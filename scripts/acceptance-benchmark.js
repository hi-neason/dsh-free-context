import { containsPlaceholder, responseSchemaIssues, phaseResponseSchema } from './evaluation-contract.js'
import { safeFailure } from './evaluation-accounting.js'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { acceptanceFixtures } from '../test/fixtures/acceptance/tasks.js'

export const groups = Object.freeze(['baseline-default', 'baseline-tuned', 'plugin'])
export const acceptanceCriteria = Object.freeze({ version: 1, repeats: 3, maxSteps: 12, maxRuns: 90, timeoutMs: 120000,
  maxTotalCostUSD: 1, maxModelCalls: 900, qualityTolerance: 0, minimumNetSavingsUSD: 0,
  cacheCondition: 'shared-provider-cache-uncontrolled-counterbalanced', monetaryClaim: 'provider-usage-priced-estimate-not-invoice' })
const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function createAcceptancePlan({ seed = 20261026 } = {}) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new TypeError('seed must be uint32')
  const fixtures = acceptanceFixtures()
  // Seed determines initial permutation, Latin rotations put each group in each position once per task.
  let state = seed || 1
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32 }
  const shuffle = values => { const copy = [...values]; for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]] } return copy }
  const tasks = fixtures.map(({ answer, ...fixture }) => ({ ...fixture, sourceHash: hash(fixture.text) }))
  const schedules = new Map(tasks.map(task => [task.id, shuffle(groups)]))
  const runs = []
  for (let repeat = 0; repeat < 3; repeat++) for (const task of shuffle(tasks)) {
    const order = schedules.get(task.id)
    for (let position = 0; position < 3; position++) runs.push({ runId: `${task.id}/${repeat}/${order[(position + repeat) % 3]}`, task: task.id, repeat, position, group: order[(position + repeat) % 3] })
  }
  const plan = { version: 1, seed, criteria: acceptanceCriteria, experimentAssumptions: { minimumFutureRequests: 1, expectedRecoveryCost: 0, safetyMargin: .25, maxCallCost: .02, maxCacheEntries: 8 }, tasks, runs }
  return { ...plan, manifestHash: hash(plan) }
}

export function price(usage, pricing) {
  if (!pricing || pricing.currency !== 'USD' || !pricing.sourceUrl || !pricing.verifiedDate || !pricing.model || !pricing.ratePeriod) return null
  if (!fields.every(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0)) return null
  const rates = [pricing.uncached, pricing.output, pricing.cacheRead, pricing.cacheWrite]
  if (!rates.every((rate, i) => Number.isFinite(rate) && rate >= 0 || i === 3 && usage.cacheWriteTokens === 0 && rate === undefined)) return null
  const value = fields.reduce((sum, key, i) => sum + usage[key] * (rates[i] ?? 0), 0) / 1e6
  return Number.isFinite(value) ? value : null
}

/** Prospective studies may explicitly refuse unquoted cache writes. This does
 * not provide a write rate or change accounting for observed usage. */
export function validEvaluationPricing(pricing) {
  return price({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, pricing) !== null &&
    (Number.isFinite(pricing.cacheWrite) && pricing.cacheWrite >= 0 ||
      pricing.cacheWrite === undefined && pricing.cacheWritePolicy === 'reject-nonzero')
}

export function validProvenance(provenance, pricing) {
  return Boolean(provenance?.runtimeVersion === '0.2.1-rc.2' && /^[a-f0-9]{40}$/.test(provenance?.repositoryCommit ?? '') && /^[a-f0-9]{64}$/.test(provenance?.sourceTreeHash ?? '') && provenance?.model === pricing?.model && provenance?.cacheCondition === acceptanceCriteria.cacheCondition)
}

export function summarizeAcceptance(plan, results, { replay = false, pricing, provenance } = {}) {
  return summarizePlannedAcceptance(createAcceptancePlan({ seed: plan.seed }), plan, results, { replay, pricing, provenance })
}

export function summarizePlannedAcceptance(canonical, plan, results, { replay = false, pricing, provenance } = {}) {
  const planValid = isDeepStrictEqual(plan, canonical)
  const expected = new Map(canonical.runs.map(run => [run.runId, run]))
  const ids = new Set()
  const coverageComplete = planValid && results.length === expected.size && results.every(result => {
    const run = expected.get(result.runId)
    const valid = run && !ids.has(result.runId) && ['task', 'group', 'repeat', 'position'].every(key => result[key] === run[key]) && result.manifestHash === canonical.manifestHash
    ids.add(result.runId)
    return valid
  })
  const qualityComplete = coverageComplete && results.every(result => {
    const fixture = canonical.tasks.find(task => task.id === result.task)
    const phases = fixture.phases ?? [{ expected: fixture.expected }]
    const schemas = phases.map(phase => phaseResponseSchema(fixture, phase))
    let schemaComplete = !schemas.some(schema => schema !== undefined)
    if (!schemaComplete) {
      try { schemaComplete = result.responseSchemaSatisfied === true && result.phaseResults?.length === phases.length && result.phaseResults.every((phase, index) => schemas[index] === undefined || typeof phase.responseText === 'string' && isDeepStrictEqual(JSON.parse(phase.responseText), phase.actual) && responseSchemaIssues(phase.actual, schemas[index]).length === 0) }
      catch { schemaComplete = false }
    }
    const fixtureEachPhase = !fixture.requireFixtureEachPhase || phases.every((_, phase) => result.toolCalls?.some(call => call.phase === phase && call.name === (fixture.ptc ? 'run_code' : 'fixture') && call.isError === false))
    const recoveredEachPhase = !fixture.requireSnapshot || result.group !== 'plugin' || fixture.historyRetirement && !result.retirements?.some(record => record.reason === 'retired') || phases.every((_, phase) => result.toolCalls?.some(call => call.phase === phase && call.name === 'read' && call.readSnapshot === true && call.isError === false))
    return schemaComplete && (!fixture.rejectPlaceholderValues || result.responseContractSatisfied === true && result.phaseResults?.every(phase => !containsPlaceholder(phase.actual))) && fixtureEachPhase && recoveredEachPhase && !result.turnEnds?.some(turn => turn.kind !== 'completed') && result.phaseResults?.length === phases.length && result.phaseResults.every((phase, index) => phase.passed === true && phase.freshAnswer === true && phase.turnCompleted === true && isDeepStrictEqual(phase.actual, phases[index].expected)) && result.passed === true && result.exactFacts === true && result.requiredTools === true && result.fileCorrect === true && result.snapshotRecovered === true
  })
  const usageComplete = coverageComplete && results.every(result => result.usageComplete === true && Array.isArray(result.modelCalls) && result.modelCalls.length > 0 && result.modelCalls.every(call => call.complete && call.usage && fields.every((field, index) => index > 1 && call.usage[field] === undefined || Number.isSafeInteger(call.usage[field]) && call.usage[field] >= 0)) && fields.every(field => {
    const sum = result.modelCalls.reduce((total, call) => total + (call.usage?.[field] ?? 0), 0)
    return Number.isSafeInteger(sum) && sum >= 0 && result.usage[field] === sum
  }))
  const provenanceComplete = validProvenance(provenance, pricing)
  const priced = result => price(result.usage, pricing)
  const costComplete = !replay && usageComplete && provenanceComplete && results.every(result => result.replay === false && result.usageKind === 'provider-reported' && result.modelCalls.every(call => call.provider === 'deepseek-official' && call.model === pricing.model) && priced(result) !== null)
  const totals = Object.fromEntries(groups.map(group => {
    const runs = results.filter(result => result.group === group)
    return [group, { runs: runs.length, passed: runs.filter(run => run.passed).length,
      usage: Object.fromEntries(fields.map(field => [field, runs.reduce((sum, run) => sum + (run.usage?.[field] ?? 0), 0)])),
      modelCalls: runs.reduce((sum, run) => sum + (run.modelCalls?.length ?? 0), 0),
      auxiliaryCalls: runs.reduce((sum, run) => sum + (run.modelCalls?.filter(call => call.kind === 'auxiliary').length ?? 0), 0),
      recoveryCalls: runs.reduce((sum, run) => sum + (run.recoveryCalls ?? 0), 0),
      retries: runs.reduce((sum, run) => sum + (run.attempts ?? 0), 0),
      steps: runs.reduce((sum, run) => sum + (run.steps ?? 0), 0), elapsedMs: runs.reduce((sum, run) => sum + (run.elapsedMs ?? 0), 0),
      estimatedCostUSD: costComplete ? runs.reduce((sum, run) => sum + priced(run), 0) : null }]
  }))
  const experimentalCoverage = canonical.tasks.filter(task => task.experiment && task.adoptionRequired !== false).every(task => results.filter(run => run.task === task.id && run.group === 'plugin').length === 3 && results.filter(run => run.task === task.id && run.group === 'plugin').every(run => run.experiments?.some(record => record.reason === 'selected' && record.llmCalled && run.adoptions?.some(adoption => adoption.callId === record.callId && adoption.strategy === (task.experiment === 'diagnostic-evidence' ? 'diagnostic-evidence-selection-v1' : `${task.experiment}-prose-selection-v1`) && adoption.persisted === true && adoption.modelVisible === true && /^[a-f0-9]{64}$/.test(adoption.contentHash) && adoption.contentHash === adoption.persistedContentHash && adoption.contentHash === adoption.modelVisibleContentHash))))
  const netSavingsVsTunedUSD = costComplete ? totals['baseline-tuned'].estimatedCostUSD - totals.plugin.estimatedCostUSD : null
  const byTask = canonical.tasks.map(task => {
    const runs = results.filter(result => result.task === task.id)
    const costs = Object.fromEntries(groups.map(group => [group, costComplete ? runs.filter(run => run.group === group).reduce((sum, run) => sum + priced(run), 0) : null]))
    return { task: task.id, passed: runs.filter(run => run.passed).length, runs: runs.length, estimatedCostUSD: costs, netSavingsVsTunedUSD: costComplete ? costs['baseline-tuned'] - costs.plugin : null }
  })
  const sortedSavings = costComplete ? byTask.map(task => task.netSavingsVsTunedUSD).sort((a, b) => a - b) : []
  const middle = Math.floor(sortedSavings.length / 2)
  const medianTaskSavingsVsTunedUSD = sortedSavings.length ? (sortedSavings[middle] + sortedSavings[Math.floor((sortedSavings.length - 1) / 2)]) / 2 : null
  return { medianTaskSavingsVsTunedUSD, byTask, planValid, coverageComplete, qualityComplete, usageComplete, provenanceComplete, costComplete, experimentalCoverage, totals, netSavingsVsTunedUSD,
    replayComplete: replay && qualityComplete && usageComplete,
    accepted: qualityComplete && costComplete && experimentalCoverage && netSavingsVsTunedUSD > acceptanceCriteria.minimumNetSavingsUSD && medianTaskSavingsVsTunedUSD > 0 }
}

// Deliberately scripted protocol smoke: answers are parsed from actual tool output, never copied from expected.
export function acceptanceReplayAdapter({ LlmAdapter, fixture, source, snapshotPath, delivered, phase }) {
  return new class extends LlmAdapter {
    index = 0
    lastPhase = -1
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      if (this.lastPhase !== phase()) { this.lastPhase = phase(); this.index = 0 }
      const i = this.index++
      let block
      const tool = (name, args) => ({ type: 'tool-call', id: `call-${phase()}-${i}`, name, arguments: JSON.stringify(args) })
      if (request.model === 'acceptance-selector-replay') block = { type: 'text', text: '{"selectedIds":["p1"]}' }
      else if (fixture.ptc && i === 0) block = tool('run_code', { code: 'const value = await tools.fixture({}); console.log(value.map(block => block.text).join("\\n"));', description: 'Return fixture output through PTC', timeoutMs: 15000 })
      else if (fixture.ptc && i === 1) block = tool('run_code', { code: `const value = await tools.read({file_path:${JSON.stringify(source)},offset:1,limit:1000}); const rows = JSON.parse(value.lines.map(line => line.text).join("\\n")); console.log(JSON.stringify([rows.find(row => row.record_identifier === "job-40")]));`, description: 'Inspect structured source rows', timeoutMs: 15000 })
      else if (fixture.edit && phase() === 1 && i === 0) block = tool('write', { file_path: source, content: fixture.editedText })
      else if (!fixture.ptc && i === 0 && phase() === 0 || fixture.experiment && i === 0) block = tool('fixture', {})
      else if (i === 1 || fixture.requireReadEachPhase && phase() > 0 && i === 0) block = tool('read', { file_path: snapshotPath() ?? source, offset: 1, limit: 1000 })
      else {
        const rendered = delivered()
        const body = rendered.match(/<content>\n([\s\S]*)\n<\/content>$/)?.[1] ?? rendered
        const text = body.replace(/^\s*\d+[:→|]\s?/gm, '').replace(/\n\(End of file - total \d+ lines\)$/, '').trim()
        let answer = null
        try { answer = fixture.answer(text, phase()) } catch {}
        block = { type: 'text', text: JSON.stringify(answer) }
      }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    }
  }()
}

export async function evaluateAcceptance({ seed = 20261026, replay = true, key, pricing, provenance, onResult, runner } = {}) {
  if (!replay && (typeof key !== 'string' || !key.trim())) throw new TypeError('Explicit credential required')
  if (!replay && price({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, pricing) === null) throw new TypeError('Complete explicit price provenance required')
  if (!replay && !validProvenance(provenance, pricing)) throw new TypeError('Valid runtime/model/source-tree provenance required before live execution')
  const plan = createAcceptancePlan({ seed })
  const fixtures = acceptanceFixtures()
  const runFixture = runner ?? (await import('./evaluate-agent.js')).runAgentFixture
  const results = []
  let knownCost = 0
  let calls = 0
  let stoppedReason = null
  for (const scheduled of plan.runs) {
    if (knownCost >= acceptanceCriteria.maxTotalCostUSD || calls >= acceptanceCriteria.maxModelCalls) { stoppedReason = 'budget'; break }
    const fixture = fixtures.find(task => task.id === scheduled.task)
    const experimentalConfig = fixture.experiment ? { mode: 'apply', selectionMode: fixture.experiment, tools: ['fixture'], provider: replay ? 'replay' : 'deepseek-official', model: replay ? 'acceptance-selector-replay' : pricing.model,
      maxInputBytes: 100000, maxPromptBytes: 120000, maxOutputBytes: 2000, maxOutputTokens: 400, maxArtifactBytes: 160000, timeoutMs: 30000, maxParagraphs: 1000, maxQueryBytes: 4096,
      ...plan.experimentAssumptions, futureCacheReadPerMillion: pricing?.cacheRead ?? .006,
      pricing: { currency: 'USD', uncachedInputPerMillion: pricing?.uncached ?? .3, cacheReadPerMillion: pricing?.cacheRead ?? .006, outputPerMillion: pricing?.output ?? 1.2 }, maxCacheEntries: 8 } : undefined
    let result
    try { result = await runFixture(fixture, scheduled.group, { key, replay, prices: pricing, model: pricing?.model ?? 'deepseek-flash', experimentalConfig, adapterFactory: acceptanceReplayAdapter, maxSteps: acceptanceCriteria.maxSteps, timeoutMs: acceptanceCriteria.timeoutMs }) }
    catch (error) { result = { passed: false, usageComplete: false, failure: safeFailure(error), stoppedReason: 'runner-exception', replay, usageKind: replay ? 'synthetic-replay' : 'provider-reported' } }
    const record = { ...result, ...scheduled, manifestHash: plan.manifestHash }
    results.push(record)
    await onResult?.(record, plan)
    calls += record.modelCalls?.length ?? 0
    const cost = replay ? 0 : price(record.usage, pricing)
    if (cost === null || !record.usageComplete) { stoppedReason = record.stoppedReason === 'runner-exception' ? 'runner-exception' : 'incomplete-cost-accounting'; break }
    knownCost += cost
  }
  return { evaluationKind: replay ? 'acceptance-scripted-replay' : 'acceptance-live-provider', plan, pricing: pricing ?? null, provenance: provenance ?? null, results, stoppedReason,
    ...summarizeAcceptance(plan, results, { replay, pricing, provenance }),
    limitations: ['Counterbalancing reduces order confounding; provider cache remains uncontrolled.', 'A priced provider-usage estimate is not an invoice.', 'Replay verifies protocols only and cannot establish monetary or model-quality acceptance.', 'Experimental economic admission may reject every call; rejected policies do not establish experimental quality or savings.', 'The one-dollar ceiling is checked between bounded tasks and can overshoot by the final task cost. Unknown usage stops the run.'] }
}
