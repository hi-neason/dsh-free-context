// Loaded only by the isolated official CLI evaluation profile.
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { validUsage, priceUsage } from './evaluation-accounting.js'

const config = Object.freeze(JSON.parse(readFileSync(process.env.DSH_DEVELOPMENT_CONFIG, 'utf8')))
const hash = value => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
const record = event => appendFileSync(config.ledger, JSON.stringify({ ...event, manifestHash: config.manifestHash }) + '\n', { mode: 0o600 })
const sourceHash = () => {
  try { return createHash('sha256').update(readFileSync(join(config.workspace, 'src/json-codec.js'))).digest('hex') }
  catch { return null }
}
export const inject = ['llm', 'tools']
export async function apply(ctx) {
  const activeTools = new Set()
  ctx.on('tools/execute', async (exec, next) => {
    activeTools.add(exec.callId)
    try { return await next() } finally { activeTools.delete(exec.callId) }
  }, { prepend: true })
  process.once('exit', () => record({ type: 'process/exit', activeTools: [...activeTools] }))
  let steps = 0, calls = 0, incomplete = false, knownCost = 0
  ctx.on('agent/pre-step', async (_payload, next) => {
    if (++steps > config.maxSteps) { record({ type: 'limit', reason: 'max-steps' }); throw new Error('Development step limit') }
    return next()
  })
  ctx.on('llm/stream', (request, next) => (async function* () {
    if (incomplete || calls >= config.maxCalls || knownCost >= config.maxCostUSD) {
      record({ type: 'limit', reason: incomplete ? 'incomplete-cost-accounting' : 'model-budget' })
      throw new Error('Development model budget unavailable')
    }
    const call = { id: ++calls, agentStep: steps, kind: request.tools?.length ? 'agent' : 'auxiliary', provider: request.provider, model: request.model,
      visibleToolResults: (request.messages ?? []).filter(message => message.role === 'tool').map(message => ({ callId: message.toolCallId, contentHash: hash(message.content) })) }
    record({ type: 'model/start', ...call })
    let usage = null, finish = null, streamEnded = false
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = { ...chunk.usage }
        if (chunk.type === 'finish') finish = chunk.reason.kind
        yield chunk
      }
      streamEnded = true
    } finally {
      // Terminal truncation can be fully billed; persisted turn state still gates task quality.
      const complete = streamEnded && validUsage(usage) && ['stop', 'tool-calls', 'max-tokens'].includes(finish)
      const cost = complete && !config.replay ? priceUsage(usage, config.pricing) : null
      incomplete ||= !complete || !config.replay && cost === null
      if (cost !== null) knownCost += cost
      record({ type: 'model/end', id: call.id, usage, finish, complete })
    }
  })())
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    record({ type: 'tool', callId: exec.callId, name: exec.name, isError: result.isError === true,
      testCommand: exec.name === 'bash' && typeof exec.arguments?.command === 'string' && config.testCommands.includes(exec.arguments.command.trim()), exitCode: result.value?.exitCode ?? null,
      sourceHash: sourceHash(), contentHash: hash(decision.content ?? result.content), valueHash: hash(result.value),
      finalValueHash: hash(Object.hasOwn(decision, 'value') ? decision.value : result.value) })
    return decision
  }, { prepend: true })
  ctx.on('free-context/decision', event => record({ type: 'decision', callId: event.callId, outcome: event.outcome, strategy: event.strategy ?? null }))
  ctx.provide('developmentObservation', Object.freeze({ ready: true }))
}
