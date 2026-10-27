// This encoding changes only the selector's input representation, never source
// spans or the evidence returned to the main agent.
export const decodingInstruction = 'Source text uses a literal dictionary encoding: dictionary contains exact strings; each span has its original id and runs of [zero-based dictionaryIndex, count]. Decode each span by repeating dictionary[dictionaryIndex] count times and concatenating runs in order, without inserting or removing characters. Select original span IDs after decoding; repeated text retains its full multiplicity.'

function chunks(text) {
  const result = []
  let start = 0
  // Keep punctuation, spaces and line endings in their original chunks.
  for (const match of text.matchAll(/[.!?。！？](?:[ \t]+|(?=\r|\n|$))|\r\n|\r|\n/g)) {
    const end = match.index + match[0].length
    result.push(text.slice(start, end))
    start = end
  }
  if (start < text.length) result.push(text.slice(start))
  return result
}

export function encodeSourceSpans(spans) {
  const dictionary = []
  const indexes = new Map()
  return { dictionary, spans: spans.map(({ id, text }) => {
    const runs = []
    for (const chunk of chunks(text)) {
      if (!indexes.has(chunk)) { indexes.set(chunk, dictionary.length); dictionary.push(chunk) }
      const index = indexes.get(chunk)
      const last = runs.at(-1)
      if (last?.[0] === index) last[1]++
      else runs.push([index, 1])
    }
    return { id, runs }
  }) }
}

function shape(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

export function decodeSourceSpans(encoded, { maxBytes } = {}) {
  const invalid = () => { throw new TypeError('Invalid or oversized selector encoding') }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      !shape(encoded, ['dictionary', 'spans']) || !Array.isArray(encoded.dictionary) ||
      !Array.isArray(encoded.spans) || !encoded.spans.length) invalid()
  let dictionaryBytes = 0
  const sizes = []
  for (const literal of encoded.dictionary) {
    if (typeof literal !== 'string' || !literal.length || !literal.isWellFormed()) invalid()
    const bytes = Buffer.byteLength(literal)
    dictionaryBytes += bytes
    if (dictionaryBytes > maxBytes) invalid()
    sizes.push(bytes)
  }
  if (!sizes.length || encoded.spans.length > maxBytes) invalid()
  const ids = new Set()
  let totalBytes = 0
  // Validate the entire expansion before allocating any decoded text.
  for (const span of encoded.spans) {
    if (!shape(span, ['id', 'runs']) || typeof span.id !== 'string' || !span.id.length ||
        !span.id.isWellFormed() || ids.has(span.id) || !Array.isArray(span.runs) || !span.runs.length) invalid()
    ids.add(span.id)
    for (const run of span.runs) {
      if (!Array.isArray(run) || run.length !== 2) invalid()
      const [index, count] = run
      if (!Number.isSafeInteger(index) || index < 0 || index >= sizes.length ||
          !Number.isSafeInteger(count) || count < 1 || count > Math.floor((maxBytes - totalBytes) / sizes[index])) invalid()
      totalBytes += sizes[index] * count
    }
  }
  return encoded.spans.map(({ id, runs }) => ({ id, text: runs.map(([index, count]) => encoded.dictionary[index].repeat(count)).join('') }))
}
