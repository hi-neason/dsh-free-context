import test from 'node:test'
import assert from 'node:assert/strict'
import { createAcceptancePlanV2 } from '../scripts/acceptance-benchmark-v2.js'
import { originalAcceptance, verifyShortHorizonBacktest } from '../scripts/acceptance-evidence.js'
import { calibrateRetirementReports, retirementEvidenceHash } from '../scripts/calibrate-retirement.js'

// All data here is synthetic contract-test data. It proves no real model benefit.
const pricing = { currency: 'USD', model: 'model', verifiedDate: '2026-10-26', ratePeriod: 'test', sourceUrl: 'https://example.test/prices', uncached: .3, cacheRead: .006, output: 1.2 }
const provenance = { runtimeVersion: '0.2.1-rc.2', repositoryCommit: 'a'.repeat(40), sourceTreeHash: 'b'.repeat(64), model: 'model', cacheCondition: 'shared-provider-cache-uncontrolled-counterbalanced' }
const usage = inputTokens => ({ inputTokens, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })
function benchmark() {
  const plan = createAcceptancePlanV2()
  const results = plan.runs.map(run => {
    const task = plan.tasks.find(task => task.id === run.task)
    const tokens = usage(run.group === 'plugin' ? 10 : 20)
    return { ...run, manifestHash: plan.manifestHash, passed: true, exactFacts: true, requiredTools: true, fileCorrect: true, snapshotRecovered: true,
      phaseResults: (task.phases ?? [task]).map(phase => ({ actual: phase.expected, passed: true, freshAnswer: true, turnCompleted: true })), turnEnds: [{ kind: 'completed' }],
      replay: false, usageKind: 'provider-reported', usageComplete: true, usage: tokens,
      modelCalls: [{ complete: true, provider: 'deepseek-official', model: 'model', usage: tokens }],
      configuration: { maxInlineTokens: run.group === 'baseline-default' ? 12500 : 1200, nativePolicyInstalledAfterPlugin: true, validationFeedbackLimit: 2 },
      retirements: [{ reason: task.expectedRetirement ? 'retired' : 'economic-gate', economics: { adopt: false } }],
      toolCalls: [0, 1].map(phase => ({ name: 'read', phase, readSnapshot: true, isError: false })),
      adoptions: [{ callId: 'fixture-call', strategy: task.experiment === 'diagnostic-evidence' ? 'diagnostic-evidence-selection-v1' : `${task.experiment}-prose-selection-v1`, persisted: true, modelVisible: true, contentHash: 'c'.repeat(64), persistedContentHash: 'c'.repeat(64), modelVisibleContentHash: 'c'.repeat(64) }],
      experiments: [{ callId: 'fixture-call', reason: 'selected', llmCalled: true }, { reason: task.expectedFallback }] }
  })
  return { evaluationKind: 'acceptance-v2-live-provider', plan, results, pricing, provenance }
}
function evidence() {
  const fixture = { id: 'history', text: 'unchanged source', expected: { correct: true } }
  const assumptions = { minimumFutureRequests: 200 }
  const reports = [0, 1, 2].map(index => ({ evaluationKind: 'history-retirement-live-agent', completed: true, runId: `run-${index}`, model: 'model', provenance,
    fixture, fixtureHash: retirementEvidenceHash(fixture), assumptions, policyHash: retirementEvidenceHash(assumptions), tasks: ['baseline-default', 'baseline-tuned', 'plugin'].map(group => ({
      group, task: fixture.id, startedAt: `run-${index}`, steps: 2, replay: false, passed: true, usageKind: 'provider-reported', usageComplete: true, attempts: 0, pricing, historyRetirement: assumptions,
      phaseResults: [{ actual: fixture.expected, passed: true, freshAnswer: true, turnCompleted: true }], turnEnds: [{ kind: 'completed' }],
      retirements: [{ reason: 'retired', beforeStep: 1, actualPostRetirementSteps: 2, economics: { minimumFutureRequests: 200, adopt: true, removedTokens: 1000, compressionCost: 0, expectedRecoveryCost: 0, cacheRebuildCost: .0001, safetyMargin: .25 } }],
      toolCalls: [{ name: 'fixture', isError: false }, { callId: 'read-1', phase: 0, name: 'read', readSnapshot: true, isError: false }],
      modelCalls: [1, 2].map(agentStep => ({ id: agentStep, agentStep, kind: 'agent', complete: true, finish: 'stop', provider: 'deepseek-official', model: 'model', visibleToolResults: [{ callId: 'read-1' }], usage: usage(group === 'plugin' ? 200 : 100) })),
      usage: { ...usage(group === 'plugin' ? 400 : 200), outputTokens: 2 },
    })) }))
  const negative = structuredClone(reports[0])
  return { calibration: { reports, expectedRunIds: reports.map(report => report.runId) }, backtest: { report: negative, expectedReportHash: retirementEvidenceHash(negative) } }
}
test('original acceptance recomputes benchmark, calibration and pinned negative backtest', () => {
  const data = evidence()
  const result = originalAcceptance(benchmark(), data.calibration, data.backtest)
  assert.equal(result.benchmarkAccepted, true)
  assert.equal(result.calibrationEvidenceComplete, true)
  assert.equal(result.shortHorizonBacktestPassed, true)
  assert.equal(result.accepted, true)
  assert.equal(originalAcceptance({ fullAccepted: true }, data.calibration, data.backtest).accepted, false)
  assert.equal(originalAcceptance(benchmark()).accepted, false)
})
test('missing planned runs, duplicate evidence and changed backtest inputs reject original acceptance', () => {
  for (const mutate of [
    data => { data.calibration.reports.pop() },
    data => { data.calibration.reports[0] = data.calibration.reports[1] },
    data => { data.calibration.reports[0].tasks[2].modelCalls[0].provider = 'replay' },
    data => { data.backtest.report.tasks[2].retirements[0].economics.cacheRebuildCost = 0 },
    data => { delete data.backtest.expectedReportHash },
  ]) {
    const data = evidence(); mutate(data)
    assert.equal(originalAcceptance(benchmark(), data.calibration, data.backtest).accepted, false)
  }
})
test('backtest requires observed loss, short horizon and a genuine conservative rejection', () => {
  const { backtest, calibration } = evidence()
  const forecast = calibrateRetirementReports(calibration.reports)
  assert.equal(verifyShortHorizonBacktest(backtest, forecast).passed, true)
  assert.equal(verifyShortHorizonBacktest(backtest).passed, false)
  assert.equal(verifyShortHorizonBacktest(backtest, { ...forecast, scope: 'other-workload' }).passed, false)
  backtest.report.tasks[2].usage = backtest.report.tasks[1].usage
  backtest.report.tasks[2].modelCalls = backtest.report.tasks[1].modelCalls
  backtest.expectedReportHash = retirementEvidenceHash(backtest.report)
  assert.equal(verifyShortHorizonBacktest(backtest, forecast).passed, false)
})

test('hindsight rejection cannot pass when the derived calibration would still adopt the negative case', () => {
  const data = evidence()
  for (const report of data.calibration.reports) for (const task of report.tasks) {
    task.steps = 8
    task.retirements[0].actualPostRetirementSteps = 8
    task.modelCalls = Array.from({ length: 8 }, (_, index) => ({ ...task.modelCalls[0], id: index + 1, agentStep: index + 1,
      visibleToolResults: index >= 6 ? [{ callId: 'read-1' }] : [],
      usage: { inputTokens: 0, outputTokens: index >= 6 ? 1 : 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }))
    task.usage = { inputTokens: 0, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
  }
  data.backtest.report.tasks[2].retirements[0].economics.cacheRebuildCost = .000025
  data.backtest.expectedReportHash = retirementEvidenceHash(data.backtest.report)
  const result = originalAcceptance(benchmark(), data.calibration, data.backtest)
  assert.equal(result.calibration.minimumFutureRequests, 8)
  assert.equal(result.calibration.expectedRecoveryCost, .0000024)
  assert.equal(result.accepted, false)
  assert.equal(result.backtest.hindsightPassed, true)
  assert.equal(result.backtest.calibratedPassed, false)
  assert.equal(result.backtest.calibratedDecisions[0].adopt, true)
})
