/**
 * Build a best-effort model-content transformer for dsh's post-execute waterfall.
 * The transformer receives a copy of content; returning undefined is a no-op.
 * It must not mutate execution metadata or perform untracked history rewrites.
 *
 * @param {((content: object[], exec: object) => Promise<object[] | undefined> | object[] | undefined) | undefined} [transform]
 * @param {(message: string) => void} warn
 */
export function createPostExecuteHandler(transform, warn = () => {}) {
  return async (exec, result, next) => {
    // Let downstream policies finish before considering their model-facing content.
    const decision = await next()
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value') ||
        result.isError || exec.signal?.aborted || exec.parent !== undefined || !transform) return decision

    const content = decision.content ?? result.content
    try {
      const replacement = await transform(structuredClone(content), exec)
      if (replacement === undefined || exec.signal?.aborted) return decision
      if (!Array.isArray(replacement)) throw new TypeError('Transformer must return content blocks or undefined')
      return { ...decision, content: replacement }
    } catch {
      // Diagnostics must never turn a successful tool call into a failed call.
      // Avoid logging tool content or potentially sensitive exception messages.
      try { warn('dsh-free-context: content transformation failed; keeping original content') } catch {}
      return decision
    }
  }
}
