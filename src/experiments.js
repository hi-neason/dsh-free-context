import { getSnapshotTracking } from './snapshot-telemetry.js'
import { parseExperimentConfig } from './experiment-config.js'
export { Config } from './experiment-config.js'
import { createTextSelector } from './text-selection.js'
import { createPostExecuteHandler } from './pipeline.js'
import { measureContent, reportDecision } from './diagnostics.js'
import { archiveOriginal, formatSnapshotReference } from './snapshot.js'
import { createTrialBudgets } from './trial-budget.js'
import { assessNetBenefit } from './economics.js'

export const name = 'dsh-free-context-experiments'
export const inject = ['tools', 'llm']

/** Price disjoint provider counters once; unknown cache-write price cannot justify adoption. */
function callCost(usage, pricing) {
  if (!usage || (usage.cacheWriteTokens > 0 && pricing.cacheWritePerMillion === undefined)) return undefined
  const cost = (usage.inputTokens * pricing.uncachedInputPerMillion + usage.outputTokens * pricing.outputPerMillion +
    (usage.cacheReadTokens ?? 0) * pricing.cacheReadPerMillion + (usage.cacheWriteTokens ?? 0) * (pricing.cacheWritePerMillion ?? 0)) / 1e6
  return Number.isFinite(cost) ? cost : undefined
}

function readQuery(provider, exec) {
  const value = provider.getQuery(Object.freeze({ session: exec.agent?.session, callId: exec.callId, toolName: exec.name }))
  if (value && typeof value.then === 'function') {
    Promise.resolve(value).catch(() => {})
    return undefined
  }
  return value
}

/** Optional auxiliary model experiment. No Agent request or historical message mutation. */
export function apply(ctx, input) {
  const config = parseExperimentConfig(input)
  if (config.mode === 'off' || !config.tools.length) return
  const tracking = getSnapshotTracking(ctx)
  const trial = config.admission === 'measured-trial'
  const trialBudgets = createTrialBudgets(config)
  const select = createTextSelector({ ...config, llm: ctx.llm })
  const warn = message => ctx.logger.warn(message)
  const transform = async (content, exec) => {
    let reason = 'unsupported-content'
    let selection
    let estimatedCost
    let callCostUpperEstimate
    let query
    let queryProvider
    let diagnosticsComplete = false
    let trialBudget
    try {
      if (content.length !== 1 || content[0].type !== 'text' || typeof content[0].text !== 'string') return undefined
      const original = measureContent(content)
      if (original.bytes > config.maxInputBytes) { reason = 'input-byte-budget'; return undefined }
      if (trial) {
        trialBudget = trialBudgets(exec.agent?.session)
        if (!trialBudget) { reason = 'trial-session-required'; return undefined }
      }
      const pricing = config.pricing
      if (!pricing?.currency || ['uncachedInputPerMillion', 'cacheReadPerMillion', 'outputPerMillion'].some(key => pricing[key] === undefined)) { reason = 'missing-pricing'; return undefined }
      if (!trial && ['minimumFutureRequests', 'expectedRecoveryCost', 'safetyMargin', 'maxCallCost', 'futureCacheReadPerMillion'].some(key => config[key] === undefined)) { reason = 'missing-economic-assumptions'; return undefined }
      const economics = (candidateTokens, compressionCost) => assessNetBenefit({
        originalTokens: Math.min(original.estimatedTokens, config.comparatorTokenCap ?? Infinity),
        candidateTokens: Math.min(candidateTokens, config.comparatorTokenCap ?? Infinity), invalidatedPrefixTokens: 0,
        minimumFutureRequests: config.minimumFutureRequests,
        pricing: { uncachedInputPerMillion: config.futureCacheReadPerMillion, cacheReadPerMillion: config.futureCacheReadPerMillion }, compressionCost,
        expectedRecoveryCost: config.expectedRecoveryCost, safetyMargin: config.safetyMargin,
      })
      if (config.selectionMode === 'query-dependent') {
        reason = 'query-unavailable'
        queryProvider = ctx.get('freeContextQuery')
        if (typeof queryProvider?.getQuery !== 'function') return undefined
        query = readQuery(queryProvider, exec)
        if (typeof query !== 'string' || !query.trim() || !query.isWellFormed()) { reason = 'missing-query'; return undefined }
        if (Buffer.byteLength(query) > config.maxQueryBytes) { reason = 'query-byte-budget'; return undefined }
      }
      const prepared = select.prepare({ kind: config.selectionMode === 'diagnostic-evidence' ? 'diagnostic' : 'prose', text: content[0].text, signal: exec.signal, query })
      if (prepared.status !== 'prepared') { reason = prepared.reason; return undefined }
      if (prepared.minimumManifestBytes > config.maxArtifactBytes) { reason = 'manifest-byte-budget'; return undefined }
      // Heuristic conservative admission: treat each actual serialized prompt byte as one
      // input token, price every token at the highest declared input rate.
      // This is an estimate, not a provider-specific token or billing guarantee.
      const cachedSelection = select.cached(prepared, { session: exec.agent?.session, signal: exec.signal })
      callCostUpperEstimate = cachedSelection ? 0 : (prepared.requestBytes * Math.max(pricing.uncachedInputPerMillion, pricing.cacheReadPerMillion, pricing.cacheWritePerMillion ?? pricing.uncachedInputPerMillion) + config.maxOutputTokens * pricing.outputPerMillion) / 1e6
      if (!Number.isFinite(callCostUpperEstimate) || callCostUpperEstimate > config.maxCallCost) { reason = 'call-cost-budget'; return undefined }
      if (!trial && !economics(0, callCostUpperEstimate).adopt) { reason = 'no-predicted-benefit-before-call'; return undefined }
      const queryIsCurrent = () => !queryProvider || (ctx.get('freeContextQuery') === queryProvider && readQuery(queryProvider, exec) === query)
      const store = ctx.get('spillStore')
      reason = 'snapshot-failed'
      const originalReceipt = await archiveOriginal(store, exec, content[0].text, { maxBytes: config.maxInputBytes })
      const originalReference = tracking.record(exec, originalReceipt, 'original')
      reason = 'selection-failed'
      let reservation
      if (trial && !cachedSelection) {
        reservation = trialBudget.reserve(callCostUpperEstimate)
        if (reservation.reason) { reason = reservation.reason; return undefined }
      }
      try {
        selection = cachedSelection ?? await select.execute(prepared, { session: exec.agent?.session, signal: exec.signal })
        estimatedCost = (selection.cacheHit || selection.shared) ? 0 : callCost(selection.callUsage, pricing)
      } finally {
        reservation?.settle(selection, estimatedCost)
      }
      if (!queryIsCurrent()) { reason = 'query-changed'; return undefined }
      if (selection.status !== 'selected') { reason = selection.reason; return undefined }
      if (!selection.usageComplete || estimatedCost === undefined || callCost(selection.originUsage, pricing) === undefined) { reason = 'missing-priced-usage'; return undefined }
      if (estimatedCost > config.maxCallCost) { reason = 'actual-call-cost-budget'; return undefined }
      reason = 'manifest-failed'
      const manifest = JSON.stringify({ version: 1, admission: config.admission, ...(trial ? { predictedSavings: null, trialBudget: trialBudget.snapshot() } : {}), policy: selection.strategy, sourceHash: selection.sourceHash, queryHash: selection.queryHash,
        originalReceipt, ...(selection.coverage ? { coverage: selection.coverage } : {}), selectedSpans: selection.spans.map(({ id, start, end, startLine, endLine, guards }) => ({ id, start, end, startLine, endLine, guards })),
        budgets: { maxQueryBytes: config.maxQueryBytes, maxInputBytes: config.maxInputBytes, maxPromptBytes: config.maxPromptBytes, maxOutputBytes: config.maxOutputBytes, maxOutputTokens: config.maxOutputTokens, timeoutMs: config.timeoutMs },
        audit: selection.audit, cacheHit: selection.cacheHit, shared: selection.shared, callUsage: selection.callUsage,
        originUsage: selection.originUsage, currency: pricing.currency, estimatedCost,
      })
      const manifestReceipt = await archiveOriginal(store, exec, manifest, { maxBytes: config.maxArtifactBytes })
      const auditReference = tracking.record(exec, manifestReceipt, 'audit')
      const text = [`[LOSSY ${config.selectionMode === 'diagnostic-evidence' ? 'diagnostic evidence' : 'paragraph'} selection; policy ${selection.strategy}. Extracted source spans do not prove complete evidence.]`,
        selection.text,
        ...(selection.coverage ? [`Compiler header coverage (supported grammar only, not semantic completeness): scanned=${JSON.stringify(selection.coverage.scanned)}, retained=${JSON.stringify(selection.coverage.retained)} BEFORE downstream retention; NOT final inline coverage. For omitted excerpts recover the full spilled tool output; full coverage metadata is in the audit.`] : []),
        'Recover omitted/exact evidence or check completeness via registered IDs with free_context_recall if installed; else retrievalHint/read/grep where supported. Read all pages; verify UTF-8 bytes and SHA-256 against receipt, not the current source file. Partial reads/grep do not verify completeness.',
        formatSnapshotReference(originalReceipt, { includeGuidance: false }),
        'Audit (full request, response, usage and selection metadata):', formatSnapshotReference(manifestReceipt, { includeGuidance: false })].join('\n\n')
      const replacement = [{ ...content[0], text }]
      const output = measureContent(replacement)
      if (exec.signal?.aborted) { reason = 'aborted'; return undefined }
      if (!queryIsCurrent()) { reason = 'query-changed'; return undefined }
      if (output.bytes >= original.bytes || output.estimatedTokens >= original.estimatedTokens || original.estimatedTokens - output.estimatedTokens < config.minSavingsTokens) { reason = 'insufficient-size-savings'; return undefined }
      if (!trial && !economics(output.estimatedTokens, estimatedCost).adopt) { reason = 'insufficient-net-benefit'; return undefined }
      reason = config.mode === 'apply' ? 'selected' : 'observed'
      return { content: replacement, strategy: selection.strategy, lossy: true, validate: () => diagnosticsComplete && queryIsCurrent(), snapshots: [originalReference, auditReference].filter(Boolean) }
    } catch {
      if (exec.signal?.aborted) reason = 'aborted'
      return undefined
    } finally {
      diagnosticsComplete = await reportDecision(record => ctx.parallel('free-context/experiment', record), warn, {
        tool: exec.name, callId: exec.callId, sessionId: exec.agent?.session?.header?.id,
        mode: config.mode, admission: config.admission, ...(trial ? { predictedSavings: null, trialBudget: trialBudget?.snapshot() } : {}), reason, queryHash: selection?.queryHash, cacheHit: selection?.cacheHit ?? false, llmCalled: selection?.llmCalled ?? false,
        ...(selection?.status === 'selected' ? { sourceHash: selection.sourceHash, selectedIds: selection.selectedIds } : {}),
        callUsage: selection?.callUsage, estimatedCost, comparatorTokenCap: config.comparatorTokenCap, futureCacheReadPerMillion: trial ? undefined : config.futureCacheReadPerMillion, currency: config.pricing?.currency, callCostUpperEstimate,
      }, { signal: exec.signal })
    }
  }
  ctx.on('tools/post-execute', createPostExecuteHandler(transform, warn, {
    mode: config.mode, eligible: exec => config.tools.includes(exec.name),
    report: record => ctx.parallel('free-context/decision', record),
  }), { prepend: true })
}
