import { isDeepStrictEqual } from 'node:util'
import { assessNetBenefit } from '../src/economics.js'
import { summarizeAcceptanceV2 } from './acceptance-benchmark-v2.js'
import { calibrateRetirementReports, inspectRetirementReport, retirementEvidenceHash, runnerConfigurationScope } from './calibrate-retirement.js'
import { priceUsage } from './evaluation-accounting.js'

/** Pin the existing historical report's digest before running this backtest.
 * The supplied calibration must be freshly derived from validated raw reports.
 */
export function verifyShortHorizonBacktest({ report, expectedReportHash } = {}, calibration) {
  const failed = reason => ({ passed: false, reason })
  if (!/^[a-f0-9]{64}$/.test(expectedReportHash ?? '') || retirementEvidenceHash(report) !== expectedReportHash) return failed('unbound-backtest')
  const evidence = inspectRetirementReport(report)
  if (evidence.status !== 'validated') return failed(evidence.reason)
  if (calibration?.status !== 'calibrated' || calibration.scope !== evidence.scope ||
      !Number.isSafeInteger(calibration.minimumFutureRequests) || calibration.minimumFutureRequests < 0 ||
      !Number.isFinite(calibration.expectedRecoveryCost) || calibration.expectedRecoveryCost < 0) return failed('missing-or-inapplicable-calibration')
  const plugin = report.tasks.find(task => task.group === 'plugin')
  const tuned = report.tasks.find(task => task.group === 'baseline-tuned')
  const actualExtraCost = priceUsage(plugin.usage, plugin.pricing) - priceUsage(tuned.usage, tuned.pricing)
  if (!(actualExtraCost > 0) || evidence.observation.remainingRequests > 2 || report.assumptions.minimumFutureRequests !== 200) return failed('not-short-negative-counterexample')
  const decisions = []
  const calibratedDecisions = []
  for (const record of plugin.retirements.filter(item => item.reason === 'retired')) {
    const original = record.economics
    if (!original || original.minimumFutureRequests !== 200 || original.adopt !== true ||
        !['removedTokens', 'compressionCost', 'cacheRebuildCost', 'expectedRecoveryCost', 'safetyMargin'].every(key => Number.isFinite(original[key]) && original[key] >= 0)) return failed('missing-economic-inputs')
    try {
      // Reuse the recorded rebuild cost exactly once; only horizon/recovery are
      // replaced by observations. Candidate zero expresses the recorded delta.
      const input = { originalTokens: original.removedTokens, candidateTokens: 0, invalidatedPrefixTokens: 0,
        compressionCost: original.compressionCost + original.cacheRebuildCost,
        safetyMargin: original.safetyMargin,
        pricing: { uncachedInputPerMillion: plugin.pricing.uncached, cacheReadPerMillion: plugin.pricing.cacheRead } }
      if (!assessNetBenefit({ ...input, minimumFutureRequests: 200, expectedRecoveryCost: original.expectedRecoveryCost }).adopt) return failed('inconsistent-original-decision')
      decisions.push(assessNetBenefit({ ...input, minimumFutureRequests: evidence.observation.remainingRequests, expectedRecoveryCost: evidence.observation.recoveryCost }))
      // Mirror the production tightening rule; the prediction must reject the
      // counterexample without using its observed future horizon/recovery.
      calibratedDecisions.push(assessNetBenefit({ ...input,
        minimumFutureRequests: Math.min(original.minimumFutureRequests, calibration.minimumFutureRequests),
        expectedRecoveryCost: Math.max(original.expectedRecoveryCost, calibration.expectedRecoveryCost) }))
    } catch { return failed('invalid-economic-inputs') }
  }
  const hindsightPassed = decisions.length > 0 && decisions.every(decision => decision.adopt === false)
  const calibratedPassed = calibratedDecisions.length > 0 && calibratedDecisions.every(decision => decision.adopt === false)
  return { passed: hindsightPassed && calibratedPassed, hindsightPassed, calibratedPassed, actualExtraCost, decisions, calibratedDecisions }
}

/** Original fourteen-feature gate, separate from the frozen v2 benchmark gate.
 * Freeze expectedRunIds before collecting calibration runs. Pin the existing
 * historical negative report's expectedReportHash before running its backtest.
 * No local validator can authenticate
 * a fabricated provider transcript or detect deliberately hidden runs outside that plan.
 */
export function originalAcceptance(report, calibrationEvidence, negativeBacktest) {
  let benchmarkAccepted = false
  try {
    benchmarkAccepted = report?.evaluationKind === 'acceptance-v2-live-provider' &&
      summarizeAcceptanceV2(report.plan, report.results, { replay: false, pricing: report.pricing, provenance: report.provenance }).fullAccepted === true
  } catch {}
  const evidence = inspectOriginalCalibration(report, calibrationEvidence, negativeBacktest)
  return { accepted: benchmarkAccepted && evidence.calibrationEvidenceComplete && evidence.shortHorizonBacktestPassed,
    benchmarkAccepted, ...evidence,
    claimBoundary: 'Acceptance applies only to the frozen benchmark and internally consistent calibration/backtest evidence; it does not guarantee savings on other workloads.' }
}

/** Validate comparable calibration and disjoint held-out evidence only.
 * Benchmark quality, adoption and savings must be independently evaluated.
 */
export function inspectOriginalCalibration(report, calibrationEvidence, negativeBacktest) {
  const { reports, expectedRunIds } = calibrationEvidence ?? {}
  const membershipComplete = Array.isArray(expectedRunIds) && expectedRunIds.length >= 3 && expectedRunIds.length <= 64 &&
    expectedRunIds.every(id => typeof id === 'string' && id.trim()) && new Set(expectedRunIds).size === expectedRunIds.length &&
    Array.isArray(reports) && isDeepStrictEqual(reports.map(item => item?.runId).sort(), [...expectedRunIds].sort())
  const benchmarkRunner = runnerConfigurationScope(report?.results)
  const comparableEnvironment = benchmarkRunner && membershipComplete && reports.every(item => item && isDeepStrictEqual(item.provenance, report?.provenance) && item.model === report?.pricing?.model && Array.isArray(item.tasks) && item.tasks.every(task => isDeepStrictEqual(task?.pricing, report.pricing)) && isDeepStrictEqual(runnerConfigurationScope(item.tasks), benchmarkRunner))
  const calibration = comparableEnvironment ? calibrateRetirementReports(reports) : { status: 'declined', reason: membershipComplete ? 'incomparable-benchmark-environment' : 'incomplete-frozen-membership' }
  const overlapsCalibration = Array.isArray(reports) && reports.some(item =>
    item?.runId === negativeBacktest?.report?.runId || retirementEvidenceHash(item) === negativeBacktest?.expectedReportHash)
  const backtest = overlapsCalibration ? { passed: false, reason: 'backtest-overlaps-calibration' }
    : verifyShortHorizonBacktest(negativeBacktest, calibration)
  const calibrationEvidenceComplete = calibration.status === 'calibrated'
  return { calibrationEvidenceComplete, shortHorizonBacktestPassed: backtest.passed, calibration, backtest }
}
