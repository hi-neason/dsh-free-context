import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as plugin from 'dsh-free-context/experiments'
import { parseExperimentConfig } from '../src/experiment-config.js'

const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} explains general background in ordinary prose. ${'This sentence provides further descriptive context. '.repeat(10)}`).join('\n\n')
const settings = overrides => ({ mode: 'apply', tools: ['read'], provider: 'fake', model: 'fake-model',
  maxInputBytes: 40000, maxPromptBytes: 50000, maxOutputBytes: 1000, maxOutputTokens: 100,
  maxArtifactBytes: 60000, timeoutMs: 1000, maxParagraphs: 50, maxCacheEntries: 2, protectedTerms: [],
  pricing: { currency: 'USD', uncachedInputPerMillion: 1, cacheReadPerMillion: 0.1, outputPerMillion: 1 },
  minimumFutureRequests: 1000, futureCacheReadPerMillion: 0.1, expectedRecoveryCost: 0, safetyMargin: 0.1, maxCallCost: 1,
  ...overrides })
const execution = () => ({ name: 'read', callId: 'call-1', agent: { session: { header: { id: 'session-1' } } }, signal: new AbortController().signal })
const result = () => ({ isError: false, content: [{ type: 'text', text }], value: { unchanged: true } })
function setup(overrides = {}, behavior = {}) {
  const events = []
  const saves = []
  const calls = []
  const store = { async saveText(input) {
    if (behavior.storageFailure) throw new Error('private storage detail')
    saves.push(input)
    return { locator: `spill://fixture/${saves.length}`, bytes: Buffer.byteLength(input.content), retrievalHint: 'Use exact snapshot.' }
  } }
  let handler
  const ctx = {
    on: (_event, callback) => { handler = callback }, logger: { warn() {} },
    get: () => behavior.noStore ? undefined : store,
    parallel: async (event, record) => { events.push({ event, record }) },
    llm: { async * stream(request) {
      calls.push(request)
      if (behavior.cancel) behavior.cancel.abort()
      const response = behavior.invalidResponse ? '{"selectedIds":[]}' : '{"selectedIds":["p1"]}'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: response }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
      if (!behavior.noUsage) yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, ...(behavior.write ? { cacheWriteTokens: 20 } : {}) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
  }
  plugin.apply(ctx, settings(overrides))
  return { handler, events, saves, calls }
}

test('disabled defaults make no hook or model calls; active configuration is strict and frozen', () => {
  plugin.apply({ on: () => assert.fail('disabled') })
  assert.deepEqual(plugin.inject, ['tools', 'llm'])
  const input = settings()
  const config = parseExperimentConfig(input)
  input.tools.push('other')
  assert.deepEqual(config.tools, ['read'])
  assert.equal(Object.isFrozen(config.pricing), true)
  for (const invalid of [{ unexpected: true }, { tools: ['read', 'read'] }, { mode: 'apply', tools: ['read'] }, { pricing: { currency: 'bad' } }, { maxCallCost: -1 }]) assert.throws(() => parseExperimentConfig(invalid), TypeError)
})

test('apply archives original and full auxiliary audit before returning a candidate with real references', async () => {
  const { handler, events, saves, calls } = setup()
  const original = result()
  const contexts = [{ role: 'user', content: [{ type: 'text', text: 'context' }] }]
  const decision = { kind: 'accept', additionalContexts: contexts }
  const actual = await handler(execution(), original, async () => decision)
  assert.notEqual(actual, decision)
  assert.equal(actual.additionalContexts, contexts)
  assert.deepEqual(original.value, { unchanged: true })
  assert.equal(saves[0].content, text)
  assert.equal(saves.length, 2)
  const manifest = JSON.parse(saves[1].content)
  assert.ok(manifest.audit.request.messages[0].content[0].text.includes(text.split('\n\n')[0]))
  assert.equal(manifest.audit.response[0].text, '{"selectedIds":["p1"]}')
  assert.equal(manifest.audit.request.provider, 'fake')
  assert.equal(manifest.callUsage.inputTokens, 100)
  assert.ok(actual.content[0].text.includes('spill://fixture/1'))
  assert.ok(actual.content[0].text.includes('spill://fixture/2'))
  assert.ok(actual.content[0].text.includes('UTF-16'))
  assert.equal(calls.length, 1)
  const report = events.find(item => item.event === 'free-context/experiment').record
  assert.equal(report.reason, 'selected')
  assert.ok(Math.abs(report.estimatedCost - 0.000115) < 1e-12)
  assert.equal(JSON.stringify(events).includes('ordinary prose'), false)
})

test('observe still incurs a model call and stores artifacts but preserves original decision', async () => {
  const { handler, saves, calls } = setup({ mode: 'observe' })
  const decision = { kind: 'accept' }
  assert.equal(await handler(execution(), result(), async () => decision), decision)
  assert.equal(calls.length, 1)
  assert.equal(saves.length, 2)
})

test('pre-call budgets, missing assumptions, no storage and archive failure prevent model calls', async () => {
  const scenarios = [
    [{ maxCallCost: 0 }, {}, 'call-cost-budget'],
    [{ pricing: undefined }, {}, 'missing-pricing'],
    [{ minimumFutureRequests: undefined }, {}, 'missing-economic-assumptions'],
    [{ minimumFutureRequests: 0 }, {}, 'no-predicted-benefit-before-call'],
    [{}, { noStore: true }, 'snapshot-failed'],
    [{}, { storageFailure: true }, 'snapshot-failed'],
  ]
  for (const [config, behavior, reason] of scenarios) {
    const { handler, calls, events } = setup(config, behavior)
    const decision = { kind: 'accept' }
    assert.equal(await handler(execution(), result(), async () => decision), decision)
    assert.equal(calls.length, 0)
    assert.equal(events[0].record.reason, reason)
  }
})

test('missing usage, unknown write price, invalid selections and abort never apply', async () => {
  for (const behavior of [{ noUsage: true }, { write: true }, { invalidResponse: true }, { cancel: new AbortController() }]) {
    const { handler, events } = setup({}, behavior)
    const exec = execution()
    if (behavior.cancel) exec.signal = behavior.cancel.signal
    const decision = { kind: 'accept' }
    assert.equal(await handler(exec, result(), async () => decision), decision)
    assert.notEqual(events[0].record.reason, 'selected')
    if (behavior.invalidResponse) assert.ok(events[0].record.estimatedCost > 0)
  }
})

test('cache hits reuse verified selection and origin usage without charging another model call', async () => {
  const { handler, calls, events, saves } = setup()
  const exec = execution()
  await handler(exec, result(), async () => ({ kind: 'accept' }))
  await handler(exec, result(), async () => ({ kind: 'accept' }))
  assert.equal(calls.length, 1)
  const reports = events.filter(item => item.event === 'free-context/experiment')
  assert.equal(reports[1].record.cacheHit, true)
  assert.equal(reports[1].record.estimatedCost, 0)
  assert.equal(reports[1].record.callUsage, undefined)
  assert.equal(JSON.parse(saves[3].content).originUsage.inputTokens, 100)
})

test('complete artifact references and archive budget are included before economic application', async () => {
  const { handler, events } = setup({ maxArtifactBytes: 1 })
  const decision = { kind: 'accept' }
  assert.equal(await handler(execution(), result(), async () => decision), decision)
  assert.equal(events[0].record.reason, 'manifest-failed')
})


test('cached selections cannot bypass missing originating cache-write prices', async () => {
  const { handler, calls, events } = setup({}, { write: true })
  const exec = execution()
  const decision = { kind: 'accept' }
  assert.equal(await handler(exec, result(), async () => decision), decision)
  assert.equal(await handler(exec, result(), async () => decision), decision)
  assert.equal(calls.length, 1)
  assert.equal(events.filter(item => item.event === 'free-context/experiment').at(-1).record.reason, 'missing-priced-usage')
})


test('future main-request cache price is required and independent from auxiliary cache pricing', async () => {
  for (const override of [{ futureCacheReadPerMillion: undefined }, { futureCacheReadPerMillion: 0 }]) {
    const { handler, calls, events } = setup(override)
    const decision = { kind: 'accept' }
    assert.equal(await handler(execution(), result(), async () => decision), decision)
    assert.equal(calls.length, 0)
    assert.equal(events[0].record.reason, override.futureCacheReadPerMillion === undefined ? 'missing-economic-assumptions' : 'no-predicted-benefit-before-call')
  }
  const { handler, events } = setup({ futureCacheReadPerMillion: 1, pricing: { currency: 'USD', uncachedInputPerMillion: 1, cacheReadPerMillion: 0, outputPerMillion: 1 } })
  await handler(execution(), result(), async () => ({ kind: 'accept' }))
  assert.equal(events[0].record.reason, 'selected')
  assert.equal(events[0].record.estimatedCost, 0.00011)
})
