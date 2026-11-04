import { readFile, readdir, realpath } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { validUsage, summarizeUsage } from '../evaluation-accounting.js'
import { completeCall } from './swe-canary-agent.js'
import { pricedCNY } from './run-swe-paired.js'

const fields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
const oldPeak = 35.1021018
const oldWallet = 24.0032055
const credit = 11.0988963
const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-8
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const normalized = usage => fields.map(field => usage[field] ?? 0)
const requireValue = (condition, message) => { if (!condition) throw new Error(message) }

/** Completed calls must agree by identity and disjoint usage, even when prices coincide. */
export function verifyPriorCalls(result, text, prices) {
  const starts = new Map(), ends = new Map()
  for (const line of text.split('\n').filter(Boolean)) {
    const record = JSON.parse(line)
    requireValue(Number.isSafeInteger(record.id) && record.id > 0, 'Invalid prior call ID')
    requireValue(record.type === 'start' || record.type === 'end', 'Invalid prior journal event')
    const records = record.type === 'start' ? starts : ends
    requireValue(!records.has(record.id), 'Duplicate prior call ID')
    records.set(record.id, record)
  }
  requireValue(starts.size > 0 && starts.size === ends.size, 'Incomplete prior calls')
  requireValue(result?.usageComplete === true && Array.isArray(result.modelCalls) &&
    result.modelCalls.length === ends.size, 'Incomplete prior result')
  const ids = new Set()
  for (const call of result.modelCalls) {
    const start = starts.get(call.id), end = ends.get(call.id)
    requireValue(!ids.has(call.id) && start && end && completeCall(call) && completeCall(end), 'Unknown or duplicate prior call')
    ids.add(call.id)
    requireValue(typeof start.requestHash === 'string' && /^[a-f0-9]{64}$/.test(start.requestHash) && start.requestHash === end.requestHash && call.requestHash === end.requestHash &&
      isDeepStrictEqual(normalized(call.usage), normalized(end.usage)), 'Prior call usage mismatch')
    requireValue(start.reservedUSD === 0 && end.reservedUSD === 0 && call.reservedUSD === 0, 'Prior reservation mismatch')
  }
  const aggregate = summarizeUsage([...ends.values()].map(call => call.usage))
  requireValue(aggregate.complete && validUsage(result.usage) &&
    isDeepStrictEqual(normalized(aggregate.usage), normalized(result.usage)), 'Prior aggregate usage mismatch')
  const costCNY = pricedCNY(aggregate.usage, prices)
  requireValue(costCNY !== null, 'Unknown prior cost')
  return costCNY
}

/** The ledger replaces the exact settled scope once, then adds each later study. */
export async function validatePriorAccounting(file, suppliedPrior, prices, currentRoot) {
  const evidence = new Map()
  async function readEvidence(name, expected) {
    const canonical = await realpath(resolve(name))
    const bytes = await readFile(canonical), sha256 = hash(bytes)
    requireValue(typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected) && sha256 === expected, 'Prior evidence checksum mismatch')
    evidence.set(canonical, sha256)
    return bytes
  }
  const ledgerFile = await realpath(resolve(file)), ledgerBytes = await readFile(ledgerFile)
  evidence.set(ledgerFile, hash(ledgerBytes))
  const ledger = JSON.parse(ledgerBytes)
  requireValue(ledger.version === 'settled-prior-accounting-v1' && Array.isArray(ledger.studies) && ledger.studies.length > 0,
    'Invalid settled prior ledger')
  const proof = JSON.parse(await readEvidence(ledger.settlementFile, ledger.settlementHash))
  requireValue(proof.decision === 'eligible' && proof.allChecksPass === true &&
    proof.checks && Object.keys(proof.checks).length > 0 && Object.values(proof.checks).every(value => value === true), 'Settlement is not verified')
  requireValue(near(Number(proof.oldScopePeakCNY), oldPeak) && near(Number(proof.oldScopeWalletCNY), oldWallet) &&
    near(Number(proof.oneTimeSettledCreditCNY), credit) && near(oldPeak - oldWallet, credit) &&
    Number(proof.additionalAuthorizedCNY) === 50 && Number(proof.cumulativeAuthorizedCNY) === 70 &&
    near(Number(proof.priorConservativeCNY), 18.02921736), 'Settlement scope or authorization mismatch')
  requireValue(proof.inputHashes && Object.keys(proof.inputHashes).length > 0, 'Missing settlement evidence')
  for (const [name, expected] of Object.entries(proof.inputHashes)) await readEvidence(name, expected)
  const studiesRoot = dirname(await realpath(resolve(ledger.settlementFile)))
  const settledReports = new Set()
  for (const name of Object.keys(proof.inputHashes)) {
    if (name.endsWith('/study-report.json')) settledReports.add(await realpath(resolve(name)))
  }
  const expectedReports = new Set(), expectedRuns = new Map()
  let laterKnownPeakCNY = 0, settledChain = false, previousTime = Date.parse('2026-11-03T16:00:00.000Z')
  for (const entry of ledger.studies) {
    const reportFile = await realpath(resolve(entry.reportFile))
    requireValue(dirname(dirname(reportFile)) === studiesRoot && !expectedReports.has(reportFile), 'Duplicate or misplaced prior study')
    expectedReports.add(reportFile)
    const report = JSON.parse(await readEvidence(reportFile, entry.sha256))
    requireValue(report.finished === true && report.accountingComplete === true && report.sourceAfterMatches === true &&
      report.withinBudget === true && !report.stoppedReason && Array.isArray(report.tasks) && report.tasks.length > 0,
    'Prior study is not complete')
    const createdAt = Date.parse(report.plan?.createdAt)
    requireValue(typeof report.plan?.root === 'string' && await realpath(resolve(report.plan.root)) === dirname(reportFile) &&
      Number.isFinite(createdAt) && createdAt > previousTime && !settledReports.has(reportFile),
    'Prior study identity or ordering mismatch')
    previousTime = createdAt
    requireValue(isDeepStrictEqual(report.plan.config.cnyPricing, prices), 'Prior pricing mismatch')
    const peakPrefix = oldPeak + laterKnownPeakCNY, bookedPrefix = oldWallet + laterKnownPeakCNY
    if (near(report.priorKnownCNY, bookedPrefix)) settledChain = true
    else requireValue(!settledChain && near(report.priorKnownCNY, peakPrefix), 'Omitted study or repeated settlement credit')
    requireValue(near(report.plan.config.priorKnownCNY, report.priorKnownCNY), 'Prior plan accounting mismatch')
    let studyCostCNY = 0
    const runNames = new Set()
    for (const row of report.tasks) {
      requireValue(Number.isSafeInteger(row.slot) && row.slot >= 0 && /^[\w-]+$/.test(row.instanceId) && row.group === 'plugin', 'Invalid prior task identity')
      const runName = `${row.slot}-${row.instanceId}-${row.group}`
      requireValue(!runNames.has(runName), 'Duplicate prior task')
      runNames.add(runName)
      const journalFile = join(dirname(reportFile), 'runs', runName, 'model-calls.jsonl')
      const journal = await readFile(journalFile)
      evidence.set(await realpath(journalFile), hash(journal))
      const costCNY = verifyPriorCalls(row.result, journal.toString('utf8'), prices)
      requireValue(near(costCNY, row.costCNY), 'Prior task cost mismatch')
      studyCostCNY += costCNY
    }
    const scheduled = report.plan.scheduled
    requireValue(Array.isArray(scheduled) && scheduled.length === runNames.size &&
      new Set(scheduled.map(row => `${row.slot}-${row.instanceId}-${row.group}`)).size === scheduled.length &&
      scheduled.every(row => runNames.has(`${row.slot}-${row.instanceId}-${row.group}`)), 'Prior task coverage mismatch')
    expectedRuns.set(join(dirname(reportFile), 'runs'), [...runNames].sort())
    const runs = await readdir(join(dirname(reportFile), 'runs'), { withFileTypes: true })
    requireValue(runs.filter(item => item.isDirectory()).every(item => runNames.has(item.name)), 'Unaccounted prior attempt')
    requireValue(near(studyCostCNY, report.knownStudyCostCNY) &&
      near(report.combinedKnownCNY, report.priorKnownCNY + studyCostCNY), 'Prior study cost mismatch')
    laterKnownPeakCNY += studyCostCNY
  }
  async function verifyInventory() {
    const found = new Set()
    for (const child of await readdir(studiesRoot, { withFileTypes: true })) {
      if (!child.isDirectory() || resolve(studiesRoot, child.name) === resolve(currentRoot)) continue
      const candidate = join(studiesRoot, child.name, 'study-report.json')
      try { JSON.parse(await readFile(candidate, 'utf8')) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      const canonical = await realpath(candidate)
      if (!settledReports.has(canonical)) found.add(canonical)
    }
    if (!isDeepStrictEqual([...found].sort(), [...expectedReports].sort())) return false
    for (const [directory, names] of expectedRuns) {
      const entries = await readdir(directory, { withFileTypes: true })
      if (!isDeepStrictEqual(entries.filter(item => item.isDirectory()).map(item => item.name).sort(), names)) return false
    }
    return true
  }
  requireValue(await verifyInventory(), 'Omitted or new prior study')
  const bookedPriorCNY = oldWallet + laterKnownPeakCNY
  requireValue(near(ledger.priorKnownCNY, bookedPriorCNY) && near(suppliedPrior, bookedPriorCNY), 'Supplied prior does not match settled ledger')
  return { file: ledgerFile, sha256: hash(ledgerBytes), ledgerBytes, verifyInventory,
    hashes: [...evidence].map(([file, sha256]) => ({ file, sha256 })),
    audit: { version: ledger.version, originalPriorPeakCNY: oldPeak + laterKnownPeakCNY,
      priorKnownCNY: bookedPriorCNY, bookedPriorCNY, settlementCreditCNY: credit,
      settledWalletCNY: oldWallet, laterKnownPeakCNY } }
}
