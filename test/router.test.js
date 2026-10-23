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
