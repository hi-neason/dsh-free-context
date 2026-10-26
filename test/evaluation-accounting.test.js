import test from 'node:test'
import assert from 'node:assert/strict'
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
