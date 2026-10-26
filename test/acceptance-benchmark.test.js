import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptanceFixtures } from './fixtures/acceptance/tasks.js'
import { acceptanceCriteria, createAcceptancePlan, summarizeAcceptance, evaluateAcceptance } from '../scripts/acceptance-benchmark.js'

test('predeclared diverse manifest is deterministic and balances every task/group position', () => {
  const plan = createAcceptancePlan()
  assert.deepEqual(plan, createAcceptancePlan())
  assert.notEqual(plan.manifestHash, createAcceptancePlan({ seed: 7 }).manifestHash)
  assert.equal(plan.runs.length, acceptanceCriteria.maxRuns)
  for (const task of plan.tasks) for (const group of ['baseline-default', 'baseline-tuned', 'plugin']) {
    const runs = plan.runs.filter(run => run.task === task.id && run.group === group)
    assert.deepEqual(runs.map(run => run.repeat).sort(), [0, 1, 2])
    assert.deepEqual(runs.map(run => run.position).sort(), [0, 1, 2])
  }
  for (const fixture of acceptanceFixtures()) for (const [phase, spec] of (fixture.phases ?? [fixture]).entries()) {
    assert.deepEqual(fixture.answer(fixture.edit && phase ? fixture.editedText : fixture.text, phase), spec.expected)
  }
  assert.throws(() => createAcceptancePlan({ seed: -1 }))
})
const pricing = { currency: 'USD', model: 'model', verifiedDate: '2026-10-26', ratePeriod: 'test', sourceUrl: 'https://example.test/prices', uncached: 1, cacheRead: .1, output: 1 }
const provenance = { runtimeVersion: '0.2.1-rc.2', repositoryCommit: 'a'.repeat(40), sourceTreeHash: 'b'.repeat(64), model: 'model', cacheCondition: acceptanceCriteria.cacheCondition }
function records(plan) {
  return plan.runs.map(run => { const usage = { inputTokens: run.group === 'plugin' ? 10 : 20, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }; return { ...run, manifestHash: plan.manifestHash, passed: true, exactFacts: true, requiredTools: true, fileCorrect: true, snapshotRecovered: true,
    phaseResults: (plan.tasks.find(task => task.id === run.task).phases ?? [plan.tasks.find(task => task.id === run.task)]).map(phase => ({ actual: phase.expected, passed: true })), replay: false, usageKind: 'provider-reported', usageComplete: true, usage, modelCalls: [{ complete: true, provider: 'deepseek-official', model: 'model', usage: { ...usage } }], toolCalls: [0, 1].map(phase => ({ name: 'read', phase, readSnapshot: true, isError: false })), adoptions: [{ callId: 'fixture-call', strategy: run.task === 'experiment-diagnostic-evidence' ? 'diagnostic-evidence-selection-v1' : `${run.task.slice(11)}-prose-selection-v1`, persisted: true, modelVisible: true, contentHash: 'c'.repeat(64), persistedContentHash: 'c'.repeat(64), modelVisibleContentHash: 'c'.repeat(64) }], experiments: [{ callId: 'fixture-call', reason: 'selected', llmCalled: true }] } })
}
test('strict gates reject missing/duplicate runs, mutated task coverage, forged usage and replay monetary claims', () => {
  const plan = createAcceptancePlan()
  const data = records(plan)
  const options = { pricing, provenance }
  assert.equal(summarizeAcceptance(plan, data, options).accepted, true)
  assert.equal(summarizeAcceptance(plan, data.slice(1), options).accepted, false)
  assert.equal(summarizeAcceptance(plan, [data[0], ...data.slice(0, -1)], options).coverageComplete, false)
  const changed = structuredClone(plan); changed.tasks[0].coverage = []
  assert.equal(summarizeAcceptance(changed, data, options).planValid, false)
  assert.equal(summarizeAcceptance(plan, data, { ...options, replay: true }).accepted, false)
  assert.equal(summarizeAcceptance(plan, data, { pricing }).costComplete, false)
  const bad = structuredClone(data); bad[0].usage.inputTokens++
  assert.equal(summarizeAcceptance(plan, bad, options).usageComplete, false)
  const auxiliary = structuredClone(data); auxiliary[0].modelCalls.push({ complete: false, usage: null })
  assert.equal(summarizeAcceptance(plan, auxiliary, options).costComplete, false)
  const noAdoption = data.map(record => ({ ...record, experiments: [{ reason: 'no-predicted-benefit-before-call', llmCalled: false }] }))
  assert.equal(summarizeAcceptance(plan, noAdoption, options).experimentalCoverage, false)
})
test('negative savings, auxiliary costs and cache-write prices are retained', () => {
  const plan = createAcceptancePlan(); const data = records(plan)
  for (const record of data.filter(row => row.group === 'plugin')) {
    const aux = { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1 }
    record.modelCalls.push({ complete: true, provider: 'deepseek-official', model: 'model', usage: aux })
    record.usage = { ...record.usage, inputTokens: 110, cacheWriteTokens: 1 }
  }
  assert.equal(summarizeAcceptance(plan, data, { pricing, provenance }).costComplete, false)
  const report = summarizeAcceptance(plan, data, { pricing: { ...pricing, cacheWrite: 2 }, provenance })
  assert.ok(report.netSavingsVsTunedUSD < 0)
  assert.equal(report.accepted, false)
})
test('runner fails closed with partial checkpoint on unknown usage', async () => {
  const checkpoints = []
  const report = await evaluateAcceptance({ runner: async () => ({ usageComplete: false }), onResult: row => checkpoints.push(row) })
  assert.equal(report.results.length, 1)
  assert.equal(checkpoints.length, 1)
  assert.equal(report.stoppedReason, 'incomplete-cost-accounting')
  assert.equal(report.accepted, false)
})

test('one large win cannot hide negative median task savings', () => {
  const plan = createAcceptancePlan(); const data = records(plan)
  for (const record of data) {
    const inputTokens = record.task === plan.tasks[0].id ? (record.group === 'plugin' ? 1 : 10000) : (record.group === 'plugin' ? 30 : 20)
    record.usage.inputTokens = inputTokens
    record.modelCalls[0].usage.inputTokens = inputTokens
  }
  const report = summarizeAcceptance(plan, data, { pricing, provenance })
  assert.ok(report.netSavingsVsTunedUSD > 0)
  assert.ok(report.medianTaskSavingsVsTunedUSD < 0)
  assert.equal(report.accepted, false)
})
test('live malformed provenance rejects before any runner invocation', async () => {
  let calls = 0
  for (const bad of [undefined, {}, { ...provenance, model: 'wrong' }, { ...provenance, runtimeVersion: 'wrong' }, { ...provenance, sourceTreeHash: 'missing' }]) {
    await assert.rejects(evaluateAcceptance({ replay: false, key: 'test-only', pricing, provenance: bad, runner: async () => { calls++; return { usageComplete: false } } }), /provenance/i)
  }
  assert.equal(calls, 0)
})
test('phase answers cannot be overridden by forged success flags', () => {
  const plan = createAcceptancePlan(); const data = records(plan)
  data[0].phaseResults[0] = { actual: { wrong: true }, passed: true }
  assert.equal(summarizeAcceptance(plan, data, { pricing, provenance }).qualityComplete, false)
})
test('early experiment selected events without persisted model-visible adoption cannot satisfy coverage', () => {
  const plan = createAcceptancePlan(); const data = records(plan)
  for (const record of data) record.adoptions = []
  assert.equal(summarizeAcceptance(plan, data, { pricing, provenance }).experimentalCoverage, false)
})
test('snapshot followup must recover snapshot in each phase, not only first phase', () => {
  const plan = createAcceptancePlan(); const data = records(plan)
  for (const record of data.filter(row => row.task === 'snapshot-followup' && row.group === 'plugin')) record.toolCalls = [
    { name: 'read', phase: 0, readSnapshot: true, isError: false }, { name: 'read', phase: 1, readOriginal: true, isError: false },
  ]
  assert.equal(summarizeAcceptance(plan, data, { pricing, provenance }).qualityComplete, false)
})
