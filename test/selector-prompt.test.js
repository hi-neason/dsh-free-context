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
