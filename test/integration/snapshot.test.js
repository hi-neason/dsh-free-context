import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { archiveOriginal, formatSnapshotReference } from '../../src/snapshot.js'

const requireRuntime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: SpillLocal } = await load('@deepseek-ai/dsh-spill-local')
const exec = () => ({ agent: { session: { header: { id: 'snapshot-integration' } } },
  name: 'read', callId: 'snapshot-call', signal: new AbortController().signal })

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'free-context-snapshot-'))
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  return { ctx, directory }
}

test('official spill-local preserves exact UTF-8 snapshot after source file changes', async t => {
  const { ctx, directory } = await fixture(t)
  await ctx.plugin(SpillLocal, { root: join(directory, 'spill'), cleanupPeriodDays: 0 })
  const source = join(directory, 'source.txt')
  const original = '原始记录 😀\r\n第二行\n  whitespace\t\n'
  await writeFile(source, original, 'utf8')
  const receipt = await archiveOriginal(ctx.spillStore, exec(), await readFile(source, 'utf8'))
  await writeFile(source, '源文件已经修改', 'utf8')

  // This fixture explicitly selected the local backend whose locator is a path.
  // Product code must treat other backends' locators as opaque.
  const restored = await readFile(receipt.locator)
  assert.equal(restored.toString('utf8'), original)
  assert.equal(restored.byteLength, receipt.bytes)
  assert.equal(createHash('sha256').update(restored).digest('hex'), receipt.sha256)
  assert.notEqual(await readFile(source, 'utf8'), original)
  assert.match(receipt.retrievalHint, /read with offset\/limit/)
  assert.match(formatSnapshotReference(receipt), /SHA-256/)
  assert.equal(receipt.sessionId, 'snapshot-integration')
  assert.equal(receipt.callId, 'snapshot-call')

  const second = await archiveOriginal(ctx.spillStore, { ...exec(), callId: 'second-call' }, 'second')
  assert.notEqual(second.locator, receipt.locator)
  assert.equal(await readFile(receipt.locator, 'utf8'), original)
})

test('official spill-local rejects an unusable storage root without returning a receipt', async t => {
  const { ctx, directory } = await fixture(t)
  const root = join(directory, 'regular-file')
  await writeFile(root, 'not a directory')
  await ctx.plugin(SpillLocal, { root, cleanupPeriodDays: 0 })
  await assert.rejects(archiveOriginal(ctx.spillStore, exec(), 'original'), error =>
    error.code === 'ENOTDIR' || error.code === 'EEXIST')
})
