import { createHash } from 'node:crypto'

const nonempty = value => typeof value === 'string' && value.length > 0
const owner = exec => exec?.agent?.session
const purposes = new Set(['original', 'audit', 'retirement'])

/** Runtime-only exact-locator associations. No source reads, path resolution or byte-verification claims. */
export function installSnapshotTracking(ctx, { maxEntriesPerSession = 128 } = {}) {
  if (!Number.isSafeInteger(maxEntriesPerSession) || maxEntriesPerSession < 1) throw new RangeError('Invalid maxEntriesPerSession')
  let sessions = new WeakMap()
  let disposed = false
  const emit = (event, record) => {
    try { Promise.resolve(ctx.parallel(event, record)).catch(() => {}) } catch {}
  }
  function record(exec, receipt, purpose = 'original') {
    try {
      const session = owner(exec)
      if (disposed || !session || typeof session !== 'object' || !purposes.has(purpose) ||
        !nonempty(receipt?.locator) || !nonempty(receipt.callId) || !nonempty(receipt.sessionId) ||
        receipt.sessionId !== session.header?.id || !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
        !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0) return undefined
      const referenceId = createHash('sha256').update(JSON.stringify([receipt.locator, receipt.sha256])).digest('hex')
      const reference = Object.freeze({ referenceId, sha256: receipt.sha256, bytes: receipt.bytes,
        sourceCallId: receipt.callId, sessionId: receipt.sessionId, purpose })
      if (!sessions.has(session)) sessions.set(session, new Map())
      const entries = sessions.get(session)
      entries.delete(receipt.locator)
      entries.set(receipt.locator, reference)
      while (entries.size > maxEntriesPerSession) entries.delete(entries.keys().next().value)
      emit('free-context/snapshot', reference)
      return reference
    } catch { return undefined }
  }
  const off = ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      if (disposed || exec.name !== 'read' || exec.parent !== undefined) return decision
      const reference = sessions.get(owner(exec))?.get(exec.arguments?.file_path)
      if (!reference || owner(exec)?.header?.id !== reference.sessionId) return decision
      const outcome = exec.signal?.aborted ? 'cancelled' : decision.kind !== 'accept' ? 'blocked' :
        result.isError ? 'failed' : Object.hasOwn(decision, 'value') || Object.hasOwn(decision, 'content') ? 'modified' : 'success'
      const value = result.value
      let range
      if (outcome === 'success' && nonempty(value?.path) && Number.isSafeInteger(value.offset) && value.offset >= 1 &&
        Number.isSafeInteger(value.totalLines) && value.totalLines >= 0 && Array.isArray(value.lines) &&
        value.lines.every((line, index) => line?.number === value.offset + index && line.number <= value.totalLines && typeof line.text === 'string')) {
        range = { startLine: value.offset, endLine: value.offset + value.lines.length - 1, totalLines: value.totalLines }
      }
      emit('free-context/recovery', Object.freeze({ ...reference, recoveryCallId: exec.callId, outcome, verifiedFull: false, ...(range ?? {}) }))
    } catch {}
    return decision
  }, { prepend: true })
  function clear() { disposed = true; sessions = new WeakMap() }
  ctx.effect?.(() => clear)
  return { record, dispose() { off?.(); clear() } }
}
