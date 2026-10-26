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

test('query-dependent selection genuinely changes with A/B tasks and cache keys include the complete query', async () => {
  const calls = []
  const llm = { async * stream(request) {
    const payload = JSON.parse(request.messages[0].content[0].text.split('\n').at(-1))
    calls.push(payload.currentTask)
    const response = JSON.stringify({ selectedIds: [payload.currentTask === 'Question Alpha' ? 'p1' : 'p2'] })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: response }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const select = createTextSelector({ ...config(llm), selectionMode: 'query-dependent', maxQueryBytes: 100, protectedTerms: [] })
  const session = {}
  const alpha = await select({ kind: 'prose', text: source, session, query: 'Question Alpha' })
  const beta = await select({ kind: 'prose', text: source, session, query: 'Question Beta' })
  const again = await select({ kind: 'prose', text: source, session, query: 'Question Alpha' })
  assert.deepEqual(alpha.selectedIds, ['p1'])
  assert.deepEqual(beta.selectedIds, ['p2'])
  assert.equal(alpha.sourceHash, beta.sourceHash)
  assert.notEqual(alpha.queryHash, beta.queryHash)
  assert.equal(again.cacheHit, true)
  assert.equal(again.callUsage, undefined)
  assert.deepEqual(calls, ['Question Alpha', 'Question Beta'])
  assert.equal(beta.strategy, 'query-dependent-prose-selection-v1')
})

test('query mode rejects absent/oversized queries before calling; independent mode never forwards an incidental query', async () => {
  const llm = runtime()
  const select = createTextSelector({ ...config(llm), selectionMode: 'query-dependent', maxQueryBytes: 5 })
  for (const query of [undefined, '', 2, '\ud800']) assert.equal((await select({ kind: 'prose', text: source, query })).reason, 'missing-query')
  assert.equal((await select({ kind: 'prose', text: source, query: '太长问题' })).reason, 'query-byte-budget')
  assert.equal(llm.calls.length, 0)
  await createTextSelector(config(llm))({ kind: 'prose', text: source, query: 'MUST_NOT_FORWARD' })
  assert.equal(llm.calls[0].messages[0].content[0].text.includes('MUST_NOT_FORWARD'), false)
  assert.throws(() => createTextSelector({ ...config(llm), selectionMode: 'query-dependent' }), /maxQueryBytes/)
})

const diagnostics = 'src/main.ts(12,3): error TS2322: wrong type.\n  at src/caller.ts:8:2\n\nINFO: ordinary progress.\n\nStatus: failed; Errors: 1\n\nExit code: 2'
const diagnosticOptions = llm => ({ ...config(llm), selectionMode: 'diagnostic-evidence', protectedTerms: [] })
test('diagnostic mode preserves mandatory exact evidence, line provenance and session cache usage', async () => {
  const llm = runtime('{"selectedIds":["d4","d1","d3"]}')
  const select = createTextSelector(diagnosticOptions(llm))
  const session = {}
  const result = await select({ kind: 'diagnostic', text: diagnostics, session })
  assert.equal(result.status, 'selected')
  assert.deepEqual(result.selectedIds, ['d1', 'd3', 'd4'])
  assert.equal(result.strategy, 'diagnostic-evidence-selection-v1')
  assert.equal(result.spans[0].startLine, 1)
  assert.equal(result.spans[0].endLine, 2)
  for (const span of result.spans) assert.equal(span.text, diagnostics.slice(span.start, span.end))
  assert.ok(result.text.includes('TS2322'))
  assert.ok(result.text.includes('src/caller.ts:8:2'))
  const cached = await select({ kind: 'diagnostic', text: diagnostics, session })
  assert.equal(cached.cacheHit, true)
  assert.equal(cached.callUsage, undefined)
  assert.equal(llm.calls.length, 1)
  const payload = JSON.parse(llm.calls[0].messages[0].content[0].text.split('\n').at(-1))
  assert.deepEqual(payload.requiredIds, ['d1', 'd3', 'd4'])
})
test('diagnostic omission and optional protected terms fail closed; unknown formats never call model', async () => {
  for (const selectedIds of [['d1', 'd3'], ['d3', 'd4'], ['d1', 'd4']]) {
    const select = createTextSelector(diagnosticOptions(runtime(JSON.stringify({ selectedIds }))))
    assert.equal((await select({ kind: 'diagnostic', text: diagnostics })).reason, 'protected-diagnostic-omitted')
  }
  const protectedSelect = createTextSelector({ ...diagnosticOptions(runtime('{"selectedIds":["d1","d3","d4"]}')), protectedTerms: ['ordinary'] })
  assert.equal((await protectedSelect({ kind: 'diagnostic', text: diagnostics })).reason, 'protected-diagnostic-omitted')
  const llm = runtime()
  assert.equal((await createTextSelector(diagnosticOptions(llm))({ kind: 'diagnostic', text: diagnostics + '\n\nunknown result' })).reason, 'unrecognized-diagnostic-block')
  assert.equal(llm.calls.length, 0)
})

test('accepts authoritative block-end and delta-only text with bounded final bytes', async () => {
  for (const authoritative of [true, false]) {
    const llm = { async * stream() {
      if (authoritative) yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"selectedIds":["p2"]}' } }
      else yield { type: 'text-delta', index: 0, text: '{"selectedIds":["p2"]}' }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    assert.equal((await createTextSelector(config(llm))({ kind: 'prose', text: source })).status, 'selected')
    assert.equal((await createTextSelector({ ...config(llm), maxOutputBytes: 1 })({ kind: 'prose', text: source })).reason, 'output-byte-budget')
  }
  assert.deepEqual((await createTextSelector(config(runtime('temporary', { endText: '{"selectedIds":["p2"]}' })))({ kind: 'prose', text: source })).selectedIds, ['p2'])
})

test('preparation is pure, opaque, and exposes actual serialized prompt bytes', async () => {
  const llm = runtime()
  const select = createTextSelector(config(llm))
  const prepared = select.prepare({ kind: 'prose', text: source })
  assert.equal(prepared.status, 'prepared')
  assert.equal(llm.calls.length, 0)
  assert.equal((await select.execute({ ...prepared })).reason, 'invalid-preparation')
  await select.execute(prepared)
  assert.equal(prepared.requestBytes, Buffer.byteLength(JSON.stringify(llm.calls[0].messages)))
})

test('concurrent identical calls share usage once and cancellation is consumer-local', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const base = runtime()
  const llm = { calls: [], stream(request) { this.calls.push(request); return (async function* () { await gate; yield* base.stream(request) })() } }
  const select = createTextSelector(config(llm))
  const session = {}
  const controller = new AbortController()
  const first = select({ kind: 'prose', text: source, session, signal: controller.signal })
  const second = select({ kind: 'prose', text: source, session })
  controller.abort()
  assert.equal((await first).reason, 'aborted')
  assert.equal(llm.calls[0].signal.aborted, false)
  release()
  const result = await second
  assert.equal(result.status, 'selected')
  assert.deepEqual(result.callUsage, usage)
  assert.equal(llm.calls.length, 1)
  const other = createTextSelector(config(runtime()))
  const results = await Promise.all([other({ kind: 'prose', text: source, session }), other({ kind: 'prose', text: source, session })])
  assert.equal(results.filter(result => result.callUsage).length, 1)
  assert.ok(results.every(result => result.usageComplete && result.originUsage.inputTokens === 100))
})

test('in-flight limits, last-consumer abort, query/session isolation and missing usage stay fail-closed', async () => {
  const calls = []
  const llm = { stream(request) { calls.push(request); return { [Symbol.asyncIterator]() { return this }, next: () => new Promise(() => {}) } } }
  const select = createTextSelector({ ...config(llm), maxInFlight: 2, selectionMode: 'query-dependent', maxQueryBytes: 100 })
  const session = {}
  const a = new AbortController()
  const b = new AbortController()
  const first = select({ kind: 'prose', text: source, session, query: 'a', signal: a.signal })
  const second = select({ kind: 'prose', text: source, session, query: 'b', signal: b.signal })
  assert.equal(calls.length, 2)
  assert.equal((await select({ kind: 'prose', text: source, session: {}, query: 'a' })).reason, 'in-flight-budget')
  a.abort(); b.abort()
  assert.equal((await first).llmCalled, true)
  assert.equal((await second).reason, 'aborted')
  assert.ok(calls.every(call => call.signal.aborted))
  const incomplete = createTextSelector(config(runtime(undefined, { usage: false })))
  const results = await Promise.all([incomplete({ kind: 'prose', text: source, session }), incomplete({ kind: 'prose', text: source, session })])
  assert.ok(results.every(result => !result.usageComplete))
})

test('abort after settlement cannot invalidate shared result or cached provenance', async () => {
  const llm = runtime()
  const select = createTextSelector(config(llm))
  const session = {}
  const controller = new AbortController()
  const results = await Promise.all([select({ kind: 'prose', text: source, session, signal: controller.signal }), select({ kind: 'prose', text: source, session })])
  controller.abort()
  assert.ok(results.every(result => result.status === 'selected'))
  assert.equal(results.filter(result => result.callUsage).length, 1)
  const cached = await select({ kind: 'prose', text: source, session })
  assert.equal(cached.cacheHit, true)
  assert.deepEqual(cached.originUsage, usage)
  assert.equal(llm.calls.length, 1)
})

test('timed-out adapters retain backend slots until pending next and return settle', async () => {
  let calls = 0
  let releaseNext
  let releaseReturn
  const llm = { stream() {
    calls++
    return { [Symbol.asyncIterator]() { return this }, next: () => new Promise(resolve => { releaseNext = resolve }), return: () => new Promise(resolve => { releaseReturn = resolve }) }
  } }
  const select = createTextSelector({ ...config(llm), maxInFlight: 1, timeoutMs: 5 })
  assert.equal((await select({ kind: 'prose', text: source })).reason, 'timeout')
  assert.equal((await select({ kind: 'prose', text: source })).reason, 'in-flight-budget')
  assert.equal(calls, 1)
  releaseNext({ done: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await select({ kind: 'prose', text: source })).reason, 'in-flight-budget')
  releaseReturn({ done: true })
  await new Promise(resolve => setImmediate(resolve))
  const resumed = select({ kind: 'prose', text: source })
  assert.equal(calls, 2)
  releaseNext({ done: true })
  await resumed
})

test('a blocked backend slot does not prevent completed cache reuse', async () => {
  const base = runtime()
  let blocked = false
  const llm = { stream(request) { return blocked ? { [Symbol.asyncIterator]() { return this }, next: () => new Promise(() => {}), return: () => new Promise(() => {}) } : base.stream(request) } }
  const select = createTextSelector({ ...config(llm), maxInFlight: 1, timeoutMs: 5 })
  const session = {}
  await select({ kind: 'prose', text: source, session })
  blocked = true
  assert.equal((await select({ kind: 'prose', text: source + ' different', session })).reason, 'timeout')
  const cached = await select({ kind: 'prose', text: source, session })
  assert.equal(cached.cacheHit, true)
  assert.equal(cached.llmCalled, false)
})

test('repeated consumer abort cannot create unlimited uncooperative streams', async () => {
  let calls = 0
  const llm = { stream() { calls++; return { [Symbol.asyncIterator]() { return this }, next: () => new Promise(() => {}), return: () => new Promise(() => {}) } } }
  const select = createTextSelector({ ...config(llm), maxInFlight: 1 })
  for (let index = 0; index < 5; index++) {
    const controller = new AbortController()
    const pending = select({ kind: 'prose', text: source, signal: controller.signal })
    controller.abort()
    assert.equal((await pending).reason, index === 0 ? 'aborted' : 'in-flight-budget')
  }
  assert.equal(calls, 1)
})

test('normally completed streams release slots without needing iterator return', async () => {
  const llm = runtime()
  const select = createTextSelector({ ...config(llm), maxInFlight: 1 })
  for (let index = 0; index < 5; index++) assert.equal((await select({ kind: 'prose', text: source })).status, 'selected')
  assert.equal(llm.calls.length, 5)
})

test('captured cache selection remains free after eviction and never admits a fresh paid call', async () => {
  const llm = runtime()
  const select = createTextSelector({ ...config(llm), maxCacheEntries: 1 })
  const session = {}
  const prepared = select.prepare({ kind: 'prose', text: source })
  assert.equal(select.cached(prepared, { session }), undefined)
  await select.execute(prepared, { session })
  const cached = select.cached(prepared, { session })
  assert.equal(cached.cacheHit, true)
  assert.equal(cached.llmCalled, false)
  assert.equal(cached.callUsage, undefined)
  assert.equal(select.cached(prepared, { session: {} }), undefined)
  assert.equal(select.cached({}, { session }), undefined)
  await select({ kind: 'prose', text: source + ' changed', session })
  assert.equal(select.cached(prepared, { session }), undefined)
  assert.equal(cached.sourceHash.length, 64)
  assert.equal(cached.spans[0].text.includes('KEEP'), true)
  assert.equal(llm.calls.length, 2, 'using captured result after eviction performs no new call')
})

test('all selector modes send only exact ID/text and retain local source validation metadata', async () => {
  for (const selectionMode of ['task-independent', 'query-dependent', 'diagnostic-evidence']) {
    const diagnostic = selectionMode === 'diagnostic-evidence'
    const text = diagnostic ? diagnostics : source
    const llm = runtime(JSON.stringify({ selectedIds: diagnostic ? ['d1', 'd3', 'd4'] : ['p2'] }))
    const select = createTextSelector({ ...config(llm), selectionMode, maxQueryBytes: 100, protectedTerms: diagnostic ? [] : ['KEEP'] })
    const prepared = select.prepare({ kind: diagnostic ? 'diagnostic' : 'prose', text, query: 'Check protected evidence' })
    const selected = await select.execute(prepared)
    assert.equal(selected.status, 'selected')
    const payload = JSON.parse(llm.calls[0].messages[0].content[0].text.split('\n').at(-1))
    const blocks = payload.sourceBlocks ?? payload.paragraphs
    for (const block of blocks) assert.deepEqual(Object.keys(block).sort(), ['id', 'text'])
    assert.deepEqual(payload.requiredIds, diagnostic ? ['d1', 'd3', 'd4'] : ['p2'])
    assert.equal(payload.currentTask, selectionMode === 'query-dependent' ? 'Check protected evidence' : undefined)
    for (const span of selected.spans) {
      assert.equal(span.text, text.slice(span.start, span.end))
      assert.deepEqual(blocks.find(block => block.id === span.id), { id: span.id, text: span.text })
    }
    if (diagnostic) {
      assert.equal(selected.spans[0].startLine, 1)
      assert.equal(selected.spans[0].endLine, 2)
      assert.ok(selected.spans[0].guards.codes.includes('TS2322'))
      assert.ok(selected.spans[0].guards.locations.includes('src/caller.ts:8:2'))
    }
    assert.equal(prepared.requestBytes, Buffer.byteLength(JSON.stringify(llm.calls[0].messages)))
    assert.deepEqual(selected.audit.request.messages, llm.calls[0].messages)
  }
})
