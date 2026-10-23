import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { installReadTracking } from '../../src/read-lifecycle.js'

const requireRuntime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: Tools } = await load('@deepseek-ai/dsh-tools')
const { default: LocalFs } = await load('@deepseek-ai/dsh-fs-local')
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
  const session = { header: { cwd: directory } }
  const tracking = installReadTracking(ctx)
  const call = (name, callId, args) => ctx.tools.execute({ name, callId, arguments: args,
    agent: { session }, signal: new AbortController().signal })
  return { directory, ctx, session, tracking, call }
}

test('official read partial/full then edit establishes coverage and marks old version stale', async t => {
  const { directory, session, tracking, call } = await fixture(t)
  await writeFile(join(directory, 'file.txt'), 'one\ntwo\nthree')
  const partial = await call('read', 'partial', { file_path: 'file.txt', offset: 2, limit: 1 })
  assert.equal(partial.isError, false)
  assert.equal(tracking.query(session, 'partial').start, 2)
  assert.equal(tracking.query(session, 'partial').end, 2)
  const full = await call('read', 'full', { file_path: 'file.txt', offset: 1, limit: 100 })
  assert.equal(full.isError, false)
  assert.equal(tracking.query(session, 'full').end, 3)
  assert.equal(tracking.query(session, 'partial').supersededBy, 'full')
  assert.equal(full.value.lines.length, 3)
  assert.match(full.content[0].text, /three/)
  const edit = await call('edit', 'edit', { file_path: 'file.txt', old_string: 'two', new_string: 'changed' })
  assert.equal(edit.isError, false)
  assert.equal(tracking.query(session, 'full').status, 'stale')
  assert.equal(tracking.query(session, 'partial').status, 'stale')
  const fresh = await call('read', 'fresh', { file_path: 'file.txt' })
  assert.equal(fresh.isError, false)
  assert.notEqual(tracking.query(session, 'fresh').version, tracking.query(session, 'full').version)
  tracking.dispose()
  const untracked = await call('read', 'untracked', { file_path: 'file.txt' })
  assert.deepEqual(untracked.value, fresh.value)
  assert.deepEqual(untracked.content, fresh.content)
  assert.equal(tracking.query(session, 'fresh'), undefined)
})

test('official byte-capped read tracks only actual returned lines', async t => {
  const { directory, session, tracking, call } = await fixture(t, { readMaxBytes: 5 })
  await writeFile(join(directory, 'file.txt'), 'one\ntwo\nthree')
  const output = await call('read', 'capped', { file_path: 'file.txt', offset: 1, limit: 100 })
  assert.equal(output.isError, false)
  assert.equal(output.value.lines.length, 1)
  assert.equal(tracking.query(session, 'capped').end, 1)
})
