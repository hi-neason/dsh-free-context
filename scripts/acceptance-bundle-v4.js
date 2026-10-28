import { isDeepStrictEqual as same } from 'node:util'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcceptancePlanV4, summarizeAcceptanceV4, originalAcceptanceV4 } from './acceptance-benchmark-v4.js'
import { createDevelopmentStudyPlan, summarizeDevelopmentStudy } from './evaluate-development-study.js'
import { parseDevelopmentLedger, reconcileDevelopmentLedger } from './evaluate-development.js'
import { retirementDiscoveryFixtureV4, retirementDiscoveryPolicyV4 } from '../test/fixtures/acceptance/retirement-v4.js'
import { calibrateRetirementReports, inspectRetirementReport, retirementEvidenceHash as hash } from './calibrate-retirement.js'
import { phaseResponseSchema, responseSchemaIssues } from './evaluation-contract.js'
import { summarizeUsage, priceUsage } from './evaluation-accounting.js'
import { validEvaluationPricing, validProvenance } from './acceptance-benchmark.js'
import { assessNetBenefit } from '../src/economics.js'

const groups = ['baseline-default', 'baseline-tuned', 'plugin']
const repository = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const digest = /^[a-f0-9]{64}$/
const agentBudget = { maxCalls: 14, maxCostUSD: .05, maxSteps: 12, timeoutMs: 120000 }
const developmentBudget = { maxCalls: 16, maxCostUSD: .05, maxSteps: 12, timeoutMs: 90000 }
function freeze(value) {
  if (value && typeof value === 'object') {
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Bundle inputs require plain data')
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
const copy = value => freeze(structuredClone(value))
const attempt = (fn, fallback = null) => { try { return fn() } catch { return fallback } }
const configuration = group => ({ maxInlineTokens: group === 'baseline-default' ? 12500 : 1200, plugin: group === 'plugin', nativePolicyInstalledAfterPlugin: true, validationFeedbackLimit: 2, maxSteps: 12, timeoutMs: 120000 })

/** Pure prospective plan. Filesystem existence, realpath and write-once creation
 * are executor responsibilities; this checks lexical containment only. */
export function createAcceptanceBundlePlanV4({ rootDir, bundleId, seed = 20261026, replay = true, provenance, pricing = null,
  maxTotalCostUSD, maxTotalCalls, knownPriorSpendUSD, priorUnpricedCalls, runtimes, developmentIdentity } = {}) {
  if (!isAbsolute(rootDir ?? '') || resolve(rootDir) !== rootDir || rootDir === repository || rootDir.startsWith(repository + sep) ||
      typeof bundleId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(bundleId) || typeof replay !== 'boolean') throw new TypeError('Explicit external root, bundle identity and boolean replay required')
  if (!Number.isFinite(maxTotalCostUSD) || maxTotalCostUSD < .05 || maxTotalCostUSD > 1 || !Number.isSafeInteger(maxTotalCalls) || maxTotalCalls < 1 || maxTotalCalls > 1992 ||
      !Number.isFinite(knownPriorSpendUSD) || knownPriorSpendUSD < 0 || !Number.isSafeInteger(priorUnpricedCalls) || priorUnpricedCalls < 0) throw new TypeError('Explicit bounded budget and prior spend required')
  if (!validProvenance(provenance, pricing ?? { model: provenance?.model }) || typeof provenance?.model !== 'string' || !provenance.model.trim()) throw new TypeError('Complete provenance required')
  if (pricing !== null && !validEvaluationPricing(pricing) || !replay && pricing === null) throw new TypeError('Complete pricing required')
  if (!runtimes || !same(Object.keys(runtimes).sort(), ['agent', 'cli']) || Object.values(runtimes).some(runtime => !runtime || !same(Object.keys(runtime).sort(), ['lockHash', 'root', 'version']) ||
      !isAbsolute(runtime.root ?? '') || resolve(runtime.root) !== runtime.root || !digest.test(runtime.lockHash ?? '') || runtime.version !== '0.2.1-rc.2')) throw new TypeError('Both pinned rc.2 runtime identities required')
  if (provenance.runtimeLockHash !== runtimes.agent.lockHash) throw new TypeError('Agent provenance lock must match pinned runtime')
  if (!developmentIdentity || !same(Object.keys(developmentIdentity).sort(), ['fixtureInitialSourceHash', 'fixtureManifestHash']) || !Object.values(developmentIdentity).every(value => digest.test(value))) throw new TypeError('Historical development fixture identities required')
  const inputs = copy({ rootDir, bundleId, seed, replay, provenance, pricing, maxTotalCostUSD, maxTotalCalls, knownPriorSpendUSD, priorUnpricedCalls, runtimes, developmentIdentity })
  const { answer, ...fixture } = retirementDiscoveryFixtureV4()
  const calibration = { fixture, fixtureHash: hash(fixture), policy: retirementDiscoveryPolicyV4(),
    trainingRunIds: [0, 1, 2].map(index => `${bundleId}/training-${index}`), heldoutRunId: `${bundleId}/heldout` }
  calibration.policyHash = hash(calibration.policy)
  calibration.runs = [...calibration.trainingRunIds, calibration.heldoutRunId].map((runId, index) => ({ runId, role: index === 3 ? 'heldout' : 'training', groups: groups.map((_, position) => groups[(position + index) % 3]) }))
  const benchmarkPlan = createAcceptancePlanV4({ seed })
  const developmentPlan = createDevelopmentStudyPlan({ directory: join(rootDir, 'development'), runtimeRoot: runtimes.cli.root,
    sourceTreeHash: provenance.sourceTreeHash, runtimeLockHash: runtimes.cli.lockHash, ...developmentIdentity, replay, pricing,
    maxTotalCostUSD, maxTotalCalls: Math.min(maxTotalCalls, 144), ...developmentBudget, maxTaskCostUSD: developmentBudget.maxCostUSD })
  const slots = [
    ...calibration.runs.flatMap(run => run.groups.map(group => ({ slotId: `cal/${run.runId}/${group}`, kind: 'calibration', runId: run.runId, group, budget: agentBudget, conditional: false }))),
    ...(!replay ? groups.map(group => ({ slotId: `forecast/${group}`, kind: 'forecast', group, budget: agentBudget, conditional: true })) : []),
    ...benchmarkPlan.runs.map(run => ({ slotId: `benchmark/${run.runId}`, kind: 'benchmark', runId: run.runId, group: run.group, budget: agentBudget, conditional: false })),
    ...developmentPlan.runs.map(run => ({ slotId: `development/${run.runId}`, kind: 'development', runId: run.runId, group: run.group, budget: developmentBudget, conditional: false })),
  ]
  const plan = { version: 'acceptance-bundle-v4', inputs, calibration, benchmarkPlan, developmentPlan, slots,
    criteria: { qualityFailuresAllowed: 0, liveTasks: 141, replayTasks: 138, eligibleTasks: 117, eligibleRunsPerGroup: 39,
      developmentAdoptionRequired: false, minimumEligibleNetSavingsUSD: 0,
      calibrationHeldoutMaximumRemainingRequests: 2 } }
  return copy({ ...plan, manifestHash: hash(plan) })
}

const agentCleanupComplete = row => row?.cleanup?.complete === true && Array.isArray(row.cleanup.failures) && row.cleanup.failures.length === 0

function agentAccounting(row, plan) {
  const calls = Array.isArray(row?.modelCalls) ? row.modelCalls : []
  const observed = summarizeUsage(calls.map(call => call?.usage))
  const known = new Map()
  calls.forEach(call => {
    if (!Number.isSafeInteger(call?.id) || call.id < 1) return
    const amount = call.provider === 'deepseek-official' && call.model === plan.inputs.pricing?.model
      ? priceUsage(call.usage, plan.inputs.pricing) : null
    const id = call.id
    if (!known.has(id)) known.set(id, amount)
    else if (known.get(id) !== amount) known.set(id, null)
  })
  const complete = agentCleanupComplete(row) && Number.isSafeInteger(row?.steps) && row.steps > 0 && row.steps <= 12 &&
    Array.from({ length: row.steps }, (_, i) => i + 1).every(step => calls.some(call => call?.kind === 'agent' && call.agentStep === step)) &&
    row.usageComplete === true && calls.length > 0 && observed.complete && same(observed.usage, row.usage) &&
    calls.every((call, index) => call?.id === index + 1 && call.complete === true && ['stop', 'tool-calls'].includes(call.finish) &&
      Number.isSafeInteger(call.agentStep) && call.agentStep >= 1 && call.agentStep <= row.steps &&
      (index === 0 || call.agentStep >= calls[index - 1].agentStep) && ['agent', 'auxiliary'].includes(call.kind) &&
      (plan.inputs.replay || call.provider === 'deepseek-official' && call.model === plan.inputs.pricing.model && priceUsage(call.usage, plan.inputs.pricing) !== null)) &&
    same(row.pricing, plan.inputs.pricing) && row.replay === plan.inputs.replay && row.usageKind === (plan.inputs.replay ? 'synthetic-replay' : 'provider-reported')
  return { complete, calls: calls.length, cost: !plan.inputs.replay && complete ? priceUsage(observed.usage, plan.inputs.pricing) : null,
    known: plan.inputs.replay || ![...known.values()].some(value => value !== null) ? null : [...known.values()].filter(value => value !== null).reduce((sum, value) => sum + value, 0) }
}

function agentQuality(row, fixture) {
  return attempt(() => {
    const phases = fixture.phases ?? [fixture]
    return agentCleanupComplete(row) && row.task === fixture.id && row.phaseResults?.length === phases.length && row.phaseResults.every((phase, i) => phase.freshAnswer === true && phase.turnCompleted === true &&
      typeof phase.responseText === 'string' && same(JSON.parse(phase.responseText), phase.actual) && same(phase.actual, phases[i].expected) &&
      responseSchemaIssues(phase.actual, phaseResponseSchema(fixture, phases[i])).length === 0) &&
      row.attempts === 0 && !row.stoppedReason && row.turnEnds?.length > 0 && row.turnEnds.every(turn => turn.kind === 'completed') &&
      row.toolCalls?.some(call => call.name === 'fixture' && call.isError === false) &&
      row.toolCalls.some(call => call.name === 'read' && call.readOriginal === true && call.isError === false) &&
      (!row.retirements?.some(item => item.reason === 'retired') || row.toolCalls.some(call => call.name === 'read' && call.readSnapshot === true && call.isError === false)) &&
      Number.isSafeInteger(row.steps) && row.steps > 0 && row.steps <= 12
  }, false)
}

function observedRetirement(row) {
  return attempt(() => {
    const retired = row.retirements.filter(item => item.reason === 'retired')
    const reads = row.toolCalls.filter(call => call.name === 'read' && call.readSnapshot === true && call.isError === false && call.phase === 0 && typeof call.callId === 'string')
    return retired.length > 0 && retired.every(item => Number.isSafeInteger(item.beforeStep) && item.beforeStep >= 1 && item.beforeStep <= row.steps &&
      item.actualPostRetirementSteps === row.modelCalls.filter(call => call.kind === 'agent' && call.agentStep >= item.beforeStep).length) &&
      reads.length > 0 && row.modelCalls.some(call => call.visibleToolResults?.some(result => reads.some(read => read.callId === result.callId)))
  }, false)
}

function forecastEvidence(tasks, plan, forecast) {
  if (plan.inputs.replay) return tasks.length === 0
  if (forecast?.status !== 'calibrated' || tasks.length !== 3 || !same(tasks.map(row => row.group), groups)) return false
  const policy = { ...plan.calibration.policy, forecast: forecast.forecastConfig }
  return tasks.every(row => same(row.configuration, configuration(row.group)) && same(row.pricing, plan.inputs.pricing) &&
    same(row.historyRetirement, policy) && agentQuality(row, plan.calibration.fixture) && agentAccounting(row, plan).complete &&
    !row.retirements?.some(item => item.reason === 'retired') && (row.group !== 'plugin' || row.retirements?.some(item => {
      const e = item.economics
      if (item.reason !== 'economic-gate' || e?.adopt !== false || e.minimumFutureRequests !== Math.min(200, forecast.minimumFutureRequests) ||
          e.expectedRecoveryCost !== Math.max(plan.calibration.policy.expectedRecoveryCost, forecast.expectedRecoveryCost) ||
          !['removedTokens', 'compressionCost', 'cacheRebuildCost', 'expectedRecoveryCost', 'safetyMargin'].every(key => Number.isFinite(e[key]) && e[key] >= 0) ||
          !Number.isSafeInteger(e.removedTokens) || e.removedTokens <= 0 || e.safetyMargin !== plan.calibration.policy.safetyMargin) return false
      const decision = attempt(() => assessNetBenefit({ originalTokens: e.removedTokens, candidateTokens: 0, invalidatedPrefixTokens: 0,
        minimumFutureRequests: e.minimumFutureRequests, compressionCost: e.compressionCost + e.cacheRebuildCost,
        expectedRecoveryCost: e.expectedRecoveryCost, safetyMargin: e.safetyMargin, pricing: plan.calibration.policy.pricing }))
      return decision?.adopt === false && decision.reason === 'insufficient-net-benefit'
    })))
}

/** Recompute from child transcripts. Cached accepted/calibrated/root verdicts
 * are never authority. Missing or malformed evidence fails closed. */
export function summarizeAcceptanceBundleV4(report) {
  const plan = attempt(() => createAcceptanceBundlePlanV4(report?.plan?.inputs))
  if (!plan) return { accepted: false, replayComplete: false, planValid: false, totalCostUSD: null, knownPricedUsageUSD: null, reason: 'invalid-plan' }
  const planValid = same(report.plan, plan)
  const identityComplete = report.evaluationKind === (plan.inputs.replay ? 'acceptance-bundle-v4-scripted-replay' : 'acceptance-bundle-v4-live-provider')
  const calibrationReports = Array.isArray(report.calibrationReports) ? report.calibrationReports : []
  const forecastTasks = Array.isArray(report.forecastTasks) ? report.forecastTasks : []
  const benchmarkRows = Array.isArray(report.benchmarkReport?.results) ? report.benchmarkReport.results : []
  const developmentRows = Array.isArray(report.developmentReport?.records) ? report.developmentReport.records : []
  const entries = [
    ...calibrationReports.flatMap(item => (Array.isArray(item?.tasks) ? item.tasks : []).map(row => ({ slotId: `cal/${item.runId}/${row?.group}`, row }))),
    ...forecastTasks.map(row => ({ slotId: `forecast/${row?.group}`, row })),
    ...benchmarkRows.map(row => ({ slotId: `benchmark/${row?.runId}`, row })),
    ...developmentRows.map(row => ({ slotId: `development/${row?.runId}`, row })),
  ]
  const slots = new Map(plan.slots.map(slot => [slot.slotId, slot]))
  const coverageComplete = same(entries.map(entry => entry.slotId), plan.slots.map(slot => slot.slotId))
  const identity = { sourceTreeHash: plan.inputs.provenance.sourceTreeHash, runtimes: plan.inputs.runtimes }
  const attestations = Array.isArray(report.attestations) ? report.attestations : []
  const attestationsComplete = planValid && coverageComplete && attestations.length === entries.length && attestations.every((record, i) => record?.slotId === entries[i].slotId && record.started === true &&
    same(record.before, identity) && same(record.after, identity) && record.resultHash === hash(entries[i].row))
  const checks = entries.map(({ slotId, row }) => {
    const slot = slots.get(slotId)
    let accounting
    if (slot?.kind === 'development') {
      const ledger = parseDevelopmentLedger(typeof row.ledgerText === 'string' ? row.ledgerText : '')
      const a = reconcileDevelopmentLedger(ledger.events, { replay: plan.inputs.replay, pricing: plan.inputs.pricing, model: plan.developmentPlan.model,
        manifestHash: row.taskPlan?.manifestHash, ledgerComplete: typeof row.ledgerText === 'string' && ledger.errors.length === 0 })
      accounting = { complete: a.usageComplete && (plan.inputs.replay || a.costComplete), calls: a.modelCalls.length, cost: a.estimatedCostUSD, known: a.knownPricedUsageUSD }
    } else accounting = agentAccounting(row, plan)
    return { slotId, ...accounting, withinBudget: Boolean(slot && accounting.complete && accounting.calls <= slot.budget.maxCalls &&
      Number.isSafeInteger(slot.kind === 'development' ? row.result?.steps : row.steps) && (slot.kind === 'development' ? row.result.steps : row.steps) >= 1 &&
      (slot.kind === 'development' ? row.result.steps : row.steps) <= slot.budget.maxSteps && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && row.elapsedMs <= slot.budget.timeoutMs &&
      (plan.inputs.replay || accounting.cost !== null && accounting.cost <= slot.budget.maxCostUSD)), identity: slot?.kind === 'development' ? row.taskPlan?.manifestHash ?? slotId : slotId }
  })
  const known = new Map()
  checks.forEach(check => { if (!known.has(check.identity)) known.set(check.identity, check.known); else if (known.get(check.identity) !== check.known) known.set(check.identity, null) })
  const priced = [...known.values()].filter(value => value !== null)
  const knownPricedUsageUSD = !plan.inputs.replay && priced.length ? priced.reduce((sum, value) => sum + value, 0) : null
  const accountingComplete = coverageComplete && checks.every(check => check.complete)
  const totalCostUSD = !plan.inputs.replay && accountingComplete && checks.every(check => check.cost !== null) ? checks.reduce((sum, check) => sum + check.cost, 0) : null
  const modelCalls = checks.reduce((sum, check) => sum + check.calls, 0)
  const budgetComplete = accountingComplete && checks.every(check => check.withinBudget) && modelCalls <= plan.inputs.maxTotalCalls && (plan.inputs.replay || totalCostUSD !== null && totalCostUSD <= plan.inputs.maxTotalCostUSD)
  const calibrationChecks = calibrationReports.map((item, i) => attempt(() => {
    const run = plan.calibration.runs[i]
    return Boolean(run) && item?.runId === run.runId && item.evaluationKind === (plan.inputs.replay ? 'history-retirement-agent-replay' : 'history-retirement-live-agent') &&
      same(item.fixture, plan.calibration.fixture) && item.fixtureHash === plan.calibration.fixtureHash && same(item.assumptions, plan.calibration.policy) && item.policyHash === plan.calibration.policyHash &&
      same(item.provenance, plan.inputs.provenance) && item.model === plan.inputs.provenance.model && same(item.groupOrder, run.groups) && same(item.tasks?.map(row => row.group), run.groups) &&
      item.tasks.every(row => same(row.configuration, configuration(row.group)) && same(row.pricing, plan.inputs.pricing) && same(row.historyRetirement, plan.calibration.policy) && agentQuality(row, plan.calibration.fixture)) &&
      observedRetirement(item.tasks.find(row => row.group === 'plugin')) &&
      (plan.inputs.replay || inspectRetirementReport(item).status === 'validated')
  }, false))
  const trainingComplete = calibrationChecks.length >= 3 && calibrationChecks.slice(0, 3).every(Boolean)
  const calibrationComplete = calibrationChecks.length === 4 && calibrationChecks.every(Boolean)
  const forecast = !plan.inputs.replay && trainingComplete ? calibrateRetirementReports(calibrationReports.slice(0, 3)) : { status: 'declined', reason: plan.inputs.replay ? 'scripted-replay-not-calibration-evidence' : 'incomplete-calibration' }
  const forecastComplete = attempt(() => forecastEvidence(forecastTasks, plan, forecast), false) && (!plan.inputs.replay || report.forecastSkipped === 'scripted-replay-not-calibration-evidence')
  const heldout = calibrationReports[3]
  const heldoutPinned = report.heldoutPin?.runId === plan.calibration.heldoutRunId && report.heldoutPin.expectedReportHash === hash(heldout)
  const benchmarkIdentity = same(report.benchmarkReport?.plan, plan.benchmarkPlan) && same(report.benchmarkReport?.pricing, plan.inputs.pricing) && same(report.benchmarkReport?.provenance, plan.inputs.provenance) &&
    report.benchmarkReport?.evaluationKind === (plan.inputs.replay ? 'acceptance-v4-scripted-replay' : 'acceptance-v4-live-provider') && !report.benchmarkReport?.stoppedReason
  const benchmark = attempt(() => summarizeAcceptanceV4(plan.benchmarkPlan, benchmarkRows, { replay: plan.inputs.replay, pricing: plan.inputs.pricing, provenance: plan.inputs.provenance }))
  const original = attempt(() => originalAcceptanceV4(report.benchmarkReport, { reports: calibrationReports.slice(0, 3), expectedRunIds: plan.calibration.trainingRunIds },
    heldoutPinned ? { report: heldout, expectedReportHash: report.heldoutPin.expectedReportHash } : undefined))
  const developmentIdentity = same(report.developmentReport?.plan, plan.developmentPlan) && report.developmentReport?.evaluationKind === (plan.inputs.replay ? 'development-study-scripted-replay' : 'development-study-live-provider') && !report.developmentReport?.stoppedReason
  const development = attempt(() => summarizeDevelopmentStudy(plan.developmentPlan, developmentRows))
  const developmentComplete = developmentIdentity && ['coverageComplete', 'configurationComplete', 'accountingComplete', 'qualityComplete', 'withinBudget'].every(key => development?.[key] === true) && (plan.inputs.replay || development.costComplete)
  const eligible = benchmarkRows.filter(row => plan.benchmarkPlan.tasks.some(task => task.id === row?.task && task.tier !== 'quality-only')).map(row => ({ group: row.group, cost: agentAccounting(row, plan).cost }))
  for (const check of development?.checks ?? []) eligible.push({ group: check.group, cost: check.estimatedCostUSD })
  const eligibleCounts = Object.fromEntries(groups.map(group => [group, eligible.filter(row => row.group === group).length]))
  const eligibleCostComplete = !plan.inputs.replay && eligible.length === 117 && Object.values(eligibleCounts).every(count => count === 39) && eligible.every(row => row.cost !== null && Number.isFinite(row.cost))
  const eligibleCosts = Object.fromEntries(groups.map(group => [group, eligibleCostComplete ? eligible.filter(row => row.group === group).reduce((sum, row) => sum + row.cost, 0) : null]))
  const eligibleNetSavingsUSD = eligibleCostComplete ? eligibleCosts['baseline-tuned'] - eligibleCosts.plugin : null
  const eligibleSavingsAccepted = eligibleCostComplete && eligibleNetSavingsUSD > 0
  const common = planValid && identityComplete && coverageComplete && attestationsComplete && accountingComplete && budgetComplete && calibrationComplete && heldoutPinned && forecastComplete && benchmarkIdentity && developmentComplete && !report.stoppedReason
  return { planValid, identityComplete, coverageComplete, attestationsComplete, accountingComplete, budgetComplete, trainingComplete, calibrationComplete, heldoutPinned, forecastComplete, benchmarkIdentity, developmentComplete,
    accepted: !plan.inputs.replay && common && original?.accepted === true && eligibleSavingsAccepted,
    replayComplete: plan.inputs.replay && common && benchmark?.replayComplete === true && development?.replayComplete === true,
    benchmark, original, development, forecast, checks, modelCalls, totalCostUSD, knownPricedUsageUSD,
    knownPriorSpendUSD: plan.inputs.knownPriorSpendUSD, priorUnpricedCalls: plan.inputs.priorUnpricedCalls,
    knownLifetimeSpendUSD: !plan.inputs.replay && knownPricedUsageUSD !== null ? plan.inputs.knownPriorSpendUSD + knownPricedUsageUSD : null,
    eligibleCounts, eligibleCosts, eligibleNetSavingsUSD, eligibleSavingsAccepted,
    claimBoundary: 'Fixed v4 bundle only; replay never proves calibration, runtime forecast or monetary benefit. Per-task limits are observed ceilings, not a guarantee against single-request overshoot. Historical unpriced calls remain unknown.' }
}
