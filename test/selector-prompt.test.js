import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeSourceSpans, decodeSourceSpans } from '../src/selector-prompt.js'

const spans = [{ id: 'p1', text: '中文 😀。\r\nRepeated sentence. Repeated sentence. ' }, { id: 'p2', text: '中文 😀。\r\n中文 😀。\r\n' }]
test('literal dictionary and runs round-trip exact Unicode, CRLF, IDs and multiplicity', () => {
  const encoded = encodeSourceSpans(spans)
  assert.deepEqual(decodeSourceSpans(encoded, { maxBytes: 1000 }), spans)
  assert.ok(encoded.dictionary.includes('Repeated sentence. '))
  assert.ok(encoded.spans.some(span => span.runs.some(([, count]) => count > 1)))
})

test('decoder rejects malformed structures and expansion overflow before allocation', () => {
  const valid = { dictionary: ['abc'], spans: [{ id: 'p1', runs: [[0, 1]] }] }
  for (const value of [null, {}, { ...valid, extra: true }, { ...valid, dictionary: [''] },
    { ...valid, dictionary: [1] }, { ...valid, spans: [{ id: 'p1', runs: [[1, 1]] }] },
    { ...valid, spans: [{ id: 'p1', runs: [[0, 0]] }] },
    { ...valid, spans: [{ id: 'p1', runs: [[0, Number.MAX_SAFE_INTEGER]] }] },
    { ...valid, spans: [{ id: 'p1', runs: [[0, 1.5]] }] },
    { ...valid, spans: [{ id: 'p1', runs: [[0, 1, 2]] }] },
    { ...valid, spans: [...valid.spans, ...valid.spans] },
    { ...valid, spans: [{ id: 'p1', runs: [[0, 1]], text: 'abc' }] },
  ]) assert.throws(() => decodeSourceSpans(value, { maxBytes: 100 }))
  assert.throws(() => decodeSourceSpans(valid, { maxBytes: 2 }))
  assert.throws(() => decodeSourceSpans(valid, { maxBytes: Infinity }))
  assert.deepEqual(decodeSourceSpans(valid, { maxBytes: 3 }), [{ id: 'p1', text: 'abc' }])
})

test('v2 shares only repeated chunks and keeps unique facts literal beside their span IDs', () => {
  const source = [
    { id: 'α', text: 'Shared. Unique 中文 😀. Second fact. Shared. ' },
    { id: 'β', text: 'Shared. Other fact. \r\nFinal' },
  ]
  const encoded = encodeSourceSpans(source)
  assert.equal(encoded.version, 2)
  assert.deepEqual(encoded.dictionary, ['Shared. '])
  assert.deepEqual(encoded.spans, [
    { id: 'α', runs: [[0, 1], 'Unique 中文 😀. Second fact. ', [0, 1]] },
    { id: 'β', runs: [[0, 1], 'Other fact. \r\nFinal'] },
  ])
  const bytes = source.reduce((sum, span) => sum + Buffer.byteLength(span.text), 0)
  assert.deepEqual(decodeSourceSpans(encoded, { maxBytes: bytes }), source)
  assert.throws(() => decodeSourceSpans(encoded, { maxBytes: bytes - 1 }))
})

test('v2 handles an empty dictionary and validates inline literals before expansion', () => {
  const source = [{ id: 'p1', text: 'Unique 😀\r\n中文' }]
  const encoded = encodeSourceSpans(source)
  assert.deepEqual(encoded.dictionary, [])
  assert.deepEqual(decodeSourceSpans(encoded, { maxBytes: 100 }), source)
  const valid = { version: 2, dictionary: ['abc'], spans: [{ id: 'p1', runs: ['😀', [0, 2], '\r\n'] }] }
  assert.deepEqual(decodeSourceSpans(valid, { maxBytes: 12 }), [{ id: 'p1', text: '😀abcabc\r\n' }])
  for (const value of [
    { ...valid, version: 3 },
    { ...valid, spans: [{ id: 'p1', runs: [''] }] },
    { ...valid, spans: [{ id: 'p1', runs: ['\ud800'] }] },
    { ...valid, spans: [{ id: 'p1', runs: ['😀', [0, Number.MAX_SAFE_INTEGER]] }] },
    { ...valid, spans: [{ id: 'p1', runs: [{ literal: 'abc' }] }] },
    { dictionary: [], spans: [{ id: 'p1', runs: ['abc'] }] },
  ]) assert.throws(() => decodeSourceSpans(value, { maxBytes: 100 }))
  assert.throws(() => decodeSourceSpans(valid, { maxBytes: 11 }))
})
