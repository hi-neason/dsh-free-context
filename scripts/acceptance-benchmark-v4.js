import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { acceptanceFixturesV4 } from '../test/fixtures/acceptance/tasks-v4.js'
import { summarizePlannedAcceptance, price, validProvenance } from './acceptance-benchmark.js'
import { acceptanceCriteriaV2, createAcceptancePlanV2, acceptanceReplayAdapterV2 } from './acceptance-benchmark-v2.js'
import { safeFailure, summarizeUsage } from './evaluation-accounting.js'
import { phaseResponseSchema } from './evaluation-contract.js'
import { inspectOriginalCalibration } from './acceptance-evidence.js'
import { retirementDiscoveryAdapter } from '../test/fixtures/retirement-discovery-provider.js'
import { decodeLosslessText } from '../src/lossless-text.js'
import { formatSnapshotReference } from '../src/snapshot.js'

export const acceptanceCriteriaV4 = Object.freeze({ ...acceptanceCriteriaV2, version: 4,
  experimentalPairedMedianMustBePositive: true, experimentalAdmission: 'measured-trial',
  responseContract: 'Every phase declares a response schema; raw JSON, parsed values and exact source facts must independently agree. Identical bounded feedback for all groups.' })
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function deepFreeze(value, seen = new WeakSet()) {
  if (value && typeof value === 'object' && !seen.has(value)) {
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Evaluation checkpoints require plain data objects')
    seen.add(value)
    Object.values(value).forEach(item => deepFreeze(item, seen))
    Object.freeze(value)
  }
  return value
}
const frozenCopy = value => deepFreeze(structuredClone(value))
const experimentSettings = Object.freeze({ promptEncoding: 'auto', admission: 'measured-trial', mode: 'apply', tools: Object.freeze(['fixture']),
  maxInputBytes: 100000, maxPromptBytes: 120000, maxOutputBytes: 2000, maxOutputTokens: 400, maxArtifactBytes: 160000,
  timeoutMs: 30000, maxParagraphs: 1000, maxQueryBytes: 4096, maxCacheEntries: 8, maxCalls: 2,
  maxTotalCost: .03, maxCallCost: .02, comparatorTokenCap: 1200 })

export function createAcceptancePlanV4({ seed = 20261026 } = {}) {
  const previous = createAcceptancePlanV2({ seed })
  const tasks = acceptanceFixturesV4().map(({ answer, ...task }) => ({ ...task, sourceHash: hash(task.text) }))
  const plan = { version: 4, seed, criteria: acceptanceCriteriaV4, readText: true, encodeArtifacts: true, experimentSettings: { ...experimentSettings, tools: [...experimentSettings.tools] },
    experimentPricingSource: 'The complete report pricing and model supplied before execution; synthetic rates for replay only.', tasks, runs: previous.runs }
  return { ...plan, manifestHash: hash(plan) }
}

export function experimentalConfigV4(fixture, { replay = false, pricing } = {}) {
  if (!fixture.experiment) return undefined
  return { ...experimentSettings, tools: [...experimentSettings.tools], selectionMode: fixture.experiment,
    provider: replay ? 'replay' : 'deepseek-official', model: replay ? 'acceptance-selector-replay' : pricing?.model,
    pricing: { currency: 'USD', uncachedInputPerMillion: pricing?.uncached ?? .3, cacheReadPerMillion: pricing?.cacheRead ?? .006,
      ...(pricing?.cacheWrite === undefined ? { cacheWritePolicy: 'reject-nonzero' } : { cacheWritePerMillion: pricing.cacheWrite }), outputPerMillion: pricing?.output ?? 1.2 } }
}

function requestedProtocol(fixture, options) {
  return { readText: true, encodeArtifacts: true, requireFixtureEachPhase: fixture.requireFixtureEachPhase === true, rejectPlaceholderValues: fixture.rejectPlaceholderValues === true,
    discoverSourcePath: fixture.discoverSourcePath === true, ptc: fixture.ptc === true,
    requireSnapshot: fixture.requireSnapshot === true, requireReadEachPhase: fixture.requireReadEachPhase === true,
    responseSchemas: (fixture.phases ?? [fixture]).map(phase => phaseResponseSchema(fixture, phase) ?? null),
    historyRetirement: fixture.historyRetirement ?? null,
    experimentalConfig: experimentalConfigV4(fixture, options) ?? null }
}

export function acceptanceReplayAdapterV4(options) {
  if (options.fixture.discoverSourcePath === true && ['history-retirement-short', 'history-retirement-stress'].includes(options.fixture.id)) return retirementDiscoveryAdapter(options)
  let visibleDelivered = ''
  const adapter = acceptanceReplayAdapterV2({ ...options, delivered: () => visibleDelivered })
  const stream = adapter.stream.bind(adapter)
  // Auxiliary selection shares the adapter but must not advance the scripted
  // agent's fixture/read/answer sequence. Its usage is still emitted and charged.
  adapter.stream = async function* (request) {
    if (request.model === 'acceptance-selector-replay') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"selectedIds":["p1"]}' } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    // Test parsing only: derive the answer source from the actual visible tool
    // message, never from fixture.text, structured values or the filesystem.
    const message = request.messages?.filter(message => message.role === 'tool').at(-1)
    visibleDelivered = (message?.content ?? []).filter(block => block.type === 'text').map(block => {
      if (!block.text.startsWith('[dsh-lossless-text:')) return block.text
      const split = block.text.indexOf('\n\nOriginal tool-result snapshot: ')
      // Artifact representation is a complete self-contained frame with no
      // newly created receipt. Decode that entire frame strictly; never trim
      // unknown suffixes or recursively reinterpret decoded source markers.
      const decoded = decodeLosslessText(split < 0 ? block.text : block.text.slice(0, split))
      if (split >= 0) {
        const footer = block.text.slice(split + 2)
        const firstLine = footer.split('\n')[0]
        const receipt = JSON.parse(firstLine.slice('Original tool-result snapshot: '.length))
        const fields = ['sessionId', 'callId', 'toolName', 'sha256', 'bytes', 'locator', 'retrievalHint']
        if (!receipt || Object.keys(receipt).length !== fields.length || !fields.every(key => Object.hasOwn(receipt, key)) ||
            ['sessionId', 'callId', 'locator', 'retrievalHint'].some(key => typeof receipt[key] !== 'string' || !receipt[key].trim()) ||
            receipt.toolName !== 'read' || receipt.bytes !== Buffer.byteLength(decoded) ||
            receipt.sha256 !== createHash('sha256').update(decoded).digest('hex') ||
            formatSnapshotReference(receipt) !== footer) throw new TypeError('Invalid lossless read footer')
      }
      return decoded
    }).join('\n')
    yield* stream(request)
  }
  return adapter
}

export function summarizeAcceptanceV4(plan, results, options = {}) {
  const canonical = createAcceptancePlanV4({ seed: plan.seed })
  const overall = summarizePlannedAcceptance(canonical, plan, results, options)
  const summarizeTasks = tasks => {
    const subset = { ...canonical, tasks, runs: canonical.runs.filter(run => tasks.some(task => task.id === run.task)) }
    return summarizePlannedAcceptance(subset, subset, results.filter(run => tasks.some(task => task.id === run.task)), options)
  }
  const core = summarizeTasks(canonical.tasks.filter(task => task.tier === 'core'))
  const experimental = summarizeTasks(canonical.tasks.filter(task => task.tier === 'experimental'))
  const stress = summarizeTasks(canonical.tasks.filter(task => task.tier === 'quality-only'))
  const accountingComplete = overall.usageComplete && results.every(run => run.modelCalls.every(call =>
    call.complete === true && ['agent', 'auxiliary'].includes(call.kind) && (options.replay === true || price(summarizeUsage([call.usage]).usage, options.pricing) !== null)))
  const configurationComplete = overall.coverageComplete && results.every(run => {
    const fixture = canonical.tasks.find(task => task.id === run.task)
    return isDeepStrictEqual(run.configuration, { maxInlineTokens: run.group === 'baseline-default' ? 12500 : 1200,
      plugin: run.group === 'plugin', nativePolicyInstalledAfterPlugin: true, validationFeedbackLimit: 2,
      maxSteps: canonical.criteria.maxSteps, timeoutMs: canonical.criteria.timeoutMs,
      readText: { enabled: run.group === 'plugin', classifier: 'filesystem-host-v1', minimumSavingsRatio: 0.5, encodeArtifacts: run.group === 'plugin' } }) &&
      isDeepStrictEqual(run.requestedProtocol, requestedProtocol(fixture, options))
  })
  const lifecycleComplete = canonical.tasks.filter(task => task.historyRetirement).every(task => {
    const runs = results.filter(run => run.task === task.id && run.group === 'plugin')
    return runs.length === 3 && runs.every(run => task.expectedRetirement
      ? run.retirements?.some(record => record.reason === 'retired') && run.snapshotRecovered === true
      : !run.retirements?.some(record => record.reason === 'retired') && run.retirements?.some(record => record.reason === 'economic-gate' && record.economics?.adopt === false))
  })
  const fallbackComplete = canonical.tasks.filter(task => task.expectedFallback).every(task => {
    const runs = results.filter(run => run.task === task.id && run.group === 'plugin')
    return runs.length === 3 && runs.every(run => run.experiments?.some(record => record.reason === task.expectedFallback))
  })
  const modes = canonical.tasks.filter(task => task.experiment && task.adoptionRequired !== false).map(task => {
    const checked = summarizeTasks([task])
    const rows = results.filter(run => run.task === task.id)
    const paired = [0, 1, 2].map(repeat => {
      const cost = group => rows.filter(run => run.repeat === repeat && run.group === group).reduce((sum, run) => sum + price(run.usage, options.pricing), 0)
      return { repeat, netSavingsVsTunedUSD: checked.costComplete ? cost('baseline-tuned') - cost('plugin') : null }
    })
    const medianPairedSavingsUSD = checked.costComplete ? paired.map(pair => pair.netSavingsVsTunedUSD).sort((a, b) => a - b)[1] : null
    return { mode: task.experiment, task: task.id, ...checked, paired, medianPairedSavingsUSD,
      accepted: overall.planValid && accountingComplete && configurationComplete && checked.accepted && medianPairedSavingsUSD > 0 }
  })
  const experimentalModesAccepted = modes.length === 3 && modes.every(mode => mode.accepted)
  const modelCalls = results.reduce((sum, run) => sum + (run.modelCalls?.length ?? 0), 0)
  const totalCostUSD = overall.costComplete ? Object.values(overall.totals).reduce((sum, group) => sum + group.estimatedCostUSD, 0) : null
  const budgetComplete = modelCalls <= canonical.criteria.maxModelCalls && (options.replay === true || totalCostUSD !== null && totalCostUSD <= canonical.criteria.maxTotalCostUSD)
  const coreAccepted = overall.planValid && accountingComplete && configurationComplete && budgetComplete && core.accepted
  const fullAccepted = coreAccepted && overall.qualityComplete && overall.costComplete && lifecycleComplete && fallbackComplete && stress.qualityComplete && experimental.accepted && experimentalModesAccepted
  return { ...overall, accepted: fullAccepted, fullAccepted, coreAccepted, accountingComplete, configurationComplete, lifecycleComplete, fallbackComplete,
    experimentalModesAccepted, modes, core, experimental, stress, budgetComplete, totalCostUSD, modelCalls,
    correctionCount: results.reduce((total, run) => total + (run.correctionCount ?? 0), 0),
    replayComplete: options.replay === true && overall.replayComplete && accountingComplete && configurationComplete && lifecycleComplete && fallbackComplete && budgetComplete,
    claimBoundary: 'Fixed synthetic tasks with explicit opt-in measured-trial selection plus source and artifact read encoding; combined savings do not isolate the causal benefit of model selection. No default-admission or general workload savings claim. Stress recovery is excluded from savings gates. Full benchmark acceptance still requires separate comparable calibration/backtest evidence for all fourteen features.' }
}

export function originalAcceptanceV4(report, calibrationEvidence, negativeBacktest) {
  let benchmarkAccepted = false
  try {
    benchmarkAccepted = report?.evaluationKind === 'acceptance-v4-live-provider' &&
      summarizeAcceptanceV4(report.plan, report.results, { replay: false, pricing: report.pricing, provenance: report.provenance }).fullAccepted === true
  } catch {}
  const evidence = inspectOriginalCalibration(report, calibrationEvidence, negativeBacktest)
  return { accepted: benchmarkAccepted && evidence.calibrationEvidenceComplete && evidence.shortHorizonBacktestPassed,
    benchmarkAccepted, ...evidence,
    claimBoundary: 'Acceptance applies only to the frozen v4 benchmark with comparable calibration and independent negative backtest; measured-trial evidence is not a default-policy or general workload guarantee.' }
}

export async function evaluateAcceptanceV4({ seed = 20261026, replay = true, key, pricing, provenance, runner, onPlan, onResult } = {}) {
  if (typeof replay !== 'boolean') throw new TypeError('replay must be a boolean')
  if (!replay && (typeof key !== 'string' || !key.trim())) throw new TypeError('Explicit credential required')
  pricing = frozenCopy(pricing)
  provenance = frozenCopy(provenance)
  if (!replay && (price({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, pricing) === null || !validProvenance(provenance, pricing))) throw new TypeError('Complete pricing/runtime/model/source provenance required before execution')
  if (!replay && (typeof onPlan !== 'function' || typeof onResult !== 'function')) throw new TypeError('Live evaluation requires onPlan and onResult checkpoint functions')
  const plan = frozenCopy(createAcceptancePlanV4({ seed }))
  const fixtures = deepFreeze(acceptanceFixturesV4())
  await onPlan?.(deepFreeze({ plan, pricing, provenance }))
  const run = runner ?? (await import('./evaluate-agent.js')).runAgentFixture
  const results = []
  let cost = 0
  let calls = 0
  let stoppedReason = null
  for (const scheduled of plan.runs) {
    if (cost >= plan.criteria.maxTotalCostUSD || calls >= plan.criteria.maxModelCalls) { stoppedReason = 'budget'; break }
    const fixture = fixtures.find(task => task.id === scheduled.task)
    const protocol = deepFreeze(requestedProtocol(fixture, { replay, pricing }))
    let result
    try { result = await run(fixture, scheduled.group, { key, replay, prices: pricing, model: pricing?.model ?? 'deepseek-flash',
      experimentalConfig: protocol.experimentalConfig ?? undefined, historyRetirement: fixture.historyRetirement,
      composeWithTunedNative: true, validationFeedbackLimit: 2, adapterFactory: acceptanceReplayAdapterV4, readText: true, encodeArtifacts: true,
      maxSteps: plan.criteria.maxSteps, timeoutMs: plan.criteria.timeoutMs }) }
    catch (error) { result = { passed: false, usageComplete: false, failure: safeFailure(error), stoppedReason: 'runner-exception', replay, usageKind: replay ? 'synthetic-replay' : 'provider-reported' } }
    const record = frozenCopy({ ...result, ...scheduled, requestedProtocol: protocol, manifestHash: plan.manifestHash })
    results.push(record)
    await onResult?.(record, plan)
    calls += record.modelCalls?.length ?? 0
    const rawCalls = Array.isArray(record.modelCalls) ? record.modelCalls : []
    const observed = summarizeUsage(rawCalls.map(call => call?.usage))
    const ledgerComplete = record.usageComplete === true && observed.complete &&
      Object.entries(observed.usage).every(([field, total]) => record.usage?.[field] === total) &&
      rawCalls.every(call => call?.complete === true && ['agent', 'auxiliary'].includes(call.kind) &&
        (replay || call.provider === 'deepseek-official' && call.model === pricing.model && price(summarizeUsage([call.usage]).usage, pricing) !== null))
    const priced = replay ? 0 : price(observed.usage, pricing)
    if (!ledgerComplete || priced === null) { stoppedReason = record.stoppedReason === 'runner-exception' ? 'runner-exception' : 'incomplete-cost-accounting'; break }
    cost += priced
  }
  return { evaluationKind: replay ? 'acceptance-v4-scripted-replay' : 'acceptance-v4-live-provider', plan, results,
    pricing: pricing ?? null, provenance: provenance ?? null, stoppedReason, ...summarizeAcceptanceV4(plan, results, { replay, pricing, provenance }),
    limitations: ['Previous protocol failures remain independently retained.', 'Provider cache is uncontrolled despite balanced order.',
      'The frozen read policy measures combined model-selection, source and artifact read encoding costs; read encoding cannot substitute for actual auxiliary selection adoption.',
      'Budget checks occur between bounded tasks; an overshoot fails acceptance.', 'Replay cannot prove model quality or monetary savings.',
      'History stress assumes 1000 future requests solely to exercise retirement/recovery and is excluded from net-benefit acceptance.',
      'Measured-trial selection deliberately evaluates actual costs; it does not validate default economic admission.',
      'Requested protocol records bind the runner invocation, not cryptographic authentication of a provider transcript.'] }
}
