import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { checkpointHistory, resolveCheckpointConfig, installHistoryCheckpoint } from '../../src/history-checkpoint.js'
import { parseConfig } from '../../src/config.js'
import * as Plugin from '../../src/index.js'
const runtime = createRequire(resolve('.omx/integration-runtime/package.json'))
const load = name => import(pathToFileURL(runtime.resolve(`@deepseek-ai/${name}`)).href)
const { Context } = await load('cordis')
const { Session, buildForkSeed, default: SessionStore } = await load('dsh-session')
const { createMessage, createToolResultMessage, createUserMessage, LlmAdapter } = await load('dsh-llm')
const { default: Projections } = await load('dsh-session-projection')
const { default: TokenMeter } = await load('dsh-token-meter')
const { estimateMessage } = await load('dsh-token-meter/estimate')
const options = { enabled: true, retainRecentSteps: 2, minModelUses: 2, minEntries: 2, minStepsBetweenCheckpoints: 0, minSavingsTokens: 64 }
function fixture(t) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  new Projections(ctx)
  new SessionStore(ctx)
  const session = ctx.sessions.create('checkpoint-fixture')
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Original task constraints' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const stored = []
  const spillStore = { async saveText(input) { stored.push(input); return { bytes: Buffer.byteLength(input.content), locator: 'fixture:original', retrievalHint: 'Read fixture.' } } }
  function append(step) {
    const id = `call-${step}`
    session.append('step/start', { turn: 1, step })
    const message = createMessage({ role: 'assistant', content: [{ type: 'reasoning', text: 'private reasoning '.repeat(1000) }, { type: 'text', text: `observation ${step}` }, { type: 'tool-call', id, name: 'bash', arguments: JSON.stringify({ command: `sed -n '${step}p' src/file.py` }) }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } })
    session.append('assistant/message', { turn: 1, step, stream: [], message }, { surfaceOp: 'append' })
    const call = session.append('tool/call', { turn: 1, step, callId: id, name: 'bash', arguments: '{}' })
    session.append('tool/result', { turn: 1, step, message: createToolResultMessage({ callId: id, content: [{ type: 'text', text: `src/file.py:${step}: ERROR 中文\nFull formatted result stored at: spill:file-${step}` }], isError: step === 1 }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    session.append('step/end', { turn: 1, step })
  }
  for (let step = 1; step <= 8; step++) append(step)
  return { ctx, session, user, stored, spillStore, append, agent: { session } }
}
const run = f => checkpointHistory({ agent: f.agent }, options, { spillStore: f.spillStore })
test('native checkpoint preserves originals and complete evidence; projection restore/fork stays exact', async t => {
  const f = fixture(t), original = JSON.stringify(f.session.snapshotEvents()), revision = f.session.seq
  const result = await run(f)
  assert.equal(result.reason, 'checkpointed')
  assert.equal(JSON.stringify(f.session.snapshotEvents().slice(0, revision)), original)
  assert.ok(f.session.surface.nodes.includes(f.user.seq))
  const message = f.session.eventAt(result.replacementSeq).data
  const snapshot = JSON.parse(f.stored[0].content)
  assert.equal(snapshot.messages.length, 12)
  assert.equal(f.stored[0].source.kind, 'session-reference')
  for (const original of snapshot.messages) for (const block of original.content) {
    if (block.type === 'reasoning') continue
    assert.ok(message.content[0].text.includes(block.arguments ?? block.text))
  }
  assert.ok(message.content[0].text.includes('"isError":true'))
  assert.ok(!message.content[0].text.includes('private reasoning private reasoning'))
  const summary = f.session.snapshotEvents().find(event => event.type === 'compaction/summary')
  assert.equal(summary.data.shadowedTokenCount, snapshot.messages.reduce((sum, message) => sum + estimateMessage(message), 0))
  const restored = Session.create('restored', JSON.parse(JSON.stringify(f.session.snapshotEvents())))
  const fork = Session.create('fork', buildForkSeed(restored.snapshotEvents(), restored.seq - 1))
  const meter = new TokenMeter(f.ctx)
  for (const session of [f.session, restored, fork]) {
    assert.deepEqual(session.deriveMessages(), f.session.deriveMessages())
    const expected = session.deriveMessages().reduce((sum, message) => sum + estimateMessage(message), 0)
    assert.equal(meter.measure(session).surfaceTokens, expected)
    const breakdown = f.ctx.sessionProjections.snapshot(session, ['contextBreakdown']).values.contextBreakdown
    assert.equal(breakdown.messageTokens + breakdown.systemTokens, expected)
  }
  for (let step = 9; step <= 13; step++) f.append(step)
  const second = await run(f)
  assert.equal(second.reason, 'checkpointed')
  assert.ok(f.session.surface.nodes.includes(result.replacementSeq))
  assert.ok(f.session.surface.nodes.includes(f.user.seq))
})
test('storage failure, abort, and history change leave original surface intact', async t => {
  for (const mode of ['failure', 'abort', 'mutation']) {
    const f = fixture(t), nodes = [...f.session.surface.nodes], controller = new AbortController()
    const store = { async saveText(input) {
      if (mode === 'failure') throw Error('disk')
      if (mode === 'abort') controller.abort()
      if (mode === 'mutation') f.session.append('step/start', { turn: 1, step: 9 })
      return { bytes: Buffer.byteLength(input.content), locator: 'fixture:original', retrievalHint: 'Read.' }
    } }
    const result = await checkpointHistory({ agent: f.agent, signal: controller.signal }, options, { spillStore: store })
    assert.equal(result.reason, { failure: 'snapshot-failed', abort: 'aborted', mutation: 'history-changed' }[mode])
    assert.deepEqual(f.session.surface.nodes, nodes)
    assert.equal(f.session.snapshotEvents().filter(e => e.type.startsWith('compaction/')).length, 0)
  }
})
test('pending or unsupported messages fail closed', async t => {
  for (const mode of ['media', 'pair', 'duplicate']) {
    const f = fixture(t), derive = f.session.deriveEventMessage.bind(f.session), revision = f.session.seq
    f.session.deriveEventMessage = event => {
      const message = structuredClone(derive(event))
      if (mode === 'media' && message.role === 'assistant') message.content.push({ type: 'image', url: 'fixture' })
      if (mode === 'pair' && message.role === 'tool') message.source.callId = 'other'
      if (mode === 'duplicate' && message.role === 'assistant') message.content.find(b => b.type === 'tool-call').id = 'duplicate'
      return message
    }
    assert.notEqual((await run(f)).reason, 'checkpointed')
    assert.equal(f.session.seq, revision)
    assert.equal(f.stored.length, 0)
  }
})
test('partial summary commit halts now and on retry', async t => {
  const f = fixture(t), append = f.session.append.bind(f.session)
  f.session.append = (type, ...args) => { if (type === 'user/message') throw Error('commit failure'); return append(type, ...args) }
  await assert.rejects(run(f), { code: 'CHECKPOINT_INCOMPLETE_PROTOCOL' })
  await assert.rejects(run(f), { code: 'CHECKPOINT_INCOMPLETE_PROTOCOL' })
  assert.equal(f.session.snapshotEvents().at(-1).type, 'compaction/end')
})
test('configuration preserves absent default shape and rejects conflicts', () => {
  assert.equal(Object.hasOwn(parseConfig(), 'checkpoint'), false)
  assert.throws(() => parseConfig({ checkpoint: options, retirement: { enabled: true } }))
  assert.throws(() => resolveCheckpointConfig({ retainRecentSteps: 0 }))
  assert.throws(() => resolveCheckpointConfig({ unknown: true }))
})
test('normal AgentLoop entry adopts checkpoint without extra model calls and observes exact request hashes', async t => {
  const { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } = await load('dsh-agent-loop-testkit')
  const { defineContentToolFixture } = await load('dsh-tools')
  const { default: SpillLocal } = await load('dsh-spill-local')
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-loop-')), ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, systemPrompt: { personaPrefix: '' } })
  await ctx.plugin(SpillLocal, { root: directory, cleanupPeriodDays: 0 })
  ctx.tools.register(defineContentToolFixture({ name: 'fixture', description: 'fixture', parameters: {}, execute: async () => [{ type: 'text', text: 'src/file.py:42: exact evidence 中文' }] }))
  const records = [], decisions = [], requests = []
  ctx.on('free-context/decision', record => { records.push(record) })
  ctx.on('free-context/checkpoint', record => { decisions.push(record) })
  await ctx.plugin(Plugin, { mode: 'apply', tools: [], checkpoint: options })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      requests.push(structuredClone(request))
      const step = requests.length
      const blocks = step <= 12 ? [{ type: 'reasoning', text: 'reasoning '.repeat(1800) }, { type: 'tool-call', id: `real-${step}`, name: 'fixture', arguments: '{}' }] : [{ type: 'text', text: 'done' }]
      for (const [index, block] of blocks.entries()) {
        yield { type: 'block-start', index, blockType: block.type }
        yield { type: 'block-end', index, block }
      }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: step <= 12 ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['checkpoint-replay'], new Adapter())
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create('checkpoint-loop', { provider: 'checkpoint-replay', model: 'fixture' }, { cwd: directory })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Call fixture 12 times.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  assert.equal(requests.length, 13)
  const adopted = decisions.filter(d => d.reason === 'checkpointed')
  assert.ok(adopted.length >= 2, JSON.stringify(decisions))
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const observed = records.filter(r => r.reason === 'checkpoint-model-visible')
  assert.ok(observed.length > 0)
  for (const record of observed) {
    const request = requests.find(r => hash(r) === record.requestHash)
    assert.ok(request)
    const message = request.messages.find(m => m.id === record.checkpointId)
    assert.equal(hash(message.content), record.contentHash)
  }
  const cliRuntime = createRequire(resolve('.omx/cli-runtime/package.json'))
  const { sessionFormatCatalog } = await import(pathToFileURL(cliRuntime.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
  const header = { ...agent.session.header, delegationDepth: 0 }
  const encodedHeader = sessionFormatCatalog.encodeCurrentHeader(header, 0)
  const restore = sessionFormatCatalog.createRestore(encodedHeader, { recovery: 'strict', validation: 'current' })
  for (const event of agent.session.snapshotEvents()) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
  const artifact = restore.finish()
  assert.deepEqual(artifact.events, agent.session.snapshotEvents())
  for (const record of adopted) {
    const content = await readFile(record.snapshot.locator, 'utf8')
    assert.equal(createHash('sha256').update(content).digest('hex'), record.snapshot.sha256)
    assert.ok(JSON.parse(content).messages.some(m => m.content.some(b => b.type === 'reasoning')))
  }
})
test('append observer exceptions never permit partial summary to proceed', async t => {
  for (const failType of ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end']) {
    const f = fixture(t), append = f.session.append.bind(f.session)
    let failed = false
    f.session.append = (type, ...args) => {
      const result = append(type, ...args)
      if (type === failType && !failed) { failed = true; throw Error('observer failure after commit') }
      return result
    }
    if (failType === 'compaction/start') {
      assert.equal((await run(f)).reason, 'checkpoint-failed')
      assert.equal((await run(f)).reason, 'checkpointed')
    } else {
      await assert.rejects(run(f), { code: 'CHECKPOINT_INCOMPLETE_PROTOCOL' })
      if (failType === 'compaction/summary') await assert.rejects(run(f), { code: 'CHECKPOINT_INCOMPLETE_PROTOCOL' })
    }
    assert.equal(f.session.snapshotEvents().at(-1).type, 'compaction/end')
  }
})
test('observe mode saves original snapshot and leaves all session events untouched', async t => {
  const f = fixture(t), original = JSON.stringify(f.session.snapshotEvents())
  const result = await checkpointHistory({ agent: f.agent }, options, { spillStore: f.spillStore, mode: 'observe' })
  assert.equal(result.reason, 'observed')
  assert.equal(JSON.stringify(f.session.snapshotEvents()), original)
})

test('read-only visibility diagnostics cannot alter frozen requests or interrupt dispatch', async t => {
  const f = fixture(t), handlers = new Map(), removed = []
  const dispose = installHistoryCheckpoint({
    on(name, handler) { handlers.set(name, handler); return () => removed.push(name) },
    get() { return f.spillStore },
    parallel() { throw Error('diagnostic unavailable') },
  }, options)
  await handlers.get('agent/pre-step')({ agent: f.agent }, () => {})
  const request = structuredClone({ messages: f.session.deriveMessages() })
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
    return value
  }
  freeze(request)
  const original = JSON.stringify(request), revision = f.session.seq
  let called = false
  handlers.get('llm/stream')(request, () => { called = true })
  assert.equal(called, true)
  assert.equal(JSON.stringify(request), original)
  assert.equal(f.session.seq, revision)
  dispose()
  assert.deepEqual(removed.sort(), ['agent/pre-step', 'llm/stream'])
})

test('missing checkpoint end blocks same-session installer reentry while foreign compaction stays busy', async t => {
  const f = fixture(t), append = f.session.append.bind(f.session)
  f.session.append = (type, ...args) => {
    if (type === 'compaction/end') throw Error('end persistence failed')
    return append(type, ...args)
  }
  await assert.rejects(run(f), { code: 'CHECKPOINT_INCOMPLETE_PROTOCOL' })
  assert.equal(f.session.snapshotEvents().at(-1).type, 'user/message')
  f.session.append = append
  const handlers = new Map()
  installHistoryCheckpoint({
    on(name, handler) { handlers.set(name, handler); return () => {} },
    get() { return f.spillStore },
  }, options)
  let continued = false
  await assert.rejects(handlers.get('agent/pre-step')({ agent: f.agent }, () => { continued = true }),
    { code: 'CHECKPOINT_INCOMPLETE_PROTOCOL' })
  assert.equal(continued, false)
  const foreign = fixture(t)
  foreign.session.append('compaction/start', { compactionId: 'foreign-active', turn: 1 })
  assert.equal((await run(foreign)).reason, 'inactive-or-busy')
})
