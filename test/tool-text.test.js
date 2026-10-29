import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../src/index.js'
import { parseConfig } from '../src/config.js'
import { createContentRouter } from '../src/router.js'
import { decodeLosslessText } from '../src/lossless-text.js'
import { measureContent } from '../src/diagnostics.js'

const text = 'Ordinary repeated diagnostic explanation. '.repeat(300) + '\r\n唯一错误 😀 at /work/check.js:42:7; status=503\r\n'
const content = [{ type: 'text', text, customMetadata: 'preserved' }]
const config = overrides => parseConfig({ mode: 'apply', tools: ['fixture'], text: { enabled: true }, minInputBytes: 0, ...overrides })
const exec = () => ({ name: 'fixture', callId: 'call-text', signal: new AbortController().signal })

test('opt-in tool text is a self-contained exact frame preserving metadata without storage', () => {
  const route = createContentRouter(config(), { getStore: () => assert.fail('no snapshot'), onSnapshot: () => assert.fail('no registration') })
  const candidate = route(content, exec())
  assert.equal(candidate.strategy, 'tool-lossless-text-v1')
  assert.equal(candidate.lossy, false)
  assert.equal(candidate.snapshots, undefined)
  assert.equal(decodeLosslessText(candidate.content[0].text), text)
  assert.equal(candidate.content[0].customMetadata, 'preserved')
  assert.ok(measureContent(candidate.content).bytes * 2 <= measureContent(content).bytes)
  assert.ok(measureContent(candidate.content).estimatedTokens * 2 <= measureContent(content).estimatedTokens)
  assert.equal(route(candidate.content, exec()), undefined)
  assert.equal(content[0].text, text)
})

test('tool text respects opt-in, allowlist, budgets and final serialized savings', () => {
  for (const overrides of [{ text: { enabled: false } }, { tools: [] }, { tools: ['other'] }, { mode: 'off' },
    { minInputBytes: measureContent(content).bytes + 1 }, { maxInputBytes: measureContent(content).bytes - 1 },
    { minSavingsTokens: 100000 }]) {
    assert.equal(createContentRouter(config(overrides))(content, exec()), undefined)
  }
  assert.equal(createContentRouter(config())([{ type: 'text', text: 'Unique short answer.' }], exec()), undefined)
  const metadata = [{ ...content[0], customMetadata: 'x'.repeat(30000) }]
  assert.equal(createContentRouter(config())(metadata, exec()), undefined)
  // A byte reduction alone cannot pass the independent 50% token gate.
  const inputBytes = measureContent(content).bytes
  assert.equal(createContentRouter(config({ minSavingsTokens: 0 }), { estimator: bytes => bytes === inputBytes ? 100 : 75 })(content, exec()), undefined)
})

test('JSON keeps precedence and read cannot enter the generic text route', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ long_identifier_field: i, long_status_field: 'success' }))
  assert.equal(createContentRouter(config())([{ type: 'text', text: JSON.stringify(rows) }], exec()).strategy, 'json-rows-v1')
  for (const readText of [{ enabled: false }, { enabled: true }, { enabled: true, encodeArtifacts: true }]) {
    const route = createContentRouter(config({ tools: ['read'], readText }), { getStore: () => assert.fail('no unclassified snapshot') })
    assert.equal(await route(content, { ...exec(), name: 'read' }, { readPath: '/work/source.txt' }), undefined)
  }
})

test('text-only plugin registers a policy; observe, errors, PTC internals and value replacement retain originals', async () => {
  for (const mode of ['observe', 'apply']) {
    const listeners = [], reports = []
    apply({ on: (...args) => listeners.push(args), get: () => assert.fail('no services needed'),
      logger: { warn: assert.fail }, parallel: async (_, record) => reports.push(record) },
    { mode, tools: ['fixture'], json: { enabled: false }, text: { enabled: true } })
    assert.equal(listeners.length, 1)
    const [, handler] = listeners[0]
    const output = { isError: false, content, value: { unchanged: true } }
    const decision = { kind: 'accept' }
    const actual = await handler(exec(), output, async () => decision)
    if (mode === 'observe') assert.equal(actual, decision)
    else assert.equal(decodeLosslessText(actual.content[0].text), text)
    assert.deepEqual(output, { isError: false, content, value: { unchanged: true } })
    assert.equal(reports[0].strategy, 'tool-lossless-text-v1')
    assert.equal(reports[0].outcome, mode === 'apply' ? 'selected' : 'observed')
    for (const [execution, result, downstream] of [
      [exec(), { ...output, isError: true }, decision],
      [{ ...exec(), parent: 'ptc' }, output, decision],
      [exec(), output, { kind: 'accept', value: {} }],
      [{ ...exec(), signal: AbortSignal.abort() }, output, decision],
    ]) assert.equal(await handler(execution, result, async () => downstream), downstream)
  }
})

test('unprofitable JSON rows retain their original representation instead of generic text encoding', () => {
  for (const [rows, minSavingsTokens] of [
    [[{ a: 'A repeated diagnostic explanation. '.repeat(400) }], 0],
    [Array.from({ length: 100 }, () => ({ a: 'A repeated diagnostic explanation. '.repeat(20) })), 1000],
  ]) {
    const originalText = JSON.stringify(rows, null, 2)
    const blocks = [{ type: 'text', text: originalText, customMetadata: 'preserved' }]
    assert.equal(createContentRouter(config({ minSavingsTokens }))(blocks, exec()), undefined)
    assert.equal(blocks[0].text, originalText)
    assert.equal(blocks[0].customMetadata, 'preserved')
  }
})

test('generic text encoding does not bypass unsupported or disabled JSON handling', () => {
  const repeated = 'A repeated diagnostic explanation. '.repeat(400)
  for (const source of [JSON.stringify({ message: repeated }), JSON.stringify(repeated),
    JSON.stringify([{ message: repeated }]), `{"a":1,"a":2,"message":${JSON.stringify(repeated)}}`]) {
    const blocks = [{ type: 'text', text: source }]
    for (const json of [{ enabled: true }, { enabled: false }]) {
      assert.equal(createContentRouter(config({ json }))(blocks, exec()), undefined)
    }
  }
})
