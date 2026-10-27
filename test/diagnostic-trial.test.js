import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { diagnosticTrialFixtures, createDiagnosticTrialPlan, summarizeDiagnosticTrial, evaluateDiagnosticTrial as evaluateRaw } from '../scripts/evaluate-diagnostic-trial.js'

const pricing = { currency: 'USD', model: 'model', verifiedDate: '2026-10-27', ratePeriod: 'test', sourceUrl: 'https://example.test/prices', uncached: 1, cacheRead: .1, cacheWrite: 0, output: 1 }
const provenance = { runtimeVersion: '0.2.1-rc.2', repositoryCommit: 'a'.repeat(40), sourceTreeHash: 'b'.repeat(64), model: 'model', cacheCondition: 'shared-provider-cache-uncontrolled-counterbalanced' }
const options = { pricing, provenance }
// Deliberately synthetic capture for portable accounting unit tests, never live evidence.
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function syntheticCapture() {
  const runs = [
    ['invalid.c', 'int main(void) { return missing_identifier; }\n', 'invalid.c:1:25: error: undeclared identifier\n', 1],
    ['warning.c', 'int main(void) { int unused_local; return 0; }\n', 'warning.c:1:22: warning: unused variable\n', 0],
  ].map(([name, source, stderr, exitCode]) => ({ name, source, sourceHash: digest(source), args: ['-fsyntax-only', '-Wall', '-fno-color-diagnostics', name], stdout: '', stderr, exitCode }))
  const value = { version: 1, compiler: 'synthetic-unit-fixture', compilerVersion: 'synthetic clang unit fixture, not a compiler invocation', runs }
  return { ...value, captureHash: digest(value) }
}
const evaluateDiagnosticTrial = args => evaluateRaw({ controlCapture: syntheticCapture(), onResult() {}, ...args })
const makePlan = overrides => createDiagnosticTrialPlan({ ...options, replay: false, ...overrides })
function records(plan) {
  return plan.runs.map(run => {
    const task = plan.tasks.find(task => task.id === run.task)
    const usage = { inputTokens: run.group === 'plugin' ? 10 : 20, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
    return { ...run, manifestHash: plan.manifestHash, passed: true, exactFacts: true, requiredTools: true, fileCorrect: true, snapshotRecovered: true,
      phaseResults: (task.phases ?? [task]).map(phase => ({ actual: phase.expected, passed: true, freshAnswer: true, turnCompleted: true })), replay: false, usageKind: 'provider-reported', usageComplete: true, usage,
      toolCalls: (task.phases ?? [task]).map((_, phase) => ({ name: 'fixture', phase, isError: false })),
      modelCalls: [{ complete: true, provider: 'deepseek-official', model: 'model', usage: { ...usage } }],
      configuration: { maxInlineTokens: run.group === 'baseline-default' ? 12500 : 1200, nativePolicyInstalledAfterPlugin: true, validationFeedbackLimit: 2 },
      adoptions: [{ callId: 'fixture-call', strategy: 'diagnostic-evidence-selection-v1', persisted: true, modelVisible: true, contentHash: 'c'.repeat(64), persistedContentHash: 'c'.repeat(64), modelVisibleContentHash: 'c'.repeat(64) }], experiments: [{ callId: 'fixture-call', reason: 'selected', llmCalled: true }] }
  })
}

test('diagnostic plan freezes interleaved source, identical prompts and Latin rotations', () => {
  const plan = makePlan()
  assert.deepEqual(plan, makePlan())
  assert.equal(Object.isFrozen(plan.tasks[0].phases), true)
  assert.equal(plan.runs.length, 9)
  for (const group of ['baseline-default', 'baseline-tuned', 'plugin']) {
    const runs = plan.runs.filter(run => run.group === group)
    assert.deepEqual(runs.map(run => run.position).sort(), [0, 1, 2])
    assert.deepEqual(runs.map(run => run.repeat).sort(), [0, 1, 2])
  }
  const fixture = diagnosticTrialFixtures()[0]
  assert.match(fixture.text.split('\n\n')[8], /TS2322/)
  assert.match(fixture.text.split('\n\n')[17], /TS6133/)
  for (const phase of fixture.phases) assert.deepEqual(fixture.answer(fixture.text), phase.expected)
})
test('strict quality, adoption, accounting, provenance and native-composition gates', () => {
  const plan = makePlan()
  assert.equal(summarizeDiagnosticTrial(plan, records(plan), options).accepted, true)
  for (const mutate of [
    rows => rows.pop(), rows => { rows[1] = rows[0] }, rows => { rows[0].phaseResults[0].actual = null },
    rows => { rows[0].usage.inputTokens++ }, rows => { rows[0].modelCalls[0].provider = 'other' },
    rows => { delete rows[0].modelCalls[0].usage.cacheWriteTokens }, rows => { rows[0].modelCalls.push({ complete: false }) },
    rows => rows.forEach(row => { row.adoptions = [] }), rows => { rows[0].configuration.maxInlineTokens = 1 },
  ]) {
    const rows = records(plan); mutate(rows)
    assert.equal(summarizeDiagnosticTrial(plan, rows).accepted, false)
  }
  const changed = structuredClone(plan); changed.tasks[0].text += 'mutated'
  assert.equal(summarizeDiagnosticTrial(changed, records(plan), options).planValid, false)
  assert.equal(summarizeDiagnosticTrial(makePlan({ replay: true }), records(makePlan({ replay: true }))).accepted, false)
  assert.equal(summarizeDiagnosticTrial(plan, records(plan), { pricing: { ...pricing, output: 99999 } }).accepted, true)
})
test('negative candidate savings cannot pass', () => {
  const plan = makePlan(); const rows = records(plan)
  for (const row of rows.filter(row => row.group === 'plugin')) row.modelCalls[0].usage.inputTokens = row.usage.inputTokens = 100
  const report = summarizeDiagnosticTrial(plan, rows, options)
  assert.ok(report.candidate.netSavingsVsTunedUSD < 0)
  assert.equal(report.accepted, false)
})
test('synthetic capture retains source/commands and short-control costs separately', async () => {
  const controlCapture = syntheticCapture()
  const plan = makePlan({ controlCapture })
  assert.equal(plan.runs.length, 18)
  assert.match(controlCapture.runs[0].stderr, /error:/)
  assert.match(controlCapture.runs[1].stderr, /warning:/)
  assert.equal(controlCapture.runs[0].args.at(-1), 'invalid.c')
  const rows = records(plan)
  for (const row of rows.filter(row => row.group === 'plugin' && row.task.includes('control'))) {
    row.modelCalls[0].usage.inputTokens = row.usage.inputTokens = 100
    row.adoptions = []
  }
  const report = summarizeDiagnosticTrial(plan, rows, { ...options, controlCapture })
  assert.equal(report.accepted, true)
  assert.ok(report.control.netSavingsVsTunedUSD < 0)
  assert.ok(report.netSavingsVsTunedUSD < 0)
  assert.equal(summarizeDiagnosticTrial(plan, rows).accepted, true)
  const damaged = structuredClone(controlCapture); damaged.runs[0].stderr += 'noise'
  assert.throws(() => createDiagnosticTrialPlan({ controlCapture: damaged }), /capture/)
})
test('preflight denies missing price/provenance/checkpoint before any calls', async () => {
  let calls = 0
  for (const override of [{ provenance: undefined }, { pricing: { ...pricing, cacheWrite: undefined } }, { onPlan: undefined }]) {
    await assert.rejects(evaluateDiagnosticTrial({ replay: false, key: 'test-only', ...options, onPlan() {}, ...override, runner() { calls++ } }))
  }
  assert.equal(calls, 0)
})
test('plan checkpoint completes before first call; partial unknown usage checkpoint survives', async () => {
  let checkpointed = false
  const saved = []
  const report = await evaluateDiagnosticTrial({ async onPlan(plan) { await Promise.resolve(); assert.ok(Object.isFrozen(plan)); checkpointed = true },
    runner: async (_fixture, _group, config) => { assert.equal(checkpointed, true); assert.equal(config.experimentalConfig.admission, 'measured-trial'); assert.equal(config.experimentalConfig.comparatorTokenCap, 1200); return { usageComplete: false } }, onResult: row => saved.push(row) })
  assert.equal(report.results.length, 1)
  assert.equal(saved.length, 1)
  assert.equal(report.stoppedReason, 'incomplete-cost-accounting')
  assert.equal(report.accepted, false)
})
test('forged known aggregate with mismatched call usage stops before further spending', async () => {
  let plan
  const report = await evaluateDiagnosticTrial({ replay: false, key: 'test-only', ...options, onPlan(value) { plan = value }, runner: async () => {
    const row = records(plan)[0]; row.modelCalls[0].usage.inputTokens++
    return row
  } })
  assert.equal(report.results.length, 1)
  assert.equal(report.stoppedReason, 'incomplete-cost-accounting')
})
test('runner failures are sanitized and retained', async () => {
  const report = await evaluateDiagnosticTrial({ runner: async () => { throw new Error('private provider body') } })
  assert.equal(report.stoppedReason, 'runner-exception')
  assert.equal(report.results.length, 1)
  assert.equal(JSON.stringify(report).includes('private provider body'), false)
})
test('observed overspend fails acceptance and stops the next task', async () => {
  let plan
  const report = await evaluateDiagnosticTrial({ replay: false, key: 'test-only', ...options, onPlan(value) { plan = value }, runner: async () => {
    const row = records(plan)[0]; row.usage.inputTokens = row.modelCalls[0].usage.inputTokens = 200000
    return row
  } })
  assert.equal(report.results.length, 1)
  assert.equal(report.stoppedReason, 'budget')
  assert.equal(report.budgetComplete, false)
})

test('each phase requires a fresh successful fixture call', () => {
  const plan = makePlan(); const rows = records(plan)
  rows[0].toolCalls = rows[0].toolCalls.filter(call => call.phase === 0)
  assert.equal(summarizeDiagnosticTrial(plan, rows).accepted, false)
})
test('one large paired win cannot hide two paired losses', () => {
  const plan = makePlan(); const rows = records(plan)
  for (const row of rows.filter(row => row.group === 'plugin')) row.usage.inputTokens = row.modelCalls[0].usage.inputTokens = row.repeat === 0 ? 1 : 25
  const report = summarizeDiagnosticTrial(plan, rows)
  assert.ok(report.candidate.netSavingsVsTunedUSD > 0)
  assert.equal(report.pairedRepeatSavings.length, 3)
  assert.ok(report.medianPairedRepeatSavingsUSD < 0)
  assert.equal(report.accepted, false)
})
test('live journal is mandatory before runner invocation', async () => {
  let calls = 0
  await assert.rejects(evaluateDiagnosticTrial({ replay: false, key: 'unit-only', ...options, onPlan() {}, onResult: undefined, runner() { calls++ } }), /onResult/)
  assert.equal(calls, 0)
})
test('callbacks cannot change frozen execution prices, provenance, encoding or model', async () => {
  const localPrices = { ...pricing }; const localProvenance = { ...provenance }
  let manifest
  let calls = 0
  const report = await evaluateDiagnosticTrial({ replay: false, key: 'unit-only', pricing: localPrices, provenance: localProvenance,
    onPlan(plan) {
      manifest = plan
      localPrices.model = 'mutated'; localPrices.output = 999
      localProvenance.model = 'mutated'
      assert.equal(Object.isFrozen(plan.experimentalConfig.pricing), true)
      assert.throws(() => { plan.experimentalConfig.pricing.outputPerMillion = 999 })
      assert.throws(() => { plan.pricing.output = 999 })
    },
    runner(_fixture, _group, config) {
      assert.equal(config.model, 'model'); assert.equal(config.prices.output, 1)
      assert.equal(config.experimentalConfig.promptEncoding, 'plain')
      assert.equal(config.experimentalConfig.pricing.outputPerMillion, 1)
      assert.equal(config.experimentalConfig.maxInFlight, 4)
      return records(manifest)[calls++]
    },
    onResult(record) {
      localPrices.uncached = 99999
      localProvenance.sourceTreeHash = 'mutated'
      assert.throws(() => { record.usage.inputTokens = 99999 })
    },
  })
  assert.equal(calls, 18)
  assert.equal(report.stoppedReason, null)
  assert.equal(report.accepted, true)
  assert.equal(report.pricing.model, 'model')
  assert.equal(report.provenance.model, 'model')
  assert.equal(report.plan, manifest)
  assert.notEqual(makePlan({ promptEncoding: 'auto' }).manifestHash, makePlan().manifestHash)
})
