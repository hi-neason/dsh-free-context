import { createHash } from 'node:crypto'
import { hashReadContent } from './read-lifecycle.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Exit zero can accompany a masked failure. Check complete stdout before a
 * downstream preview can omit its diagnostic, and check the retained text too.
 */
export function hasProtectedCommandEvidence(text) {
  return /\[dsh-(?:lossless-text|search-results):|"format"\s*:\s*"dsh-json-rows"/.test(text) ||
    /^\s*::(?:error|warning)(?:\s|::)/mi.test(text) ||
    /^.+:\d+(?::\d+)?:\s*(?:error|warning|fatal)\b/mi.test(text) ||
    /^\[(?:stderr\]|exit code:|timed out|stopped:|killed by signal:|still running|sandbox:|some output was dropped)/mi.test(text) ||
    /^\s*(?:STDERR:|Exit code:\s*(?:-[1-9]\d*|[1-9]\d*)\b|Traceback \(most recent call last\):|(?:FAIL(?:ED)?|ERROR|FATAL|WARNING)(?:\s|:|$)|not ok\b)/mi.test(text) ||
    /^\s*(?:E\s+|[\w./\\ -]+:\d+(?::\d+)?:\s*)?(?:[A-Za-z_][\w.]*)?(?:Error|Exception|Warning)\s*:/m.test(text) ||
    /\b[1-9]\d*\s+(?:failed|errors?|failures?)\b|\b(?:errors?|failures?)\s*=\s*[1-9]\d*\b/i.test(text) ||
    /\b(?:command not found|No such file or directory|Permission denied)\b/i.test(text)
}

function matchingCall(session, exec, allowResult) {
  if (exec.name !== 'bash' || typeof exec.callId !== 'string' || !exec.callId ||
      typeof session?.snapshotEvents !== 'function' || typeof session.eventAt !== 'function') return undefined
  const events = session.snapshotEvents()
  const calls = events.filter(event => event.type === 'tool/call' && event.data.callId === exec.callId)
  if (calls.length !== 1 || (!allowResult && events.some(event =>
    event.type === 'tool/result' && event.data.message?.source?.callId === exec.callId))) return undefined
  const call = calls[0]
  if (call.data.name !== exec.name || !Number.isSafeInteger(call.seq) ||
      !Number.isSafeInteger(call.data.turn) || !Number.isSafeInteger(call.data.step) ||
      session.eventAt(call.seq) !== call || hash(JSON.parse(call.data.arguments)) !== hash(exec.arguments)) return undefined
  return call
}

function successfulValue(result) {
  const value = result?.value
  const valid = result?.isError === false && value && typeof value === 'object' &&
    Object.keys(value).length === 3 && ['exitCode', 'stdout', 'stderr'].every(key => Object.hasOwn(value, key)) &&
    value.exitCode === 0 && typeof value.stdout === 'string' && value.stderr === '' &&
    !hasProtectedCommandEvidence(value.stdout)
  if (!valid) return false
  // Structured status objects need their own semantics and cannot grant the
  // relaxed source-text policy, even when the shell itself exited successfully.
  try { JSON.parse(value.stdout); return false } catch { return true }
}

/** Credentials expire with the Session object. Eviction discards optimization
 * evidence and advances a sequence floor so old executions cannot regain it.
 */
export function createVerifiedSuccessTracker({ maxEntries = 256 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError('Invalid success tracker bound')
  let sessions = new WeakMap(), disposed = false
  const state = session => {
    if (!sessions.has(session)) sessions.set(session, { records: new Map(), expiredThrough: -1 })
    return sessions.get(session)
  }
  function begin(exec, result) {
    if (disposed || exec.parent !== undefined || exec.signal?.aborted !== false || typeof exec.token !== 'symbol') return undefined
    const session = exec.agent?.session
    if (!session || typeof session.header?.id !== 'string') return undefined
    const call = matchingCall(session, exec, false)
    if (!call) return undefined
    const data = state(session)
    if (call.seq <= data.expiredThrough) return undefined
    const previous = data.records.get(call.seq)
    if (previous) { previous.status = 'invalid'; return undefined }
    const successful = successfulValue(result)
    const record = { session, call, token: exec.token, status: successful ? 'pending' : 'invalid', sessionId: session.header.id,
      callId: exec.callId, name: exec.name, argumentsHash: hash(exec.arguments), valueHash: successful ? hash(result.value) : undefined }
    data.records.set(call.seq, record)
    while (data.records.size > maxEntries) {
      const oldest = data.records.keys().next().value
      data.records.delete(oldest)
      data.expiredThrough = Math.max(data.expiredThrough, oldest)
    }
    return record
  }
  function settle(record, exec, result, decision) {
    if (!record || disposed || record.status !== 'pending') return
    record.status = 'invalid'
    const data = sessions.get(record.session)
    if (data?.records.get(record.call.seq) !== record || exec.agent?.session !== record.session ||
        exec.token !== record.token || exec.signal?.aborted || exec.parent !== undefined ||
        decision.kind !== 'accept' || Object.hasOwn(decision, 'value') || !successfulValue(result) ||
        hash(result.value) !== record.valueHash || matchingCall(record.session, exec, false) !== record.call) return
    const content = decision.content ?? result.content
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text' ||
        typeof content[0].text !== 'string' || hasProtectedCommandEvidence(content[0].text)) return
    record.contentHash = hashReadContent(content)
    record.status = 'valid'
  }
  function query(session, call, event) {
    if (disposed) return undefined
    const record = sessions.get(session)?.records.get(call?.seq)
    if (!record || record.status !== 'valid' || record.call !== call || session.header?.id !== record.sessionId ||
        event.surfaceOp !== 'append' || (event.sourceEventSeqs?.length &&
          (event.sourceEventSeqs.length !== 1 || event.sourceEventSeqs[0] !== call.seq)) || session.eventAt(event.seq) !== event ||
        event.seq <= call.seq || event.data.turn !== call.data.turn || event.data.step !== call.data.step ||
        event.data.message?.source?.callId !== record.callId || event.data.message.toolCallId !== record.callId ||
        event.data.message.isError || event.data.error ||
        hashReadContent(event.data.message.content) !== record.contentHash) return undefined
    const exec = { name: record.name, callId: record.callId, arguments: JSON.parse(call.data.arguments) }
    if (matchingCall(session, exec, true) !== call || hash(exec.arguments) !== record.argumentsHash ||
        session.snapshotEvents().filter(item => item.type === 'tool/result' &&
          item.data.message?.source?.callId === record.callId).length !== 1) return undefined
    return Object.freeze({ callSeq: call.seq, turn: call.data.turn, step: call.data.step, callId: record.callId,
      tool: record.name, argumentsHash: record.argumentsHash, contentHash: record.contentHash })
  }
  return { begin, settle, query, dispose() { disposed = true; sessions = new WeakMap() } }
}

/** Install after the already-mounted policies on the first tool invocation.
 * Later outer changes remain untrusted until the final Session hash matches.
 */
export function installVerifiedSuccessTracking(ctx) {
  const tracker = createVerifiedSuccessTracker()
  let offPost, disposed = false
  const offPre = ctx.on('tools/pre-execute', async (_exec, next) => {
    if (!disposed && !offPost) offPost = ctx.on('tools/post-execute', async (exec, result, next) => {
      let record
      try { record = tracker.begin(exec, result) } catch {}
      const decision = await next()
      try { tracker.settle(record, exec, result, decision) } catch {}
      return decision
    }, { prepend: true })
    return next()
  }, { prepend: true })
  const dispose = () => { disposed = true; offPre(); offPost?.(); tracker.dispose() }
  ctx.effect?.(() => dispose)
  return { query: tracker.query, dispose }
}
