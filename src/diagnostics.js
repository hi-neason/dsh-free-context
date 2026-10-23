/** Estimate serialized content cost, not tokenizer/provider usage or billing. */
export function estimateTokens(bytes) {
  return Math.ceil(bytes / 3)
}

/** Metrics describe JSON-serialized content, including block framing; media tokens are unknown. */
export function measureContent(content, estimator = estimateTokens) {
  const bytes = Buffer.byteLength(JSON.stringify(content), 'utf8')
  const tokens = estimator(bytes)
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new TypeError('Invalid token estimate')
  return Object.freeze({ bytes, estimatedTokens: tokens })
}

export function safeWarn(warn, message) {
  try { warn(message) } catch {}
}

/** Emit only explicit metadata fields; never include content, arguments or exception text. */
export async function reportDecision(report, warn, record) {
  try { await report(Object.freeze(record)) } catch {
    safeWarn(warn, 'dsh-free-context: diagnostic observer failed')
  }
}
