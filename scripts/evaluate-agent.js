import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { decodeJsonRows } from '../src/json-codec.js'
import * as plugin from '../src/index.js'
import { loadFixtures } from './evaluate.js'

const runtime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
const load = name => import(pathToFileURL(runtime.resolve(`@deepseek-ai/${name}`)).href)
const { Context } = await load('cordis')
const { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } = await load('dsh-agent-loop-testkit')
const { LlmAdapter, createUserMessage } = await load('dsh-llm')
const { defineContentToolFixture } = await load('dsh-tools')
const { default: SpillLocal } = await load('dsh-spill-local')
const SpillPolicy = await load('dsh-spill-policy')
const ToolFs = await load('dsh-tool-fs')
const Provider = await load('dsh-llm-deepseek-api-key')
const { createLaunchEnvironmentSnapshot } = await load('dsh-launch-environment')
export const groups = ['baseline-default', 'baseline-tuned', 'plugin']
export const criteria = { exactFactsRequired: true, maxSteps: 8, timeoutMs: 120000, requiredTools: ['fixture'], snapshotTaskRequiresRead: true }

export async function agentFixtures() {
  const json = (await loadFixtures()).find(item => item.kind === 'json')
  const lines = ['TAP version 13']
  for (let i = 1; i <= 100; i++) lines.push(`# Subtest: check-${i}`, `ok ${i} - check-${i}`, '  ---', `  duration_ms: ${i === 50 ? '73.625' : '0.125'}`, "  type: 'test'", '  ...')
  lines.push('1..100', '# tests 100', '# suites 0', '# pass 100', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 120')
  return [{ ...json, text: JSON.stringify(JSON.parse(json.text), null, 2), query: `Call fixture first. ${json.query}` }, { id: 'tap-snapshot', kind: 'tap', text: lines.join('\n') + '\n',
    query: 'Call fixture, then read the ORIGINAL snapshot using read (not just the preview). Find the exact duration_ms for check-50. Return only JSON {"test":"check-50","duration_ms":NUMBER}. If the fixture output contains Original tool-result snapshot, you MUST read its locator; reading the user-supplied original path instead fails this task even if the answer matches. Otherwise read the fixture original path supplied by the user. Return exactly the JSON object, without Markdown fences or commentary. Do not guess.',
    expected: { test: 'check-50', duration_ms: 73.625 } }]
}

function chunks(block) {
  const tool = block.type === 'tool-call'
  return [{ type: 'block-start', index: 0, blockType: tool ? 'tool-call' : 'text' },
    { type: 'block-end', index: 0, block }, { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } },
    { type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } }]
}

class ReplayAdapter extends LlmAdapter {
  constructor(fixture, source, snapshotPath, delivered) { super(); this.delivered = delivered; this.fixture = fixture; this.source = source; this.snapshotPath = snapshotPath; this.calls = 0 }
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream() {
    this.calls++
    let block
    if (this.calls === 1) block = { type: 'tool-call', id: 'fixture-1', name: 'fixture', arguments: '{}' }
    else if (this.calls === 2 && (this.fixture.kind === 'tap' || this.delivered().includes('[...]'))) block = { type: 'tool-call', id: 'read-1', name: 'read', arguments: JSON.stringify({ file_path: this.snapshotPath() ?? this.source, offset: this.fixture.kind === 'tap' ? 280 : 240, limit: this.fixture.kind === 'tap' ? 35 : 12 }) }
    else {
      const text = this.delivered().replace(/^\s*\d+[:→|]\s?/gm, '')
      let answer = null
      if (this.fixture.kind === 'tap') {
        const match = text.match(/ok 50 - check-50\n\s*---\n\s*duration_ms: ([\d.]+)/)
        if (match) answer = { test: 'check-50', duration_ms: Number(match[1]) }
      } else {
        try {
          let value = JSON.parse(text)
          if (value.format === 'dsh-json-rows') value = JSON.parse(decodeJsonRows(text))
          const row = value.find(row => row.record_identifier === 'job-040')
          answer = { processing_status: row.processing_status, retry_count: row.retry_count }
        } catch { const match = text.match(/"record_identifier":\s*"job-040",\s*"deployment_environment":\s*"production",\s*"processing_status":\s*"([^"]+)",\s*"retry_count":\s*(\d+)/); if (match) answer = { processing_status: match[1], retry_count: Number(match[2]) } }
      }
      block = { type: 'text', text: JSON.stringify(answer) }
    }
    yield* chunks(block)
  }
}

const usageFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
function validUsage(usage) {
  return usage !== null && typeof usage === 'object' && usageFields.every((field, index) =>
    index > 1 && usage[field] === undefined || Number.isSafeInteger(usage[field]) && usage[field] >= 0)
}

/** Unknown or invalid attempts leave accounting incomplete, never silently free. */
export function summarizeUsage(records) {
  const usage = Object.fromEntries(usageFields.map(field => [field, 0]))
  let complete = records.length > 0
  for (const record of records) {
    if (!validUsage(record)) { complete = false; continue }
    for (const field of usageFields) {
      const total = usage[field] + (record[field] ?? 0)
      if (!Number.isSafeInteger(total)) complete = false
      else usage[field] = total
    }
  }
  return { usage, complete }
}

/** Explicit-price estimates, never billed charges. Input counts in DSH are disjoint. */
export function priceUsage(usage, prices) {
  if (!validUsage(usage)) return null
  if (!prices || prices.currency !== 'USD' || !['uncached', 'cacheRead', 'output'].every(key => Number.isFinite(prices[key]) && prices[key] >= 0) || !prices.sourceUrl) return null
  if ((usage.cacheWriteTokens ?? 0) > 0) return null
  const cost = (usage.inputTokens * prices.uncached + usage.outputTokens * prices.output + (usage.cacheReadTokens ?? 0) * prices.cacheRead) / 1e6
  return Number.isFinite(cost) ? cost : null
}

export async function runAgentFixture(fixture, group, { key, model = 'deepseek-flash', replay = false, prices, timeoutMs = criteria.timeoutMs } = {}) {
  if (!groups.includes(group)) throw new TypeError('Unknown evaluation group')
  if (!replay && !key) throw new TypeError('Missing explicit credential')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-eval-'))
  const source = join(directory, 'original.txt')
  await writeFile(source, fixture.text)
  const ctx = new Context()
  let agent
  let timer
  const decisions = []
  const toolCalls = []
  let steps = 0
  let stoppedReason
  let snapshotPath
  let delivered = ''
  const startedAt = new Date().toISOString()
  const started = performance.now()
  try {
    if (key) ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { DEEPSEEK_API_KEY: key } }]))
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, systemPrompt: { personaPrefix: '' } })
    await ctx.plugin(SpillLocal, { root: join(directory, 'spill'), cleanupPeriodDays: 0 })
    await ctx.plugin(ToolFs, { read: true, readImage: false, write: false, edit: false, readLimit: 1000 })
    // Actual official policy composition; the base bundle declares 12500.
    const maxInlineTokens = group === 'baseline-tuned' ? 1200 : 12500
    await ctx.plugin(SpillPolicy, { maxInlineTokens })
    if (group === 'plugin') await ctx.plugin(plugin, { mode: 'apply', tools: ['fixture'], minInputBytes: 0, logs: { enabled: true } })
    ctx.on('free-context/decision', record => decisions.push(record))
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      const content = decision.content ?? result.content
      const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      delivered = text
      const reference = text.match(/Original tool-result snapshot: (\{[^\n]+\})/)
      if (reference) snapshotPath = JSON.parse(reference[1]).locator
      toolCalls.push({ name: exec.name, bytes: Buffer.byteLength(text), isError: result.isError === true,
        ...(exec.name === 'read' ? { readSnapshot: exec.arguments.file_path === snapshotPath, readOriginal: exec.arguments.file_path === source } : {}) })
      return decision
    }, { prepend: true })
    ctx.tools.register(defineContentToolFixture({ name: 'fixture', description: 'Return immutable evaluation dataset.', parameters: {}, execute: async () => [{ type: 'text', text: fixture.text }] }))
    if (replay) ctx.llm.registerAdapter(['replay'], new ReplayAdapter(fixture, source, () => snapshotPath, () => delivered))
    else await ctx.plugin(Provider, { apiKeyEnv: 'DEEPSEEK_API_KEY', thinking: 'disabled', reasoningEffort: 'off', maxTokens: 1024, streamIdleTimeoutMs: 30000 })
    const harness = await mountAgentLoopTestHarness(ctx)
    ctx.on('agent/pre-step', async (_payload, next) => {
      if (++steps > criteria.maxSteps) { stoppedReason = 'max-steps'; throw new Error('Evaluation step limit') }
      return next()
    })
    agent = await harness.create(`eval-${group}-${fixture.id}`, { provider: replay ? 'replay' : 'deepseek-official', model }, { cwd: directory })
    timer = setTimeout(() => { stoppedReason = 'timeout'; agent.cancel({ kind: 'hook', reason: 'evaluation-timeout' }) }, timeoutMs)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: `${fixture.query}\nOriginal fixture path: ${source}` }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    const messages = events.filter(event => event.type === 'assistant/message')
    const attempts = events.filter(event => event.type === 'assistant/attempt')
    const { usage, complete: usageComplete } = summarizeUsage([...messages, ...attempts].map(event => event.data.usage))
    const text = messages.at(-1)?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    let actual
    try { actual = JSON.parse(text) } catch { actual = null }
    const exactFacts = isDeepStrictEqual(actual, fixture.expected)
    const requiredTools = toolCalls.some(call => call.name === 'fixture') && (fixture.kind !== 'tap' || toolCalls.some(call => call.name === 'read' && !call.isError))
    const snapshotRecovered = fixture.kind !== 'tap' || group !== 'plugin' || toolCalls.some(call => call.readSnapshot && !call.isError)
    const passed = exactFacts && requiredTools && snapshotRecovered && !stoppedReason && attempts.length === 0 && steps <= criteria.maxSteps
    return { task: fixture.id, group, replay, passed, exactFacts, requiredTools, snapshotRecovered, actual, finalAnswer: text ?? null, startedAt, steps,
      attempts: attempts.length, usageComplete,
      usageKind: replay ? 'synthetic-replay' : 'provider-reported', usage,
      estimatedCostUSD: replay || !usageComplete ? null : priceUsage(usage, prices), pricing: prices ?? null,
      elapsedMs: performance.now() - started, stoppedReason, toolCalls,
      decisions: decisions.map(({ strategy, outcome, reason, input, output }) => ({ strategy, outcome, reason, input, output })),
      configuration: { maxInlineTokens, plugin: group === 'plugin' },
      turnEnds: events.filter(event => event.type === 'turn/end').map(event => ({ kind: event.data.reason.kind, code: event.data.reason.error?.code })),
    }
  } finally {
    clearTimeout(timer)
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}

/** Quality alone cannot complete a live cost comparison. Replay has no monetary claim. */
export function agentCompletion(tasks, { replay = false } = {}) {
  const qualityComplete = tasks.length > 0 && tasks.every(task => task.passed)
  const usageComplete = tasks.length > 0 && tasks.every(task => task.usageComplete)
  const costComplete = !replay && usageComplete && tasks.every(task => {
    const price = priceUsage(task.usage, task.pricing)
    return price !== null && task.estimatedCostUSD === price
  })
  return { qualityComplete, usageComplete, costComplete,
    completed: qualityComplete && usageComplete && (replay || costComplete) }
}

export async function evaluateAgent(options = {}) {
  const tasks = []
  for (const fixture of await agentFixtures()) for (const group of groups) tasks.push(await runAgentFixture(fixture, group, options))
  return { evaluationKind: options.replay ? 'real-agent-loop-scripted-provider' : 'real-agent-loop-live-provider',
    model: options.model ?? 'deepseek-flash', criteria, groupOrder: groups,
    ...agentCompletion(tasks, options),
    limitations: ['Bounded fixed fixture tasks, not general coding workload evidence.', 'Baselines load real spill policy at base-bundle 12500 or tuned 1200; unrelated full CLI profile plugins are not loaded.', 'Fixed group order and shared provider cache confound comparisons; this is not a randomized repeated benchmark.', 'Price estimates apply caller-supplied uniform rates to the whole run; verify date, model, peak/off-peak and holiday regime. No automatic rate selection or billed-charge claim.', 'Incomplete usage exposes only known counts and yields null cost, not zero cost.'], tasks }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    const replay = args.includes('--replay')
    const get = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
    const file = get('--credential-file')
    const key = file ? (await readFile(file, 'utf8')).trim() : process.env.DEEPSEEK_API_KEY
    const prices = get('--pricing-file') ? JSON.parse(await readFile(get('--pricing-file'), 'utf8')) : undefined
    const report = await evaluateAgent({ replay, key, prices, model: get('--model') })
    console.log(JSON.stringify(report, null, 2))
    if (!report.completed) process.exitCode = 1
  } catch {
    console.error('Agent evaluation failed to start or complete; no credential or provider error body printed.')
    process.exitCode = 1
  }
}
