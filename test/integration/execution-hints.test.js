import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { installExecutionHints, executionHintSource, executionHintText } from '../../src/execution-hints.js'
import { parseConfig } from '../../src/config.js'
import * as Plugin from '../../src/index.js'
const runtime = createRequire(resolve('.omx/integration-runtime/package.json'))
const load = name => import(pathToFileURL(runtime.resolve(`@deepseek-ai/${name}`)).href)
const { Context } = await load('cordis')
const { Session, buildForkSeed } = await load('dsh-session')
const { createUserMessage, LlmAdapter } = await load('dsh-llm')
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fixture() {
  const session = Session.create('hint-fixture')
  session.append('turn/start', { turn: 1 })
  const message = createUserMessage({ content: [{ type: 'text', text: 'Fix requested issue' }], source: { kind: 'user' } })
  return { session, event: { agent: { session }, turn: 1, step: 1, messages: [message], signal: new AbortController().signal } }
}
function installer(options = { enabled: true }, mode = 'apply') {
  let handler, removed = false
  const dispose = installExecutionHints({ on(name, callback) { if (name === 'agent/pre-step') handler = callback; return () => { removed = true } } }, options, { mode })
  return { run: (...args) => handler(...args), dispose, get installed() { return Boolean(handler) }, get removed() { return removed } }
}
test('config opt-in preserves default shape and validates exact option', () => {
  assert.equal(Object.hasOwn(parseConfig(), 'executionHints'), false)
  assert.deepEqual(parseConfig({ executionHints: {} }).executionHints, { enabled: false })
  assert.throws(() => parseConfig({ executionHints: { enabled: 'yes' } }))
  assert.throws(() => parseConfig({ executionHints: { extra: 1 } }))
})
test('awaits downstream admission, preserves original messages, and avoids duplicate installations', async () => {
  const f = fixture(), a = installer(), b = installer()
  const original = Object.freeze({ kind: 'enter', messages: Object.freeze([...f.event.messages]), startsRequestSeries: true })
  const before = JSON.stringify(f.session.snapshotEvents())
  const decision = await a.run(f.event, () => b.run(f.event, async () => original))
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0], original.messages[0])
  assert.equal(decision.startsRequestSeries, true)
  assert.equal(decision.messages[1].source.kind, executionHintSource)
  assert.equal(decision.messages[1].content[0].text, executionHintText)
  assert.match(decision.messages[1].id, /^[0-9a-f-]{36}$/)
  assert.equal(JSON.stringify(f.session.snapshotEvents()), before)
  a.dispose(); b.dispose()
  assert.equal(a.removed, true)
})
test('disabled, observe and off modes install no interceptor', () => {
  for (const [enabled, mode] of [[false, 'apply'], [true, 'observe'], [true, 'off']]) assert.equal(installer({ enabled }, mode).installed, false)
})
test('reject, abort, cleared inbox, empty initial inbox and downstream throw are respected', async () => {
  for (const kind of ['reject', 'abort', 'cleared', 'context-only', 'empty-initial', 'throw']) {
    const f = fixture(), i = installer()
    let decision = { kind: 'enter', messages: [...f.event.messages] }
    if (kind === 'reject') decision = { kind: 'reject' }
    if (kind === 'cleared') decision.messages = []
    if (kind === 'context-only') decision.messages = [createUserMessage({ content: [{ type: 'text', text: 'runtime context' }], source: { kind: 'runtime-context' } })]
    if (kind === 'empty-initial') f.event.messages = []
    const controller = new AbortController(); f.event.signal = controller.signal
    const next = async () => {
      if (kind === 'abort') controller.abort()
      if (kind === 'throw') throw Error('downstream failure')
      return decision
    }
    if (kind === 'throw') await assert.rejects(i.run(f.event, next), /downstream failure/)
    else assert.equal(await i.run(f.event, next), decision)
  }
})
test('persistent marker and admitted-step history prevent restored/forked turn duplication', async () => {
  const f = fixture(), i = installer(), decision = await i.run(f.event, async () => ({ kind: 'enter', messages: f.event.messages }))
  for (const message of decision.messages) f.session.append('user/message', message, { surfaceOp: 'append' })
  const restored = Session.create('restored', JSON.parse(JSON.stringify(f.session.snapshotEvents())))
  const fork = Session.create('fork', buildForkSeed(f.session.snapshotEvents(), f.session.seq - 1))
  for (const session of [f.session, restored, fork]) {
    const original = { kind: 'enter', messages: f.event.messages }
    assert.equal(await installer().run({ ...f.event, agent: { session } }, async () => original), original)
  }
  const prior = fixture(); prior.session.append('step/start', { turn: 1, step: 1 })
  const original = { kind: 'enter', messages: prior.event.messages }
  assert.equal(await installer().run({ ...prior.event, step: 2 }, async () => original), original)
})
test('native AgentLoop logs one notice per turn and sends exact logged notice to adapter; catalog accepts source', async t => {
  const { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } = await load('dsh-agent-loop-testkit')
  const { defineContentToolFixture } = await load('dsh-tools')
  const directory = await mkdtemp(join(tmpdir(), 'execution-hint-')), ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, systemPrompt: { personaPrefix: '' } })
  ctx.tools.register(defineContentToolFixture({ name: 'fixture', description: 'fixture tool', parameters: {}, execute: async () => [{ type: 'text', text: 'validation passed' }] }))
  const plugin = await ctx.plugin(Plugin, { mode: 'apply', tools: [], executionHints: { enabled: true } })
  const requests = [], observed = [], diagnostics = []
  ctx.on('free-context/decision', record => { diagnostics.push(record) })
  ctx.on('llm/stream', (request, next) => { observed.push(hash(request)); return next() })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      requests.push(structuredClone(request))
      const count = requests.length, useTool = count % 2 === 1
      const block = useTool ? { type: 'tool-call', id: `call-${count}`, name: 'fixture', arguments: '{}' } : { type: 'text', text: 'done' }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: useTool ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['hint-replay'], new Adapter())
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create('hint-loop', { provider: 'hint-replay', model: 'fixture' }, { cwd: directory })
  for (const text of ['First task', 'Second task']) {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  assert.equal(requests.length, 4)
  const notices = agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.kind === executionHintSource)
  assert.equal(notices.length, 2)
  assert.deepEqual(notices.map(e => e.data.source.turn), [1, 2])
  assert.deepEqual(requests.map(hash), observed)
  const visible = diagnostics.filter(record => record.reason === 'execution-hint-model-visible')
  assert.ok(visible.length >= 4)
  for (const record of visible) {
    const request = requests.find(request => hash(request) === record.requestHash)
    assert.ok(request)
    assert.equal(hash(request.messages.find(message => message.id === record.hintId).content), record.contentHash)
  }
  for (const event of notices) {
    assert.equal(event.surfaceOp, 'append')
    assert.ok(requests.some(request => request.messages.some(message => hash(message) === hash(event.data))))
  }
  const cli = createRequire(resolve('.omx/cli-runtime/package.json'))
  const { sessionFormatCatalog } = await import(pathToFileURL(cli.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
  const restore = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader({ ...agent.session.header, delegationDepth: 0 }, 0), { recovery: 'strict', validation: 'current' })
  for (const event of agent.session.snapshotEvents()) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
  assert.deepEqual(restore.finish().events, agent.session.snapshotEvents())
  await plugin.dispose()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Third task after unload' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  assert.equal(requests.length, 6)
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.kind === executionHintSource).length, 2)
})

test('visibility observer preserves frozen request and tolerates diagnostic failure; disposal cancels pending admission', async () => {
  const f = fixture(), handlers = new Map(), removed = []
  const dispose = installExecutionHints({
    on(name, handler) { handlers.set(name, handler); return () => removed.push(name) },
    parallel() { throw Error('diagnostics failure') },
  }, { enabled: true }, { mode: 'apply' })
  const decision = await handlers.get('agent/pre-step')(f.event, async () => ({ kind: 'enter', messages: f.event.messages }))
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
    return value
  }
  const request = freeze({ messages: decision.messages }), before = JSON.stringify(request), revision = f.session.seq
  let delegated = false
  handlers.get('llm/stream')(request, () => { delegated = true })
  assert.equal(delegated, true)
  assert.equal(JSON.stringify(request), before)
  assert.equal(f.session.seq, revision)
  let release
  const original = { kind: 'enter', messages: f.event.messages }
  const pending = handlers.get('agent/pre-step')(f.event, () => new Promise(resolve => { release = resolve }))
  dispose()
  release(original)
  assert.equal(await pending, original)
  assert.deepEqual(removed.sort(), ['agent/pre-step', 'llm/stream'])
})
