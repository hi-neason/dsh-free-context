import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgentFixture } from '../../scripts/evaluate-agent.js'
import { acceptanceFixtures } from '../fixtures/acceptance/tasks.js'
import { acceptanceReplayAdapter } from '../../scripts/acceptance-benchmark.js'

test('each requested phase must consume a new successful fixture result', async () => {
  const fixture = acceptanceFixtures()[0]
  fixture.requireFixtureEachPhase = true
  fixture.phases = [0, 1].map(() => ({ query: fixture.query, expected: fixture.expected }))
  const adapterFactory = options => {
    const adapter = acceptanceReplayAdapter(options)
    const stream = adapter.stream.bind(adapter)
    adapter.stream = async function* (request) {
      if (options.phase() === 0) { yield* stream(request); return }
      // Deliberately correct facts with no new phase tool call must still fail.
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(fixture.expected) } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    return adapter
  }
  const result = await runAgentFixture(fixture, 'baseline-tuned', { replay: true, adapterFactory, validationFeedbackLimit: 2 })
  assert.equal(result.phaseResults[0].passed, true)
  assert.equal(result.passed, false)
  assert.equal(result.requiredTools, false)
  assert.equal(result.phaseResults[1].passed, true) // Correct facts alone do not satisfy the tool contract.
  assert.equal(result.feedback.length, 2)
})
