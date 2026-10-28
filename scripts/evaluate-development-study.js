import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acceptanceSourceHash } from './acceptance-benchmark-cli.js'
import { loadDevelopmentFixture } from './development-fixtures.js'
import { buildDevelopmentProfile, inspectDevelopmentWorkflow, parseDevelopmentLedger, readDevelopmentSessionRecords, reconcileDevelopmentLedger, runDevelopmentTask } from './evaluate-development.js'
import { safeFailure } from './evaluation-accounting.js'
import { price } from './acceptance-benchmark.js'

const repository = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const hash = value => createHash('sha256').update(value).digest('hex')
const digest = value => hash(JSON.stringify(value) ?? 'undefined')
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const groups = ['baseline-default', 'baseline-tuned', 'plugin']
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const hashPattern = /^[a-f0-9]{64}$/
const withoutHash = ({ manifestHash, ...value }) => value

export function createDevelopmentStudyPlan({ directory, runtimeRoot, sourceTreeHash, runtimeLockHash, fixtureManifestHash, fixtureInitialSourceHash, replay = true, pricing = null,
  maxTotalCostUSD, maxTotalCalls = 144, maxSteps = 12, maxCalls = 16, maxTaskCostUSD = .05, timeoutMs = 90000 } = {}) {
  if (!isAbsolute(directory ?? '') || !isAbsolute(runtimeRoot ?? '') || ![sourceTreeHash, runtimeLockHash, fixtureManifestHash, fixtureInitialSourceHash].every(value => hashPattern.test(value ?? '')) || typeof replay !== 'boolean') throw new TypeError('Explicit paths and source hashes required')
  if (![maxTotalCalls, maxSteps, maxCalls, timeoutMs].every(Number.isSafeInteger) || maxTotalCalls < 1 || maxTotalCalls > 576 || maxSteps < 1 || maxSteps > 32 || maxCalls < 1 || maxCalls > 64 || timeoutMs < 1 || timeoutMs > 120000 ||
    !Number.isFinite(maxTaskCostUSD) || maxTaskCostUSD <= 0 || maxTaskCostUSD > 1 || !Number.isFinite(maxTotalCostUSD) || maxTotalCostUSD < maxTaskCostUSD || maxTotalCostUSD > 1) throw new TypeError('Explicit bounded study budgets required')
  pricing = structuredClone(pricing)
  if (!replay && (typeof pricing?.model !== 'string' || !pricing.model.trim() || price({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1 }, pricing) === null)) throw new TypeError('Complete model pricing required')
  const runs = []
  for (let repeat = 0; repeat < 3; repeat++) for (let position = 0; position < 3; position++) {
    const group = groups[(position + repeat) % 3]
    runs.push({ runId: `${repeat}-${group}`, repeat, position, group, directory: join(directory, `run-${repeat}-${group}`) })
  }
  const plan = { version: 'development-study-v1', fixtureId: 'json-output-limit', directory, runtimeRoot, runtimeVersion: '0.2.1-rc.2', sourceTreeHash, runtimeLockHash, fixtureManifestHash, fixtureInitialSourceHash,
    replay, pricing, model: replay ? 'scripted' : pricing.model, maxTotalCostUSD, maxTotalCalls,
    taskBudget: { maxSteps, maxCalls, maxCostUSD: maxTaskCostUSD, timeoutMs, shutdownGraceMs: 6000 }, runs,
    criteria: { repetitions: 3, qualityFailuresAllowed: 0, minimumNetSavingsUSD: 0, positivePairedMedianRequired: true, actualAdoptionRequired: true } }
  return freeze({ ...plan, manifestHash: digest(plan) })
}

function canonicalPlan(plan) {
  return createDevelopmentStudyPlan({ ...plan, ...plan.taskBudget, maxTaskCostUSD: plan.taskBudget.maxCostUSD })
}

function taskPlanMatches(plan, scheduled, task) {
  if (!task || task.version !== 'development-task-v1' || digest(withoutHash(task)) !== task.manifestHash) return false
  const config = task.configuration
  if (!config) return false
  const root = scheduled.directory, workspace = join(root, 'workspace'), home = join(root, 'home')
  const expected = { runId: config.runId, group: scheduled.group, replay: plan.replay, model: plan.model, pricing: plan.pricing, workspace,
    maxSteps: plan.taskBudget.maxSteps, maxCalls: plan.taskBudget.maxCalls, maxCostUSD: plan.taskBudget.maxCostUSD,
    tools: ['bash', 'read', 'grep'], instructionMaxBytes: 0, policyInstallationOrder: ['compression-input', 'free-context-if-enabled', 'compression-output', 'native-spill', 'observer'], plugin: scheduled.group === 'plugin', maxInlineTokens: scheduled.group === 'baseline-default' ? 12500 : 1200,
    sessions: join(home, 'sessions'), spill: join(root, 'spill'), ledger: join(root, 'ledger.jsonl'), runtimePackage: join(plan.runtimeRoot, 'package.json'),
    testCommands: ['node --test test/json-codec.test.js', 'node --test --test-reporter=tap test/json-codec.test.js'],
    ...(plan.replay ? { replayProvider: fileURLToPath(new URL('./development-replay-provider.js', import.meta.url)), controlSource: fileURLToPath(new URL('../test/fixtures/development/json-output-limit/control/json-codec.js', import.meta.url)) } : {}) }
  return typeof config.runId === 'string' && config.runId.length > 0 && same(config, expected) && task.fixtureId === plan.fixtureId && task.fixtureManifestHash === plan.fixtureManifestHash &&
    task.sourceTreeHash === plan.sourceTreeHash && task.runtimeLockHash === plan.runtimeLockHash && task.runtimeVersion === plan.runtimeVersion && task.timeoutMs === plan.taskBudget.timeoutMs &&
    task.shutdownGraceMs === plan.taskBudget.shutdownGraceMs && task.patchHash === hash(buildDevelopmentProfile(expected))
}

function inspectRecord(plan, scheduled, record) {
  const result = record.result
  const task = record.taskPlan
  const configured = record.runId === scheduled.runId && record.manifestHash === plan.manifestHash && result?.task === plan.fixtureId && result.group === scheduled.group && result.replay === plan.replay && taskPlanMatches(plan, scheduled, task) && same(task, result.plan)
  const parsed = parseDevelopmentLedger(typeof record.ledgerText === 'string' ? record.ledgerText : '')
  const accounting = reconcileDevelopmentLedger(parsed.events, { replay: plan.replay, pricing: plan.pricing, model: plan.model, manifestHash: task?.manifestHash,
    ledgerComplete: configured && parsed.errors.length === 0 && typeof record.ledgerText === 'string' })
  const accountingMatches = configured && ['modelCalls', 'modelEnds', 'usage', 'usageComplete', 'costComplete', 'estimatedCostUSD', 'knownPricedUsageUSD'].every(key => same(accounting[key], result[key]))
  const exits = parsed.events.filter(event => event.type === 'process/exit' && event.manifestHash === task?.manifestHash)
  const cleanup = exits.length === 1 && Array.isArray(exits[0].activeTools) && exits[0].activeTools.length === 0 && result?.cli?.cleaned === true && result.cli.processGroupCleaned === true && result.cli.escalated === false && result.cli.exitCode === 0 && result.cli.stopReason === null
  const tools = parsed.events.filter(event => event.type === 'tool')
  const workflow = inspectDevelopmentWorkflow(tools, plan.fixtureInitialSourceHash, result?.verification?.sourceHash)
  const sessions = Array.isArray(record.sessionEvents) ? record.sessionEvents : []
  const persisted = tools.length > 0 && tools.every(tool => sessions.some(row => row.type === 'tool/result' && row.data?.message?.toolCallId === tool.callId && digest(row.data.message.content) === tool.contentHash))
  const turns = sessions.filter(row => row.type === 'turn/end')
  const steps = sessions.filter(row => row.type === 'step/start').length
  const agents = accounting.modelCalls.filter(call => call.kind === 'agent')
  const stepCoverage = steps > 0 && agents.length >= steps && agents.every(call => call.agentStep >= 1 && call.agentStep <= steps) &&
    Array.from({ length: steps }, (_, i) => i + 1).every(step => agents.some(call => call.agentStep === step))
  const verified = result?.verification
  const quality = configured && cleanup && result.passed === true && verified?.passed === true && verified.sourceChanged === true && verified.protectedFilesIntact === true && hashPattern.test(verified.sourceHash ?? '') &&
    verified.testRun?.tests === 9 && verified.testRun.passedTests === 9 && verified.testRun.failedTests === 0 && verified.testRun.exitCode === 0 && verified.testRun.stopReason === null &&
    workflow.workflowOrdered && persisted && tools.every(tool => hashPattern.test(tool.valueHash ?? '') && tool.valueHash === tool.finalValueHash) &&
    turns.length > 0 && turns.every(row => row.data?.reason?.kind === 'completed') && stepCoverage && steps <= plan.taskBudget.maxSteps && result.steps === steps &&
    result.workflowOrdered === true && result.reproduced === true && result.retested === true && result.persistenceComplete === true && result.structuredValuesPreserved === true && result.stepsRecorded === true
  // A selected candidate can still fail final validation. Require a smaller,
  // changed return at the plugin boundary and its exact hash all the way to a
  // later model request. Native spill of that return is conservatively excluded.
  const adopted = configured && accounting.usageComplete && parsed.events.some((event, index) => {
    if (event.type !== 'compression/output' || !hashPattern.test(event.contentHash ?? '') || !Number.isSafeInteger(event.bytes) || event.bytes < 0) return false
    const inputs = parsed.events.slice(0, index).map((row, i) => ({ row, i })).filter(({ row }) => row.type === 'compression/input' && row.callId === event.callId)
    if (inputs.length !== 1) return false
    const { row: input, i } = inputs[0]
    return hashPattern.test(input.contentHash ?? '') && input.contentHash !== event.contentHash && Number.isSafeInteger(input.bytes) && input.bytes > event.bytes &&
      parsed.events.slice(i + 1, index).some(row => row.type === 'decision' && row.outcome === 'selected' && row.callId === event.callId) &&
      parsed.events.slice(index + 1).some((row, offset) => row.type === 'tool' && row.callId === event.callId && row.contentHash === event.contentHash &&
        sessions.some(saved => saved.type === 'tool/result' && saved.data?.message?.toolCallId === event.callId && digest(saved.data.message.content) === event.contentHash) &&
        parsed.events.slice(index + offset + 2).some(request => request.type === 'model/start' && request.visibleToolResults?.some(tool => tool.callId === event.callId && tool.contentHash === event.contentHash)))
  })
  const sourceAfterMatches = same(record.sourceAfter, { sourceTreeHash: plan.sourceTreeHash, runtimeLockHash: plan.runtimeLockHash, fixtureManifestHash: plan.fixtureManifestHash, runtimeVersion: plan.runtimeVersion })
  return { runId: scheduled.runId, group: scheduled.group, repeat: scheduled.repeat, configured, sourceAfterMatches, accountingMatches, quality, adopted,
    elapsedMs: Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0 ? record.elapsedMs : null, steps: result?.steps ?? null, ...accounting }
}

export function summarizeDevelopmentStudy(plan, records) {
  const canonical = canonicalPlan(plan)
  const planValid = same(plan, canonical)
  const ordered = records.length <= canonical.runs.length && records.every((record, i) => record.runId === canonical.runs[i].runId)
  const coverageComplete = ordered && records.length === canonical.runs.length
  const checked = records.map((record, i) => inspectRecord(canonical, canonical.runs.find(run => run.runId === record.runId) ?? canonical.runs[i % 9], record))
  const configurationComplete = planValid && ordered && checked.every(record => record.configured && record.sourceAfterMatches)
  const accountingComplete = configurationComplete && checked.length > 0 && checked.every(record => record.accountingMatches && record.usageComplete)
  const costComplete = coverageComplete && accountingComplete && !canonical.replay && checked.every(record => record.costComplete)
  const observedCostUSD = !canonical.replay && accountingComplete && checked.every(record => record.costComplete) ? checked.reduce((sum, record) => sum + record.estimatedCostUSD, 0) : null
  const known = new Map()
  checked.forEach((record, i) => {
    const id = records[i].taskPlan?.manifestHash
    if (hashPattern.test(id ?? '') && record.knownPricedUsageUSD !== null) {
      if (!known.has(id)) known.set(id, record.knownPricedUsageUSD)
      else if (known.get(id) !== record.knownPricedUsageUSD) known.set(id, null)
    }
  })
  const priced = [...known.values()].filter(cost => cost !== null)
  const knownPricedUsageUSD = priced.length ? priced.reduce((sum, cost) => sum + cost, 0) : null
  const callCount = checked.reduce((sum, record) => sum + record.modelCalls.length, 0)
  const withinBudget = configurationComplete && accountingComplete && callCount <= canonical.maxTotalCalls && checked.every(record => record.modelCalls.length <= canonical.taskBudget.maxCalls && (canonical.replay || record.estimatedCostUSD <= canonical.taskBudget.maxCostUSD)) &&
    (canonical.replay || observedCostUSD !== null && observedCostUSD <= canonical.maxTotalCostUSD)
  const qualityComplete = coverageComplete && configurationComplete && checked.every(record => record.quality)
  const adoptionComplete = coverageComplete && configurationComplete && checked.filter(record => record.group === 'plugin').every(record => record.adopted)
  const cost = (repeat, group) => costComplete ? checked.find(record => record.repeat === repeat && record.group === group).estimatedCostUSD : null
  const paired = [0, 1, 2].map(repeat => ({ repeat, tunedCostUSD: cost(repeat, 'baseline-tuned'), pluginCostUSD: cost(repeat, 'plugin'), netSavingsVsTunedUSD: costComplete ? cost(repeat, 'baseline-tuned') - cost(repeat, 'plugin') : null }))
  const netSavingsVsTunedUSD = costComplete ? paired.reduce((sum, pair) => sum + pair.netSavingsVsTunedUSD, 0) : null
  const medianPairedSavingsUSD = costComplete ? paired.map(pair => pair.netSavingsVsTunedUSD).sort((a, b) => a - b)[1] : null
  return { planValid, coverageComplete, configurationComplete, accountingComplete, costComplete, qualityComplete, adoptionComplete, withinBudget, callCount, observedCostUSD, knownPricedUsageUSD,
    paired, netSavingsVsTunedUSD, medianPairedSavingsUSD, checks: checked,
    replayComplete: canonical.replay && qualityComplete && accountingComplete && withinBudget,
    accepted: qualityComplete && costComplete && withinBudget && adoptionComplete && netSavingsVsTunedUSD > 0 && medianPairedSavingsUSD > 0,
    claimBoundary: 'One fixed historical development task. No adoption means no compression attribution; scripted replay cannot establish model repair or monetary benefit. This does not accept the original fourteen-feature bundle.' }
}

export async function evaluateDevelopmentStudy({ directory, runtimeRoot = process.env.DSH_CLI_RUNTIME_ROOT ?? '.omx/cli-runtime', key, onPlan, onTaskPlan, onResult, ...options } = {}) {
  if (!isAbsolute(directory ?? '') || options.replay === false && (typeof key !== 'string' || !key.trim())) throw new TypeError('New absolute study directory and explicit live credential required')
  if ([onPlan, onTaskPlan, onResult].some(callback => callback !== undefined && typeof callback !== 'function')) throw new TypeError('Study checkpoints must be functions')
  options = structuredClone(options)
  const root = join(await realpath(dirname(directory)), basename(directory)), repo = await realpath(repository)
  if (root === repo || root.startsWith(repo + sep)) throw new TypeError('Study directory must be outside the repository')
  const runtime = await realpath(resolve(runtimeRoot))
  const version = JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version
  if (version !== '0.2.1-rc.2') throw new Error('Unsupported official CLI runtime')
  const fixture = await loadDevelopmentFixture('json-output-limit')
  const plan = createDevelopmentStudyPlan({ ...options, directory: root, runtimeRoot: runtime, fixtureManifestHash: fixture.manifestHash, fixtureInitialSourceHash: fixture.manifest.files['workspace/src/json-codec.js'].sha256,
    sourceTreeHash: await acceptanceSourceHash(repository), runtimeLockHash: hash(await readFile(join(runtime, 'package-lock.json'))) })
  await mkdir(root, { mode: 0o700 })
  await writeFile(join(root, 'study-plan.json'), JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 })
  await writeFile(join(root, 'study-journal.jsonl'), '', { flag: 'wx', mode: 0o600 })
  await writeFile(join(root, 'study-task-plans.jsonl'), '', { flag: 'wx', mode: 0o600 })
  await onPlan?.(plan)
  const records = []
  let stoppedReason = null, spent = 0, calls = 0
  for (const scheduled of plan.runs) {
    if (calls + plan.taskBudget.maxCalls > plan.maxTotalCalls || !plan.replay && spent + plan.taskBudget.maxCostUSD > plan.maxTotalCostUSD) { stoppedReason = 'budget-reservation'; break }
    try {
      if (await acceptanceSourceHash(repository) !== plan.sourceTreeHash || hash(await readFile(join(runtime, 'package-lock.json'))) !== plan.runtimeLockHash) { stoppedReason = 'source-or-runtime-drift'; break }
    } catch { stoppedReason = 'source-or-runtime-drift'; break }
    let result, taskPlan, sourceAfter, failure, ledgerText = null, sessionEvents = null
    const startedAt = performance.now()
    try {
      result = await runDevelopmentTask(plan.fixtureId, scheduled.group, { ...plan.taskBudget, replay: plan.replay, key, pricing: plan.pricing, model: plan.model, directory: scheduled.directory, runtimeRoot: runtime,
        async onPlan(task) {
          if (!taskPlanMatches(plan, scheduled, task)) throw new Error('Nested task plan mismatch')
          taskPlan = task
          await appendFile(join(root, 'study-task-plans.jsonl'), JSON.stringify({ runId: scheduled.runId, manifestHash: plan.manifestHash, taskPlan: task }) + '\n', { mode: 0o600 })
          await onTaskPlan?.(task, scheduled, plan)
        }, onResult() {} })
    } catch (error) { failure = safeFailure(error) }
    try { ledgerText = await readFile(join(scheduled.directory, 'ledger.jsonl'), 'utf8') } catch {}
    try {
      const cli = (await readFile(join(scheduled.directory, 'cli.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
      sessionEvents = await readDevelopmentSessionRecords(join(scheduled.directory, 'home/sessions'), cli.find(row => row.type === 'session')?.sessionId)
    } catch {}
    try {
      sourceAfter = { sourceTreeHash: await acceptanceSourceHash(repository), runtimeLockHash: hash(await readFile(join(runtime, 'package-lock.json'))),
        fixtureManifestHash: (await loadDevelopmentFixture(plan.fixtureId)).manifestHash,
        runtimeVersion: JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version }
    } catch {}
    const record = freeze({ runId: scheduled.runId, manifestHash: plan.manifestHash, taskPlan: taskPlan ?? null, result: result ?? null, ledgerText, sessionEvents, sourceAfter: sourceAfter ?? null,
      elapsedMs: performance.now() - startedAt, ...(failure ? { failure } : {}) })
    records.push(record)
    await appendFile(join(root, 'study-journal.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 })
    await onResult?.(record, plan)
    const inspected = inspectRecord(plan, scheduled, record)
    if (!inspected.sourceAfterMatches) { stoppedReason = 'source-or-runtime-drift'; break }
    if (!inspected.configured || !inspected.accountingMatches || !inspected.usageComplete || !plan.replay && !inspected.costComplete) { stoppedReason = failure ? 'runner-exception' : 'incomplete-accounting-or-configuration'; break }
    calls += inspected.modelCalls.length
    spent += plan.replay ? 0 : inspected.estimatedCostUSD
    if (!result.cli.cleaned) { stoppedReason = 'tool-cleanup-unconfirmed'; break }
    if (calls > plan.maxTotalCalls || !plan.replay && (spent > plan.maxTotalCostUSD || inspected.estimatedCostUSD > plan.taskBudget.maxCostUSD)) { stoppedReason = 'budget-exceeded'; break }
  }
  const report = freeze({ evaluationKind: plan.replay ? 'development-study-scripted-replay' : 'development-study-live-provider', plan, records, stoppedReason, ...summarizeDevelopmentStudy(plan, records) })
  await writeFile(join(root, 'study-report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
  return report
}
