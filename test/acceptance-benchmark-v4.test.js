import test from 'node:test'
import assert from 'node:assert/strict'
import { retirementEvidenceHash } from '../scripts/calibrate-retirement.js'
import { createAcceptancePlanV2 } from '../scripts/acceptance-benchmark-v2.js'
import { createAcceptancePlanV4, summarizeAcceptanceV4, evaluateAcceptanceV4, experimentalConfigV4, acceptanceReplayAdapterV4, originalAcceptanceV4 } from '../scripts/acceptance-benchmark-v4.js'
import { createAcceptancePlanV3 } from '../scripts/acceptance-benchmark-v3.js'
import { acceptanceFixturesV3 } from './fixtures/acceptance/tasks-v3.js'
import { acceptanceFixturesV4 } from './fixtures/acceptance/tasks-v4.js'
import { encodeLosslessText } from '../src/lossless-text.js'
import { formatSnapshotReference } from '../src/snapshot.js'
import { createHash } from 'node:crypto'

// Synthetic ledger contract tests: no real provider or savings evidence.
const pricing = { currency: 'USD', model: 'model', verifiedDate: '2026-10-27', ratePeriod: 'test', sourceUrl: 'https://example.test/prices', uncached: 1, cacheRead: .1, cacheWrite: 0, output: 1 }
const provenance = { runtimeVersion: '0.2.1-rc.2', repositoryCommit: 'a'.repeat(40), sourceTreeHash: 'b'.repeat(64), model: 'model', cacheCondition: 'shared-provider-cache-uncontrolled-counterbalanced' }
const options = { pricing, provenance }
function records(plan) {
  return plan.runs.map(run => {
    const fixture = plan.tasks.find(task => task.id === run.task)
    const usage = { inputTokens: run.group === 'plugin' ? 50 : 100, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
    return { ...run, manifestHash: plan.manifestHash, passed: true, exactFacts: true, requiredTools: true, fileCorrect: true, snapshotRecovered: true,
      responseSchemaSatisfied: true, responseContractSatisfied: true, phaseResults: (fixture.phases ?? [fixture]).map(phase => ({ responseText: JSON.stringify(phase.expected), actual: phase.expected, passed: true, freshAnswer: true, turnCompleted: true })),
      turnEnds: [{ kind: 'completed' }], replay: false, usageKind: 'provider-reported', usageComplete: true, usage,
      modelCalls: [{ kind: 'agent', complete: true, provider: 'deepseek-official', model: 'model', usage: { ...usage } }],
      configuration: { maxInlineTokens: run.group === 'baseline-default' ? 12500 : 1200, plugin: run.group === 'plugin', nativePolicyInstalledAfterPlugin: true,
        validationFeedbackLimit: 2, maxSteps: 12, timeoutMs: 120000, readText: { enabled: run.group === 'plugin', classifier: 'filesystem-host-v1', minimumSavingsRatio: 0.5, encodeArtifacts: run.group === 'plugin' } },
      requestedProtocol: { readText: true, encodeArtifacts: true, requireFixtureEachPhase: fixture.requireFixtureEachPhase === true, rejectPlaceholderValues: fixture.rejectPlaceholderValues === true,
        discoverSourcePath: fixture.discoverSourcePath === true, ptc: fixture.ptc === true,
        requireSnapshot: fixture.requireSnapshot === true, requireReadEachPhase: fixture.requireReadEachPhase === true,
        responseSchemas: (fixture.phases ?? [fixture]).map(phase => phase.responseSchema ?? fixture.responseSchema ?? null),
        historyRetirement: fixture.historyRetirement ?? null, experimentalConfig: experimentalConfigV4(fixture, options) ?? null },
      retirements: [{ reason: fixture.expectedRetirement ? 'retired' : 'economic-gate', economics: { adopt: false } }],
      toolCalls: [0, 1].flatMap(phase => [{ name: fixture.ptc ? 'run_code' : 'fixture', phase, isError: false }, { name: 'read', phase, readSnapshot: true, isError: false }]),
      adoptions: [{ callId: 'fixture-call', strategy: fixture.experiment === 'diagnostic-evidence' ? 'diagnostic-evidence-selection-v1' : `${fixture.experiment}-prose-selection-v1`,
        persisted: true, modelVisible: true, contentHash: 'c'.repeat(64), persistedContentHash: 'c'.repeat(64), modelVisibleContentHash: 'c'.repeat(64) }],
      experiments: [{ callId: 'fixture-call', reason: 'selected', llmCalled: true }, { reason: fixture.expectedFallback }] }
  })
}
const selected = (rows, task = 'experiment-query-dependent') => rows.find(row => row.task === task && row.group === 'plugin')

test('v4 keeps all v2 tasks and balanced schedule with a separate canonical manifest', () => {
  const previous = createAcceptancePlanV2()
  assert.equal(previous.manifestHash, '5e220ecd0d2b156fa9b02cfc0e927ea74bbb767eaa991739adefb25b20e30bcd')
  const plan = createAcceptancePlanV4()
  assert.equal(plan.version, 4)
  assert.equal(plan.tasks.length, 13)
  assert.equal(plan.runs.length, 117)
  assert.deepEqual(plan.runs, previous.runs)
  assert.deepEqual(plan, createAcceptancePlanV4())
  assert.notEqual(plan.manifestHash, previous.manifestHash)
  assert.notEqual(plan.manifestHash, createAcceptancePlanV4({ seed: 1 }).manifestHash)
  assert.throws(() => createAcceptancePlanV4({ seed: -1 }), /seed/)
  for (const task of plan.tasks) for (const group of ['baseline-default', 'baseline-tuned', 'plugin']) {
    assert.deepEqual(plan.runs.filter(run => run.task === task.id && run.group === group).map(run => run.position).sort(), [0, 1, 2])
  }
  assert.deepEqual(createAcceptancePlanV2(), previous)
})

test('v4 preserves the frozen v3 schedule, source facts and flags while declaring every phase schema', () => {
  const oldPlan = createAcceptancePlanV3()
  assert.equal(oldPlan.manifestHash, 'b0015867662374dbd1177e763fd11e42ef57abe498efd07da295c3e30cd92e34')
  const previous = acceptanceFixturesV3()
  for (const fixture of acceptanceFixturesV4()) {
    const old = previous.find(task => task.id === fixture.id)
    assert.equal(fixture.text, old.text)
    for (const key of ['requireFixtureEachPhase', 'rejectPlaceholderValues', 'requireSnapshot', 'requireReadEachPhase', 'ptc', 'historyRetirement']) assert.deepEqual(fixture[key], old[key])
    for (const [index, phase] of (fixture.phases ?? [fixture]).entries()) {
      const oldPhase = (old.phases ?? [old])[index]
      assert.ok(phase.query.startsWith(oldPhase.query))
      assert.ok(phase.responseSchema)
      assert.deepEqual(phase.expected, oldPhase.expected)
      assert.deepEqual(fixture.answer(fixture.edit && index ? fixture.editedText : fixture.text, index), phase.expected)
    }
  }
  assert.deepEqual(createAcceptancePlanV4().runs, oldPlan.runs)
  assert.deepEqual(createAcceptancePlanV3(), oldPlan)
})

test('all synthetic gates pass only together and replay never certifies money', () => {
  const plan = createAcceptancePlanV4()
  const data = records(plan)
  const result = summarizeAcceptanceV4(plan, data, options)
  assert.equal(result.fullAccepted, true)
  assert.equal(result.modes.length, 3)
  assert.ok(result.modes.every(mode => mode.accepted && mode.medianPairedSavingsUSD > 0))
  assert.equal(summarizeAcceptanceV4(plan, data, { ...options, replay: true }).accepted, false)
  assert.equal(summarizeAcceptanceV4(plan, data, { pricing }).costComplete, false)
})

test('original v4 acceptance recomputes its versioned benchmark and still requires calibration', () => {
  const plan = createAcceptancePlanV4()
  const report = { evaluationKind: 'acceptance-v4-live-provider', plan, results: records(plan), pricing, provenance }
  const result = originalAcceptanceV4(report)
  assert.equal(result.benchmarkAccepted, true)
  assert.equal(result.calibrationEvidenceComplete, false)
  assert.equal(result.accepted, false)
  assert.equal(originalAcceptanceV4({ ...report, evaluationKind: 'acceptance-v2-live-provider', fullAccepted: true }).benchmarkAccepted, false)
  assert.equal(originalAcceptanceV4({ evaluationKind: 'acceptance-v4-live-provider', fullAccepted: true }).benchmarkAccepted, false)
  const forged = structuredClone(report)
  forged.fullAccepted = true
  selected(forged.results).adoptions = []
  assert.equal(originalAcceptanceV4(forged).benchmarkAccepted, false)
})

test('missing, duplicate, altered-plan and old-protocol evidence cannot pass', () => {
  const plan = createAcceptancePlanV4()
  const data = records(plan)
  assert.equal(summarizeAcceptanceV4(plan, data.slice(1), options).accepted, false)
  assert.equal(summarizeAcceptanceV4(plan, [data[0], ...data.slice(0, -1)], options).coverageComplete, false)
  const changed = structuredClone(plan)
  changed.tasks.find(task => task.id === 'experiment-query-dependent').rejectPlaceholderValues = false
  assert.equal(summarizeAcceptanceV4(changed, data, options).planValid, false)
  const badConfig = structuredClone(plan)
  badConfig.experimentSettings.maxOutputTokens = 120
  assert.equal(summarizeAcceptanceV4(badConfig, data, options).accepted, false)
  assert.equal(summarizeAcceptanceV4(createAcceptancePlanV2(), data, options).accepted, false)
})

test('one mode with negative paired median fails despite positive sums everywhere', () => {
  const plan = createAcceptancePlanV4()
  const data = records(plan)
  for (const row of data.filter(row => row.task === 'experiment-query-dependent')) {
    const tokens = row.group === 'plugin' ? [300, 300, 1][row.repeat] : [200, 200, 1000][row.repeat]
    row.usage.inputTokens = tokens
    row.modelCalls[0].usage.inputTokens = tokens
  }
  const result = summarizeAcceptanceV4(plan, data, options)
  const mode = result.modes.find(mode => mode.mode === 'query-dependent')
  assert.ok(result.experimental.netSavingsVsTunedUSD > 0)
  assert.ok(mode.netSavingsVsTunedUSD > 0)
  assert.ok(mode.medianPairedSavingsUSD < 0)
  assert.equal(result.experimentalModesAccepted, false)
  assert.equal(result.accepted, false)
})

test('per-mode quality, actual adoption and protocol settings are required despite success flags', () => {
  const plan = createAcceptancePlanV4()
  for (const mutate of [
    row => { row.phaseResults[0].actual = { owner: 'UNKNOWN' } },
    row => { row.responseContractSatisfied = false },
    row => { row.adoptions[0].modelVisible = false },
    row => { row.adoptions[0].persistedContentHash = 'd'.repeat(64) },
    row => { row.requestedProtocol.rejectPlaceholderValues = false },
    row => { row.requestedProtocol.experimentalConfig.admission = 'net-benefit' },
    row => { row.requestedProtocol.experimentalConfig.maxOutputTokens = 120 },
    row => { row.configuration.maxInlineTokens = 12500 },
    row => { row.configuration.validationFeedbackLimit = 1 },
    row => { row.configuration.maxSteps = 13 },
    row => { row.configuration.timeoutMs = 130000 },
    row => { row.toolCalls = row.toolCalls.filter(call => call.phase === 0) },
  ]) {
    const data = records(plan)
    mutate(selected(data))
    assert.equal(summarizeAcceptanceV4(plan, data, options).accepted, false)
  }
})

test('unknown auxiliary costs, ledger mismatches and overall budget overshoot fail closed', () => {
  const plan = createAcceptancePlanV4()
  for (const mutate of [
    row => { row.modelCalls.push({ kind: 'auxiliary', complete: false, usage: null }) },
    row => { row.modelCalls[0].usage.inputTokens++ },
    row => { row.usage.inputTokens = 2000000; row.modelCalls[0].usage.inputTokens = 2000000 },
  ]) {
    const data = records(plan)
    mutate(data.find(row => row.group === 'baseline-default'))
    assert.equal(summarizeAcceptanceV4(plan, data, options).accepted, false)
  }
})

test('fallback, stress and conservative lifecycle rejection remain mandatory', () => {
  const plan = createAcceptancePlanV4()
  for (const [task, mutate] of [
    ['experiment-diagnostic-tap-fallback', row => { row.experiments = [] }],
    ['history-retirement-stress', row => { row.retirements = [] }],
    ['history-retirement-short', row => { row.retirements[0].reason = 'retired' }],
  ]) {
    const data = records(plan)
    mutate(selected(data, task))
    assert.equal(summarizeAcceptanceV4(plan, data, options).accepted, false)
  }
})

test('runner preflight, partial checkpoints and safe failures prevent unpriced continuation', async () => {
  let calls = 0
  await assert.rejects(evaluateAcceptanceV4({ replay: false, key: 'test', runner() { calls++ } }), /provenance/)
  assert.equal(calls, 0)
  const checkpoints = []
  const report = await evaluateAcceptanceV4({ runner() { throw { code: 'EACCES', message: 'private provider text' } }, onResult: row => checkpoints.push(row) })
  assert.equal(report.stoppedReason, 'runner-exception')
  assert.equal(report.results.length, 1)
  assert.equal(checkpoints.length, 1)
  assert.equal(JSON.stringify(report).includes('private provider text'), false)
  assert.equal(report.accepted, false)
})

test('runner passes declared experiment configuration and same limits to all 117 tasks', async () => {
  const plan = createAcceptancePlanV4()
  const data = records(plan)
  let index = 0
  const report = await evaluateAcceptanceV4({ replay: false, key: 'synthetic-only', ...options,
    onPlan() {}, onResult() {},
    runner: async (fixture, group, passed) => {
      assert.equal(group, plan.runs[index].group)
      assert.equal(fixture.id, plan.runs[index].task)
      assert.equal(passed.composeWithTunedNative, true)
      assert.equal(passed.validationFeedbackLimit, 2)
      assert.equal(passed.maxSteps, 12)
      assert.equal(passed.timeoutMs, 120000)
      assert.deepEqual(passed.experimentalConfig, experimentalConfigV4(fixture, options))
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
    await assert.rejects(evaluateAcceptanceV4({ ...base, ...callbacks }), /checkpoint functions/)
  }
  await assert.rejects(evaluateAcceptanceV4({ ...base, onResult() {}, async onPlan() { throw new Error('pin failed') } }), /pin failed/)
  await assert.rejects(evaluateAcceptanceV4({ ...base, provenance: { ...provenance, mutable: new Map() }, onPlan() {}, onResult() {} }), /plain data/)
  assert.equal(calls, 0)
  const order = []
  await evaluateAcceptanceV4({ ...base,
    async onPlan() { order.push('pin-start'); await Promise.resolve(); order.push('pin-finished') },
    runner() { order.push('runner'); return { usageComplete: false } },
    onResult() { order.push('result') } })
  assert.deepEqual(order, ['pin-start', 'pin-finished', 'runner', 'result'])
})

test('callbacks cannot mutate pinned inputs or records and caller mutations cannot change later costs', async () => {
  const callerPricing = structuredClone(pricing)
  const callerProvenance = { ...provenance, audit: { source: 'frozen' } }
  const plan = createAcceptancePlanV4()
  const data = records(plan)
  const expected = summarizeAcceptanceV4(plan, data, { pricing, provenance: callerProvenance })
  let index = 0
  const report = await evaluateAcceptanceV4({ replay: false, key: 'synthetic-only', pricing: callerPricing, provenance: callerProvenance,
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
  const data = records(createAcceptancePlanV4())
  let calls = 0
  await assert.rejects(evaluateAcceptanceV4({ replay: false, key: 'synthetic-only', ...options, onPlan() {},
    runner() { return data[calls++] }, onResult() { throw new Error('journal failed') } }), /journal failed/)
  assert.equal(calls, 1)
})

test('the runner journals and stops immediately when raw calls contradict trusted-looking usage flags', async () => {
  const plan = createAcceptancePlanV4()
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
    const report = await evaluateAcceptanceV4({ replay: false, key: 'synthetic-only', pricing: prices, provenance,
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
  const row = records(createAcceptancePlanV4())[0]
  row.modelCalls[0].usage.inputTokens = 2000000
  row.usage.inputTokens = 2000000
  row.estimatedCostUSD = 0
  let calls = 0
  const report = await evaluateAcceptanceV4({ replay: false, key: 'synthetic-only', ...options,
    onPlan() {}, onResult() {}, runner() { calls++; return row } })
  assert.equal(calls, 1)
  assert.equal(report.results.length, 1)
  assert.equal(report.stoppedReason, 'budget')
  assert.equal(report.accepted, false)
})

test('scripted auxiliary calls retain usage without skipping the agent source read', async () => {
  const fixture = acceptanceFixturesV4().find(task => task.id === 'experiment-query-dependent')
  const adapter = acceptanceReplayAdapterV4({ LlmAdapter: class {}, fixture, source: '/fixture', snapshotPath: () => undefined, delivered: () => { throw Error('Hidden delivered callback is not evidence') }, phase: () => 0 })
  const collect = async model => { const chunks = []; for await (const chunk of adapter.stream({ model, messages: [{ role: 'tool', content: [{ type: 'text', text: fixture.text }] }] })) chunks.push(chunk); return chunks }
  assert.equal((await collect('agent')).find(chunk => chunk.type === 'block-end').block.name, 'fixture')
  const auxiliary = await collect('acceptance-selector-replay')
  assert.equal(auxiliary.find(chunk => chunk.type === 'usage').usage.inputTokens, 10)
  assert.equal((await collect('agent')).find(chunk => chunk.type === 'block-end').block.name, 'read')
  const answer = (await collect('agent')).find(chunk => chunk.type === 'block-end').block.text
  assert.deepEqual(JSON.parse(answer), fixture.phases[0].expected)
})

test('raw JSON, schema and exact facts are independently checked despite all success flags', () => {
  const plan = createAcceptancePlanV4()
  for (const mutate of [
    phase => { phase.responseText = `\`\`\`json\n${phase.responseText}\n\`\`\`` },
    phase => { phase.responseText = `Answer: ${phase.responseText}` },
    phase => { phase.responseText = '{broken' },
    phase => { delete phase.responseText },
    phase => { phase.responseText = JSON.stringify({ result: phase.actual }); phase.actual = { result: phase.actual } },
    phase => { phase.actual.owner = 'wrong-but-valid-string'; phase.responseText = JSON.stringify(phase.actual) },
    phase => { phase.actual.owner = 42; phase.responseText = JSON.stringify(phase.actual) },
    phase => { phase.actual.owner = 'UNKNOWN'; phase.responseText = JSON.stringify(phase.actual) },
    phase => { phase.actual.owner = 'wrong-but-raw-text-unchanged' },
  ]) {
    const data = records(plan)
    // Detach expected values from the plan before simulating hostile ledgers.
    const row = selected(data)
    row.phaseResults = structuredClone(row.phaseResults)
    mutate(row.phaseResults[0])
    const result = summarizeAcceptanceV4(plan, data, options)
    assert.equal(result.planValid, true)
    assert.equal(result.qualityComplete, false)
    assert.equal(result.fullAccepted, false)
  }
})

test('every requested schema and fixture protocol flag is bound independently to canonical v4', () => {
  const plan = createAcceptancePlanV4()
  for (const mutate of [
    protocol => { protocol.responseSchemas = [] },
    protocol => { protocol.responseSchemas[1] = { type: 'object' } },
    protocol => { delete protocol.responseSchemas },
    protocol => { protocol.discoverSourcePath = true },
    protocol => { protocol.ptc = true },
    protocol => { protocol.requireSnapshot = !protocol.requireSnapshot },
    protocol => { protocol.requireReadEachPhase = !protocol.requireReadEachPhase },
    protocol => { protocol.historyRetirement = { enabled: false } },
  ]) {
    const data = records(plan)
    const row = selected(data)
    row.requestedProtocol = structuredClone(row.requestedProtocol)
    mutate(row.requestedProtocol)
    const result = summarizeAcceptanceV4(plan, data, options)
    assert.equal(result.planValid, true)
    assert.equal(result.configurationComplete, false)
    assert.equal(result.fullAccepted, false)
  }
  const forgedPlan = structuredClone(plan)
  forgedPlan.tasks[0].responseSchema = { type: 'object' }
  assert.equal(summarizeAcceptanceV4(forgedPlan, records(plan), options).planValid, false)
})

test('original gate cannot accept relabeled v3, injected verdicts or a caller validator', () => {
  const plan = createAcceptancePlanV4()
  const report = { evaluationKind: 'acceptance-v4-live-provider', plan, results: records(plan), pricing, provenance }
  let invoked = false
  const fakeEvidence = { accepted: true, calibrationEvidenceComplete: true, shortHorizonBacktestPassed: true }
  const result = originalAcceptanceV4(report, fakeEvidence, fakeEvidence, () => { invoked = true; return true })
  assert.equal(invoked, false)
  assert.equal(result.benchmarkAccepted, true)
  assert.equal(result.accepted, false)
  assert.equal(originalAcceptanceV4({ ...report, plan: createAcceptancePlanV3(), fullAccepted: true }, fakeEvidence, fakeEvidence).benchmarkAccepted, false)
  assert.equal(originalAcceptanceV4({ ...report, evaluationKind: 'acceptance-v3-live-provider', accepted: true }, fakeEvidence, fakeEvidence).accepted, false)
})

test('core savings, each mode cumulative savings and the raw model-call ceiling are mandatory', () => {
  const plan = createAcceptancePlanV4()
  for (const mutate of [
    data => {
      for (const row of data.filter(row => plan.tasks.find(task => task.id === row.task).tier === 'core' && row.group === 'plugin')) {
        row.usage.inputTokens = 500; row.modelCalls[0].usage.inputTokens = 500
      }
    },
    data => {
      for (const row of data.filter(row => row.task === 'experiment-query-dependent' && row.group === 'plugin')) {
        row.usage.inputTokens = [1, 1, 400][row.repeat]; row.modelCalls[0].usage.inputTokens = row.usage.inputTokens
      }
    },
    data => {
      const row = data[0]
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      row.modelCalls.push(...Array.from({ length: plan.criteria.maxModelCalls }, () => ({ kind: 'agent', complete: true, provider: 'deepseek-official', model: 'model', usage })))
    },
    data => { data[0].modelCalls[0].kind = 'unaccounted-route' },
    data => { data[0].modelCalls[0].complete = 'true' },
  ]) {
    const data = records(plan)
    mutate(data)
    assert.equal(summarizeAcceptanceV4(plan, data, options).fullAccepted, false)
  }
})

test('missing key and incomplete pricing/provenance fail before either live checkpoint', async () => {
  let invoked = 0
  const base = { replay: false, key: 'synthetic-only', ...options, runner() { invoked++ }, onPlan() { invoked++ }, onResult() { invoked++ } }
  for (const override of [
    { key: undefined }, { key: ' ' },
    { pricing: { ...pricing, output: undefined } },
    { pricing: { ...pricing, sourceUrl: '' } },
    { provenance: { ...provenance, model: 'different' } },
  ]) await assert.rejects(evaluateAcceptanceV4({ ...base, ...override }), /credential|provenance/)
  assert.equal(invoked, 0)
})

test('awaited result checkpoints finish before the next scheduled task', async () => {
  const data = records(createAcceptancePlanV4())
  let completed = 0
  let index = 0
  await evaluateAcceptanceV4({ replay: false, key: 'synthetic-only', ...options,
    async onPlan() { await Promise.resolve() },
    runner() { assert.equal(completed, index); return index === 1 ? { usageComplete: false } : data[index++] },
    async onResult() { await new Promise(resolve => setImmediate(resolve)); completed++ },
  })
  assert.equal(completed, 2)
})

const usage = inputTokens => ({ inputTokens, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })
function evidence() {
  const fixture = { id: 'history', text: 'unchanged source', expected: { correct: true } }
  const assumptions = { minimumFutureRequests: 200 }
  const reports = [0, 1, 2].map(index => ({ evaluationKind: 'history-retirement-live-agent', completed: true, runId: `run-${index}`, model: 'model', provenance,
    fixture, fixtureHash: retirementEvidenceHash(fixture), assumptions, policyHash: retirementEvidenceHash(assumptions), tasks: ['baseline-default', 'baseline-tuned', 'plugin'].map(group => ({
      group, configuration: { maxInlineTokens: group === 'baseline-default' ? 12500 : 1200, plugin: group === 'plugin', nativePolicyInstalledAfterPlugin: true, validationFeedbackLimit: 2, maxSteps: 12, timeoutMs: 120000, readText: { enabled: group === 'plugin', classifier: 'filesystem-host-v1', minimumSavingsRatio: 0.5, encodeArtifacts: group === 'plugin' } }, task: fixture.id, startedAt: `run-${index}`, steps: 2, replay: false, passed: true, usageKind: 'provider-reported', usageComplete: true, attempts: 0, pricing, historyRetirement: assumptions,
      phaseResults: [{ actual: fixture.expected, passed: true, freshAnswer: true, turnCompleted: true }], turnEnds: [{ kind: 'completed' }],
      retirements: [{ reason: 'retired', beforeStep: 1, actualPostRetirementSteps: 2, economics: { minimumFutureRequests: 200, adopt: true, removedTokens: 1000, compressionCost: 0, expectedRecoveryCost: 0, cacheRebuildCost: .0001, safetyMargin: .25 } }],
      toolCalls: [{ name: 'fixture', isError: false }, { callId: 'read-1', phase: 0, name: 'read', readSnapshot: true, isError: false }],
      modelCalls: [1, 2].map(agentStep => ({ id: agentStep, agentStep, kind: 'agent', complete: true, finish: 'stop', provider: 'deepseek-official', model: 'model', visibleToolResults: [{ callId: 'read-1' }], usage: usage(group === 'plugin' ? 200 : 100) })),
      usage: { ...usage(group === 'plugin' ? 400 : 200), outputTokens: 2 },
    })) }))
  const negative = structuredClone(reports[0])
  negative.runId = 'held-out-negative'
  return { calibration: { reports, expectedRunIds: reports.map(report => report.runId) }, backtest: { report: negative, expectedReportHash: retirementEvidenceHash(negative) } }
}

test('original v4 requires independently derived calibration and disjoint pinned negative horizon <= 2', () => {
  const plan = createAcceptancePlanV4()
  const report = { evaluationKind: 'acceptance-v4-live-provider', plan, results: records(plan), pricing, provenance }
  const data = evidence()
  const checked = originalAcceptanceV4(report, data.calibration, data.backtest)
  assert.equal(checked.benchmarkAccepted, true)
  assert.equal(checked.calibrationEvidenceComplete, true)
  assert.equal(checked.shortHorizonBacktestPassed, true)
  assert.equal(checked.accepted, true)
  for (const mutate of [
    item => { item.calibration.reports.pop() },
    item => { item.backtest.expectedReportHash = '0'.repeat(64) },
    item => { item.backtest.report = item.calibration.reports[0]; item.backtest.expectedReportHash = retirementEvidenceHash(item.backtest.report) },
    item => {
      for (const task of item.backtest.report.tasks) {
        task.steps = 3
        task.retirements[0].actualPostRetirementSteps = 3
        task.modelCalls.push({ ...structuredClone(task.modelCalls[1]), id: 3, agentStep: 3 })
        task.usage.inputTokens += task.modelCalls[2].usage.inputTokens
        task.usage.outputTokens++
      }
      item.backtest.expectedReportHash = retirementEvidenceHash(item.backtest.report)
    },
  ]) {
    const changed = evidence()
    mutate(changed)
    assert.equal(originalAcceptanceV4(report, changed.calibration, changed.backtest).accepted, false)
  }
})

test('invalid replay switches fail before checkpoints and raw-ledger defects block every subgate', async () => {
  let invoked = 0
  for (const replay of ['false', 'true', 0, 1, null, {}, []]) {
    await assert.rejects(evaluateAcceptanceV4({ replay, runner() { invoked++ }, onPlan() { invoked++ } }), /replay must be a boolean/)
  }
  assert.equal(invoked, 0)
  const plan = createAcceptancePlanV4()
  const data = records(plan)
  selected(data).modelCalls[0].kind = 'unknown'
  const result = summarizeAcceptanceV4(plan, data, options)
  assert.equal(result.accountingComplete, false)
  assert.equal(result.coreAccepted, false)
  assert.equal(result.fullAccepted, false)
  assert.ok(result.modes.every(mode => mode.accepted === false))
})

test('v4 selector pricing does not invent a zero rate for unquoted cache writes', () => {
  const fixture = acceptanceFixturesV4().find(task => task.experiment)
  const { cacheWrite, ...unquoted } = pricing
  const config = experimentalConfigV4(fixture, { pricing: { ...unquoted, cacheWritePolicy: 'reject-nonzero' } })
  assert.equal(Object.hasOwn(config.pricing, 'cacheWritePerMillion'), false)
  assert.equal(config.pricing.cacheWritePolicy, 'reject-nonzero')
  assert.equal(config.pricing.uncachedInputPerMillion, pricing.uncached)
  assert.equal(config.pricing.cacheReadPerMillion, pricing.cacheRead)
  assert.equal(config.pricing.outputPerMillion, pricing.output)
  for (const rate of [0, .25]) {
    assert.equal(experimentalConfigV4(fixture, { pricing: { ...unquoted, cacheWrite: rate } }).pricing.cacheWritePerMillion, rate)
  }
})

test('the prospective 400-token response budget preserves money gates and rejects relabelled 120-token evidence', () => {
  const plan = createAcceptancePlanV4()
  const { maxOutputTokens, ...settings } = plan.experimentSettings
  const { maxOutputTokens: oldLimit, ...oldSettings } = createAcceptancePlanV3().experimentSettings
  assert.equal(oldLimit, 120)
  assert.equal(maxOutputTokens, 400)
  assert.deepEqual(settings, oldSettings)
  assert.equal(settings.maxOutputBytes, 2000)
  assert.equal(settings.maxCallCost, .02)
  assert.equal(settings.maxTotalCost, .03)
  assert.equal(plan.runs.length, 117)
  const oldPlan = structuredClone(plan)
  oldPlan.experimentSettings.maxOutputTokens = 120
  const { manifestHash, ...oldContent } = oldPlan
  oldPlan.manifestHash = retirementEvidenceHash(oldContent)
  assert.notEqual(plan.manifestHash, oldPlan.manifestHash)
  assert.equal(summarizeAcceptanceV4(oldPlan, records(oldPlan), options).planValid, false)
  const relabelled = records(plan)
  selected(relabelled).requestedProtocol.experimentalConfig.maxOutputTokens = 120
  const rejected = summarizeAcceptanceV4(plan, relabelled, options)
  assert.equal(rejected.configurationComplete, false)
  assert.equal(rejected.fullAccepted, false)
})

test('prospective read policy is pinned and missing or changed configuration fails acceptance', () => {
  const plan = createAcceptancePlanV4()
  assert.equal(plan.readText, true)
  for (const change of [row => { delete row.configuration.readText },
    row => { row.configuration.readText.minimumSavingsRatio = 0 },
    row => { row.configuration.readText.classifier = 'registry-miss' },
    row => { row.requestedProtocol.readText = false }]) {
    const rows = records(plan)
    change(rows.find(row => row.group === 'plugin'))
    const summary = summarizeAcceptanceV4(plan, rows, options)
    assert.equal(summary.configurationComplete, false)
    assert.equal(summary.accepted, false)
  }
  const old = structuredClone(plan)
  delete old.readText
  const { manifestHash, ...body } = old
  old.manifestHash = retirementEvidenceHash(body)
  assert.equal(summarizeAcceptanceV4(old, records(old), options).planValid, false)
})

test('v4 replay strictly decodes both standalone and receipt-wrapped visible frames', async () => {
  const fixture = acceptanceFixturesV4().find(task => task.id === 'experiment-query-dependent')
  const encoded = encodeLosslessText(fixture.text)
  assert.ok(encoded)
  const receipt = { sessionId: 'session', callId: 'read-call', toolName: 'read', sha256: createHash('sha256').update(fixture.text).digest('hex'), bytes: Buffer.byteLength(fixture.text), locator: '/fixture-render-snapshot', retrievalHint: 'Read exact saved text.' }
  const footer = formatSnapshotReference(receipt)
  for (const visible of [encoded, `${encoded}\n\n${footer}`]) {
    const messages = [{ role: 'tool', content: [{ type: 'text', text: visible }] }]
    const adapter = acceptanceReplayAdapterV4({ LlmAdapter: class {}, fixture, source: '/fixture', snapshotPath: () => undefined,
      delivered: () => { throw Error('hidden source') }, phase: () => 0 })
    const stream = async request => { const blocks = []; for await (const chunk of adapter.stream(request)) if (chunk.type === 'block-end') blocks.push(chunk.block); return blocks }
    await stream({ model: 'agent', messages: [] })
    await stream({ model: 'agent', messages: [] })
    const answer = (await stream({ model: 'agent', messages }))[0]
    assert.deepEqual(JSON.parse(answer.text), fixture.phases[0].expected)
    for (const invalid of [encoded + '\n', encoded + ' unknown suffix', encoded.replace('"bytes":', '"bytes":0,"other":'),
      `${encoded}\n\nOriginal tool-result snapshot: NOT_JSON\nUNRECOGNIZED TRAILER`,
      `${encoded}\n\nOriginal tool-result snapshot: {}\nUNRECOGNIZED TRAILER`,
      `${encoded}\n\n${footer}\nUNRECOGNIZED TRAILER`,
      `${encoded}\n\n${formatSnapshotReference({ ...receipt, sha256: '0'.repeat(64) })}`]) {
      messages[0].content[0].text = invalid
      await assert.rejects(stream({ model: 'agent', messages }))
    }
  }
})

test('read encoding adoption cannot replace any of the three auxiliary model-selection adoptions', () => {
  const plan = createAcceptancePlanV4()
  for (const mode of ['task-independent', 'query-dependent', 'diagnostic-evidence']) {
    const rows = records(plan)
    const row = rows.find(row => row.group === 'plugin' && plan.tasks.some(task => task.id === row.task && task.experiment === mode && task.adoptionRequired !== false))
    row.adoptions[0].strategy = 'read-lossless-text-v1'
    const summary = summarizeAcceptanceV4(plan, rows, options)
    assert.equal(summary.experimentalModesAccepted, false)
    assert.equal(summary.accepted, false)
  }
})

test('artifact representation is a new prospective policy and rejects frozen source-only evidence', () => {
  const current = createAcceptancePlanV4()
  assert.equal(current.encodeArtifacts, true)
  const prior = structuredClone(current)
  delete prior.encodeArtifacts
  delete prior.manifestHash
  prior.manifestHash = retirementEvidenceHash(prior)
  assert.equal(prior.manifestHash, '7132fc47177d31d6a92842d34e0767540fdc077df2c7e0c856540eeb55bd4626')
  assert.equal(summarizeAcceptanceV4(prior, records(prior), options).planValid, false)
  for (const change of [row => { delete row.configuration.readText.encodeArtifacts },
    row => { row.configuration.readText.encodeArtifacts = false },
    row => { row.requestedProtocol.encodeArtifacts = false }]) {
    const rows = records(current)
    change(rows.find(row => row.group === 'plugin'))
    assert.equal(summarizeAcceptanceV4(current, rows, options).configurationComplete, false)
  }
})
