import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcceptanceBundlePlanV4, summarizeAcceptanceBundleV4 } from '../scripts/acceptance-bundle-v4.js'
import { createAcceptancePlanV3 } from '../scripts/acceptance-benchmark-v3.js'
import { experimentalConfigV4 } from '../scripts/acceptance-benchmark-v4.js'
import { calibrateRetirementReports, retirementEvidenceHash } from '../scripts/calibrate-retirement.js'
import { buildDevelopmentProfile, reconcileDevelopmentLedger } from '../scripts/evaluate-development.js'

// Explicitly fabricated raw transcripts for validator contracts only. These
// tests never relabel a captured replay or establish real provider savings.
const repository = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const hash = value => createHash('sha256').update(value).digest('hex')
const digest = value => hash(JSON.stringify(value))
const pricing = { currency: 'USD', model: 'model', verifiedDate: '2026-10-28', ratePeriod: 'test', sourceUrl: 'https://example.test/prices', uncached: .3, cacheRead: .006, cacheWrite: 0, output: 1.2 }
const provenance = { runtimeVersion: '0.2.1-rc.2', repositoryCommit: 'a'.repeat(40), sourceTreeHash: 'b'.repeat(64), runtimeLockHash: 'c'.repeat(64), model: 'model', cacheCondition: 'shared-provider-cache-uncontrolled-counterbalanced' }
const options = { pricing, provenance }
const inputs = { rootDir: '/private/tmp/bundle-test', bundleId: 'bundle-test', seed: 20261026, replay: false, ...options, maxTotalCostUSD: 1, maxTotalCalls: 1992, knownPriorSpendUSD: .979656936, priorUnpricedCalls: 1,
  runtimes: { agent: { root: '/private/runtime/agent', lockHash: 'c'.repeat(64), version: '0.2.1-rc.2' }, cli: { root: '/private/runtime/cli', lockHash: 'd'.repeat(64), version: '0.2.1-rc.2' } },
  developmentIdentity: { fixtureManifestHash: 'e'.repeat(64), fixtureInitialSourceHash: 'f'.repeat(64) } }

function benchmarkRecords(plan) {
  return plan.runs.map(run => {
    const fixture = plan.tasks.find(task => task.id === run.task)
    const usage = { inputTokens: run.group === 'plugin' ? 50 : 100, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
    return { ...run, manifestHash: plan.manifestHash, pricing, cleanup: { complete: true, failures: [] }, steps: 1, elapsedMs: 100, passed: true, exactFacts: true, requiredTools: true, fileCorrect: true, snapshotRecovered: true,
      responseSchemaSatisfied: true, responseContractSatisfied: true, phaseResults: (fixture.phases ?? [fixture]).map(phase => ({ responseText: JSON.stringify(phase.expected), actual: phase.expected, passed: true, freshAnswer: true, turnCompleted: true })),
      turnEnds: [{ kind: 'completed' }], replay: false, usageKind: 'provider-reported', usageComplete: true, usage,
      modelCalls: [{ id: 1, agentStep: 1, finish: 'stop', kind: 'agent', complete: true, provider: 'deepseek-official', model: 'model', usage: { ...usage } }],
      configuration: { maxInlineTokens: run.group === 'baseline-default' ? 12500 : 1200, plugin: run.group === 'plugin', nativePolicyInstalledAfterPlugin: true,
        validationFeedbackLimit: 2, maxSteps: 12, timeoutMs: 120000 },
      requestedProtocol: { requireFixtureEachPhase: fixture.requireFixtureEachPhase === true, rejectPlaceholderValues: fixture.rejectPlaceholderValues === true,
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

function recordsFor(plan, { adopted = true, pluginCounts = [10, 10, 10] } = {}) {
  return plan.runs.map(run => {
    const root = run.directory, home = join(root, 'home')
    const config = { runId: `child-${run.runId}`, group: run.group, replay: plan.replay, model: plan.model, pricing: plan.pricing, workspace: join(root, 'workspace'),
      maxSteps: plan.taskBudget.maxSteps, maxCalls: plan.taskBudget.maxCalls, maxCostUSD: plan.taskBudget.maxCostUSD, tools: ['bash', 'read', 'grep'], instructionMaxBytes: 0, maxOutputTokens: 4096,
      policyInstallationOrder: ['compression-input', 'free-context-if-enabled', 'compression-output', 'native-spill', 'observer'], plugin: run.group === 'plugin', maxInlineTokens: run.group === 'baseline-default' ? 12500 : 1200,
      sessions: join(home, 'sessions'), spill: join(root, 'spill'), ledger: join(root, 'ledger.jsonl'), runtimePackage: join(plan.runtimeRoot, 'package.json'),
      testCommands: ['node --test test/json-codec.test.js', 'node --test --test-reporter=tap test/json-codec.test.js'],
      ...(plan.replay ? { replayProvider: join(repository, 'scripts/development-replay-provider.js'), controlSource: join(repository, 'test/fixtures/development/json-output-limit/control/json-codec.js') } : {}) }
    const task = { version: 'development-task-v1', fixtureId: plan.fixtureId, fixtureManifestHash: plan.fixtureManifestHash, configuration: config, timeoutMs: plan.taskBudget.timeoutMs,
      shutdownGraceMs: 6000, runtimeVersion: plan.runtimeVersion, runtimeLockHash: plan.runtimeLockHash, sourceTreeHash: plan.sourceTreeHash, patchHash: hash(buildDevelopmentProfile(config)) }
    const taskPlan = { ...task, manifestHash: digest(task) }
    const content = [{ type: 'text', text: 'compressed result' }], contentHash = digest(content)
    const calls = run.group === 'plugin' ? pluginCounts[run.repeat] : 20
    const events = [
      { type: 'compression/input', callId: 'tool-1', contentHash: 'f'.repeat(64), bytes: 200 },
      ...(adopted ? [{ type: 'decision', callId: 'tool-1', outcome: 'selected', strategy: 'json' }] : []),
      { type: 'compression/output', callId: 'tool-1', contentHash, bytes: 100 },
      { type: 'tool', callId: 'tool-1', contentHash, name: 'bash', testCommand: true, isError: false, exitCode: 1, sourceHash: plan.fixtureInitialSourceHash, valueHash: contentHash, finalValueHash: contentHash },
      { type: 'tool', callId: 'tool-2', contentHash, name: 'write', sourceHash: 'e'.repeat(64), valueHash: contentHash, finalValueHash: contentHash },
      { type: 'tool', callId: 'tool-3', contentHash, name: 'bash', testCommand: true, isError: false, exitCode: 0, sourceHash: 'e'.repeat(64), valueHash: contentHash, finalValueHash: contentHash },
      { type: 'model/start', id: 1, provider: plan.replay ? 'development-replay' : 'deepseek-official', model: plan.model, agentStep: 1, kind: 'agent', visibleToolResults: [{ callId: 'tool-1', contentHash }] },
      { type: 'model/end', id: 1, usage: { inputTokens: calls, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, finish: 'stop', complete: true },
      { type: 'process/exit', activeTools: [] },
    ].map(event => ({ ...event, manifestHash: taskPlan.manifestHash }))
    const accounting = reconcileDevelopmentLedger(events, { replay: plan.replay, pricing: plan.pricing, model: plan.model, manifestHash: taskPlan.manifestHash })
    const result = { task: plan.fixtureId, group: run.group, replay: plan.replay, plan: taskPlan, ...accounting, passed: true,
      verification: { passed: true, sourceChanged: true, protectedFilesIntact: true, sourceHash: 'e'.repeat(64), testRun: { tests: 9, passedTests: 9, failedTests: 0, exitCode: 0, stopReason: null } }, workflowOrdered: true, reproduced: true, retested: true, persistenceComplete: true, structuredValuesPreserved: true, stepsRecorded: true,
      cli: { cleaned: true, processGroupCleaned: true, escalated: false, exitCode: 0, stopReason: null }, steps: 1 }
    return { runId: run.runId, manifestHash: plan.manifestHash, taskPlan, result, ledgerText: events.map(JSON.stringify).join('\n'),
      sessionEvents: [...['tool-1', 'tool-2', 'tool-3'].map(toolCallId => ({ type: 'tool/result', data: { message: { toolCallId, content } } })),
        { type: 'step/start' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }],
      sourceAfter: { sourceTreeHash: plan.sourceTreeHash, runtimeLockHash: plan.runtimeLockHash, fixtureManifestHash: plan.fixtureManifestHash, runtimeVersion: plan.runtimeVersion }, elapsedMs: 100 }
  })
}


const usage = inputTokens => ({ inputTokens, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })
const config = group => ({ maxInlineTokens: group === 'baseline-default' ? 12500 : 1200, plugin: group === 'plugin', nativePolicyInstalledAfterPlugin: true, validationFeedbackLimit: 2, maxSteps: 12, timeoutMs: 120000 })
function calibrationRows(plan, run) {
  return run.groups.map(group => {
    const steps = group === 'plugin' ? 4 : 3
    const one = usage(group === 'plugin' ? 200 : 100)
    return { task: plan.calibration.fixture.id, group, pricing: plan.inputs.pricing, configuration: config(group), historyRetirement: plan.calibration.policy,
      passed: true, cleanup: { complete: true, failures: [] }, attempts: 0, replay: plan.inputs.replay, usageKind: plan.inputs.replay ? 'synthetic-replay' : 'provider-reported', usageComplete: true, steps, elapsedMs: 100,
      phaseResults: [{ actual: plan.calibration.fixture.expected, responseText: JSON.stringify(plan.calibration.fixture.expected), passed: true, freshAnswer: true, turnCompleted: true }],
      turnEnds: [{ kind: 'completed' }],
      toolCalls: [{ name: 'fixture', isError: false }, { name: 'read', isError: false, readOriginal: true, callId: 'read-original', phase: 0 },
        ...(group === 'plugin' ? [{ name: 'read', isError: false, readSnapshot: true, callId: 'read-snapshot', phase: 0 }] : [])],
      retirements: group === 'plugin' ? [{ reason: 'retired', beforeStep: 3, actualPostRetirementSteps: 2,
        economics: { minimumFutureRequests: 200, adopt: true, removedTokens: 1000, compressionCost: 0, expectedRecoveryCost: 0, cacheRebuildCost: .0001, safetyMargin: .25 } }] : [],
      modelCalls: Array.from({ length: steps }, (_, i) => ({ id: i + 1, agentStep: i + 1, kind: 'agent', complete: true, finish: 'stop',
        provider: plan.inputs.replay ? 'replay' : 'deepseek-official', model: 'model', usage: { ...one }, visibleToolResults: i === 3 ? [{ callId: 'read-snapshot' }] : [] })),
      usage: { ...one, inputTokens: one.inputTokens * steps, outputTokens: steps } }
  })
}
function attested(report) {
  const state = { sourceTreeHash: report.plan.inputs.provenance.sourceTreeHash, runtimes: report.plan.inputs.runtimes }
  const entries = [
    ...report.calibrationReports.flatMap(item => item.tasks.map(row => [`cal/${item.runId}/${row.group}`, row])),
    ...report.forecastTasks.map(row => [`forecast/${row.group}`, row]),
    ...report.benchmarkReport.results.map(row => [`benchmark/${row.runId}`, row]),
    ...report.developmentReport.records.map(row => [`development/${row.runId}`, row]),
  ]
  report.attestations = entries.map(([slotId, row]) => ({ slotId, started: true, before: structuredClone(state), after: structuredClone(state), resultHash: retirementEvidenceHash(row) }))
  report.heldoutPin = { runId: report.plan.calibration.heldoutRunId, expectedReportHash: retirementEvidenceHash(report.calibrationReports[3]) }
  return report
}
function bundle({ replay = false, adopted = false, pluginCounts, budgets = {} } = {}) {
  const plan = createAcceptanceBundlePlanV4({ ...inputs, replay, ...budgets })
  const calibrationReports = plan.calibration.runs.map(run => ({ evaluationKind: replay ? 'history-retirement-agent-replay' : 'history-retirement-live-agent', completed: true,
    runId: run.runId, model: provenance.model, provenance: plan.inputs.provenance, fixture: plan.calibration.fixture, fixtureHash: plan.calibration.fixtureHash,
    assumptions: plan.calibration.policy, policyHash: plan.calibration.policyHash, groupOrder: run.groups, tasks: calibrationRows(plan, run) }))
  let forecastTasks = []
  if (!replay) {
    const forecast = calibrateRetirementReports(calibrationReports.slice(0, 3))
    assert.equal(forecast.status, 'calibrated')
    forecastTasks = calibrationRows(plan, { groups: ['baseline-default', 'baseline-tuned', 'plugin'] }).map(row => ({ ...row,
      historyRetirement: { ...plan.calibration.policy, forecast: forecast.forecastConfig },
      retirements: row.group === 'plugin' ? [{ reason: 'economic-gate', economics: { minimumFutureRequests: forecast.minimumFutureRequests, expectedRecoveryCost: forecast.expectedRecoveryCost,
        adopt: false, removedTokens: 1000, compressionCost: 0, cacheRebuildCost: .0001, safetyMargin: .25 } }] : [] }))
  }
  const results = benchmarkRecords(plan.benchmarkPlan)
  if (replay) for (const row of results) {
    row.replay = true; row.usageKind = 'synthetic-replay'
    row.requestedProtocol.experimentalConfig = experimentalConfigV4(plan.benchmarkPlan.tasks.find(task => task.id === row.task), { replay, pricing }) ?? null
  }
  return attested({ evaluationKind: replay ? 'acceptance-bundle-v4-scripted-replay' : 'acceptance-bundle-v4-live-provider', plan, calibrationReports, forecastTasks, stoppedReason: null,
    ...(replay ? { forecastSkipped: 'scripted-replay-not-calibration-evidence' } : {}),
    benchmarkReport: { evaluationKind: replay ? 'acceptance-v4-scripted-replay' : 'acceptance-v4-live-provider', plan: plan.benchmarkPlan, results, pricing, provenance },
    developmentReport: { evaluationKind: replay ? 'development-study-scripted-replay' : 'development-study-live-provider', plan: plan.developmentPlan, records: recordsFor(plan.developmentPlan, { adopted, pluginCounts }) } })
}

test('pure root plan pins canonical 141 live / 138 replay slots, identities and budgets', () => {
  const caller = structuredClone(inputs)
  const plan = createAcceptanceBundlePlanV4(caller)
  assert.equal(plan.slots.length, 141)
  assert.equal(createAcceptanceBundlePlanV4({ ...inputs, replay: true }).slots.length, 138)
  assert.deepEqual(plan.slots.filter(slot => slot.kind === 'forecast').map(slot => slot.conditional), [true, true, true])
  assert.equal(plan.calibration.runs.length, 4)
  assert.deepEqual(plan.calibration.runs.slice(0, 3).map(run => run.groups), [
    ['baseline-default', 'baseline-tuned', 'plugin'], ['baseline-tuned', 'plugin', 'baseline-default'], ['plugin', 'baseline-default', 'baseline-tuned']])
  assert.equal(plan.benchmarkPlan.version, 4)
  assert.notEqual(plan.benchmarkPlan.manifestHash, createAcceptancePlanV3().manifestHash)
  assert.equal(plan.calibration.policy.minimumFutureRequests, 200)
  assert.equal(plan.calibration.policy.excerptCharacters, 64)
  assert.equal(plan.developmentPlan.runtimeLockHash, inputs.runtimes.cli.lockHash)
  for (const slot of plan.slots) assert.deepEqual(slot.budget, slot.kind === 'development'
    ? { maxCalls: 16, maxCostUSD: .05, maxSteps: 12, timeoutMs: 90000 }
    : { maxCalls: 14, maxCostUSD: .05, maxSteps: 12, timeoutMs: 120000 })
  caller.pricing.output = 99; caller.provenance.sourceTreeHash = '0'.repeat(64); caller.runtimes.agent.lockHash = '0'.repeat(64)
  assert.deepEqual(plan.inputs.pricing, pricing)
  assert.deepEqual(plan.inputs.provenance, provenance)
  assert.ok(Object.isFrozen(plan.inputs.runtimes.agent))
  assert.throws(() => { plan.slots.pop() }, TypeError)
  for (const override of [{ rootDir: repository }, { rootDir: join(repository, 'local') }, { rootDir: 'relative' }, { rootDir: '/tmp/x/../x' },
    { maxTotalCostUSD: 1.01 }, { maxTotalCalls: undefined }, { knownPriorSpendUSD: undefined }, { priorUnpricedCalls: -1 }, { replay: 'false' },
    { provenance: { ...provenance, runtimeLockHash: '0'.repeat(64) } }, { developmentIdentity: {} }, { pricing: null }]) {
    assert.throws(() => createAcceptanceBundlePlanV4({ ...inputs, ...override }), TypeError)
  }
})

test('independent full synthetic raw evidence passes with no development adoption required', () => {
  const report = bundle()
  const result = summarizeAcceptanceBundleV4(report)
  assert.equal(result.accepted, true, JSON.stringify(result))
  assert.equal(result.original.accepted, true)
  assert.equal(result.development.accepted, false)
  assert.equal(result.development.adoptionComplete, false)
  assert.equal(result.developmentComplete, true)
  assert.deepEqual(result.eligibleCounts, { 'baseline-default': 39, 'baseline-tuned': 39, plugin: 39 })
  assert.ok(result.eligibleNetSavingsUSD > 0)
  assert.ok(result.totalCostUSD > 0)
  assert.equal(result.priorUnpricedCalls, 1)
  assert.equal(result.knownLifetimeSpendUSD, result.knownPricedUsageUSD + inputs.knownPriorSpendUSD)
})

test('scripted replay covers 138 mandatory slots but proves no calibration, forecast or money', () => {
  const report = bundle({ replay: true })
  const result = summarizeAcceptanceBundleV4(report)
  assert.equal(result.replayComplete, true, JSON.stringify(result))
  assert.equal(result.accepted, false)
  assert.equal(result.forecast.status, 'declined')
  assert.equal(result.totalCostUSD, null)
  assert.equal(result.knownPricedUsageUSD, null)
  assert.equal(result.eligibleNetSavingsUSD, null)
  delete report.forecastSkipped
  assert.equal(summarizeAcceptanceBundleV4(report).replayComplete, false)
  report.forecastSkipped = 'scripted-replay-not-calibration-evidence'
  report.forecastTasks = [report.calibrationReports[0].tasks[0]]
  assert.equal(summarizeAcceptanceBundleV4(attested(report)).replayComplete, false)
})

test('cached child verdicts cannot rescue altered raw JSON, usage, protocols or versions', () => {
  for (const mutate of [
    r => { r.evaluationKind = 'acceptance-bundle-v4-scripted-replay' },
    r => { delete r.evaluationKind },
    r => { r.benchmarkReport.results[0].phaseResults[0].responseText = '```json\n{}\n```' },
    r => { r.calibrationReports[0].tasks[0].phaseResults[0].responseText = '{"revision":"wrong","checkpoint":0}' },
    r => { r.forecastTasks[0].phaseResults[0].actual.checkpoint = 1 },
    r => { r.benchmarkReport.results[0].modelCalls[0].usage.inputTokens++ },
    r => { r.benchmarkReport.results[0].requestedProtocol.responseSchemas = [] },
    r => { r.benchmarkReport.plan = createAcceptancePlanV3() },
    r => { r.benchmarkReport.evaluationKind = 'acceptance-v3-live-provider' },
    r => { r.developmentReport.records[0].sessionEvents = [] },
    r => { r.developmentReport.records[0].result.verification.testRun.passedTests = 8 },
    r => { r.developmentReport.records[0].ledgerText += '\ncorrupted-json' },
    r => { r.developmentReport.records[0].result.estimatedCostUSD = 0 },
  ]) {
    const report = structuredClone(bundle())
    mutate(report)
    report.accepted = true; report.rootAccepted = true; report.calibrated = true; report.runtimeForecastVerified = true
    report.benchmarkReport.accepted = true; report.developmentReport.accepted = true
    for (const row of report.benchmarkReport.results) { row.passed = true; row.responseSchemaSatisfied = true; row.exactFacts = true }
    assert.equal(summarizeAcceptanceBundleV4(attested(report)).accepted, false)
  }
})

test('attestations require exact ordered slots, started evidence, raw hashes and both runtime identities', () => {
  for (const mutate of [
    r => { r.attestations[0].before.sourceTreeHash = '0'.repeat(64) },
    r => { r.attestations[0].after.runtimes.cli.lockHash = '0'.repeat(64) },
    r => { r.attestations[0].after.runtimes.agent.version = '0.2.1-rc.1' },
    r => { r.attestations[0].before.runtimes.agent.root = '/different' },
    r => { r.attestations[0].resultHash = '0'.repeat(64) },
    r => { r.attestations[0].started = false },
    r => { r.attestations[0] = r.attestations[1] },
    r => { r.attestations.reverse() },
    r => { r.attestations.pop() },
    r => { r.attestations.push(r.attestations[0]) },
  ]) {
    const report = structuredClone(bundle())
    mutate(report)
    const result = summarizeAcceptanceBundleV4(report)
    assert.equal(result.accepted, false)
    assert.equal(result.attestationsComplete, false)
  }
  const report = structuredClone(bundle())
  report.plan.criteria.eligibleTasks = 1
  assert.equal(summarizeAcceptanceBundleV4(report).planValid, false)
})

test('training and heldout membership, ordering, pinning and <=2 horizon stay mandatory', () => {
  for (const mutate of [
    r => { r.calibrationReports.splice(1, 1) },
    r => { r.calibrationReports[3] = r.calibrationReports[0] },
    r => { r.calibrationReports[0].tasks.reverse() },
    r => { r.calibrationReports.reverse() },
    r => { r.calibrationReports[0].assumptions.minimumFutureRequests = 100 },
    r => { r.calibrationReports[0].fixture.query += ' altered' },
    r => { r.calibrationReports[0].provenance.repositoryCommit = '0'.repeat(40) },
    r => {
      const row = r.calibrationReports[3].tasks.find(task => task.group === 'plugin')
      row.steps = 5
      row.modelCalls.push({ ...structuredClone(row.modelCalls[3]), id: 5, agentStep: 5 })
      row.usage.inputTokens += row.modelCalls[4].usage.inputTokens; row.usage.outputTokens++
      row.retirements[0].actualPostRetirementSteps = 3
    },
  ]) {
    const report = structuredClone(bundle())
    mutate(report)
    assert.equal(summarizeAcceptanceBundleV4(attested(report)).accepted, false)
  }
  const report = bundle()
  report.heldoutPin.expectedReportHash = '0'.repeat(64)
  assert.equal(summarizeAcceptanceBundleV4(report).heldoutPinned, false)
})

test('forecast must actually load independently derived training evidence and tighten economics', () => {
  for (const mutate of [
    r => { r.forecastTasks = [] },
    r => { r.forecastTasks.reverse() },
    r => { delete r.forecastTasks[0].historyRetirement.forecast },
    r => { r.forecastTasks[0].historyRetirement.forecast.scope = 'forged' },
    r => { r.forecastTasks[2].retirements[0].reason = 'retired' },
    r => { r.forecastTasks[2].retirements[0].economics.adopt = true },
    r => { r.forecastTasks[2].retirements[0].economics.minimumFutureRequests = 200 },
    r => { r.forecastTasks[2].retirements[0].economics.expectedRecoveryCost = 0 },
    r => { r.forecastTasks[2].retirements[0].economics.removedTokens = 1e9 },
    r => { delete r.forecastTasks[2].retirements[0].economics.removedTokens },
    r => { delete r.forecastTasks[2].retirements[0].economics.safetyMargin },
    r => { r.forecastTasks[2].retirements[0].economics.removedTokens = 0 },
    r => { r.forecastTasks[2].retirements[0].economics.safetyMargin = .99 },
  ]) {
    const report = structuredClone(bundle())
    mutate(report)
    report.runtimeForecastVerified = true
    assert.equal(summarizeAcceptanceBundleV4(attested(report)).accepted, false)
  }
})

test('eligible combined net includes development losses and excludes stress/calibration/forecast expenses', () => {
  const smallLoss = summarizeAcceptanceBundleV4(bundle({ pluginCounts: [21, 21, 21] }))
  assert.ok(smallLoss.development.netSavingsVsTunedUSD < 0)
  assert.ok(smallLoss.eligibleNetSavingsUSD > 0)
  assert.equal(smallLoss.accepted, true)
  const largeLoss = summarizeAcceptanceBundleV4(bundle({ pluginCounts: [10000, 10000, 10000] }))
  assert.ok(largeLoss.benchmark.fullAccepted)
  assert.ok(largeLoss.development.qualityComplete && largeLoss.development.costComplete)
  assert.ok(largeLoss.eligibleNetSavingsUSD < 0)
  assert.equal(largeLoss.accepted, false)
  const report = structuredClone(bundle())
  const before = summarizeAcceptanceBundleV4(report)
  for (const row of report.benchmarkReport.results.filter(row => row.task === 'history-retirement-stress')) {
    row.usage.inputTokens += 1000; row.modelCalls[0].usage.inputTokens += 1000
  }
  const after = summarizeAcceptanceBundleV4(attested(report))
  assert.equal(after.eligibleNetSavingsUSD, before.eligibleNetSavingsUSD)
  assert.ok(after.totalCostUSD > before.totalCostUSD)
})

test('unknown usage, nonzero cache writes and every observed budget cap fail without losing known spend', () => {
  for (const mutate of [
    r => { r.benchmarkReport.results[0].modelCalls.push({ id: 2, kind: 'agent', complete: false, usage: null }) },
    r => { r.benchmarkReport.results[0].modelCalls[0].usage.cacheWriteTokens = 1; r.benchmarkReport.results[0].usage.cacheWriteTokens = 1 },
    r => { r.benchmarkReport.results[0].steps = 13 },
    r => { r.benchmarkReport.results[0].elapsedMs = 120001 },
    r => { const row = r.benchmarkReport.results[0]; row.usage.inputTokens = 200000; row.modelCalls[0].usage.inputTokens = 200000 },
    r => { const row = r.benchmarkReport.results[0]; for (let i = 1; i < 15; i++) row.modelCalls.push({ ...row.modelCalls[0], id: i + 1, usage: usage(0) }); row.usage.outputTokens += 14 },
    r => { r.stoppedReason = 'callback-exception' },
  ]) {
    const report = structuredClone(bundle())
    mutate(report)
    const result = summarizeAcceptanceBundleV4(attested(report))
    assert.equal(result.accepted, false)
    assert.ok(result.knownPricedUsageUSD > 0)
  }
  const report = structuredClone(bundle())
  report.benchmarkReport.results[0].modelCalls.push({ id: 2, kind: 'agent', complete: false, usage: null })
  const result = summarizeAcceptanceBundleV4(attested(report))
  assert.equal(result.totalCostUSD, null)
  assert.ok(result.knownPricedUsageUSD > 0)
})

test('malformed nested visibility rejects the bundle and preserves other and affected known charges', () => {
  const original = bundle()
  const baseline = summarizeAcceptanceBundleV4(original)
  const report = structuredClone(original)
  const record = report.developmentReport.records[0]
  const events = record.ledgerText.split('\n').filter(Boolean).map(JSON.parse)
  events.find(event => event.type === 'model/start').visibleToolResults = [null]
  record.ledgerText = events.map(JSON.stringify).join('\n')
  const result = summarizeAcceptanceBundleV4(attested(report))
  assert.equal(result.accepted, false)
  assert.equal(result.accountingComplete, false)
  assert.equal(result.totalCostUSD, null)
  assert.equal(result.knownPricedUsageUSD, baseline.knownPricedUsageUSD)
  const wrongKind = structuredClone(original)
  wrongKind.benchmarkReport.results[0].modelCalls[0].kind = 'damaged-kind-metadata'
  const damaged = summarizeAcceptanceBundleV4(attested(wrongKind))
  assert.equal(damaged.accountingComplete, false)
  assert.equal(damaged.knownPricedUsageUSD, baseline.knownPricedUsageUSD)
})

test('missing, extra, duplicate or reordered child slots cannot pass or double count known costs', () => {
  const original = bundle()
  const known = summarizeAcceptanceBundleV4(original).knownPricedUsageUSD
  for (const mutate of [
    r => { r.benchmarkReport.results.pop() },
    r => { r.benchmarkReport.results.push(r.benchmarkReport.results[0]) },
    r => { r.developmentReport.records.push(r.developmentReport.records[0]) },
    r => { r.benchmarkReport.results.reverse() },
  ]) {
    const report = structuredClone(original)
    mutate(report)
    const result = summarizeAcceptanceBundleV4(attested(report))
    assert.equal(result.accepted, false)
    assert.equal(result.coverageComplete, false)
    assert.ok(result.knownPricedUsageUSD <= known)
    assert.equal(result.totalCostUSD, null)
  }
})

test('heldout failure cannot rewrite the three-training forecast', () => {
  const report = structuredClone(bundle())
  const original = summarizeAcceptanceBundleV4(report)
  report.calibrationReports[3].tasks[0].phaseResults[0].responseText = '{}'
  const result = summarizeAcceptanceBundleV4(attested(report))
  assert.equal(result.trainingComplete, true)
  assert.equal(result.calibrationComplete, false)
  assert.equal(result.accepted, false)
  assert.deepEqual(result.forecast, original.forecast)
  assert.equal(result.forecastComplete, true)
})

test('valid usage on unfinished unique calls remains known while missing or duplicate identities cannot pass', () => {
  const original = bundle()
  const baseline = summarizeAcceptanceBundleV4(original)
  const unfinished = structuredClone(original)
  unfinished.benchmarkReport.results[0].modelCalls[0].complete = false
  const known = summarizeAcceptanceBundleV4(attested(unfinished))
  assert.equal(known.accountingComplete, false)
  assert.equal(known.totalCostUSD, null)
  assert.equal(known.knownPricedUsageUSD, baseline.knownPricedUsageUSD)
  for (const mutate of [
    row => { delete row.modelCalls[0].id },
    row => { row.modelCalls[0].id = 0 },
    row => { row.modelCalls.push(structuredClone(row.modelCalls[0])) },
    row => { row.steps = 2 },
    row => { row.modelCalls[0].agentStep = 0 },
    row => { row.modelCalls[0].kind = 'auxiliary' },
  ]) {
    const report = structuredClone(original)
    mutate(report.benchmarkReport.results[0])
    const result = summarizeAcceptanceBundleV4(attested(report))
    assert.equal(result.accountingComplete, false)
    assert.equal(result.accepted, false)
    assert.ok(result.knownPricedUsageUSD <= baseline.knownPricedUsageUSD)
  }
})

test('global observed cost and call budgets include all calibration, forecast and stress slots', () => {
  const report = structuredClone(bundle({ budgets: { maxTotalCostUSD: .05 } }))
  for (const row of report.benchmarkReport.results) {
    row.usage.inputTokens = row.group === 'plugin' ? 5000 : 10000
    row.modelCalls[0].usage.inputTokens = row.usage.inputTokens
  }
  const result = summarizeAcceptanceBundleV4(attested(report))
  assert.ok(result.checks.every(check => check.withinBudget))
  assert.ok(result.totalCostUSD > .05)
  assert.equal(result.budgetComplete, false)
  assert.equal(result.accepted, false)
  const calls = summarizeAcceptanceBundleV4(bundle({ budgets: { maxTotalCalls: 10 } }))
  assert.ok(calls.modelCalls > 10)
  assert.equal(calls.budgetComplete, false)
})

test('replay calibration still requires observed retirement and visible snapshot recovery', () => {
  for (const mutate of [
    row => { row.retirements = [] },
    row => { row.retirements[0].actualPostRetirementSteps = 3 },
    row => { row.toolCalls = row.toolCalls.filter(call => !call.readSnapshot) },
    row => { row.modelCalls.forEach(call => { call.visibleToolResults = [] }) },
  ]) {
    const report = structuredClone(bundle({ replay: true }))
    mutate(report.calibrationReports[0].tasks.find(row => row.group === 'plugin'))
    assert.equal(summarizeAcceptanceBundleV4(attested(report)).replayComplete, false)
  }
})


test('missing or failed Agent cleanup rejects acceptance without discarding known charges', () => {
  const original = bundle()
  const known = summarizeAcceptanceBundleV4(original).knownPricedUsageUSD
  for (const pick of [r => r.calibrationReports[0].tasks[0], r => r.forecastTasks[0], r => r.benchmarkReport.results[0]]) {
    for (const cleanup of [undefined, { complete: false, failures: [{ phase: 'directory-cleanup' }] }, { complete: true, failures: [{}] }, { complete: true }]) {
      const report = structuredClone(original)
      pick(report).cleanup = cleanup
      const result = summarizeAcceptanceBundleV4(attested(report))
      assert.equal(result.accepted, false)
      assert.equal(result.accountingComplete, false)
      assert.equal(result.totalCostUSD, null)
      assert.equal(result.knownPricedUsageUSD, known)
    }
  }
})

test('unquoted cache writes require explicit rejection policy, never a fabricated zero rate', () => {
  const { cacheWrite, ...unquoted } = pricing
  assert.throws(() => createAcceptanceBundlePlanV4({ ...inputs, pricing: unquoted }), /pricing/i)
  const explicit = { ...unquoted, cacheWritePolicy: 'reject-nonzero' }
  const plan = createAcceptanceBundlePlanV4({ ...inputs, pricing: explicit })
  assert.deepEqual(plan.inputs.pricing, explicit)
  assert.deepEqual(plan.developmentPlan.pricing, explicit)
  assert.equal(Object.hasOwn(plan.inputs.pricing, 'cacheWrite'), false)
  for (const cacheWritePolicy of ['zero', 'ignore', null]) {
    assert.throws(() => createAcceptanceBundlePlanV4({ ...inputs, pricing: { ...unquoted, cacheWritePolicy } }), /pricing/i)
  }
})


test('explicit task cost limits only tighten the original ceilings without changing coverage or quality gates', () => {
  const original = createAcceptanceBundlePlanV4(inputs)
  const tighter = createAcceptanceBundlePlanV4({ ...inputs, maxTaskCostUSD: .02 })
  assert.equal(Object.hasOwn(original.inputs, 'maxTaskCostUSD'), false)
  assert.equal(tighter.inputs.maxTaskCostUSD, .02)
  assert.deepEqual(tighter.slots.map(({ budget, ...slot }) => slot), original.slots.map(({ budget, ...slot }) => slot))
  for (const [index, slot] of tighter.slots.entries()) {
    assert.equal(slot.budget.maxCostUSD, .02)
    assert.deepEqual(slot.budget, { ...original.slots[index].budget, maxCostUSD: .02 })
  }
  assert.equal(tighter.developmentPlan.taskBudget.maxCostUSD, .02)
  assert.deepEqual(tighter.criteria, original.criteria)
  assert.deepEqual(tighter.calibration, original.calibration)
  assert.deepEqual(tighter.benchmarkPlan, original.benchmarkPlan)
  for (const maxTaskCostUSD of [0, -.01, .050001, Infinity, '0.02', null]) {
    assert.throws(() => createAcceptanceBundlePlanV4({ ...inputs, maxTaskCostUSD }), /tighten/)
  }
})

test('a fully metered truncated auxiliary call is priced but cannot satisfy experiment adoption', () => {
  const report = structuredClone(bundle())
  const row = report.benchmarkReport.results.find(row => row.task === 'experiment-task-independent' && row.group === 'plugin')
  row.adoptions = []
  row.experiments = [{ reason: 'unsuccessful-finish', llmCalled: true }]
  const extra = { ...structuredClone(row.modelCalls[0]), id: 2, kind: 'auxiliary', finish: 'max-tokens', usage: usage(20) }
  row.modelCalls.push(extra)
  row.usage.inputTokens += extra.usage.inputTokens
  row.usage.outputTokens += extra.usage.outputTokens
  const result = summarizeAcceptanceBundleV4(attested(report))
  assert.equal(result.accountingComplete, true)
  assert.ok(result.totalCostUSD > 0)
  assert.equal(result.totalCostUSD, result.knownPricedUsageUSD)
  assert.equal(result.benchmark.experimentalModesAccepted, false)
  assert.equal(result.accepted, false)
  for (const mutate of [
    call => { call.kind = 'agent' },
    call => { call.usage = null },
    call => { call.complete = false },
    call => { call.finish = 'unknown-finish' },
    call => { call.usage.cacheWriteTokens = 1 },
  ]) {
    const invalid = structuredClone(report)
    mutate(invalid.benchmarkReport.results.find(row => row.task === 'experiment-task-independent' && row.group === 'plugin').modelCalls[1])
    const rejected = summarizeAcceptanceBundleV4(attested(invalid))
    assert.equal(rejected.accountingComplete, false)
    assert.equal(rejected.totalCostUSD, null)
    assert.equal(rejected.accepted, false)
  }
})
