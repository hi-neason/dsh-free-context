import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { retireHistory, installRetirement } from '../../src/retirement.js'
import { createRetirementTextMeter, estimateRetirementMessage } from '../../src/retirement-meter.js'
import { encodeLosslessText } from '../../src/lossless-text.js'
import * as Plugin from '../../src/index.js'
import { readSpill, runSweCanaryTask } from '../../scripts/benchmark/swe-canary-agent.js'

const runtime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
const load = name => import(pathToFileURL(runtime.resolve(`@deepseek-ai/${name}`)).href)
const { Context } = await load('cordis')
const { Session, buildForkSeed, default: SessionStore } = await load('dsh-session')
const { createMessage, createToolResultMessage } = await load('dsh-llm')
const { default: Projections } = await load('dsh-session-projection')
const { default: TokenMeter } = await load('dsh-token-meter')
const { estimateMessage } = await load('dsh-token-meter/estimate')

const config = { enabled: true, objective: 'tokens', tokenEstimator: 'dsh-rc2-text-v1',
  tools: ['bash'], minInputBytes: 100, retainRecentResults: 1, minAgeSteps: 1,
  minModelUses: 1, excerptCharacters: 80, maxEntriesPerStep: 1 }

function appendResult(session, turn, callId, text = 'source text 🙂中\n'.repeat(600)) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', { turn, step: 1, stream: [], message: createMessage({
    role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
    source: { kind: 'model', provider: 'fixture', model: 'fixture' },
  }) }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' })
  const event = session.append('tool/result', { turn, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: false }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return event
}

function fixture(t, text) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  new Projections(ctx)
  new SessionStore(ctx)
  const session = ctx.sessions.create('token-retirement')
  const original = appendResult(session, 1, 'old', text)
  const recent = appendResult(session, 2, 'recent')
  const stored = []
  const spillStore = { async saveText(input) {
    stored.push(input)
    return { locator: `fixture:${stored.length}`, bytes: Buffer.byteLength(input.content), retrievalHint: 'Read fixture snapshot.' }
  } }
  return { ctx, session, agent: { session }, original, recent, stored, spillStore }
}

test('explicit fallback retires through pre-step and native shadow prices survive restore and fork', async t => {
  const f = fixture(t)
  assert.equal(f.ctx.get('tokenMeter'), undefined)
  let handler
  installRetirement({ on(_name, fn) { handler = fn; return () => {} },
    get(name) { return name === 'spillStore' ? f.spillStore : undefined } }, config)
  let delegated = false
  await handler({ agent: f.agent }, async () => { delegated = true })
  assert.equal(delegated, true)
  assert.equal(f.stored.length, 1)
  assert.equal(f.stored[0].content, f.original.data.message.content[0].text)
  const events = f.session.snapshotEvents(), shadow = events.at(-2), replacement = events.at(-1)
  assert.equal(shadow.type, 'compaction/prune')
  assert.equal(shadow.data.shadowedTokenCount, estimateMessage(f.session.deriveEventMessage(f.original)))
  assert.equal(estimateRetirementMessage(f.original.data.message), shadow.data.shadowedTokenCount)
  assert.deepEqual(replacement.sourceEventSeqs, [f.original.seq])
  assert.equal(replacement.data.message.source.callId, 'old')
  const policy = JSON.parse(replacement.data.message.content[0].text.split('\n')[1].slice('Retirement decision: '.length))
  assert.equal(policy.objective, 'tokens')
  assert.equal(policy.costGateEnforced, false)
  assert.equal(policy.estimateKind, 'dsh-rc2-text-v1')
  assert.ok(f.session.surface.nodes.includes(f.recent.seq))
  const restored = Session.create('restored-token', JSON.parse(JSON.stringify(events)))
  const fork = Session.create('fork-token', buildForkSeed(restored.snapshotEvents(), restored.seq - 1))
  const native = new TokenMeter(f.ctx)
  for (const session of [f.session, restored, fork]) {
    assert.deepEqual(session.deriveMessages(), f.session.deriveMessages())
    const expected = session.surface.nodes.reduce((sum, seq) => {
      const message = session.deriveEventMessage(session.eventAt(seq))
      return sum + (message === null ? 0 : estimateMessage(message))
    }, 0)
    assert.equal(native.measure(session).surfaceTokens, expected)
    assert.equal(createRetirementTextMeter().measure(session).surfaceTokens, expected)
    const breakdown = f.ctx.sessionProjections.snapshot(session, ['contextBreakdown']).values.contextBreakdown
    assert.equal(breakdown.messageTokens + breakdown.systemTokens, expected)
  }
})

test('token fallback keeps cost unavailable and honors missing explicit opt-in', async t => {
  const f = fixture(t)
  for (const options of [{ ...config, objective: undefined, tokenEstimator: undefined },
    { ...config, tokenEstimator: undefined }]) {
    assert.equal((await retireHistory({ agent: f.agent }, options, { spillStore: f.spillStore }))[0].reason, 'missing-token-meter')
  }
  const records = await retireHistory({ agent: f.agent }, { ...config, minimumFutureRequests: 0 }, { spillStore: f.spillStore })
  assert.equal(records[0].reason, 'retired')
  assert.deepEqual(records[0].economics, { adopt: false, reason: 'unavailable-host-cost-measurement' })
  assert.equal(records[0].costGateEnforced, false)
})

test('host cost objective still rejects a negative forecast while explicit token objective records it', async t => {
  const f = fixture(t), meter = new TokenMeter(f.ctx)
  const prices = { minimumFutureRequests: 1, expectedRecoveryCost: 100, safetyMargin: 0,
    pricing: { uncachedInputPerMillion: 9, cacheReadPerMillion: 0.3 } }
  const cost = { ...config, objective: 'cost', tokenEstimator: undefined, ...prices }
  assert.equal((await retireHistory({ agent: f.agent }, cost, { tokenMeter: meter, spillStore: f.spillStore }))[0].reason, 'economic-gate')
  const records = await retireHistory({ agent: f.agent }, { ...config, ...prices }, { tokenMeter: meter, spillStore: f.spillStore })
  assert.equal(records[0].reason, 'retired')
  assert.equal(records[0].economics.adopt, false)
  assert.equal(records[0].economics.reason, 'insufficient-net-benefit')
})

test('plain command failures and encoded frames remain available', async t => {
  const body = 'ordinary source text\n'.repeat(600)
  const encoded = encodeLosslessText(body + 'Exit code: 1\n')
  assert.equal(typeof encoded, 'string')
  for (const text of [body + '\nExit code: 1', body + '\nExit code: -9', body + '\nSTDERR:\nnotice',
    body + '\nModuleNotFoundError: unavailable', body + '\nTraceback (most recent call last):',
    encoded, encoded.slice(0, 400), '[dsh-search-results:v1]\n' + body]) {
    const f = fixture(t, text), revision = f.session.seq
    const records = await retireHistory({ agent: f.agent }, config, { spillStore: f.spillStore })
    assert.equal(records[0]?.reason, 'protected-status-evidence')
    assert.equal(f.session.seq, revision)
    assert.equal(f.stored.length, 0)
  }
})

test('snapshot failure and unsupported current surface leave history intact', async t => {
  const f = fixture(t), revision = f.session.seq
  const failure = { saveText() { throw Error('storage failure') } }
  assert.equal((await retireHistory({ agent: f.agent }, config, { spillStore: failure }))[0].reason, 'retirement-failed')
  assert.equal(f.session.seq, revision)
  const derive = f.session.deriveEventMessage.bind(f.session)
  f.session.deriveEventMessage = event => event.seq === f.recent.seq
    ? { ...derive(event), content: [{ type: 'image', url: 'fixture' }] } : derive(event)
  assert.equal((await retireHistory({ agent: f.agent }, config, { spillStore: f.spillStore }))[0].reason, 'unsupported-token-estimate')
  assert.equal(f.session.seq, revision)
  assert.equal(f.stored.length, 0)
})

async function successfulRuntime(t) {
  const { mountAgentLoopTestDependencies } = await load('dsh-agent-loop-testkit')
  const { defineTool } = await load('dsh-tools')
  const { default: SpillLocal } = await load('dsh-spill-local')
  const SpillPolicy = await load('dsh-spill-policy')
  const directory = await mkdtemp(join(tmpdir(), 'retirement-success-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, systemPrompt: { personaPrefix: '' } })
  await ctx.plugin(SpillLocal, { root: directory, cleanupPeriodDays: 0 })
  const values = new Map(), saved = []
  const saveText = ctx.spillStore.saveText.bind(ctx.spillStore)
  ctx.spillStore.saveText = async input => {
    const receipt = await saveText(input)
    saved.push({ input, receipt })
    return receipt
  }
  ctx.tools.register(defineTool({ name: 'bash', description: 'fixture bash',
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text',
      text: value.stdout + (value.stderr ? '\nSTDERR:\n' + value.stderr : '') + (value.exitCode ? '\nExit code: ' + value.exitCode : '') }] },
    execute: args => values.get(args.command),
  }))
  const plugin = await ctx.plugin(Plugin, { mode: 'apply', tools: [], retirement: { ...config, allowVerifiedSuccess: true } })
  await ctx.plugin(SpillPolicy, { maxInlineTokens: 1200 })
  ctx.on('tools/post-execute', async (_exec, _result, next) => next(), { prepend: true })
  const session = ctx.sessions.create('verified-native-preview'), agent = { session }
  async function execute(turn, callId, value) {
    const args = { command: `fixture-${turn}` }, argumentText = JSON.stringify(args)
    values.set(args.command, value)
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', { turn, step: 1, stream: [], message: createMessage({
      role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: argumentText }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }) }, { surfaceOp: 'append' })
    const call = session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: argumentText })
    const result = await ctx.tools.execute({ callId, name: 'bash', arguments: args, agent, signal: new AbortController().signal })
    const event = session.append('tool/result', { turn, step: 1,
      message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    return { call, event, result }
  }
  const step = () => ctx.waterfall('agent/pre-step', { agent, signal: new AbortController().signal }, async () => ({ kind: 'continue' }))
  return { ctx, directory, session, agent, saved, execute, step, plugin }
}

test('real plugin followed by native spill retires verified source and preserves both snapshot links', async t => {
  const f = await successfulRuntime(t)
  const original = 'if error:\n    raise ValueError(message)\n# warning or failure handling\n'.repeat(350)
  const old = await f.execute(1, 'old-source', { stdout: original, stderr: '', exitCode: 0 })
  const preview = old.result.content[0].text
  assert.notEqual(preview, original)
  assert.match(preview, /Full formatted result stored at:/)
  assert.equal(f.saved.length, 1)
  const fullReceipt = f.saved[0].receipt
  await f.execute(2, 'recent', { stdout: 'recent result\n'.repeat(100), stderr: '', exitCode: 0 })
  await f.step()
  const replacement = f.session.snapshotEvents().at(-1)
  assert.equal(replacement.surfaceOp.op, 'replace')
  assert.deepEqual(replacement.sourceEventSeqs, [old.event.seq])
  const policy = JSON.parse(replacement.data.message.content[0].text.split('\n')[1].slice('Retirement decision: '.length))
  assert.equal(policy.verifiedSuccessUsed, true)
  assert.equal(policy.snapshotScope, 'model-visible-result')
  assert.equal(policy.verifiedSuccess.callSeq, old.call.seq)
  const previewReceipt = f.saved.at(-1).receipt
  assert.equal(await readFile(previewReceipt.locator, 'utf8'), preview)
  assert.ok(preview.includes(fullReceipt.locator))
  assert.equal((await readSpill(f.directory, previewReceipt.locator, 1, 2000)).lines.join('\n'), preview)
  assert.equal((await readSpill(f.directory, fullReceipt.locator, 1, 2000)).lines.join('\n'), original)
})

test('real source credentials do not survive outer changes, duplicate ids, restore, fork or disposal', async t => {
  for (const scenario of ['outer-change', 'duplicate', 'restore', 'fork', 'dispose']) {
    const f = await successfulRuntime(t)
    const body = 'if error: handle_exception()\n'.repeat(120)
    if (scenario === 'outer-change') {
      await f.execute(1, 'warmup', { stdout: 'warmup', stderr: '', exitCode: 0 })
      f.ctx.on('tools/post-execute', async (_exec, _result, next) => ({ ...await next(),
        content: [{ type: 'text', text: body + '# outer change\n' }] }), { prepend: true })
    }
    const old = await f.execute(2, 'old-source', { stdout: body, stderr: '', exitCode: 0 })
    await f.execute(3, scenario === 'duplicate' ? 'old-source' : 'recent', { stdout: 'recent\n'.repeat(50), stderr: '', exitCode: 0 })
    if (scenario === 'restore') f.agent.session = Session.create('restored-success', JSON.parse(JSON.stringify(f.session.snapshotEvents())))
    if (scenario === 'fork') f.agent.session = Session.create('fork-success', buildForkSeed(f.session.snapshotEvents(), f.session.seq - 1))
    if (scenario === 'dispose') await f.plugin.dispose()
    const active = f.agent.session, revision = active.seq
    await f.step()
    assert.equal(active.seq, revision, scenario)
    assert.ok(active.surface.nodes.includes(old.event.seq), scenario)
  }
})

test('real native spill cannot hide masked failures from verified-success eligibility', async t => {
  for (const value of [
    { stdout: 'if error: handle_exception()\n'.repeat(300), stderr: '', exitCode: 1 },
    { stdout: 'if error: handle_exception()\n'.repeat(300), stderr: 'diagnostic', exitCode: 0 },
    { stdout: 'if error: handle_exception()\n'.repeat(300) + '2 failed\n' + 'tail\n'.repeat(300), stderr: '', exitCode: 0 },
  ]) {
    const f = await successfulRuntime(t)
    const old = await f.execute(1, 'old-source', value)
    await f.execute(2, 'recent', { stdout: 'recent\n'.repeat(50), stderr: '', exitCode: 0 })
    const revision = f.session.seq
    await f.step()
    assert.equal(f.session.seq, revision)
    assert.ok(f.session.surface.nodes.includes(old.event.seq))
  }
})

test('success proof revalidation that appends history cannot publish a stale shadow claim', async t => {
  const f = fixture(t, 'if error: handle_exception()\n'.repeat(400))
  const proof = Object.freeze({ callSeq: 2 }), revision = f.session.seq
  let queries = 0
  const successTracking = { query() {
    if (++queries === 2) f.session.append('step/start', { turn: 3, step: 1 })
    return proof
  } }
  const records = await retireHistory({ agent: f.agent }, { ...config, allowVerifiedSuccess: true },
    { spillStore: f.spillStore, successTracking })
  assert.equal(queries, 2)
  assert.equal(records[0].reason, 'history-changed')
  assert.equal(f.session.seq, revision + 1)
  assert.equal(f.session.snapshotEvents().filter(event => event.type === 'compaction/prune').length, 0)
  assert.ok(f.session.surface.nodes.includes(f.original.seq))
})

test('official AgentLoop uses native call provenance and sees the verified replacement next step', async t => {
  const root = await mkdtemp(join(tmpdir(), 'retirement-agentloop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const observed = []
  const result = await runSweCanaryTask({ directory: join(root, 'run'), containerName: 'fixture',
    instanceId: 'retirement-synthetic', baseCommit: '38c31c99f6be6c2ffcc9e4132387edb7af8c5d06',
    problemStatement: 'Inspect the fixture.', group: 'plugin', costGuard: 'actual-usage', maxCostUSD: 0.03,
    pricing: { currency: 'USD', uncached: 0.3, cacheRead: 0.006, output: 1.2, sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/' },
    pluginConfiguration: { mode: 'apply', tools: ['bash'], json: { enabled: false }, retirement: { ...config, allowVerifiedSuccess: true } },
    commandExecutor: async (_container, command) => ({ exitCode: 0, stderr: '', stdout: command.includes('--binary') ? 'patch'
      : command === 'source' ? 'if error:\n    raise ValueError(message)\n'.repeat(400) : 'recent result\n'.repeat(30) }),
    adapterFactory: ({ LlmAdapter }) => new class extends LlmAdapter {
      calls = 0
      async resolveModel(provider, model) { return { provider, id: model, name: model } }
      async *stream(request) {
        observed.push(request.messages)
        const count = ++this.calls
        const block = count < 3 ? { type: 'tool-call', id: count === 1 ? 'old-source' : 'recent', name: 'bash',
          arguments: JSON.stringify({ command: count === 1 ? 'source' : 'recent' }) } : { type: 'text', text: 'Done.' }
        yield { type: 'block-start', index: 0, blockType: block.type }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 5 } }
        yield { type: 'finish', reason: { kind: count < 3 ? 'tool-calls' : 'stop' } }
      }
    }(),
  })
  assert.equal(result.failure, null)
  assert.equal(result.agentCompleted, true)
  const events = JSON.parse(await readFile(join(root, 'run/session-events.json'), 'utf8'))
  const call = events.find(event => event.type === 'tool/call' && event.data.callId === 'old-source')
  const original = events.find(event => event.type === 'tool/result' && event.surfaceOp === 'append' && event.data.message.toolCallId === 'old-source')
  assert.deepEqual(original.sourceEventSeqs, [call.seq])
  const replacement = events.find(event => event.type === 'tool/result' && event.surfaceOp?.op === 'replace')
  assert.deepEqual(replacement.sourceEventSeqs, [original.seq])
  assert.equal(replacement.data.message.toolCallId, 'old-source')
  assert.ok(observed[2].some(message => message.role === 'tool' && message.toolCallId === 'old-source' &&
    message.content[0].text.startsWith('[dsh-free-context retired v1]')))
})
