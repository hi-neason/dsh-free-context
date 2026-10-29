import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { installSnapshotTracking } from '../../src/snapshot-telemetry.js'
import { installSnapshotRecovery } from '../../src/recovery-tool.js'
import { archiveOriginal } from '../../src/snapshot.js'

const requireRuntime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: Tools, defineContentToolFixture } = await load('@deepseek-ai/dsh-tools')
const { default: LocalFs } = await load('@deepseek-ai/dsh-fs-local')
const { default: SpillLocal } = await load('@deepseek-ai/dsh-spill-local')
const ToolFs = await load('@deepseek-ai/dsh-tool-fs')
const { provideWorkingDirectoryFixture } = await load('@deepseek-ai/dsh-agent-loop-testkit')

async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'free-context-read-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  provideWorkingDirectoryFixture(ctx, directory)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(LocalFs, { cwd: directory })
  await ctx.plugin(ToolFs, config)
  await ctx.plugin(SpillLocal, { root: join(directory, 'spill'), cleanupPeriodDays: 0 })
  const session = { header: { id: 'telemetry-session', cwd: directory } }
  const tracking = installSnapshotTracking(ctx, { maxEntriesPerSession: 2 })
  const call = (name, callId, args) => ctx.tools.execute({ name, callId, arguments: args,
    agent: { session }, signal: new AbortController().signal })
  return { directory, ctx, session, tracking, call }
}

test('official spill and read report partial/full/failed recovery without leaking paths or claiming byte verification', async t => {
  const { directory, ctx, session, tracking, call } = await fixture(t)
  const events = []
  ctx.on('free-context/snapshot', record => events.push({event:'snapshot',record}))
  ctx.on('free-context/recovery', record => events.push({event:'recovery',record}))
  const exec = { name:'fixture', callId:'original', agent:{session}, signal:new AbortController().signal }
  const receipt = await archiveOriginal(ctx.get('spillStore'),exec,'SECRET one\nSECRET two\nSECRET three')
  const reference = tracking.record(exec,receipt)
  const partial = await call('read','partial',{file_path:receipt.locator,offset:2,limit:1})
  assert.equal(partial.isError,false)
  assert.equal(events.at(-1).record.startLine,2)
  assert.equal(events.at(-1).record.endLine,2)
  await call('read','full',{file_path:receipt.locator})
  assert.equal(events.at(-1).record.endLine,3)
  assert.equal(events.at(-1).record.verifiedFull,false)
  assert.equal(events.at(-1).record.referenceId,reference.referenceId)
  const count=events.length
  await call('read','unknown',{file_path:join(directory,'unknown')})
  assert.equal(events.length,count)
  await rm(receipt.locator)
  await call('read','missing',{file_path:receipt.locator})
  assert.equal(events.at(-1).record.outcome,'failed')
  for (const secret of [directory,'SECRET','locator','retrievalHint']) assert.equal(JSON.stringify(events).includes(secret),false)
})

test('official recovery tracking respects object ownership, eviction and explicit restored registration', async t => {
  const { ctx, session, tracking, call } = await fixture(t)
  const events = []
  ctx.on('free-context/recovery', record => events.push(record))
  const exec = { name:'fixture',callId:'original',agent:{session} }
  const receipt = await archiveOriginal(ctx.get('spillStore'),exec,'one\ntwo')
  tracking.record(exec,receipt)
  const restored = {header:{...session.header}}
  const read = {name:'read',callId:'restored',arguments:{file_path:receipt.locator},agent:{session:restored},signal:new AbortController().signal}
  await ctx.tools.execute(read)
  assert.equal(events.length,0)
  tracking.record({...exec,agent:{session:restored}},receipt)
  await ctx.tools.execute(read)
  assert.equal(events.length,1)
  for (const content of ['three','four']) {
    const extra = await archiveOriginal(ctx.get('spillStore'),exec,content)
    tracking.record(exec,extra)
  }
  await call('read','evicted',{file_path:receipt.locator})
  assert.equal(events.length,1)
})

for (const registration of ['before', 'after']) {
  test(`final recovery observes a transformer registered ${registration} tracking`, async t => {
    const { ctx, session, tracking, call } = await fixture(t)
    if (registration === 'before') tracking.dispose()
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      return exec.name === 'read' ? { kind: 'accept', content: [{ type: 'text', text: 'encoded replacement' }] } : decision
    }, { prepend: true })
    const active = registration === 'before' ? installSnapshotTracking(ctx) : tracking
    const events = []
    ctx.on('free-context/recovery', record => events.push(record))
    const exec = { name: 'fixture', callId: 'original', agent: { session } }
    const receipt = await archiveOriginal(ctx.get('spillStore'), exec, 'original one\noriginal two')
    active.record(exec, receipt)
    const result = await call('read', 'transformed', { file_path: receipt.locator })
    assert.equal(result.content[0].text, 'encoded replacement')
    assert.equal(events.length, 1)
    assert.equal(events[0].outcome, 'modified')
    assert.equal(events[0].startLine, undefined)
    assert.equal(events[0].verifiedFull, false)
  })
}

test('definition-owned finalization is observed after post policies and receives the frozen final result', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  ctx.tools.register({
    ...defineContentToolFixture({ name: 'read', description: 'finalized recovery fixture', parameters: {},
      execute: async () => [{ type: 'text', text: 'raw source' }] }),
    finalizeContent: () => [{ type: 'text', text: 'finalized source' }],
  })
  const session = { header: { id: 'finalizer-session' } }
  const exec = { name: 'read', callId: 'finalized-read', signal: new AbortController().signal, arguments: { file_path: '/private/snapshot' }, agent: { session } }
  const tracking = installSnapshotTracking(ctx)
  tracking.record(exec, { locator: '/private/snapshot', callId: 'original', sessionId: session.header.id, sha256: 'a'.repeat(64), bytes: 10 })
  const events = []
  ctx.on('free-context/recovery', record => events.push(record))
  let final
  ctx.on('tools/result', (observedExec, result) => {
    assert.equal(Object.isFrozen(observedExec), true)
    assert.equal(Object.isFrozen(result), true)
    assert.equal(Object.isFrozen(result.content), true)
    final = result
  })
  const result = await ctx.tools.execute(exec)
  assert.deepEqual(result, final)
  assert.equal(result.content[0].text, 'finalized source')
  assert.equal(events.length, 1)
  assert.equal(events[0].outcome, 'modified')
  assert.equal(events[0].verifiedFull, false)
  assert.equal(events[0].startLine, undefined)
})

for (const registration of ['before', 'after']) {
  test(`recall final telemetry respects policies registered ${registration} tracking and failed verified reads`, async t => {
    const { ctx, session, tracking, call } = await fixture(t)
    if (registration === 'before') tracking.dispose()
    let policy = 'accept'
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (exec.name !== 'free_context_recall') return decision
      if (policy === 'modify') return { kind: 'accept', content: [{ type: 'text', text: 'replacement' }] }
      if (policy === 'block') return { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }
      return decision
    }, { prepend: true })
    const active = registration === 'before' ? installSnapshotTracking(ctx) : tracking
    const controller = new AbortController()
    let cancelRead = false
    installSnapshotRecovery(ctx, { tracking: active, readPage: async (locator, { offset, length, signal }) => {
      if (cancelRead) controller.abort()
      return ctx.fs.readByteRange(await ctx.fs.resolve(locator, { signal }), { offset, length }, signal)
    } })
    const exec = { name: 'fixture', callId: 'original', agent: { session } }
    const receipt = await archiveOriginal(ctx.spillStore, exec, 'original\r\n😀 evidence')
    const { referenceId } = active.record(exec, receipt)
    const events = []
    ctx.on('free-context/recovery', record => events.push(record))
    const args = { referenceId, ranges: [{ offset: 0, limit: 3 }, { offset: 8, limit: 3 }] }
    for (const action of ['accept', 'modify', 'block']) {
      policy = action
      const result = await call('free_context_recall', action, args)
      assert.equal(result.isError, action === 'block')
      // An outer blocker is only observable as final failure; do not infer its
      // private decision from the failure text when tracking did not receive it.
      const expected = action === 'accept' ? 'success' : action === 'modify' ? 'modified' : registration === 'before' ? 'blocked' : 'failed'
      assert.equal(events.at(-1).outcome, expected)
      assert.equal(events.at(-1).recoveryTool, 'free_context_recall')
      assert.equal(events.at(-1).reportedSnapshotVerified, action === 'accept' ? true : undefined)
      assert.equal(events.at(-1).characterRanges?.length, action === 'accept' ? 2 : undefined)
    }
    policy = 'accept'
    cancelRead = true
    const cancelled = await ctx.tools.execute({ name: 'free_context_recall', callId: 'cancelled', arguments: args,
      agent: { session }, signal: controller.signal })
    assert.equal(cancelled.isError, true)
    assert.equal(events.at(-1).outcome, 'cancelled')
    assert.equal(events.at(-1).characterRanges, undefined)
    cancelRead = false
    await writeFile(receipt.locator, 'modified\r\n😀 evidence')
    assert.equal((await call('free_context_recall', 'corrupt', args)).isError, true)
    assert.equal(events.at(-1).outcome, 'failed')
    assert.equal(events.at(-1).reportedSnapshotVerified, undefined)
    await rm(receipt.locator)
    assert.equal((await call('free_context_recall', 'missing', args)).isError, true)
    assert.equal(events.at(-1).outcome, 'failed')
    assert.equal(events.length, 6)
    for (const secret of ['original\\r\\n', 'evidence', 'locator', 'retrievalHint']) assert.equal(JSON.stringify(events).includes(secret), false)
  })
}
