import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTextSelector } from 'dsh-free-context/text-selection'

const source = 'First paragraph explains the general background.\n\nSecond paragraph contains a protected fact: KEEP.\n\nThird paragraph adds a qualification.'
const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, totalTokens: 130 }
const config = llm => ({ llm, provider: 'explicit-provider', model: 'explicit-model', maxInputBytes: 10000,
  maxPromptBytes: 20000, maxOutputBytes: 2000, maxOutputTokens: 200,
  timeoutMs: 1000, maxParagraphs: 20, maxCacheEntries: 2, protectedTerms: ['KEEP'] })
function runtime(response = '{"selectedIds":["p2"]}', settings = {}) {
  const calls = []
  return { calls, stream(request) {
    calls.push(request)
    return (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: response.slice(0, 5) }
      yield { type: 'text-delta', index: 0, text: response.slice(5) }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: settings.endText ?? response } }
      if (settings.usage !== false) yield { type: 'usage', usage: settings.usage ?? usage }
      yield { type: 'finish', reason: { kind: settings.finish ?? 'stop' } }
      if (settings.extra) yield { type: 'text-delta', index: 0, text: 'extra' }
    })()
  } }
}

test('calls public streaming protocol with explicit route, selects original spans and collects real usage', async () => {
  const llm = runtime()
  const select = createTextSelector(config(llm))
  const result = await select({ kind: 'prose', text: source })
  assert.equal(result.status, 'selected')
  assert.equal(result.cacheHit, false)
  assert.equal(result.llmCalled, true)
  assert.equal(result.usageComplete, true)
  assert.deepEqual(result.callUsage, usage)
  assert.deepEqual(result.originUsage, usage)
  assert.equal(result.spans[0].text, source.slice(result.spans[0].start, result.spans[0].end))
  assert.ok(result.text.includes('[Source paragraph p2; UTF-16 '))
  assert.equal(result.sourceHash.length, 64)
  assert.ok(result.elapsedMs >= 0)
  const request = llm.calls[0]
  assert.equal(request.provider, 'explicit-provider')
  assert.equal(request.model, 'explicit-model')
  assert.equal(request.maxTokens, 200)
  assert.deepEqual(Object.keys(request.messages[0]).sort(), ['content', 'role'])
  assert.equal('tools' in request, false)
  assert.equal('sessionId' in request, false)
  assert.ok(request.messages[0].content[0].text.includes('independent of any current task'))
})

test('rejects rewritten output, duplicates, unknown IDs, extra fields, empty selection and duplicate keys', async () => {
  for (const response of [
    'rewritten paragraph', '{"selectedIds":["p2"],"text":"rewritten"}', '{"selectedIds":["p2","p2"]}',
    '{"selectedIds":["p0"]}', '{"selectedIds":[]}', '{"selectedIds":[2]}', '{"selectedIds":["p2"]',
    '{"selectedIds":["p2"],"selectedIds":["p2"]}', '```json\n{"selectedIds":["p2"]}\n```',
  ]) {
    const result = await createTextSelector(config(runtime(response)))({ kind: 'prose', text: source })
    assert.equal(result.reason, 'invalid-selection', response)
    assert.deepEqual(result.callUsage, usage)
  }
})

test('requires every protected paragraph and always returns original source order', async () => {
  assert.equal((await createTextSelector(config(runtime('{"selectedIds":["p1"]}')))({ kind: 'prose', text: source })).reason, 'protected-paragraph-omitted')
  const result = await createTextSelector(config(runtime('{ "selectedIds" : ["p3", "p2"] }')))({ kind: 'prose', text: source })
  assert.deepEqual(result.selectedIds, ['p2', 'p3'])
})

test('usage is optional for observation but missing or invalid usage cannot authorize economic adoption', async () => {
  const absent = await createTextSelector(config(runtime(undefined, { usage: false })))({ kind: 'prose', text: source })
  assert.equal(absent.status, 'selected')
  assert.equal(absent.usageComplete, false)
  assert.equal(absent.callUsage, undefined)
  const invalid = await createTextSelector(config(runtime(undefined, { usage: { inputTokens: NaN, outputTokens: 1 } })))({ kind: 'prose', text: source })
  assert.equal(invalid.reason, 'invalid-usage')
})

test('only bounded plain prose is admitted and budgets are distinct from token claims', async () => {
  const llm = runtime()
  const select = createTextSelector(config(llm))
  for (const text of ['```js\nconst x = 1\n```', '[{"a":1}]', 'TAP version 13\nok 1', 'const value = 1', '# Heading\ntext', '<xml>text</xml>']) {
    assert.equal((await select({ kind: 'prose', text })).reason, 'structured-content')
  }
  assert.equal((await select({ kind: 'code', text: source })).reason, 'unsupported-content')
  assert.equal(llm.calls.length, 0)
  assert.equal((await createTextSelector({ ...config(llm), maxInputBytes: 1 })({ kind: 'prose', text: source })).reason, 'input-byte-budget')
  assert.equal((await createTextSelector({ ...config(llm), maxPromptBytes: 1 })({ kind: 'prose', text: source })).reason, 'prompt-byte-budget')
  assert.equal((await createTextSelector({ ...config(llm), maxParagraphs: 1 })({ kind: 'prose', text: source })).reason, 'paragraph-budget')
  assert.equal((await createTextSelector({ ...config(runtime()), maxOutputBytes: 1 })({ kind: 'prose', text: source })).reason, 'output-byte-budget')
  assert.equal((await createTextSelector({ ...config(runtime()), maxOutputTokens: 1 })({ kind: 'prose', text: source })).reason, 'output-token-budget')
})

test('invalid or unsuccessful stream endings never produce selections', async () => {
  for (const settings of [{ finish: 'max-tokens' }, { finish: 'error' }, { extra: true }, { endText: 'different' }]) {
    const result = await createTextSelector(config(runtime(undefined, settings)))({ kind: 'prose', text: source })
    assert.equal(result.status, 'declined')
  }
  const result = await createTextSelector(config({ stream: async function* () { yield { type: 'tool-call-delta', index: 0, id: 'x' } } }))({ kind: 'prose', text: source })
  assert.equal(result.reason, 'invalid-stream')
})

test('timeout and abort return promptly even for an uncooperative stream', async () => {
  const calls = []
  const llm = { stream(request) { calls.push(request); return { [Symbol.asyncIterator]() { return this }, next: () => new Promise(() => {}), return: () => new Promise(() => {}) } } }
  const select = createTextSelector({ ...config(llm), timeoutMs: 15 })
  const timeout = await select({ kind: 'prose', text: source })
  assert.equal(timeout.reason, 'timeout')
  assert.equal(calls[0].signal.aborted, true)
  const controller = new AbortController()
  const pending = createTextSelector(config(llm))({ kind: 'prose', text: source, signal: controller.signal })
  controller.abort()
  assert.equal((await pending).reason, 'aborted')
  assert.equal((await select({ kind: 'prose', text: source, signal: AbortSignal.abort() })).llmCalled, false)
})

test('cache is session-object isolated, content/config keyed, bounded and never double-reports call usage', async () => {
  const llm = runtime()
  const options = config(llm)
  const select = createTextSelector(options)
  const session = {}
  const first = await select({ kind: 'prose', text: source, session })
  options.model = 'mutated-model'
  options.protectedTerms.push('new term')
  const cached = await select({ kind: 'prose', text: source, session })
  assert.equal(cached.cacheHit, true)
  assert.equal(cached.llmCalled, false)
  assert.equal(cached.callUsage, undefined)
  assert.deepEqual(cached.originUsage, first.callUsage)
  assert.equal(Object.isFrozen(cached.spans), true)
  assert.equal(llm.calls.length, 1)
  assert.equal((await select({ kind: 'prose', text: source, session: {} })).cacheHit, false)
  await select({ kind: 'prose', text: source + ' extra one', session })
  await select({ kind: 'prose', text: source + ' extra two', session })
  assert.equal((await select({ kind: 'prose', text: source, session })).cacheHit, false)
  const otherModel = createTextSelector({ ...config(llm), model: 'other-model' })
  assert.equal((await otherModel({ kind: 'prose', text: source, session })).cacheHit, false)
  assert.equal((await select({ kind: 'prose', text: source })).cacheHit, false)
})

test('invalid selections are not cached and missing usage remains incomplete on cache hit', async () => {
  const session = {}
  const llm = runtime('{"selectedIds":["p1"]}')
  const select = createTextSelector(config(llm))
  await select({ kind: 'prose', text: source, session })
  await select({ kind: 'prose', text: source, session })
  assert.equal(llm.calls.length, 2)
  const missing = createTextSelector(config(runtime(undefined, { usage: false })))
  await missing({ kind: 'prose', text: source, session })
  const result = await missing({ kind: 'prose', text: source, session })
  assert.equal(result.cacheHit, true)
  assert.equal(result.usageComplete, false)
})

test('configuration requires explicit route and all budgets', () => {
  for (const key of ['provider', 'model', 'maxInputBytes', 'maxPromptBytes', 'maxOutputBytes', 'maxOutputTokens', 'timeoutMs', 'maxParagraphs', 'maxCacheEntries', 'protectedTerms']) {
    const options = config(runtime())
    delete options[key]
    assert.throws(() => createTextSelector(options), TypeError)
  }
  assert.throws(() => createTextSelector({ ...config(runtime()), timeoutMs: 2147483648 }), TypeError)
})


test('Unicode source offsets and CRLF paragraphs recover exact original slices', async () => {
  const text = '背景 😀 保持原样。\r\n\r\nKEEP 中文证据与空格。  '
  const result = await createTextSelector(config(runtime()))({ kind: 'prose', text })
  assert.equal(result.status, 'selected')
  assert.equal(result.spans[0].text, 'KEEP 中文证据与空格。  ')
  assert.equal(text.slice(result.spans[0].start, result.spans[0].end), result.spans[0].text)
})

test('reasoning stream bytes are bounded and contradictory usage is rejected', async () => {
  const llm = { stream: async function* () {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: 'x'.repeat(20) }
  } }
  assert.equal((await createTextSelector({ ...config(llm), maxOutputBytes: 10 })({ kind: 'prose', text: source })).reason, 'output-byte-budget')
  const invalid = await createTextSelector(config(runtime(undefined, { usage: { ...usage, totalTokens: 999 } })))({ kind: 'prose', text: source })
  assert.equal(invalid.reason, 'invalid-usage')
})
