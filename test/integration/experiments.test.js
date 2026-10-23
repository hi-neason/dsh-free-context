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
  if (!behavior.noStore) await ctx.plugin(SpillLocal, { root, cleanupPeriodDays: 0 })
  const calls = []
  class Adapter extends LlmAdapter {
    async * stream(request) {
      calls.push(request)
      if (behavior.cancel) behavior.cancel.abort()
      const response = '{"selectedIds":["p1"]}'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: response }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
      if (!behavior.noUsage) yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['selection-fixture'], new Adapter())
  ctx.tools.register(defineContentToolFixture({ name: 'prose', description: 'prose', parameters: {}, execute: async () => [{ type: 'text', text }] }))
  const records = []
  ctx.on('free-context/experiment', record => { records.push(record) })
  const exec = { name: 'prose', callId: 'prose-call', arguments: {}, agent: { session: { header: { id: 'experiment-session' } } }, signal: behavior.cancel?.signal ?? new AbortController().signal }
  return { ctx, calls, records, exec }
}

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
