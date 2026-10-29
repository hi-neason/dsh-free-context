import { createHash } from 'node:crypto'

const marker = '[dsh-search-results:'
const header = '[dsh-search-results:v1]\nExact search text. matches is the verified number of match rows. In row order, [p,n,s,t,e] means paths[p]+s+n+s+t+e; ["--",e] means "--"+e. n is the original line number; s=":" is a match, s="-" is context; e is the exact line ending. Verify bytes and sha256.\n'
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex')
const invalidControl = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\uFEFF]/u
const validPath = path => typeof path === 'string' && path.length > 0 && path.isWellFormed() && path.trim() === path &&
  !/[:\\\r\n\t]/.test(path) && !invalidControl.test(path) && !/-\d+-/.test(path)
const validLineNumber = number => typeof number === 'string' && /^\d+$/.test(number) &&
  Number.isSafeInteger(Number(number)) && Number(number) > 0

function budgets(maxInputBytes, maxOutputBytes) {
  if (![maxInputBytes, maxOutputBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('Search codec budgets must be positive safe integers')
  }
}

// This grammar deliberately excludes colon/backslash paths and ambiguous
// numeric delimiters. Every accepted character is retained, including context.
function parseLine(line) {
  if (line === '--') return { group: true }
  if (!line || invalidControl.test(line) || /[\r\n]/.test(line)) return undefined
  const match = /^([^:]+):(\d+):(.*)$/.exec(line)
  if (match && validPath(match[1]) && validLineNumber(match[2]) && !/:\d+:/.test(match[3])) {
    return { path: match[1], number: match[2], separator: ':', text: match[3] }
  }
  const separators = [...line.matchAll(/(?=-(\d+)-)/g)]
  if (separators.length !== 1) return undefined
  const [{ index, 1: number }] = separators
  const path = line.slice(0, index)
  if (!validPath(path) || !validLineNumber(number)) return undefined
  return { path, number, separator: '-', text: line.slice(index + number.length + 2) }
}

/** Exact representation of supported grep/rg text, not a claim of complete
 * search coverage, token savings or equivalent model understanding. Unknown
 * lines, ANSI/BOM, Windows/colon paths and ambiguous delimiters retain original.
 */
export function encodeSearchResults(text, { maxInputBytes = 1024 * 1024, maxOutputBytes = 1024 * 1024 } = {}) {
  budgets(maxInputBytes, maxOutputBytes)
  if (typeof text !== 'string' || !text || !text.isWellFormed() || text.trimStart().startsWith(marker)) return undefined
  const bytes = Buffer.byteLength(text)
  if (bytes > maxInputBytes) return undefined
  const paths = []
  const indexes = new Map()
  const rows = []
  let matches = 0
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    if (index === lines.length - 1 && lines[index] === '') break
    let line = lines[index]
    let ending = index < lines.length - 1 ? '\n' : ''
    if (ending && line.endsWith('\r')) { line = line.slice(0, -1); ending = '\r\n' }
    const parsed = parseLine(line)
    if (!parsed) return undefined
    if (parsed.group) { rows.push(['--', ending]); continue }
    if (!indexes.has(parsed.path)) { indexes.set(parsed.path, paths.length); paths.push(parsed.path) }
    rows.push([indexes.get(parsed.path), parsed.number, parsed.separator, parsed.text, ending])
    if (parsed.separator === ':') matches++
  }
  if (!matches) return undefined
  const encoded = header + JSON.stringify({ version: 1, matches, bytes, sha256: hash(text), paths, rows })
  if (Buffer.byteLength(encoded) >= bytes || Buffer.byteLength(encoded) > maxOutputBytes) return undefined
  if (decodeSearchResults(encoded, { maxInputBytes: maxOutputBytes, maxOutputBytes: maxInputBytes }) !== text) return undefined
  return encoded
}

/** Decode only a validated frame, bounding expanded UTF-8 bytes before joining
 * repeated paths. Line-number spelling, row order and all endings are exact.
 */
export function decodeSearchResults(encoded, { maxInputBytes = 1024 * 1024, maxOutputBytes = 1024 * 1024 } = {}) {
  budgets(maxInputBytes, maxOutputBytes)
  const invalid = () => { throw new TypeError('Invalid or oversized search encoding') }
  if (typeof encoded !== 'string' || !encoded.isWellFormed() || Buffer.byteLength(encoded) > maxInputBytes || !encoded.startsWith(header)) invalid()
  const json = encoded.slice(header.length)
  let body
  try { body = JSON.parse(json) } catch { invalid() }
  if (!body || Array.isArray(body) || Object.keys(body).length !== 6 ||
      !['version', 'matches', 'bytes', 'sha256', 'paths', 'rows'].every(key => Object.hasOwn(body, key)) ||
      JSON.stringify(body) !== json || body.version !== 1 ||
      !Number.isSafeInteger(body.matches) || body.matches < 1 ||
      !Number.isSafeInteger(body.bytes) || body.bytes < 1 || body.bytes > maxOutputBytes ||
      typeof body.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.sha256) ||
      !Array.isArray(body.paths) || !body.paths.length || !body.paths.every(validPath) ||
      new Set(body.paths).size !== body.paths.length || !Array.isArray(body.rows) || !body.rows.length) invalid()
  const pathBytes = body.paths.map(path => Buffer.byteLength(path))
  const used = new Set()
  const pieces = []
  let bytes = 0
  let matches = 0
  for (let index = 0; index < body.rows.length; index++) {
    const row = body.rows[index]
    if (!Array.isArray(row)) invalid()
    const group = row.length === 2 && row[0] === '--'
    const ending = row[group ? 1 : 4]
    if (!['', '\n', '\r\n'].includes(ending) || ending === '' && index !== body.rows.length - 1) invalid()
    let line
    if (group) {
      bytes += 2 + ending.length
      if (bytes > body.bytes) invalid()
      line = '--'
    } else {
      const [pathIndex, number, separator, text] = row
      if (row.length !== 5 || !Number.isSafeInteger(pathIndex) || pathIndex < 0 || pathIndex >= body.paths.length ||
          !validLineNumber(number) || ![':', '-'].includes(separator) || typeof text !== 'string' ||
          !text.isWellFormed() || invalidControl.test(text) || /[\r\n]/.test(text)) invalid()
      bytes += pathBytes[pathIndex] + number.length + 2 + Buffer.byteLength(text) + ending.length
      if (!Number.isSafeInteger(bytes) || bytes > body.bytes) invalid()
      line = body.paths[pathIndex] + separator + number + separator + text
      const parsed = parseLine(line)
      if (!parsed || parsed.path !== body.paths[pathIndex] || parsed.number !== number ||
          parsed.separator !== separator || parsed.text !== text) invalid()
      used.add(pathIndex)
      if (separator === ':') matches++
    }
    pieces.push(line + ending)
  }
  if (bytes !== body.bytes || used.size !== body.paths.length || matches !== body.matches) invalid()
  const text = pieces.join('')
  if (hash(text) !== body.sha256) invalid()
  return text
}
