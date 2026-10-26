import assert from 'node:assert/strict'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { archiveOriginal } from '../../src/snapshot.js'
import { recoverSnapshot, verifySnapshot } from '../../src/recovery.js'

const requireRuntime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: Tools } = await load('@deepseek-ai/dsh-tools')
const { default: LocalFs } = await load('@deepseek-ai/dsh-fs-local')
const { default: SpillLocal } = await load('@deepseek-ai/dsh-spill-local')
const ToolFs = await load('@deepseek-ai/dsh-tool-fs')
const { provideWorkingDirectoryFixture } = await load('@deepseek-ai/dsh-agent-loop-testkit')

const verify = verifySnapshot

async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'free-context-recovery-boundaries-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  provideWorkingDirectoryFixture(ctx, directory)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(LocalFs, { cwd: directory })
  await ctx.plugin(ToolFs, config)
  const root = join(directory, 'spill')
  await ctx.plugin(SpillLocal, { root, cleanupPeriodDays: 0 })
  const session = { header: { id: 'recovery-boundaries', cwd: directory } }
  const exec = { name: 'source', callId: 'original', agent: { session } }
  const save = text => archiveOriginal(ctx.spillStore, exec, text)
  const read = (receipt, offset = 1, limit = 2) => ctx.tools.execute({
    name: 'read', callId: `read-${offset}`, arguments: { file_path: receipt.locator, offset, limit },
    agent: { session }, signal: new AbortController().signal,
  })
  return { ctx, directory, root, save, read }
}

test('official byte pagination exactly restores Unicode, CRLF, terminal newline and long lines after source edits', async t => {
  const { ctx, directory, save } = await fixture(t)
  const original = '\ufeff中文😀e\u0301\r\n' + '超长😀'.repeat(1400) + '\r\n中间\r孤立\n末行\r\n'
  const source = join(directory, 'source.txt')
  await writeFile(source, original)
  const sourceTarget = await ctx.fs.resolve(source)
  const receipt = await save(Buffer.from(await ctx.fs.readBytes(sourceTarget, undefined, 20000)).toString('utf8'))
  await writeFile(source, 'modified source must not replace the snapshot')
  const target = await ctx.fs.resolve(receipt.locator)
  const pages = []
  for (let offset = 0; offset < receipt.bytes; offset += 113) {
    const page = await ctx.fs.readByteRange(target, { offset, length: 113 })
    assert.ok(page.byteLength > 0 && page.byteLength <= 113)
    pages.push(Buffer.from(page))
  }
  assert.ok(pages.length > 100)
  const recovered = Buffer.concat(pages)
  verify(receipt, recovered)
  assert.deepEqual(await recoverSnapshot(receipt, async (locator, { offset, length, signal }) =>
    ctx.fs.readByteRange(await ctx.fs.resolve(locator), { offset, length }, signal), { pageBytes: 113 }), recovered)
  assert.equal(recovered.toString('utf8'), original)
  assert.equal((await ctx.fs.readByteRange(target, { offset: receipt.bytes, length: 113 })).byteLength, 0)
  assert.notEqual(await ctx.fs.readText(sourceTarget), original)
})

test('reading every model-facing line cannot verify CRLF or terminal-newline bytes', async t => {
  const { save, read } = await fixture(t)
  for (const original of ['中文😀\r\n第二行\r\n第三行', '中文😀\n第二行\n第三行\n']) {
    const receipt = await save(original)
    const lines = []
    for (let offset = 1; offset <= 3; offset += 2) {
      const result = await read(receipt, offset)
      assert.equal(result.isError, false)
      lines.push(...result.value.lines.map(line => line.text))
    }
    assert.equal(lines.length, 3)
    assert.throws(() => verify(receipt, Buffer.from(lines.join('\n'))), /byte count/)
  }
})

test('model read long-line truncation is not repairable by advancing its line offset', async t => {
  const { save, read } = await fixture(t, { readMaxLineLength: 40 })
  const original = 'start ' + '中文😀'.repeat(200) + ' SECRET_END\nlast'
  const receipt = await save(original)
  const result = await read(receipt)
  assert.equal(result.isError, false)
  assert.match(result.value.lines[0].text, /line truncated/)
  assert.equal(result.value.lines.some(line => line.text.includes('SECRET_END')), false)
  assert.equal(result.value.totalLines, 2)
  assert.throws(() => verify(receipt, Buffer.from(result.value.lines.map(line => line.text).join('\n'))))
  assert.equal((await read(receipt, 3)).isError, true)
})

test('byte-capped model pages expose no-progress while public byte read rejects undersized caps', async t => {
  const { ctx, save, read } = await fixture(t, { readMaxBytes: 12 })
  const receipt = await save('中'.repeat(20) + '\nlast')
  const result = await read(receipt)
  assert.equal(result.isError, false)
  assert.deepEqual(result.value.lines, [])
  assert.match(result.content[0].text, /Output capped/)
  assert.throws(() => verify(receipt, Buffer.alloc(0)), /byte count/)
  const target = await ctx.fs.resolve(receipt.locator)
  await assert.rejects(ctx.fs.readBytes(target, undefined, receipt.bytes - 1), { code: 'FS_TOO_LARGE' })
  verify(receipt, await ctx.fs.readBytes(target, undefined, receipt.bytes))
})

test('partial matches, same-length corruption and appended bytes never count as complete recovery', async t => {
  const { ctx, save } = await fixture(t)
  const original = 'header\nERROR evidence\ntail'
  const receipt = await save(original)
  const target = await ctx.fs.resolve(receipt.locator)
  const match = await ctx.fs.readByteRange(target, { offset: 7, length: 14 })
  assert.match(Buffer.from(match).toString(), /ERROR evidence/)
  assert.throws(() => verify(receipt, match), /byte count/)
  await writeFile(receipt.locator, original.replace('ERROR', 'WRONG'))
  assert.throws(() => verify(receipt, Buffer.from(original.replace('ERROR', 'WRONG'))), /hash mismatch/)
  assert.throws(() => verify(receipt, Buffer.from(original + '\n')), /byte count/)
  const corrupt = await ctx.fs.readBytes(target, undefined, receipt.bytes)
  assert.throws(() => verify(receipt, corrupt), /hash mismatch/)
})

test('missing, directory and cancelled artifact reads fail instead of using current source', async t => {
  const { ctx, directory, save, read } = await fixture(t)
  const receipt = await save('historical snapshot')
  const target = await ctx.fs.resolve(receipt.locator)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(ctx.fs.readByteRange(target, { offset: 0, length: 10 }, controller.signal), { code: 'FS_ABORTED' })
  await assert.rejects(ctx.fs.readBytes(await ctx.fs.resolve(directory), undefined, 100), { code: 'FS_NOT_REGULAR_FILE' })
  await rm(receipt.locator)
  assert.equal((await read(receipt)).isError, true)
  await assert.rejects(ctx.fs.readByteRange(target, { offset: 0, length: 10 }))
})

test('official spill startup expiry removes old artifacts and subsequent recovery fails', async t => {
  const { ctx, root, save, read } = await fixture(t)
  const receipt = await save('old snapshot')
  const old = new Date(Date.now() - 3 * 86400000)
  await utimes(receipt.locator, old, old)
  const sweeper = new Context()
  try {
    await sweeper.plugin(SpillLocal, { root, cleanupPeriodDays: 1 })
    // Disposal waits for the official startup cleanup job to finish.
  } finally { await sweeper.fiber.dispose() }
  assert.equal(await ctx.fs.stat(await ctx.fs.resolve(receipt.locator)), undefined)
  assert.equal((await read(receipt)).isError, true)
})
