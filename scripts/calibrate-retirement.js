import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { calibrateRequestForecast } from '../src/economics.js'
import { priceUsage } from './evaluation-accounting.js'

/** Convert complete real-run evidence; never relabel a replay or guess missing recovery charges. */
export function calibrateRetirementReports(reports) {
  const decline = reason => ({ status: 'declined', reason })
  if (!Array.isArray(reports) || reports.length < 3 || reports.length > 64) return decline('insufficient-comparable-reports')
  const observations = []
  let scope
  for (const report of reports) {
    if (!report || !Array.isArray(report.tasks) || report.tasks.length !== 3 ||
        JSON.stringify(report.tasks.map(task => task?.group).sort()) !== JSON.stringify(['baseline-default', 'baseline-tuned', 'plugin']) ||
        report.tasks.some(task => task.passed !== true || task.usageComplete !== true || task.replay !== false || task.usageKind !== 'provider-reported')) return decline('incomplete-real-run')
    const task = report.tasks.find(task => task?.group === 'plugin')
    if (report.evaluationKind !== 'history-retirement-live-agent' || report.completed !== true ||
        !task || task.replay !== false || task.passed !== true || task.usageComplete !== true ||
        task.usageKind !== 'provider-reported' || task.attempts !== 0 || !Array.isArray(task.retirements) || !Array.isArray(task.toolCalls) ||
        !Array.isArray(task.modelCalls) || !task.modelCalls.length) return decline('incomplete-real-run')
    const scopeValue = JSON.stringify({ model: report.model, task: task.task, assumptions: report.assumptions, pricing: task.pricing })
    const currentScope = `retirement:${createHash('sha256').update(scopeValue).digest('hex')}`
    if (scope && currentScope !== scope) return decline('incomparable-reports')
    scope = currentScope
    const retired = task.retirements.filter(item => item?.reason === 'retired')
    if (!retired.length || retired.some(item => !Number.isSafeInteger(item.actualPostRetirementSteps) || item.actualPostRetirementSteps < 0)) return decline('missing-observed-horizon')
    const reads = new Set(task.toolCalls.filter(call => call?.readSnapshot && !call.isError).map(call => call.callId))
    if (!reads.size) return decline('missing-recovery-evidence')
    // Include the FULL cost of all later requests retaining a recovery result.
    // This conservatively overcounts context beyond recovery rather than treating
    // reconstruction as free. It is an observed allowance, not causal extra cost.
    let recoveryCost = 0
    let recoveredRequests = 0
    for (const call of task.modelCalls) {
      if (!call || !call.complete || !Array.isArray(call.visibleToolResults)) return decline('incomplete-recovery-accounting')
      if (!call.visibleToolResults.some(result => reads.has(result.callId))) continue
      const cost = priceUsage(call.usage, task.pricing)
      if (cost === null) return decline('incomplete-recovery-accounting')
      recoveryCost += cost
      recoveredRequests++
    }
    if (!recoveredRequests || !Number.isFinite(recoveryCost) || typeof task.startedAt !== 'string') return decline('incomplete-recovery-accounting')
    observations.push({ runId: `${task.task}/${task.startedAt}`, scope, usageKind: task.usageKind,
      usageComplete: true, qualityPassed: true,
      remainingRequests: Math.min(...retired.map(item => item.actualPostRetirementSteps)), recoveryCost })
  }
  const forecast = calibrateRequestForecast(observations, { scope })
  return forecast.status === 'calibrated' ? { ...forecast, forecastConfig: { scope, observations },
    limitations: ['Observed comparable-run minimum is not a future guarantee.', 'Recovery allowance includes full subsequent model-call costs, not a causal cost difference.', 'Caller-supplied reports are validated for completeness but not cryptographically authenticated.'] } : forecast
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const reports = await Promise.all(process.argv.slice(2).map(async file => JSON.parse(await readFile(resolve(file), 'utf8'))))
    const report = calibrateRetirementReports(reports)
    console.log(JSON.stringify(report, null, 2))
    if (report.status !== 'calibrated') process.exitCode = 1
  } catch { console.error('Calibration rejected incomplete or invalid evidence.'); process.exitCode = 1 }
}
