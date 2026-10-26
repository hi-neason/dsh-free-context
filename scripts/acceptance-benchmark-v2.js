import { createHash } from 'node:crypto'
import { acceptanceFixturesV2 } from '../test/fixtures/acceptance/tasks-v2.js'
import { groups, acceptanceCriteria, acceptanceReplayAdapter, summarizePlannedAcceptance, price, validProvenance } from './acceptance-benchmark.js'
import { safeFailure } from './evaluation-accounting.js'

export const acceptanceCriteriaV2 = Object.freeze({ ...acceptanceCriteria, version: 2, maxRuns: 117, maxModelCalls: 1404,
  validationFeedbackLimit: 2, nativeComposition: 'plugin-before-native-spill-1200', medianTaskSavingsMustBePositive: true,
  stressMonetaryEvidence: false, fullAcceptanceRequiresExperimentalAdoptionAndSavings: true })
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function createAcceptancePlanV2({ seed = 20261026 } = {}) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new TypeError('seed must be uint32')
  let state = seed || 1
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32 }
  const shuffle = values => { const copy = [...values]; for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]] } return copy }
  const tasks = acceptanceFixturesV2().map(({ answer, ...task }) => ({ ...task, sourceHash: hash(task.text) }))
  const orders = new Map(tasks.map(task => [task.id, shuffle(groups)]))
  const runs = []
  for (let repeat = 0; repeat < 3; repeat++) for (const task of shuffle(tasks)) for (let position = 0; position < 3; position++) {
    const group = orders.get(task.id)[(position + repeat) % 3]
    runs.push({ runId: `${task.id}/${repeat}/${group}`, task: task.id, repeat, position, group })
  }
  const plan = { version: 2, seed, criteria: acceptanceCriteriaV2, experimentAssumptions: { minimumFutureRequests: 1, expectedRecoveryCost: 0, safetyMargin: .25, maxCallCost: .02, maxCacheEntries: 8 }, tasks, runs }
  return { ...plan, manifestHash: hash(plan) }
}
export function summarizeAcceptanceV2(plan, results, options = {}) {
  const canonical = createAcceptancePlanV2({ seed: plan.seed })
  const overall = summarizePlannedAcceptance(canonical, plan, results, options)
  const tier = name => {
    const tasks = canonical.tasks.filter(task => task.tier === name)
    const subset = { ...canonical, tasks, runs: canonical.runs.filter(run => tasks.some(task => task.id === run.task)) }
    return summarizePlannedAcceptance(subset, subset, results.filter(run => tasks.some(task => task.id === run.task)), options)
  }
  const core = tier('core')
  const experimental = tier('experimental')
  const stress = tier('quality-only')
  const configurationComplete = overall.coverageComplete && results.every(run => run.configuration?.maxInlineTokens === (run.group === 'baseline-default' ? 12500 : 1200) && run.configuration?.nativePolicyInstalledAfterPlugin === true && run.configuration?.validationFeedbackLimit === 2)
  const lifecycleComplete = canonical.tasks.filter(task => task.historyRetirement).every(task => {
    const runs = results.filter(run => run.task === task.id && run.group === 'plugin')
    return runs.length === 3 && runs.every(run => task.expectedRetirement
      ? run.retirements?.some(record => record.reason === 'retired') && run.snapshotRecovered === true
      : !run.retirements?.some(record => record.reason === 'retired') && run.retirements?.some(record => record.reason === 'economic-gate' && record.economics?.adopt === false))
  })
  const fallbackComplete = canonical.tasks.filter(task => task.expectedFallback).every(task => results.filter(run => run.task === task.id && run.group === 'plugin').length === 3 && results.filter(run => run.task === task.id && run.group === 'plugin').every(run => run.experiments?.some(record => record.reason === task.expectedFallback)))
  const experimentalTaskSavingsPositive = experimental.costComplete && experimental.byTask.filter(row => canonical.tasks.find(task => task.id === row.task).adoptionRequired !== false).every(row => row.netSavingsVsTunedUSD > 0)
  const coreAccepted = overall.planValid && configurationComplete && core.accepted
  const fullAccepted = coreAccepted && overall.qualityComplete && overall.costComplete && lifecycleComplete && fallbackComplete && stress.qualityComplete && experimental.accepted && experimentalTaskSavingsPositive
  return { ...overall, accepted: fullAccepted, fullAccepted, coreAccepted, configurationComplete, lifecycleComplete, fallbackComplete, experimentalTaskSavingsPositive,
    core, experimental, stress, correctionCount: results.reduce((total, run) => total + (run.correctionCount ?? 0), 0),
    replayComplete: options.replay === true && overall.replayComplete && configurationComplete && lifecycleComplete && fallbackComplete,
    claimBoundary: 'Stress retirement tests recovery only and is excluded from both core and experimental savings gates. Core acceptance is not completion of all fourteen features.' }
}

export function acceptanceReplayAdapterV2(options) {
  const adapter = acceptanceReplayAdapter(options)
  const stream = adapter.stream.bind(adapter)
  let lastSnapshotRead
  adapter.stream = async function* (request) {
    if (options.fixture.historyRetirement && options.snapshotPath() && lastSnapshotRead !== options.snapshotPath()) {
      lastSnapshotRead = options.snapshotPath()
      const block = { type: 'tool-call', id: `history-read-${options.phase()}`, name: 'read', arguments: JSON.stringify({ file_path: lastSnapshotRead, offset: 1, limit: 1000 }) }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield* stream(request)
  }
  return adapter
}
export async function evaluateAcceptanceV2({ seed = 20261026, replay = true, key, pricing, provenance, runner, onResult } = {}) {
  if (!replay && (typeof key !== 'string' || !key.trim())) throw new TypeError('Explicit credential required')
  if (!replay && (price({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, pricing) === null || !validProvenance(provenance, pricing))) throw new TypeError('Complete pricing/runtime/model/source provenance required before execution')
  const plan = createAcceptancePlanV2({ seed })
  const fixtures = acceptanceFixturesV2()
  const run = runner ?? (await import('./evaluate-agent.js')).runAgentFixture
  const results = []
  let cost = 0
  let calls = 0
  let stoppedReason = null
  for (const scheduled of plan.runs) {
    if (cost >= plan.criteria.maxTotalCostUSD || calls >= plan.criteria.maxModelCalls) { stoppedReason = 'budget'; break }
    const fixture = fixtures.find(task => task.id === scheduled.task)
    const experimentalConfig = fixture.experiment ? { mode: 'apply', selectionMode: fixture.experiment, tools: ['fixture'], provider: replay ? 'replay' : 'deepseek-official', model: replay ? 'acceptance-selector-replay' : pricing.model,
      maxInputBytes: 100000, maxPromptBytes: 120000, maxOutputBytes: 2000, maxOutputTokens: 400, maxArtifactBytes: 160000, timeoutMs: 30000, maxParagraphs: 1000, maxQueryBytes: 4096, ...plan.experimentAssumptions,
      futureCacheReadPerMillion: pricing?.cacheRead ?? .006, pricing: { currency: 'USD', uncachedInputPerMillion: pricing?.uncached ?? .3, cacheReadPerMillion: pricing?.cacheRead ?? .006, outputPerMillion: pricing?.output ?? 1.2 } } : undefined
    let result
    try { result = await run(fixture, scheduled.group, { key, replay, prices: pricing, model: pricing?.model ?? 'deepseek-flash', experimentalConfig, historyRetirement: fixture.historyRetirement,
      composeWithTunedNative: true, validationFeedbackLimit: 2, adapterFactory: acceptanceReplayAdapterV2, maxSteps: plan.criteria.maxSteps, timeoutMs: plan.criteria.timeoutMs }) }
    catch (error) { result = { passed: false, usageComplete: false, failure: safeFailure(error), stoppedReason: 'runner-exception', replay, usageKind: replay ? 'synthetic-replay' : 'provider-reported' } }
    const record = { ...result, ...scheduled, manifestHash: plan.manifestHash }
    results.push(record)
    await onResult?.(record, plan)
    calls += record.modelCalls?.length ?? 0
    const priced = replay ? 0 : price(record.usage, pricing)
    if (!record.usageComplete || priced === null) { stoppedReason = record.stoppedReason === 'runner-exception' ? 'runner-exception' : 'incomplete-cost-accounting'; break }
    cost += priced
  }
  return { evaluationKind: replay ? 'acceptance-v2-scripted-replay' : 'acceptance-v2-live-provider', plan, results, pricing: pricing ?? null, provenance: provenance ?? null, stoppedReason,
    ...summarizeAcceptanceV2(plan, results, { replay, pricing, provenance }),
    limitations: ['Original v1 failed outcomes are retained independently.', 'Provider cache is uncontrolled despite balanced order.', 'Budget checks occur between bounded tasks; one task can overshoot the observed dollar threshold.', 'Replay cannot prove model quality or monetary savings.', 'History stress assumes 1000 future requests solely to exercise retirement/recovery; it is excluded from net-benefit acceptance.', 'Experimental horizon stays one remaining request; safe economic rejection does not prove experimental adoption or savings.'] }
}
