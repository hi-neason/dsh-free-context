import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import * as plugin from '../../src/index.js'
import { decodeJsonRows, encodeJsonRows } from '../../src/json-codec.js'

const runtime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
const load = name => import(pathToFileURL(runtime.resolve(`@deepseek-ai/${name}`)).href)
const { Context } = await load('cordis')
const { default: SystemPrompt } = await load('dsh-system-prompt')
const { default: Tools, defineContentToolFixture } = await load('dsh-tools')
const { default: SpillLocal } = await load('dsh-spill-local')
const SpillPolicy = await load('dsh-spill-policy')
const { estimateContent } = await load('dsh-token-meter/estimate')
const budget = 1200
const blocks = text => [{ type: 'text', text }]
const rows = Array.from({ length: 70 }, (_, i) => ({
  long_repeated_record_identifier: i,
  long_repeated_processing_status: 'ok',
  long_repeated_deployment_environment: 'prod',
  long_repeated_retry_count: 0,
}))
const originalJson = JSON.stringify(rows)
const unknownText = Array.from({ length: 700 }, (_, i) => `unstructured observation ${i}: arbitrary prose without a supported diagnostic format`).join('\n')
async function files(root) {
  try { return (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

for (const order of ['native-first', 'plugin-first']) {
  for (const kind of ['json', 'unknown']) {
    test(`official spill 1200 composition ${order}: ${kind}`, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'free-context-spill-composition-'))
      const root = join(directory, 'spill')
      const ctx = new Context()
      t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(Tools)
      await ctx.plugin(SpillLocal, { root, cleanupPeriodDays: 0 })
      const original = blocks(kind === 'json' ? originalJson : unknownText)
      assert.ok(estimateContent(original) > budget, 'original must exceed the real native estimate budget')
      if (kind === 'json') assert.ok(estimateContent(blocks(encodeJsonRows(originalJson))) < budget, 'compact JSON must fit the same native budget')
      let calls = 0
      ctx.tools.register(defineContentToolFixture({ name: 'fixture', description: 'composition data', parameters: {}, execute: async () => { calls++; return original } }))
      const decisions = []
      ctx.on('free-context/decision', event => { decisions.push(event) })
      const mountNative = () => ctx.plugin(SpillPolicy, { maxInlineTokens: budget })
      const mountPlugin = () => ctx.plugin(plugin, { mode: 'apply', tools: ['fixture'], minInputBytes: 0 })
      for (const mount of order === 'native-first' ? [mountNative, mountPlugin] : [mountPlugin, mountNative]) await mount()
      const output = await ctx.tools.execute({ name: 'fixture', callId: 'composition-fixture', arguments: {}, signal: new AbortController().signal,
        agent: { session: { header: { id: `composition-${order}-${kind}` } } } })
      assert.equal(output.isError, false)
      assert.deepEqual(output.value, original, 'structured value must remain exact')
      assert.equal(calls, 1)
      assert.ok(estimateContent(output.content) <= budget, 'final content must respect native retention budget')
      const text = output.content.map(block => block.text).join('')
      // Prepending native middleware must wrap the plugin so it bounds the
      // compressed result. Native-first is safe but may prune before routing.
      if (kind === 'json' && order === 'plugin-first') {
        assert.equal((await files(root)).length, 0, 'fitting reversible encoding must avoid a native snapshot and subsequent recovery requirement')
        assert.equal(JSON.parse(text).format, 'dsh-json-rows')
        assert.deepEqual(JSON.parse(decodeJsonRows(text)), rows)
        assert.equal(decisions.at(-1).outcome, 'selected')
        assert.doesNotMatch(text, /Full formatted result stored at|Original tool-result snapshot/)
      } else {
        assert.match(text, /Full formatted result stored at/)
        assert.ok((await files(root)).length > 0, 'native fallback must persist its original')
        assert.notEqual(decisions.at(-1).outcome, 'selected')
      }
    })
  }
}
