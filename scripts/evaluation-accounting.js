const usageFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
export function validUsage(usage) {
  return usage !== null && typeof usage === 'object' && usageFields.every((field, index) =>
    index > 1 && usage[field] === undefined || Number.isSafeInteger(usage[field]) && usage[field] >= 0)
}

/** Unknown or invalid attempts leave accounting incomplete, never silently free. */
export function summarizeUsage(records) {
  const usage = Object.fromEntries(usageFields.map(field => [field, 0]))
  let complete = records.length > 0
  for (const record of records) {
    if (!validUsage(record)) { complete = false; continue }
    for (const field of usageFields) {
      const total = usage[field] + (record[field] ?? 0)
      if (!Number.isSafeInteger(total)) complete = false
      else usage[field] = total
    }
  }
  return { usage, complete }
}

/** Explicit-price estimates, never billed charges. Input counts in DSH are disjoint. */
export function priceUsage(usage, prices) {
  if (!validUsage(usage)) return null
  if (!prices || prices.currency !== 'USD' || !['uncached', 'cacheRead', 'output'].every(key => Number.isFinite(prices[key]) && prices[key] >= 0) || !prices.sourceUrl) return null
  if ((usage.cacheWriteTokens ?? 0) > 0) return null
  const cost = (usage.inputTokens * prices.uncached + usage.outputTokens * prices.output + (usage.cacheReadTokens ?? 0) * prices.cacheRead) / 1e6
  return Number.isFinite(cost) ? cost : null
}
/** Provider bodies and arbitrary exception strings are never evaluation evidence. */
export function safeFailure(error) {
  const codes = { EACCES: 'filesystem', EPERM: 'filesystem', ENOENT: 'filesystem', ENOSPC: 'filesystem', ETIMEDOUT: 'timeout', ABORTED: 'timeout', UNAUTHORIZED: 'auth', INVALID_API_KEY: 'auth', CONFIG_INVALID: 'configuration' }
  const names = { TimeoutError: 'timeout', AbortError: 'timeout', TypeError: 'configuration', SyntaxError: 'configuration' }
  const code = Object.hasOwn(codes, error?.code) ? error.code : undefined
  const name = Object.hasOwn(names, error?.name) ? error.name : undefined
  return { category: code ? codes[code] : name ? names[name] : 'unknown', ...(code ? { code } : {}), ...(name ? { name } : {}) }
}
