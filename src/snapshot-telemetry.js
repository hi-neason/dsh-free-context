import { isDeepStrictEqual } from 'node:util'
import { snapshotReferenceId } from './snapshot.js'

const nonempty = value => typeof value === 'string' && value.length > 0
const owner = exec => exec?.agent?.session
const purposes = new Set(['original', 'audit', 'retirement'])

/** Runtime-only exact-locator associations. No source reads, path resolution or byte-verification claims. */
export function installSnapshotTracking(ctx, { maxEntriesPerSession = 128 } = {}) {
  if (!Number.isSafeInteger(maxEntriesPerSession) || maxEntriesPerSession < 1) throw new RangeError('Invalid maxEntriesPerSession')
  let sessions = new WeakMap()
  let pending = new WeakMap()
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
      const referenceId = snapshotReferenceId(receipt)
      const reference = Object.freeze({ referenceId, sha256: receipt.sha256, bytes: receipt.bytes,
        sourceCallId: receipt.callId, sessionId: receipt.sessionId, purpose })
      if (!sessions.has(session)) sessions.set(session, new Map())
      const entries = sessions.get(session)
      entries.delete(receipt.locator)
      entries.set(receipt.locator, { reference, receipt: Object.freeze({ ...receipt }) })
      while (entries.size > maxEntriesPerSession) entries.delete(entries.keys().next().value)
      emit('free-context/snapshot', reference)
      return reference
    } catch { return undefined }
  }
  // The post hook only captures a baseline: outer policies and tool finalizers may still replace it.
  const offPost = ctx.on('tools/post-execute', async (exec, result, next) => {
    let observed
    try {
      const session = owner(exec)
      const locator = exec.arguments?.file_path
      const entry = sessions.get(session)?.get(locator)
      if (!disposed && exec.name === 'read' && exec.parent === undefined && entry && session.header?.id === entry.reference.sessionId) {
        observed = { session, locator, entry, result }
        pending.set(exec, observed)
      }
    } catch {}
    const decision = await next()
    if (observed) observed.decision = decision
    return decision
  }, { prepend: true })
  const offResult = ctx.on('tools/result', (exec, result) => {
    const observed = pending.get(exec)
    pending.delete(exec)
    try {
      if (disposed || !observed || owner(exec) !== observed.session ||
        sessions.get(observed.session)?.get(observed.locator) !== observed.entry) return
      const { reference } = observed.entry
      if (observed.session.header?.id !== reference.sessionId) return
      const { decision, result: original } = observed
      const outcome = exec.signal?.aborted ? 'cancelled' : decision?.kind === 'block' && result.isError ? 'blocked' :
        result.isError || original.isError ? 'failed' : !decision || decision.kind !== 'accept' ||
        Object.hasOwn(decision, 'value') || Object.hasOwn(decision, 'content') ||
        !isDeepStrictEqual(original.content, result.content) || !isDeepStrictEqual(original.value, result.value) ? 'modified' : 'success'
      const value = result.value
      let range
      if (outcome === 'success' && nonempty(value?.path) && Number.isSafeInteger(value.offset) && value.offset >= 1 &&
        Number.isSafeInteger(value.totalLines) && value.totalLines >= 0 && Array.isArray(value.lines) &&
        value.lines.every((line, index) => line?.number === value.offset + index && line.number <= value.totalLines && typeof line.text === 'string')) {
        range = { startLine: value.offset, endLine: value.offset + value.lines.length - 1, totalLines: value.totalLines }
      }
      emit('free-context/recovery', Object.freeze({ ...reference, recoveryCallId: exec.callId, outcome, verifiedFull: false, ...(range ?? {}) }))
    } catch {}
  })
  function lookup(exec, referenceId) {
    const session = owner(exec)
    if (disposed || typeof referenceId !== 'string') return undefined
    for (const entry of sessions.get(session)?.values() ?? []) {
      if (entry.reference.referenceId === referenceId && session?.header?.id === entry.reference.sessionId) return entry.receipt
    }
    return undefined
  }
  function clear() { disposed = true; sessions = new WeakMap(); pending = new WeakMap() }
  ctx.effect?.(() => clear)
  return { record, lookup, dispose() { offPost?.(); offResult?.(); clear() } }
}

/** Use an explicitly host-provided registry, otherwise retain private tracking. */
export function getSnapshotTracking(ctx) {
  const shared = ctx.get('freeContextSnapshots')
  if (shared === undefined) return installSnapshotTracking(ctx)
  if (typeof shared?.record !== 'function' || typeof shared?.lookup !== 'function') throw new TypeError('Invalid freeContextSnapshots service')
  return shared
}
