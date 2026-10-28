import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { encodeLosslessText, decodeLosslessText } from '../src/lossless-text.js'
import { measureContent } from '../src/diagnostics.js'
import { acceptanceFixturesV4 } from './fixtures/acceptance/tasks-v4.js'

const hash = text => createHash('sha256').update(text).digest('hex')
const repeated = 'Common explanatory sentence. '.repeat(300)
const source = `${repeated}\r\n唯一事实 😀: const x = " a  b ";\t\r\n{"__proto__":{"safe":true},"n":-0,"digits":"9007199254740993"}\n  trailing spaces  `
const envelope = () => encodeLosslessText(source)
const edit = (encoded, change) => {
  const start = encoded.lastIndexOf('\n') + 1
  const body = JSON.parse(encoded.slice(start))
  change(body)
  return encoded.slice(0, start) + JSON.stringify(body)
}

test('lossless envelope restores exact source characters and leaves unique literals near the source span', () => {
  const encoded = envelope()
  assert.equal(typeof encoded, 'string')
  assert.ok(Buffer.byteLength(encoded) < Buffer.byteLength(source))
  assert.equal(decodeLosslessText(encoded), source)
  const body = JSON.parse(encoded.slice(encoded.lastIndexOf('\n') + 1))
  assert.equal(body.bytes, Buffer.byteLength(source))
  assert.equal(body.sha256, hash(source))
  assert.equal(body.source.version, 2)
  assert.equal(body.source.spans.length, 1)
  assert.equal(body.source.spans[0].id, 'text')
  assert.ok(body.source.spans[0].runs.some(run => typeof run === 'string' && run.includes('唯一事实 😀')))
  assert.equal(body.source.dictionary.some(text => text.includes('唯一事实 😀')), false)
  assert.match(encoded, /not.*(?:semantic|file).*completeness/i)
})

test('encode declines invalid, empty, oversized, nested and unprofitable source without changing it', () => {
  for (const value of [undefined, null, {}, 42, '', '\ud800', 'a short unique text']) assert.equal(encodeLosslessText(value), undefined)
  assert.equal(encodeLosslessText(source, { maxInputBytes: Buffer.byteLength(source) - 1 }), undefined)
  assert.equal(encodeLosslessText(source, { maxOutputBytes: 10 }), undefined)
  const encoded = envelope()
  assert.equal(encodeLosslessText(encoded), undefined)
  assert.equal(encodeLosslessText('  ' + encoded), undefined)
  assert.equal(encodeLosslessText(encoded.replace('v1]', 'v999]')), undefined)
})

test('decode enforces exact encoded and expanded UTF-8 budgets, hashes and configuration', () => {
  const encoded = envelope()
  const input = Buffer.byteLength(encoded)
  const output = Buffer.byteLength(source)
  assert.equal(decodeLosslessText(encoded, { maxInputBytes: input, maxOutputBytes: output }), source)
  assert.throws(() => decodeLosslessText(encoded, { maxInputBytes: input - 1 }))
  assert.throws(() => decodeLosslessText(encoded, { maxOutputBytes: output - 1 }))
  assert.throws(() => decodeLosslessText(edit(encoded, body => { body.sha256 = '0'.repeat(64) })))
  assert.throws(() => decodeLosslessText(edit(encoded, body => { body.bytes-- })))
  assert.throws(() => decodeLosslessText(edit(encoded, body => { body.source.spans[0].runs[0][1] = Number.MAX_SAFE_INTEGER })))
  for (const limit of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => decodeLosslessText(encoded, { maxInputBytes: limit }), TypeError)
    assert.throws(() => encodeLosslessText(source, { maxOutputBytes: limit }), TypeError)
  }
})

test('decode rejects altered headers, unknown versions, extra text, duplicate keys and prototype fields', () => {
  const encoded = envelope()
  for (const candidate of [null, {}, source, ' ' + encoded, encoded + '\n', encoded + '\nextra',
    encoded.replace('v1]', 'v2]'), encoded.replace('Decode', 'Change'),
    edit(encoded, body => { body.version = 2 }), edit(encoded, body => { body.extra = true }),
    edit(encoded, body => { body.source.version = 1 }),
    edit(encoded, body => { body.source.spans.push({ id: 'extra', runs: ['x'] }) }),
    edit(encoded, body => { body.source.spans[0].id = 'other' }),
    edit(encoded, body => { body.source.spans[0].runs.push('\ud800') }),
    encoded.replace('"version":1', '"version":1,"version":1'),
    encoded.replace('"version":1', '"__proto__":{},"version":1'),
    encoded.replace('"version":2', '"__proto__":{},"version":2'),
  ]) assert.throws(() => decodeLosslessText(candidate), TypeError)
})

test('decode refuses an otherwise valid nested lossless envelope', () => {
  const nested = envelope()
  const outer = edit(envelope(), body => {
    body.bytes = Buffer.byteLength(nested)
    body.sha256 = hash(nested)
    body.source = { version: 2, dictionary: [], spans: [{ id: 'text', runs: [nested] }] }
  })
  assert.throws(() => decodeLosslessText(outer), TypeError)
})

test('compiler source and official read-render-equivalent text round-trip with lower serialized estimates', () => {
  const fixture = acceptanceFixturesV4().find(task => task.id === 'experiment-diagnostic-compiler')
  const lines = fixture.text.split('\n')
  // Exact full-window layout of the official dsh-tool-fs formatReadOutput;
  // this test does not claim the official runtime executed or verified a file.
  const rendered = `<path>/fixture/compiler.log</path>\n<type>file</type>\n<content>\n${lines.map((text, index) => `${index + 1}: ${text}`).join('\n')}\n\n(End of file - total ${lines.length} lines)\n</content>`
  for (const text of [fixture.text, rendered]) {
    const encoded = encodeLosslessText(text)
    assert.equal(typeof encoded, 'string')
    assert.equal(decodeLosslessText(encoded), text)
    const before = measureContent([{ type: 'text', text }])
    const after = measureContent([{ type: 'text', text: encoded }])
    assert.ok(after.bytes < before.bytes)
    assert.ok(after.estimatedTokens < before.estimatedTokens)
    const body = JSON.parse(encoded.slice(encoded.lastIndexOf('\n') + 1))
    assert.ok(body.source.spans[0].runs.some(run => typeof run === 'string' && run.includes('TS2322')))
    assert.ok(body.source.spans[0].runs.some(run => typeof run === 'string' && run.includes('TS6133')))
  }
})
