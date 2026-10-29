import { recoverSnapshot } from './recovery.js'

const MAX_RANGES = 16
const pageProperties = {
  pageComplete: { type: 'boolean' }, offset: { type: 'integer' },
  nextOffset: { oneOf: [{ type: 'integer' }, { type: 'null' }] }, text: { type: 'string' },
}
const snapshotProperties = {
  referenceId: { type: 'string' }, sha256: { type: 'string' }, bytes: { type: 'integer' },
  snapshotVerified: { type: 'boolean' }, totalCharacters: { type: 'integer' },
}

function requestedRanges(args, pageCharacters, maxBatchCharacters) {
  const batch = Object.hasOwn(args, 'ranges')
  if (batch && (Object.hasOwn(args, 'offset') || Object.hasOwn(args, 'limit'))) {
    throw new TypeError('ranges cannot be combined with offset or limit')
  }
  const ranges = batch ? args.ranges : [{ offset: args.offset === undefined ? 0 : args.offset,
    limit: args.limit === undefined ? pageCharacters : args.limit }]
  if (!Array.isArray(ranges) || ranges.length < 1 || ranges.length > MAX_RANGES) throw new RangeError('Invalid recovery ranges')
  let requested = 0
  const copy = []
  for (const range of ranges) {
    if (!range || typeof range !== 'object' || Array.isArray(range) ||
        Object.keys(range).some(key => !['offset', 'limit'].includes(key)) ||
        !Number.isSafeInteger(range.offset) || range.offset < 0 ||
        !Number.isSafeInteger(range.limit) || range.limit < 1 || range.limit > pageCharacters) {
      throw new RangeError('Invalid recovery character range')
    }
    requested += range.limit
    copy.push({ offset: range.offset, limit: range.limit })
  }
  // Reserve requested sizes, including overlaps and portions that may exceed EOF.
  if (batch && requested > maxBatchCharacters) throw new RangeError('Recovery batch exceeds character budget')
  return { batch, ranges: copy }
}

/**
 * Explicit opt-in model tool. The host supplies an authorized raw-byte backend
 * adapter and the bounded live-session registry used to register its receipts.
 * This does not infer local paths or automatically restore registry ownership.
 */
export function installSnapshotRecovery(ctx, {
  tracking, readPage, maxBytes = 1024 * 1024, pageBytes = 16 * 1024,
  pageCharacters = 2048, maxBatchCharacters = 8192, timeoutMs = 10000, maxPendingReads = 4,
} = {}) {
  if (typeof tracking?.lookup !== 'function' || typeof readPage !== 'function') {
    throw new TypeError('Snapshot tracking and readPage adapter are required')
  }
  for (const [name, value] of Object.entries({ maxBytes, pageBytes, pageCharacters, maxBatchCharacters, timeoutMs, maxPendingReads })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid ${name}`)
  }
  if (pageCharacters > 4096) throw new RangeError('pageCharacters must not exceed 4096')
  if (maxBatchCharacters > 16384) throw new RangeError('maxBatchCharacters must not exceed 16384')
  if (timeoutMs > 2147483647) throw new RangeError('Invalid timeoutMs')
  let disposed = false
  const definition = {
    name: 'free_context_recall',
    description: `Read exact snapshot text by registered referenceId. Choose offset/limit or ranges (1-${MAX_RANGES} {offset,limit} entries; never both). Each limit <= ${pageCharacters}; summed batch limits <= ${maxBatchCharacters}, overlaps included. Offsets/limits count Unicode code points from zero; CRLF/BOM are preserved. Every call checks the full snapshot's bytes/SHA-256 once. snapshotVerified covers stored bytes, not page completeness. Continue via each page's nextOffset until null.`,
    parameters: { type: 'object', additionalProperties: false, required: ['referenceId'], properties: {
      referenceId: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' },
      ranges: { type: 'array', minItems: 1, maxItems: MAX_RANGES, items: {
        type: 'object', additionalProperties: false, required: ['offset', 'limit'], properties: {
          offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: pageCharacters },
        },
      } },
    } },
    output: {
      schema: { oneOf: [
        { type: 'object', additionalProperties: false,
          required: [...Object.keys(snapshotProperties), ...Object.keys(pageProperties)],
          properties: { ...snapshotProperties, ...pageProperties } },
        { type: 'object', additionalProperties: false, required: [...Object.keys(snapshotProperties), 'pages'],
          properties: { ...snapshotProperties, pages: { type: 'array',
            items: { type: 'object', additionalProperties: false, required: Object.keys(pageProperties), properties: pageProperties } } } },
      ] },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
    },
    async execute(args, exec) {
      if (disposed) throw new Error('Snapshot recovery tool is disposed')
      exec.signal?.throwIfAborted()
      if (!args || typeof args !== 'object' || Array.isArray(args) ||
          Object.keys(args).some(key => !['referenceId', 'offset', 'limit', 'ranges'].includes(key)) ||
          typeof args.referenceId !== 'string' || !/^[a-f0-9]{64}$/.test(args.referenceId)) {
        throw new TypeError('Invalid snapshot reference arguments')
      }
      const { referenceId } = args
      const { batch, ranges } = requestedRanges(args, pageCharacters, maxBatchCharacters)
      const receipt = tracking.lookup(exec, referenceId)
      if (!receipt) throw new Error('Unknown snapshot reference for this session')
      const bytes = await recoverSnapshot(receipt, readPage, { maxBytes, pageBytes, timeoutMs, maxPendingReads, signal: exec.signal })
      exec.signal?.throwIfAborted()
      if (disposed || tracking.lookup(exec, referenceId) !== receipt) throw new Error('Snapshot reference ownership changed during recovery')
      // Fatal UTF-8 decoding preserves BOM and prevents replacement-character
      // substitution from being presented as exact snapshot text.
      const characters = Array.from(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
      // Validate all offsets before returning any page; batch failure is atomic.
      if (ranges.some(range => range.offset > characters.length)) throw new RangeError('Recovery offset exceeds snapshot characters')
      const pages = ranges.map(({ offset, limit }) => {
        const end = Math.min(offset + limit, characters.length)
        return { pageComplete: offset === 0 && end === characters.length, offset,
          nextOffset: end < characters.length ? end : null, text: characters.slice(offset, end).join('') }
      })
      const verified = { referenceId, sha256: receipt.sha256, bytes: receipt.bytes, snapshotVerified: true }
      if (batch) return { ...verified, totalCharacters: characters.length, pages }
      const { pageComplete, offset, nextOffset, text } = pages[0]
      return { ...verified, pageComplete, offset, nextOffset, totalCharacters: characters.length, text }
    },
  }
  const unregister = ctx.tools.register(definition)
  const dispose = () => { disposed = true; unregister?.() }
  ctx.effect?.(() => dispose)
  return { dispose }
}
