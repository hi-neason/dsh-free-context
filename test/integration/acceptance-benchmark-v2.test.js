import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptanceFixtures } from '../fixtures/acceptance/tasks.js'
import { acceptanceReplayAdapter } from '../../scripts/acceptance-benchmark.js'
import { runAgentFixture } from '../../scripts/evaluate-agent.js'

test('v2 adds plugin to tuned native policy through public install order', async () => {
  const fixture = acceptanceFixtures()[0]
  const result = await runAgentFixture(fixture, 'plugin', { replay: true, adapterFactory: acceptanceReplayAdapter, composeWithTunedNative: true })
  assert.equal(result.configuration.maxInlineTokens, 1200)
  assert.equal(result.configuration.nativePolicyInstalledAfterPlugin, true)
  assert.equal(result.passed, true)
})
test('runner exceptions preserve only allowlisted metadata and available accounting', async () => {
  const result = await runAgentFixture(acceptanceFixtures()[0], 'plugin', { replay: true, configureContext() { throw Object.assign(new Error('secret credential provider body'), { code: 'EACCES' }) } })
  assert.equal(result.failure.category, 'filesystem')
  assert.equal(result.failure.code, 'EACCES')
  assert.equal(result.passed, false)
  assert.equal(JSON.stringify(result).includes('secret credential'), false)
  assert.ok(Array.isArray(result.modelCalls))
})

test('a failed later phase cannot reuse an earlier successful assistant answer', async () => {
  const fixture = structuredClone({ ...acceptanceFixtures()[0], answer: undefined })
  fixture.answer = acceptanceFixtures()[0].answer
  fixture.phases = [0, 1].map(() => ({ query: fixture.query, expected: fixture.expected }))
  let steps = 0
  const result = await runAgentFixture(fixture, 'baseline-default', { replay: true, adapterFactory: acceptanceReplayAdapter,
    configureContext(ctx) {
      ctx.on('agent/pre-step', async (_payload, next) => {
        if (++steps > 3) throw new Error('second phase failed')
        return next()
      })
    } })
  assert.equal(result.phaseResults[0].passed, true)
  assert.equal(result.passed, false)
  assert.equal(result.exactFacts, false)
  assert.equal(result.phaseResults[1].passed, false)
})

test('bounded validation feedback records initial failures and extra calls without golden answers', async () => {
  const fixture = acceptanceFixtures()[0]
  const adapterFactory = options => {
    const adapter = acceptanceReplayAdapter(options)
    const original = adapter.stream.bind(adapter)
    let rejected = false
    adapter.stream = async function* (request) {
      for await (const chunk of original(request)) {
        if (!rejected && chunk.type === 'block-end' && chunk.block.type === 'text') {
          rejected = true
          yield { ...chunk, block: { type: 'text', text: 'not valid JSON' } }
        } else yield chunk
      }
    }
    return adapter
  }
  const result = await runAgentFixture(fixture, 'plugin', { replay: true, adapterFactory, validationFeedbackLimit: 2, composeWithTunedNative: true, maxSteps: 12 })
  assert.equal(result.passed, true)
  assert.equal(result.correctionCount, 1)
  assert.equal(result.drafts[0].actual, null)
  assert.equal(result.modelCalls.length, 4)
  assert.equal(result.usage.inputTokens, 40)
  assert.equal(JSON.stringify(result.feedback).includes('blocked'), false)
  assert.equal(JSON.stringify(result.feedback).includes('retry_count'), false)
})
