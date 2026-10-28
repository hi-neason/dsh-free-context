// This encoding changes only the selector's input representation, never source
// spans or the evidence returned to the main agent.
export const decodingInstruction = 'Source text uses version 2 literal dictionary encoding: dictionary contains only repeated exact strings; each span retains its original id and ordered runs. A string run is exact inline text; [zero-based dictionaryIndex, count] repeats dictionary[dictionaryIndex] count times. Concatenate runs without inserting or removing characters. Select original span IDs; repeated text retains its full multiplicity.'

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
  const chunked = spans.map(({ id, text }) => ({ id, chunks: chunks(text) }))
  const counts = new Map()
  for (const span of chunked) for (const chunk of span.chunks) counts.set(chunk, (counts.get(chunk) ?? 0) + 1)
  const dictionary = []
  const indexes = new Map()
  return { version: 2, dictionary, spans: chunked.map(({ id, chunks }) => {
    const runs = []
    for (const chunk of chunks) {
      const last = runs.at(-1)
      if (counts.get(chunk) === 1) {
        if (typeof last === 'string') runs[runs.length - 1] += chunk
        else runs.push(chunk)
        continue
      }
      if (!indexes.has(chunk)) { indexes.set(chunk, dictionary.length); dictionary.push(chunk) }
      const index = indexes.get(chunk)
      if (Array.isArray(last) && last[0] === index) last[1]++
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
  const inline = encoded?.version === 2
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      !shape(encoded, inline ? ['version', 'dictionary', 'spans'] : ['dictionary', 'spans']) || !Array.isArray(encoded.dictionary) ||
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
  if ((!inline && !sizes.length) || encoded.spans.length > maxBytes) invalid()
  const ids = new Set()
  let totalBytes = 0
  // Validate the entire expansion before allocating any decoded text.
  for (const span of encoded.spans) {
    if (!shape(span, ['id', 'runs']) || typeof span.id !== 'string' || !span.id.length ||
        !span.id.isWellFormed() || ids.has(span.id) || !Array.isArray(span.runs) || !span.runs.length) invalid()
    ids.add(span.id)
    for (const run of span.runs) {
      if (inline && typeof run === 'string') {
        if (!run.length || !run.isWellFormed()) invalid()
        totalBytes += Buffer.byteLength(run)
        if (totalBytes > maxBytes) invalid()
        continue
      }
      if (!Array.isArray(run) || run.length !== 2) invalid()
      const [index, count] = run
      if (!Number.isSafeInteger(index) || index < 0 || index >= sizes.length ||
          !Number.isSafeInteger(count) || count < 1 || count > Math.floor((maxBytes - totalBytes) / sizes[index])) invalid()
      totalBytes += sizes[index] * count
    }
  }
  return encoded.spans.map(({ id, runs }) => ({ id, text: runs.map(run => typeof run === 'string' ? run : encoded.dictionary[run[0]].repeat(run[1])).join('') }))
}
