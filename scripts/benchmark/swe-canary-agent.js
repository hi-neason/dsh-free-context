import { execFile } from 'node:child_process'
import { promisify, isDeepStrictEqual } from 'node:util'
import { mkdir, readFile, realpath, appendFile, writeFile } from 'node:fs/promises'
import { resolve, sep, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { validUsage, summarizeUsage, priceUsage, safeFailure } from '../evaluation-accounting.js'
import * as Plugin from '../../src/index.js'
import { parseConfig } from '../../src/config.js'

function freezeCopy(value) {
  const copy = structuredClone(value)
  const freeze = item => {
    if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item) }
    return item
  }
  return freeze(copy)
}
const defaultPluginConfiguration = { mode: 'apply', tools: ['bash'], json: { enabled: true }, text: { enabled: true }, logs: { enabled: true }, search: { enabled: false }, readText: { enabled: false } }
const execute = promisify(execFile)
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function dockerArgs(containerName, command) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)) throw new TypeError('Invalid container name')
  if (typeof command !== 'string') throw new TypeError('Invalid command')
  return ['exec', '-w', '/testbed', containerName, 'bash', '-lc', command]
}
export async function dockerCommand(containerName, command, signal) {
  try {
    const result = await execute('docker', dockerArgs(containerName, command), { signal, timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
    return { ...result, exitCode: 0 }
  } catch (error) {
    if (typeof error.code !== 'number') throw error
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code }
  }
}
export async function readSpill(root, path, offset = 1, limit = 200) {
  if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1 || limit > 2000) throw new TypeError('Invalid read window')
  const base = await realpath(root)
  const target = await realpath(resolve(root, path))
  if (!target.startsWith(base + sep)) throw new TypeError('Read outside run spill root')
  const lines = (await readFile(target, 'utf8')).split('\n')
  return { offset, totalLines: lines.length, lines: lines.slice(offset - 1, offset - 1 + limit) }
}
export function callReservation(request, maxOutputTokens, pricing) {
  // One UTF-8 byte per input token is intentionally conservative, with extra
  // room for provider serialization/framing. This is a guard, not billed cost.
  return ((Buffer.byteLength(JSON.stringify(request)) + 16384) * Math.max(pricing.uncached, pricing.cacheRead) + maxOutputTokens * pricing.output) / 1e6
}
export function completeCall(record) {
  return record.streamCompleted === true && ['stop', 'tool-calls', 'max-tokens'].includes(record.finish) && validUsage(record.usage)
}
export function budgetBlock(records, reserve, maxCalls, maxCostUSD, pricing, costGuard = 'request-reserve') {
  if (records.some(record => !completeCall(record) || priceUsage(record.usage, pricing) === null)) return 'incomplete-usage'
  if (records.length >= maxCalls) return 'max-calls'
  const spent = records.reduce((sum, record) => sum + priceUsage(record.usage, pricing), 0)
  if (costGuard === 'actual-usage') return spent >= maxCostUSD ? 'max-cost-actual' : null
  return spent + reserve > maxCostUSD ? 'max-cost-reserve' : null
}

/** Official AgentLoop restricted profile. Caller owns container isolation/lifecycle and scoring. */
export async function runSweCanaryTask({ directory, containerName, instanceId, problemStatement, key, pricing, group,
  model = 'deepseek-flash', thinking = 'disabled', reasoningEffort = 'off',
  pluginConfiguration = defaultPluginConfiguration, nativeInlineTokens,
  maxSteps = 20, maxCalls = 24, maxCostUSD = 0.03, costGuard = 'request-reserve', timeoutMs = 300000, maxOutputTokens = 2048,
  baseCommit, beforePatchExport, adapterFactory, commandExecutor = dockerCommand }) {
  if (!['request-reserve', 'actual-usage'].includes(costGuard)) throw new TypeError('Invalid costGuard')
  if (!['baseline-default', 'baseline-tuned', 'plugin'].includes(group)) throw new TypeError('Invalid group')
  if (typeof model !== 'string' || !model.trim() || model !== model.trim()) throw new TypeError('Explicit model required')
  if (pricing?.model !== undefined && pricing.model !== model) throw new TypeError('Model must match pricing.model')
  if (!['enabled', 'disabled'].includes(thinking) || !['off', 'low', 'high', 'max'].includes(reasoningEffort) ||
      (thinking === 'disabled') !== (reasoningEffort === 'off')) throw new TypeError('Invalid thinking/reasoningEffort combination')
  nativeInlineTokens ??= group === 'baseline-default' ? 12500 : 1200
  if (!Number.isSafeInteger(nativeInlineTokens) || nativeInlineTokens < 1) throw new TypeError('Invalid nativeInlineTokens')
  const parsedPlugin = parseConfig(pluginConfiguration)
  if (parsedPlugin.mode !== 'apply' || !isDeepStrictEqual(parsedPlugin.tools, ['bash'])) throw new TypeError('Benchmark plugin requires mode apply and tools bash')
  pricing = freezeCopy(pricing)
  const providerConfiguration = freezeCopy({ apiKeyEnv: 'DEEPSEEK_API_KEY', thinking, reasoningEffort, maxTokens: maxOutputTokens,
    streamIdleTimeoutMs: 30000, retryPolicy: { mode: 'normal', maxRetries: 0 } })
  const configuration = freezeCopy({ model, providerConfiguration, nativeInlineTokens,
    pluginConfiguration: group === 'plugin' ? parsedPlugin : null,
    limits: { maxSteps, maxCalls, maxCostUSD, costGuard, timeoutMs, maxOutputTokens }, pricing })
  dockerArgs(containerName, '')
  if (priceUsage({ inputTokens: 0, outputTokens: 0 }, pricing) === null) throw new TypeError('Explicit USD pricing required')
  for (const value of [maxSteps, maxCalls, timeoutMs, maxOutputTokens]) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid limit')
  if (!Number.isFinite(maxCostUSD) || maxCostUSD <= 0) throw new TypeError('Invalid cost limit')
  if (typeof problemStatement !== 'string' || !problemStatement.trim()) throw new TypeError('Problem statement required')
  if (!adapterFactory && model !== 'deepseek-flash') throw new TypeError('Real benchmark calls require deepseek-flash; other models are forbidden')
  if (!adapterFactory && !key) throw new TypeError('Provider key required')
  if (!/^[a-f0-9]{40}$/.test(baseCommit ?? '')) throw new TypeError('Immutable baseCommit required')
  directory = resolve(directory)
  await mkdir(dirname(directory), { recursive: true })
  await mkdir(directory)
  await writeFile(resolve(directory, '.run-reservation'), JSON.stringify({ instanceId, group }), { flag: 'wx' })
  const spillRoot = resolve(directory, 'spill')
  await mkdir(spillRoot, { recursive: true })
  const journal = resolve(directory, 'model-calls.jsonl')
  const append = record => appendFile(journal, JSON.stringify(record) + '\n')
  const runtime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
  const load = name => import(pathToFileURL(runtime.resolve(`@deepseek-ai/${name}`)).href)
  const { Context } = await load('cordis')
  const { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } = await load('dsh-agent-loop-testkit')
  const { LlmAdapter, createUserMessage } = await load('dsh-llm')
  const { defineTool } = await load('dsh-tools')
  const { default: SpillLocal } = await load('dsh-spill-local')
  const SpillPolicy = await load('dsh-spill-policy')
  const ctx = new Context()
  const modelCalls = [], toolCalls = [], decisions = []
  let toolsUncertain = false, sessionEndReason = null
  const activeTools = new Set()
  let agent, timer, stoppedReason = null, failure = null, cleanup = 'not-started', steps = 0
  const startedAt = new Date().toISOString()
  try {
    if (!adapterFactory) {
      const { createLaunchEnvironmentSnapshot } = await load('dsh-launch-environment')
      ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { DEEPSEEK_API_KEY: key } }]))
    }
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, systemPrompt: { personaPrefix: '' } })
    await ctx.plugin(SpillLocal, { root: spillRoot, cleanupPeriodDays: 0 })
    ctx.tools.register(defineTool({ name: 'bash', description: 'Execute shell commands in the isolated task container, working directory /testbed. Read and edit repository files and run tests here.', parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.stdout + (value.stderr ? '\nSTDERR:\n' + value.stderr : '') + (value.exitCode ? '\nExit code: ' + value.exitCode : '') }] },
      execute: async (args, exec) => {
        const pending = commandExecutor(containerName, args.command, exec.signal)
        activeTools.add(pending)
        try { return await pending } catch (error) { toolsUncertain = true; throw error } finally { activeTools.delete(pending) }
      } }))
    ctx.tools.register(defineTool({ name: 'read', description: 'Read ONLY a saved tool-result spill/snapshot locator from this run. For repository files use bash cat/sed inside /testbed. Offset is 1-based.', parameters: { file_path: { type: 'string', required: true }, offset: { type: 'integer' }, limit: { type: 'integer' } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.lines.map((line, i) => `${i + value.offset}: ${line}`).join('\n') }] },
      execute: args => readSpill(spillRoot, args.file_path, args.offset, args.limit) }))
    if (group === 'plugin') await ctx.plugin(Plugin, configuration.pluginConfiguration)
    await ctx.plugin(SpillPolicy, { maxInlineTokens: nativeInlineTokens })
    ctx.on('free-context/decision', record => { decisions.push(record) })
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const before = structuredClone(result.value)
      const decision = await next()
      toolCalls.push({ callId: exec.callId, name: exec.name, argumentsHash: hash(exec.arguments), originalContentHash: hash(result.content), contentHash: hash(decision.content ?? result.content), valuePreserved: isDeepStrictEqual(before, Object.hasOwn(decision, 'value') ? decision.value : result.value), isError: result.isError === true })
      return decision
    }, { prepend: true })
    ctx.on('llm/stream', (request, next) => (async function* () {
      if (!adapterFactory && request.model !== 'deepseek-flash') throw new TypeError('Real benchmark requests require deepseek-flash')
      // Actual-usage mode does not reserve an estimated next-request cost.
      const reservedUSD = costGuard === 'request-reserve' ? callReservation(request, maxOutputTokens, pricing) : 0
      const blocked = budgetBlock(modelCalls, reservedUSD, maxCalls, maxCostUSD, pricing, costGuard)
      if (blocked) { stoppedReason = blocked; throw new Error(blocked) }
      const record = { id: modelCalls.length + 1, startedAt: new Date().toISOString(), requestHash: hash(request), provider: request.provider, model: request.model, reservedUSD, usage: null, finish: null, streamCompleted: false,
        visibleToolResults: (request.messages ?? []).filter(message => message.role === 'tool').map(message => ({ callId: message.toolCallId, contentHash: hash(message.content) })) }
      await append({ type: 'start', ...record })
      modelCalls.push(record)
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') record.usage = chunk.usage
          if (chunk.type === 'finish') record.finish = chunk.reason.kind
          yield chunk
        }
        record.streamCompleted = true
      } catch (error) { record.failure = safeFailure(error); throw error }
      finally {
        record.endedAt = new Date().toISOString()
        record.costUSD = priceUsage(record.usage, pricing)
        if (!completeCall(record) || record.costUSD === null) stoppedReason ??= 'incomplete-usage'
        await append({ type: 'end', ...record })
      }
    })())
    if (adapterFactory) ctx.llm.registerAdapter(['replay'], adapterFactory({ LlmAdapter, configuration }))
    else await ctx.plugin(await load('dsh-llm-deepseek-api-key'), providerConfiguration)
    const harness = await mountAgentLoopTestHarness(ctx)
    ctx.on('agent/pre-step', async (_payload, next) => {
      if (stoppedReason) throw new Error(stoppedReason)
      if (++steps > maxSteps) { stoppedReason = 'max-steps'; throw new Error(stoppedReason) }
      return next()
    })
    agent = await harness.create(`swe-${randomUUID()}`, { provider: adapterFactory ? 'replay' : 'deepseek-official', model }, { cwd: directory })
    timer = setTimeout(() => { stoppedReason = 'timeout'; agent.cancel({ kind: 'hook', reason: 'evaluation-timeout' }) }, timeoutMs)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: `Fix the issue in the repository at /testbed. Use bash to inspect files, edit code, and run relevant tests. The bash tool runs only inside the task container. The read tool only reads saved output snapshots. Finish by briefly explaining the change and validation.\n\n${problemStatement}` }], source: { kind: 'user' } }))
    await agent.whenIdle()
  } catch (error) { failure = safeFailure(error) }
  finally {
    clearTimeout(timer)
    const events = agent?.session.snapshotEvents() ?? []
    sessionEndReason = events.filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind ?? null
    await writeFile(resolve(directory, 'session-events.json'), JSON.stringify(events, null, 2))
    await writeFile(resolve(directory, 'final-answer.json'), JSON.stringify(events.filter(event => event.type === 'assistant/message').at(-1)?.data.message ?? null, null, 2))
    try { await ctx.fiber.dispose(); cleanup = 'complete' } catch (error) { cleanup = safeFailure(error) }
  }
  let patchStatus = 'complete'
  try {
    if (cleanup !== 'complete' || activeTools.size || toolsUncertain || stoppedReason === 'timeout') throw new Error('Task processes not proven stopped')
    if (!adapterFactory && !beforePatchExport) throw new Error('Process cleanup callback required')
    if (beforePatchExport && await beforePatchExport({ containerName }) !== true) throw new Error('Process cleanup unconfirmed')
    const patch = await commandExecutor(containerName, `git add -N -- . && git -c core.fileMode=false diff --binary ${baseCommit}`, undefined)
    if (patch.exitCode !== 0) throw new Error('Patch export failed')
    await writeFile(resolve(directory, 'model.patch'), patch.stdout)
  } catch (error) { patchStatus = { state: 'unavailable', reason: 'process-cleanup-or-export-unconfirmed', failure: safeFailure(error) } }
  const summary = summarizeUsage(modelCalls.map(call => completeCall(call) ? call.usage : null))
  const result = { instanceId, group, baseCommit, startedAt, endedAt: new Date().toISOString(), profile: 'official AgentLoop restricted profile', simulated: Boolean(adapterFactory), model, modelCalls, toolCalls, decisions,
    steps, sessionEndReason, agentCompleted: !failure && !stoppedReason && sessionEndReason === 'completed' && modelCalls.at(-1)?.finish === 'stop', stoppedReason, failure, cleanup, patchStatus, usage: summary.usage, usageComplete: summary.complete,
    costUSD: summary.complete ? priceUsage(summary.usage, pricing) : null, maxCostUSD, costGuard, maxOutputTokens, pricing, configuration, thinking, reasoningEffort, nativeInlineTokens, pluginConfiguration: configuration.pluginConfiguration,
    retryPolicy: { mode: 'normal', maxRetries: 0 }, transportNote: 'Installed provider uses fetch; bounded Files stale-ID retry exists but this profile sends text only and no file IDs. Logical journal is not an HTTP billing audit.' }
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2))
  return result
}
