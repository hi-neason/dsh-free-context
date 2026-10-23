import { measureContent, reportDecision, safeWarn } from './diagnostics.js'

/**
 * Internal candidate protocol: { content, strategy, lossy? }; undefined means no strategy.
 * The transformer receives copied content. Observe computes without replacing the decision.
 * Diagnostic metrics are estimates, never provider billing evidence.
 */
export function createPostExecuteHandler(transform, warn = () => {}, options = {}) {
  const { mode = 'observe', report = () => {}, estimator, eligible = () => true } = options
  return async (exec, result, next) => {
    const decision = await next()
    const started = performance.now()
    let input
    let output
    let strategy
    let lossy
    const finish = async (outcome, reason, returned = decision) => {
      await reportDecision(report, warn, {
        tool: exec.name, callId: exec.callId,
        ...(exec.agent?.session?.header?.id !== undefined ? { sessionId: exec.agent.session.header.id } : {}),
        mode, outcome, reason,
        ...(strategy ? { strategy, lossy: lossy === true } : {}),
        ...(input ? { input } : {}), ...(output ? { output } : {}),
        estimateKind: 'serialized-content-utf8-heuristic', elapsedMs: performance.now() - started,
      })
      return exec.signal?.aborted ? decision : returned
    }
    const skip = decision.kind !== 'accept' ? 'blocked' : Object.hasOwn(decision, 'value') ? 'value-replacement' :
      result.isError ? 'tool-failure' : exec.signal?.aborted ? 'aborted' :
        exec.parent !== undefined ? 'ptc-internal' : mode === 'off' ? 'disabled' : undefined
    if (skip) return finish('skipped', skip)

    try {
      const content = decision.content ?? result.content
      input = measureContent(content, estimator)
      output = input
      if (!eligible(exec, input.bytes)) return finish('skipped', 'ineligible')
      if (!transform) return finish('eligible', 'no-strategy')
      const candidate = await transform(structuredClone(content), exec)
      if (exec.signal?.aborted) return finish('skipped', 'aborted')
      if (candidate === undefined) return finish('eligible', 'no-strategy')
      if (!candidate || !Array.isArray(candidate.content) || typeof candidate.strategy !== 'string' || !candidate.strategy.trim() ||
          (candidate.lossy !== undefined && typeof candidate.lossy !== 'boolean')) throw new TypeError('Invalid candidate')
      strategy = candidate.strategy
      lossy = candidate.lossy
      output = measureContent(candidate.content, estimator)
      return mode === 'apply'
        ? finish('selected', 'candidate', { ...decision, content: candidate.content })
        : finish('observed', 'candidate')
    } catch {
      output = input
      safeWarn(warn, 'dsh-free-context: content transformation failed; keeping original content')
      return finish('fallback', 'transformation-failed')
    }
  }
}
