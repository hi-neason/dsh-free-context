import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptanceFixtures } from '../fixtures/acceptance/tasks.js'
import { acceptanceReplayAdapter } from '../../scripts/acceptance-benchmark.js'
import { runAgentFixture } from '../../scripts/evaluate-agent.js'

test('diverse fixtures run real AgentLoop with official edit/read/PTC and model-call ledger', { timeout: 90000 }, async () => {
  for (const fixture of acceptanceFixtures()) {
    const result = await runAgentFixture(fixture, 'plugin', { replay: true, adapterFactory: acceptanceReplayAdapter, maxSteps: 12 })
    assert.equal(result.passed, true, JSON.stringify({ fixture: fixture.id, ...result }))
    assert.equal(result.usageComplete, true)
    assert.equal(result.usage.inputTokens, result.modelCalls.length * 10)
    assert.equal(result.estimatedCostUSD, null)
    if (fixture.edit) assert.equal(result.fileCorrect, true)
    if (fixture.ptc) assert.ok(result.toolCalls.some(call => call.name === 'run_code' && !call.isError))
    if (fixture.requireSnapshot) assert.ok(result.recoveryCalls >= 2)
  }
})

test('all-call ledger includes auxiliary model usage once, including a declined selection', async () => {
  const fixture = acceptanceFixtures().find(task => task.experiment === 'task-independent')
  const result = await runAgentFixture(fixture, 'plugin', { replay: true, adapterFactory: acceptanceReplayAdapter, maxSteps: 12,
    // Deliberately generous protocol-test assumptions, never used by the acceptance manifest.
    experimentalConfig: { mode: 'apply', selectionMode: 'task-independent', tools: ['fixture'], provider: 'replay', model: 'acceptance-selector-replay', maxInputBytes: 100000, maxPromptBytes: 120000, maxOutputBytes: 2000, maxOutputTokens: 400, maxArtifactBytes: 160000, timeoutMs: 30000, maxParagraphs: 100,
      minimumFutureRequests: 1, expectedRecoveryCost: 0, safetyMargin: .25, maxCallCost: 1, futureCacheReadPerMillion: 100,
      pricing: { currency: 'USD', uncachedInputPerMillion: .3, cacheReadPerMillion: .006, outputPerMillion: 1.2 }, maxCacheEntries: 8 } })
  assert.ok(result.experiments.some(record => record.llmCalled))
  assert.ok(result.modelCalls.some(call => call.model === 'acceptance-selector-replay'))
  assert.equal(result.usageComplete, true)
  assert.equal(result.usage.inputTokens, result.modelCalls.length * 10)
  assert.equal(result.estimatedCostUSD, null)
})

const admission = selectionMode => ({ mode: 'apply', selectionMode, tools: ['fixture'], provider: 'replay', model: 'acceptance-selector-replay', maxInputBytes: 100000, maxPromptBytes: 120000, maxOutputBytes: 2000, maxOutputTokens: 400, maxArtifactBytes: 160000, timeoutMs: 30000, maxParagraphs: 100, maxQueryBytes: 4096,
  minimumFutureRequests: 1, expectedRecoveryCost: 0, safetyMargin: .25, maxCallCost: 1, futureCacheReadPerMillion: 100,
  pricing: { currency: 'USD', uncachedInputPerMillion: .3, cacheReadPerMillion: .006, outputPerMillion: 1.2 }, maxCacheEntries: 8 })
test('adoption ledger requires persisted transformed content in an actual later model request', async () => {
  const fixture = acceptanceFixtures().find(task => task.experiment === 'task-independent')
  const result = await runAgentFixture(fixture, 'plugin', { replay: true, adapterFactory: acceptanceReplayAdapter, maxSteps: 12, experimentalConfig: admission('task-independent') })
  assert.ok(result.adoptions.some(adoption => adoption.persisted && adoption.modelVisible && adoption.strategy === 'task-independent-prose-selection-v1'))
  for (const adoption of result.adoptions.filter(item => item.modelVisible)) {
    assert.equal(adoption.persistedContentHash, adoption.modelVisibleContentHash)
    assert.ok(result.experiments.some(record => record.callId === adoption.callId && record.reason === 'selected'))
  }
})
test('diagnostic observer timeout or final query change cannot count early selected event as adoption', async () => {
  for (const fault of ['timeout', 'query-change']) {
    const mode = fault === 'timeout' ? 'task-independent' : 'query-dependent'
    const fixture = acceptanceFixtures().find(task => task.experiment === mode)
    const result = await runAgentFixture(fixture, 'plugin', { replay: true, adapterFactory: acceptanceReplayAdapter, maxSteps: 12, experimentalConfig: admission(mode), configureContext(ctx) {
      let query = fixture.phases[0].query
      if (fault === 'query-change') ctx.get('freeContextQuery').getQuery = () => query
      ctx.on('free-context/decision', async record => {
        if (record.outcome !== 'selected' || !record.strategy?.includes('prose-selection')) return
        if (fault === 'timeout') await new Promise(resolve => setTimeout(resolve, 1100))
        else query += ' changed after selection'
      })
    } })
    assert.ok(result.experiments.some(record => record.reason === 'selected'), fault)
    assert.deepEqual(result.adoptions, [], fault)
    assert.ok(result.modelCalls.some(call => call.model === 'acceptance-selector-replay'), 'declined usage still counted')
  }
})
test('correct followup facts read from original file instead of snapshot fail recovery requirement', async () => {
  const fixture = acceptanceFixtures().find(task => task.id === 'snapshot-followup')
  const result = await runAgentFixture(fixture, 'plugin', { replay: true, maxSteps: 12,
    adapterFactory: options => acceptanceReplayAdapter({ ...options, snapshotPath: () => options.phase() === 1 ? undefined : options.snapshotPath() }) })
  assert.equal(result.exactFacts, true)
  assert.equal(result.snapshotRecoveryByPhase[0].recovered, true)
  assert.equal(result.snapshotRecoveryByPhase[1].recovered, false)
  assert.equal(result.snapshotRecovered, false)
  assert.equal(result.passed, false)
})
