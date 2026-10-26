import { archiveOriginal, formatSnapshotReference } from './snapshot.js'
import { assessNetBenefit } from './economics.js'
import { hashReadContent } from './read-lifecycle.js'

const MARKER = '[dsh-free-context retired v1]\n'
const defaults = { enabled: false, tools: [], minInputBytes: 8192, minSavingsTokens: 32,
  retainRecentResults: 4, minAgeSteps: 3, minModelUses: 2, minStepsBetweenRetirements: 1,
  phasePolicy: 'any', excerptCharacters: 256, maxEntriesPerStep: 1, maxSnapshotBytes: 1048576 }
const costKeys = ['minimumFutureRequests', 'pricing', 'expectedRecoveryCost', 'safetyMargin']
const POLICY = 'Retirement decision: '
const callKey = (turn, step, callId) => JSON.stringify([turn, step, callId])
function historyIndex(events) {
  const calls = new Map()
  const exposure = new Map()
  let steps = 0
  let uses = 0
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    exposure.set(event.seq, { steps, uses })
    if (event.type === 'tool/call') calls.set(callKey(event.data.turn, event.data.step, event.data.callId), event)
    if (event.type === 'step/start') steps++
    if (event.type === 'assistant/message' || (event.type === 'assistant/attempt' &&
      (event.data.usage?.inputTokens ?? 0) + (event.data.usage?.cacheReadTokens ?? 0) > 0)) uses++
  }
  return { calls, exposure }
}
function retainedReads(session) {
  const retained = new Map()
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/result' || event.surfaceOp !== 'append' || event.sourceEventSeqs?.length) continue
    const message = session.deriveEventMessage(event)
    if (message.isError || message.content?.some(block => block.type === 'text' && block.text.startsWith(MARKER))) continue
    const callId = message.source?.callId
    if (!retained.has(callId)) retained.set(callId, [])
    retained.get(callId).push(message.content)
  }
  return retained
}

function taskBoundary(provider, session) {
  if (typeof provider?.getState !== 'function') return undefined
  const state = provider.getState(Object.freeze({ session }))
  if (state && typeof state.then === 'function') { Promise.resolve(state).catch(() => {}); return undefined }
  if (!state || state.status !== 'complete' || !['phase', 'boundaryId'].every(key =>
    typeof state[key] === 'string' && state[key].trim() && state[key].length <= 256)) return undefined
  return Object.freeze({ phase: state.phase, boundaryId: state.boundaryId, status: state.status })
}

function previousRetirements(events) {
  return events.flatMap(event => {
    if (event.type !== 'tool/result') return []
    const text = event.data.message?.content?.[0]?.text
    if (!text?.startsWith(MARKER)) return []
    const line = text.slice(MARKER.length).split('\n', 1)[0]
    if (!line.startsWith(POLICY)) return []
    try { return [{ ...JSON.parse(line.slice(POLICY.length)), seq: event.seq }] } catch { return [] }
  })
}

// Tool infrastructure success does not imply command success. In particular,
// official bash/pwsh encode nonzero exits and interruptions as ordinary text.
function protectedEvidence(text) {
  return /^\[(?:stderr\]|exit code:|timed out|stopped:|killed by signal:|still running|sandbox:|some output was dropped|output truncated;)/mi.test(text) ||
    /\b(?:error|fatal|exception|failed|failure|warning)\b|^not ok\b/im.test(text)
}

function excerpt(text, characters) {
  if (!characters) return ''
  const points = Array.from(text)
  const head = Math.ceil(characters / 2)
  const tail = Math.floor(characters / 2)
  return `Lossy head/tail excerpt (not complete evidence):\n${points.slice(0, head).join('')}\n[... omitted ...]\n${tail ? points.slice(-tail).join('') : ''}\n\n`
}

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
  if (!['any', 'boundary'].includes(config.phasePolicy)) throw new TypeError('Invalid retirement phasePolicy')
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

function eligibleRead(tracking, session, callId, retained) {
  const old = tracking?.query(session, callId)
  const newer = old?.supersededBy && tracking.query(session, old.supersededBy)
  if (old?.status !== 'superseded' || newer?.status !== 'active' || !old.version ||
    old.version !== newer.version || old.targetKey !== newer.targetKey || newer.start > old.start ||
    newer.end < old.end || old.end < old.start) return undefined
  // Only actual retained native append content can establish complete coverage.
  if (!newer.contentHash || !retained.get(newer.callId)?.some(content =>
    hashReadContent(content) === newer.contentHash)) return undefined
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
  let boundary
  let taskProvider
  if (config.phasePolicy === 'boundary') {
    try {
      taskProvider = services.getTaskState ? services.getTaskState() : services.taskState
      boundary = taskBoundary(taskProvider, session)
    } catch {}
    if (!boundary) { report('missing-task-boundary'); return reports }
  }
  const index = historyIndex(events)
  const past = previousRetirements(events)
  if (boundary && past.some(item => item.boundaryId === boundary.boundaryId)) {
    report('boundary-already-retired'); return reports
  }
  if (past.length && index.exposure.get(past.at(-1).seq).steps < config.minStepsBetweenRetirements) {
    report('retirement-cooldown'); return reports
  }
  const surface = [...session.surface.nodes]
  const results = surface.filter(seq => session.eventAt(seq)?.type === 'tool/result')
  const selected = results.slice(0, Math.max(0, results.length - config.retainRecentResults))
  const retained = config.tools.includes('read') ? retainedReads(session) : undefined
  let attempted = 0
  for (const seq of selected) {
    if (attempted >= config.maxEntriesPerStep || signal?.aborted) break
    const event = session.eventAt(seq)
    const original = session.deriveEventMessage(event)
    const callId = original.source?.callId
    const call = index.calls.get(callKey(event.data.turn, event.data.step, callId))
    const name = call?.data.name
    const text = original.content?.length === 1 && original.content[0]?.type === 'text' ? original.content[0].text : undefined
    if (!config.tools.includes(name) || original.isError || event.data.error || typeof text !== 'string' ||
      text.startsWith(MARKER) || Buffer.byteLength(text) < config.minInputBytes ||
      index.exposure.get(seq).steps < config.minAgeSteps) continue
    if (protectedEvidence(text)) { report('protected-status-evidence', { callId }); continue }
    // Only committed model outcomes count. A step start or abandoned request is
    // not evidence of exposure; retries with committed attempts count separately.
    const modelUses = index.exposure.get(seq).uses
    if (modelUses < config.minModelUses) { report('insufficient-model-uses', { callId, modelUses }); continue }
    const readState = name === 'read' ? eligibleRead(services.readTracking, session, callId, retained) : undefined
    if (name === 'read' && !readState) continue
    attempted++
    const revision = session.seq
    const nodes = [...session.surface.nodes]
    const originalImage = JSON.stringify(original)
    let priceCommitted = false
    let replacementMessage
    let economics
    try {
      const archiveExec = { agent, signal, name, callId }
      const receipt = await archiveOriginal(services.spillStore,
        archiveExec, text, { maxBytes: config.maxSnapshotBytes })
      const snapshot = { sha256: receipt.sha256, bytes: receipt.bytes,
        sourceCallId: receipt.callId, sessionId: receipt.sessionId, purpose: 'retirement' }
      try {
        const pending = services.onSnapshot?.(archiveExec, receipt, 'retirement')
        if (pending && typeof pending.catch === 'function') pending.catch(() => {})
      } catch {}
      const policy = { modelUses, ...(boundary ?? {}) }
      const content = [{ type: 'text', text: MARKER + POLICY + JSON.stringify(policy) + '\n' +
        excerpt(text, config.excerptCharacters) + formatSnapshotReference(receipt) }]
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
      if (boundary && ((services.getTaskState && services.getTaskState() !== taskProvider) ||
        JSON.stringify(taskBoundary(taskProvider, session)) !== JSON.stringify(boundary))) {
        report('task-boundary-changed', { callId }); continue
      }
      if (signal?.aborted || agent.session !== session || session.seq !== revision ||
        JSON.stringify([...session.surface.nodes]) !== JSON.stringify(nodes) || !nodes.includes(seq) ||
        session.eventAt(seq) !== event || JSON.stringify(session.deriveEventMessage(event)) !== originalImage ||
        (name === 'read' && eligibleRead(services.readTracking, session, callId, retainedReads(session)) !== readState)) {
        report(signal?.aborted ? 'aborted' : 'history-changed', { callId }); continue
      }
      if (services.mode === 'observe') {
        report('observed', { callId, originalSeq: seq, economics, ...(snapshot ? { snapshot } : {}) }); continue
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
      report('retired', { callId, originalSeq: seq, replacementSeq: replacement.seq, economics, ...(snapshot ? { snapshot } : {}) })
      // A boundary is a one-shot trigger, durably recorded in the replacement.
      // Other candidates wait for a new explicit stage or the configured cooldown.
      if (boundary || config.minStepsBetweenRetirements > 0) break
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
        if (boundary || config.minStepsBetweenRetirements > 0) break
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
          getTaskState: () => ctx.get('freeContextTaskState'),
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
