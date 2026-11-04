const estimateKind = 'dsh-rc2-text-v1'

function invalid() {
  throw new TypeError('Unsupported retirement text estimate')
}

function textLength(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) invalid()
  return value.length
}

/** The public dsh 0.2.1-rc.2 text heuristic, including its shadow-price framing.
 * This deliberately declines media and merge-extended blocks. It measures a
 * supported textual surface, independently of provider-reported usage.
 */
export function estimateRetirementMessage(message) {
  if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role) ||
      !Array.isArray(message.content)) invalid()
  if (message.role === 'system') {
    if (!message.content.length) return 0
    let characters = 0
    for (const block of message.content) {
      if (block?.type !== 'text') invalid()
      characters += textLength(block.text)
    }
    return Math.ceil(characters / 4) + 4
  }
  let tokens = 4
  for (const block of message.content) {
    if (block?.type === 'text' || block?.type === 'reasoning') {
      tokens += Math.ceil(textLength(block.text) / 4) + 4
    } else if (block?.type === 'tool-call') {
      tokens += Math.ceil(textLength(block.name) / 4) + Math.ceil(textLength(block.arguments) / 4) + 4
    } else invalid()
  }
  if (!Number.isSafeInteger(tokens)) invalid()
  return tokens
}

export function createRetirementTextMeter() {
  return Object.freeze({
    estimateKind,
    measurementScope: 'text-surface-only',
    estimateMessage: estimateRetirementMessage,
    measure(session) {
      const revision = session?.seq
      if (!Number.isSafeInteger(revision) || revision < 0 ||
          !Array.isArray(session?.surface?.nodes) || typeof session.eventAt !== 'function' ||
          typeof session.deriveEventMessage !== 'function' || typeof session.snapshotEvents !== 'function') invalid()
      const nodes = [...session.surface.nodes]
      if (new Set(nodes).size !== nodes.length) invalid()
      let surfaceTokens = 0
      for (const seq of nodes) {
        if (!Number.isSafeInteger(seq) || seq < 0 || seq >= revision) invalid()
        const event = session.eventAt(seq)
        if (!event || event.seq !== seq) invalid()
        const message = session.deriveEventMessage(event)
        if (message !== null) surfaceTokens += estimateRetirementMessage(message)
      }
      const events = session.snapshotEvents()
      if (!Array.isArray(events) || events.length !== revision ||
          events.some((event, index) => event?.seq !== index)) invalid()
      if (!Number.isSafeInteger(surfaceTokens) || session.seq !== revision ||
          JSON.stringify(session.surface.nodes) !== JSON.stringify(nodes)) invalid()
      return { logRevision: revision, surfaceTokens, estimateKind, measurementScope: 'text-surface-only' }
    },
  })
}
