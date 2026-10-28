import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptanceFixturesV4 } from '../fixtures/acceptance/tasks-v4.js'
import { runAgentFixture } from '../../scripts/evaluate-agent.js'
import { acceptanceReplayAdapterV4, experimentalConfigV4 } from '../../scripts/acceptance-benchmark-v4.js'

test('all thirteen prospective response-contract fixtures run through official AgentLoop in each comparison group', { timeout: 120000 }, async () => {
  let completed = 0
  for (const fixture of acceptanceFixturesV4()) for (const group of ['baseline-default', 'baseline-tuned', 'plugin']) {
    const result = await runAgentFixture(fixture, group, { replay: true, composeWithTunedNative: true, validationFeedbackLimit: 2,
      maxSteps: 12, timeoutMs: 120000, adapterFactory: acceptanceReplayAdapterV4,
      historyRetirement: fixture.historyRetirement, experimentalConfig: experimentalConfigV4(fixture, { replay: true }) })
    assert.equal(result.passed, true, JSON.stringify({ task: fixture.id, group, steps: result.steps, phases: result.phaseResults, feedback: result.feedback, stoppedReason: result.stoppedReason }))
    assert.equal(result.responseSchemaSatisfied, true)
    assert.equal(result.usageComplete, true)
    assert.equal(result.estimatedCostUSD, null)
    assert.equal(result.configuration.maxInlineTokens, group === 'baseline-default' ? 12500 : 1200)
    completed++
  }
  assert.equal(completed, 39)
})
