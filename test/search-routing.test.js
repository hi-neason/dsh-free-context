import assert from 'node:assert/strict'
import test from 'node:test'
import { parseConfig } from '../src/config.js'
import { createContentRouter } from '../src/router.js'
import { apply } from '../src/index.js'
import { decodeSearchResults } from '../src/search-codec.js'
import { decodeLosslessText } from '../src/lossless-text.js'

const text = Array.from({ length: 80 }, (_, index) =>
  `/workspace/services/customer-billing/long-module-name/source.js:${index + 1}:return value_${index}`).join('\n') + '\n'
const content = [{ type: 'text', text, metadata: { retained: true } }]
const options = overrides => ({ mode: 'apply', tools: ['bash'], minInputBytes: 0, json: { enabled: false }, search: { enabled: true }, ...overrides })

test('opt-in search route preserves every result and metadata without snapshots or auxiliary calls', () => {
  const config = parseConfig(options())
  const candidate = createContentRouter(config, { getStore: () => assert.fail('lossless search does not need storage') })(content, { name: 'bash' })
  assert.equal(candidate.strategy, 'search-paths-v1')
  assert.equal(candidate.lossy, false)
  assert.equal(decodeSearchResults(candidate.content[0].text), text)
  assert.deepEqual(candidate.content[0].metadata, content[0].metadata)
  assert.equal(createContentRouter(config)(candidate.content, { name: 'bash' }), undefined)
})

test('search rejects read, unlisted tools, structured JSON and unknown formats', () => {
  const route = createContentRouter(parseConfig(options({ tools: ['bash', 'read'] })))
  assert.equal(route(content, { name: 'read' }), undefined)
  assert.equal(route(content, { name: 'other' }), undefined)
  for (const value of [JSON.stringify(text), JSON.stringify({ text }), text + 'unknown trailer\n', text.replaceAll(':', '\u001b[31m:')]) {
    assert.equal(route([{ type: 'text', text: value }], { name: 'bash' }), undefined)
  }
  assert.equal(createContentRouter(parseConfig(options({ search: { enabled: false } })))(content, { name: 'bash' }), undefined)
})

test('search obeys full block bytes, token estimates and minimum savings', () => {
  assert.equal(createContentRouter(parseConfig(options({ maxInputBytes: Buffer.byteLength(text) })))(content, { name: 'bash' }), undefined)
  assert.equal(createContentRouter(parseConfig(options({ minSavingsTokens: 100000 })))(content, { name: 'bash' }), undefined)
  assert.equal(createContentRouter(parseConfig(options()), { estimator: () => 10 })(content, { name: 'bash' }), undefined)
})

test('search-only plugin registers its handler and preserves program values', async () => {
  let handler
  const records = []
  apply({ get() {}, on: (_name, fn) => { handler = fn }, parallel: (_name, record) => records.push(record), logger: { warn() {} } }, options())
  assert.equal(typeof handler, 'function')
  const result = { content, value: { raw: text }, isError: false }
  const decision = { kind: 'accept' }
  const actual = await handler({ name: 'bash' }, result, async () => decision)
  assert.equal(decodeSearchResults(actual.content[0].text), text)
  assert.deepEqual(result.value, { raw: text })
  assert.equal(Object.hasOwn(actual, 'value'), false)
  assert.equal(records[0].strategy, 'search-paths-v1')
})

test('search flag follows strict boolean config and normalized freezing', () => {
  assert.deepEqual(parseConfig().search, { enabled: false })
  const config = parseConfig(options())
  assert.equal(Object.isFrozen(config.search), true)
  for (const search of [true, null, [], { enabled: 1 }, { extra: true }]) assert.throws(() => parseConfig({ search }), TypeError)
})

test('competing exact encodings select the smaller eligible full result', () => {
  const route = createContentRouter(parseConfig(options({ text: { enabled: true } })))
  const search = route(content, { name: 'bash' })
  assert.equal(search.strategy, 'search-paths-v1')
  assert.equal(decodeSearchResults(search.content[0].text), text)
  const repeated = '/workspace/services/customer-billing/long-module-name/source.js:42:return value\n'.repeat(100)
  const general = route([{ type: 'text', text: repeated }], { name: 'bash' })
  assert.equal(general.strategy, 'tool-lossless-text-v1')
  assert.equal(decodeLosslessText(general.content[0].text), repeated)
})
