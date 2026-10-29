import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { encodeSearchResults, decodeSearchResults } from '../src/search-codec.js'

const paths = ['/workspace/very-long-project-name/packages/application/src/feature-one.js',
  '/workspace/very-long-project-name/packages/application/src/feature-two.js']
const source = Array.from({ length: 80 }, (_, i) => `${paths[i % 2]}:${i + 1}:unique result ${i}\n`).join('')
const edit = (encoded, change) => {
  const split = encoded.lastIndexOf('\n') + 1
  const body = JSON.parse(encoded.slice(split))
  change(body)
  return encoded.slice(0, split) + JSON.stringify(body)
}
const bodyOf = encoded => JSON.parse(encoded.slice(encoded.lastIndexOf('\n') + 1))

test('search path dictionary preserves interleaved files, every match and duplicate records', () => {
  const text = source + `${paths[0]}:0007:duplicate\n`.repeat(2)
  const encoded = encodeSearchResults(text)
  assert.equal(typeof encoded, 'string')
  assert.ok(Buffer.byteLength(encoded) < Buffer.byteLength(text))
  assert.equal(decodeSearchResults(encoded), text)
  const body = bodyOf(encoded)
  assert.deepEqual(body.paths, paths)
  assert.equal(body.rows.length, 82)
  assert.equal(body.matches, 82)
  assert.deepEqual(body.rows.slice(0, 4).map(row => row[0]), [0, 1, 0, 1])
  assert.equal(body.rows[80][1], '0007')
  assert.equal(body.sha256, createHash('sha256').update(text).digest('hex'))
})

test('search encoding preserves spaces, Unicode paths, empty text, context and mixed exact line endings', () => {
  const path = '/workspace/长目录名 with spaces/重复目录/long-feature-file.js'
  const text = Array.from({ length: 40 }, (_, i) => `${path}-${i * 2 + 1}-before 😀\r\n${path}:${i * 2 + 2}:\n--\r\n`).join('') + `${path}:0099:末尾  `
  const encoded = encodeSearchResults(text)
  assert.equal(typeof encoded, 'string')
  assert.equal(decodeSearchResults(encoded), text)
  assert.equal(bodyOf(encoded).matches, 41)
  assert.ok(bodyOf(encoded).rows.some(row => row[2] === '-'))
  assert.ok(bodyOf(encoded).rows.some(row => row.length === 2 && row[0] === '--'))
})

test('unknown or ambiguous search formats retain the entire original instead of dropping lines', () => {
  for (const suffix of [
    'unknown line\n', '\n', '... 20 matches omitted\n', 'Binary file x matches\n',
    'C:\\source\\file.js:1:match\n', '/some:path/file.js:1:match\n', '/some:12:path/file.js:1:match\n',
    '/some/path/file.js-1-context-2-ambiguous\n', '/some/path-3-file.js-1-context\n',
    '/some/path/file.js:0:invalid\n', '/some/path/file.js:9007199254740992:too large\n',
    '/some/path/file.js:1:bad\rcontrol\n', '\u001b[31m/path/file.js:1:ansi\n',
    '\uFEFF/path/file.js:1:bom\n',
  ]) assert.equal(encodeSearchResults(source + suffix), undefined, suffix)
  for (const text of ['', null, {}, '\ud800', '--\n', source.replaceAll(':', '-')]) {
    assert.equal(encodeSearchResults(text), undefined)
  }
})

test('short, oversized and already encoded results are declined without extra storage or dependencies', () => {
  assert.equal(encodeSearchResults('a.js:1:x\n'), undefined)
  assert.equal(encodeSearchResults(source, { maxInputBytes: Buffer.byteLength(source) - 1 }), undefined)
  assert.equal(encodeSearchResults(source, { maxOutputBytes: 100 }), undefined)
  const encoded = encodeSearchResults(source)
  assert.equal(encodeSearchResults(encoded), undefined)
  assert.equal(encodeSearchResults('  ' + encoded), undefined)
  assert.equal(encodeSearchResults(encoded.replace('v1]', 'v2]')), undefined)
})

test('decoder enforces exact input/output byte limits and rejects corruption before returning content', () => {
  const encoded = encodeSearchResults(source)
  const inputBytes = Buffer.byteLength(encoded)
  const outputBytes = Buffer.byteLength(source)
  assert.equal(decodeSearchResults(encoded, { maxInputBytes: inputBytes, maxOutputBytes: outputBytes }), source)
  assert.throws(() => decodeSearchResults(encoded, { maxInputBytes: inputBytes - 1 }))
  assert.throws(() => decodeSearchResults(encoded, { maxOutputBytes: outputBytes - 1 }))
  for (const change of [body => { body.sha256 = '0'.repeat(64) }, body => { body.bytes-- },
    body => { body.matches-- }, body => { body.matches = 0 }, body => { body.matches = '80' },
    body => { body.rows[0][0] = -1 }, body => { body.rows[0][0] = body.paths.length },
    body => { body.rows[0][0] = .5 }, body => { body.rows[0][1] = 1 },
    body => { body.rows[0][1] = '9007199254740992' }, body => { body.rows[0][1] = '0' },
    body => { body.rows[0][2] = '?' }, body => { body.rows[0][3] = '\ud800' },
    body => { body.rows[0][4] = '\r' }, body => { body.rows[0][4] = '' },
    body => { body.rows[0].push('extra') }, body => { body.paths.push(body.paths[0]) },
    body => { body.paths[0] = 'C:\\path' }, body => { body.rows = [] },
    body => { body.paths[0] = 'x'.repeat(200000) },
  ]) assert.throws(() => decodeSearchResults(edit(encoded, change)), TypeError)
  for (const limit of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => encodeSearchResults(source, { maxInputBytes: limit }), TypeError)
    assert.throws(() => decodeSearchResults(encoded, { maxOutputBytes: limit }), TypeError)
  }
})

test('decoder rejects unknown fields, altered framing, duplicate keys and invalid group separators', () => {
  const encoded = encodeSearchResults(source)
  for (const value of [null, {}, source, ' ' + encoded, encoded + '\n',
    encoded.replace('v1]', 'v2]'), encoded.replace('paths', 'files'),
    encoded.replace('"version":1', '"version":1,"version":1'),
    edit(encoded, body => { body.extra = true }), edit(encoded, body => { body.version = 2 }),
    edit(encoded, body => { body.rows[0] = ['--', '\r'] }),
    edit(encoded, body => { body.rows[0] = ['--', '\n', 0] }),
    edit(encoded, body => { body.rows = [['--', '']] }),
  ]) assert.throws(() => decodeSearchResults(value), TypeError)
})

test('decoder refuses escaped malformed Unicode paths even with matching replacement-byte receipts', () => {
  const encoded = encodeSearchResults(source)
  const malformedPath = '/workspace/\ud800/file.js'
  const malformedSource = source.replaceAll(paths[0], malformedPath)
  const forged = edit(encoded, body => {
    body.paths[0] = malformedPath
    body.bytes = Buffer.byteLength(malformedSource)
    body.sha256 = createHash('sha256').update(malformedSource).digest('hex')
  })
  assert.throws(() => decodeSearchResults(forged), TypeError)
})

test('deterministic mixed search fixtures round-trip independently of paths, line spelling and content', () => {
  for (let seed = 0; seed < 50; seed++) {
    const text = Array.from({ length: 50 }, (_, i) => {
      const path = `${paths[(seed + i) % 2]}/子目录 ${seed % 3}/source.js`
      const separator = i % 3 === 0 ? '-' : ':'
      const ending = i === 49 ? seed % 2 ? '' : '\r\n' : (seed + i) % 2 ? '\n' : '\r\n'
      return `${path}${separator}${String(seed + i + 1).padStart(4, '0')}${separator}value ${seed * i} 😀\t${ending}`
    }).join('')
    const encoded = encodeSearchResults(text)
    assert.equal(typeof encoded, 'string')
    assert.equal(decodeSearchResults(encoded), text)
  }
})
