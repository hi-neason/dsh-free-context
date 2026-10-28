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
const options = { directory: '/private/tmp/study', runtimeRoot: '/private/runtime', sourceTreeHash: 'a'.repeat(64), runtimeLockHash: 'b'.repeat(64), fixtureManifestHash: 'c'.repeat(64), fixtureInitialSourceHash: 'd'.repeat(64), replay: false, pricing: prices, maxTotalCostUSD: .5 }

function recordsFor(plan, { adopted = true, pluginCounts = [10, 10, 10] } = {}) {
  return plan.runs.map(run => {
    const root = run.directory, home = join(root, 'home')
    const config = { runId: `child-${run.runId}`, group: run.group, replay: plan.replay, model: plan.model, pricing: plan.pricing, workspace: join(root, 'workspace'),
      maxSteps: plan.taskBudget.maxSteps, maxCalls: plan.taskBudget.maxCalls, maxCostUSD: plan.taskBudget.maxCostUSD, tools: ['bash', 'read', 'grep'], instructionMaxBytes: 0,
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
    row => { row.result.passed = false }, row => { row.taskPlan.configuration.maxInlineTokens = 999 }, row => { row.result.verification.testRun.passedTests = 8 }]) {
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
})
