import { containsPlaceholder, validateResponseSchema, responseSchemaIssues, phaseResponseSchema } from './evaluation-contract.js'
import { validUsage, summarizeUsage, priceUsage, safeFailure } from './evaluation-accounting.js'
export { summarizeUsage, priceUsage } from './evaluation-accounting.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { decodeLosslessText } from '../src/lossless-text.js'
import { formatSnapshotReference } from '../src/snapshot.js'
import { verifySnapshot } from '../src/recovery.js'
import { decodeJsonRows } from '../src/json-codec.js'
import * as plugin from '../src/index.js'
import * as experimentsPlugin from '../src/experiments.js'
import { createFilesystemReadClassifier } from '../src/read-source-classifier.js'
import { loadFixtures } from './evaluate.js'

const runtime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
export const agentRuntimePackagePath = runtime.resolve('./package.json')
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
    else if ((this.calls === 2 && (this.fixture.kind === 'tap' || this.delivered().includes('[...]'))) ||
      (this.snapshotPath() && this.lastReadPath !== this.snapshotPath())) {
      this.lastReadPath = this.snapshotPath() ?? this.source
      block = { type: 'tool-call', id: `read-${this.calls}`, name: 'read', arguments: JSON.stringify({ file_path: this.lastReadPath, offset: this.fixture.kind === 'tap' ? 280 : 240, limit: this.fixture.kind === 'tap' ? 35 : 12 }) }
    }
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

const contentHash = content => createHash('sha256').update(JSON.stringify(content)).digest('hex')

/** Only persisted tool results actually sent to a later model request prove adoption. */
export function collectAdoptions(events, modelCalls) {
  return events.filter(event => event.type === 'tool/result').flatMap(event => {
    const message = event.data.message
    if (message.isError) return []
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const strategy = text.match(/^\[LOSSY (?:paragraph|diagnostic evidence) selection; policy ([a-z-]+-v1)\./)?.[1]
    if (!strategy) return []
    const hash = contentHash(message.content)
    const visible = modelCalls.flatMap(call => call.visibleToolResults ?? []).find(result => result.callId === message.toolCallId && result.contentHash === hash)
    return [{ callId: message.toolCallId, strategy, persisted: true, modelVisible: Boolean(visible), contentHash: hash,
      persistedContentHash: hash, modelVisibleContentHash: visible?.contentHash ?? null }]
  })
}

/** Read attribution is separate from auxiliary selection and requires a final valid frame. */
export function collectReadAdoptions(events, modelCalls, decisions, toolCalls) {
  const strategies = ['read-lossless-text-v1', 'read-artifact-lossless-text-v1']
  return events.filter(event => event.type === 'tool/result').flatMap(event => {
    const message = event.data?.message
    if (!message || message.isError || !Array.isArray(message.content) || message.content.length !== 1 ||
      message.content[0]?.type !== 'text' || typeof message.content[0].text !== 'string' ||
      !toolCalls.some(call => call.callId === message.toolCallId && call.name === 'read' && !call.isError)) return []
    const selected = decisions.filter(decision => decision.callId === message.toolCallId && decision.outcome === 'selected' && strategies.includes(decision.strategy))
    if (selected.length !== 1) return []
    const strategy = selected[0].strategy
    const text = message.content[0].text
    try {
      if (strategy === 'read-artifact-lossless-text-v1') decodeLosslessText(text)
      else {
        const boundary = text.indexOf('\n\nOriginal tool-result snapshot: ')
        if (boundary < 0) return []
        const footer = text.slice(boundary + 2)
        const receipt = JSON.parse(footer.split('\n')[0].slice('Original tool-result snapshot: '.length))
        const fields = ['sessionId', 'callId', 'toolName', 'sha256', 'bytes', 'locator', 'retrievalHint']
        if (!receipt || Object.getPrototypeOf(receipt) !== Object.prototype || Object.keys(receipt).length !== fields.length ||
            !fields.every(key => Object.hasOwn(receipt, key)) ||
            ['sessionId', 'callId', 'locator', 'retrievalHint'].some(key => typeof receipt[key] !== 'string' || !receipt[key].trim()) ||
            selected[0].sessionId !== undefined && receipt.sessionId !== selected[0].sessionId ||
            receipt.callId !== message.toolCallId || receipt.toolName !== 'read' || footer !== formatSnapshotReference(receipt)) return []
        verifySnapshot(receipt, Buffer.from(decodeLosslessText(text.slice(0, boundary)), 'utf8'))
      }
    } catch { return [] }
    const hash = contentHash(message.content)
    const visible = modelCalls.flatMap(call => call.visibleToolResults ?? []).find(result => result.callId === message.toolCallId && result.contentHash === hash)
    return [{ callId: message.toolCallId, strategy, persisted: true, modelVisible: Boolean(visible), contentHash: hash,
      persistedContentHash: hash, modelVisibleContentHash: visible?.contentHash ?? null }]
  })
}

export async function runAgentFixture(fixture, group, { key, model = 'deepseek-flash', replay = false, prices, historyRetirement, timeoutMs = criteria.timeoutMs, experimentalConfig, adapterFactory, maxSteps = criteria.maxSteps, configureContext, composeWithTunedNative = false, validationFeedbackLimit = 0, readText = false, encodeArtifacts = false } = {}) {
  if (typeof readText !== 'boolean') throw new TypeError('readText must be a boolean')
  if (typeof encodeArtifacts !== 'boolean' || encodeArtifacts && !readText) throw new TypeError('encodeArtifacts requires boolean readText enabled')
  if (!Number.isSafeInteger(validationFeedbackLimit) || validationFeedbackLimit < 0 || validationFeedbackLimit > 2) throw new TypeError('Validation feedback limit must be 0..2')
  if (fixture.rejectPlaceholderValues !== undefined && typeof fixture.rejectPlaceholderValues !== 'boolean') throw new TypeError('Placeholder response contract must be boolean')
  if (fixture.discoverSourcePath !== undefined && typeof fixture.discoverSourcePath !== 'boolean') throw new TypeError('Source discovery must be boolean')
  validateResponseSchema(fixture.responseSchema)
  for (const phase of fixture.phases ?? []) validateResponseSchema(phaseResponseSchema(fixture, phase))
  if (!groups.includes(group)) throw new TypeError('Unknown evaluation group')
  if (!replay && !key) throw new TypeError('Missing explicit credential')
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'dsh-agent-eval-'))
  const directory = readText ? await realpath(temporaryDirectory) : temporaryDirectory
  const source = join(directory, fixture.discoverSourcePath ? `source-${randomUUID()}.txt` : 'original.txt')
  const spillRoot = join(directory, 'spill')
  const readClassification = readText && group === 'plugin' ? {
    sourceRoots: [directory], artifactRoots: [spillRoot], artifactInventoryComplete: true,
  } : undefined
  const fixtureContent = fixture.discoverSourcePath ? `${fixture.text}\n\nOriginal fixture path: ${source}` : fixture.text
  await writeFile(source, fixture.text)
  const ctx = new Context()
  let agent
  let timer
  const decisions = []
  const toolCalls = []
  const retirements = []
  const modelCalls = []
  const experiments = []
  const phaseResults = []
  const drafts = []
  const feedback = []
  let phaseIndex = 0
  let steps = 0
  let stoppedReason
  let outcome
  let snapshotPath
  let delivered = ''
  const startedAt = new Date().toISOString()
  const started = performance.now()
  try {
    if (key) ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { DEEPSEEK_API_KEY: key } }]))
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, ...(fixture.ptc ? { tools: { mode: 'ptc' } } : {}), systemPrompt: { personaPrefix: '' } })
    ctx.on('llm/stream', (request, next) => (async function* () {
      const visibleToolResults = (request.messages ?? []).filter(message => message.role === 'tool').map(message => ({ callId: message.toolCallId, contentHash: contentHash(message.content) }))
      const record = { visibleToolResults, id: modelCalls.length + 1, agentStep: steps, kind: request.tools?.length ? 'agent' : 'auxiliary', provider: request.provider, model: request.model, usage: null, finish: null }
      modelCalls.push(record)
      // Observed block-end text is diagnostic evidence, not a valid or complete
      // selector answer. Bound retained bodies and metadata independently.
      const observed = record.kind === 'auxiliary' ? { bytes: 0, blockCount: 0, omitted: false, blocks: [] } : undefined
      const observedHash = observed ? createHash('sha256') : undefined
      let retainedBytes = 0
      if (observed) record.observedAuxiliaryTextBlocks = observed
      try {
        for await (const chunk of next()) {
          if (observed && chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
            const text = chunk.block.text
            const bytes = Buffer.byteLength(text)
            observed.bytes += bytes
            observed.blockCount++
            observedHash.update(text)
            if (observed.blocks.length < 16) {
              const block = { index: Number.isSafeInteger(chunk.index) && chunk.index >= 0 ? chunk.index : null, bytes, sha256: createHash('sha256').update(text).digest('hex') }
              if (bytes <= 16 * 1024 - retainedBytes) { block.text = text; retainedBytes += bytes }
              else { block.omitted = true; observed.omitted = true }
              observed.blocks.push(block)
            } else observed.omitted = true
          }
          if (chunk.type === 'usage') record.usage = chunk.usage
          if (chunk.type === 'finish') record.finish = chunk.reason.kind
          yield chunk
        }
      } finally {
        // This aggregate hashes concatenated observed block texts, including
        // omitted bodies/blocks; it does not imply a successful response.
        if (observed) observed.sha256 = observedHash.digest('hex')
        record.complete = validUsage(record.usage) && record.finish !== null
      }
    })())
    if (fixture.ptc) {
      for (const name of ['dsh-subprocess-local', 'dsh-sandbox-local']) { const module = await load(name); await ctx.plugin(module.default ?? module) }
      await ctx.plugin((await load('dsh-sandbox-policy')).default, { mode: 'read-only' })
      await ctx.plugin((await load('dsh-ptc-runtime-node')).NodePtcRuntime, { timeoutMs: 15000, maxTimeoutMs: 15000 })
    }
    // SpillLocal creates storage lazily. The classifier requires every declared
    // root to exist even before the first save; never infer source from a miss.
    if (readText) await mkdir(spillRoot, { mode: 0o700 })
    await ctx.plugin(SpillLocal, { root: spillRoot, cleanupPeriodDays: 0 })
    if (readClassification) ctx.provide('freeContextReadClassifier', createFilesystemReadClassifier(readClassification))
    await ctx.plugin(ToolFs, { read: true, readImage: false, write: fixture.edit === true, edit: fixture.edit === true, readLimit: 1000 })
    // Actual official policy composition; the base bundle declares 12500.
    const maxInlineTokens = group === 'baseline-tuned' || composeWithTunedNative && group === 'plugin' ? 1200 : 12500
    if (!composeWithTunedNative) await ctx.plugin(SpillPolicy, { maxInlineTokens })
    if (historyRetirement) {
      const { default: TokenMeter } = await load('dsh-token-meter')
      await ctx.plugin(TokenMeter)
      ctx.on('free-context/retirement', record => {
        retirements.push({ ...record, beforeStep: steps + 1 })
        if (record.reason === 'retired') {
          const text = agent.session.eventAt(record.replacementSeq).data.message.content[0].text
          const reference = text.match(/Original tool-result snapshot: (\{[^\n]+\})/)
          if (reference) snapshotPath = JSON.parse(reference[1]).locator
        }
      })
    }
    if (group === 'plugin') await ctx.plugin(plugin, historyRetirement
      ? { mode: 'apply', tools: readText ? ['read'] : [], retirement: historyRetirement,
        ...(readText ? { readText: { enabled: true, ...(encodeArtifacts ? { encodeArtifacts: true } : {}) } } : {}) }
      : { mode: 'apply', tools: [fixture.ptc ? 'run_code' : 'fixture', ...(readText ? ['read'] : [])], minInputBytes: 0, logs: { enabled: true },
        ...(readText ? { readText: { enabled: true, ...(encodeArtifacts ? { encodeArtifacts: true } : {}) } } : {}) })
    if (group === 'plugin' && experimentalConfig) {
      ctx.provide('freeContextQuery', { getQuery: () => fixture.phases?.[phaseIndex]?.query ?? fixture.query })
      await ctx.plugin(experimentsPlugin, experimentalConfig)
    }
    if (composeWithTunedNative) await ctx.plugin(SpillPolicy, { maxInlineTokens })
    ctx.on('free-context/experiment', record => experiments.push(record))
    ctx.on('free-context/decision', record => decisions.push(record))
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      const content = decision.content ?? result.content
      const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      delivered = text
      const expectedSnapshotPath = snapshotPath
      const reference = text.match(/Original tool-result snapshot: (\{[^\n]+\})/)
      // Read encoding creates its own rendered-text snapshot. It must not
      // replace the fixture/retirement snapshot required by the task protocol.
      if (reference && ['fixture', 'run_code'].includes(exec.name)) snapshotPath = JSON.parse(reference[1]).locator
      let readWindow
      if (exec.name === 'read') {
        const requested = Object.fromEntries(['offset', 'limit'].filter(key => Number.isSafeInteger(exec.arguments[key]) && exec.arguments[key] >= 1).map(key => [key, exec.arguments[key]]))
        const value = Object.hasOwn(decision, 'value') ? decision.value : result.value
        const knownRange = Number.isSafeInteger(value?.offset) && value.offset >= 1 && Number.isSafeInteger(value.totalLines) && value.totalLines >= 0 &&
          Array.isArray(value.lines) && value.lines.every((line, index) => line?.number === value.offset + index && line.number <= value.totalLines)
        readWindow = { requested, returned: knownRange ? { offset: value.offset, lineCount: value.lines.length, totalLines: value.totalLines,
          coversAllReportedLines: value.offset === 1 && value.lines.length === value.totalLines } : null,
          contentReplaced: Object.hasOwn(decision, 'content'), valueReplaced: Object.hasOwn(decision, 'value'), byteVerified: false }
      }
      toolCalls.push({ callId: exec.callId, name: exec.name, phase: phaseIndex, bytes: Buffer.byteLength(text), isError: result.isError === true,
        ...(exec.name === 'read' ? { readSnapshot: exec.arguments.file_path === expectedSnapshotPath, readOriginal: exec.arguments.file_path === source, readWindow } : {}) })
      return decision
    }, { prepend: true })
    ctx.tools.register(defineContentToolFixture({ name: 'fixture', description: 'Return immutable evaluation dataset.', parameters: {}, execute: async () => [{ type: 'text', text: fixtureContent }] }))
    if (replay) ctx.llm.registerAdapter(['replay'], adapterFactory ? adapterFactory({ LlmAdapter, fixture, source, snapshotPath: () => snapshotPath, delivered: () => delivered, phase: () => phaseIndex }) : new ReplayAdapter(fixture, source, () => snapshotPath, () => delivered))
    else await ctx.plugin(Provider, { apiKeyEnv: 'DEEPSEEK_API_KEY', thinking: 'disabled', reasoningEffort: 'off', maxTokens: 1024, streamIdleTimeoutMs: 30000 })
    await configureContext?.(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    ctx.on('agent/pre-step', async (_payload, next) => {
      if (++steps > maxSteps) { stoppedReason = 'max-steps'; throw new Error('Evaluation step limit') }
      return next()
    })
    agent = await harness.create(`eval-${group}-${fixture.id}`, { provider: replay ? 'replay' : 'deepseek-official', model }, { cwd: directory })
    timer = setTimeout(() => { stoppedReason = 'timeout'; agent.cancel({ kind: 'hook', reason: 'evaluation-timeout' }) }, timeoutMs)
    for (const [index, phase] of (fixture.phases ?? [{ query: fixture.query, expected: fixture.expected }]).entries()) {
      phaseIndex = index
      let prompt = fixture.discoverSourcePath ? `${phase.query}\nCall fixture to discover the original source locator before reading it.` : `${phase.query}\nOriginal fixture path: ${source}`
      for (let correction = 0; correction <= validationFeedbackLimit; correction++) {
        const eventBoundary = agent.session.snapshotEvents().length
        agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
        await agent.whenIdle()
        const phaseEvents = agent.session.snapshotEvents().slice(eventBoundary)
        const turnCompleted = phaseEvents.filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind === 'completed'
        const phaseMessages = phaseEvents.filter(event => event.type === 'assistant/message')
        const answer = phaseMessages.at(-1)?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        let actual = null
        let parsed = false
        try { actual = JSON.parse(answer); parsed = true } catch {}
        const issues = []
        if (!turnCompleted || !phaseMessages.length) issues.push('This phase did not produce a fresh answer in a completed turn.')
        const responseSchema = phaseResponseSchema(fixture, phase)
        const rootValid = responseSchema !== undefined || actual !== null && typeof actual === 'object'
        if (!parsed || !rootValid) issues.push(responseSchema === undefined ? 'Return the requested JSON object only, without prose or Markdown.' : 'Return valid JSON only, without prose or Markdown.')
        if (parsed) issues.push(...responseSchemaIssues(actual, responseSchema).map(issue => `Response schema: ${issue}`))
        if (parsed && fixture.rejectPlaceholderValues && containsPlaceholder(actual)) issues.push('The response contains placeholder values instead of the requested source facts. Inspect available original evidence and return supported literal values, without placeholders.')
        if (!toolCalls.some(call => call.name === (fixture.ptc ? 'run_code' : 'fixture') && !call.isError && (!fixture.requireFixtureEachPhase || call.phase === index))) issues.push('Use the required fixture tool in this phase before answering.')
        if (fixture.requireReadEachPhase && !toolCalls.some(call => call.phase === index && call.name === 'read' && !call.isError)) issues.push('Read the required source in this phase before answering.')
        const needsSnapshot = group === 'plugin' && (fixture.kind === 'tap' || fixture.requireSnapshot) && (!historyRetirement || retirements.some(record => record.reason === 'retired'))
        if (needsSnapshot && !toolCalls.some(call => call.phase === index && call.readSnapshot && !call.isError)) issues.push('Read the ORIGINAL snapshot locator from the latest tool result or retirement replacement in history now. Do not call fixture again or substitute the user original file.')
        if (fixture.edit && index === (fixture.phases?.length ?? 1) - 1 && !toolCalls.some(call => call.phase === index && ['edit', 'write'].includes(call.name) && !call.isError)) issues.push('Perform the requested file edit and verify it by reading the file.')
        drafts.push({ phase: index, correction, actual, exactFacts: isDeepStrictEqual(actual, phase.expected), issues })
        if (!issues.length || correction === validationFeedbackLimit || stoppedReason || steps >= maxSteps) {
          phaseResults.push({ actual, turnCompleted, freshAnswer: phaseMessages.length > 0, passed: parsed && rootValid && turnCompleted && phaseMessages.length > 0 && isDeepStrictEqual(actual, phase.expected), ...(responseSchema !== undefined ? { responseText: answer ?? null } : {}) })
          break
        }
        feedback.push({ phase: index, correction: correction + 1, issues })
        prompt = `Validation feedback: ${issues.join(' ')} Recheck the source evidence and satisfy the original request. No expected answer is supplied.`
      }
      if (stoppedReason) break
    }
    const events = agent.session.snapshotEvents()
    const messages = events.filter(event => event.type === 'assistant/message')
    const attempts = events.filter(event => event.type === 'assistant/attempt')
    const { usage, complete: usageComplete } = summarizeUsage(modelCalls.map(call => call.complete ? call.usage : undefined))
    const text = messages.at(-1)?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    let actual
    try { actual = JSON.parse(text) } catch { actual = null }
    const exactFacts = phaseResults.length === (fixture.phases?.length ?? 1) && phaseResults.every(phase => phase.passed)
    const requiredTools = toolCalls.some(call => call.name === (fixture.ptc ? 'run_code' : 'fixture')) &&
      (!fixture.requireFixtureEachPhase || phaseResults.every((_, phase) => toolCalls.some(call => call.phase === phase && call.name === (fixture.ptc ? 'run_code' : 'fixture') && !call.isError))) &&
      (!fixture.edit || toolCalls.some(call => ['write', 'edit'].includes(call.name) && !call.isError)) &&
      (!fixture.requireReadEachPhase || phaseResults.every((_, index) => toolCalls.some(call => call.phase === index && call.name === 'read' && !call.isError))) && (fixture.kind !== 'tap' || toolCalls.some(call => call.name === 'read' && !call.isError))
    const snapshotRecoveryRequired = (fixture.kind === 'tap' || fixture.requireSnapshot) && group === 'plugin' &&
      (!historyRetirement || retirements.some(record => record.reason === 'retired'))
    const snapshotRecoveryByPhase = phaseResults.map((_, phase) => ({ phase, recovered: toolCalls.some(call => call.phase === phase && call.readSnapshot && !call.isError) }))
    const snapshotRecovered = !snapshotRecoveryRequired || (fixture.requireSnapshot ? snapshotRecoveryByPhase.every(phase => phase.recovered) : toolCalls.some(call => call.readSnapshot && !call.isError))
    const failedTurn = events.some(event => event.type === 'turn/end' && event.data.reason.kind !== 'completed')
    const responseContractSatisfied = !fixture.rejectPlaceholderValues || phaseResults.every(phase => !containsPlaceholder(phase.actual))
    const responseSchemaSatisfied = phaseResults.every((phase, index) => {
      const schema = phaseResponseSchema(fixture, fixture.phases?.[index] ?? fixture)
      if (schema === undefined) return true
      try { return typeof phase.responseText === 'string' && isDeepStrictEqual(JSON.parse(phase.responseText), phase.actual) && responseSchemaIssues(phase.actual, schema).length === 0 }
      catch { return false }
    })
    const passed = responseSchemaSatisfied && responseContractSatisfied && exactFacts && requiredTools && snapshotRecovered && !failedTurn && !stoppedReason && attempts.length === 0 && steps <= maxSteps
    const fileCorrect = !fixture.edit || await readFile(source, 'utf8') === fixture.editedText
    outcome = { task: fixture.id, group, replay, passed: passed && fileCorrect, fileCorrect, exactFacts, requiredTools, snapshotRecoveryRequired, snapshotRecovered, actual, finalAnswer: text ?? null, startedAt, steps,
      drafts, feedback, correctionCount: feedback.length, responseContractSatisfied, responseSchemaSatisfied, attempts: attempts.length, usageComplete, modelCalls, phaseResults, experiments, snapshotRecoveryByPhase,
      adoptions: collectAdoptions(events, modelCalls),
      readAdoptions: collectReadAdoptions(events, modelCalls, decisions, toolCalls),
      recoveryCalls: toolCalls.filter(call => call.readSnapshot).length,
      usageKind: replay ? 'synthetic-replay' : 'provider-reported', usage,
      estimatedCostUSD: replay || !usageComplete ? null : priceUsage(usage, prices), pricing: prices ?? null,
      elapsedMs: performance.now() - started, stoppedReason, toolCalls,
      ...(historyRetirement ? { historyRetirement, retirements: retirements.map(record => ({ ...record,
        ...(record.reason === 'retired' ? { actualPostRetirementSteps: steps - record.beforeStep + 1 } : {}) })) } : {}),
      decisions: decisions.map(({ strategy, outcome, reason, input, output }) => ({ strategy, outcome, reason, input, output })),
      configuration: { maxInlineTokens, plugin: group === 'plugin', nativePolicyInstalledAfterPlugin: composeWithTunedNative, validationFeedbackLimit, maxSteps, timeoutMs,
        ...(readText ? { readText: { enabled: group === 'plugin', classifier: 'filesystem-host-v1', minimumSavingsRatio: 0.5, ...(encodeArtifacts ? { encodeArtifacts: group === 'plugin' } : {}) } } : {}) },
      ...(readClassification ? { readClassification } : {}),
      turnEnds: events.filter(event => event.type === 'turn/end').map(event => ({ kind: event.data.reason.kind, code: event.data.reason.error?.code })),
    }
    return outcome
  } catch (error) {
    const { usage } = summarizeUsage(modelCalls.map(call => call.complete ? call.usage : undefined))
    outcome = { task: fixture.id, group, replay, passed: false, exactFacts: false, requiredTools: false, fileCorrect: false, snapshotRecovered: false,
      readAdoptions: [], failure: safeFailure(error), stoppedReason: 'runner-exception', usageComplete: false, usage, modelCalls, phaseResults, drafts, feedback, correctionCount: feedback.length, toolCalls, experiments, retirements,
      usageKind: replay ? 'synthetic-replay' : 'provider-reported', estimatedCostUSD: null, pricing: prices ?? null, steps, startedAt, elapsedMs: performance.now() - started }
    return outcome
  } finally {
    clearTimeout(timer)
    const failures = []
    try { await ctx.fiber.dispose() } catch (error) { failures.push({ phase: 'context-dispose', failure: safeFailure(error) }) }
    try { await rm(directory, { recursive: true, force: true }) } catch (error) { failures.push({ phase: 'directory-cleanup', failure: safeFailure(error) }) }
    if (outcome) {
      const refreshed = summarizeUsage(modelCalls.map(call => call.usage))
      outcome.usage = refreshed.usage
      outcome.usageComplete = !outcome.failure && failures.length === 0 && refreshed.complete && modelCalls.every(call => call.complete)
      outcome.estimatedCostUSD = replay || !outcome.usageComplete ? null : priceUsage(outcome.usage, prices)
      outcome.cleanup = { complete: failures.length === 0, failures }
      outcome.elapsedMs = performance.now() - started
      if (failures.length) {
        outcome.passed = false
        outcome.stoppedReason ??= 'cleanup-failed'
      }
    }
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

/** Console output never traverses or prints auxiliary evidence, even a malformed
 * same-named field inside a model answer. Full evidence belongs in private logs. */
export function evaluationConsoleReplacer(key, value) {
  return key === 'observedAuxiliaryTextBlocks' ? { consoleTextOmitted: true } : value
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
    console.log(JSON.stringify(report, evaluationConsoleReplacer, 2))
    if (!report.completed) process.exitCode = 1
  } catch {
    console.error('Agent evaluation failed to start or complete; no credential or provider error body printed.')
    process.exitCode = 1
  }
}
