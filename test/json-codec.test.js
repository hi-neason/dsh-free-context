import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeJsonRows, decodeJsonRows } from 'dsh-free-context/json'

test('repeated schemas roundtrip and can produce a smaller candidate', () => {
  const data = Array.from({ length: 20 }, (_, index) => ({
    descriptive_identifier: index, descriptive_status: 'ready', descriptive_name: `item ${index}`,
  }))
  const text = JSON.stringify(data)
  const encoded = encodeJsonRows(text)
  assert.ok(encoded.length < text.length)
  assert.equal(decodeJsonRows(encoded), text)
})

test('Unicode, nested values and string whitespace are preserved', () => {
  const data = [{ text: '中文 😀 \t " \\ \n', nested: { a: [null, false, 1.25] } }]
  assert.equal(decodeJsonRows(encodeJsonRows(JSON.stringify(data, null, 2))), JSON.stringify(data))
})

test('hostile property names remain own data properties', () => {
  const text = '[{"__proto__":{"polluted":true},"constructor":"data","prototype":null}]'
  const restored = JSON.parse(decodeJsonRows(encodeJsonRows(text)))
  assert.equal(Object.hasOwn(restored[0], '__proto__'), true)
  assert.deepEqual(restored[0].__proto__, { polluted: true })
  assert.equal(restored[0].constructor, 'data')
  assert.equal({}.polluted, undefined)
  assert.equal(JSON.stringify(restored), text)
})

test('deterministic query fixture preserves filtering, sums and nested lookups (not model evaluation)', () => {
  const records = [
    { id: 'a', status: 'ready', amount: 12.5, details: { owner: '张三', tags: ['urgent'] } },
    { id: 'b', status: 'blocked', amount: 99, details: { owner: '李四', tags: [] } },
    { id: 'c', status: 'ready', amount: 7.5, details: { owner: '王五', tags: ['review'] } },
  ]
  const restored = JSON.parse(decodeJsonRows(encodeJsonRows(JSON.stringify(records))))
  const query = rows => ({
    readyIds: rows.filter(row => row.status === 'ready').map(row => row.id),
    readyAmount: rows.filter(row => row.status === 'ready').reduce((sum, row) => sum + row.amount, 0),
    urgentOwner: rows.find(row => row.details.tags.includes('urgent')).details.owner,
  })
  const expected = { readyIds: ['a', 'c'], readyAmount: 20, urgentOwner: '张三' }
  assert.deepEqual(query(records), expected)
  assert.deepEqual(query(restored), expected)
})

test('unsupported roots and heterogeneous ordered schemas fall back', () => {
  for (const text of ['null', '{}', '[]', '[null]', '[[1]]', '[1]', '[{},null]',
    '[{"a":1},{"b":2}]', '[{"a":1,"b":2},{"b":3,"a":4}]', 'invalid']) {
    assert.equal(encodeJsonRows(text), undefined, text)
  }
  assert.equal(decodeJsonRows(encodeJsonRows('[{},{}]')), '[{},{}]')
})

test('rejects lossy numbers, duplicate keys and noncanonical lexical forms', () => {
  for (const text of ['[{"a":9007199254740992}]', '[{"a":9007199254740993}]',
    '[{"a":-0}]', '[{"a":1e400}]', '[{"a":0.1234567890123456789}]',
    '[{"a":1,"a":2}]', '[{"a":{"b":1,"b":2}}]', '[{"a":1e2}]',
    '[{"a":"\\u0061"}]', '[{"a":[9007199254740992]}]']) {
    assert.equal(encodeJsonRows(text), undefined, text)
  }
})

test('size limits count UTF-8 bytes and encoder safely declines invalid limits', () => {
  const text = '[{"a":"中文"}]'
  assert.equal(encodeJsonRows(text, { maxInputBytes: text.length }), undefined)
  assert.ok(encodeJsonRows(text, { maxInputBytes: Buffer.byteLength(text) }))
  assert.equal(encodeJsonRows(text, { maxInputBytes: 0 }), undefined)
  assert.equal(encodeJsonRows(null), undefined)
  assert.throws(() => decodeJsonRows(encodeJsonRows(text), { maxInputBytes: 5 }))
  assert.throws(() => decodeJsonRows('{}', { maxInputBytes: NaN }))
})

test('decoder rejects malformed or unsupported envelopes', () => {
  const valid = { format: 'dsh-json-rows', version: 1, schema: ['a'], rows: [[1]] }
  const cases = [null, [], {}, { ...valid, extra: true }, { ...valid, version: 2 },
    { ...valid, format: 'other' }, { ...valid, schema: ['a', 'a'], rows: [[1, 2]] },
    { ...valid, schema: [1] }, { ...valid, schema: null }, { ...valid, rows: [] },
    { ...valid, rows: [null] }, { ...valid, rows: [[1, 2]] }, { ...valid, rows: {} }]
  for (const value of cases) assert.throws(() => decodeJsonRows(JSON.stringify(value)))
  assert.throws(() => decodeJsonRows('{'))
  assert.throws(() => decodeJsonRows(JSON.stringify(valid).replace('[[1]]', '[[9007199254740992]]')))
  assert.throws(() => decodeJsonRows(JSON.stringify(valid).replace('"version":1', '"version":1,"version":1')))
})
