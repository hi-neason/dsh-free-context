import test from 'node:test'
import assert from 'node:assert/strict'
import { calibrateRetirementReports, retirementEvidenceHash } from '../scripts/calibrate-retirement.js'

// Synthetic contract fixture, not provider evidence or a savings result.
export function reports() {
  return [2, 3, 4].map((remaining, index) => {
    const pricing = { currency: 'USD', model: 'flash', verifiedDate: '2026-10-26', ratePeriod: 'test', uncached: .3, cacheRead: .006, output: 1.2, sourceUrl: 'https://example.test/pricing' }
    const fixture = { id: 'same-task', text: 'immutable source', expected: { answer: 42 } }
    const assumptions = { minimumFutureRequests: 200 }
    const modelCalls = Array.from({ length: remaining }, (_, step) => ({ id: step + 1, agentStep: step + 1, kind: 'agent', provider: 'deepseek-official', model: 'flash', finish: 'stop', complete: true, visibleToolResults: [{ callId: 'read-1' }], usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 } }))
    const task = { task: fixture.id, startedAt: `run-${index}`, steps: remaining, replay: false, passed: true, usageKind: 'provider-reported', usageComplete: true, attempts: 0,
      pricing, historyRetirement: assumptions, phaseResults: [{ actual: fixture.expected, passed: true, freshAnswer: true, turnCompleted: true }], turnEnds: [{ kind: 'completed' }],
      retirements: [{ reason: 'retired', beforeStep: 1, actualPostRetirementSteps: remaining }], toolCalls: [{ name: 'fixture', isError: false }, { name: 'read', phase: 0, callId: 'read-1', readSnapshot: true, isError: false }],
      usage: { inputTokens: 100 * remaining, outputTokens: 10 * remaining, cacheReadTokens: 0, cacheWriteTokens: 0 }, modelCalls }
    return { evaluationKind: 'history-retirement-live-agent', completed: true, runId: `run-${index}`, model: 'flash', fixture, fixtureHash: retirementEvidenceHash(fixture), assumptions, policyHash: retirementEvidenceHash(assumptions),
      provenance: { model: 'flash', runtimeVersion: '0.2.1-rc.2', repositoryCommit: 'a'.repeat(40), sourceTreeHash: 'b'.repeat(64), cacheCondition: 'shared-provider-cache-uncontrolled-counterbalanced' },
      tasks: ['baseline-default', 'baseline-tuned', 'plugin'].map(group => structuredClone({ ...task, group })) }
  })
}
test('complete comparable real-run reports generate conservative observed configuration', () => {
  const result = calibrateRetirementReports(reports())
  assert.equal(result.status, 'calibrated')
  assert.equal(result.minimumFutureRequests, 2)
  assert.ok(result.expectedRecoveryCost > 0)
  assert.equal(result.forecastConfig.observations.length, 3)
})
test('all groups and all calls must reconcile complete real-provider usage', () => {
  for (const mutate of [
    r => { r[0].tasks[0].modelCalls = [] },
    r => { r[0].tasks[2].modelCalls.push({ complete: true, visibleToolResults: [], provider: 'deepseek-official', model: 'flash' }) },
    r => { r[0].tasks[2].modelCalls[0].provider = 'replay' },
    r => { r[0].tasks[2].modelCalls[0].model = 'other' },
    r => { r[0].tasks[2].usage.inputTokens++ },
    r => { r[0].tasks[2].modelCalls[0].finish = null },
  ]) {
    const data = reports(); mutate(data)
    assert.equal(calibrateRetirementReports(data).status, 'declined')
  }
})
test('missing identity, impossible horizon, forged phase success and altered source cannot calibrate', () => {
  for (const mutate of [
    r => { delete r[0].provenance }, r => { delete r[0].runId },
    r => { r[0].fixture.text += ' changed' }, r => { r[0].assumptions.minimumFutureRequests++ },
    r => { r[0].tasks[2].retirements[0].actualPostRetirementSteps = 200 },
    r => { r[0].tasks[2].modelCalls[0].agentStep = 200 },
    r => { r[0].tasks[2].phaseResults[0].actual = { answer: 0 } },
    r => { r[0].tasks[2].phaseResults[0].freshAnswer = false },
    r => { r[0].tasks[2].turnEnds.push({ kind: 'error' }) },
  ]) {
    const data = reports(); mutate(data)
    assert.equal(calibrateRetirementReports(data).status, 'declined')
  }
})
test('replay, wrong scope, duplicate run, failed quality and missing recovery accounting cannot calibrate', () => {
  for (const mutate of [r => { r[0].evaluationKind = 'history-retirement-agent-replay' }, r => { r[0].completed = false },
    r => { r[0] = null }, r => { r[0].tasks[2].retirements = undefined }, r => { r[0].model = 'other' }, r => { r[0] = structuredClone(r[1]) },
    r => { r[0].tasks[2].modelCalls[0].complete = false }, r => { r[0].tasks[2].toolCalls = [] },
    r => { for (const call of r[0].tasks[2].modelCalls) call.visibleToolResults = [] }, r => { r[0].tasks[2].passed = false }]) {
    const data = reports(); mutate(data)
    assert.equal(calibrateRetirementReports(data).status, 'declined')
  }
})
