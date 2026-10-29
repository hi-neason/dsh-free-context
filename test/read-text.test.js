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

const artifactConfig = extra => config({ readText: { enabled: true, encodeArtifacts: true }, ...extra })
const artifactClassifier = { classify: async inputPath => ({ kind: 'artifact', complete: true, inputPath, canonicalPath: inputPath }) }
const noArchive = { getStore: () => assert.fail('artifact must not access storage'),
  onSnapshot: () => assert.fail('artifact must not register snapshots'), getReadClassifier: () => artifactClassifier }

test('artifact encoding requires both switches and produces an exact standalone frame without storage', async () => {
  for (const readText of [{ enabled: true }, { encodeArtifacts: true }, { enabled: false, encodeArtifacts: true }]) {
    const route = createContentRouter(config({ readText }), noArchive)
    assert.equal(await route(content, exec(), { readPath: '/work/a.log' }), undefined)
  }
  const embedded = `${text}\nOriginal tool-result snapshot: {"locator":"opaque://original"}\nSnapshot referenceId: preserved`
  const result = { ...original(), content: [{ ...content[0], text: embedded }] }
  const before = structuredClone(result), records = []
  const route = createContentRouter(artifactConfig(), noArchive)
  const candidate = await route(result.content, exec(), { readPath: '/work/a.log' })
  assert.equal(candidate.strategy, 'read-artifact-lossless-text-v1')
  assert.equal(candidate.lossy, false)
  assert.equal(candidate.snapshots, undefined)
  assert.equal(decodeLosslessText(candidate.content[0].text), embedded)
  const handler = createPostExecuteHandler(route, undefined, { mode: 'apply', report: record => records.push(record) })
  const actual = await handler(exec(), result, async () => ({ kind: 'accept' }))
  assert.deepEqual(actual.content, candidate.content)
  assert.equal(actual.content[0].metadata, 'preserved')
  assert.deepEqual(result, before)
  assert.equal(records.at(-1).snapshots, undefined)
  assert.equal(records.at(-1).strategy, 'read-artifact-lossless-text-v1')
  assert.deepEqual(await route(result.content, exec(), { readPath: '/work/a.log' }), candidate)
  assert.equal(await route(candidate.content, exec(), { readPath: '/work/a.log' }), undefined)
})

test('artifact opt-in rejects incomplete, unknown and path-mismatched classifications', async () => {
  for (const classified of [{ kind: 'unknown', complete: true },
    { kind: 'artifact', complete: false, inputPath: '/work/a.log', canonicalPath: '/work/a.log' },
    { kind: 'artifact', complete: true, inputPath: '/other', canonicalPath: '/other' },
    { kind: 'artifact', complete: true, inputPath: '/work/a.log' }]) {
    const route = createContentRouter(artifactConfig(), { ...noArchive, getReadClassifier: () => ({ classify: async () => classified }) })
    assert.equal(await route(content, exec(), { readPath: '/work/a.log' }), undefined)
  }
})

test('artifact frame gates include serialized metadata, token ratio and minimum savings', async () => {
  const cases = [
    { input: [{ ...content[0], metadata: 'x'.repeat(100000) }] },
    { estimator: bytes => bytes > 30000 ? 100 : 75 },
    { policy: { minSavingsTokens: 100000 } },
  ]
  for (const entry of cases) {
    const route = createContentRouter(artifactConfig(entry.policy), { ...noArchive, estimator: entry.estimator })
    assert.equal(await route(entry.input ?? content, exec(), { readPath: '/work/a.log' }), undefined)
  }
})

test('artifact encoding preserves observe, error, PTC, replacement and cancellation boundaries', async () => {
  for (const kind of ['observe', 'error', 'ptc', 'value', 'blocked', 'classify-cancel', 'report-cancel', 'classifier-failure']) {
    const controller = new AbortController(), execution = { ...exec(), signal: controller.signal }
    const result = original(), decision = { kind: kind === 'blocked' ? 'block' : 'accept' }
    if (kind === 'error') result.isError = true
    if (kind === 'ptc') execution.parent = 'parent'
    if (kind === 'value') decision.value = null
    const route = createContentRouter(artifactConfig(), { ...noArchive, getReadClassifier: () => ({ classify: async inputPath => {
      if (kind === 'classifier-failure') throw Error('unavailable')
      if (kind === 'classify-cancel') controller.abort()
      return artifactClassifier.classify(inputPath)
    } }) })
    const handler = createPostExecuteHandler(route, undefined, { mode: kind === 'observe' ? 'observe' : 'apply',
      report: () => { if (kind === 'report-cancel') controller.abort() } })
    assert.equal(await handler(execution, result, async () => decision), decision)
  }
})


test('artifact opt-in leaves source archival and snapshot registration intact', async () => {
  const saves = [], registrations = []
  const route = createContentRouter(artifactConfig(), { getReadClassifier: () => classifier,
    getStore: () => receiptStore(saves), onSnapshot: (...args) => { registrations.push(args) } })
  const candidate = await route(content, exec(), { readPath: '/work/a.log' })
  assert.equal(candidate.strategy, 'read-lossless-text-v1')
  assert.equal(saves.length, 1)
  assert.equal(saves[0].content, text)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0][2], 'original')
  assert.match(candidate.content[0].text, /Original tool-result snapshot:/)
})

test('source reads below the required byte saving never write a doomed snapshot', async () => {
  const source = 'Repeated status. '.repeat(200) + Array.from({ length: 200 },
    (_, i) => `Unique detail number ${i} has value ${i * 7919}.`).join('\n')
  const blocks = [{ type: 'text', text: source }]
  const saves = []
  const route = createContentRouter(config(), { getReadClassifier: () => classifier, getStore: () => receiptStore(saves) })
  assert.equal(await route(blocks, exec(), { readPath: '/work/a.log' }), undefined)
  assert.equal(saves.length, 0)
})
