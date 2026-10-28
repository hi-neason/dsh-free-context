import { createHash } from 'node:crypto'
import { encodeSourceSpans, decodeSourceSpans } from './selector-prompt.js'

const marker = '[dsh-lossless-text:'
const header = '[dsh-lossless-text:v1]\nLossless encoding of this tool-result text, not a claim of semantic or file completeness. Decode source.spans[0].runs in order: string runs are exact literals; [index,count] repeats source.dictionary[index] count times. Concatenate without adding or removing characters. Verify the decoded UTF-8 bytes and SHA-256 against bytes and sha256.\n'
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex')
const isEnvelope = text => text.trimStart().startsWith(marker)

function validateBudgets(maxInputBytes, maxOutputBytes) {
  if (![maxInputBytes, maxOutputBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('Lossless text budgets must be positive safe integers')
  }
}

/** Pure representation change. Budgets bound source input and encoded output.
 * A caller must separately gate final serialized content, including receipts.
 */
export function encodeLosslessText(text, { maxInputBytes = 1024 * 1024, maxOutputBytes = 1024 * 1024 } = {}) {
  validateBudgets(maxInputBytes, maxOutputBytes)
  if (typeof text !== 'string' || !text.length || !text.isWellFormed()) return undefined
  const bytes = Buffer.byteLength(text)
  if (bytes > maxInputBytes || isEnvelope(text)) return undefined
  const encoded = header + JSON.stringify({ version: 1, bytes, sha256: hash(text), source: encodeSourceSpans([{ id: 'text', text }]) })
  const encodedBytes = Buffer.byteLength(encoded)
  if (encodedBytes >= bytes || encodedBytes > maxOutputBytes) return undefined
  if (decodeLosslessText(encoded, { maxInputBytes: maxOutputBytes, maxOutputBytes: maxInputBytes }) !== text) return undefined
  return encoded
}

/** Budgets bound encoded input and decoded output. Return only verified text;
 * no filesystem lookup, snapshot claim, semantic guarantee or model call.
 */
export function decodeLosslessText(encoded, { maxInputBytes = 1024 * 1024, maxOutputBytes = 1024 * 1024 } = {}) {
  validateBudgets(maxInputBytes, maxOutputBytes)
  const invalid = () => { throw new TypeError('Invalid or oversized lossless text encoding') }
  if (typeof encoded !== 'string' || !encoded.isWellFormed() || Buffer.byteLength(encoded) > maxInputBytes || !encoded.startsWith(header)) invalid()
  const json = encoded.slice(header.length)
  let body
  try { body = JSON.parse(json) } catch { invalid() }
  // Canonical JSON rejects trailing text/whitespace and duplicate keys. Exact
  // field sets reject prototype-shaped metadata, without filtering source text.
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== 4 || !['version', 'bytes', 'sha256', 'source'].every(key => Object.hasOwn(body, key)) ||
      JSON.stringify(body) !== json || body.version !== 1 ||
      !Number.isSafeInteger(body.bytes) || body.bytes < 1 || body.bytes > maxOutputBytes ||
      typeof body.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.sha256) ||
      body.source?.version !== 2 || !Array.isArray(body.source.spans) || body.source.spans.length !== 1 || body.source.spans[0]?.id !== 'text') invalid()
  const [{ text }] = decodeSourceSpans(body.source, { maxBytes: body.bytes })
  if (Buffer.byteLength(text) !== body.bytes || hash(text) !== body.sha256 || isEnvelope(text)) invalid()
  return text
}
