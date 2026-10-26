import test from 'node:test'
import assert from 'node:assert/strict'
import { calibrateRetirementReports } from '../scripts/calibrate-retirement.js'

function reports() {
  return [2, 3, 200].map((remaining, index) => ({ evaluationKind: 'history-retirement-live-agent', completed: true, model: 'flash', assumptions: { futureRequests: 200 }, tasks: [{
    group: 'plugin', task: 'same-task', startedAt: `run-${index}`, replay: false, passed: true, usageKind: 'provider-reported', usageComplete: true, attempts: 0,
    pricing: { currency: 'USD', uncached: .3, cacheRead: .006, output: 1.2, sourceUrl: 'https://example.test/pricing' },
    retirements: [{ reason: 'retired', actualPostRetirementSteps: remaining }], toolCalls: [{ callId: 'read-1', readSnapshot: true, isError: false }],
    modelCalls: [{ complete: true, visibleToolResults: [{ callId: 'read-1' }], usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 } }],
  }] })).map(report => { const plugin = report.tasks[0]; report.tasks = [{ ...plugin, group: 'baseline-default' }, { ...plugin, group: 'baseline-tuned' }, plugin]; return report })
}
test('complete comparable real-run reports generate conservative observed configuration', () => {
  const result = calibrateRetirementReports(reports())
  assert.equal(result.status, 'calibrated')
  assert.equal(result.minimumFutureRequests, 2)
  assert.ok(result.expectedRecoveryCost > 0)
  assert.equal(result.forecastConfig.observations.length, 3)
})
test('replay, wrong scope, duplicate run, failed quality and missing recovery accounting cannot calibrate', () => {
  for (const mutate of [r => { r[0].evaluationKind = 'history-retirement-agent-replay' }, r => { r[0].completed = false },
    r => { r[0] = null }, r => { r[0].tasks[2].retirements = undefined }, r => { r[0].model = 'other' }, r => { r[0] = structuredClone(r[1]) },
    r => { r[0].tasks[2].modelCalls[0].complete = false }, r => { r[0].tasks[2].toolCalls = [] },
    r => { r[0].tasks[2].modelCalls[0].visibleToolResults = [] }, r => { r[0].tasks[2].passed = false }]) {
    const data = reports(); mutate(data)
    assert.equal(calibrateRetirementReports(data).status, 'declined')
  }
})
