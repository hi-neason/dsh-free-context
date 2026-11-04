import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { validatePriorAccounting } from '../scripts/benchmark/settled-budget.js'
import { parseArguments, actualTaskLimit } from '../scripts/benchmark/run-swe-plugin.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const prices = { currency: 'CNY', uncached: 9, cacheRead: .3, output: 27 }
const usage = { inputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
const json = value => JSON.stringify(value, null, 2)
const oldPeak = 35.1021018, oldWallet = 24.0032055

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'settled-budget-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const evidenceFile = join(root, 'receipt.txt')
  await writeFile(evidenceFile, 'audited receipt fixture')
  const proofFile = join(root, 'proof.json')
  const proof = { decision: 'eligible', allChecksPass: true, checks: { receipt: true },
    oldScopePeakCNY: String(oldPeak), oldScopeWalletCNY: String(oldWallet), oneTimeSettledCreditCNY: '11.0988963',
    additionalAuthorizedCNY: '50', cumulativeAuthorizedCNY: '70', priorConservativeCNY: '18.02921736',
    inputHashes: { [evidenceFile]: hash(await readFile(evidenceFile)) } }
  const studies = []
  for (let index = 0; index < 2; index++) {
    const directory = join(root, `study-${index}`), runName = '0-fixture__task-1-plugin'
    const runDirectory = join(directory, 'runs', runName)
    await mkdir(runDirectory, { recursive: true })
    const call = { id: 1, requestHash: hash(String(index)), reservedUSD: 0, usage: { ...usage }, finish: 'stop', streamCompleted: true }
    const records = [{ type: 'start', id: 1, requestHash: call.requestHash, reservedUSD: 0 }, { type: 'end', ...call }]
    const journalFile = join(runDirectory, 'model-calls.jsonl')
    const reportFile = join(directory, 'study-report.json')
    const result = { usageComplete: true, usage: { ...usage }, modelCalls: [call] }
    const priorKnownCNY = oldPeak + index * 9
    const report = { finished: true, accountingComplete: true, sourceAfterMatches: true, withinBudget: true,
      priorKnownCNY, knownStudyCostCNY: 9, combinedKnownCNY: priorKnownCNY + 9,
      plan: { root: directory, createdAt: `2026-11-04T0${index}:00:00.000Z`, config: { priorKnownCNY, cnyPricing: prices }, scheduled: [{slot:0,instanceId:'fixture__task-1',group:'plugin'}] },
      tasks: [{ slot: 0, instanceId: 'fixture__task-1', group: 'plugin', result, costCNY: 9 }] }
    studies.push({ reportFile, report, journalFile, records })
  }
  const ledgerFile = join(root, 'ledger.json')
  const ledger = { version: 'settled-prior-accounting-v1', settlementFile: proofFile,
    settlementHash: '', studies: [], priorKnownCNY: oldWallet + 18 }
  async function save() {
    await writeFile(proofFile, json(proof))
    ledger.settlementHash = hash(await readFile(proofFile))
    for (const item of studies) {
      await writeFile(item.reportFile, json(item.report))
      await writeFile(item.journalFile, item.records.map(row => JSON.stringify(row)).join('\n') + '\n')
    }
    ledger.studies = studies.map(item => ({ reportFile: item.reportFile, sha256: hash(json(item.report)) }))
    await writeFile(ledgerFile, json(ledger))
  }
  await save()
  const run = () => validatePriorAccounting(ledgerFile, ledger.priorKnownCNY, prices, join(root, 'next-study'))
  return { root, proof, proofFile, ledger, ledgerFile, studies, save, run, evidenceFile }
}

test('settles the old scope once and binds every evidence file', async t => {
  const f = await fixture(t), result = await f.run()
  assert.equal(result.audit.bookedPriorCNY, oldWallet + 18)
  assert.equal(result.audit.originalPriorPeakCNY, oldPeak + 18)
  assert.equal(result.audit.settlementCreditCNY, 11.0988963)
  assert.equal(result.audit.laterKnownPeakCNY, 18)
  for (const path of [f.ledgerFile, f.proofFile, f.evidenceFile, ...f.studies.flatMap(item => [item.reportFile, item.journalFile])]) {
    assert.equal(result.hashes.find(item => item.file === path)?.sha256, hash(await readFile(path)))
  }
  const config = { priorKnownCNY: result.audit.bookedPriorCNY, maxTaskCNY: 4,
    pricing: { uncached: 1.32, cacheRead: .044, output: 3.96 }, cnyPricing: prices }
  assert.equal(actualTaskLimit(config, 0).remainingCNY, 50 - config.priorKnownCNY)
  assert.equal(actualTaskLimit(config, 9).maxTaskUSD, 0)
})

test('permits one transition to settled-book prior chains and rejects double credit', async t => {
  const f = await fixture(t), second = f.studies[1].report
  second.priorKnownCNY = oldWallet + 9
  second.plan.config.priorKnownCNY = second.priorKnownCNY
  second.combinedKnownCNY = second.priorKnownCNY + 9
  await f.save()
  assert.equal((await f.run()).audit.bookedPriorCNY, oldWallet + 18)
  f.ledger.priorKnownCNY -= 11.0988963
  await f.save()
  await assert.rejects(f.run(), /Supplied prior/)
})

test('rejects same-price different token categories and incorrect aggregate usage', async t => {
  const f = await fixture(t), row = f.studies[0]
  row.records[1].usage = { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  row.report.tasks[0].result.modelCalls[0].usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 30, cacheWriteTokens: 0 }
  await f.save()
  await assert.rejects(f.run(), /call usage mismatch/)
  row.report.tasks[0].result.modelCalls[0].usage = { ...row.records[1].usage }
  await f.save()
  await assert.rejects(f.run(), /aggregate usage mismatch/)
})

test('rejects duplicate, missing, unknown and reserved calls', async t => {
  for (const mode of ['duplicate', 'missing', 'unknown', 'result-id', 'reservation']) {
    const f = await fixture(t), item = f.studies[0]
    if (mode === 'duplicate') item.records.push({ ...item.records[1] })
    if (mode === 'missing') item.records.pop()
    if (mode === 'unknown') item.records[1].usage = null
    if (mode === 'result-id') item.report.tasks[0].result.modelCalls[0].id = 2
    if (mode === 'reservation') item.records[0].reservedUSD = 1
    await f.save()
    await assert.rejects(f.run())
  }
})

test('rejects omitted, duplicate, nonterminal and unaccounted prior studies', async t => {
  for (const mode of ['omit', 'duplicate', 'unfinished', 'extra-run', 'cost', 'chain', 'coverage']) {
    const f = await fixture(t)
    if (mode === 'coverage') f.studies[1].report.plan.scheduled.push({ slot: 1, instanceId: 'missing', group: 'plugin' })
    if (mode === 'unfinished') f.studies[1].report.finished = false
    if (mode === 'cost') f.studies[1].report.tasks[0].costCNY = 0
    if (mode === 'chain') f.studies[1].report.priorKnownCNY = oldPeak
    if (mode === 'extra-run') await mkdir(join(f.root, 'study-1', 'runs', 'orphan'))
    await f.save()
    if (mode === 'omit') f.ledger.studies.pop()
    if (mode === 'duplicate') f.ledger.studies.push(f.ledger.studies[0])
    await writeFile(f.ledgerFile, json(f.ledger))
    await assert.rejects(f.run())
  }
})

test('frozen inventory rejects a new study including one with malformed metadata', async t => {
  const f = await fixture(t), prepared = await f.run()
  assert.equal(await prepared.verifyInventory(), true)
  await mkdir(join(f.root, 'later'))
  await writeFile(join(f.root, 'later', 'study-report.json'), '{}')
  assert.equal(await prepared.verifyInventory(), false)
  await assert.rejects(f.run(), /Omitted or new/)
})

test('rejects evidence drift, invalid settlement and changed authorizations', async t => {
  for (const mode of ['evidence', 'proof-hash', 'approval', 'limit', 'amount']) {
    const f = await fixture(t)
    if (mode === 'evidence') await writeFile(f.evidenceFile, 'changed')
    if (mode === 'approval') f.proof.checks.receipt = false
    if (mode === 'limit') f.proof.additionalAuthorizedCNY = '500'
    if (mode === 'amount') f.proof.oldScopeWalletCNY = '0'
    await f.save()
    if (mode === 'proof-hash') await writeFile(f.proofFile, '{}')
    await assert.rejects(f.run())
  }
})

test('CLI accounting option is explicit and legacy execution remains opt-in', () => {
  const base = resolve('.omx/benchmarks/paired-benchmark-20261029')
  const args = ['--baseline', join(base, 'frozen-baselines-20261103/baseline.json'),
    '--reference-plan', join(base, 'actual-usage-study-20261102/study-plan.json'),
    '--root', join(base, 'settled-budget-uncreated-test-root'), '--prior-spent-cny', '41.1916398']
  const options = parseArguments(args)
  assert.equal(options.run, false)
  assert.equal(parseArguments([...args, '--prior-accounting-file', 'ledger']).priorAccountingFile, 'ledger')
  assert.throws(() => parseArguments([...args, '--prior-accounting-file', 'a', '--prior-accounting-file', 'b']))
  assert.equal(Object.hasOwn(options, 'priorAccountingFile'), false)
})
