import { createHash, randomUUID } from 'node:crypto'

const contentHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export const executionHintSource = 'free-context-execution-hints-v1'
export const executionHintText = [
  'Execution guidance for this task. Preserve the requested scope and investigate failures.',
  'Identify the repository-supported test runner and required settings before running tests.',
  'Read relevant source line ranges and reuse observations instead of repeating truncated whole-file reads.',
  'Derive regression scenarios from the task requirements and exercise the public operations it names. Do not substitute a convenient internal shortcut for the requested behavior.',
  'Confirm the regression fails before the fix, then verify each stated condition and relevant state or boundary variation, along with the related test suite.',
  'Use the supplied task and repository as evidence; do not hunt for benchmark artifacts or prewritten reference fixes.',
  'Run necessary validation and inspect the diff before finishing.',
  'Repeat a passing test when code, inputs, or environment changed, or a concrete unresolved question requires it. Otherwise reuse its result.',
  'Complete necessary verification and failure investigation, then summarize the change and evidence.',
].join(' ')

/** Adds workflow guidance to admitted inbox content. This changes behavior, not compression. */
export function installExecutionHints(ctx, { enabled = false } = {}, { mode = 'observe' } = {}) {
  if (!enabled || mode !== 'apply') return () => {}
  let active = true
  const notices = new Map()
  const offStream = ctx.on('llm/stream', (request, next) => {
    try {
      for (const message of request.messages ?? []) {
        const notice = notices.get(message.id)
        if (!notice || message.source?.kind !== executionHintSource || message.source.turn !== notice.turn ||
            contentHash(message.content) !== notice.contentHash) continue
        Promise.resolve(ctx.parallel('free-context/decision', {
          strategy: 'execution-hints-v1', mode: 'observe', outcome: 'observed',
          reason: 'execution-hint-model-visible', hintId: message.id,
          contentHash: notice.contentHash, requestHash: contentHash(request),
        })).catch(() => {})
      }
    } catch {}
    return next()
  })
  const offStep = ctx.on('agent/pre-step', async (event, next) => {
    const decision = await next()
    if (!active || event.signal?.aborted || decision?.kind !== 'enter' || !event.messages?.length ||
        !decision.messages?.length || !Number.isSafeInteger(event.turn)) return decision
    // Downstream filters may remove the waking inbox while retaining runtime context.
    // Only decorate a decision that still admits an original inbox message.
    const originalIds = new Set(event.messages.map(message => message.id))
    if (!decision.messages.some(message => originalIds.has(message.id))) return decision
    if (decision.messages.some(message => message.source?.kind === executionHintSource && message.source.turn === event.turn)) return decision
    const session = event.agent?.session
    if (typeof session?.snapshotEvents !== 'function') return decision
    const events = session.snapshotEvents()
    let start = events.length - 1
    while (start >= 0 && events[start].type !== 'turn/start') start--
    if (start < 0 || events[start].data.turn !== event.turn) return decision
    const current = events.slice(start + 1)
    if (current.some(record => record.type === 'turn/end' || record.type === 'step/start' ||
        (record.type === 'user/message' && record.data.source?.kind === executionHintSource))) return decision
    const notice = {
      id: randomUUID(), role: 'user', content: [{ type: 'text', text: executionHintText }],
      source: { kind: executionHintSource, turn: event.turn },
    }
    notices.set(notice.id, { turn: event.turn, contentHash: contentHash(notice.content) })
    while (notices.size > 256) notices.delete(notices.keys().next().value)
    return { ...decision, messages: [...decision.messages, notice] }
  })
  const dispose = () => { active = false; offStep(); offStream(); notices.clear() }
  ctx.effect?.(() => dispose)
  return dispose
}
