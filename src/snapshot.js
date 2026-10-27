import { createHash } from 'node:crypto'
import { waitForBoundary } from './async-boundary.js'

// A timeout releases the caller, not the backend. Count real unfinished saves
// until they settle so repeated cancellation cannot start unlimited writes.
const pendingSaves = new WeakMap()

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a nonempty string`)
  }
  return value
}

/**
 * Archive the exact original tool text through the host-owned spill backend.
 * A failed or cancelled save must be handled by retaining original content.
 * No receipt is returned after cancellation, even if storage already completed.
 * @param {{saveText: Function}} store
 * @param {object} exec
 * @param {string} text
 * @param {{maxBytes?: number, timeoutMs?: number, maxPendingSaves?: number}} [options]
 */
export async function archiveOriginal(store, exec, text, {
  maxBytes = 1024 * 1024, timeoutMs = 10000, maxPendingSaves = 4,
} = {}) {
  const sessionId = requireText(exec?.agent?.session?.header?.id, 'sessionId')
  const callId = requireText(exec?.callId, 'callId')
  const toolName = requireText(exec?.name, 'toolName')
  const signal = exec.signal
  signal?.throwIfAborted()
  if (typeof store?.saveText !== 'function') throw new TypeError('spillStore.saveText is required')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Invalid maxBytes')
  if (!Number.isSafeInteger(maxPendingSaves) || maxPendingSaves < 1) throw new RangeError('Invalid maxPendingSaves')
  // Unpaired surrogates cannot be saved verbatim as UTF-8.
  if (typeof text !== 'string' || !text.isWellFormed()) throw new TypeError('Expected well-formed text')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > maxBytes) throw new RangeError('Original exceeds snapshot byte limit')
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex')
  const saved = await waitForBoundary(() => {
    const count = pendingSaves.get(store) ?? 0
    if (count >= maxPendingSaves) throw new Error('Snapshot pending save limit reached')
    pendingSaves.set(store, count + 1)
    const release = () => {
      const remaining = pendingSaves.get(store) - 1
      if (remaining) pendingSaves.set(store, remaining)
      else pendingSaves.delete(store)
    }
    try {
      return Promise.resolve(store.saveText({
        owner: { sessionId },
        source: { kind: 'tool', toolName, callId, label: 'result' },
        suggestedName: 'free-context-original.txt', content: text,
      })).finally(release)
    } catch (error) { release(); throw error }
  }, { signal, timeoutMs })
  signal?.throwIfAborted()
  exec.signal?.throwIfAborted()
  if (exec.agent?.session?.header?.id !== sessionId || exec.callId !== callId || exec.name !== toolName) {
    throw new Error('Tool execution identity changed during snapshot storage')
  }
  const locator = requireText(saved?.locator, 'locator')
  const retrievalHint = requireText(saved?.retrievalHint, 'retrievalHint')
  if (saved.bytes !== bytes) throw new Error('Snapshot byte count does not match original')
  return Object.freeze({ sessionId, callId, toolName, sha256, bytes, locator, retrievalHint })
}

/** Stable public identifier; it grants no access without a session registration. */
export function snapshotReferenceId(receipt) {
  return createHash('sha256').update(JSON.stringify([receipt.locator, receipt.sha256])).digest('hex')
}

/** Render an opaque backend reference; never derive a filesystem path from it. */
export function formatSnapshotReference(receipt, { includeGuidance = true } = {}) {
  if (typeof includeGuidance !== 'boolean') throw new TypeError('includeGuidance must be a boolean')
  const reference = [
    `Original tool-result snapshot: ${JSON.stringify(receipt)}`,
    `Snapshot referenceId: ${snapshotReferenceId(receipt)}.`,
  ]
  if (!includeGuidance) return reference.join('\n')
  return [
    reference[0],
    `${reference[1]} For verified recovery, use this registered ID with free_context_recall if installed.`,
    'Retrieve this snapshot when the task requires omitted evidence, a completeness check, or the exact original. Use the backend retrievalHint and existing read/grep tools when supported; read all pages for full recovery. Do not substitute the current source file.',
    'For full recovery, verify the UTF-8 byte count and SHA-256 of the complete retrieved text against this receipt. A partial read or grep match does not verify the full snapshot.',
  ].join('\n')
}
