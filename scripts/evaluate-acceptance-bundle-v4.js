import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual as same } from 'node:util'
import { createAcceptanceBundlePlanV4, summarizeAcceptanceBundleV4 } from './acceptance-bundle-v4.js'
import { evaluateAcceptanceV4 } from './acceptance-benchmark-v4.js'
import { acceptanceSourceHash } from './acceptance-benchmark-cli.js'
import { evaluateDevelopmentStudy } from './evaluate-development-study.js'
import { loadDevelopmentFixture } from './development-fixtures.js'
import { calibrateRetirementReports, retirementEvidenceHash as hash } from './calibrate-retirement.js'
import { retirementDiscoveryFixtureV4 } from '../test/fixtures/acceptance/retirement-v4.js'
import { retirementDiscoveryAdapter } from '../test/fixtures/retirement-discovery-provider.js'
import { safeFailure } from './evaluation-accounting.js'

const repository = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
// Match evaluate-agent's module-scoped resolver. Never switch an already-loaded
// runtime by changing the environment halfway through this execution.
const environmentAgentRoot = resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime')
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const copy = value => freeze(structuredClone(value))
const durableCopy = value => freeze(JSON.parse(JSON.stringify(value)))
class BundleStop extends Error {
  constructor(reason) { super(reason); this.reason = reason }
}
const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex')

async function runtimeIdentity(root, kind) {
  const canonical = await realpath(root)
  const name = kind === 'agent' ? 'dsh-agent-loop-testkit' : 'dsh'
  const version = JSON.parse(await readFile(join(canonical, `node_modules/@deepseek-ai/${name}/package.json`), 'utf8')).version
  if (version !== '0.2.1-rc.2') throw new TypeError('Both official runtimes must be 0.2.1-rc.2')
  return { root: canonical, version, lockHash: bytesHash(await readFile(join(canonical, 'package-lock.json'))) }
}

/** Execute the frozen bundle with real official runtimes. No custom runner or
 * mutable context injection is exposed; callbacks observe durable checkpoints. */
export async function evaluateAcceptanceBundleV4({ rootDir, bundleId, seed = 20261026, replay = true, pricing = null,
  maxTotalCostUSD, maxTotalCalls, maxTaskCostUSD, knownPriorSpendUSD, priorUnpricedCalls,
  agentRuntimeRoot = environmentAgentRoot, cliRuntimeRoot = process.env.DSH_CLI_RUNTIME_ROOT ?? '.omx/cli-runtime',
  key, credentialFile, onPlan, onResult } = {}) {
  if (typeof replay !== 'boolean') throw new TypeError('replay must be a boolean')
  if (Number(process.versions.node.split('.')[0]) < 24 || process.platform === 'win32') throw new TypeError('Node 24 and POSIX are required')
  if (!isAbsolute(rootDir ?? '')) throw new TypeError('A new external absolute rootDir is required')
  if ([onPlan, onResult].some(callback => callback !== undefined && typeof callback !== 'function')) throw new TypeError('Checkpoint callbacks must be functions')
  if (!replay && ((key !== undefined) === (credentialFile !== undefined) || key !== undefined && (typeof key !== 'string' || !key.trim()) ||
    credentialFile !== undefined && (typeof credentialFile !== 'string' || !credentialFile.trim()))) throw new TypeError('Exactly one explicit live key or credentialFile required')
  const credentialPath = !replay && credentialFile !== undefined ? resolve(credentialFile) : undefined
  const settings = copy({ bundleId, seed, replay, pricing, maxTotalCostUSD, maxTotalCalls, knownPriorSpendUSD, priorUnpricedCalls, ...(maxTaskCostUSD === undefined ? {} : { maxTaskCostUSD }) })
  const repo = await realpath(repository)
  const root = join(await realpath(dirname(rootDir)), basename(rootDir))
  if (root === repo || root.startsWith(repo + sep)) throw new TypeError('Bundle directory must be outside the repository')
  const agentRoot = await realpath(resolve(agentRuntimeRoot))
  if (agentRoot !== await realpath(environmentAgentRoot) || resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime') !== environmentAgentRoot) throw new TypeError('Agent runtime must match the actual DSH_RUNTIME_ROOT resolver')
  const cliRoot = await realpath(resolve(cliRuntimeRoot))
  const capture = async () => {
    if (resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime') !== environmentAgentRoot) throw new BundleStop('runtime-resolver-drift')
    const [sourceTreeHash, agent, cli, fixture] = await Promise.all([
      acceptanceSourceHash(repository), runtimeIdentity(agentRoot, 'agent'), runtimeIdentity(cliRoot, 'cli'), loadDevelopmentFixture('json-output-limit'),
    ])
    return { state: { sourceTreeHash, runtimes: { agent, cli } },
      developmentIdentity: { fixtureManifestHash: fixture.manifestHash, fixtureInitialSourceHash: fixture.manifest.files['workspace/src/json-codec.js'].sha256 } }
  }
  const initial = await capture()
  const provenance = { runtimeVersion: initial.state.runtimes.agent.version, runtimeLockHash: initial.state.runtimes.agent.lockHash,
    repositoryCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(), sourceTreeHash: initial.state.sourceTreeHash,
    model: settings.pricing?.model ?? 'deepseek-flash', cacheCondition: 'shared-provider-cache-uncontrolled-counterbalanced' }
  const plan = createAcceptanceBundlePlanV4({ ...settings, rootDir: root, provenance, runtimes: initial.state.runtimes, developmentIdentity: initial.developmentIdentity })
  // mkdir is the write-once claim. An existing root fails before reading secrets.
  await mkdir(root, { mode: 0o700 })
  const write = (name, value) => writeFile(join(root, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  await write('bundle-plan.json', plan)
  await writeFile(join(root, 'bundle-journal.jsonl'), '', { flag: 'wx', mode: 0o600 })
  const journal = event => appendFile(join(root, 'bundle-journal.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 })
  const calibrationReports = [], forecastTasks = [], attestations = [], notStarted = [], benchmarkRows = [], developmentRows = []
  let benchmarkReport = null, developmentReport = null, heldoutPin = null, stoppedReason = null, pending = null
  let observedCalls = 0, observedCost = 0, calibrationIndex = 0
  const partial = () => ({ evaluationKind: replay ? 'acceptance-bundle-v4-scripted-replay' : 'acceptance-bundle-v4-live-provider', plan,
    calibrationReports, heldoutPin, forecastTasks,
    ...(replay ? { forecastSkipped: 'scripted-replay-not-calibration-evidence' } : {}),
    benchmarkReport: benchmarkReport ?? { evaluationKind: replay ? 'acceptance-v4-scripted-replay' : 'acceptance-v4-live-provider', plan: plan.benchmarkPlan,
      pricing: plan.inputs.pricing, provenance: plan.inputs.provenance, results: benchmarkRows, stoppedReason: stoppedReason ?? 'not-completed' },
    developmentReport: developmentReport ?? { evaluationKind: replay ? 'development-study-scripted-replay' : 'development-study-live-provider', plan: plan.developmentPlan,
      records: developmentRows, stoppedReason: stoppedReason ?? 'not-completed' },
    attestations, notStarted, stoppedReason })
  const stop = reason => { stoppedReason ??= reason; throw new BundleStop(stoppedReason) }
  const deny = async (slot, reason, before = null) => {
    const event = copy({ type: 'slot-not-started', slotId: slot.slotId, started: false, reason, before })
    notStarted.push(event)
    await journal(event)
    stop(reason)
  }
  const begin = async (slot, childPlan = null) => {
    if (stoppedReason) return deny(slot, stoppedReason)
    let captured
    try { captured = await capture() } catch { return deny(slot, 'source-or-runtime-drift') }
    if (!same(captured, initial)) return deny(slot, 'source-or-runtime-drift', captured.state)
    if (observedCalls + slot.budget.maxCalls > plan.inputs.maxTotalCalls || !replay && observedCost + slot.budget.maxCostUSD > plan.inputs.maxTotalCostUSD) return deny(slot, 'budget-reservation', captured.state)
    const event = copy({ type: 'slot-plan', slot, parentManifestHash: plan.manifestHash, before: captured.state, childPlan })
    await journal(event)
    pending = { slot, before: captured.state }
  }
  const finish = async (slot, raw) => {
    const started = pending?.slot.slotId === slot.slotId
    let after = null
    try {
      const captured = await capture()
      after = captured.state
      if (!same(captured, initial)) stoppedReason ??= 'source-or-runtime-drift'
    } catch { stoppedReason ??= 'source-or-runtime-drift' }
    const attestation = started ? copy({ slotId: slot.slotId, started: true, before: pending.before, after, resultHash: hash(raw) }) : null
    if (attestation) attestations.push(attestation)
    await journal({ type: 'slot-result', slotId: slot.slotId, started, record: raw, attestation })
    pending = null
    const checked = summarizeAcceptanceBundleV4(partial()).checks?.findLast(check => check.slotId === slot.slotId)
    if (!started) stoppedReason ??= 'task-not-started'
    if (slot.kind !== 'development' && raw.cleanup?.complete !== true) stoppedReason ??= 'agent-cleanup-unconfirmed'
    if (!checked?.complete) stoppedReason ??= 'incomplete-cost-accounting'
    if (checked) {
      observedCalls += checked.calls
      if (!replay && checked.cost !== null) observedCost += checked.cost
      if (!checked.withinBudget || observedCalls > plan.inputs.maxTotalCalls || !replay && observedCost > plan.inputs.maxTotalCostUSD) stoppedReason ??= 'budget-exceeded'
    }
    if (slot.kind === 'development' && (raw.result?.cli?.cleaned !== true || raw.result.cli.processGroupCleaned !== true || raw.result.cli.escalated !== false)) stoppedReason ??= 'tool-cleanup-unconfirmed'
    try { await onResult?.(copy(raw), slot, plan) } catch { stoppedReason ??= 'result-checkpoint-failed' }
    if (stoppedReason) stop(stoppedReason)
  }
  try {
    await journal({ type: 'bundle-plan', manifestHash: plan.manifestHash })
    try { await onPlan?.(plan) } catch { stop('plan-checkpoint-failed') }
    if (resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime') !== environmentAgentRoot) await deny(plan.slots[0], 'runtime-resolver-drift')
    const { runAgentFixture, agentCompletion, agentRuntimePackagePath } = await import('./evaluate-agent.js')
    let loadedAgentRoot
    try { loadedAgentRoot = await realpath(dirname(agentRuntimePackagePath)) } catch { await deny(plan.slots[0], 'runtime-module-mismatch') }
    if (loadedAgentRoot !== agentRoot) await deny(plan.slots[0], 'runtime-module-mismatch')
    if (credentialPath !== undefined) {
      try { key = (await readFile(credentialPath, 'utf8')).trim() } catch { stop('credential-read-failed') }
      if (!key) stop('credential-read-failed')
    }
    const agentOptions = policy => ({ key: replay ? undefined : key, model: plan.inputs.provenance.model, replay, prices: plan.inputs.pricing,
      historyRetirement: policy, maxSteps: 12, timeoutMs: 120000, composeWithTunedNative: true, validationFeedbackLimit: 2,
      adapterFactory: replay ? retirementDiscoveryAdapter : undefined })
    for (const scheduled of plan.calibration.runs) {
      const report = { evaluationKind: replay ? 'history-retirement-agent-replay' : 'history-retirement-live-agent', runId: scheduled.runId,
        model: plan.inputs.provenance.model, provenance: plan.inputs.provenance, fixture: plan.calibration.fixture, fixtureHash: plan.calibration.fixtureHash,
        assumptions: plan.calibration.policy, policyHash: plan.calibration.policyHash, groupOrder: scheduled.groups, completed: false, tasks: [] }
      calibrationReports.push(report)
      for (const group of scheduled.groups) {
        const slot = plan.slots.find(item => item.slotId === `cal/${scheduled.runId}/${group}`)
        await begin(slot)
        let raw
        try { raw = await runAgentFixture(retirementDiscoveryFixtureV4(), group, agentOptions(plan.calibration.policy)) }
        catch (error) { raw = { task: plan.calibration.fixture.id, group, replay, pricing: plan.inputs.pricing, modelCalls: [], usageComplete: false, failure: safeFailure(error), stoppedReason: 'runner-exception' } }
        const row = durableCopy(raw)
        report.tasks.push(row)
        await finish(slot, row)
      }
      const plugin = report.tasks.find(row => row.group === 'plugin')
      Object.assign(report, agentCompletion(report.tasks, { replay }))
      report.completed = report.completed && report.tasks.length === 3 && plugin.retirements?.some(row => row.reason === 'retired') && plugin.snapshotRecovered === true
      await write(`calibration-${calibrationIndex++}.json`, report)
      await journal({ type: 'calibration-report', runId: report.runId, report })
      if (scheduled.role === 'heldout') {
        heldoutPin = copy({ runId: report.runId, expectedReportHash: hash(report) })
        await write('heldout-pin.json', heldoutPin)
        await journal({ type: 'heldout-pin', ...heldoutPin })
      }
    }
    if (!replay) {
      const forecast = calibrateRetirementReports(calibrationReports.slice(0, 3))
      await journal({ type: 'training-forecast', forecast })
      if (forecast.status === 'calibrated') for (const slot of plan.slots.filter(item => item.kind === 'forecast')) {
        const policy = copy({ ...plan.calibration.policy, forecast: forecast.forecastConfig })
        await begin(slot, { historyRetirement: policy })
        let raw
        try { raw = await runAgentFixture(retirementDiscoveryFixtureV4(), slot.group, agentOptions(policy)) }
        catch (error) { raw = { task: plan.calibration.fixture.id, group: slot.group, replay, pricing: plan.inputs.pricing, modelCalls: [], usageComplete: false, failure: safeFailure(error), stoppedReason: 'runner-exception' } }
        const row = durableCopy(raw)
        forecastTasks.push(row)
        await finish(slot, row)
      }
    } else await journal({ type: 'forecast-skipped', reason: 'scripted-replay-not-calibration-evidence' })
    try {
      let scheduledIndex = 0
      benchmarkReport = await evaluateAcceptanceV4({ seed: plan.inputs.seed, replay, key: replay ? undefined : key,
        pricing: plan.inputs.pricing, provenance: plan.inputs.provenance,
        async onPlan(pinned) {
          if (!same(pinned, { plan: plan.benchmarkPlan, pricing: plan.inputs.pricing, provenance: plan.inputs.provenance })) stop('benchmark-plan-mismatch')
          await journal({ type: 'benchmark-plan', pinned })
        },
        async runner(fixture, group, options) {
          const scheduled = plan.benchmarkPlan.runs[scheduledIndex]
          if (scheduled?.task !== fixture.id || scheduled.group !== group) stop('benchmark-schedule-mismatch')
          await begin(plan.slots.find(slot => slot.slotId === `benchmark/${scheduled.runId}`))
          return runAgentFixture(fixture, group, options)
        },
        async onResult(raw) {
          const scheduled = plan.benchmarkPlan.runs[scheduledIndex++]
          const slot = plan.slots.find(item => item.slotId === `benchmark/${scheduled.runId}`)
          const row = durableCopy(raw)
          benchmarkRows.push(row)
          await finish(slot, row)
        },
      })
      await write('benchmark-report.json', benchmarkReport)
      if (benchmarkReport.stoppedReason) stop(benchmarkReport.stoppedReason)
    } catch (error) { stop(stoppedReason ?? (error instanceof BundleStop ? error.reason : 'benchmark-exception')) }
    try {
      developmentReport = await evaluateDevelopmentStudy({ directory: plan.developmentPlan.directory, runtimeRoot: cliRoot, replay,
        key: replay ? undefined : key, pricing: plan.inputs.pricing, maxTotalCostUSD: plan.inputs.maxTotalCostUSD,
        maxTotalCalls: plan.developmentPlan.maxTotalCalls, ...plan.developmentPlan.taskBudget, maxTaskCostUSD: plan.developmentPlan.taskBudget.maxCostUSD,
        async onPlan(child) {
          if (!same(child, plan.developmentPlan)) stop('development-plan-mismatch')
          await journal({ type: 'development-plan', plan: child })
        },
        async onTaskPlan(task, scheduled, study) {
          if (!same(study, plan.developmentPlan)) stop('development-plan-mismatch')
          const slot = plan.slots.find(item => item.slotId === `development/${scheduled.runId}`)
          if (!slot || scheduled.runId !== plan.developmentPlan.runs[developmentRows.length]?.runId) stop('development-schedule-mismatch')
          await begin(slot, task)
        },
        async onResult(raw) {
          const slot = plan.slots.find(item => item.slotId === `development/${raw.runId}`)
          if (!slot) stop('development-schedule-mismatch')
          const row = durableCopy(raw)
          developmentRows.push(row)
          await finish(slot, row)
        },
      })
      if (developmentReport.stoppedReason) stop(developmentReport.stoppedReason)
    } catch (error) { stop(stoppedReason ?? (error instanceof BundleStop ? error.reason : 'development-exception')) }
  } catch (error) {
    stoppedReason ??= error instanceof BundleStop ? error.reason : 'bundle-exception'
    await journal({ type: 'bundle-stopped', reason: stoppedReason, failure: safeFailure(error) })
  }
  const rawReport = partial()
  const report = durableCopy({ ...rawReport, ...summarizeAcceptanceBundleV4(rawReport) })
  await write('bundle-report.json', report)
  return report
}
