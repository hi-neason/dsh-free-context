import test from 'node:test'
import assert from 'node:assert/strict'
import { price, validEvaluationPricing } from '../scripts/acceptance-benchmark.js'
import { createHash } from 'node:crypto'
import { summarizeUsage, priceUsage, safeFailure } from '../scripts/evaluation-accounting.js'

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


test('provider failure metadata is strictly whitelisted and request identifiers are hash-only', () => {
  const codes = { TRANSPORT: 'transport', TIMEOUT: 'timeout', ABORTED: 'timeout', AUTH: 'auth', QUOTA: 'quota', RATE_LIMIT: 'rate-limit', SERVER: 'server', INVALID_REQUEST: 'request' }
  const secret = 'secret-body-header-request\nID 中文'
  for (const [code, category] of Object.entries(codes)) {
    const failure = { code, status: 429, requestId: secret, message: secret, body: secret, headers: { authorization: secret } }
    Object.defineProperty(failure, 'cause', { get() { assert.fail('Unpublished cause must not be read') } })
    const result = safeFailure(failure)
    assert.deepEqual(result, { category, code, status: 429, requestIdHash: createHash('sha256').update(secret).digest('hex') })
    assert.equal(JSON.stringify(result).includes(secret), false)
  }
  for (const requestId of ['', null, { body: secret }, ['private'], 'private'.repeat(1000)]) {
    assert.deepEqual(safeFailure({ code: secret, name: secret, requestId, status: '503', message: secret }), { category: 'unknown' })
  }
  for (const status of [0, 99, 600, 503.5, Infinity, NaN]) assert.deepEqual(safeFailure({ status }), { category: 'unknown' })
  assert.deepEqual(safeFailure({ code: { toString() { assert.fail('Arbitrary code must not be coerced') } } }), { category: 'unknown' })
})
