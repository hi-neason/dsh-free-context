import assert from 'node:assert/strict'
import test from 'node:test'
import { parseConfig } from '../src/config.js'
import { createContentRouter } from '../src/router.js'
import { createPostExecuteHandler } from '../src/pipeline.js'
import { decodeLosslessText } from '../src/lossless-text.js'
import { measureContent } from '../src/diagnostics.js'

const text = `${'A repeated diagnostic explanation. '.repeat(900)}\n唯一事实 😀\r\n`
const content = [{ type: 'text', text, metadata: 'preserved' }]
const exec = () => ({ name: 'read', callId: 'read-1', arguments: { file_path: '/work/a.log' },
  agent: { session: { header: { id: 'session-1' } } }, signal: new AbortController().signal })
const config = extra => parseConfig({ mode: 'apply', tools: ['read'], minInputBytes: 0, readText: { enabled: true }, ...extra })
const classifier = { classify: async inputPath => ({ kind: 'source', complete: true, inputPath, canonicalPath: inputPath }) }
const receiptStore = saves => ({ saveText: async input => {
  saves.push(input)
  return { locator: 'opaque://archive', bytes: Buffer.byteLength(input.content), retrievalHint: 'Read this exact snapshot.' }
} })
const original = () => ({ content, value: { path: '/work/a.log', lines: ['structured data'] }, isError: false })

test('read encoding requires explicit source evidence and exact input path binding before saving', async () => {
  for (const classified of [undefined, { kind: 'artifact', complete: true }, { kind: 'unknown' },
    { kind: 'source', complete: false, inputPath: '/work/a.log', canonicalPath: '/work/a.log' },
    { kind: 'source', complete: true, inputPath: '/other', canonicalPath: '/other' }]) {
    const route = createContentRouter(config(), { getReadClassifier: () => ({ classify: async () => classified }),
      getStore: () => assert.fail('must not save unclassified reads') })
    assert.equal(await route(content, exec(), { readPath: '/work/a.log' }), undefined)
  }
  assert.equal(await createContentRouter(config())(content, exec(), { readPath: '/work/a.log' }), undefined)
  assert.equal(await createContentRouter(config(), { getReadClassifier: () => classifier })(content, exec()), undefined)
})

test('read encoding keeps exact rendered text, structured value and framing; every receipt cost is counted', async () => {
  const saves = []
  const route = createContentRouter(config(), { getReadClassifier: () => classifier, getStore: () => receiptStore(saves) })
  const result = original()
  const before = structuredClone(result)
  const actual = await createPostExecuteHandler(route, undefined, { mode: 'apply' })(exec(), result, async () => ({ kind: 'accept' }))
  const encoded = actual.content[0].text.split('\n\nOriginal tool-result snapshot:')[0]
  assert.equal(decodeLosslessText(encoded), text)
  assert.deepEqual(result, before)
  assert.equal(actual.content[0].metadata, 'preserved')
  assert.equal(saves[0].content, text)
  assert.match(actual.content[0].text, /Snapshot referenceId:/)
  assert.ok(measureContent(actual.content).bytes * 2 <= measureContent(content).bytes)
  assert.equal(await route(actual.content, exec(), { readPath: '/work/a.log' }), undefined)
})

test('disabled, PTC, errors and structured replacements bypass read encoding', async () => {
  const route = createContentRouter(config({ readText: { enabled: false } }), { getReadClassifier: () => assert.fail('disabled') })
  assert.equal(await route(content, exec(), { readPath: '/work/a.log' }), undefined)
  for (const type of ['ptc', 'error', 'value']) {
    const execution = exec(), result = original(), decision = { kind: 'accept' }
    if (type === 'ptc') execution.parent = 'parent-call'
    if (type === 'error') result.isError = true
    if (type === 'value') decision.value = null
    assert.equal(await createPostExecuteHandler(() => assert.fail('bypass'), undefined, { mode: 'apply' })(execution, result, async () => decision), decision)
  }
})

test('archive failure, cancellation, observer mode and excessive recovery overhead preserve original decision', async () => {
  for (const kind of ['save-failure', 'cancel', 'observe', 'overhead', 'classifier-failure']) {
    const execution = exec(), decision = { kind: 'accept' }, controller = new AbortController()
    execution.signal = controller.signal
    const route = createContentRouter(config(), { getReadClassifier: () => kind === 'classifier-failure'
      ? { classify: async () => { throw Error('unavailable') } } : classifier,
    getStore: () => ({ saveText: async input => {
      if (kind === 'save-failure') throw Error('unavailable')
      if (kind === 'cancel') controller.abort()
      return { locator: 'opaque://archive', bytes: Buffer.byteLength(input.content), retrievalHint: kind === 'overhead' ? 'x'.repeat(40000) : 'Read snapshot.' }
    } }) })
    const actual = await createPostExecuteHandler(route, undefined, { mode: kind === 'observe' ? 'observe' : 'apply' })(execution, original(), async () => decision)
    assert.equal(actual, decision)
  }
})
