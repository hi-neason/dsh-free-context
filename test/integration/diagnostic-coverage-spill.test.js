import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import * as experiments from '../../src/experiments.js'

const runtime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
const load = name => import(pathToFileURL(runtime.resolve(`@deepseek-ai/${name}`)).href)
const { Context } = await load('cordis')
const { LlmAdapter, createUserMessage } = await load('dsh-llm')
const { defineContentToolFixture } = await load('dsh-tools')
const { default: SpillLocal } = await load('dsh-spill-local')
const SpillPolicy = await load('dsh-spill-policy')
const { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } = await load('dsh-agent-loop-testkit')

// Synthetic composition stress, not a model-quality or savings benchmark.
for (const [count, cap] of [[30, 2500], [250, 3000]]) test(`official spill ${cap} preserves stage-qualified coverage while omitting some of ${count} headers`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-coverage-spill-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(SpillLocal, { root: join(directory, 'spill'), cleanupPeriodDays: 0 })
  const text = ['INFO: ' + 'ordinary build progress '.repeat(2500), ...Array.from({ length: count }, (_, index) => `src/file${index}.ts:1:2: error TS2322: ${'invalid assignment for this compilation unit '.repeat(count === 30 ? 4 : 1)}`), 'Status: failed\nexit code: 1'].join('\n\n')
  ctx.tools.register(defineContentToolFixture({ name: 'fixture', description: 'diagnostic stress source', parameters: {}, execute: async () => [{ type: 'text', text }] }))
  let visible
  let selected = false
  ctx.on('free-context/experiment', record => { if (record.reason === 'selected') selected = true })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      let block
      if (request.model === 'selector') {
        const payload = JSON.parse(request.messages[0].content[0].text.split('\n').at(-1))
        block = { type: 'text', text: JSON.stringify({ selectedIds: payload.requiredIds }) }
      } else {
        const toolResult = request.messages.find(message => message.role === 'tool')
        if (toolResult) {
          visible = toolResult.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
          block = { type: 'text', text: 'observed' }
        } else block = { type: 'tool-call', id: 'fixture-1', name: 'fixture', arguments: '{}' }
      }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['coverage-replay'], new Adapter())
  await ctx.plugin(experiments, { admission: 'measured-trial', mode: 'apply', tools: ['fixture'], selectionMode: 'diagnostic-evidence', provider: 'coverage-replay', model: 'selector',
    maxInputBytes: 200000, maxPromptBytes: 300000, maxOutputBytes: 10000, maxOutputTokens: 4000, maxArtifactBytes: 400000, timeoutMs: 10000, maxParagraphs: 1000,
    maxCalls: 1, maxTotalCost: 1, maxCallCost: 1, pricing: { currency: 'USD', uncachedInputPerMillion: 1, cacheReadPerMillion: 1, cacheWritePerMillion: 1, outputPerMillion: 1 } })
  // Public plugin-first/native-second composition, without patching core order.
  await ctx.plugin(SpillPolicy, { maxInlineTokens: cap })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create('coverage-agent', { provider: 'coverage-replay', model: 'agent' }, { cwd: directory })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Call fixture.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  assert.equal(selected, true)
  assert.match(visible, /Full formatted result stored at/)
  const headersVisible = [...visible.matchAll(/src\/file\d+\.ts:1:2: error TS2322:/g)].length
  assert.ok(headersVisible > 0 && headersVisible < count, `expected a proper preview subset, received ${headersVisible}`)
  assert.ok(visible.includes(`"compilerHeaders":${count}`))
  assert.match(visible, /"stage":"validated-selection-before-downstream-retention"/)
  assert.match(visible, /NOT final inline coverage/)
  assert.match(visible, /recover the full spilled tool output/)
  assert.match(visible, /original snapshot for source-completeness checks/)
})
