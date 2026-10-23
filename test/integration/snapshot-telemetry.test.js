import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { installSnapshotTracking } from '../../src/snapshot-telemetry.js'
import { archiveOriginal } from '../../src/snapshot.js'

const requireRuntime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: Tools } = await load('@deepseek-ai/dsh-tools')
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
