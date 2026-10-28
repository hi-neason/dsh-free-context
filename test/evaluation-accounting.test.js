import test from 'node:test'
import assert from 'node:assert/strict'
import { price, validEvaluationPricing } from '../scripts/acceptance-benchmark.js'
import { summarizeUsage, priceUsage } from '../scripts/evaluation-accounting.js'

test('pure accounting keeps known usage but never labels missing calls complete or free', () => {
  const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 }
  const partial = summarizeUsage([usage, undefined])
  assert.equal(partial.complete, false)
  assert.equal(partial.usage.inputTokens, 100)
  assert.equal(summarizeUsage([]).complete, false)
  assert.equal(summarizeUsage([usage, usage]).usage.cacheReadTokens, 100)
})
test('prices disjoint counts once and refuses absent prices or unpriced cache writes', () => {
  const prices = { currency: 'USD', uncached: .3, cacheRead: .006, output: 1.2, sourceUrl: 'https://example.test/prices' }
  const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 }
  assert.equal(priceUsage(usage, prices), (100 * .3 + 10 * 1.2 + 50 * .006) / 1e6)
  assert.equal(priceUsage(usage), null)
  assert.equal(priceUsage({ ...usage, cacheWriteTokens: 1 }, prices), null)
})


test('an explicit unquoted-write policy preserves pricing and rejects every nonzero write', () => {
  const prices = { currency: 'USD', model: 'model', verifiedDate: '2026-10-28', ratePeriod: 'test',
    uncached: .3, cacheRead: .006, output: 1.2, sourceUrl: 'https://example.test/prices', cacheWritePolicy: 'reject-nonzero' }
  assert.equal(validEvaluationPricing(prices), true)
  const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0 }
  assert.equal(price(usage, prices), priceUsage(usage, prices))
  assert.ok(priceUsage(usage, prices) > 0)
  assert.equal(price({ ...usage, cacheWriteTokens: 1 }, prices), null)
  assert.equal(priceUsage({ ...usage, cacheWriteTokens: 1 }, prices), null)
  assert.equal(priceUsage({ ...usage, cacheWriteTokens: 1000000 }, prices), null)
  assert.equal(Object.hasOwn(prices, 'cacheWrite'), false)
  assert.equal(validEvaluationPricing({ ...prices, cacheWritePolicy: undefined }), false)
  assert.equal(validEvaluationPricing({ ...prices, uncached: undefined }), false)
})
