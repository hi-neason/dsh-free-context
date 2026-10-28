const FORMAT = 'dsh-json-rows'
const DEFAULT_MAX_BYTES = 1024 * 1024

/** Remove insignificant JSON whitespace without changing string contents. */
function compactWhitespace(text) {
  let result = ''
  let quoted = false
  let escaped = false
  for (const char of text) {
    if (quoted) {
      result += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') {
      quoted = true
      result += char
    } else if (!' \t\r\n'.includes(char)) result += char
  }
  return result
}

function assertLimit(text, maxInputBytes) {
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1) {
    throw new RangeError('maxInputBytes must be a positive safe integer')
  }
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxInputBytes) {
    throw new TypeError('Expected JSON text within the input byte limit')
  }
}

function assertSafeNumbers(value) {
  const pending = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0) ||
      (Number.isInteger(item) && !Number.isSafeInteger(item)))) {
      throw new TypeError('JSON number cannot be represented safely')
    }
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) pending.push(child)
    }
  }
}

function parseExact(text, maxInputBytes) {
  assertLimit(text, maxInputBytes)
  const value = JSON.parse(text)
  assertSafeNumbers(value)
  // Reject duplicate keys, rounded numbers, negative zero, and other lexical
  // changes. This deliberately rejects some otherwise valid JSON inputs.
  if (compactWhitespace(text) !== JSON.stringify(value)) {
    throw new TypeError('JSON text is not an exact canonical representation')
  }
  return value
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Produce a reversible candidate for a nonempty array with identical ordered
 * object keys. Whitespace formatting is not preserved. A candidate is not a
 * claim of token savings or equivalent model task performance.
 *
 * @param {string} text
 * @param {{maxInputBytes?: number}} [options]
 * @returns {string | undefined} Undefined means retain the original input.
 */
export function encodeJsonRows(text, { maxInputBytes = DEFAULT_MAX_BYTES } = {}) {
  try {
    const value = parseExact(text, maxInputBytes)
    if (!Array.isArray(value) || value.length === 0 || !value.every(isRecord)) return undefined
    const schema = Object.keys(value[0])
    if (!value.every(row => {
      const keys = Object.keys(row)
      return keys.length === schema.length && keys.every((key, index) => key === schema[index])
    })) return undefined
    return JSON.stringify({ format: FORMAT, version: 1, schema,
      rows: value.map(row => schema.map(key => row[key])) })
  } catch {
    return undefined
  }
}

/**
 * Validate an untrusted versioned envelope and restore canonical JSON text.
 * Throws when input is invalid or exceeds the configured byte limit.
 *
 * @param {string} text
 * @param {{maxInputBytes?: number, maxOutputBytes?: number}} [options]
 * @returns {string}
 */
export function decodeJsonRows(text, { maxInputBytes = DEFAULT_MAX_BYTES, maxOutputBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new RangeError('Invalid maxOutputBytes')
  const envelope = parseExact(text, maxInputBytes)
  if (!isRecord(envelope) || Object.keys(envelope).length !== 4 ||
    !['format', 'version', 'schema', 'rows'].every(key => Object.hasOwn(envelope, key)) ||
    envelope.format !== FORMAT || envelope.version !== 1 ||
    !Array.isArray(envelope.schema) || !envelope.schema.every(key => typeof key === 'string') ||
    new Set(envelope.schema).size !== envelope.schema.length ||
    !Array.isArray(envelope.rows) || envelope.rows.length === 0 ||
    !envelope.rows.every(row => Array.isArray(row) && row.length === envelope.schema.length)) {
    throw new TypeError('Invalid dsh-json-rows envelope')
  }
  // Bound schema expansion before constructing any restored objects. A small
  // envelope can otherwise repeat a very long key across thousands of rows.
  const keyBytes = envelope.schema.reduce((total, key) => total + Buffer.byteLength(JSON.stringify(key)) + 1, 0)
  let outputBytes = 2 + envelope.rows.length - 1
  for (const row of envelope.rows) {
    outputBytes += 2 + keyBytes + Math.max(0, row.length - 1)
    for (const value of row) outputBytes += Buffer.byteLength(JSON.stringify(value))
    if (outputBytes > maxOutputBytes) throw new RangeError('Decoded JSON exceeds output byte limit')
  }
  // fromEntries creates own data properties, including __proto__.
  const restored = envelope.rows.map(row => Object.fromEntries(
    envelope.schema.map((key, index) => [key, row[index]])))
  return JSON.stringify(restored)
}
