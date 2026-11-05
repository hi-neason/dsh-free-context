import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { budgetBlock } from '../../scripts/benchmark/swe-canary-agent.js'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { parseCompletionReview, installCompletionReview, completionReviewEligible, completionReviewSource, completionReviewText } from '../../src/completion-review.js'
import * as CandidatePlugin from '../../src/index.js'
import { parseConfig as candidateConfig } from '../../src/config.js'
const runtime = createRequire(resolve('.omx/integration-runtime/package.json'))
const load = name => import(pathToFileURL(runtime.resolve(`@deepseek-ai/${name}`)).href)
const { Context } = await load('cordis')
const { Session, buildForkSeed } = await load('dsh-session')
const { createUserMessage, LlmAdapter } = await load('dsh-llm')
const { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } = await load('dsh-agent-loop-testkit')
const { defineContentToolFixture } = await load('dsh-tools')
const notice = event => event.type === 'user/message' && event.data.source?.kind === completionReviewSource
const inserted = event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(m => m.source?.kind === completionReviewSource)
async function scenario(t, { finish = 'stop', config = { enabled: true }, copies = 1, guard = null, abort = false, throwSteer = false, usePlugin = false, streamGuard = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'completion-review-')), ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, systemPrompt: { personaPrefix: '' } })
  ctx.tools.register(defineContentToolFixture({ name: 'done', description: 'finish tool', parameters: {}, execute: async (_args, exec) => { if (finish !== 'tool-then-stop') exec.concludeTurn(); return [{ type: 'text', text: 'done' }] } }))
  if (abort) ctx.on('agent/turn-stopping', ({ agent }) => agent.cancel({ kind: 'hook', reason: 'fixture-abort' }))
  let stopPayload
  ctx.on('agent/turn-stopping', payload => { stopPayload = payload })
  if (usePlugin) await ctx.plugin(CandidatePlugin, { mode: 'apply', tools: [], completionReview: config })
  else for (let i = 0; i < copies; i++) installCompletionReview(ctx, config, { mode: 'apply' })
  let attempts = 0
  if (guard) ctx.on('agent/pre-step', async (_event, next) => { if (++attempts > 1) throw new Error(guard); return next() })
  const requests = [], observed = [], diagnostics = [], budgetRecords = [], budgetRejections = []
  ctx.on('free-context/decision', record => { diagnostics.push(record) })
  if (streamGuard) ctx.on('llm/stream', (request, next) => (async function* () {
    const blocked = budgetBlock(budgetRecords, 0, streamGuard === 'calls' ? 1 : 80, streamGuard === 'cost' ? .000001 : 1, { currency: 'USD', sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/', uncached: .3, cacheRead: .006, output: 1.2 }, 'actual-usage')
    if (blocked) { budgetRejections.push(blocked); throw Error(blocked) }
    const record = { usage: null, finish: null, streamCompleted: false }; budgetRecords.push(record)
    for await (const chunk of next()) {
      if (chunk.type === 'usage' && streamGuard !== 'unknown') record.usage = chunk.usage
      if (chunk.type === 'finish') record.finish = chunk.reason.kind
      yield chunk
    }
    record.streamCompleted = true
  })())
  ctx.on('llm/stream', (request, next) => { observed.push(JSON.stringify(request)); return next() })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      requests.push(structuredClone(request))
      if (finish === 'throw') throw Error('adapter failure')
      const tool = finish === 'tool-concludes' || (finish === 'tool-then-stop' && requests.length === 1), block = tool ? { type: 'tool-call', id: 'call-1', name: 'done', arguments: '{}' } : { type: 'text', text: 'Finished task' }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: finish === 'error' ? { kind: 'error', failure: { code: 'SERVER', message: 'fixture failure' } } : { kind: tool ? 'tool-calls' : finish === 'tool-then-stop' ? 'stop' : finish } }
    }
  }
  ctx.llm.registerAdapter(['completion-replay'], new Adapter())
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create('completion-loop', { provider: 'completion-replay', model: 'fixture' }, { cwd: directory })
  let steerAttempts = 0
  if (throwSteer) { const steer = agent.steer.bind(agent); agent.steer = message => { steerAttempts++; if (throwSteer === 'after') steer(message); throw Error('steer unavailable') } }
  const original = createUserMessage({ content: [{ type: 'text', text: 'Implement the requested operation and verify it.' }], source: { kind: 'user' } })
  agent.followup(original); await agent.whenIdle()
  return { ctx, agent, requests, observed, original, events: agent.session.snapshotEvents(), stopPayload, steerAttempts, diagnostics, budgetRecords, budgetRejections }
}

test('default disabled, exact options, no installation in observe/off', () => {
  assert.deepEqual(parseCompletionReview(), { enabled: false, maxStartStep: 48 })
  for (const value of [{ enabled: 'yes' }, { maxStartStep: 1 }, { maxStartStep: Infinity }, { extra: true }, null]) assert.throws(() => parseCompletionReview(value))
  for (const [input, mode] of [[{}, 'apply'], [{ enabled: true }, 'observe'], [{ enabled: true }, 'off']]) installCompletionReview({ on() { assert.fail('must not install') } }, input, { mode })()
})
test('native normal stop adds exactly one durable review in the same turn and does not rewrite request', async t => {
  const f = await scenario(t, { copies: 2 })
  assert.equal(f.requests.length, 2); assert.equal(f.events.filter(notice).length, 1); assert.equal(f.events.filter(inserted).length, 1)
  assert.equal(f.events.filter(e => e.type === 'turn/start').length, 1)
  assert.equal(f.events.filter(e => e.type === 'turn/end').length, 1)
  assert.deepEqual(f.requests.map(JSON.stringify), f.observed)
  assert.deepEqual(f.events.find(e => e.type === 'user/message' && e.data.id === f.original.id).data, f.original)
  assert.ok(f.requests[1].messages.some(m => m.source?.kind === completionReviewSource))
  assert.equal(f.events.at(-1).type, 'turn/end')
})
for (const finish of ['max-tokens', 'tool-concludes', 'throw', 'error']) test(`native ${finish} never requests completion review`, async t => {
  const f = await scenario(t, { finish })
  assert.equal(f.requests.length, 1); assert.equal(f.events.filter(inserted).length, 0)
})
test('abort in stopping listener prevents steer and prevents a new turn', async t => {
  const f = await scenario(t, { abort: true })
  assert.equal(f.requests.length, 1); assert.equal(f.events.filter(inserted).length, 0)
  assert.equal(f.events.filter(e => e.type === 'turn/start').length, 1)
})
for (const guard of ['max-steps', 'actual-budget']) test(`external ${guard} guard refuses extra admission without another model call or steering`, async t => {
  const f = await scenario(t, { guard, copies: 2 })
  assert.equal(f.requests.length, 1); assert.equal(f.events.filter(inserted).length, 1)
  assert.equal(f.events.filter(e => e.type === 'turn/start').length, 1)
  assert.equal(f.events.at(-1).data.reason.kind, 'error')
})
test('steer throw is swallowed, duplicate installation cannot retry in same process', async t => {
  const f = await scenario(t, { throwSteer: true, copies: 2 })
  assert.equal(f.steerAttempts, 1); assert.equal(f.requests.length, 1)
  assert.equal(f.events.at(-1).data.reason.kind, 'completed')
})
test('durable pending and committed markers survive native Session restore and fork', async t => {
  const f = await scenario(t)
  const spliceIndex = f.events.findIndex(inserted), committedIndex = f.events.findIndex(notice)
  for (const index of [spliceIndex, committedIndex]) {
    const seed = f.events.slice(0, index + 1)
    for (const session of [Session.create('restored', JSON.parse(JSON.stringify(seed))), Session.create('forked', buildForkSeed(seed, seed.at(-1).seq))]) {
      assert.ok(session.snapshotEvents().some(inserted) || session.snapshotEvents().some(notice), 'fork/restore retains a durable marker')
      let handler, steered = 0
      installCompletionReview({ on(_name, callback) { handler = callback; return () => {} } }, { enabled: true }, { mode: 'apply' })
      const event = { turn: 1, signal: new AbortController().signal, agent: { status: 'running', session, inbox: { nextStep: [], nextTurn: [] }, steer() { steered++ } } }
      assert.equal(completionReviewEligible(event, 48), false); handler(event); assert.equal(steered, 0)
    }
  }
})
test('persisted stop/step checks reject missing finish, wrong attempt, ended turn and ceiling', async t => {
  const f = await scenario(t)
  const cut = f.events.findIndex(inserted), seed = f.events.slice(0, cut)
  const eventFor = events => ({ turn: 1, signal: new AbortController().signal, agent: { status: 'running', session: Session.create('check', events), inbox: { nextStep: [], nextTurn: [] }, steer() {} } })
  assert.equal(completionReviewEligible(eventFor(seed), 48), true)
  assert.equal(completionReviewEligible(eventFor(seed), 1), false)
  for (const kind of ['finish-missing', 'max-tokens', 'interrupted', 'attempt', 'wrong-step', 'ended']) {
    const copy = structuredClone(seed), assistant = copy.findLast(e => e.type === 'assistant/message')
    if (kind === 'finish-missing') assistant.data.stream = []
    if (kind === 'max-tokens') assistant.data.stream.find(r => r.chunk?.type === 'finish').chunk.reason.kind = 'max-tokens'
    if (kind === 'interrupted') assistant.data.interrupted = true
    if (kind === 'attempt') { assistant.type = 'assistant/attempt'; delete assistant.surfaceOp }
    if (kind === 'wrong-step') assistant.data.step++
    if (kind === 'ended') copy.push({ ...f.events.find(e => e.type === 'turn/end'), seq: copy.at(-1).seq + 1 })
    assert.equal(completionReviewEligible(eventFor(copy), 48), false, kind)
  }
})

test('native plugin start ceiling prevents review at the boundary; normal tool steps below it remain eligible', async t => {
  const blocked = await scenario(t, { finish: 'tool-then-stop', config: { enabled: true, maxStartStep: 2 } })
  assert.equal(blocked.requests.length, 2); assert.equal(blocked.events.filter(inserted).length, 0)
  const allowed = await scenario(t, { finish: 'tool-then-stop', config: { enabled: true, maxStartStep: 3 } })
  assert.equal(allowed.requests.length, 3); assert.equal(allowed.events.filter(inserted).length, 1)
})

test('copied public config/index opt-in integrates through native plugin; default shape is unchanged', async t => {
  assert.equal(Object.hasOwn(candidateConfig(), 'completionReview'), false)
  assert.deepEqual(candidateConfig({ completionReview: {} }).completionReview, { enabled: false, maxStartStep: 48 })
  assert.throws(() => candidateConfig({ completionReview: { extra: true } }))
  const f = await scenario(t, { usePlugin: true })
  assert.equal(f.requests.length, 2); assert.equal(f.events.filter(notice).length, 1)
  const cli = createRequire(resolve('.omx/cli-runtime/package.json'))
  const { sessionFormatCatalog } = await import(pathToFileURL(cli.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
  const restore = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader({ ...f.agent.session.header, delegationDepth: 0 }, 0), { recovery: 'strict', validation: 'current' })
  for (const event of f.events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
  assert.deepEqual(restore.finish().events, f.events)
})

test('throw after durable steer still delivers only once and ends in the same turn', async t => {
  const f = await scenario(t, { throwSteer: 'after', copies: 2 })
  assert.equal(f.steerAttempts, 1); assert.equal(f.requests.length, 2)
  assert.equal(f.events.filter(inserted).length, 1); assert.equal(f.events.filter(e => e.type === 'turn/start').length, 1)
})
test('unloading removes listener and each subsequent task receives at most its own review', async t => {
  const f = await scenario(t)
  f.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Second task' }], source: { kind: 'user' } }))
  await f.agent.whenIdle()
  assert.equal(f.requests.length, 4)
  assert.deepEqual(f.agent.session.snapshotEvents().filter(notice).map(event => event.data.source.turn), [1, 2])
  let handler, removed = false
  const dispose = installCompletionReview({ on(_name, callback) { handler = callback; return () => { removed = true } } }, { enabled: true }, { mode: 'apply' })
  const first = f.events.slice(0, f.events.findIndex(inserted)); let steered = 0
  const event = { turn: 1, signal: new AbortController().signal, agent: { status: 'running', session: Session.create('disposal', first), inbox: { nextStep: [], nextTurn: [] }, steer() { steered++ } } }
  assert.equal(completionReviewEligible(event, 48), true)
  dispose(); handler(event)
  assert.equal(removed, true); assert.equal(steered, 0)
})

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
for (const [streamGuard, reason] of [['calls', 'max-calls'], ['cost', 'max-cost-actual'], ['unknown', 'incomplete-usage']]) test(`real native stream ${streamGuard} guard refuses review before second adapter invocation`, async t => {
  const f = await scenario(t, { streamGuard, copies: 2 })
  assert.deepEqual(f.budgetRejections, [reason]); assert.equal(f.budgetRecords.length, 1)
  assert.equal(f.requests.length, 1); assert.equal(f.events.filter(inserted).length, 1)
  assert.equal(f.events.filter(e => e.type === 'turn/start').length, 1)
  assert.equal(f.events.at(-1).data.reason.kind, 'error')
  // Visibility notification alone must not be mistaken for a completed adapter call.
  assert.equal(f.requests.filter(r => r.messages.some(m => m.source?.kind === completionReviewSource)).length, 0)
})
test('native review visibility hashes match the exact adapter request and durable notice', async t => {
  const f = await scenario(t)
  const observed = f.diagnostics.filter(record => record.reason === 'completion-review-model-visible')
  assert.equal(observed.length, 1)
  const record = observed[0], message = f.events.find(notice).data
  assert.deepEqual(record, { strategy: 'completion-review-v1', mode: 'observe', outcome: 'observed', reason: 'completion-review-model-visible', reviewId: message.id, contentHash: hash(message.content), requestHash: hash(f.requests[1]) })
})
test('visibility observer is read-only, restores from request markers, tolerates failed diagnostics, and stops after disposal', async t => {
  const f = await scenario(t), request = structuredClone(f.requests[1]), handlers = new Map(), removed = [], records = []
  function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
  freeze(request)
  const before = JSON.stringify(request), revision = f.agent.session.seq
  let diagnosticMode = 'ok', nextCalls = 0
  const dispose = installCompletionReview({
    on(name, handler) { handlers.set(name, handler); return () => removed.push(name) },
    parallel(_name, record) { records.push(record); if (diagnosticMode === 'throw') throw Error('diagnostic failure'); if (diagnosticMode === 'reject') return Promise.reject(Error('diagnostic failure')) },
  }, { enabled: true }, { mode: 'apply' })
  for (const mode of ['ok', 'throw', 'reject']) { diagnosticMode = mode; handlers.get('llm/stream')(request, () => { nextCalls++ }) }
  await Promise.resolve()
  assert.equal(nextCalls, 3); assert.equal(records.length, 3)
  assert.equal(JSON.stringify(request), before); assert.equal(f.agent.session.seq, revision)
  for (const record of records) assert.equal(record.requestHash, hash(request))
  for (const mutate of [m => { m.content[0].text += 'changed' }, m => { m.source.turn = '1' }, m => { m.source.kind = 'user' }, m => { m.id = 'unidentified' }]) {
    const changed = structuredClone(request), message = changed.messages.find(m => m.source?.kind === completionReviewSource)
    mutate(message); handlers.get('llm/stream')(changed, () => { nextCalls++ })
  }
  assert.equal(records.length, 3)
  dispose(); handlers.get('llm/stream')(request, () => { nextCalls++ })
  assert.equal(records.length, 3); assert.equal(nextCalls, 8)
  assert.deepEqual(removed.sort(), ['agent/turn-stopping', 'llm/stream'])
})

test('native checkpoint + hints + review preserves original evidence and exposes one review after real checkpoint adoption', async t => {
  const { default: SpillLocal } = await load('dsh-spill-local')
  const directory = await mkdtemp(join(tmpdir(), 'completion-checkpoint-')), ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, systemPrompt: { personaPrefix: '' } })
  await ctx.plugin(SpillLocal, { root: directory, cleanupPeriodDays: 0 })
  const toolText = 'src/file.py:42: exact public operation validation evidence 中文'
  ctx.tools.register(defineContentToolFixture({ name: 'fixture', description: 'fixture', parameters: {}, execute: async () => [{ type: 'text', text: toolText }] }))
  const records = [], checkpoints = [], requests = [], preReviewSnapshots = []
  ctx.on('free-context/decision', record => { records.push(record) })
  ctx.on('free-context/checkpoint', record => { checkpoints.push(record) })
  await ctx.plugin(CandidatePlugin, { mode: 'apply', tools: [], executionHints: { enabled: true }, completionReview: { enabled: true },
    checkpoint: { enabled: true, retainRecentSteps: 2, minModelUses: 2, minEntries: 2, minStepsBetweenCheckpoints: 0, minSavingsTokens: 64 } })
  ctx.on('agent/turn-stopping', ({ agent }) => { preReviewSnapshots.push(structuredClone(agent.session.snapshotEvents())) }, { prepend: true })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      requests.push(structuredClone(request))
      const step = requests.length, blocks = step <= 8 ? [{ type: 'reasoning', text: 'reasoning '.repeat(1800) }, { type: 'tool-call', id: `combined-${step}`, name: 'fixture', arguments: '{}' }] : [{ type: 'text', text: 'done' }]
      for (const [index, block] of blocks.entries()) { yield { type: 'block-start', index, blockType: block.type }; yield { type: 'block-end', index, block } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: step <= 8 ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['combined-replay'], new Adapter())
  const harness = await mountAgentLoopTestHarness(ctx), agent = await harness.create('combined-loop', { provider: 'combined-replay', model: 'fixture' }, { cwd: directory })
  const original = createUserMessage({ content: [{ type: 'text', text: 'Original task constraints: preserve scope; validate the public operation.' }], source: { kind: 'user' } })
  agent.followup(original); await agent.whenIdle()
  const events = agent.session.snapshotEvents(), review = events.find(notice)
  assert.equal(requests.length, 10); assert.equal(events.filter(notice).length, 1); assert.equal(events.filter(inserted).length, 1)
  assert.equal(events.filter(e => e.type === 'turn/start').length, 1)
  assert.ok(checkpoints.some(record => record.reason === 'checkpointed'))
  assert.ok(events.some(event => event.type === 'compaction/end' && event.seq < review.seq))
  assert.deepEqual(events.slice(0, preReviewSnapshots[0].length), preReviewSnapshots[0], 'all pre-review log events remain byte-identical')
  assert.deepEqual(events.find(event => event.type === 'user/message' && event.data.id === original.id).data, original)
  const reviewRequest = requests[9]
  assert.ok(reviewRequest.messages.some(message => message.id === original.id && hash(message.content) === hash(original.content)))
  assert.ok(reviewRequest.messages.some(message => message.source?.kind === 'free-context-execution-hints-v1'))
  assert.ok(reviewRequest.messages.some(message => message.id === review.data.id && hash(message.content) === hash(review.data.content)))
  assert.ok(reviewRequest.messages.some(message => message.source?.kind === 'compact-checkpoint' && message.content.some(block => block.text?.includes(toolText))))
  assert.ok(reviewRequest.messages.some(message => message.role === 'tool' && message.content.some(block => block.text === toolText)))
  const visible = records.filter(record => record.reason === 'completion-review-model-visible')
  assert.equal(visible.length, 1); assert.equal(visible[0].requestHash, hash(reviewRequest)); assert.equal(visible[0].reviewId, review.data.id)
  assert.ok(records.some(record => record.reason === 'checkpoint-model-visible' && record.requestHash === hash(reviewRequest)))
  for (const event of events.filter(event => event.type === 'tool/result')) assert.equal(event.data.message.content[0].text, toolText)
  // Seed from the committed notice, before the next step; both pending insertion and
  // committed marker survive native restoration/fork even after earlier compaction.
  const seed = events.slice(0, events.findIndex(notice) + 1)
  for (const session of [Session.create('combined-restored', structuredClone(seed)), Session.create('combined-fork', buildForkSeed(seed, seed.at(-1).seq))]) {
    assert.ok(session.snapshotEvents().some(notice))
    assert.equal(completionReviewEligible({ turn: 1, signal: new AbortController().signal, agent: { status: 'running', session, inbox: { nextStep: [], nextTurn: [] }, steer() { assert.fail('duplicate review') } } }, 48), false)
    const messages = session.deriveMessages()
    assert.ok(messages.some(message => message.id === review.data.id))
    const handlers = new Map(), restoredRecords = []
    const dispose = installCompletionReview({ on(name, handler) { handlers.set(name, handler); return () => {} }, parallel(_name, record) { restoredRecords.push(record) } }, { enabled: true }, { mode: 'apply' })
    const restoredRequest = { messages }
    handlers.get('llm/stream')(restoredRequest, () => {})
    assert.equal(restoredRecords.length, 1); assert.equal(restoredRecords[0].reviewId, review.data.id); assert.equal(restoredRecords[0].requestHash, hash(restoredRequest))
    dispose()
  }
})
