import test from 'node:test'
import assert from 'node:assert/strict'
import { createAcceptancePlanV2 } from '../scripts/acceptance-benchmark-v2.js'
import { createAcceptancePlanV3, summarizeAcceptanceV3, evaluateAcceptanceV3, experimentalConfigV3, acceptanceReplayAdapterV3, originalAcceptanceV3 } from '../scripts/acceptance-benchmark-v3.js'
import { acceptanceFixturesV2 } from './fixtures/acceptance/tasks-v2.js'
import { acceptanceFixturesV3 } from './fixtures/acceptance/tasks-v3.js'

// Synthetic ledger contract tests: no real provider or savings evidence.
const pricing = { currency: 'USD', model: 'model', verifiedDate: '2026-10-27', ratePeriod: 'test', sourceUrl: 'https://example.test/prices', uncached: 1, cacheRead: .1, cacheWrite: 0, output: 1 }
const provenance = { runtimeVersion: '0.2.1-rc.2', repositoryCommit: 'a'.repeat(40), sourceTreeHash: 'b'.repeat(64), model: 'model', cacheCondition: 'shared-provider-cache-uncontrolled-counterbalanced' }
const options = { pricing, provenance }
function records(plan) {
  return plan.runs.map(run => {
    const fixture = plan.tasks.find(task => task.id === run.task)
    const usage = { inputTokens: run.group === 'plugin' ? 50 : 100, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
    return { ...run, manifestHash: plan.manifestHash, passed: true, exactFacts: true, requiredTools: true, fileCorrect: true, snapshotRecovered: true,
      responseContractSatisfied: true, phaseResults: (fixture.phases ?? [fixture]).map(phase => ({ actual: phase.expected, passed: true, freshAnswer: true, turnCompleted: true })),
      turnEnds: [{ kind: 'completed' }], replay: false, usageKind: 'provider-reported', usageComplete: true, usage,
      modelCalls: [{ kind: 'agent', complete: true, provider: 'deepseek-official', model: 'model', usage: { ...usage } }],
      configuration: { maxInlineTokens: run.group === 'baseline-default' ? 12500 : 1200, plugin: run.group === 'plugin', nativePolicyInstalledAfterPlugin: true,
        validationFeedbackLimit: 2, maxSteps: 12, timeoutMs: 120000 },
      requestedProtocol: { requireFixtureEachPhase: fixture.requireFixtureEachPhase === true, rejectPlaceholderValues: fixture.rejectPlaceholderValues === true,
        experimentalConfig: experimentalConfigV3(fixture, options) ?? null },
      retirements: [{ reason: fixture.expectedRetirement ? 'retired' : 'economic-gate', economics: { adopt: false } }],
      toolCalls: [0, 1].flatMap(phase => [{ name: fixture.ptc ? 'run_code' : 'fixture', phase, isError: false }, { name: 'read', phase, readSnapshot: true, isError: false }]),
      adoptions: [{ callId: 'fixture-call', strategy: fixture.experiment === 'diagnostic-evidence' ? 'diagnostic-evidence-selection-v1' : `${fixture.experiment}-prose-selection-v1`,
        persisted: true, modelVisible: true, contentHash: 'c'.repeat(64), persistedContentHash: 'c'.repeat(64), modelVisibleContentHash: 'c'.repeat(64) }],
      experiments: [{ callId: 'fixture-call', reason: 'selected', llmCalled: true }, { reason: fixture.expectedFallback }] }
  })
}
const selected = (rows, task = 'experiment-query-dependent') => rows.find(row => row.task === task && row.group === 'plugin')

test('v3 keeps all v2 tasks and balanced schedule with a separate canonical manifest', () => {
  const previous = createAcceptancePlanV2()
  assert.equal(previous.manifestHash, '5e220ecd0d2b156fa9b02cfc0e927ea74bbb767eaa991739adefb25b20e30bcd')
  const plan = createAcceptancePlanV3()
  assert.equal(plan.version, 3)
  assert.equal(plan.tasks.length, 13)
  assert.equal(plan.runs.length, 117)
  assert.deepEqual(plan.runs, previous.runs)
  assert.deepEqual(plan, createAcceptancePlanV3())
  assert.notEqual(plan.manifestHash, previous.manifestHash)
  assert.notEqual(plan.manifestHash, createAcceptancePlanV3({ seed: 1 }).manifestHash)
  assert.throws(() => createAcceptancePlanV3({ seed: -1 }), /seed/)
  for (const task of plan.tasks) for (const group of ['baseline-default', 'baseline-tuned', 'plugin']) {
    assert.deepEqual(plan.runs.filter(run => run.task === task.id && run.group === group).map(run => run.position).sort(), [0, 1, 2])
  }
  assert.deepEqual(createAcceptancePlanV2(), previous)
})

test('only the three adopted experiment fixtures receive prospective source and answer contracts', () => {
  const previous = acceptanceFixturesV2()
  for (const fixture of acceptanceFixturesV3()) {
    const old = previous.find(task => task.id === fixture.id)
    if (!fixture.experiment || fixture.adoptionRequired === false) {
      const { answer, ...spec } = fixture
      const { answer: oldAnswer, ...oldSpec } = old
      assert.deepEqual(spec, oldSpec)
    } else {
      assert.equal(fixture.requireFixtureEachPhase, true)
      assert.equal(fixture.rejectPlaceholderValues, fixture.experiment !== 'diagnostic-evidence')
      assert.deepEqual(fixture.phases.map(phase => phase.expected), old.phases.map(phase => phase.expected))
      for (const [index, phase] of fixture.phases.entries()) assert.ok(phase.query.startsWith(old.phases[index].query))
      if (fixture.experiment === 'diagnostic-evidence') assert.ok(fixture.text.indexOf('src/alpha.ts') < fixture.text.indexOf('INFO build stage 8:'))
      else assert.equal(fixture.text, old.text)
    }
    for (const [index, phase] of (fixture.phases ?? [fixture]).entries()) assert.deepEqual(fixture.answer(fixture.edit && index ? fixture.editedText : fixture.text, index), phase.expected)
  }
})

test('all synthetic gates pass only together and replay never certifies money', () => {
  const plan = createAcceptancePlanV3()
  const data = records(plan)
  const result = summarizeAcceptanceV3(plan, data, options)
  assert.equal(result.fullAccepted, true)
  assert.equal(result.modes.length, 3)
  assert.ok(result.modes.every(mode => mode.accepted && mode.medianPairedSavingsUSD > 0))
  assert.equal(summarizeAcceptanceV3(plan, data, { ...options, replay: true }).accepted, false)
  assert.equal(summarizeAcceptanceV3(plan, data, { pricing }).costComplete, false)
})

test('original v3 acceptance recomputes its versioned benchmark and still requires calibration', () => {
  const plan = createAcceptancePlanV3()
  const report = { evaluationKind: 'acceptance-v3-live-provider', plan, results: records(plan), pricing, provenance }
  const result = originalAcceptanceV3(report)
  assert.equal(result.benchmarkAccepted, true)
  assert.equal(result.calibrationEvidenceComplete, false)
  assert.equal(result.accepted, false)
  assert.equal(originalAcceptanceV3({ ...report, evaluationKind: 'acceptance-v2-live-provider', fullAccepted: true }).benchmarkAccepted, false)
  assert.equal(originalAcceptanceV3({ evaluationKind: 'acceptance-v3-live-provider', fullAccepted: true }).benchmarkAccepted, false)
  const forged = structuredClone(report)
  forged.fullAccepted = true
  selected(forged.results).adoptions = []
  assert.equal(originalAcceptanceV3(forged).benchmarkAccepted, false)
})

test('missing, duplicate, altered-plan and old-protocol evidence cannot pass', () => {
  const plan = createAcceptancePlanV3()
  const data = records(plan)
  assert.equal(summarizeAcceptanceV3(plan, data.slice(1), options).accepted, false)
  assert.equal(summarizeAcceptanceV3(plan, [data[0], ...data.slice(0, -1)], options).coverageComplete, false)
  const changed = structuredClone(plan)
  changed.tasks.find(task => task.id === 'experiment-query-dependent').rejectPlaceholderValues = false
  assert.equal(summarizeAcceptanceV3(changed, data, options).planValid, false)
  const badConfig = structuredClone(plan)
  badConfig.experimentSettings.maxOutputTokens = 400
  assert.equal(summarizeAcceptanceV3(badConfig, data, options).accepted, false)
  assert.equal(summarizeAcceptanceV3(createAcceptancePlanV2(), data, options).accepted, false)
})

test('one mode with negative paired median fails despite positive sums everywhere', () => {
  const plan = createAcceptancePlanV3()
  const data = records(plan)
  for (const row of data.filter(row => row.task === 'experiment-query-dependent')) {
    const tokens = row.group === 'plugin' ? [300, 300, 1][row.repeat] : [200, 200, 1000][row.repeat]
    row.usage.inputTokens = tokens
    row.modelCalls[0].usage.inputTokens = tokens
  }
  const result = summarizeAcceptanceV3(plan, data, options)
  const mode = result.modes.find(mode => mode.mode === 'query-dependent')
  assert.ok(result.experimental.netSavingsVsTunedUSD > 0)
  assert.ok(mode.netSavingsVsTunedUSD > 0)
  assert.ok(mode.medianPairedSavingsUSD < 0)
  assert.equal(result.experimentalModesAccepted, false)
  assert.equal(result.accepted, false)
})

test('per-mode quality, actual adoption and protocol settings are required despite success flags', () => {
  const plan = createAcceptancePlanV3()
  for (const mutate of [
    row => { row.phaseResults[0].actual = { owner: 'UNKNOWN' } },
    row => { row.responseContractSatisfied = false },
    row => { row.adoptions[0].modelVisible = false },
    row => { row.adoptions[0].persistedContentHash = 'd'.repeat(64) },
    row => { row.requestedProtocol.rejectPlaceholderValues = false },
    row => { row.requestedProtocol.experimentalConfig.admission = 'net-benefit' },
    row => { row.requestedProtocol.experimentalConfig.maxOutputTokens = 400 },
    row => { row.configuration.maxInlineTokens = 12500 },
    row => { row.configuration.validationFeedbackLimit = 1 },
    row => { row.configuration.maxSteps = 13 },
    row => { row.configuration.timeoutMs = 130000 },
    row => { row.toolCalls = row.toolCalls.filter(call => call.phase === 0) },
  ]) {
    const data = records(plan)
    mutate(selected(data))
    assert.equal(summarizeAcceptanceV3(plan, data, options).accepted, false)
  }
})

test('unknown auxiliary costs, ledger mismatches and overall budget overshoot fail closed', () => {
  const plan = createAcceptancePlanV3()
  for (const mutate of [
    row => { row.modelCalls.push({ kind: 'auxiliary', complete: false, usage: null }) },
    row => { row.modelCalls[0].usage.inputTokens++ },
    row => { row.usage.inputTokens = 2000000; row.modelCalls[0].usage.inputTokens = 2000000 },
  ]) {
    const data = records(plan)
    mutate(data.find(row => row.group === 'baseline-default'))
    assert.equal(summarizeAcceptanceV3(plan, data, options).accepted, false)
  }
})

test('fallback, stress and conservative lifecycle rejection remain mandatory', () => {
  const plan = createAcceptancePlanV3()
  for (const [task, mutate] of [
    ['experiment-diagnostic-tap-fallback', row => { row.experiments = [] }],
    ['history-retirement-stress', row => { row.retirements = [] }],
    ['history-retirement-short', row => { row.retirements[0].reason = 'retired' }],
  ]) {
    const data = records(plan)
    mutate(selected(data, task))
    assert.equal(summarizeAcceptanceV3(plan, data, options).accepted, false)
  }
})

test('runner preflight, partial checkpoints and safe failures prevent unpriced continuation', async () => {
  let calls = 0
  await assert.rejects(evaluateAcceptanceV3({ replay: false, key: 'test', runner() { calls++ } }), /provenance/)
  assert.equal(calls, 0)
  const checkpoints = []
  const report = await evaluateAcceptanceV3({ runner() { throw { code: 'EACCES', message: 'private provider text' } }, onResult: row => checkpoints.push(row) })
  assert.equal(report.stoppedReason, 'runner-exception')
  assert.equal(report.results.length, 1)
  assert.equal(checkpoints.length, 1)
  assert.equal(JSON.stringify(report).includes('private provider text'), false)
  assert.equal(report.accepted, false)
})

test('runner passes declared experiment configuration and same limits to all 117 tasks', async () => {
  const plan = createAcceptancePlanV3()
  const data = records(plan)
  let index = 0
  const report = await evaluateAcceptanceV3({ replay: false, key: 'synthetic-only', ...options,
    onPlan() {}, onResult() {},
    runner: async (fixture, group, passed) => {
      assert.equal(group, plan.runs[index].group)
      assert.equal(fixture.id, plan.runs[index].task)
      assert.equal(passed.composeWithTunedNative, true)
      assert.equal(passed.validationFeedbackLimit, 2)
      assert.equal(passed.maxSteps, 12)
      assert.equal(passed.timeoutMs, 120000)
      assert.deepEqual(passed.experimentalConfig, experimentalConfigV3(fixture, options))
      return data[index++]
    } })
  assert.equal(index, 117)
  assert.equal(report.fullAccepted, true)
  assert.equal(report.stoppedReason, null)
})

test('live checkpoints must exist and finish pinning the plan before any runner invocation', async () => {
  let calls = 0
  const base = { replay: false, key: 'synthetic-only', ...options, runner() { calls++; return {} } }
  for (const callbacks of [{}, { onPlan() {} }, { onResult() {} }, { onPlan: true, onResult() {} }]) {
    await assert.rejects(evaluateAcceptanceV3({ ...base, ...callbacks }), /checkpoint functions/)
  }
  await assert.rejects(evaluateAcceptanceV3({ ...base, onResult() {}, async onPlan() { throw new Error('pin failed') } }), /pin failed/)
  await assert.rejects(evaluateAcceptanceV3({ ...base, provenance: { ...provenance, mutable: new Map() }, onPlan() {}, onResult() {} }), /plain data/)
  assert.equal(calls, 0)
  const order = []
  await evaluateAcceptanceV3({ ...base,
    async onPlan() { order.push('pin-start'); await Promise.resolve(); order.push('pin-finished') },
    runner() { order.push('runner'); return { usageComplete: false } },
    onResult() { order.push('result') } })
  assert.deepEqual(order, ['pin-start', 'pin-finished', 'runner', 'result'])
})

test('callbacks cannot mutate pinned inputs or records and caller mutations cannot change later costs', async () => {
  const callerPricing = structuredClone(pricing)
  const callerProvenance = { ...provenance, audit: { source: 'frozen' } }
  const plan = createAcceptancePlanV3()
  const data = records(plan)
  const expected = summarizeAcceptanceV3(plan, data, { pricing, provenance: callerProvenance })
  let index = 0
  const report = await evaluateAcceptanceV3({ replay: false, key: 'synthetic-only', pricing: callerPricing, provenance: callerProvenance,
    onPlan(pinned) {
      assert.notEqual(pinned.pricing, callerPricing)
      assert.notEqual(pinned.provenance, callerProvenance)
      for (const mutate of [
        () => { pinned.plan.criteria.maxSteps = 100 },
        () => { pinned.plan.tasks[0].text = 'changed' },
        () => { pinned.plan.runs.splice(0, 1) },
        () => { pinned.pricing.uncached = 0 },
        () => { pinned.provenance.audit.source = 'changed' },
      ]) assert.throws(mutate, TypeError)
      callerPricing.uncached = 1000000
      callerProvenance.model = 'changed'
      callerProvenance.audit.source = 'changed'
    },
    runner(fixture, group, passed) {
      assert.equal(passed.prices.uncached, pricing.uncached)
      assert.equal(passed.model, pricing.model)
      assert.throws(() => { passed.prices.output = 0 }, TypeError)
      return data[index++]
    },
    onResult(row, pinnedPlan) {
      for (const mutate of [
        () => { row.usage.inputTokens = 0 },
        () => { row.modelCalls[0].usage.inputTokens = 0 },
        () => { row.configuration.maxSteps = 100 },
        () => { row.phaseResults[0].actual = {} },
        () => { pinnedPlan.runs.pop() },
      ]) assert.throws(mutate, TypeError)
      // Even the runner's original returned object is detached from the ledger.
      data[index - 1].usage.inputTokens = 9999999
      callerPricing.output = 1000000
    } })
  assert.equal(index, 117)
  assert.equal(report.fullAccepted, true)
  assert.equal(report.totalCostUSD, expected.totalCostUSD)
  assert.equal(report.provenance.audit.source, 'frozen')
  assert.equal(report.provenance.model, provenance.model)
  assert.deepEqual(report.pricing, pricing)
  assert.equal(report.plan.manifestHash, plan.manifestHash)
})

test('a failed result checkpoint prevents the next model task', async () => {
  const data = records(createAcceptancePlanV3())
  let calls = 0
  await assert.rejects(evaluateAcceptanceV3({ replay: false, key: 'synthetic-only', ...options, onPlan() {},
    runner() { return data[calls++] }, onResult() { throw new Error('journal failed') } }), /journal failed/)
  assert.equal(calls, 1)
})

test('the runner journals and stops immediately when raw calls contradict trusted-looking usage flags', async () => {
  const plan = createAcceptancePlanV3()
  for (const mutate of [
    row => { row.modelCalls = [{ kind: 'auxiliary', complete: false, usage: null }] },
    row => { row.modelCalls = [] },
    row => { row.modelCalls[0].usage.inputTokens++ },
    row => { row.modelCalls[0].provider = 'replay' },
    row => { row.modelCalls[0].model = 'different-model' },
    row => { row.modelCalls[0].usage.cacheWriteTokens = 1; row.usage.cacheWriteTokens = 1 },
  ]) {
    const row = records(plan)[0]
    mutate(row)
    row.usageComplete = true
    row.estimatedCostUSD = 0
    const checkpoints = []
    let calls = 0
    const prices = { ...pricing, cacheWrite: undefined }
    const report = await evaluateAcceptanceV3({ replay: false, key: 'synthetic-only', pricing: prices, provenance,
      onPlan() {}, onResult: result => checkpoints.push(result), runner() { calls++; return row } })
    assert.equal(calls, 1)
    assert.equal(checkpoints.length, 1)
    assert.equal(report.results.length, 1)
    assert.equal(report.stoppedReason, 'incomplete-cost-accounting')
    assert.equal(report.accepted, false)
    assert.deepEqual(report.results[0].modelCalls, row.modelCalls)
    assert.deepEqual(report.results[0].usage, row.usage)
  }
})

test('observed raw usage enforces the between-task budget despite a forged zero cost estimate', async () => {
  const row = records(createAcceptancePlanV3())[0]
  row.modelCalls[0].usage.inputTokens = 2000000
  row.usage.inputTokens = 2000000
  row.estimatedCostUSD = 0
  let calls = 0
  const report = await evaluateAcceptanceV3({ replay: false, key: 'synthetic-only', ...options,
    onPlan() {}, onResult() {}, runner() { calls++; return row } })
  assert.equal(calls, 1)
  assert.equal(report.results.length, 1)
  assert.equal(report.stoppedReason, 'budget')
  assert.equal(report.accepted, false)
})

test('scripted auxiliary calls retain usage without skipping the agent source read', async () => {
  const fixture = acceptanceFixturesV3().find(task => task.id === 'experiment-query-dependent')
  const adapter = acceptanceReplayAdapterV3({ LlmAdapter: class {}, fixture, source: '/fixture', snapshotPath: () => undefined, delivered: () => fixture.text, phase: () => 0 })
  const collect = async model => { const chunks = []; for await (const chunk of adapter.stream({ model })) chunks.push(chunk); return chunks }
  assert.equal((await collect('agent')).find(chunk => chunk.type === 'block-end').block.name, 'fixture')
  const auxiliary = await collect('acceptance-selector-replay')
  assert.equal(auxiliary.find(chunk => chunk.type === 'usage').usage.inputTokens, 10)
  assert.equal((await collect('agent')).find(chunk => chunk.type === 'block-end').block.name, 'read')
  const answer = (await collect('agent')).find(chunk => chunk.type === 'block-end').block.text
  assert.deepEqual(JSON.parse(answer), fixture.phases[0].expected)
})
