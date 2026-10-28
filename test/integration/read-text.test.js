import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import * as FreeContext from '../../src/index.js'
import { createFilesystemReadClassifier } from '../../src/read-source-classifier.js'
import { decodeLosslessText } from '../../src/lossless-text.js'
import { verifySnapshot } from '../../src/recovery.js'

const runtimeRoot = resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime')
const requireRuntime = createRequire(join(runtimeRoot, 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: Tools } = await load('@deepseek-ai/dsh-tools')
const { default: LocalFs } = await load('@deepseek-ai/dsh-fs-local')
const { default: SpillLocal } = await load('@deepseek-ai/dsh-spill-local')
const ToolFs = await load('@deepseek-ai/dsh-tool-fs')
const { provideWorkingDirectoryFixture } = await load('@deepseek-ai/dsh-agent-loop-testkit')

const sourceText = 'Repeated diagnostic preamble. '.repeat(700) + '\n唯一事实😀: src/main.ts:17 TS2322\n  trailing spaces  '
const config = { mode: 'apply', tools: ['read'], json: { enabled: false }, logs: { enabled: false } }

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'free-context-read-text-')))
  const spillRoot = join(directory, 'spill')
  await mkdir(spillRoot)
  const contexts = []
  t.after(async () => {
    for (const ctx of contexts) await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  async function runtime({ enabled = false, encodeArtifacts = false, classifier = true } = {}) {
    const ctx = new Context()
    contexts.push(ctx)
    provideWorkingDirectoryFixture(ctx, directory)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(LocalFs, { cwd: directory })
    await ctx.plugin(ToolFs, { readMaxLineLength: 40000, readMaxBytes: 100000 })
    await ctx.plugin(SpillLocal, { root: spillRoot, cleanupPeriodDays: 0 })
    if (classifier) ctx.provide('freeContextReadClassifier', createFilesystemReadClassifier({
      sourceRoots: [directory], artifactRoots: [spillRoot], artifactInventoryComplete: true,
    }))
    const decisions = []
    ctx.on('free-context/decision', record => decisions.push(record))
    await ctx.plugin(FreeContext, { ...config, ...(enabled ? { readText: { enabled: true, encodeArtifacts } } : {}) })
    const session = { header: { id: 'read-text-session', cwd: directory } }
    const read = (filePath, callId, owner = session) => ctx.tools.execute({
      name: 'read', callId, arguments: { file_path: filePath }, agent: { session: owner }, signal: new AbortController().signal,
    })
    return { ctx, session, read, decisions }
  }
  const file = join(directory, 'source.txt')
  await writeFile(file, sourceText)
  return { directory, spillRoot, file, runtime }
}

function unpack(result) {
  const text = result.content[0].text
  const delimiter = '\n\nOriginal tool-result snapshot: '
  const split = text.indexOf(delimiter)
  assert.ok(split > 0, 'encoded read has an original snapshot receipt')
  const receipt = JSON.parse(text.slice(split + delimiter.length).split('\n')[0])
  return { encoded: text.slice(0, split), receipt }
}

test('official read packing preserves structured value and presentation metadata and archives exact rendered text', async t => {
  const f = await fixture(t)
  const baseline = await f.runtime()
  const enabled = await f.runtime({ enabled: true })
  const original = await baseline.read(f.file, 'original')
  const packed = await enabled.read(f.file, 'packed')
  assert.equal(original.isError, false)
  assert.equal(packed.isError, false)
  assert.deepEqual(packed.value, original.value)
  assert.ok(original.meta && Object.keys(original.meta).length > 0)
  assert.deepEqual(packed.meta, original.meta)
  assert.deepEqual(packed.value.lines.map(line => line.text), sourceText.split('\n'))
  const { encoded, receipt } = unpack(packed)
  assert.equal(decodeLosslessText(encoded), original.content[0].text)
  const saved = await readFile(receipt.locator)
  verifySnapshot(receipt, saved)
  assert.equal(saved.toString('utf8'), original.content[0].text)
  assert.equal(receipt.callId, 'packed')
  assert.equal(receipt.toolName, 'read')
  assert.equal(receipt.sessionId, enabled.session.header.id)
  assert.equal(enabled.decisions.at(-1).strategy, 'read-lossless-text-v1')
  assert.equal(enabled.decisions.at(-1).lossy, false)
  assert.ok(Buffer.byteLength(JSON.stringify(packed.content)) * 2 <= Buffer.byteLength(JSON.stringify(original.content)))
})

test('official snapshot reads remain raw after source edits and a fresh runtime with no old tracker', async t => {
  const f = await fixture(t)
  const baseline = await f.runtime()
  const enabled = await f.runtime({ enabled: true })
  const original = await baseline.read(f.file, 'original')
  const { receipt } = unpack(await enabled.read(f.file, 'packed'))
  await writeFile(f.file, 'source changed after the snapshot')
  const baselineRecovery = await baseline.read(receipt.locator, 'baseline-recovery')
  const recovery = await enabled.read(receipt.locator, 'recovery')
  assert.deepEqual(recovery, baselineRecovery)
  assert.equal(recovery.value.lines.map(line => line.text).join('\n'), original.content[0].text)
  assert.equal(enabled.decisions.at(-1).reason, 'no-strategy')
  const target = await enabled.ctx.fs.resolve(receipt.locator)
  const saved = Buffer.from(await enabled.ctx.fs.readBytes(target, undefined, receipt.bytes))
  verifySnapshot(receipt, saved)
  assert.equal(saved.toString('utf8'), original.content[0].text)
  assert.notEqual((await baseline.read(f.file, 'changed')).content[0].text, saved.toString('utf8'))

  // A newly installed plugin has no registration for this prior snapshot. Root
  // classification still excludes it; this is not a Session-log replay claim.
  const fresh = await f.runtime({ enabled: true })
  assert.deepEqual(await fresh.read(receipt.locator, 'fresh-recovery'), baselineRecovery)
  assert.equal(fresh.decisions.at(-1).reason, 'no-strategy')
  const anotherSession = { header: { id: 'another-session', cwd: f.directory } }
  assert.deepEqual(await fresh.read(receipt.locator, 'other-session-recovery', anotherSession), baselineRecovery)
  assert.equal(fresh.decisions.at(-1).reason, 'no-strategy')
})

test('official read defaults stay raw and enabled mode without a host classifier keeps original output', async t => {
  const f = await fixture(t)
  const baseline = await f.runtime()
  const noClassifier = await f.runtime({ enabled: true, classifier: false })
  const original = await baseline.read(f.file, 'default')
  assert.match(original.content[0].text, /^<path>/)
  assert.equal(baseline.decisions.length, 0)
  assert.deepEqual(await noClassifier.read(f.file, 'unknown-source'), original)
  assert.equal(noClassifier.decisions.at(-1).reason, 'no-strategy')
  const enabled = await f.runtime({ enabled: true })
  const missing = join(f.directory, 'missing.txt')
  assert.deepEqual(await enabled.read(missing, 'failed'), await baseline.read(missing, 'baseline-failed'))
  assert.equal(enabled.decisions.at(-1).reason, 'tool-failure')
})


test('official artifact opt-in encodes only the rendered read without creating recursive snapshots', async t => {
  const f = await fixture(t)
  const baseline = await f.runtime()
  const source = await f.runtime({ enabled: true })
  const { receipt } = unpack(await source.read(f.file, 'source-snapshot'))
  const saved = await readFile(receipt.locator)
  const inventory = async () => (await readdir(f.spillRoot, { recursive: true })).sort()
  const before = await inventory()
  await writeFile(f.file, 'source changed after archive')
  const expected = await baseline.read(receipt.locator, 'raw-render')
  const enabled = await f.runtime({ enabled: true, encodeArtifacts: true })
  for (const runtime of [enabled, await f.runtime({ enabled: true, encodeArtifacts: true })]) {
    for (let index = 0; index < 3; index++) {
      const actual = await runtime.read(receipt.locator, `artifact-${index}`)
      // This validates the current rendered read, not complete original file bytes
      // or Session replay. A fresh host can classify without prior tracker state.
      assert.equal(decodeLosslessText(actual.content[0].text), expected.content[0].text)
      assert.deepEqual(actual.value, expected.value)
      assert.deepEqual(actual.meta, expected.meta)
      assert.equal(actual.isError, false)
      assert.ok(Buffer.byteLength(JSON.stringify(actual.content)) * 2 <= Buffer.byteLength(JSON.stringify(expected.content)))
      assert.equal(runtime.decisions.at(-1).strategy, 'read-artifact-lossless-text-v1')
      assert.equal(runtime.decisions.at(-1).snapshots, undefined)
      assert.deepEqual(await inventory(), before)
      assert.deepEqual(await readFile(receipt.locator), saved)
    }
  }
  verifySnapshot(receipt, saved)
})
