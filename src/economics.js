const tokenFields = ['originalTokens', 'candidateTokens', 'invalidatedPrefixTokens', 'minimumFutureRequests']
const costFields = ['compressionCost', 'expectedRecoveryCost', 'safetyMargin']
const priceFields = ['uncachedInputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion']

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain object`)
}

function nonnegative(value, label, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
      (integer && !Number.isInteger(value)) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new TypeError(`${label} must be a non-negative ${integer ? 'safe integer' : 'finite number'}`)
}

/**
 * Conservative prediction only, not provider billing evidence or guaranteed savings.
 * All monetary inputs use the same caller-selected unit. Prices are per million
 * tokens; compressionCost and expectedRecoveryCost are TOTAL incremental costs
 * for this decision, not per-request costs. They must exclude the prefix rebuild
 * charged here, preventing double counting. Include extra model/output costs in
 * those explicit totals. No price, model or future-request default is inferred.
 *
 * Baseline: removed tokens would be cache hits on every assumed future request.
 * Rebuild: one invalidated prefix is charged only the positive difference between
 * cache-write (when supplied) OR uncached-input price and baseline cache-read
 * price, never both. A supplied write price means a REPLACEMENT total token price,
 * not a provider's additive write surcharge; callers must normalize it first.
 * invalidatedPrefixTokens describes the retained prefix requiring this rebuild,
 * excluding removed tokens. Repeated invalidations require separate assessments.
 *
 * safetyMargin is a required proportion in [0, 1): reserve that share of gross
 * savings. Adopt only when remaining savings strictly exceed all extra costs.
 * minimumFutureRequests is an explicit caller assumption, not a forecast produced
 * here. Missing assumptions decline adoption; malformed supplied values throw.
 * Integer-valued prices/costs must also be safe integers; decimal prices are allowed.
 *
 * @param {object} [input]
 * @returns {object} Explained decision; breakEvenRequests is null if no finite safe threshold exists.
 */
export function assessNetBenefit(input = {}) {
  plainObject(input, 'input')
  for (const key of tokenFields) if (input[key] !== undefined) nonnegative(input[key], key, true)
  for (const key of costFields) if (input[key] !== undefined) nonnegative(input[key], key)
  if (input.safetyMargin !== undefined && input.safetyMargin >= 1) throw new TypeError('safetyMargin must be less than 1')
  if (input.pricing !== undefined) {
    plainObject(input.pricing, 'pricing')
    for (const key of priceFields) if (input.pricing[key] !== undefined) nonnegative(input.pricing[key], `pricing.${key}`)
  }
  const missing = [...tokenFields, ...costFields].filter(key => input[key] === undefined)
  for (const key of priceFields.slice(0, 2)) if (input.pricing?.[key] === undefined) missing.push(`pricing.${key}`)
  if (missing.length) return { adopt: false, reason: 'missing-input', missing }

  const { originalTokens, candidateTokens, invalidatedPrefixTokens, minimumFutureRequests,
    compressionCost, expectedRecoveryCost, safetyMargin, pricing } = input
  if (candidateTokens >= originalTokens) return { adopt: false, reason: 'not-smaller' }
  if (minimumFutureRequests === 0) return { adopt: false, reason: 'no-future-requests' }
  if (pricing.cacheReadPerMillion === 0) return { adopt: false, reason: 'no-cache-read-savings' }

  const removedTokens = originalTokens - candidateTokens
  const rebuildPrice = pricing.cacheWritePerMillion ?? pricing.uncachedInputPerMillion
  const perRequestSavings = removedTokens * (pricing.cacheReadPerMillion / 1e6)
  const grossSavings = perRequestSavings * minimumFutureRequests
  const cacheRebuildCost = invalidatedPrefixTokens * (Math.max(0, rebuildPrice - pricing.cacheReadPerMillion) / 1e6)
  const totalExtraCost = cacheRebuildCost + compressionCost + expectedRecoveryCost
  const safetyReserve = grossSavings * safetyMargin
  const netBenefit = grossSavings - totalExtraCost
  const conservativeNetBenefit = grossSavings - safetyReserve - totalExtraCost
  if (![perRequestSavings, grossSavings, cacheRebuildCost, totalExtraCost, safetyReserve, netBenefit, conservativeNetBenefit].every(Number.isFinite)) {
    return { adopt: false, reason: 'non-finite-estimate' }
  }
  const conservativePerRequest = perRequestSavings * (1 - safetyMargin)
  const threshold = conservativePerRequest > 0 ? Math.floor(totalExtraCost / conservativePerRequest) + 1 : Infinity
  const breakEvenRequests = Number.isSafeInteger(threshold) && threshold > 0 ? threshold : null
  return {
    adopt: conservativeNetBenefit > 0,
    reason: conservativeNetBenefit > 0 ? 'positive-conservative-net-benefit' : 'insufficient-net-benefit',
    removedTokens, minimumFutureRequests, perRequestSavings, grossSavings, cacheRebuildCost,
    compressionCost, expectedRecoveryCost, totalExtraCost, safetyMargin, safetyReserve,
    netBenefit, conservativeNetBenefit, breakEvenRequests,
    rebuildPriceSource: pricing.cacheWritePerMillion === undefined ? 'uncached-input' : 'cache-write',
  }
}
