import assert from 'node:assert/strict'
import test from 'node:test'
import { agentCompletion, evaluateAgent, priceUsage, summarizeUsage } from '../../scripts/evaluate-agent.js'

test('real AgentLoop composes three policies and recovers exact facts through official tools', async () => {
  const report = await evaluateAgent({ replay: true })
  assert.equal(report.completed, true)
  assert.equal(report.tasks.length, 6)
  for (const task of report.tasks) {
    assert.equal(task.exactFacts, true)
    assert.ok(task.steps >= 2 && task.steps <= 8)
    assert.equal(task.usageKind, 'synthetic-replay')
    assert.equal(task.estimatedCostUSD, null)
  }
  const tap = report.tasks.find(task => task.task === 'tap-snapshot' && task.group === 'plugin')
  assert.ok(tap.decisions.some(decision => decision.strategy === 'node-tap-v13' && decision.outcome === 'selected'))
  assert.ok(tap.toolCalls.some(call => call.name === 'read' && call.readSnapshot && !call.isError))
  const tuned = report.tasks.find(task => task.task === 'repeated-json' && task.group === 'baseline-tuned')
  assert.ok(tuned.toolCalls.some(call => call.name === 'read'))
})

test('missing, malformed and overflowing usage cannot become complete zero-cost evidence', () => {
  const known = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 20 }
  assert.equal(summarizeUsage([]).complete, false)
  const partial = summarizeUsage([known, undefined])
  assert.equal(partial.complete, false)
  assert.equal(partial.usage.inputTokens, 10)
  for (const bad of [{}, { inputTokens: -1, outputTokens: 0 }, { inputTokens: 1.5, outputTokens: 0 },
    { inputTokens: 1, outputTokens: NaN }, { ...known, cacheReadTokens: -1 }]) {
    assert.equal(summarizeUsage([bad]).complete, false)
    assert.equal(priceUsage(bad, { currency: 'USD', uncached: .3, cacheRead: .006, output: 1.2, sourceUrl: 'source' }), null)
  }
  assert.equal(summarizeUsage([{ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }, known]).complete, false)
  assert.deepEqual(summarizeUsage([known, known]), { complete: true,
    usage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 40, cacheWriteTokens: 0 } })
})

test('price estimates charge disjoint cache and uncached counts only with explicit provenance', () => {
  const usage = { inputTokens: 1000000, cacheReadTokens: 1000000, outputTokens: 1000000 }
  assert.equal(priceUsage(usage), null)
  assert.equal(priceUsage(usage, { currency: 'USD', uncached: .3, cacheRead: .006, output: 1.2, sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/' }), 1.506)
  assert.equal(priceUsage({ ...usage, cacheWriteTokens: 1 }, { currency: 'USD', uncached: .3, cacheRead: .006, output: 1.2, sourceUrl: 'source' }), null)
})

test('real cost completion requires explicit valid prices and complete cost coverage; replay does not', () => {
  const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 }
  const unpriced = { passed: true, usageComplete: true, usage, pricing: null, estimatedCostUSD: null }
  assert.deepEqual(agentCompletion([unpriced]), {
    qualityComplete: true, usageComplete: true, costComplete: false, completed: false,
  })
  assert.equal(agentCompletion([unpriced], { replay: true }).completed, true)
  const pricing = { currency: 'USD', uncached: .3, cacheRead: .006, output: 1.2, sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/' }
  const priced = { ...unpriced, pricing, estimatedCostUSD: priceUsage(usage, pricing) }
  assert.equal(agentCompletion([priced]).completed, true)
  assert.equal(agentCompletion([priced, unpriced]).completed, false)
  assert.equal(agentCompletion([{ ...priced, usageComplete: false }]).completed, false)
  assert.equal(agentCompletion([{ ...priced, passed: false }]).completed, false)
  assert.equal(agentCompletion([{ ...priced, estimatedCostUSD: null }]).completed, false)
  assert.equal(agentCompletion([{ ...priced, usage: { ...usage, cacheWriteTokens: 1 }, estimatedCostUSD: null }]).completed, false)
  assert.equal(agentCompletion([]).completed, false)
})
