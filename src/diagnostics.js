import { waitForBoundary } from './async-boundary.js'

/** Estimate serialized content cost, not tokenizer/provider usage or billing. */
export function estimateTokens(bytes) {
  return Math.ceil(bytes / 3)
}

/** Metrics describe JSON-serialized content, including block framing; media tokens are unknown. */
export function measureContent(content, estimator = estimateTokens) {
  const serialized = JSON.stringify(content)
  const bytes = Buffer.byteLength(serialized, 'utf8')
  // The second argument enables a model-specific tokenizer without changing
  // existing byte-only estimators. Pass text, never mutable content objects.
  const tokens = estimator(bytes, serialized)
  if (tokens && typeof tokens.then === 'function') Promise.resolve(tokens).catch(() => {})
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new TypeError('Invalid token estimate')
  return Object.freeze({ bytes, estimatedTokens: tokens })
}

export function safeWarn(warn, message) {
  try { warn(message) } catch {}
}

/** Emit only explicit metadata fields; never include content, arguments or exception text. */
export async function reportDecision(report, warn, record, { signal, timeoutMs = 1000 } = {}) {
  try {
    // Invoke even when already cancelled so synchronous observers can record
    // the skip reason, but never wait indefinitely for their asynchronous work.
    const pending = Promise.resolve(report(Object.freeze(record)))
    pending.catch(() => {})
    await waitForBoundary(() => pending, { signal, timeoutMs })
    return true
  } catch (error) {
    if (signal?.aborted || error?.code === 'BOUNDARY_TIMEOUT') {
      safeWarn(warn, 'dsh-free-context: diagnostic wait interrupted; keeping original content')
      return false
    }
    safeWarn(warn, 'dsh-free-context: diagnostic observer failed')
    return true
  }
}
