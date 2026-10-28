import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { runAgentFixture } from '../../scripts/evaluate-agent.js'
import { acceptanceReplayAdapter } from '../../scripts/acceptance-benchmark.js'
import { acceptanceFixtures } from '../fixtures/acceptance/tasks.js'

const usage = { inputTokens: 17, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0 }
const secret = 'private-provider-body-and-request-id\nAuthorization: secret'
const failure = Object.freeze({ code: 'TRANSPORT', message: secret, status: 503, requestId: secret, body: secret, headers: { authorization: secret } })
const errorFinish = Object.freeze({ type: 'finish', reason: Object.freeze({ kind: 'error', failure }) })
const fixture = { id: 'usage-stop', kind: 'text', text: 'value: 7', query: 'Call fixture and return JSON.', expected: { value: 7 },
  phases: [0, 1].map(() => ({ query: 'Call fixture and return JSON {"value":7}.', expected: { value: 7 } })) }

function adapterFactory({ error = false, missingFirst = false } = {}) {
  return ({ LlmAdapter }) => new class extends LlmAdapter {
    count = 0
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() {
      const index = this.count++
      const block = index === 0 ? { type: 'tool-call', id: 'fixture', name: 'fixture', arguments: '{}' } : { type: 'text', text: '{"value":7}' }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      if (!(missingFirst && index === 0) && !(error && index === 1)) yield { type: 'usage', usage }
      yield error && index === 1 ? errorFinish : { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    }
  }()
}

test('ended transport failure with unknown usage prevents feedback and subsequent phases without changing known usage', async () => {
  const observed = []
  const result = await runAgentFixture(fixture, 'baseline-tuned', { replay: true, validationFeedbackLimit: 2, adapterFactory: adapterFactory({ error: true }),
    configureContext(ctx) {
      ctx.on('llm/stream', (_request, next) => (async function* () {
        for await (const chunk of next()) { if (chunk.type === 'finish' && chunk.reason.kind === 'error') observed.push(chunk); yield chunk }
      })())
    } })
  assert.equal(result.modelCalls.length, 2)
  assert.equal(result.stoppedReason, 'incomplete-model-usage')
  assert.equal(result.feedback.length, 0)
  assert.equal(result.phaseResults.length, 1)
  assert.equal(result.passed, false)
  assert.equal(result.usageComplete, false)
  assert.deepEqual(result.usage, usage)
  assert.equal(result.modelCalls[1].usage, null)
  assert.deepEqual(result.modelCalls[1].failure, { category: 'transport', code: 'TRANSPORT', status: 503,
    requestIdHash: createHash('sha256').update(secret).digest('hex') })
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(observed[0], errorFinish)
  assert.equal(result.cleanup.complete, true)
})

test('missing tool-call usage prevents the next internal step, while normal in-flight calls and valid multi-phase usage continue', async () => {
  const stopped = await runAgentFixture(fixture, 'baseline-tuned', { replay: true, validationFeedbackLimit: 2, adapterFactory: adapterFactory({ missingFirst: true }) })
  assert.equal(stopped.modelCalls.length, 1)
  assert.equal(stopped.steps, 1)
  assert.equal(stopped.stoppedReason, 'incomplete-model-usage')
  assert.equal(stopped.cleanup.complete, true)
  const normal = await runAgentFixture(fixture, 'baseline-tuned', { replay: true, validationFeedbackLimit: 2, adapterFactory: adapterFactory() })
  assert.equal(normal.passed, true)
  assert.equal(normal.modelCalls.length, 3)
  assert.equal(normal.usageComplete, true)
})

test('unknown auxiliary usage prevents the next agent call, but metered max-tokens retains its existing accounting behavior', async () => {
  const base = acceptanceFixtures().find(task => task.experiment === 'task-independent')
  const task = { ...base, phases: base.phases.slice(0, 1) }
  const experimentalConfig = { admission: 'measured-trial', mode: 'apply', selectionMode: 'task-independent', tools: ['fixture'], provider: 'replay', model: 'usage-selector',
    maxInputBytes: 100000, maxPromptBytes: 120000, maxOutputBytes: 100000, maxOutputTokens: 120, maxArtifactBytes: 160000, timeoutMs: 30000, maxParagraphs: 100,
    maxCalls: 1, maxTotalCost: 1, maxCallCost: 1, pricing: { currency: 'USD', uncachedInputPerMillion: .3, cacheReadPerMillion: .006, cacheWritePerMillion: 0, outputPerMillion: 1.2 } }
  for (const metered of [false, true]) {
    const result = await runAgentFixture(task, 'plugin', { replay: true, validationFeedbackLimit: 2, experimentalConfig,
      adapterFactory(options) {
        const adapter = acceptanceReplayAdapter(options), stream = adapter.stream.bind(adapter)
        adapter.stream = async function* (request) {
          if (request.model !== experimentalConfig.model) { yield* stream(request); return }
          if (metered) yield { type: 'usage', usage }
          yield metered ? { type: 'finish', reason: { kind: 'max-tokens' } } : errorFinish
        }
        return adapter
      } })
    const auxiliary = result.modelCalls.find(call => call.kind === 'auxiliary')
    assert.equal(auxiliary.complete, metered)
    assert.equal(result.usageComplete, metered)
    if (metered) assert.equal(result.passed, true)
    else {
      assert.equal(result.modelCalls.length, 2)
      assert.equal(result.stoppedReason, 'incomplete-model-usage')
      assert.equal(result.passed, false)
      assert.equal(result.feedback.length, 0)
    }
    assert.equal(result.cleanup.complete, true)
  }
})
