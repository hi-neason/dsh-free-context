import { recoverSnapshot } from './recovery.js'

/**
 * Explicit opt-in model tool. The host supplies an authorized raw-byte backend
 * adapter and the bounded live-session registry used to register its receipts.
 * This does not infer local paths or automatically restore registry ownership.
 */
export function installSnapshotRecovery(ctx, {
  tracking, readPage, maxBytes = 1024 * 1024, pageBytes = 16 * 1024,
  pageCharacters = 2048, timeoutMs = 10000, maxPendingReads = 4,
} = {}) {
  if (typeof tracking?.lookup !== 'function' || typeof readPage !== 'function') {
    throw new TypeError('Snapshot tracking and readPage adapter are required')
  }
  for (const [name, value] of Object.entries({ maxBytes, pageBytes, pageCharacters, timeoutMs, maxPendingReads })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid ${name}`)
  }
  if (pageCharacters > 4096) throw new RangeError('pageCharacters must not exceed 4096')
  if (timeoutMs > 2147483647) throw new RangeError('Invalid timeoutMs')
  let disposed = false
  const definition = {
    name: 'free_context_recall',
    description: 'Read exact original snapshot text by a registered referenceId. Every call verifies the entire snapshot byte count and SHA-256 before returning one bounded page. Offsets and limits count Unicode code points, starting at zero; preserve text exactly including CRLF. snapshotVerified describes the full stored bytes, not whether this page includes the whole snapshot. Continue with nextOffset until null.',
    parameters: { type: 'object', additionalProperties: false, required: ['referenceId'], properties: {
      referenceId: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' },
    } },
    output: {
      schema: { type: 'object', additionalProperties: false,
        required: ['referenceId', 'sha256', 'bytes', 'snapshotVerified', 'pageComplete', 'offset', 'nextOffset', 'totalCharacters', 'text'],
        properties: {
          referenceId: { type: 'string' }, sha256: { type: 'string' }, bytes: { type: 'integer' },
          snapshotVerified: { type: 'boolean' }, pageComplete: { type: 'boolean' }, offset: { type: 'integer' },
          nextOffset: { oneOf: [{ type: 'integer' }, { type: 'null' }] }, totalCharacters: { type: 'integer' }, text: { type: 'string' },
        } },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
    },
    async execute(args, exec) {
      if (disposed) throw new Error('Snapshot recovery tool is disposed')
      exec.signal?.throwIfAborted()
      if (!args || typeof args !== 'object' || Array.isArray(args) ||
          Object.keys(args).some(key => !['referenceId', 'offset', 'limit'].includes(key)) ||
          typeof args.referenceId !== 'string' || !/^[a-f0-9]{64}$/.test(args.referenceId)) {
        throw new TypeError('Invalid snapshot reference arguments')
      }
      const { referenceId, offset = 0, limit = pageCharacters } = args
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > pageCharacters) {
        throw new RangeError('Invalid recovery character range')
      }
      const receipt = tracking.lookup(exec, referenceId)
      if (!receipt) throw new Error('Unknown snapshot reference for this session')
      const bytes = await recoverSnapshot(receipt, readPage, { maxBytes, pageBytes, timeoutMs, maxPendingReads, signal: exec.signal })
      exec.signal?.throwIfAborted()
      if (disposed || tracking.lookup(exec, referenceId) !== receipt) throw new Error('Snapshot reference ownership changed during recovery')
      // Fatal UTF-8 decoding preserves BOM and prevents replacement-character
      // substitution from being presented as exact snapshot text.
      const characters = Array.from(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
      if (offset > characters.length) throw new RangeError('Recovery offset exceeds snapshot characters')
      const end = Math.min(offset + limit, characters.length)
      return { referenceId, sha256: receipt.sha256, bytes: receipt.bytes, snapshotVerified: true,
        pageComplete: offset === 0 && end === characters.length, offset,
        nextOffset: end < characters.length ? end : null, totalCharacters: characters.length,
        text: characters.slice(offset, end).join('') }
    },
  }
  const unregister = ctx.tools.register(definition)
  const dispose = () => { disposed = true; unregister?.() }
  ctx.effect?.(() => dispose)
  return { dispose }
}
