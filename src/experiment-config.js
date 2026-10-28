const budgets = ['maxInputBytes', 'maxPromptBytes', 'maxOutputBytes', 'maxOutputTokens', 'maxArtifactBytes', 'timeoutMs', 'maxParagraphs']
const amounts = ['maxTotalCost', 'maxCallCost', 'expectedRecoveryCost', 'safetyMargin', 'futureCacheReadPerMillion']
const keys = ['promptEncoding', 'admission', 'maxCalls', 'selectionMode', 'maxQueryBytes', 'mode', 'tools', 'provider', 'model', ...budgets, ...amounts, 'maxCacheEntries', 'maxInFlight', 'protectedTerms', 'pricing', 'minimumFutureRequests', 'minSavingsTokens', 'comparatorTokenCap']
const rateKeys = ['uncachedInputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion', 'outputPerMillion']
const priceKeys = ['currency', ...rateKeys, 'cacheWritePolicy']
function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be an object`)
  for (const key of Reflect.ownKeys(value)) if (!allowed.includes(key)) throw new TypeError(`${label}: unknown key ${String(key)}`)
}
function number(value, label, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
      (integer && !Number.isSafeInteger(value)) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new TypeError(`${label} is invalid`)
}
function strings(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim()) || new Set(value).size !== value.length) throw new TypeError(`${label} must contain unique nonempty strings`)
  return Object.freeze([...value])
}

export function parseExperimentConfig(input = {}) {
  object(input, keys, 'experiment config')
  const config = { promptEncoding: 'plain', admission: 'forecast', selectionMode: 'task-independent', mode: 'off', tools: [], maxInFlight: 4, maxCacheEntries: 0, protectedTerms: [], minSavingsTokens: 32, ...input }
  if (!['plain', 'auto'].includes(config.promptEncoding)) throw new TypeError('Invalid promptEncoding')
  if (!['forecast', 'measured-trial'].includes(config.admission)) throw new TypeError('Invalid admission')
  if (!['task-independent', 'query-dependent', 'diagnostic-evidence'].includes(config.selectionMode)) throw new TypeError('Invalid selectionMode')
  if (!['off', 'observe', 'apply'].includes(config.mode)) throw new TypeError('Invalid mode')
  config.tools = strings(config.tools, 'tools')
  if (config.tools.some(tool => /\s/.test(tool))) throw new TypeError('Tool names must not contain whitespace')
  config.protectedTerms = strings(config.protectedTerms, 'protectedTerms')
  for (const key of [...budgets, 'maxCalls', 'maxQueryBytes', 'maxInFlight', 'maxCacheEntries', 'minimumFutureRequests', 'minSavingsTokens', 'comparatorTokenCap']) if (config[key] !== undefined) number(config[key], key, true)
  for (const key of amounts) if (config[key] !== undefined) number(config[key], key)
  if (!config.maxInFlight) throw new TypeError('maxInFlight must be positive')
  if (config.safetyMargin !== undefined && config.safetyMargin >= 1) throw new TypeError('safetyMargin must be less than 1')
  if (config.timeoutMs !== undefined && config.timeoutMs > 2147483647) throw new TypeError('timeoutMs exceeds timer range')
  for (const key of ['provider', 'model']) if (config[key] !== undefined && (typeof config[key] !== 'string' || !config[key].trim())) throw new TypeError(`${key} is invalid`)
  if (config.pricing !== undefined) {
    object(config.pricing, priceKeys, 'pricing')
    if (config.pricing.currency !== undefined && (typeof config.pricing.currency !== 'string' || !/^[A-Z]{3}$/.test(config.pricing.currency))) throw new TypeError('pricing.currency must be a currency code')
    if (config.pricing.cacheWritePolicy !== undefined && config.pricing.cacheWritePolicy !== 'reject-nonzero') throw new TypeError('pricing.cacheWritePolicy is invalid')
    for (const key of rateKeys) if (config.pricing[key] !== undefined) number(config.pricing[key], `pricing.${key}`)
    config.pricing = Object.freeze({ ...config.pricing })
  }
  if (config.admission === 'measured-trial') {
    for (const key of ['maxCalls', 'maxTotalCost', 'maxCallCost']) if (!config[key]) throw new TypeError(`${key} must be explicitly positive for measured-trial`)
    if (config.pricing?.currency !== 'USD' || ['uncachedInputPerMillion', 'cacheReadPerMillion', 'outputPerMillion'].some(key => config.pricing[key] === undefined) ||
      config.pricing.cacheWritePerMillion === undefined && config.pricing.cacheWritePolicy !== 'reject-nonzero') throw new TypeError('Measured trials require complete USD auxiliary pricing')
  }
  if (config.mode !== 'off' && config.tools.length) {
    for (const key of budgets) if (!config[key]) throw new TypeError(`${key} must be explicitly positive`)
    if (config.selectionMode === 'query-dependent' && !config.maxQueryBytes) throw new TypeError('maxQueryBytes must be explicitly positive')
    if (!config.provider || !config.model) throw new TypeError('Explicit provider and model are required')
  }
  return Object.freeze(config)
}

export const Config = Object.freeze({ '~standard': Object.freeze({ version: 1, vendor: 'dsh-free-context-experiments', validate(input) {
  try { return { value: parseExperimentConfig(input) } } catch (error) { return { issues: [{ message: error.message }] } }
} }) })
