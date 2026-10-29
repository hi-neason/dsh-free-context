import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as Experiments from '../../src/experiments.js'

const requireRuntime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: SessionStore } = await load('@deepseek-ai/dsh-session')
const { default: LlmRuntime, LlmAdapter } = await load('@deepseek-ai/dsh-llm')
const { default: ToolRuntime, defineContentToolFixture } = await load('@deepseek-ai/dsh-tools')
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: SpillLocal } = await load('@deepseek-ai/dsh-spill-local')
const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} contains general background. ${'Descriptive prose provides further ordinary context. '.repeat(10)}`).join('\n\n')
const options = overrides => ({ mode: 'apply', tools: ['prose'], provider: 'selection-fixture', model: 'fixture-model', maxInputBytes: 40000, maxPromptBytes: 50000,
  maxOutputBytes: 1000, maxOutputTokens: 100, maxArtifactBytes: 60000, timeoutMs: 1000, maxParagraphs: 50,
  pricing: { currency: 'USD', uncachedInputPerMillion: 1, cacheReadPerMillion: 0.1, outputPerMillion: 1 },
  minimumFutureRequests: 1000, futureCacheReadPerMillion: 0.1, expectedRecoveryCost: 0, safetyMargin: 0.1, maxCallCost: 1, ...overrides })

async function setup(t, behavior = {}) {
  const ctx = new Context()
  const root = await mkdtemp(join(tmpdir(), 'free-context-experiment-'))
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (!behavior.noClassifier) ctx.provide('freeContextContentClassifier', {
    classify: request => ({ ...request, kind: request.toolName === 'prose' ? 'prose' : 'unknown', complete: true }),
  })
  if (behavior.getQuery) ctx.provide('freeContextQuery', { getQuery: behavior.getQuery })
  if (!behavior.noStore) await ctx.plugin(SpillLocal, { root, cleanupPeriodDays: 0 })
  const calls = []
  class Adapter extends LlmAdapter {
    async * stream(request) {
      calls.push(request)
      if (behavior.cancel) behavior.cancel.abort()
      const response = behavior.responseFor ? behavior.responseFor(request) : '{"selectedIds":["p1"]}'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: response }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
      if (!behavior.noUsage) yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['selection-fixture'], new Adapter())
  ctx.tools.register(defineContentToolFixture({ name: 'prose', description: 'prose', parameters: {}, execute: async () => [{ type: 'text', text: behavior.text ?? text }] }))
  const records = []
  ctx.on('free-context/experiment', record => { records.push(record) })
  const exec = { name: 'prose', callId: 'prose-call', arguments: {}, agent: { session: { header: { id: 'experiment-session' } } }, signal: behavior.cancel?.signal ?? new AbortController().signal }
  return { ctx, calls, records, exec }
}

test('official prose runtime keeps original content without a trusted classifier', async t => {
  const { ctx, calls, records, exec } = await setup(t, { noClassifier: true })
  const baseline = await ctx.tools.execute(exec)
  await ctx.plugin(Experiments, options())
  assert.deepEqual(await ctx.tools.execute(exec), baseline)
  assert.equal(calls.length, 0)
  assert.equal(records.at(-1).reason, 'content-not-prose')
})

test('official runtime rejects entirely protected prose before auxiliary inference', async t => {
  const { ctx, calls, records, exec } = await setup(t)
  const baseline = await ctx.tools.execute(exec)
  await ctx.plugin(Experiments, options({ protectedTerms: ['Paragraph'] }))
  assert.deepEqual(await ctx.tools.execute(exec), baseline)
  assert.equal(calls.length, 0)
  assert.equal(records.at(-1).reason, 'no-selection-room')
})

test('official runtime supports explicit off/observe/apply and persists the auxiliary prompt-response manifest', async t => {
  const { ctx, calls, records, exec } = await setup(t)
  const baseline = await ctx.tools.execute(exec)
  const disabled = await ctx.plugin(Experiments)
  assert.deepEqual(await ctx.tools.execute(exec), baseline)
  assert.equal(calls.length, 0)
  await disabled.dispose()
  const observe = await ctx.plugin(Experiments, options({ mode: 'observe' }))
  assert.deepEqual(await ctx.tools.execute(exec), baseline)
  assert.equal(calls.length, 1)
  assert.equal(records.at(-1).reason, 'observed')
  await observe.dispose()
  const apply = await ctx.plugin(Experiments, options())
  const result = await ctx.tools.execute(exec)
  assert.equal(result.isError, false)
  assert.deepEqual(result.value, baseline.value)
  assert.ok(result.content[0].text.includes('LOSSY paragraph selection'))
  const references = result.content[0].text.split('\n').filter(line => line.startsWith('Original tool-result snapshot: ')).map(line => JSON.parse(line.slice('Original tool-result snapshot: '.length)))
  assert.equal(references.length, 2)
  assert.equal(await readFile(references[0].locator, 'utf8'), text)
  const manifest = JSON.parse(await readFile(references[1].locator, 'utf8'))
  assert.equal(manifest.audit.request.provider, 'selection-fixture')
  assert.equal(manifest.audit.response[0].text, '{"selectedIds":["p1"]}')
  assert.equal(manifest.callUsage.outputTokens, 10)
  assert.equal(manifest.originalReceipt.sha256, references[0].sha256)
  assert.equal(records.at(-1).reason, 'selected')
  await apply.dispose()
  assert.deepEqual(await ctx.tools.execute(exec), baseline)
})

test('official runtime blocks calls for absent prices, exceeded budget and absent spill backend', async t => {
  for (const scenario of ['price', 'budget', 'store']) {
    const { ctx, calls, records, exec } = await setup(t, { noStore: scenario === 'store' })
    await ctx.plugin(Experiments, options(scenario === 'price' ? { pricing: undefined } : scenario === 'budget' ? { maxCallCost: 0 } : {}))
    const result = await ctx.tools.execute(exec)
    assert.equal(result.isError, false)
    assert.deepEqual(result.content, [{ type: 'text', text }])
    assert.equal(calls.length, 0)
    assert.equal(records[0].reason, { price: 'missing-pricing', budget: 'call-cost-budget', store: 'snapshot-failed' }[scenario])
  }
})

test('official runtime missing usage and cancellation preserve safety boundaries', async t => {
  const missing = await setup(t, { noUsage: true })
  await missing.ctx.plugin(Experiments, options())
  const result = await missing.ctx.tools.execute(missing.exec)
  assert.deepEqual(result.content, [{ type: 'text', text }])
  assert.equal(missing.records[0].reason, 'missing-priced-usage')
  const cancel = await setup(t, { cancel: new AbortController() })
  await cancel.ctx.plugin(Experiments, options())
  const aborted = await cancel.ctx.tools.execute(cancel.exec)
  assert.equal(aborted.isError, true)
  assert.equal(JSON.stringify(aborted.content).includes('LOSSY paragraph selection'), false)
  assert.equal(cancel.records[0].reason, 'aborted')
})


test('official runtime query provider updates A/B/A within one session without reloading the plugin', async t => {
  let task = 'Question Alpha'
  const { ctx, exec, calls, records } = await setup(t, {
    getQuery: () => task,
    responseFor: request => JSON.stringify({ selectedIds: [JSON.parse(request.messages[0].content[0].text.split('\n').at(-1)).currentTask === 'Question Alpha' ? 'p1' : 'p2'] }),
  })
  await ctx.plugin(Experiments, options({ selectionMode: 'query-dependent', maxQueryBytes: 100, maxCacheEntries: 2 }))
  const alpha = await ctx.tools.execute(exec)
  task = 'Question Beta'
  const beta = await ctx.tools.execute(exec)
  task = 'Question Alpha'
  const again = await ctx.tools.execute(exec)
  assert.ok(alpha.content[0].text.includes('Source paragraph p1;'))
  assert.ok(beta.content[0].text.includes('Source paragraph p2;'))
  assert.ok(again.content[0].text.includes('Source paragraph p1;'))
  assert.equal(calls.length, 2)
  assert.notEqual(records[0].queryHash, records[1].queryHash)
  assert.equal(records[2].cacheHit, true)
  assert.equal(records[2].estimatedCost, 0)
  assert.deepEqual(beta.value, [{ type: 'text', text }])
})

test('official query mode handles missing service, missing usage and cancellation without applying', async t => {
  for (const behavior of [{}, { getQuery: () => 'Question Alpha', noUsage: true }, { getQuery: () => 'Question Alpha', cancel: new AbortController() }]) {
    const { ctx, exec, calls, records } = await setup(t, behavior)
    await ctx.plugin(Experiments, options({ selectionMode: 'query-dependent', maxQueryBytes: 100 }))
    const output = await ctx.tools.execute(exec)
    if (!behavior.getQuery) {
      assert.equal(calls.length, 0)
      assert.equal(records[0].reason, 'query-unavailable')
    } else if (behavior.noUsage) assert.equal(records[0].reason, 'missing-priced-usage')
    else assert.equal(output.isError, true)
    assert.equal(JSON.stringify(output.content).includes('LOSSY paragraph selection'), false)
  }
})

test('official runtime rejects stale selection after asynchronous query-changing decision observers', async t => {
  let task = 'Question Alpha'
  const { ctx, exec, calls } = await setup(t, { getQuery: () => task })
  ctx.on('free-context/decision', async () => { await Promise.resolve(); task = 'Question Beta' })
  await ctx.plugin(Experiments, options({ selectionMode: 'query-dependent', maxQueryBytes: 100 }))
  const output = await ctx.tools.execute(exec)
  assert.deepEqual(output.content, [{ type: 'text', text }])
  assert.equal(calls.length, 1)
})

const diagnosticText = ['src/main.ts(12,3): error TS2322: wrong type.\n  at src/caller.ts:8:2', ...Array.from({ length: 30 }, () => 'INFO: ' + 'Ordinary progress continues smoothly. '.repeat(15)), 'Status: failed; Errors: 1', 'Exit code: 2'].join('\n\n')
const selectRequired = request => JSON.stringify({ selectedIds: JSON.parse(request.messages[0].content[0].text.split('\n').at(-1)).requiredIds })
test('official diagnostic experiment preserves errors/status/locations and archives full provenance', async t => {
  const { ctx, exec, calls, records } = await setup(t, { text: diagnosticText, responseFor: selectRequired })
  const baseline = await ctx.tools.execute(exec)
  await ctx.plugin(Experiments, options({ selectionMode: 'diagnostic-evidence', maxCacheEntries: 2 }))
  const output = await ctx.tools.execute(exec)
  assert.deepEqual(output.value, baseline.value)
  assert.ok(output.content[0].text.includes('LOSSY diagnostic evidence selection'))
  for (const evidence of ['TS2322', 'src/caller.ts:8:2', 'Status: failed; Errors: 1', 'Exit code: 2']) assert.ok(output.content[0].text.includes(evidence))
  const refs = output.content[0].text.split('\n').filter(line => line.startsWith('Original tool-result snapshot: ')).map(line => JSON.parse(line.slice('Original tool-result snapshot: '.length)))
  assert.equal(await readFile(refs[0].locator, 'utf8'), diagnosticText)
  const manifest = JSON.parse(await readFile(refs[1].locator, 'utf8'))
  assert.equal(manifest.sourceHash, refs[0].sha256)
  assert.equal(manifest.selectedSpans[0].startLine, 1)
  assert.equal(manifest.selectedSpans[0].endLine, 2)
  assert.ok(manifest.selectedSpans[0].guards.codes.includes('TS2322'))
  assert.equal(manifest.callUsage.outputTokens, 10)
  await ctx.tools.execute(exec)
  assert.equal(calls.length, 1)
  assert.equal(records.at(-1).estimatedCost, 0)
})
test('official diagnostic experiment falls back for unknown formats, missing usage and cancellation', async t => {
  for (const extra of [{ text: diagnosticText + '\n\nunknown format' }, { noUsage: true }, { cancel: new AbortController() }]) {
    const behavior = { text: diagnosticText, responseFor: selectRequired, ...extra }
    const { ctx, exec, calls, records } = await setup(t, behavior)
    await ctx.plugin(Experiments, options({ selectionMode: 'diagnostic-evidence', maxCacheEntries: 2 }))
    const output = await ctx.tools.execute(exec)
    assert.equal(JSON.stringify(output.content).includes('LOSSY diagnostic evidence selection'), false)
    if (extra.text) assert.equal(calls.length, 0)
    else if (extra.noUsage) assert.equal(records[0].reason, 'missing-priced-usage')
    else assert.equal(output.isError, true)
  }
})
