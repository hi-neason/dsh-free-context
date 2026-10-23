import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as Plugin from '../../src/index.js'

const requireRuntime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { Session, buildForkSeed } = await load('@deepseek-ai/dsh-session')
const { createMessage, createToolResultMessage } = await load('@deepseek-ai/dsh-llm')
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: Tools, defineContentToolFixture } = await load('@deepseek-ai/dsh-tools')
const { default: Projections } = await load('@deepseek-ai/dsh-session-projection')
const { default: TokenMeter } = await load('@deepseek-ai/dsh-token-meter')
const { default: SpillLocal } = await load('@deepseek-ai/dsh-spill-local')
const { default: LocalFs } = await load('@deepseek-ai/dsh-fs-local')
const ToolFs = await load('@deepseek-ai/dsh-tool-fs')
const { provideWorkingDirectoryFixture } = await load('@deepseek-ai/dsh-agent-loop-testkit')

function appendToolResult(session, turn, callId, content) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', { turn, step: 1, stream: [], message: createMessage({
    role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    content: [{ type: 'tool-call', id: callId, name: 'source_fixture', arguments: '{}' }],
  }) }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: 'source_fixture', arguments: '{}' })
  const result = session.append('tool/result', { turn, step: 1,
    message: createToolResultMessage({ callId, content, isError: false }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return result
}

function receiptFrom(session) {
  const message = session.deriveMessages().find(message => message.source?.callId === 'old-source')
  const text = message.content[0].text
  const marker = 'Original tool-result snapshot: '
  assert.ok(text.includes(marker))
  return JSON.parse(text.slice(text.indexOf(marker) + marker.length).split('\n')[0])
}

async function readSnapshot(ctx, session, locator) {
  const lines = []
  for (let offset = 1; ; ) {
    const output = await ctx.tools.execute({ name: 'read', callId: `recover-${session.id}-${offset}`,
      arguments: { file_path: locator, offset, limit: 17 }, agent: { session }, signal: new AbortController().signal })
    assert.equal(output.isError, false)
    assert.ok(output.value.lines.length > 0)
    assert.equal(output.value.lines[0].number, offset)
    lines.push(...output.value.lines.map(line => line.text))
    offset = output.value.lines.at(-1).number + 1
    if (offset > output.value.totalLines) return lines.join('\n')
  }
}

test('persisted retirement snapshot survives restore/fork/unload and is recoverable with official paginated read', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-context-retirement-recovery-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  provideWorkingDirectoryFixture(ctx, directory)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Projections)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(LocalFs, { cwd: directory })
  await ctx.plugin(SpillLocal, { root: join(directory, 'spill'), cleanupPeriodDays: 0 })
  await ctx.plugin(ToolFs)
  const sourcePath = join(directory, 'original.txt')
  // LF-only fixture without terminal newline: read's canonical line values can
  // reconstruct its exact bytes. This does not prove byte-exact CRLF recovery.
  const original = Array.from({ length: 200 }, (_, index) => `记录 ${index}: 原始证据 😀 ${'unchanged '.repeat(8)}`).join('\n')
  await writeFile(sourcePath, original, 'utf8')
  ctx.tools.register(defineContentToolFixture({ name: 'source_fixture', description: 'read source fixture', parameters: {},
    execute: async () => [{ type: 'text', text: await readFile(sourcePath, 'utf8') }] }))
  const session = Session.create('recovery-parent')
  const raw = await ctx.tools.execute({ name: 'source_fixture', callId: 'old-source', arguments: {},
    agent: { session }, signal: new AbortController().signal })
  assert.equal(raw.isError, false)
  const originalEvent = appendToolResult(session, 1, 'old-source', raw.content)
  appendToolResult(session, 2, 'recent-source', [{ type: 'text', text: 'retain recent' }])
  const decisions = []
  ctx.on('free-context/retirement', record => { decisions.push(record) })
  const plugin = await ctx.plugin(Plugin, { mode: 'apply', retirement: {
    enabled: true, tools: ['source_fixture'], minInputBytes: 100, retainRecentResults: 1,
    minAgeSteps: 1, minModelUses: 0, maxEntriesPerStep: 1, minimumFutureRequests: 100,
    pricing: { uncachedInputPerMillion: 1, cacheReadPerMillion: 1 }, expectedRecoveryCost: 0, safetyMargin: 0.1,
  } })
  await ctx.waterfall('agent/pre-step', { agent: { session }, signal: new AbortController().signal }, async () => ({ kind: 'continue' }))
  assert.equal(decisions[0]?.reason, 'retired')
  const receipt = receiptFrom(session)
  assert.equal(receipt.sessionId, session.id)
  assert.equal(receipt.bytes, Buffer.byteLength(original))
  assert.equal(receipt.sha256, createHash('sha256').update(original).digest('hex'))
  assert.equal(session.eventAt(originalEvent.seq).data.message.content[0].text, original)
  const jsonlPath = join(directory, 'session.jsonl')
  await writeFile(jsonlPath, session.snapshotEvents().map(event => JSON.stringify(event)).join('\n'), 'utf8')
  await writeFile(sourcePath, 'source has changed; never use as recovery fallback', 'utf8')
  await plugin.dispose()

  const seed = (await readFile(jsonlPath, 'utf8')).split('\n').map(line => JSON.parse(line))
  const restored = Session.create('recovery-parent', seed)
  const fork = Session.create('recovery-child', buildForkSeed(restored.snapshotEvents(), restored.seq - 1))
  assert.notEqual(fork.id, receipt.sessionId)
  for (const targetSession of [restored, fork]) {
    assert.deepEqual(receiptFrom(targetSession), receipt)
    const recovered = await readSnapshot(ctx, targetSession, receipt.locator)
    assert.equal(recovered, original)
    assert.equal(Buffer.byteLength(recovered), receipt.bytes)
    assert.equal(createHash('sha256').update(recovered).digest('hex'), receipt.sha256)
  }
  // LocalSpill's owner groups storage; LocalFs read uses the explicit retained
  // locator and this host's filesystem permissions, not a caller-session ACL.
  // Therefore this local deployment lets the child read the parent's snapshot.
  await rm(receipt.locator)
  const expired = await ctx.tools.execute({ name: 'read', callId: 'expired-snapshot',
    arguments: { file_path: receipt.locator, offset: 1, limit: 17 }, agent: { session: fork }, signal: new AbortController().signal })
  assert.equal(expired.isError, true)
  assert.equal(expired.content.some(block => block.type === 'text' && block.text.includes('source has changed')), false)
  assert.equal(await readFile(sourcePath, 'utf8'), 'source has changed; never use as recovery fallback')
})
