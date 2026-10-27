import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { acceptanceFixturesV2 } from '../test/fixtures/acceptance/tasks-v2.js'
import { groups, acceptanceCriteria, acceptanceReplayAdapter, summarizePlannedAcceptance, price, validProvenance } from './acceptance-benchmark.js'
import { safeFailure } from './evaluation-accounting.js'
import { parseExperimentConfig } from '../src/experiment-config.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const recoveryInstruction = ' Use read or grep on the immutable original file if the delivered result lacks evidence. Never guess, return UNKNOWN/null, or infer facts absent from evidence. A snapshot may be used when supplied.'
export const diagnosticTrialCriteria = freeze({ ...acceptanceCriteria, version: 'diagnostic-trial-v1', maxRuns: 18, maxModelCalls: 468, maxTotalCostUSD: .12, validationFeedbackLimit: 2, nativeComposition: 'plugin-before-native-spill-1200', claimScope: 'declared-long-compiler-task-only' })
const sources = Object.freeze({ 'invalid.c': 'int main(void) { return missing_identifier; }\n', 'warning.c': 'int main(void) { int unused_local; return 0; }\n' })
const compilerArgs = name => ['-fsyntax-only', '-Wall', '-fno-color-diagnostics', name]

/** Actual local compiler output; no padding, transformed diagnostics, or synthetic noise. */
export async function captureClangControl({ compiler = '/usr/bin/clang' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-diagnostic-control-'))
  const execute = promisify(execFile)
  try {
    const { stdout: version } = await execute(compiler, ['--version'], { cwd: directory, timeout: 10000, maxBuffer: 100000 })
    const runs = []
    for (const [name, source] of Object.entries(sources)) {
      await writeFile(join(directory, name), source)
      let result
      try { result = { ...await execute(compiler, compilerArgs(name), { cwd: directory, timeout: 10000, maxBuffer: 100000 }), exitCode: 0 } }
      catch (error) { if (!Number.isInteger(error.code) || error.killed) throw error; result = { stdout: error.stdout, stderr: error.stderr, exitCode: error.code } }
      runs.push({ name, source, sourceHash: hash(source), args: compilerArgs(name), stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode })
    }
    const evidence = { version: 1, compiler, compilerVersion: version, runs }
    return freeze({ ...evidence, captureHash: hash(evidence) })
  } finally { await rm(directory, { recursive: true, force: true }) }
}
function validateCapture(capture) {
  const { captureHash, ...evidence } = capture ?? {}
  if (captureHash !== hash(evidence) || evidence.version !== 1 || typeof evidence.compiler !== 'string' || !evidence.compilerVersion?.includes('clang') || evidence.runs?.length !== 2 ||
    !evidence.runs.every((run, i) => run.name === Object.keys(sources)[i] && run.source === sources[run.name] && run.sourceHash === hash(run.source) && JSON.stringify(run.args) === JSON.stringify(compilerArgs(run.name)) && typeof run.stdout === 'string' && typeof run.stderr === 'string' && Number.isSafeInteger(run.exitCode) && run.exitCode >= 0)) throw new TypeError('Invalid Clang capture evidence')
}
const clangAnswer = text => ({ diagnostics: [...text.matchAll(/\b((?:invalid|warning)\.c):(\d+):(\d+): (error|warning):/g)].map(m => ({ path: m[1], line: Number(m[2]), column: Number(m[3]), severity: m[4] })), exitCodes: [...text.matchAll(/Status: compiler invocation (?:invalid|warning)\.c exit code: (\d+)/g)].map(m => Number(m[1])) })
export function diagnosticTrialFixtures({ controlCapture } = {}) {
  const main = acceptanceFixturesV2().find(task => task.id === 'experiment-diagnostic-compiler')
  const blocks = main.text.split('\n\n')
  main.id = 'diagnostic-interleaved-compiler'
  main.tier = 'benefit-candidate'
  main.requireFixtureEachPhase = true
  main.text = [...blocks.slice(0, 8), blocks[24], ...blocks.slice(8, 16), blocks[25], ...blocks.slice(16, 24), blocks[26]].join('\n\n')
  main.phases = main.phases.map(phase => ({ ...phase, query: phase.query + recoveryInstruction }))
  const fixtures = [main]
  if (controlCapture) {
    validateCapture(controlCapture)
    const text = controlCapture.runs.map(run => `${run.stdout}${run.stderr}\nStatus: compiler invocation ${run.name} exit code: ${run.exitCode}`).join('\n\n')
    const expected = clangAnswer(text)
    if (expected.diagnostics.length !== 2 || expected.diagnostics[0].severity !== 'error' || expected.diagnostics[1].severity !== 'warning' || expected.exitCodes[0] === 0 || expected.exitCodes[1] !== 0) throw new TypeError('Clang did not produce the required error/warning control')
    fixtures.push({ id: 'diagnostic-real-clang-short-control', kind: 'acceptance', tier: 'short-cost-control', experiment: 'diagnostic-evidence', adoptionRequired: false, requireFixtureEachPhase: true,
      coverage: ['actual-local-compiler-output', 'short-log-cost-control'], text, expected, answer: clangAnswer,
      query: 'Call fixture. Report every compiler error and warning in source order as {"diagnostics":[{"path":STRING,"line":NUMBER,"column":NUMBER,"severity":STRING}],"exitCodes":[NUMBER,NUMBER]}. The Status lines are orchestration metadata with actual process exit codes in invocation order. Return only JSON without Markdown.' + recoveryInstruction })
  }
  return fixtures
}
export function createDiagnosticTrialPlan({ controlCapture, pricing, provenance, replay = true, promptEncoding = 'plain' } = {}) {
  if (!['plain', 'auto'].includes(promptEncoding)) throw new TypeError('Invalid promptEncoding')
  pricing = structuredClone(pricing ?? null)
  provenance = structuredClone(provenance ?? null)
  controlCapture = structuredClone(controlCapture ?? null)
  const model = pricing?.model ?? 'deepseek-flash'
  const experimentalConfig = parseExperimentConfig({ admission: 'measured-trial', maxCalls: 2, maxTotalCost: .03, maxCallCost: .02, maxCacheEntries: 8, comparatorTokenCap: 1200,
    mode: 'apply', tools: ['fixture'], selectionMode: 'diagnostic-evidence', promptEncoding, provider: replay ? 'replay' : 'deepseek-official', model: replay ? 'acceptance-selector-replay' : model,
    maxInputBytes: 100000, maxPromptBytes: 120000, maxOutputBytes: 2000, maxOutputTokens: 120, maxArtifactBytes: 160000, timeoutMs: 30000, maxParagraphs: 1000, maxQueryBytes: 4096,
    pricing: { currency: 'USD', uncachedInputPerMillion: pricing?.uncached ?? .3, cacheReadPerMillion: pricing?.cacheRead ?? .006, cacheWritePerMillion: pricing?.cacheWrite ?? 0, outputPerMillion: pricing?.output ?? 1.2 } })

  const tasks = diagnosticTrialFixtures({ controlCapture }).map(({ answer, ...task }) => ({ ...task, sourceHash: hash(task.text) }))
  const runs = []
  for (let repeat = 0; repeat < 3; repeat++) for (const task of tasks) for (let position = 0; position < 3; position++) {
    const group = groups[(position + repeat) % 3]
    runs.push({ runId: `${task.id}/${repeat}/${group}`, task: task.id, repeat, position, group })
  }
  const plan = { version: 'diagnostic-trial-v1', criteria: diagnosticTrialCriteria, controlCapture, pricing, provenance, replay, model, promptEncoding, experimentalConfig,
    runnerConfig: { composeWithTunedNative: true, validationFeedbackLimit: 2, maxSteps: 12, timeoutMs: 120000 },
    experimentAssumptions: { admission: 'measured-trial', predictedSavings: null, maxCalls: 2, maxTotalCost: .03, maxCallCost: .02, maxCacheEntries: 8, comparatorTokenCap: 1200 }, tasks, runs }
  return freeze({ ...plan, manifestHash: hash(plan) })
}
function accounted(record, { replay, pricing }) {
  return record.usageComplete === true && Array.isArray(record.modelCalls) && record.modelCalls.length > 0 &&
    record.modelCalls.every(call => call.complete === true && fields.every(field => Number.isSafeInteger(call.usage?.[field]) && call.usage[field] >= 0) &&
      (replay || call.provider === 'deepseek-official' && call.model === pricing?.model && price(call.usage, pricing) !== null)) &&
    fields.every(field => Number.isSafeInteger(record.usage?.[field]) && record.usage[field] === record.modelCalls.reduce((sum, call) => sum + call.usage[field], 0)) &&
    (replay || record.replay === false && record.usageKind === 'provider-reported' && price(record.usage, pricing) !== null)
}
export function summarizeDiagnosticTrial(plan, results) {
  const canonical = createDiagnosticTrialPlan({ controlCapture: plan.controlCapture, pricing: plan.pricing, provenance: plan.provenance, replay: plan.replay, promptEncoding: plan.promptEncoding })
  const options = { replay: canonical.replay, pricing: canonical.pricing, provenance: canonical.provenance }
  const overall = summarizePlannedAcceptance(canonical, plan, results, options)
  const tier = name => {
    const tasks = canonical.tasks.filter(task => task.tier === name)
    const subset = { ...canonical, tasks, runs: canonical.runs.filter(run => tasks.some(task => task.id === run.task)) }
    return summarizePlannedAcceptance(subset, subset, results.filter(run => tasks.some(task => task.id === run.task)), options)
  }
  const candidate = tier('benefit-candidate')
  const control = canonical.controlCapture ? tier('short-cost-control') : null
  const configurationComplete = overall.coverageComplete && results.every(run => run.configuration?.maxInlineTokens === (run.group === 'baseline-default' ? 12500 : 1200) && run.configuration?.nativePolicyInstalledAfterPlugin === true && run.configuration?.validationFeedbackLimit === 2)
  const accountingComplete = overall.coverageComplete && results.every(record => accounted(record, options))
  const callCount = results.reduce((sum, record) => sum + (record.modelCalls?.length ?? 0), 0)
  const observedCostUSD = !options.replay && results.every(record => accounted(record, options)) ? results.reduce((sum, record) => sum + price(record.usage, options.pricing), 0) : null
  const budgetComplete = callCount <= canonical.criteria.maxModelCalls && (options.replay || observedCostUSD !== null && observedCostUSD <= canonical.criteria.maxTotalCostUSD)
  const pairedRepeatSavings = [0, 1, 2].map(repeat => {
    const rows = results.filter(row => row.repeat === repeat && canonical.tasks.some(task => task.tier === 'benefit-candidate' && task.id === row.task))
    const cost = group => candidate.costComplete ? rows.filter(row => row.group === group).reduce((sum, row) => sum + price(row.usage, canonical.pricing), 0) : null
    const tunedCostUSD = cost('baseline-tuned'); const pluginCostUSD = cost('plugin')
    return { repeat, tunedCostUSD, pluginCostUSD, netSavingsVsTunedUSD: candidate.costComplete ? tunedCostUSD - pluginCostUSD : null }
  })
  const medianPairedRepeatSavingsUSD = candidate.costComplete ? pairedRepeatSavings.map(row => row.netSavingsVsTunedUSD).sort((a, b) => a - b)[1] : null
  const accepted = medianPairedRepeatSavingsUSD > 0 && overall.planValid && configurationComplete && accountingComplete && budgetComplete && overall.qualityComplete && overall.costComplete && candidate.accepted
  return { ...overall, pairedRepeatSavings, medianPairedRepeatSavingsUSD, accepted, candidateAccepted: accepted, configurationComplete, accountingComplete, budgetComplete, observedCostUSD, callCount, candidate, control,
    replayComplete: options.replay === true && overall.replayComplete && configurationComplete && accountingComplete && budgetComplete,
    claimBoundary: 'A candidate pass applies only to the declared interleaved long compiler task. Short real Clang control costs are reported separately, including regressions. This does not accept all fourteen features or establish general workload savings.' }
}
export function diagnosticTrialReplayAdapter(options) {
  const adapter = acceptanceReplayAdapter(options)
  const stream = adapter.stream.bind(adapter)
  adapter.stream = async function* (request) {
    if (request.model !== 'acceptance-selector-replay') { yield* stream(request); return }
    const prompt = request.messages[0].content[0].text
    const { requiredIds } = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ selectedIds: requiredIds }) } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  return adapter
}
export async function evaluateDiagnosticTrial({ key, pricing, provenance, runner, onPlan, onResult, replay = true, controlCapture, promptEncoding = 'plain' } = {}) {
  if (!replay && (typeof key !== 'string' || !key.trim())) throw new TypeError('Explicit credential required')
  if (!replay && (!validProvenance(provenance, pricing) || price({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1 }, pricing) === null)) throw new TypeError('Complete pricing including cacheWrite and runtime/model/source provenance required')
  if (!replay && typeof onPlan !== 'function') throw new TypeError('Live execution requires an awaited onPlan checkpoint')
  if (!replay && typeof onResult !== 'function') throw new TypeError('Live execution requires an awaited onResult journal')
  // Snapshot caller-owned execution inputs before awaiting compiler capture or callbacks.
  pricing = structuredClone(pricing ?? null)
  provenance = structuredClone(provenance ?? null)
  const capture = controlCapture ? structuredClone(controlCapture) : await captureClangControl()
  const plan = createDiagnosticTrialPlan({ controlCapture: capture, pricing, provenance, replay, promptEncoding })
  pricing = plan.pricing
  provenance = plan.provenance
  await onPlan?.(plan)
  const fixtures = diagnosticTrialFixtures({ controlCapture: capture })
  const run = runner ?? (await import('./evaluate-agent.js')).runAgentFixture
  const results = []
  let observedCost = 0
  let calls = 0
  let stoppedReason = null
  for (const scheduled of plan.runs) {
    // Reserve a bounded task's call count; dollar limit is observed between tasks.
    if (observedCost >= plan.criteria.maxTotalCostUSD || calls + 26 > plan.criteria.maxModelCalls) { stoppedReason = 'budget'; break }
    let result
    try { result = await run(fixtures.find(task => task.id === scheduled.task), scheduled.group, { key, replay, prices: pricing, model: plan.model, experimentalConfig: plan.experimentalConfig,
      ...plan.runnerConfig, adapterFactory: diagnosticTrialReplayAdapter }) }
    catch (error) { result = { passed: false, usageComplete: false, failure: safeFailure(error), stoppedReason: 'runner-exception', replay, usageKind: replay ? 'synthetic-replay' : 'provider-reported' } }
    const record = freeze(structuredClone({ ...result, ...scheduled, manifestHash: plan.manifestHash }))
    results.push(record)
    await onResult?.(record, plan)
    if (!accounted(record, { replay, pricing })) { stoppedReason = record.stoppedReason === 'runner-exception' ? 'runner-exception' : 'incomplete-cost-accounting'; break }
    calls += record.modelCalls.length
    observedCost += replay ? 0 : price(record.usage, pricing)
    if (observedCost > plan.criteria.maxTotalCostUSD || calls > plan.criteria.maxModelCalls) { stoppedReason = 'budget'; break }
  }
  return { evaluationKind: replay ? 'diagnostic-trial-scripted-replay' : 'diagnostic-trial-live-provider', plan, results, pricing: pricing ?? null, provenance: provenance ?? null, stoppedReason,
    ...summarizeDiagnosticTrial(plan, results),
    limitations: ['Provider cache remains uncontrolled despite balanced order.', 'Dollar budget is checked between bounded tasks and a final task may overshoot; such a report cannot pass.', 'Replay proves protocol execution only, not model quality or monetary savings.', 'Clang evidence records local compiler version and exact captured bytes; output can differ across compiler versions.', 'Prior failed v1/v2 evaluations are not replaced.'] }
}
