import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateRetirement, retirementAssumptions } from '../../scripts/evaluate-retirement.js'
import { agentFixtures, runAgentFixture } from '../../scripts/evaluate-agent.js'

test('real AgentLoop history-policy control retires after exposure and recovers through read', async () => {
  const report = await evaluateRetirement({ replay: true })
  assert.equal(report.completed, true)
  assert.equal(report.activated, true)
  assert.equal(report.tasks.length, 3)
  const candidate = report.tasks.find(task => task.group === 'plugin')
  assert.equal(candidate.passed, true)
  assert.equal(candidate.snapshotRecoveryRequired, true)
  assert.equal(candidate.snapshotRecovered, true)
  assert.deepEqual(candidate.decisions, [], 'upfront JSON/TAP strategies are disabled')
  const retired = candidate.retirements.find(record => record.reason === 'retired')
  assert.equal(retired.economics.adopt, true)
  assert.equal(retired.economics.minimumFutureRequests, 200)
  assert.ok(retired.actualPostRetirementSteps > 0 && retired.actualPostRetirementSteps < 200)
  assert.ok(candidate.toolCalls.some(call => call.name === 'read' && call.readSnapshot && !call.isError))
  assert.equal(candidate.estimatedCostUSD, null, 'replay makes no monetary claim')
  for (const baseline of report.tasks.filter(task => task.group !== 'plugin')) assert.deepEqual(baseline.retirements, [])
})

test('short realistic remaining-request assumptions refuse the same history rewrite', async () => {
  const fixture = (await agentFixtures()).find(item => item.kind === 'tap')
  for (const minimumFutureRequests of [2, 5]) {
    const result = await runAgentFixture(fixture, 'plugin', { replay: true,
      historyRetirement: { ...retirementAssumptions, minimumFutureRequests } })
    assert.equal(result.exactFacts, true)
    assert.equal(result.passed, true)
    assert.equal(result.snapshotRecoveryRequired, false)
    assert.equal(result.retirements.some(record => record.reason === 'retired'), false)
    assert.ok(result.retirements.some(record => record.reason === 'economic-gate' && !record.economics.adopt))
    assert.equal(result.toolCalls.some(call => call.readSnapshot), false)
  }
})

test('flash-price stress scenario rejects another model before starting tasks', async () => {
  await assert.rejects(evaluateRetirement({ replay: true, model: 'deepseek-v4-pro' }), /requires model deepseek-flash/)
})
