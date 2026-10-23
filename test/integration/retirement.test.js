import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { retireHistory, installRetirement } from '../../src/retirement.js'
import { createReadTracker } from '../../src/read-lifecycle.js'
import * as Plugin from '../../src/index.js'

const requireRuntime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { Session, buildForkSeed, default: SessionStore } = await load('@deepseek-ai/dsh-session')
const { createMessage, createToolResultMessage } = await load('@deepseek-ai/dsh-llm')
const { default: Projections } = await load('@deepseek-ai/dsh-session-projection')
const { default: TokenMeter } = await load('@deepseek-ai/dsh-token-meter')
const config = { enabled: true, tools: ['fixture'], minInputBytes: 100, retainRecentResults: 1,
  minAgeSteps: 1, maxEntriesPerStep: 2, minimumFutureRequests: 100,
  pricing: { uncachedInputPerMillion: 1, cacheReadPerMillion: 1 }, expectedRecoveryCost: 0, safetyMargin: 0.1 }

function appendResult(session, turn, callId, { error = false, name = 'fixture', text = 'original '.repeat(2000) } = {}) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', { turn, step: 1, stream: [], message: createMessage({
    role: 'assistant', content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }],
    source: { kind: 'model', provider: 'fixture', model: 'fixture' },
  }) }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name, arguments: '{}' })
  const event = session.append('tool/result', { turn, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: error }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return event
}

function fixture(t) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  new Projections(ctx)
  const tokenMeter = new TokenMeter(ctx)
  new SessionStore(ctx)
  const session = ctx.sessions.create('retirement-fixture')
  const original = appendResult(session, 1, 'old')
  const recent = appendResult(session, 2, 'recent')
  const stored = []
  const spillStore = { async saveText(input) {
    stored.push(input)
    return { locator: `opaque:${stored.length}`, bytes: Buffer.byteLength(input.content), retrievalHint: 'Use fixture storage.' }
  } }
  return { ctx, session, agent: { session }, tokenMeter, spillStore, original, recent, stored }
}

test('native events survive JSONL serialization, fresh Session restore and fork without plugin interpreter', async t => {
  const f = fixture(t)
  const originalJSON = JSON.stringify(f.original)
  const reports = await retireHistory({ agent: f.agent }, config, f)
  assert.equal(reports[0].reason, 'retired')
  assert.equal(JSON.stringify(f.session.eventAt(f.original.seq)), originalJSON)
  assert.equal(f.stored[0].content, f.original.data.message.content[0].text)
  const tail = f.session.snapshotEvents().slice(-2)
  assert.equal(tail[0].type, 'compaction/prune')
  assert.equal(tail[1].type, 'tool/result')
  assert.deepEqual(tail[1].sourceEventSeqs, [f.original.seq])
  assert.equal(tail[1].data.message.id, f.original.data.message.id)
  assert.deepEqual(tail[1].data.message.source, f.original.data.message.source)
  assert.ok(f.session.surface.nodes.includes(f.recent.seq))
  const jsonl = f.session.snapshotEvents().map(event => JSON.stringify(event)).join('\n')
  const restored = Session.create('restored', jsonl.split('\n').map(line => JSON.parse(line)))
  assert.deepEqual(restored.deriveMessages(), f.session.deriveMessages())
  const fork = Session.create('fork', buildForkSeed(restored.snapshotEvents(), restored.seq - 1))
  assert.deepEqual(fork.deriveMessages(), restored.deriveMessages())
  const revision = f.session.seq
  assert.deepEqual(await retireHistory({ agent: f.agent }, config, f), [])
  assert.equal(f.session.seq, revision)
  assert.doesNotThrow(() => f.tokenMeter.measure(restored))
  assert.equal(f.tokenMeter.measure(restored).totalTokens, f.tokenMeter.measure(f.session).totalTokens)
})

test('cancel, concurrent append, changed surface and storage failure preserve original history', async t => {
  for (const scenario of ['abort', 'append', 'replace', 'failure']) {
    const f = fixture(t)
    const controller = new AbortController()
    const revision = f.session.seq
    const baseSave = f.spillStore.saveText
    f.spillStore.saveText = async input => {
      if (scenario === 'abort') controller.abort()
      if (scenario === 'append') f.session.append('step/start', { turn: 3, step: 1 })
      if (scenario === 'replace') f.session.append('tool/result', f.original.data,
        { surfaceOp: { op: 'replace', startSeq: f.original.seq, endSeq: f.original.seq }, sourceEventSeqs: [f.original.seq] })
      if (scenario === 'failure') throw new Error('storage failure')
      return baseSave(input)
    }
    const reports = await retireHistory({ agent: f.agent, signal: controller.signal }, config, f)
    assert.notEqual(reports[0]?.reason, 'retired', scenario)
    assert.equal(f.session.seq, revision + (['append', 'replace'].includes(scenario) ? 1 : 0))
    assert.equal(f.session.snapshotEvents().filter(event => event.type === 'compaction/prune').length, 0)
  }
})

test('economic rejection, observe mode and read without known supersession never rewrite', async t => {
  for (const options of [{ expectedRecoveryCost: 1000 }, { mode: 'observe' }, { read: true }]) {
    const f = fixture(t)
    if (options.read) {
      f.session = Session.create('read-retirement')
      f.agent.session = f.session
      appendResult(f.session, 1, 'read-old', { name: 'read' })
      appendResult(f.session, 2, 'read-new', { name: 'read' })
    }
    const revision = f.session.seq
    await retireHistory({ agent: f.agent }, { ...config, tools: options.read ? ['read'] : ['fixture'],
      expectedRecoveryCost: options.expectedRecoveryCost ?? 0 }, { ...f, mode: options.mode })
    assert.equal(f.session.seq, revision)
  }
})

test('failed and recent results remain while a qualified older success is retired', async t => {
  const f = fixture(t)
  const error = appendResult(f.session, 3, 'error', { error: true })
  appendResult(f.session, 4, 'newest')
  await retireHistory({ agent: f.agent }, { ...config, maxEntriesPerStep: 1 }, f)
  assert.ok(f.session.surface.nodes.includes(error.seq))
  assert.equal(f.session.eventAt(error.seq).data.message.isError, true)
  assert.equal(f.session.snapshotEvents().filter(event => event.type === 'compaction/prune').length, 1)
})

test('second append failure is reported partial and no further replacement is attempted', async t => {
  const f = fixture(t)
  appendResult(f.session, 3, 'third')
  const originalAppend = f.session.append.bind(f.session)
  f.session.append = (type, data, options) => {
    if (type === 'tool/result') throw new Error('replacement rejected')
    return originalAppend(type, data, options)
  }
  await assert.rejects(retireHistory({ agent: f.agent }, config, f), error => {
    assert.equal(error.code, 'RETIREMENT_INCOMPLETE_PROTOCOL')
    assert.equal(error.reports[0].reason, 'partial-commit')
    return true
  })
  assert.equal(f.stored.length, 1)
  assert.ok(f.session.surface.nodes.includes(f.original.seq))
  await assert.rejects(retireHistory({ agent: f.agent }, config, f), error =>
    error.reports[0].reason === 'incomplete-shadow-protocol')
  await assert.rejects(retireHistory({ agent: f.agent }, { enabled: true }, {}), error =>
    error.code === 'RETIREMENT_INCOMPLETE_PROTOCOL')
})

test('partial shadow-price commit rejects pre-step and never delegates to a model request', async t => {
  const f = fixture(t)
  const append = f.session.append.bind(f.session)
  f.session.append = (type, data, options) => {
    if (type === 'tool/result') throw new Error('replacement rejected')
    return append(type, data, options)
  }
  let handler
  const ctx = { on(_name, fn) { handler = fn; return () => {} },
    get(name) { return name === 'tokenMeter' ? f.tokenMeter : f.spillStore }, logger: { warn() {} } }
  installRetirement(ctx, config)
  let delegated = false
  await assert.rejects(handler({ agent: f.agent }, async () => { delegated = true }),
    error => error.code === 'RETIREMENT_INCOMPLETE_PROTOCOL')
  assert.equal(delegated, false)
})

test('real session/event reentry and observer failures cannot split native adjacent appends', async t => {
  const f = fixture(t)
  let seen = 0
  f.ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/prune') return
    seen++
    assert.throws(() => session.append('step/start', { turn: 3, step: 1 }))
    throw new Error('observer failed after commit')
  })
  const reports = await retireHistory({ agent: f.agent }, config, f)
  assert.equal(seen, 1)
  assert.equal(reports[0].reason, 'retired')
  assert.deepEqual(f.session.snapshotEvents().slice(-2).map(event => event.type), ['compaction/prune', 'tool/result'])
})

test('post-commit append wrapper errors are classified by durable surface, not thrown status', async t => {
  const f = fixture(t)
  const append = f.session.append.bind(f.session)
  f.session.append = (type, data, options) => {
    const committed = append(type, data, options)
    if (type === 'tool/result') throw new Error('after commit')
    return committed
  }
  const reports = await retireHistory({ agent: f.agent }, config, f)
  assert.equal(reports[0].reason, 'retired')
})

test('read retirement requires retained same-version coverage and rechecks it after storage', async t => {
  for (const changeDuringSave of [false, true]) {
    const f = fixture(t)
    f.session = Session.create('covered-read')
    f.agent.session = f.session
    const old = appendResult(f.session, 1, 'old-read', { name: 'read' })
    appendResult(f.session, 2, 'new-read', { name: 'read' })
    const tracker = createReadTracker()
    const target = { targetKey: 'opaque:file' }
    for (const callId of ['old-read', 'new-read']) {
      const exec = { agent: f.agent, name: 'read', callId }
      tracker.observe(target, { kind: 'present', version: 'v1' }, exec)
      tracker.settle(exec, { value: { path: 'file', offset: 1, lines: [{ number: 1, text: 'same' }], totalLines: 1 } })
    }
    const save = f.spillStore.saveText
    f.spillStore.saveText = async input => {
      if (changeDuringSave) tracker.observe(target, { kind: 'present', version: 'v2' }, { agent: f.agent, name: 'edit' })
      return save(input)
    }
    const reports = await retireHistory({ agent: f.agent }, { ...config, tools: ['read'] }, { ...f, readTracking: tracker })
    assert.equal(reports[0].reason, changeDuringSave ? 'history-changed' : 'retired')
    assert.equal(f.session.surface.nodes.includes(old.seq), changeDuringSave)
  }
})

test('real Cordis plugin can run history-only pre-step and unload without a replay interpreter', async t => {
  const f = fixture(t)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.provide('tools', {})
  ctx.provide('tokenMeter', f.tokenMeter)
  ctx.provide('spillStore', f.spillStore)
  const records = []
  ctx.on('free-context/retirement', record => { records.push(record) })
  const plugin = await ctx.plugin(Plugin, { mode: 'apply', retirement: config })
  await ctx.waterfall('agent/pre-step', { agent: f.agent, signal: new AbortController().signal }, async () => ({ kind: 'continue' }))
  assert.equal(records[0]?.reason, 'retired')
  const messages = f.session.deriveMessages()
  await plugin.dispose()
  assert.deepEqual(Session.create('after-unload', f.session.snapshotEvents()).deriveMessages(), messages)
})

test('a native replacement of the covering read cannot justify retiring the older read', async t => {
  const f = fixture(t)
  f.session = Session.create('pruned-covering-read')
  f.agent.session = f.session
  const old = appendResult(f.session, 1, 'old-read', { name: 'read' })
  const newer = appendResult(f.session, 2, 'new-read', { name: 'read' })
  const tracker = createReadTracker()
  for (const callId of ['old-read', 'new-read']) {
    const exec = { agent: f.agent, name: 'read', callId }
    tracker.observe({ targetKey: 'opaque:file' }, { kind: 'present', version: 'v1' }, exec)
    tracker.settle(exec, { value: { path: 'file', offset: 1,
      lines: [{ number: 1, text: 'same' }], totalLines: 1 } })
  }
  // Reproduce the official pruner's native two-event protocol. The newer
  // message retains its identity/callId, but no longer contains the full read.
  f.session.append('compaction/prune', { shadowedRange: { start: newer.seq, end: newer.seq },
    shadowedSeqs: [newer.seq], shadowedTokenCount: f.tokenMeter.estimateMessage(newer.data.message) })
  f.session.append('tool/result', { ...newer.data,
    message: { ...newer.data.message, content: [{ type: 'text', text: 'head ... removed middle ... tail' }] },
  }, { surfaceOp: { op: 'replace', startSeq: newer.seq, endSeq: newer.seq }, sourceEventSeqs: [newer.seq] })
  assert.equal(tracker.query(f.session, 'old-read').status, 'superseded')
  const revision = f.session.seq
  const reports = await retireHistory({ agent: f.agent }, { ...config, tools: ['read'] }, { ...f, readTracking: tracker })
  assert.deepEqual(reports, [])
  assert.equal(f.session.seq, revision)
  assert.equal(f.stored.length, 0)
  assert.ok(f.session.surface.nodes.includes(old.seq))
})
