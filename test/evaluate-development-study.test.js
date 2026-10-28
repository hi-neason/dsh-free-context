import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDevelopmentStudyPlan, summarizeDevelopmentStudy, evaluateDevelopmentStudy } from '../scripts/evaluate-development-study.js'
import { buildDevelopmentProfile, reconcileDevelopmentLedger } from '../scripts/evaluate-development.js'

const repository = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const hash = value => createHash('sha256').update(value).digest('hex')
const digest = value => hash(JSON.stringify(value))
const prices = { currency: 'USD', model: 'model', sourceUrl: 'https://example.test/pricing', verifiedDate: '2026-10-28', ratePeriod: 'test', uncached: 1, cacheRead: .1, cacheWrite: 0, output: 2 }
const options = { directory: '/private/tmp/study', runtimeRoot: '/private/runtime', sourceTreeHash: 'a'.repeat(64), runtimeLockHash: 'b'.repeat(64), fixtureManifestHash: 'c'.repeat(64), fixtureValidationHash: '1'.repeat(64), fixtureInitialSourceHash: 'd'.repeat(64), replay: false, pricing: prices, maxTotalCostUSD: .5 }

function recordsFor(plan, { adopted = true, pluginCounts = [10, 10, 10] } = {}) {
  return plan.runs.map(run => {
    const root = run.directory, home = join(root, 'home')
    const config = { runId: `child-${run.runId}`, group: run.group, replay: plan.replay, model: plan.model, pricing: plan.pricing, workspace: join(root, 'workspace'),
      maxSteps: plan.taskBudget.maxSteps, maxCalls: plan.taskBudget.maxCalls, maxCostUSD: plan.taskBudget.maxCostUSD, tools: ['bash', 'read', 'grep'], instructionMaxBytes: 0, maxOutputTokens: 4096,
      policyInstallationOrder: ['compression-input', 'free-context-if-enabled', 'compression-output', 'native-spill', 'observer'], plugin: run.group === 'plugin', maxInlineTokens: run.group === 'baseline-default' ? 12500 : 1200,
      sessions: join(home, 'sessions'), spill: join(root, 'spill'), ledger: join(root, 'ledger.jsonl'), runtimePackage: join(plan.runtimeRoot, 'package.json'),
      testCommands: ['node --test test/json-codec.test.js', 'node --test --test-reporter=tap test/json-codec.test.js'],
      ...(plan.replay ? { replayProvider: join(repository, 'scripts/development-replay-provider.js'), controlSource: join(repository, 'test/fixtures/development/json-output-limit/control/json-codec.js') } : {}) }
    if (plan.readText) config.readText = { enabled: run.group === 'plugin', classifier: 'filesystem-host-v1', minimumSavingsRatio: 0.5, ...(plan.encodeArtifacts ? { encodeArtifacts: run.group === 'plugin' } : {}) }
    const task = { version: 'development-task-v1', fixtureId: plan.fixtureId, fixtureManifestHash: plan.fixtureManifestHash, byteBudgetValidation: { version: 'json-output-utf8-v1', cases: 82, validatorHash: plan.fixtureValidationHash }, configuration: config, timeoutMs: plan.taskBudget.timeoutMs,
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
      verification: { byteBudgetValidation: { version: 'json-output-utf8-v1', cases: 82, passedCases: 82, failedCases: 0, exitCode: 0, stopReason: null, cleaned: true, sourceHash: 'e'.repeat(64), validatorHash: plan.fixtureValidationHash, outputHash: '2'.repeat(64) }, passed: true, sourceChanged: true, protectedFilesIntact: true, sourceHash: 'e'.repeat(64), testRun: { tests: 9, passedTests: 9, failedTests: 0, exitCode: 0, stopReason: null } }, workflowOrdered: true, reproduced: true, retested: true, persistenceComplete: true, structuredValuesPreserved: true, stepsRecorded: true,
      cli: { cleaned: true, processGroupCleaned: true, escalated: false, exitCode: 0, stopReason: null }, steps: 1 }
    return { runId: run.runId, manifestHash: plan.manifestHash, taskPlan, result, ledgerText: events.map(JSON.stringify).join('\n'),
      sessionEvents: [...['tool-1', 'tool-2', 'tool-3'].map(toolCallId => ({ type: 'tool/result', data: { message: { toolCallId, content } } })),
        { type: 'step/start' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }],
      sourceAfter: { sourceTreeHash: plan.sourceTreeHash, runtimeLockHash: plan.runtimeLockHash, fixtureManifestHash: plan.fixtureManifestHash, fixtureValidationHash: plan.fixtureValidationHash, runtimeVersion: plan.runtimeVersion }, elapsedMs: 100 }
  })
}

test('development study freezes nine balanced runs and explicit budgets without retaining caller pricing', () => {
  const input = { ...options, pricing: { ...prices } }
  const plan = createDevelopmentStudyPlan(input)
  input.pricing.uncached = 999
  assert.equal(plan.pricing.uncached, 1)
  assert.equal(Object.isFrozen(plan.runs[0]), true)
  assert.deepEqual(plan.runs.map(run => run.group), ['baseline-default', 'baseline-tuned', 'plugin', 'baseline-tuned', 'plugin', 'baseline-default', 'plugin', 'baseline-default', 'baseline-tuned'])
  for (const change of [{ maxTotalCostUSD: undefined }, { maxTotalCostUSD: .01 }, { maxCalls: 0 }, { maxTotalCalls: 0 }, { replay: 'false' }, { pricing: null }, { sourceTreeHash: 'wrong' }]) assert.throws(() => createDevelopmentStudyPlan({ ...options, ...change }), TypeError)
})

test('independent study summary requires full quality, accounting, adoption and positive repeated savings', () => {
  const plan = createDevelopmentStudyPlan(options)
  const rows = recordsFor(plan)
  const result = summarizeDevelopmentStudy(plan, rows)
  assert.equal(result.accepted, true)
  assert.equal(result.qualityComplete, true)
  assert.equal(result.costComplete, true)
  assert.equal(result.adoptionComplete, true)
  assert.ok(result.netSavingsVsTunedUSD > 0)
  assert.ok(result.medianPairedSavingsUSD > 0)
  assert.equal(result.replayComplete, false)
  assert.equal(summarizeDevelopmentStudy(plan, recordsFor(plan, { adopted: false })).accepted, false)
  assert.equal(summarizeDevelopmentStudy(plan, rows.slice(0, 8)).accepted, false)
  const altered = structuredClone(plan); altered.criteria.actualAdoptionRequired = false
  assert.equal(summarizeDevelopmentStudy(altered, rows).planValid, false)
})

test('raw billing journal defeats summary tampering and preserves known costs on corruption and duplicates', () => {
  const plan = createDevelopmentStudyPlan(options)
  const rows = recordsFor(plan)
  const original = summarizeDevelopmentStudy(plan, rows)
  const changed = structuredClone(rows); changed[0].result.estimatedCostUSD = 0
  assert.equal(summarizeDevelopmentStudy(plan, changed).accountingComplete, false)
  const broken = structuredClone(rows); broken[0].ledgerText += '\ntruncated-json'
  const summary = summarizeDevelopmentStudy(plan, broken)
  assert.equal(summary.accepted, false)
  assert.equal(summary.costComplete, false)
  assert.equal(summary.knownPricedUsageUSD, original.knownPricedUsageUSD)
  const duplicates = summarizeDevelopmentStudy(plan, [...rows, rows[0]])
  assert.equal(duplicates.accepted, false)
  assert.equal(duplicates.knownPricedUsageUSD, original.knownPricedUsageUSD)
  const failed = structuredClone(rows); failed[0].result = null
  assert.ok(summarizeDevelopmentStudy(plan, failed).knownPricedUsageUSD > 0)
})

test('nested malformed visibility in a valid JSON journal fails without losing known task charges', () => {
  const plan = createDevelopmentStudyPlan(options)
  const rows = recordsFor(plan)
  const known = summarizeDevelopmentStudy(plan, rows).knownPricedUsageUSD
  const events = rows[0].ledgerText.split('\n').map(JSON.parse)
  events.find(event => event.type === 'model/start').visibleToolResults = [null]
  rows[0].ledgerText = events.map(JSON.stringify).join('\n')
  const result = summarizeDevelopmentStudy(plan, rows)
  assert.equal(result.accepted, false)
  assert.equal(result.accountingComplete, false)
  assert.equal(result.costComplete, false)
  assert.equal(result.knownPricedUsageUSD, known)
})

test('adoption requires a selected final hash in durable Session and a later request', () => {
  const plan = createDevelopmentStudyPlan(options)
  for (const mutate of [
    row => { row.sessionEvents = [] },
    row => { row.sessionEvents[0].data.message.content = [] },
    row => { const events = row.ledgerText.split('\n').map(JSON.parse); const request = events.findIndex(event => event.type === 'model/start'), tool = events.findIndex(event => event.type === 'tool'); [events[tool], events[request]] = [events[request], events[tool]]; row.ledgerText = events.map(JSON.stringify).join('\n') },
    row => { const events = row.ledgerText.split('\n').map(JSON.parse); events[0].contentHash = events.find(event => event.type === 'compression/output').contentHash; events[0].bytes = 100; row.ledgerText = events.map(JSON.stringify).join('\n') },
    row => { const events = row.ledgerText.split('\n').map(JSON.parse); events.find(event => event.type === 'compression/output').contentHash = '1'.repeat(64); row.ledgerText = events.map(JSON.stringify).join('\n') },
  ]) {
    const rows = recordsFor(plan)
    rows.filter(row => row.result.group === 'plugin').forEach(mutate)
    const result = summarizeDevelopmentStudy(plan, rows)
    assert.equal(result.adoptionComplete, false)
    assert.equal(result.accepted, false)
  }
})

test('source/configuration drift, cleanup failure and task quality failure cannot pass the study', () => {
  const plan = createDevelopmentStudyPlan(options)
  for (const mutate of [row => { row.sourceAfter.sourceTreeHash = 'f'.repeat(64) }, row => { row.result.cli.escalated = true },
    row => { row.result.passed = false }, row => { row.taskPlan.configuration.maxInlineTokens = 999 }, row => { row.taskPlan.configuration.maxOutputTokens = 1024 }, row => { row.result.verification.testRun.passedTests = 8 }]) {
    const rows = structuredClone(recordsFor(plan)); mutate(rows[0])
    assert.equal(summarizeDevelopmentStudy(plan, rows).accepted, false)
  }
})

test('independent step coverage rejects a forged flag, missing calls and invalid agent steps', () => {
  const plan = createDevelopmentStudyPlan(options)
  const extraStep = recordsFor(plan)
  extraStep[0].sessionEvents.push({ type: 'step/start' })
  extraStep[0].result.steps = 2
  assert.equal(summarizeDevelopmentStudy(plan, extraStep).qualityComplete, false)
  for (const agentStep of [0, 2]) {
    const rows = recordsFor(plan)
    const row = rows[0], events = row.ledgerText.split('\n').map(JSON.parse)
    events.find(event => event.type === 'model/start').agentStep = agentStep
    row.ledgerText = events.map(JSON.stringify).join('\n')
    Object.assign(row.result, reconcileDevelopmentLedger(events, { replay: false, pricing: plan.pricing, model: plan.model, manifestHash: row.taskPlan.manifestHash }))
    assert.equal(summarizeDevelopmentStudy(plan, rows).qualityComplete, false)
  }
})

test('aggregate profit cannot hide a negative paired median and raw task budgets remain enforced', () => {
  const plan = createDevelopmentStudyPlan(options)
  const summary = summarizeDevelopmentStudy(plan, recordsFor(plan, { pluginCounts: [1, 21, 21] }))
  assert.ok(summary.netSavingsVsTunedUSD > 0)
  assert.ok(summary.medianPairedSavingsUSD < 0)
  assert.equal(summary.accepted, false)
  const callsLimited = createDevelopmentStudyPlan({ ...options, maxTotalCalls: 8 })
  assert.equal(summarizeDevelopmentStudy(callsLimited, recordsFor(callsLimited)).withinBudget, false)
  assert.equal(summarizeDevelopmentStudy(plan, recordsFor(plan, { pluginCounts: [100000, 1, 1] })).withinBudget, false)
})

test('scripted studies can complete protocol coverage without ever reporting dollars or acceptance', () => {
  const plan = createDevelopmentStudyPlan({ ...options, replay: true })
  const summary = summarizeDevelopmentStudy(plan, recordsFor(plan))
  assert.equal(summary.replayComplete, true)
  assert.equal(summary.accepted, false)
  assert.equal(summary.costComplete, false)
  assert.equal(summary.observedCostUSD, null)
  assert.equal(summary.knownPricedUsageUSD, null)
  assert.equal(summary.netSavingsVsTunedUSD, null)
})

test('live studies cannot begin without explicit credentials or with relative directories', async () => {
  await assert.rejects(evaluateDevelopmentStudy({ directory: '/tmp/should-not-be-created-development-study', replay: false }), TypeError)
  await assert.rejects(evaluateDevelopmentStudy({ directory: 'relative' }), TypeError)
  for (const callback of ['onPlan', 'onTaskPlan', 'onResult']) await assert.rejects(evaluateDevelopmentStudy({ directory: '/tmp/not-created-invalid-study-callback', [callback]: true }), TypeError)
})

test('development plans accept unquoted writes only with an explicit reject-nonzero policy', () => {
  const { cacheWrite, ...unquoted } = prices
  assert.throws(() => createDevelopmentStudyPlan({ ...options, pricing: unquoted }), /pricing/i)
  const pricing = { ...unquoted, cacheWritePolicy: 'reject-nonzero' }
  const plan = createDevelopmentStudyPlan({ ...options, pricing })
  assert.deepEqual(plan.pricing, pricing)
  assert.equal(Object.hasOwn(plan.pricing, 'cacheWrite'), false)
  const rows = recordsFor(plan)
  const original = summarizeDevelopmentStudy(plan, rows)
  assert.equal(original.accepted, true) // fabricated validator transcripts only
  const row = rows[0], events = row.ledgerText.split('\n').map(JSON.parse)
  events.find(event => event.type === 'model/end').usage.cacheWriteTokens = 1
  row.ledgerText = events.map(JSON.stringify).join('\n')
  Object.assign(row.result, reconcileDevelopmentLedger(events, { replay: false, pricing, model: plan.model, manifestHash: row.taskPlan.manifestHash }))
  const unpriced = summarizeDevelopmentStudy(plan, rows)
  assert.equal(unpriced.accepted, false)
  assert.equal(unpriced.costComplete, false)
  assert.ok(unpriced.knownPricedUsageUSD > 0)
  assert.ok(unpriced.knownPricedUsageUSD < original.knownPricedUsageUSD)
  assert.throws(() => createDevelopmentStudyPlan({ ...options, pricing: { ...unquoted, cacheWritePolicy: 'ignore' } }), /pricing/i)
})

test('independent byte-budget evidence rejects forged success flags and binds validator and final source', () => {
  assert.throws(() => createDevelopmentStudyPlan({ ...options, fixtureValidationHash: undefined }), TypeError)
  const plan = createDevelopmentStudyPlan(options)
  for (const change of [null, { version: 'older' }, { cases: 81 }, { passedCases: 81 }, { failedCases: 1 }, { exitCode: 1 },
    { stopReason: 'timeout' }, { cleaned: false }, { sourceHash: '0'.repeat(64) }, { validatorHash: '0'.repeat(64) }, { outputHash: 'bad' }]) {
    const rows = recordsFor(plan)
    rows[0].result.verification.byteBudgetValidation = change === null ? null : { ...rows[0].result.verification.byteBudgetValidation, ...change, passed: true }
    const summary = summarizeDevelopmentStudy(plan, rows)
    assert.equal(summary.qualityComplete, false, JSON.stringify(change))
    assert.equal(summary.accepted, false)
    assert.equal(summary.costComplete, true)
  }
  for (const change of [null, { version: 'older' }, { cases: 81 }, { validatorHash: '0'.repeat(64) }, { extra: true }]) {
    const rows = recordsFor(plan)
    const task = rows[0].taskPlan
    task.byteBudgetValidation = change === null ? null : { ...task.byteBudgetValidation, ...change }
    const { manifestHash, ...body } = task
    task.manifestHash = digest(body)
    assert.equal(summarizeDevelopmentStudy(plan, rows).configurationComplete, false)
  }
  const rows = recordsFor(plan)
  delete rows[0].sourceAfter.fixtureValidationHash
  assert.equal(summarizeDevelopmentStudy(plan, rows).configurationComplete, false)
})


test('read packing is explicit, frozen, group-specific and independently matched', () => {
  const off = createDevelopmentStudyPlan(options)
  assert.equal(off.readText, false)
  assert.equal(Object.hasOwn(recordsFor(off)[0].taskPlan.configuration, 'readText'), false)
  assert.throws(() => createDevelopmentStudyPlan({ ...options, readText: 'true' }), TypeError)
  const plan = createDevelopmentStudyPlan({ ...options, readText: true })
  const rows = recordsFor(plan)
  assert.equal(summarizeDevelopmentStudy(plan, rows).accepted, true)
  for (const row of rows) assert.deepEqual(row.taskPlan.configuration.readText,
    { enabled: row.result.group === 'plugin', classifier: 'filesystem-host-v1', minimumSavingsRatio: 0.5 })
  for (const change of [null, { enabled: true }, { classifier: 'untrusted' }, { minimumSavingsRatio: 0 }]) {
    const changed = recordsFor(plan), task = changed[0].taskPlan
    if (change === null) delete task.configuration.readText
    else Object.assign(task.configuration.readText, change)
    task.patchHash = hash(buildDevelopmentProfile(task.configuration))
    const { manifestHash, ...body } = task
    task.manifestHash = digest(body)
    assert.equal(summarizeDevelopmentStudy(plan, changed).configurationComplete, false)
  }
})


test('artifact packing requires read packing and is bound to each independently checked task', () => {
  assert.equal(createDevelopmentStudyPlan(options).encodeArtifacts, false)
  for (const settings of [{ encodeArtifacts: true }, { readText: true, encodeArtifacts: 'true' }]) {
    assert.throws(() => createDevelopmentStudyPlan({ ...options, ...settings }), TypeError)
  }
  const plan = createDevelopmentStudyPlan({ ...options, readText: true, encodeArtifacts: true })
  const rows = recordsFor(plan)
  assert.equal(summarizeDevelopmentStudy(plan, rows).accepted, true)
  for (const row of rows) assert.deepEqual(row.taskPlan.configuration.readText,
    { enabled: row.result.group === 'plugin', classifier: 'filesystem-host-v1', minimumSavingsRatio: 0.5, encodeArtifacts: row.result.group === 'plugin' })
  for (const index of [0, 2]) {
    const changed = recordsFor(plan), task = changed[index].taskPlan
    delete task.configuration.readText.encodeArtifacts
    const { manifestHash, ...body } = task
    task.manifestHash = digest(body)
    assert.equal(summarizeDevelopmentStudy(plan, changed).configurationComplete, false)
  }
})
