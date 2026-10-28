import { createHash } from 'node:crypto'

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
  const codes = { EACCES: 'filesystem', EPERM: 'filesystem', ENOENT: 'filesystem', ENOSPC: 'filesystem', ETIMEDOUT: 'timeout', ABORTED: 'timeout', UNAUTHORIZED: 'auth', INVALID_API_KEY: 'auth', CONFIG_INVALID: 'configuration',
    TRANSPORT: 'transport', TIMEOUT: 'timeout', AUTH: 'auth', QUOTA: 'quota', RATE_LIMIT: 'rate-limit', SERVER: 'server', INVALID_REQUEST: 'request' }
  const names = { TimeoutError: 'timeout', AbortError: 'timeout', TypeError: 'configuration', SyntaxError: 'configuration' }
  const code = typeof error?.code === 'string' && Object.hasOwn(codes, error.code) ? error.code : undefined
  const name = typeof error?.name === 'string' && Object.hasOwn(names, error.name) ? error.name : undefined
  const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : undefined
  const requestIdHash = typeof error?.requestId === 'string' && error.requestId.length > 0 && error.requestId.length <= 4096
    ? createHash('sha256').update(error.requestId, 'utf8').digest('hex') : undefined
  return { category: code ? codes[code] : name ? names[name] : 'unknown', ...(code ? { code } : {}), ...(name ? { name } : {}),
    ...(status !== undefined ? { status } : {}), ...(requestIdHash ? { requestIdHash } : {}) }
}
