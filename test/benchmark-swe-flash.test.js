import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runSweCanaryTask } from '../scripts/benchmark/swe-canary-agent.js'
import { flashSchedule, validateFlashPricing, flashTaskLimit, validateFlashPrior, parseArguments, flashComparison, freezeFlashBaselines, runFlashStudy } from '../scripts/benchmark/run-swe-flash.js'

const ids = ['django__django-16116', 'django__django-12273', 'matplotlib__matplotlib-22871', 'sphinx-doc__sphinx-7910', 'sympy__sympy-12419']
const sha = value => createHash('sha256').update(value).digest('hex')
const prices = {
  pricing: { currency: 'USD', model: 'deepseek-flash', uncached: .3, cacheRead: .006, output: 1.2, documentedModelVersion: 'DeepSeek-V4.1-Flash-1017', verifiedDate: '2026-11-04', sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/' },
  cnyPricing: { currency: 'CNY', uncached: 2, cacheRead: .04, output: 8, sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/' },
}
const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0 }
const call = { id: 1, requestHash: 'b'.repeat(64), provider: 'deepseek-official', model: 'deepseek-flash', usage, finish: 'stop', streamCompleted: true, reservedUSD: 0 }
const cost = .000362
const journal = record => JSON.stringify({ type: 'start', ...record, usage: null, finish: null, streamCompleted: false }) + '\n' + JSON.stringify({ type: 'end', ...record }) + '\n'
const result = () => ({ model: 'deepseek-flash', simulated: false, usage, usageComplete: true, modelCalls: [structuredClone(call)], patchStatus: 'complete' })
const quality = id => ({ infrastructureError: false, resolved: true, report: { [id]: { resolved: true, infra_failure: false } } })
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swe-flash-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function reportFixture() {
  const scheduled = flashSchedule(ids)
  const config = { model: 'deepseek-flash', ...prices, priorKnownCNY: 37, nativeInlineTokensByGroup: { 'baseline-default': 12500, 'baseline-tuned': 1200, plugin: 1200 } }
  return { plan: { config, scheduled }, finished: true, accountingComplete: true, sourceAfterMatches: true, withinBudget: true,
    tasks: scheduled.map(slot => ({ ...slot, result: { ...result(), nativeInlineTokens: config.nativeInlineTokensByGroup[slot.group] }, quality: quality(slot.instanceId), costCNY: cost })) }
}

test('real provider entry rejects every non-Flash route before writing or loading provider', async t => {
  const directory = join(await temporary(t), 'run')
  for (const model of ['deepseek-v4-pro', 'deepseek-pro', 'deepseek-v4-flash']) {
    await assert.rejects(runSweCanaryTask({ directory, model, key: 'fixture-not-used', pricing: { ...prices.pricing, model },
      group: 'plugin', problemStatement: 'Fix issue', baseCommit: 'a'.repeat(40), containerName: 'fixture' }), /require deepseek-flash/)
    await assert.rejects(stat(directory), { code: 'ENOENT' })
  }
})

test('Flash schedule covers five identities by three rotating arms and supports plugin-only', () => {
  const schedule = flashSchedule(ids)
  assert.equal(schedule.length, 15)
  assert.equal(new Set(schedule.map(row => `${row.instanceId}/${row.group}`)).size, 15)
  assert.deepEqual(schedule.slice(0, 3).map(row => row.group), ['baseline-default', 'baseline-tuned', 'plugin'])
  assert.deepEqual(schedule.slice(3, 6).map(row => row.group), ['baseline-tuned', 'plugin', 'baseline-default'])
  assert.deepEqual(flashSchedule(ids, true).map(row => row.group), Array(5).fill('plugin'))
  assert.throws(() => flashSchedule(ids.slice(1)))
})

test('Flash pricing, CLI and actual budget cannot select Pro or reserve future tasks', () => {
  assert.deepEqual(validateFlashPricing(prices), prices)
  assert.throws(() => validateFlashPricing({ ...prices, pricing: { ...prices.pricing, model: 'deepseek-v4-pro' } }))
  assert.throws(() => validateFlashPricing({ ...prices, cnyPricing: { ...prices.cnyPricing, output: 27 } }))
  const config = { ...prices, priorKnownCNY: 49.9 }
  assert.ok(flashTaskLimit(config, 0).maxTaskUSD > 0)
  assert.ok(Math.abs(flashTaskLimit(config, 0).remainingCNY - .1) < 1e-8)
  assert.equal(flashTaskLimit(config, .2).maxTaskUSD, 0)
  assert.throws(() => flashTaskLimit(config, NaN))
  const args = ['--baseline', 'b', '--reference-plan', 'r', '--root', 'o', '--pricing-file', 'p', '--prior-accounting-file', 'a', '--plugin-config', 'c']
  assert.equal(parseArguments(args).run, false)
  assert.equal(parseArguments([...args, '--plugin-only']).pluginOnly, true)
  assert.throws(() => parseArguments([...args, '--model', 'deepseek-v4-pro']))
})

async function budgetFixture(t) {
  const root = await temporary(t), file = join(root, 'ledger.json')
  const inputHashes = {}, components = []
  for (const [index, amount] of [24.0032055, 12.9992034].entries()) {
    const phase = `history-${index}`, reportFile = join(root, phase, 'study-report.json'), evidenceFile = join(root, `evidence-${index}.json`)
    await mkdir(join(root, phase)); await writeFile(reportFile, '{}')
    const amountField = index === 0 ? 'oldScopeWalletCNY' : 'actualProviderWalletCNY'
    const evidence = { decision: 'eligible', allChecksPass: true, checks: { receipt: true }, [amountField]: String(amount), inputHashes: { [reportFile]: sha('{}') },
      ...(index === 0 ? { scopes: [{ phases: [phase] }] } : { budgetComponent: { scope: [phase], mode: 'settled-wallet', costCNY: amount } }) }
    const bytes = JSON.stringify(evidence)
    await writeFile(evidenceFile, bytes)
    Object.assign(inputHashes, evidence.inputHashes, { [evidenceFile]: sha(bytes) })
    components.push({ scope: index === 0 ? 'nov2-nov3-settled' : 'nov4-pro-history-settled', mode: 'settled-wallet', costCNY: amount, evidenceFile, evidenceHash: sha(bytes), amountField })
  }
  const ledger = { version: 'swe-flash-prior-accounting-v1', accountingComplete: true, priorKnownCNY: 37.0024089,
    authorizedAdditionalCNY: 50, historicalPriorCNY: 18.02921736, cumulativeAuthorizedCNY: 70, inputHashes, components }
  await writeFile(file, JSON.stringify(ledger))
  return { root, file, ledger, evidenceFile: components[0].evidenceFile, write: () => writeFile(file, JSON.stringify(ledger)) }
}

test('reconciled prior binds exact component amounts and rejects missing/duplicate/changed evidence', async t => {
  const f = await budgetFixture(t)
  const prior = await validateFlashPrior(f.file, join(f.root, 'new-run'))
  assert.equal(prior.ledger.priorKnownCNY, 37.0024089)
  f.ledger.components[0].costCNY = 1; f.ledger.priorKnownCNY = 1; await f.write()
  await assert.rejects(validateFlashPrior(f.file, join(f.root, 'new-run')), /amount mismatch/)
  f.ledger.components[0].costCNY = 24.0032055; f.ledger.priorKnownCNY = 37.0024089
  f.ledger.components.push({ ...f.ledger.components[0] }); await f.write()
  await assert.rejects(validateFlashPrior(f.file, join(f.root, 'new-run')), /duplicate prior/)
  f.ledger.components.pop()
  const nov4 = f.ledger.components.pop(); f.ledger.priorKnownCNY = 24.0032055; await f.write()
  await assert.rejects(validateFlashPrior(f.file, join(f.root, 'new-run')), /Required settled history/)
  f.ledger.components.push(nov4); f.ledger.priorKnownCNY = 37.0024089
  f.ledger.accountingComplete = false; await f.write()
  await assert.rejects(validateFlashPrior(f.file, join(f.root, 'new-run')), /Complete reconciled/)
  f.ledger.accountingComplete = true; await f.write(); await writeFile(f.evidenceFile, '{}')
  await assert.rejects(validateFlashPrior(f.file, join(f.root, 'new-run')), /checksum/)
})

test('prior study inventory rejects a newly introduced unaccounted run', async t => {
  const f = await budgetFixture(t), prior = await validateFlashPrior(f.file, join(f.root, 'new-run'))
  await mkdir(join(f.root, 'unaccounted')); await writeFile(join(f.root, 'unaccounted/study-report.json'), '{}')
  await assert.rejects(prior.inventory(), /omits a study/)
})

test('cohort comparison rejects partial, duplicate or cross-model rows and preserves per-task scores', () => {
  const report = reportFixture()
  assert.equal(flashComparison(report).complete, true)
  assert.equal(flashComparison(report).comparisons[0].qualityNoRegression, true)
  const mixed = structuredClone(report); mixed.tasks[0].result.model = 'deepseek-v4-pro'
  assert.equal(flashComparison(mixed).complete, false)
  const incomplete = structuredClone(report); incomplete.tasks[0].result.usageComplete = false
  assert.equal(flashComparison(incomplete).complete, false)
  const duplicate = structuredClone(report); duplicate.tasks[1] = duplicate.tasks[0]
  assert.throws(() => flashComparison(duplicate), /coverage/)
  const plugin = structuredClone(report); plugin.plan.pluginOnly = true; plugin.plan.scheduled = flashSchedule(ids, true); plugin.tasks = plugin.tasks.filter(row => row.group === 'plugin')
  assert.throws(() => flashComparison(plugin, { protocol: { model: 'deepseek-v4-pro' } }), /Cross-model/)
})

async function executionFixture(t, mode = 'success') {
  const parent = await temporary(t), root = join(parent, 'run'), credentialFile = join(parent, 'key'), taskFile = join(parent, 'task.json'), selectionFile = join(parent, 'selection.json')
  await writeFile(credentialFile, 'fixture-not-a-key'); await writeFile(taskFile, JSON.stringify({ problem_statement: 'Fix fixture.' })); await writeFile(selectionFile, '{}')
  const report = reportFixture(), plan = { ...report.plan, root, sourceTreeHash: 'frozen', pluginOnly: false, identities: ids.map(instanceId => ({ instanceId, imageReference: 'fixture:image', imageId: 'fixture-id', taskFile, baseCommit: 'a'.repeat(40), expected: {}, evalScript: 'fixture' })), compatibility: {}, config: { ...report.plan.config, root, credentialFile, selectionFile, harnessRoot: 'fixture', pluginConfiguration: { mode: 'apply', tools: ['bash'] }, thinking: 'enabled', reasoningEffort: 'high' } }
  const containers = new Map(), removed = [], calls = []
  let nextId = 0
  const services = {
    prepare: async () => ({ plan, baseline: {}, frozen: async () => true, prior: { bytes: Buffer.from('{}') } }),
    command: async (_command, args) => {
      if (args[0] === 'image') return { stdout: JSON.stringify([{ Id: 'fixture-id', Architecture: 'amd64' }]) }
      if (args[0] === 'ps') {
        const filter = args[args.indexOf('--filter') + 1], name = filter.slice('name=^/'.length, -1)
        return { stdout: containers.get(name) ?? '' }
      }
      if (args[0] === 'run') {
        const name = args[args.indexOf('--name') + 1]; containers.set(name, (++nextId).toString(16).padStart(64, '0'))
        if (mode === 'create-timeout') throw Object.assign(new Error('timeout after creation'), { code: 'ETIMEDOUT' })
      }
      if (args[0] === 'rm') {
        removed.push(args.at(-1)); for (const [name, id] of containers) if (id === args.at(-1)) containers.delete(name)
      }
      return { stdout: '' }
    },
    taskRunner: async input => {
      calls.push(input)
      assert.equal(input.model, 'deepseek-flash'); assert.equal(input.costGuard, 'actual-usage')
      await mkdir(input.directory, { recursive: true })
      assert.equal(input.nativeInlineTokens, input.group === 'baseline-default' ? 12500 : 1200)
      const value = { ...result(), nativeInlineTokens: input.nativeInlineTokens }
      if (mode === 'unknown') { value.usageComplete = false; value.modelCalls[0].usage = null }
      if (mode === 'same-price-mismatch') { value.usage = { inputTokens: 0, cacheReadTokens: 5050, cacheWriteTokens: 0, outputTokens: 20 }; value.modelCalls[0].usage = value.usage }
      if (mode !== 'missing-journal') await writeFile(join(input.directory, 'model-calls.jsonl'), journal(mode === 'same-price-mismatch' ? call : value.modelCalls[0]))
      await writeFile(join(input.directory, 'result.json'), JSON.stringify(value)); await writeFile(join(input.directory, 'model.patch'), 'fixture patch')
      if (mode === 'agent-throw') throw new Error('after paid call')
      return value
    },
    scorer: async input => {
      await mkdir(input.directory, { recursive: true })
      const id = plan.scheduled[Number(input.directory.match(/runs\/(\d+)-/)[1])].instanceId
      const q = quality(id)
      await writeFile(join(input.directory, 'official-grade.json'), JSON.stringify({ report: q.report }))
      if (mode === 'score-timeout') { containers.set(input.containerName, (++nextId).toString(16).padStart(64, '0')); throw new Error('eval create timeout') }
      return q
    },
  }
  return { root, plan, services, containers, removed, calls }
}

test('mock full Flash cohort runs 15 equal-protocol slots and freezes ten controls without reuse', async t => {
  const f = await executionFixture(t), report = await runFlashStudy({}, f.services)
  assert.equal(report.finished, true); assert.equal(report.comparison.complete, true); assert.equal(f.calls.length, 15)
  assert.equal(f.containers.size, 0)
  const frozen = JSON.parse(await readFile(report.frozenBaselines.file))
  assert.equal(frozen.protocol.model, 'deepseek-flash'); assert.equal(frozen.rows.length, 10); assert.equal(frozen.artifacts.length, 30)
  assert.equal((await stat(report.frozenBaselines.file)).mode & 0o777, 0o444)
  const before = await Promise.all(frozen.artifacts.map(async item => sha(await readFile(join(f.root, 'frozen-baselines', item.file)))))
  const next = await executionFixture(t)
  next.plan.pluginOnly = true; next.plan.scheduled = flashSchedule(ids, true)
  const prepare = next.services.prepare
  next.services.prepare = async () => ({ ...await prepare(), baseline: frozen })
  const rerun = await runFlashStudy({}, next.services)
  assert.equal(rerun.finished, true); assert.equal(next.calls.length, 5); assert.ok(next.calls.every(call => call.group === 'plugin'))
  assert.equal(rerun.frozenBaselines, undefined)
  assert.deepEqual(await Promise.all(frozen.artifacts.map(async item => sha(await readFile(join(f.root, 'frozen-baselines', item.file))))), before)
  await assert.rejects(freezeFlashBaselines(report), { code: 'EEXIST' })
  await assert.rejects(runFlashStudy({}, f.services), { code: 'EEXIST' })
})

test('unknown or equal-cost mismatched token accounting stops Flash after the first attempted slot', async t => {
  for (const mode of ['unknown', 'same-price-mismatch']) {
    const f = await executionFixture(t, mode), report = await runFlashStudy({}, f.services)
    assert.equal(f.calls.length, 1); assert.equal(report.accountingComplete, false); assert.equal(report.finished, false)
    assert.equal(report.tasks[0].costCNY, null); assert.equal(report.comparison.complete, false)
    assert.equal(f.containers.size, 0)
  }
})

test('baseline freeze rejects a result artifact that differs from the official comparison row', async t => {
  const root = await temporary(t), report = reportFixture(), row = report.tasks[0]
  report.plan.root = root
  const directory = join(root, 'runs', `${row.slot}-${row.instanceId}-${row.group}`)
  await mkdir(join(directory, 'evaluation'), { recursive: true })
  await writeFile(join(directory, 'result.json'), '{}')
  await writeFile(join(directory, 'model-calls.jsonl'), journal(call))
  await writeFile(join(directory, 'evaluation/official-grade.json'), JSON.stringify({ report: row.quality.report }))
  await assert.rejects(freezeFlashBaselines(report), /artifacts do not match/)
  await assert.rejects(readFile(join(root, 'frozen-baselines/baseline.json')), { code: 'ENOENT' })
})

test('task/evaluation creation timeout cleans exact owned IDs and retains known charges after errors', async t => {
  for (const mode of ['create-timeout', 'score-timeout', 'agent-throw', 'missing-journal']) {
    const f = await executionFixture(t, mode), report = await runFlashStudy({}, f.services)
    assert.equal(report.finished, false); assert.equal(f.containers.size, 0); assert.ok(f.removed.length > 0)
    assert.ok(f.removed.every(id => /^[a-f0-9]{64}$/.test(id)))
    if (mode !== 'create-timeout') assert.ok(near(report.knownStudyCostCNY, cost))
  }
})
const near = (a, b) => Math.abs(a - b) < 1e-8
