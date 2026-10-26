import { createHash } from 'node:crypto'
import { waitForBoundary } from './async-boundary.js'

// Caller deadlines do not settle backend work. Keep actual pending reads
// charged to the stable backend callback until that callback really settles.
const pendingReads = new WeakMap()

function validateReceipt(receipt) {
  if (!Number.isSafeInteger(receipt?.bytes) || receipt.bytes < 0 ||
      typeof receipt.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
      typeof receipt.locator !== 'string' || receipt.locator.trim().length === 0) {
    throw new TypeError('Invalid snapshot receipt')
  }
}

/** Verify complete raw bytes, never decoded line windows or search matches. */
export function verifySnapshot(receipt, bytes) {
  validateReceipt(receipt)
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected raw snapshot bytes')
  if (bytes.byteLength !== receipt.bytes) throw new Error('Snapshot byte count mismatch')
  if (createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) {
    throw new Error('Snapshot hash mismatch')
  }
  return true
}

/**
 * Recover through a caller-supplied raw-byte backend, without interpreting its
 * opaque locator. readPage(locator, {offset, length, signal}) must return bytes.
 * This is a host library, not a model-facing tool or an authorization boundary.
 * Local hosts can explicitly adapt fs.resolve + fs.readByteRange; other spill
 * backends must supply their own adapter. No source-file fallback is attempted.
 */
export async function recoverSnapshot(receipt, readPage, {
  maxBytes = 1024 * 1024, pageBytes = 16 * 1024, timeoutMs = 10000, maxPendingReads = 4, signal,
} = {}) {
  validateReceipt(receipt)
  // Freeze the expected identity across asynchronous reads.
  const expected = { bytes: receipt.bytes, sha256: receipt.sha256, locator: receipt.locator }
  if (typeof readPage !== 'function') throw new TypeError('readPage is required')
  for (const [name, value] of Object.entries({ maxBytes, pageBytes, maxPendingReads })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid ${name}`)
  }
  if (expected.bytes > maxBytes) throw new RangeError('Snapshot exceeds recovery byte limit')
  const controller = new AbortController()
  const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    return await waitForBoundary(async () => {
      const chunks = []
      let offset = 0
      // Probe one byte beyond expected EOF to reject appended content too.
      while (offset <= expected.bytes) {
        activeSignal.throwIfAborted()
        const length = Math.min(pageBytes, expected.bytes - offset + 1)
        const pending = pendingReads.get(readPage) ?? 0
        if (pending >= maxPendingReads) throw new Error('Snapshot pending read limit reached')
        pendingReads.set(readPage, pending + 1)
        let page
        try {
          page = await readPage(expected.locator, { offset, length, signal: activeSignal })
        } finally {
          const remaining = pendingReads.get(readPage) - 1
          if (remaining) pendingReads.set(readPage, remaining)
          else pendingReads.delete(readPage)
        }
        activeSignal.throwIfAborted()
        if (!(page instanceof Uint8Array)) throw new TypeError('Expected raw page bytes')
        if (page.byteLength > length) throw new Error('Backend exceeded requested page size')
        if (page.byteLength === 0) {
          if (offset !== expected.bytes) throw new Error('Snapshot ended before expected byte count')
          break
        }
        offset += page.byteLength
        if (offset > expected.bytes) throw new Error('Snapshot byte count exceeds receipt')
        chunks.push(Buffer.from(page))
      }
      const bytes = Buffer.concat(chunks, offset)
      verifySnapshot(expected, bytes)
      return bytes
    }, { signal: activeSignal, timeoutMs })
  } finally {
    // Prevent another page after late settlement of a timed-out backend read.
    controller.abort()
  }
}
