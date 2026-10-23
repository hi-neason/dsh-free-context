import { archiveOriginal, formatSnapshotReference } from './snapshot.js'
import { assessNetBenefit } from './economics.js'

const MARKER = '[dsh-free-context retired v1]\n'
const defaults = { enabled: false, tools: [], minInputBytes: 8192, minSavingsTokens: 32,
  retainRecentResults: 4, minAgeSteps: 3, maxEntriesPerStep: 1, maxSnapshotBytes: 1048576 }
const costKeys = ['minimumFutureRequests', 'pricing', 'expectedRecoveryCost', 'safetyMargin']

export class RetirementProtocolError extends Error {
  constructor(reports) {
    super('Incomplete retirement shadow-price protocol; the model step must not continue')
    this.name = 'RetirementProtocolError'
    this.code = 'RETIREMENT_INCOMPLETE_PROTOCOL'
    this.reports = Object.freeze([...reports])
  }
}

export function resolveRetirementConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError('Invalid retirement config')
  for (const key of Reflect.ownKeys(input)) if (!Object.hasOwn(defaults, key) && !costKeys.includes(key)) throw new TypeError(`Unknown retirement option: ${String(key)}`)
  if (input.pricing !== undefined) {
    for (const key of Reflect.ownKeys(input.pricing)) {
      if (!['uncachedInputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion'].includes(key)) throw new TypeError('Unknown retirement price')
    }
  }
  const config = structuredClone({ ...defaults, ...input })
  if (typeof config.enabled !== 'boolean' || !Array.isArray(config.tools) ||
    config.tools.some(name => typeof name !== 'string' || !name || /\s/.test(name)) ||
    new Set(config.tools).size !== config.tools.length) throw new TypeError('Invalid retirement enablement or tools')
  for (const key of Object.keys(defaults).filter(key => typeof defaults[key] === 'number')) {
    if (!Number.isSafeInteger(config[key]) || config[key] < (key === 'maxSnapshotBytes' ? 1 : 0)) throw new RangeError(`Invalid retirement ${key}`)
  }
  assessNetBenefit({ originalTokens: 2, candidateTokens: 1, invalidatedPrefixTokens: 1,
    compressionCost: 0, ...Object.fromEntries(costKeys.map(key => [key, config[key]])) })
  Object.freeze(config.tools)
  if (config.pricing) Object.freeze(config.pricing)
  return Object.freeze(config)
}

function eligibleRead(tracking, session, callId) {
  const old = tracking?.query(session, callId)
  const newer = old?.supersededBy && tracking.query(session, old.supersededBy)
  if (old?.status !== 'superseded' || newer?.status !== 'active' || !old.version ||
    old.version !== newer.version || old.targetKey !== newer.targetKey || newer.start > old.start ||
    newer.end < old.end || old.end < old.start) return undefined
  const retained = [...session.surface.nodes].some(seq => {
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/result') return false
    // A native pruner or other replacement may retain call identity while
    // removing lines. Tracker coverage describes the original returned window,
    // so a replaced surface node cannot serve as full-coverage evidence.
    if (event.surfaceOp !== 'append' || event.sourceEventSeqs?.length) return false
    const message = session.deriveEventMessage(event)
    return message.source?.callId === newer.callId && !message.isError &&
      !message.content?.some(block => block.type === 'text' && block.text.startsWith(MARKER))
  })
  if (!retained) return undefined
  return JSON.stringify([old, newer])
}

function finiteTokens(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid token measurement')
  return value
}

/**
 * Retire selected historical tool results with native replayable Session events.
 * No model invocation: compressionCost is zero. Costs and future requests remain
 * explicit caller assumptions. The two native appends are not a transaction;
 * an error after the shadow-price append is reported as partial-commit and stops.
 */
export async function retireHistory({ agent, signal }, input = {}, services = {}) {
  const config = resolveRetirementConfig(input)
  const reports = []
  const report = (reason, detail = {}) => {
    const entry = Object.freeze({ reason, ...detail })
    reports.push(entry)
    // Diagnostics never run between the shadow-price and replacement appends.
    try {
      const pending = services.onDecision?.(entry)
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    } catch {}
  }
  if (!config.enabled) return reports
  if (signal?.aborted) { report('aborted'); return reports }
  const session = agent?.session
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
  // An existing partial protocol remains unsafe even if pricing or storage
  // becomes unavailable on a later step. Check before normal capability skips.
  for (let index = 0; index < (events?.length ?? 0); index++) {
    if (events[index].type !== 'compaction/prune') continue
    const replacement = events[index + 1]
    if (replacement?.type !== 'tool/result' || replacement.surfaceOp?.op !== 'replace' ||
      JSON.stringify(replacement.sourceEventSeqs) !== JSON.stringify(events[index].data.shadowedSeqs)) {
      report('incomplete-shadow-protocol'); throw new RetirementProtocolError(reports)
    }
  }
  const meter = services.tokenMeter
  if (!meter || typeof meter.estimateMessage !== 'function' || typeof meter.measure !== 'function') {
    report('missing-token-meter'); return reports
  }
  const economicInputs = Object.fromEntries(costKeys.map(key => [key, config[key]]))
  const assumptions = assessNetBenefit({ originalTokens: 2, candidateTokens: 1,
    invalidatedPrefixTokens: 1, compressionCost: 0, ...economicInputs })
  if (assumptions.reason === 'missing-input') { report('missing-economic-assumptions'); return reports }
  if (!events || !services.spillStore) { report('missing-session-or-storage'); return reports }
  const surface = [...session.surface.nodes]
  const results = surface.filter(seq => session.eventAt(seq)?.type === 'tool/result')
  const selected = results.slice(0, Math.max(0, results.length - config.retainRecentResults))
  let attempted = 0
  for (const seq of selected) {
    if (attempted >= config.maxEntriesPerStep || signal?.aborted) break
    const event = session.eventAt(seq)
    const original = session.deriveEventMessage(event)
    const callId = original.source?.callId
    const call = events.find(item => item.type === 'tool/call' && item.data.callId === callId &&
      item.data.turn === event.data.turn && item.data.step === event.data.step)
    const name = call?.data.name
    const text = original.content?.length === 1 && original.content[0]?.type === 'text' ? original.content[0].text : undefined
    if (!config.tools.includes(name) || original.isError || event.data.error || typeof text !== 'string' ||
      text.startsWith(MARKER) || Buffer.byteLength(text) < config.minInputBytes ||
      events.filter(item => item.seq > seq && item.type === 'step/start').length < config.minAgeSteps) continue
    const readState = name === 'read' ? eligibleRead(services.readTracking, session, callId) : undefined
    if (name === 'read' && !readState) continue
    attempted++
    const revision = session.seq
    const nodes = [...session.surface.nodes]
    const originalImage = JSON.stringify(original)
    let priceCommitted = false
    let replacementMessage
    let economics
    try {
      const receipt = await archiveOriginal(services.spillStore,
        { agent, signal, name, callId }, text, { maxBytes: config.maxSnapshotBytes })
      const content = [{ type: 'text', text: MARKER + formatSnapshotReference(receipt) }]
      const message = { ...original, content }
      replacementMessage = message
      if (Buffer.byteLength(JSON.stringify(message)) >= Buffer.byteLength(originalImage)) {
        report('candidate-not-smaller', { callId }); continue
      }
      const originalTokens = finiteTokens(meter.estimateMessage(original))
      const candidateTokens = finiteTokens(meter.estimateMessage(message))
      if (originalTokens - candidateTokens < config.minSavingsTokens) { report('insufficient-token-savings', { callId }); continue }
      const measurement = meter.measure(session)
      if (measurement.logRevision !== revision) { report('history-changed', { callId }); continue }
      const retainedTokens = Math.max(finiteTokens(measurement.totalTokens), finiteTokens(measurement.surfaceTokens)) - originalTokens + candidateTokens
      economics = assessNetBenefit({ originalTokens, candidateTokens,
        invalidatedPrefixTokens: Math.max(0, retainedTokens), compressionCost: 0, ...economicInputs })
      if (!economics.adopt) { report('economic-gate', { callId, economics }); continue }
      // Nothing asynchronous or user-provided is invoked after this final check
      // until the two appends complete. Native post-commit observers may still run.
      if (signal?.aborted || agent.session !== session || session.seq !== revision ||
        JSON.stringify([...session.surface.nodes]) !== JSON.stringify(nodes) || !nodes.includes(seq) ||
        session.eventAt(seq) !== event || JSON.stringify(session.deriveEventMessage(event)) !== originalImage ||
        (name === 'read' && eligibleRead(services.readTracking, session, callId) !== readState)) {
        report(signal?.aborted ? 'aborted' : 'history-changed', { callId }); continue
      }
      if (services.mode === 'observe') {
        report('observed', { callId, originalSeq: seq, economics }); continue
      }
      session.append('compaction/prune', { shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq], shadowedTokenCount: originalTokens })
      priceCommitted = true
      if (session.seq !== revision + 1 || JSON.stringify([...session.surface.nodes]) !== JSON.stringify(nodes)) {
        throw new Error('History changed during shadow-price publication')
      }
      const replacement = session.append('tool/result', { ...event.data, message }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
      })
      report('retired', { callId, originalSeq: seq, replacementSeq: replacement.seq, economics })
    } catch {
      const shadow = session.eventAt(revision)
      if (shadow?.type === 'compaction/prune' &&
        JSON.stringify(shadow.data.shadowedSeqs) === JSON.stringify([seq])) priceCommitted = true
      // A wrapper/observer may throw after a durable append. Inspect the native
      // log and surface before classifying the two-event protocol as incomplete.
      const committed = priceCommitted && session.eventAt(revision + 1)
      if (committed?.type === 'tool/result' && session.seq === revision + 2 &&
        committed.surfaceOp?.op === 'replace' &&
        JSON.stringify(committed.sourceEventSeqs) === JSON.stringify([seq]) &&
        JSON.stringify(committed.data.message) === JSON.stringify(replacementMessage) &&
        session.surface.nodes.includes(committed.seq) && !session.surface.nodes.includes(seq)) {
        report('retired', { callId, originalSeq: seq, replacementSeq: committed.seq, economics })
        continue
      }
      report(priceCommitted ? 'partial-commit' : signal?.aborted ? 'aborted' : 'retirement-failed', { callId })
      // Never compound a partial protocol failure with another replacement.
      if (priceCommitted) throw new RetirementProtocolError(reports)
    }
  }
  return reports
}

/** Optional pre-step installer. Default disabled; always delegates the waterfall. */
export function installRetirement(ctx, input = {}, services = {}) {
  const config = resolveRetirementConfig(input)
  if (!config.enabled) return () => {}
  const busy = new WeakSet()
  return ctx.on('agent/pre-step', async (event, next) => {
    const session = event.agent?.session
    if (session && !busy.has(session)) {
      busy.add(session)
      try {
        await retireHistory(event, config, { ...services,
          tokenMeter: ctx.get('tokenMeter'), spillStore: ctx.get('spillStore'),
          onDecision(record) {
            if (['partial-commit', 'incomplete-shadow-protocol'].includes(record.reason)) {
              try { ctx.logger?.warn('dsh-free-context: incomplete retirement shadow-price protocol; automatic retirement stopped') } catch {}
            }
            return services.onDecision?.(record)
          } })
      } catch (error) {
        if (error?.code === 'RETIREMENT_INCOMPLETE_PROTOCOL') throw error
        try { ctx.logger?.warn('dsh-free-context: retirement failed; continuing the step') } catch {}
      } finally { busy.delete(session) }
    }
    return next()
  })
}
