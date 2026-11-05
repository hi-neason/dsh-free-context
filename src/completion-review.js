import { createHash, randomUUID } from 'node:crypto'

export const completionReviewSource = 'free-context-completion-review-v1'
export const completionReviewText = [
  'Before completing, check the original task requirements one by one against the implementation and the publicly available operations they name.',
  'Check whether the implementation or regression tests substitute a shortcut that hides a missing requirement.',
  'Preserve the requested scope. Address only concrete omissions and run the necessary relevant tests.',
  'If no further change is needed, finish with a brief statement of the completed work and validation.',
].join(' ')

export function parseCompletionReview(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).some(key => !['enabled', 'maxStartStep'].includes(key))) throw new TypeError('Invalid completionReview options')
  const { enabled = false, maxStartStep = 48 } = input
  if (typeof enabled !== 'boolean' || !Number.isSafeInteger(maxStartStep) || maxStartStep < 2) throw new TypeError('Invalid completionReview options')
  return { enabled, maxStartStep }
}

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const reviewContentHash = hash([{ type: 'text', text: completionReviewText }])
const failedTurns = new WeakMap()
function marked(message, turn) { return message?.source?.kind === completionReviewSource && message.source.turn === turn }

/** Own trigger ceiling only; the host retains final step, budget and cancellation admission. */
export function completionReviewEligible({ agent, turn, signal }, maxStartStep) {
  if (signal?.aborted || agent?.status !== 'running' || !Number.isSafeInteger(turn) || typeof agent.steer !== 'function' ||
      typeof agent.session?.snapshotEvents !== 'function' || !Array.isArray(agent.inbox?.nextStep) || !Array.isArray(agent.inbox?.nextTurn)) return false
  if (failedTurns.get(agent.session) === turn || agent.inbox.nextStep.length || agent.inbox.nextTurn.some(message => marked(message, turn))) return false
  const events = agent.session.snapshotEvents()
  const start = events.findLastIndex(event => event.type === 'turn/start')
  if (start < 0 || events[start].data.turn !== turn) return false
  const current = events.slice(start + 1)
  if (current.some(event => event.type === 'turn/end' ||
      (event.type === 'user/message' && marked(event.data, turn)) ||
      (event.type === 'agent/inbox/spliced' && event.data.inserted?.some(message => marked(message, turn))))) return false
  if (current.some(event => ['assistant/message', 'assistant/attempt'].includes(event.type) && event.data.stream?.some(record =>
      record.type === 'chunk' && record.chunk?.type === 'finish' && ['max-tokens', 'error', 'aborted'].includes(record.chunk.reason?.kind)))) return false
  const stepStart = current.findLast(event => event.type === 'step/start')?.data
  const stepEnd = current.findLast(event => event.type === 'step/end')?.data
  if (!Number.isSafeInteger(stepStart?.step) || stepStart.step < 1 || stepStart.step >= maxStartStep ||
      stepStart.turn !== turn || stepEnd?.turn !== turn || stepEnd.step !== stepStart.step) return false
  const settlement = current.findLast(event => event.type === 'assistant/message' || event.type === 'assistant/attempt')
  if (settlement?.type !== 'assistant/message' || settlement.data.turn !== turn || settlement.data.step !== stepStart.step || settlement.data.interrupted) return false
  const { message, stream } = settlement.data
  if (!Array.isArray(message?.content) || message.content.some(block => block.type === 'tool-call') || !Array.isArray(stream)) return false
  const finishes = stream.filter(record => record.type === 'chunk' && record.chunk?.type === 'finish')
  // Require a unique explicit durable normal finish, never infer it from absence of tools.
  return finishes.length === 1 && finishes[0].chunk.reason?.kind === 'stop'
}

export function installCompletionReview(ctx, input, { mode = 'observe' } = {}) {
  const config = parseCompletionReview(input)
  if (!config.enabled || mode !== 'apply') return () => {}
  let active = true
  const offStream = ctx.on('llm/stream', (request, next) => {
    if (active) try {
      for (const message of request.messages ?? []) {
        if (message.role !== 'user' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(message.id ?? '') ||
            message.source?.kind !== completionReviewSource || !Number.isSafeInteger(message.source.turn) || message.source.turn < 1 ||
            hash(message.content) !== reviewContentHash) continue
        Promise.resolve(ctx.parallel('free-context/decision', {
          strategy: 'completion-review-v1', mode: 'observe', outcome: 'observed', reason: 'completion-review-model-visible',
          reviewId: message.id, contentHash: reviewContentHash, requestHash: hash(request),
        })).catch(() => {})
      }
    } catch {}
    return next()
  })
  const off = ctx.on('agent/turn-stopping', event => {
    if (!active || !completionReviewEligible(event, config.maxStartStep)) return
    const { agent, turn, signal } = event
    if (!active || signal?.aborted) return
    try {
      agent.steer({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: completionReviewText }], source: { kind: completionReviewSource, turn } })
    } catch {
      // A failed delivery must not fail the original task. Durable insertion, if any,
      // remains the once marker; this local guard also prevents immediate throw loops.
      failedTurns.set(agent.session, turn)
    }
  })
  const dispose = () => { active = false; off(); offStream() }
  ctx.effect?.(() => dispose)
  return dispose
}
