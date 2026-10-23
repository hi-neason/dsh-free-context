import { createHash } from 'node:crypto'

const nonempty = value => typeof value === 'string' && value.length > 0

/** Bind coverage evidence to the complete model-visible content, not just line ranges. */
export function hashReadContent(content) {
  if (!Array.isArray(content)) return undefined
  try { return createHash('sha256').update(JSON.stringify(content)).digest('hex') } catch { return undefined }
}
const owner = exec => {
  const session = exec?.agent?.session
  return session !== null && typeof session === 'object' ? session : undefined
}

function range(value) {
  if (!value || !nonempty(value.path) || !Number.isSafeInteger(value.offset) || value.offset < 1 ||
    !Number.isSafeInteger(value.totalLines) || value.totalLines < 0 || !Array.isArray(value.lines)) return undefined
  const hashes = []
  for (let index = 0; index < value.lines.length; index++) {
    const line = value.lines[index]
    if (line?.number !== value.offset + index || line.number > value.totalLines || typeof line.text !== 'string') return undefined
    hashes.push(createHash('sha256').update(line.text).digest('hex'))
  }
  return { start: value.offset, end: value.offset + value.lines.length - 1, hashes }
}

/**
 * Session-local advisory metadata, never a history mutation or freshness guard.
 * Version tokens and target keys are opaque host observations. Unknown versions
 * cannot authorize supersession. Eviction discards optimization metadata only.
 */
export function createReadTracker({ maxEntriesPerSession = 256 } = {}) {
  if (!Number.isSafeInteger(maxEntriesPerSession) || maxEntriesPerSession < 1) throw new RangeError('Invalid maxEntriesPerSession')
  let sessions = new WeakMap()
  let disposed = false
  function state(session) {
    if (disposed || !session || typeof session !== 'object') return undefined
    if (!sessions.has(session)) sessions.set(session, { records: new Map(), pending: new Map() })
    return sessions.get(session)
  }
  function trim(map) {
    while (map.size > maxEntriesPerSession) map.delete(map.keys().next().value)
  }
  function observe(target, observation, actor) {
    const data = state(owner(actor))
    if (!data || !nonempty(target?.targetKey)) return
    const version = observation?.kind === 'present' && nonempty(observation.version) ? observation.version : undefined
    const stale = observation?.kind === 'absent' || version !== undefined
    for (const item of data.records.values()) {
      if (item.targetKey === target.targetKey && (version === undefined || item.version !== version)) {
        item.status = stale ? 'stale' : 'unknown'
        delete item.supersededBy
      }
    }
    for (const item of data.pending.values()) {
      if (item.targetKey === target.targetKey && (version === undefined || item.version !== version)) item.conflict = true
    }
    if (actor?.name !== 'read' || !nonempty(actor.callId)) return
    const previous = data.pending.get(actor.callId)
    if (previous) {
      if (previous.targetKey !== target.targetKey || previous.version !== version) previous.conflict = true
      return
    }
    data.pending.set(actor.callId, { targetKey: target.targetKey, version, conflict: version === undefined })
    trim(data.pending)
  }
  function settle(exec, result, decision = { kind: 'accept' }) {
    const data = state(owner(exec))
    if (!data || exec?.name !== 'read' || !nonempty(exec.callId)) return
    const observed = data.pending.get(exec.callId)
    data.pending.delete(exec.callId)
    if (result?.isError || exec.signal?.aborted || exec.parent !== undefined || decision.kind !== 'accept' ||
      Object.hasOwn(decision, 'value') || Object.hasOwn(decision, 'content')) return
    const window = range(result?.value)
    const contentHash = hashReadContent(result?.content)
    if (!window || !contentHash) return
    // Duplicate ids cannot establish which execution the observation belongs to.
    if (data.records.has(exec.callId)) {
      data.records.get(exec.callId).status = 'unknown'
      delete data.records.get(exec.callId).supersededBy
      return
    }
    const current = { callId: exec.callId, targetKey: observed?.targetKey, version: observed?.version,
      start: window.start, end: window.end, status: observed && !observed.conflict ? 'active' : 'unknown',
      hashes: window.hashes, contentHash }
    if (current.status === 'active' && current.end >= current.start) {
      for (const previous of data.records.values()) {
        if (previous.status !== 'active' || previous.targetKey !== current.targetKey || previous.version !== current.version ||
          previous.end < previous.start || current.start > previous.start || current.end < previous.end) continue
        // Same line numbers alone do not prove coverage when per-line text caps
        // differ. Require identical returned text for each overlapping old line.
        if (!previous.hashes.every((hash, index) => hash === current.hashes[previous.start - current.start + index])) continue
        previous.status = 'superseded'
        previous.supersededBy = current.callId
      }
    }
    data.records.set(exec.callId, current)
    trim(data.records)
  }
  function query(session, callId) {
    const entry = sessions.get(session)?.records.get(callId)
    if (!entry) return undefined
    const { hashes, ...metadata } = entry
    return Object.freeze(metadata)
  }
  return { observe, settle, query, dispose() { disposed = true; sessions = new WeakMap() } }
}

/** Install nonthrowing observers without registering a service or changing results. */
export function installReadTracking(ctx, options) {
  const tracker = createReadTracker(options)
  const offObserved = ctx.on('fs/observed', (target, observation, actor) => {
    try { tracker.observe(target, observation, actor) } catch {}
  })
  const offSettled = ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try { tracker.settle(exec, result, decision) } catch {}
    return decision
  }, { prepend: true })
  const dispose = () => { offObserved(); offSettled(); tracker.dispose() }
  ctx.effect(() => () => tracker.dispose())
  return { query: tracker.query, dispose }
}
