import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessNetBenefit } from 'dsh-free-context/economics'

const scenario = overrides => ({
  originalTokens: 20000, candidateTokens: 10000, invalidatedPrefixTokens: 1000,
  minimumFutureRequests: 20, pricing: { uncachedInputPerMillion: 10, cacheReadPerMillion: 2 },
  compressionCost: 0.02, expectedRecoveryCost: 0.01, safetyMargin: 0.25,
  ...overrides,
})
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`)

test('positive decision uses cached baseline, one incremental rebuild and explicit extra costs', () => {
  const result = assessNetBenefit(scenario())
  assert.equal(result.adopt, true)
  close(result.grossSavings, 0.4)
  close(result.cacheRebuildCost, 0.008)
  close(result.totalExtraCost, 0.038)
  close(result.safetyReserve, 0.1)
  close(result.netBenefit, 0.362)
  close(result.conservativeNetBenefit, 0.262)
  assert.equal(result.breakEvenRequests, 3)
  assert.equal(result.rebuildPriceSource, 'uncached-input')
})

test('large cache rebuild and additional calls can each outweigh savings', () => {
  for (const overrides of [{ invalidatedPrefixTokens: 1000000 }, { compressionCost: 1 }, { expectedRecoveryCost: 1 }]) {
    const result = assessNetBenefit(scenario(overrides))
    assert.equal(result.adopt, false)
    assert.equal(result.reason, 'insufficient-net-benefit')
  }
})

test('write price replaces uncached price and only its nonnegative read-price difference is charged', () => {
  const result = assessNetBenefit(scenario({ pricing: { uncachedInputPerMillion: 1000, cacheReadPerMillion: 2, cacheWritePerMillion: 5 } }))
  close(result.cacheRebuildCost, 0.003)
  assert.equal(result.rebuildPriceSource, 'cache-write')
  const free = assessNetBenefit(scenario({ pricing: { uncachedInputPerMillion: 1000, cacheReadPerMillion: 2, cacheWritePerMillion: 1 } }))
  assert.equal(free.cacheRebuildCost, 0)
})

test('missing prices or forecasts decline without inventing defaults', () => {
  assert.equal(assessNetBenefit().reason, 'missing-input')
  for (const field of ['originalTokens', 'candidateTokens', 'invalidatedPrefixTokens', 'minimumFutureRequests', 'compressionCost', 'expectedRecoveryCost', 'safetyMargin']) {
    const input = scenario()
    delete input[field]
    assert.deepEqual(assessNetBenefit(input), { adopt: false, reason: 'missing-input', missing: [field] })
  }
  for (const field of ['cacheReadPerMillion', 'uncachedInputPerMillion']) {
    const input = scenario()
    delete input.pricing[field]
    assert.deepEqual(assessNetBenefit(input).missing, [`pricing.${field}`])
  }
})

test('no size reduction, no future requests or free cached reads cannot create savings', () => {
  assert.equal(assessNetBenefit(scenario({ candidateTokens: 20000 })).reason, 'not-smaller')
  assert.equal(assessNetBenefit(scenario({ candidateTokens: 30000 })).reason, 'not-smaller')
  assert.equal(assessNetBenefit(scenario({ minimumFutureRequests: 0 })).reason, 'no-future-requests')
  assert.equal(assessNetBenefit(scenario({ pricing: { uncachedInputPerMillion: 1, cacheReadPerMillion: 0 } })).reason, 'no-cache-read-savings')
})

test('per-million units, strict zero-net boundary and safety reserve are explicit', () => {
  const input = scenario({ originalTokens: 1000000, candidateTokens: 0, invalidatedPrefixTokens: 0,
    minimumFutureRequests: 1, pricing: { uncachedInputPerMillion: 8, cacheReadPerMillion: 4 },
    compressionCost: 3, expectedRecoveryCost: 0, safetyMargin: 0.25 })
  const result = assessNetBenefit(input)
  assert.equal(result.grossSavings, 4)
  assert.equal(result.conservativeNetBenefit, 0)
  assert.equal(result.adopt, false)
  assert.equal(result.breakEvenRequests, 2)
  assert.equal(assessNetBenefit({ ...input, safetyMargin: 0 }).adopt, true)
})

test('rejects malformed provided numbers and objects even when other inputs are missing', () => {
  for (const field of ['originalTokens', 'candidateTokens', 'invalidatedPrefixTokens', 'minimumFutureRequests']) {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) assert.throws(() => assessNetBenefit({ [field]: value }), TypeError)
  }
  for (const field of ['compressionCost', 'expectedRecoveryCost', 'safetyMargin']) {
    for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) assert.throws(() => assessNetBenefit({ [field]: value }), TypeError)
  }
  for (const field of ['uncachedInputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion']) {
    for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) assert.throws(() => assessNetBenefit({ pricing: { [field]: value } }), TypeError)
  }
  for (const value of [null, [], true]) assert.throws(() => assessNetBenefit(value), TypeError)
  assert.throws(() => assessNetBenefit({ pricing: [] }), TypeError)
  assert.throws(() => assessNetBenefit({ safetyMargin: 1 }), TypeError)
})

test('unsafe magnitudes are rejected and underflow never creates a false benefit', () => {
  assert.throws(() => assessNetBenefit(scenario({ pricing: { uncachedInputPerMillion: 1e308, cacheReadPerMillion: 1e308 } })), TypeError)
  const huge = assessNetBenefit(scenario({ originalTokens: Number.MAX_SAFE_INTEGER, minimumFutureRequests: Number.MAX_SAFE_INTEGER }))
  assert.ok(Number.isFinite(huge.conservativeNetBenefit))
  const tiny = assessNetBenefit(scenario({ pricing: { uncachedInputPerMillion: 1, cacheReadPerMillion: Number.MIN_VALUE } }))
  assert.equal(tiny.adopt, false)
  assert.equal(tiny.breakEvenRequests, null)
})

test('does not mutate input and scales consistently when all cost units change together', () => {
  const input = scenario()
  const before = structuredClone(input)
  const result = assessNetBenefit(input)
  assert.deepEqual(input, before)
  const scaled = assessNetBenefit({ ...input, pricing: { uncachedInputPerMillion: 10000, cacheReadPerMillion: 2000 }, compressionCost: 20, expectedRecoveryCost: 10 })
  assert.equal(scaled.adopt, result.adopt)
  assert.equal(scaled.breakEvenRequests, result.breakEvenRequests)
  close(scaled.conservativeNetBenefit, result.conservativeNetBenefit * 1000)
})

test('forecast calibration uses comparable complete independent runs and a conservative cap', async () => {
  const { calibrateRequestForecast } = await import('dsh-free-context/economics')
  const observations = [2, 200, 3].map((remainingRequests, index) => ({
    runId: `run-${index}`, scope: 'flash/tap', usageKind: 'provider-reported', usageComplete: true,
    qualityPassed: true, remainingRequests, recoveryCost: index / 1000,
  }))
  const result = calibrateRequestForecast(observations, { scope: 'flash/tap', maximumRequests: 8 })
  assert.equal(result.status, 'calibrated')
  assert.equal(result.minimumFutureRequests, 2)
  assert.equal(result.expectedRecoveryCost, 0.002)
  assert.equal(result.sampleCount, 3)
  const long = observations.map(item => ({ ...item, remainingRequests: 200 }))
  assert.equal(calibrateRequestForecast(long, { scope: 'flash/tap', maximumRequests: 8 }).minimumFutureRequests, 8)
  assert.equal(calibrateRequestForecast(observations.slice(0, 2), { scope: 'flash/tap' }).reason, 'insufficient-observations')
  assert.deepEqual(observations.map(item => item.remainingRequests), [2, 200, 3])
})

test('calibration rejects synthetic, duplicated, mismatched, failed and incomplete observations', async () => {
  const { calibrateRequestForecast } = await import('dsh-free-context/economics')
  const observation = { runId: 'run', scope: 'flash/tap', usageKind: 'provider-reported', usageComplete: true,
    qualityPassed: true, remainingRequests: 2, recoveryCost: 0.0001 }
  for (const change of [{ usageKind: 'synthetic-replay' }, { usageComplete: false }, { qualityPassed: false },
    { scope: 'another-model/tap' }, { remainingRequests: -1 }, { recoveryCost: undefined }]) {
    const records = [0, 1, 2].map(index => ({ ...observation, runId: `run-${index}` }))
    Object.assign(records[1], change)
    assert.equal(calibrateRequestForecast(records, { scope: observation.scope }).status, 'declined')
  }
  assert.equal(calibrateRequestForecast(Array(3).fill(observation), { scope: observation.scope }).reason, 'duplicate-run')
  assert.equal(calibrateRequestForecast([], { scope: observation.scope }).status, 'declined')
  assert.throws(() => calibrateRequestForecast([], { scope: observation.scope, minimumSamples: 1 }), TypeError)
})

test('calibrated two-request horizon rejects the historical 200-request optimistic decision', async () => {
  const { calibrateRequestForecast } = await import('dsh-free-context/economics')
  const records = Array.from({ length: 3 }, (_, index) => ({ runId: `r${index}`, scope: 'flash/tap',
    usageKind: 'provider-reported', usageComplete: true, qualityPassed: true, remainingRequests: 2, recoveryCost: 0.0001 }))
  const forecast = calibrateRequestForecast(records, { scope: 'flash/tap' })
  const input = scenario({ originalTokens: 10000, candidateTokens: 1000, invalidatedPrefixTokens: 20000,
    minimumFutureRequests: 200, pricing: { uncachedInputPerMillion: .3, cacheReadPerMillion: .006 },
    compressionCost: 0, expectedRecoveryCost: 0, safetyMargin: .25 })
  assert.equal(assessNetBenefit(input).adopt, true)
  assert.equal(assessNetBenefit({ ...input, minimumFutureRequests: forecast.minimumFutureRequests,
    expectedRecoveryCost: forecast.expectedRecoveryCost }).adopt, false)
})
