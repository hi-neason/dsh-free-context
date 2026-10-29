import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { archiveOriginal } from '../../src/snapshot.js'
import { installSnapshotTracking } from '../../src/snapshot-telemetry.js'
import { installSnapshotRecovery } from '../../src/recovery-tool.js'

const requireRuntime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { LlmAdapter, createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { Session, buildForkSeed } = await load('@deepseek-ai/dsh-session')
const { default: SpillLocal } = await load('@deepseek-ai/dsh-spill-local')
const { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } = await load('@deepseek-ai/dsh-agent-loop-testkit')

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'free-context-recall-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(SpillLocal, { root: join(directory, 'spill'), cleanupPeriodDays: 0 })
  const tracking = installSnapshotTracking(ctx)
  const reads = { calls: 0, bytes: 0 }
  const recovery = installSnapshotRecovery(ctx, { tracking, pageCharacters: 512, ...options,
    readPage: async (locator, { offset, length, signal }) => {
      const bytes = await ctx.fs.readByteRange(await ctx.fs.resolve(locator, { signal }), { offset, length }, signal)
      reads.calls++
      reads.bytes += bytes.byteLength
      return bytes
    },
  })
  return { ctx, directory, tracking, recovery, reads }
}

class RecallAdapter extends LlmAdapter {
  constructor(referenceId) { super(); this.referenceId = referenceId; this.calls = 0 }
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(request) {
    if (++this.calls > 30) throw new Error('scripted recovery exceeded step limit')
    // Read actual model-request content, never backend bytes or expected text.
    const pages = request.messages.flatMap(message => message.content ?? []).flatMap(block => {
      if (block.type !== 'text') return []
      try { const value = JSON.parse(block.text); return value.referenceId === this.referenceId && value.snapshotVerified === true ? [value] : [] }
      catch { return [] }
    })
    const last = pages.at(-1)
    const block = last?.nextOffset === null ? { type: 'text', text: JSON.stringify({ recovered: pages.map(page => page.text).join('') }) } :
      { type: 'tool-call', id: `recall-${this.calls}`, name: 'free_context_recall',
        arguments: JSON.stringify({ referenceId: this.referenceId, offset: last?.nextOffset ?? 0 }) }
    yield { type: 'block-start', index: 0, blockType: block.type }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
  }
}

test('official AgentLoop receives exact Unicode/CRLF/long-line pages and persists recoverable transcript', async t => {
  const { ctx, directory, tracking } = await fixture(t)
  let referenceId
  const adapter = new RecallAdapter()
  ctx.llm.registerAdapter(['recovery-replay'], adapter)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create('recall-agent', { provider: 'recovery-replay', model: 'scripted' }, { cwd: directory })
  const original = '\ufeff中文😀\r\n' + 'a😀中'.repeat(900) + '\r\n最后\r孤立\n'
  const receipt = await archiveOriginal(ctx.spillStore, { agent, name: 'fixture', callId: 'original' }, original)
  referenceId = tracking.record({ agent }, receipt).referenceId
  adapter.referenceId = referenceId
  agent.followup(createUserMessage({ content: [{ type: 'text', text: `Recover exact snapshot reference ${referenceId}, all pages.` }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  const final = events.filter(event => event.type === 'assistant/message').at(-1).data.message.content
  assert.equal(JSON.parse(final.find(block => block.type === 'text').text).recovered, original)
  const results = events.filter(event => event.type === 'tool/result')
  assert.ok(results.length > 4)
  for (const event of results) {
    assert.equal(event.data.message.isError, false)
    const page = JSON.parse(event.data.message.content[0].text)
    assert.equal(page.snapshotVerified, true)
    assert.ok(Array.from(page.text).length <= 512)
    assert.equal(page.pageComplete, false)
  }
  const path = join(directory, 'session.jsonl')
  await writeFile(path, events.map(event => JSON.stringify(event)).join('\n'))
  const restored = Session.create('recall-agent', (await readFile(path, 'utf8')).split('\n').map(line => JSON.parse(line)))
  const replayed = restored.deriveMessages().flatMap(message => message.content).filter(block => block.type === 'text')
  assert.ok(replayed.some(block => { try { return JSON.parse(block.text).recovered === original } catch { return false } }))
  // Runtime registration is deliberately not restored merely by replaying text.
  const fork = Session.create('recall-fork', buildForkSeed(restored.snapshotEvents(), restored.seq - 1))
  for (const session of [restored, fork]) {
    const result = await ctx.tools.execute({ name: 'free_context_recall', callId: 'wrong-owner', arguments: { referenceId }, agent: { session }, signal: new AbortController().signal })
    assert.equal(result.isError, true)
  }
})

test('official tool execution blocks forged reference, corruption, expiry and cancellation without returning a page', async t => {
  const { ctx, tracking, recovery } = await fixture(t)
  const session = Session.create('recall-errors')
  const agent = { session }
  const receipt = await archiveOriginal(ctx.spillStore, { agent, name: 'fixture', callId: 'original' }, 'original\r\n😀')
  const { referenceId } = tracking.record({ agent }, receipt)
  const call = (arguments_, signal = new AbortController().signal) => ctx.tools.execute({ name: 'free_context_recall', callId: 'recall', arguments: arguments_, agent, signal })
  for (const args of [{ referenceId, locator: receipt.locator }, { referenceId: '0'.repeat(64) }, { referenceId, limit: 513 }]) {
    assert.equal((await call(args)).isError, true)
  }
  assert.equal((await call({ referenceId }, AbortSignal.abort())).isError, true)
  await writeFile(receipt.locator, 'modified\r\n😀')
  assert.equal((await call({ referenceId })).isError, true)
  await rm(receipt.locator)
  assert.equal((await call({ referenceId })).isError, true)
  recovery.dispose()
  assert.equal(ctx.tools.get('free_context_recall'), undefined)
})

test('main plugin snapshots share an explicitly provided registry with model recovery', async t => {
  const { ctx, directory, tracking } = await fixture(t)
  const { defineContentToolFixture } = await load('@deepseek-ai/dsh-tools')
  const Plugin = await import('../../src/index.js')
  const lines = ['TAP version 13']
  for (let index = 1; index <= 50; index++) lines.push(`# Subtest: 中文😀-${index}`, `ok ${index} - 中文😀-${index}`, '  ---', '  duration_ms: 0.125', "  type: 'test'", '  ...')
  lines.push('1..50', '# tests 50', '# suites 0', '# pass 50', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 120')
  const original = lines.join('\n') + '\n'
  ctx.provide('freeContextSnapshots', tracking)
  await ctx.plugin(Plugin, { mode: 'apply', tools: ['fixture'], minInputBytes: 0, json: { enabled: false }, logs: { enabled: true } })
  ctx.tools.register(defineContentToolFixture({ name: 'fixture', description: 'Return original Unicode TAP data', parameters: {}, execute: async () => [{ type: 'text', text: original }] }))
  class PluginRecallAdapter extends RecallAdapter {
    async *stream(request) {
      if (!request.messages.some(message => message.role === 'tool')) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'original-plugin-call', name: 'fixture', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else yield* super.stream(request)
    }
  }
  const adapter = new PluginRecallAdapter()
  ctx.on('free-context/snapshot', record => { if (record.sourceCallId === 'original-plugin-call') adapter.referenceId = record.referenceId })
  ctx.llm.registerAdapter(['plugin-recovery'], adapter)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create('plugin-recall-agent', { provider: 'plugin-recovery', model: 'scripted' }, { cwd: directory })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Call fixture, then recover its original snapshot using all recall pages.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  const result = events.find(event => event.type === 'tool/result' && event.data.message.source?.callId === 'original-plugin-call')
  assert.ok(result.data.message.content[0].text.includes('LOSSY'))
  assert.ok(result.data.message.content[0].text.includes(adapter.referenceId))
  const last = events.filter(event => event.type === 'assistant/message').at(-1).data.message.content[0].text
  assert.equal(JSON.parse(last).recovered, original)
})

test('official AgentLoop receives multiple exact ranges from one verified tool call and reports final recovery', async t => {
  const { ctx, directory, tracking, reads } = await fixture(t)
  const recoveries = []
  ctx.on('free-context/recovery', record => recoveries.push(record))
  class BatchAdapter extends LlmAdapter {
    calls = 0
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      if (++this.calls > 2) throw new Error('batch recovery needs only one tool call')
      const tool = request.messages.findLast(message => message.role === 'tool')
      const block = tool ? { type: 'text', text: JSON.stringify({ recovered: JSON.parse(tool.content[0].text).pages.map(page => page.text) }) } :
        { type: 'tool-call', id: 'batch-recall', name: 'free_context_recall',
          arguments: request.messages.find(message => message.role === 'user').content[0].text }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: tool ? 'stop' : 'tool-calls' } }
    }
  }
  const adapter = new BatchAdapter()
  ctx.llm.registerAdapter(['batch-recovery'], adapter)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create('batch-recall', { provider: 'batch-recovery', model: 'scripted' }, { cwd: directory })
  const original = '\ufeff中文😀\r\n' + 'a😀中'.repeat(900) + '\r\n最后'
  const receipt = await archiveOriginal(ctx.spillStore, { agent, name: 'fixture', callId: 'original' }, original)
  const { referenceId } = tracking.record({ agent }, receipt)
  const ranges = [{ offset: 0, limit: 6 }, { offset: 1000, limit: 10 }]
  agent.followup(createUserMessage({ content: [{ type: 'text', text: JSON.stringify({ referenceId, ranges }) }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  const final = events.filter(event => event.type === 'assistant/message').at(-1).data.message.content[0].text
  const characters = Array.from(original)
  assert.deepEqual(JSON.parse(final).recovered, ranges.map(({ offset, limit }) => characters.slice(offset, offset + limit).join('')))
  assert.equal(events.filter(event => event.type === 'tool/result').length, 1)
  assert.equal(adapter.calls, 2)
  assert.equal(reads.calls, 2)
  assert.equal(reads.bytes, receipt.bytes)
  assert.equal(recoveries.length, 1)
  assert.equal(recoveries[0].outcome, 'success')
  assert.equal(recoveries[0].reportedSnapshotVerified, true)
  assert.equal(recoveries[0].verifiedFull, false)
  assert.deepEqual(recoveries[0].characterRanges, [{ offset: 0, endOffset: 6 }, { offset: 1000, endOffset: 1010 }])
  assert.equal(recoveries[0].returnedCharacters, 16)
  for (const secret of [directory, original, 'locator', 'retrievalHint']) assert.equal(JSON.stringify(recoveries).includes(secret), false)
})

test('four-page batches recover 64 KiB with eight tool calls instead of thirty-two without changing bytes', async t => {
  const { ctx, tracking, reads } = await fixture(t, { pageCharacters: 2048 })
  const agent = { session: Session.create('batch-budget') }
  const original = 'a'.repeat(65536)
  const receipt = await archiveOriginal(ctx.spillStore, { agent, name: 'fixture', callId: 'original' }, original)
  const { referenceId } = tracking.record({ agent }, receipt)
  const recover = async batch => {
    let calls = 0
    let recovered = ''
    for (let offset = 0; offset < original.length; offset += batch ? 8192 : 2048) {
      const args = batch ? { referenceId, ranges: Array.from({ length: 4 }, (_, index) => ({ offset: offset + index * 2048, limit: 2048 })) } :
        { referenceId, offset }
      const result = await ctx.tools.execute({ name: 'free_context_recall', callId: `${batch}-${calls++}`, arguments: args, agent, signal: new AbortController().signal })
      assert.equal(result.isError, false)
      const value = JSON.parse(result.content[0].text)
      assert.equal(value.snapshotVerified, true)
      recovered += batch ? value.pages.map(page => page.text).join('') : value.text
    }
    assert.equal(recovered, original)
    return calls
  }
  assert.equal(await recover(false), 32)
  assert.deepEqual(reads, { calls: 160, bytes: 2097152 })
  reads.calls = 0
  reads.bytes = 0
  assert.equal(await recover(true), 8)
  assert.deepEqual(reads, { calls: 40, bytes: 524288 })
})
