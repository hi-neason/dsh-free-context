import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseConfig } from '../src/config.js'
import { measureContent } from '../src/diagnostics.js'
import { decodeJsonRows } from '../src/json-codec.js'
import { createContentRouter } from '../src/router.js'

const rows = Array.from({ length: 50 }, (_, i) => ({ long_identifier_field: i, long_description_field: `value-${i}`, long_status_field: 'ok' }))
const content = [{ type: 'text', text: JSON.stringify(rows), customMetadata: 'kept' }]
const exec = { name: 'fixture' }
const config = overrides => parseConfig({ mode: 'apply', tools: ['fixture'], minInputBytes: 0, ...overrides })

test('routes eligible JSON to a verified strictly smaller candidate preserving metadata', () => {
  const candidate = createContentRouter(config())(content, exec)
  assert.equal(candidate.strategy, 'json-rows-v1')
  assert.equal(candidate.lossy, false)
  assert.deepEqual(JSON.parse(decodeJsonRows(candidate.content[0].text)), rows)
  assert.equal(candidate.content[0].customMetadata, 'kept')
  assert.ok(measureContent(candidate.content).bytes < measureContent(content).bytes)
  assert.equal(content[0].text, JSON.stringify(rows))
  assert.equal(createContentRouter(config())(candidate.content, exec), undefined)
})

test('budget uses the complete serialized block, with inclusive input limits', () => {
  const size = measureContent(content).bytes
  assert.ok(createContentRouter(config({ minInputBytes: size, maxInputBytes: size }))(content, exec))
  assert.equal(createContentRouter(config({ maxInputBytes: size - 1 }))(content, exec), undefined)
  assert.equal(createContentRouter(config({ minInputBytes: size + 1 }))(content, exec), undefined)
  // Text alone fits, but its JSON-escaped block and metadata must also fit.
  assert.equal(createContentRouter(config({ maxInputBytes: Buffer.byteLength(content[0].text) }))(content, exec), undefined)
})

test('requires minimum estimated savings and strict byte/token decrease', () => {
  const candidate = createContentRouter(config())(content, exec)
  const savings = measureContent(content).estimatedTokens - measureContent(candidate.content).estimatedTokens
  assert.ok(createContentRouter(config({ minSavingsTokens: savings }))(content, exec))
  assert.equal(createContentRouter(config({ minSavingsTokens: savings + 1 }))(content, exec), undefined)
  assert.equal(createContentRouter(config({ minSavingsTokens: 0 }), { estimator: () => 1 })(content, exec), undefined)
  assert.equal(createContentRouter(config({ minSavingsTokens: 0 }))([{ type: 'text', text: '[{"a":1}]' }], exec), undefined)
})

test('does not route disabled, unlisted, unknown, multiple or noncanonical content', () => {
  for (const options of [{ mode: 'off' }, { tools: [] }, { tools: ['other'] }, { json: { enabled: false }, logs: { enabled: true } }]) {
    assert.equal(createContentRouter(config(options))(content, exec), undefined)
  }
  for (const text of ['plain text', 'PASS test-one\nPASS test-two', '{bad}', '[{"a":1,"a":2}]', '[{"a":1e2}]', '{"x":1}']) {
    assert.equal(createContentRouter(config())([{ type: 'text', text }], exec), undefined)
  }
  for (const blocks of [[], [...content, ...content], [{ type: 'image', url: 'fixture' }], [{ type: 'text', text: 1 }]]) {
    assert.equal(createContentRouter(config())(blocks, exec), undefined)
  }
})

function successfulTap(count = 100) {
  return ['TAP version 13', ...Array.from({ length: count }, (_, i) => `# Subtest: test ${i + 1}\nok ${i + 1} - test ${i + 1}\n  ---\n  duration_ms: 1.5\n  type: 'test'\n  ...`), `1..${count}`, `# tests ${count}`, '# suites 0', `# pass ${count}`, '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 10.5', ''].join('\n')
}
const logExec = () => ({ name: 'fixture', callId: 'call-log', agent: { session: { header: { id: 'session-log' } } }, signal: new AbortController().signal })
const logBlocks = () => [{ type: 'text', text: successfulTap() }]
const logConfig = overrides => config({ logs: { enabled: true }, ...overrides })
const store = saves => ({ saveText: async input => {
  saves.push(input)
  return { locator: 'spill://fixture/log', bytes: Buffer.byteLength(input.content), retrievalHint: 'Read exact snapshot.' }
} })

test('TAP route saves exact original before applying a lossy candidate including real receipt cost', async () => {
  const saves = []
  const original = logBlocks()
  const route = createContentRouter(logConfig(), { getStore: () => store(saves) })
  const candidate = await route(original, logExec())
  assert.equal(candidate.strategy, 'node-tap-v13')
  assert.equal(candidate.lossy, true)
  assert.equal(saves[0].content, original[0].text)
  assert.equal(saves[0].owner.sessionId, 'session-log')
  assert.ok(candidate.content[0].text.includes('spill://fixture/log'))
  assert.ok(candidate.content[0].text.includes('sha256'))
  assert.ok(measureContent(candidate.content).bytes < measureContent(original).bytes)
})

test('log route requires storage and ownership; aborted or failed archives yield no candidate', async () => {
  const original = logBlocks()
  await assert.rejects(createContentRouter(logConfig())(original, logExec()), /spillStore/)
  await assert.rejects(createContentRouter(logConfig(), { getStore: () => store([]) })(original, exec), /sessionId/)
  await assert.rejects(createContentRouter(logConfig(), { getStore: () => ({ saveText: async () => { throw new Error('storage failed') } }) })(original, logExec()), /storage failed/)
  const controller = new AbortController()
  const storage = store([])
  const route = createContentRouter(logConfig(), { getStore: () => ({ saveText: async input => {
    const receipt = await storage.saveText(input)
    controller.abort()
    return receipt
  } }) })
  await assert.rejects(route(original, { ...logExec(), signal: controller.signal }), { name: 'AbortError' })
})

test('observe mode archives and complete receipt can disqualify apparent savings', async () => {
  const saves = []
  const route = createContentRouter(logConfig({ mode: 'observe' }), { getStore: () => store(saves) })
  assert.ok(await route(logBlocks(), logExec()))
  assert.equal(saves.length, 1)
  const oversizedReceipt = { saveText: async input => ({ locator: 'spill://fixture/log', bytes: Buffer.byteLength(input.content), retrievalHint: 'x'.repeat(20000) }) }
  assert.equal(await createContentRouter(logConfig(), { getStore: () => oversizedReceipt })(logBlocks(), logExec()), undefined)
  assert.equal(await createContentRouter(logConfig({ minSavingsTokens: 1000000 }), { getStore: () => assert.fail('do not save hopeless candidate') })(logBlocks(), logExec()), undefined)
  assert.equal(createContentRouter(config(), { getStore: () => assert.fail('logs are disabled') })(logBlocks(), logExec()), undefined)
})

test('explicit input budgets above one MiB also bound the verification decoder output', () => {
  const largeRows = Array.from({ length: 15000 }, (_, index) => ({
    very_long_identifier_field_name: index, another_very_long_description_field_name: 'abc',
  }))
  const blocks = [{ type: 'text', text: JSON.stringify(largeRows) }]
  assert.ok(Buffer.byteLength(blocks[0].text) > 1048576)
  const budget = 3000000
  const candidate = createContentRouter(config({ maxInputBytes: budget }))(blocks, exec)
  assert.equal(candidate.strategy, 'json-rows-v1')
  assert.deepEqual(JSON.parse(decodeJsonRows(candidate.content[0].text, { maxOutputBytes: budget })), largeRows)
})
