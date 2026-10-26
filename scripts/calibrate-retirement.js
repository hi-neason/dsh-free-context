import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { calibrateRequestForecast } from '../src/economics.js'
import { priceUsage, summarizeUsage } from './evaluation-accounting.js'

export const retirementEvidenceHash = value => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
const decline = reason => ({ status: 'declined', reason })
const groups = ['baseline-default', 'baseline-tuned', 'plugin']

/** Validate raw runner evidence, deriving horizon and costs rather than trusting labels. */
export function inspectRetirementReport(report) {
  if (!report || report.evaluationKind !== 'history-retirement-live-agent' || report.completed !== true ||
      typeof report.runId !== 'string' || !report.runId.trim() || !report.fixture ||
      typeof report.fixture.id !== 'string' || typeof report.fixture.text !== 'string' ||
      report.fixtureHash !== retirementEvidenceHash(report.fixture) || !report.assumptions ||
      report.policyHash !== retirementEvidenceHash(report.assumptions) ||
      report.provenance?.runtimeVersion !== '0.2.1-rc.2' || report.provenance?.model !== report.model ||
      !/^[a-f0-9]{40}$/.test(report.provenance?.repositoryCommit ?? '') ||
      !/^[a-f0-9]{64}$/.test(report.provenance?.sourceTreeHash ?? '') ||
      typeof report.provenance?.cacheCondition !== 'string') return decline('incomplete-identity')
  if (!Array.isArray(report.tasks) || report.tasks.length !== 3 ||
      JSON.stringify(report.tasks.map(task => task?.group).sort()) !== JSON.stringify(groups)) return decline('incomplete-real-run')
  const phases = report.fixture.phases ?? [{ expected: report.fixture.expected }]
  if (!phases.length || phases.some(phase => phase.expected === undefined)) return decline('missing-quality-contract')
  for (const task of report.tasks) {
    if (task.task !== report.fixture.id || task.passed !== true || task.usageComplete !== true || task.replay !== false ||
        task.usageKind !== 'provider-reported' || task.attempts !== 0 || task.stoppedReason ||
        !isDeepStrictEqual(task.historyRetirement, report.assumptions) ||
        !Array.isArray(task.toolCalls) || !task.toolCalls.some(call => call.name === (report.fixture.ptc ? 'run_code' : 'fixture') && call.isError === false) ||
        !Array.isArray(task.turnEnds) || !task.turnEnds.length || task.turnEnds.some(turn => turn.kind !== 'completed') ||
        !Array.isArray(task.phaseResults) || task.phaseResults.length !== phases.length ||
        task.phaseResults.some((phase, i) => phase.passed !== true || phase.freshAnswer !== true || phase.turnCompleted !== true || !isDeepStrictEqual(phase.actual, phases[i].expected))) return decline('incomplete-real-run')
    if (!Array.isArray(task.modelCalls) || !task.modelCalls.length || !Number.isSafeInteger(task.steps) || task.steps < 1 ||
        task.modelCalls.some((call, i) => !call || call.id !== i + 1 || call.complete !== true || !['stop', 'tool-calls'].includes(call.finish) ||
          !['agent', 'auxiliary'].includes(call.kind) || call.provider !== 'deepseek-official' || call.model !== report.model ||
          !Number.isSafeInteger(call.agentStep) || call.agentStep < 1 || call.agentStep > task.steps ||
          i > 0 && call.agentStep < task.modelCalls[i - 1].agentStep || !Array.isArray(call.visibleToolResults)) ||
        task.pricing?.model !== report.model || !task.pricing?.verifiedDate || !task.pricing?.ratePeriod) return decline('incomplete-provider-ledger')
    const total = summarizeUsage(task.modelCalls.map(call => call.usage))
    if (!total.complete || Object.entries(total.usage).some(([field, value]) => value !== task.usage?.[field]) ||
        task.modelCalls.some(call => priceUsage(call.usage, task.pricing) === null)) return decline('incomplete-provider-ledger')
  }
  const task = report.tasks.find(task => task.group === 'plugin')
  if (report.tasks.some(item => !isDeepStrictEqual(item.pricing, task.pricing))) return decline('incomparable-prices')
  const retired = task.retirements?.filter(item => item?.reason === 'retired')
  if (!retired?.length) return decline('missing-observed-horizon')
  const horizons = []
  for (const item of retired) {
    if (!Number.isSafeInteger(item.beforeStep) || item.beforeStep < 1 || item.beforeStep > task.steps) return decline('missing-observed-horizon')
    const remaining = task.modelCalls.filter(call => call.kind === 'agent' && call.agentStep >= item.beforeStep).length
    if (item.actualPostRetirementSteps !== remaining) return decline('inconsistent-observed-horizon')
    horizons.push(remaining)
  }
  const reads = new Set(task.toolCalls?.filter(call => call?.name === 'read' && call.readSnapshot === true && call.isError === false && typeof call.callId === 'string').map(call => call.callId))
  if (!reads.size || !phases.every((_, phase) => task.toolCalls.some(call => call.phase === phase && reads.has(call.callId)))) return decline('missing-recovery-evidence')
  // Full cost of every later request retaining recovery text is a conservative
  // allowance, not a causal estimate of incremental recovery expense.
  const recovered = task.modelCalls.filter(call => call.visibleToolResults.some(result => reads.has(result.callId)))
  if (!recovered.length) return decline('incomplete-recovery-accounting')
  const recoveryCost = recovered.reduce((sum, call) => sum + priceUsage(call.usage, task.pricing), 0)
  const scope = `retirement:${retirementEvidenceHash({ fixtureHash: report.fixtureHash, policyHash: report.policyHash, provenance: report.provenance, pricing: task.pricing })}`
  return { status: 'validated', scope, observation: { runId: report.runId, scope, usageKind: 'provider-reported', usageComplete: true, qualityPassed: true, remainingRequests: Math.min(...horizons), recoveryCost } }
}

/** Convert complete real-run evidence; old reports missing raw evidence decline. */
export function calibrateRetirementReports(reports) {
  if (!Array.isArray(reports) || reports.length < 3 || reports.length > 64) return decline('insufficient-comparable-reports')
  const observations = []
  let scope
  for (const report of reports) {
    const evidence = inspectRetirementReport(report)
    if (evidence.status !== 'validated') return evidence
    if (scope && evidence.scope !== scope) return decline('incomparable-reports')
    scope = evidence.scope
    observations.push(evidence.observation)
  }
  const forecast = calibrateRequestForecast(observations, { scope })
  return forecast.status === 'calibrated' ? { ...forecast, forecastConfig: { scope, observations },
    limitations: ['Observed comparable-run minimum is not a future guarantee.', 'Recovery allowance includes full subsequent model-call costs, not a causal cost difference.', 'Caller-supplied reports are checked for internal consistency, not cryptographically authenticated.'] } : forecast
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const reports = await Promise.all(process.argv.slice(2).map(async file => JSON.parse(await readFile(resolve(file), 'utf8'))))
    const report = calibrateRetirementReports(reports)
    console.log(JSON.stringify(report, null, 2))
    if (report.status !== 'calibrated') process.exitCode = 1
  } catch { console.error('Calibration rejected incomplete or invalid evidence.'); process.exitCode = 1 }
}
