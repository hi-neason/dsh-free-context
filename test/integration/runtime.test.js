import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as plugin from '../../src/index.js'
import { createPostExecuteHandler } from '../../src/pipeline.js'

// Runtime packages live in a separate test installation, never product dependencies.
const requireRuntime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: ToolRuntime, defineContentToolFixture } = await load('@deepseek-ai/dsh-tools')
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader')
const blocks = text => [{ type: 'text', text }]
const exec = () => ({ name: 'fixture', callId: 'call-fixture', arguments: {}, signal: new AbortController().signal })

test('official runtime loads named exports, composes real tool policies, and disposes listeners', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(defineContentToolFixture({
    name: 'fixture', description: 'fixture', parameters: {},
    execute: async () => blocks('original'),
  }))
  const loader = Object.create(Loader.prototype)
  assert.equal(loader.unwrapExports(plugin), plugin)
  const baseline = await ctx.tools.execute(exec())
  assert.equal(baseline.isError, false)
  const production = await ctx.plugin(loader.unwrapExports(plugin), { tools: ['fixture'] })
  assert.deepEqual(await ctx.tools.execute(exec()), baseline)

  const events = []
  const downstream = await ctx.plugin({
    name: 'fixture-downstream',
    apply(scope) {
      scope.on('tools/post-execute', async (_exec, _result, next) => {
        const decision = await next()
        events.push('downstream')
        return { ...decision, content: blocks('downstream') }
      })
    },
  })
  const transformer = await ctx.plugin({
    name: 'fixture-transformer',
    apply(scope) {
      scope.on('tools/post-execute', createPostExecuteHandler(content => {
        events.push('transform')
        assert.deepEqual(content, blocks('downstream'))
        return { content: blocks('transformed'), strategy: 'fixture' }
      }, undefined, { mode: 'apply' }), { prepend: true })
    },
  })
  const transformed = await ctx.tools.execute(exec())
  assert.equal(transformed.isError, false)
  assert.deepEqual(transformed.content, blocks('transformed'))
  assert.deepEqual(transformed.value, baseline.value)
  assert.deepEqual(events, ['downstream', 'transform'])
  await transformer.dispose()
  assert.deepEqual((await ctx.tools.execute(exec())).content, blocks('downstream'))
  await downstream.dispose()
  await production.dispose()
  assert.deepEqual(await ctx.tools.execute(exec()), baseline)
})


test('official runtime validates plugin config, freezes normalized values, and accepts off mode', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await assert.rejects(async () => { await ctx.plugin(plugin, { mode: 'apply', tools: ['fixture', 'fixture'] }) }, /duplicate/)
  const fiber = await ctx.plugin(plugin, { mode: 'off', tools: ['fixture'] })
  assert.equal(fiber.config.mode, 'off')
  assert.equal(fiber.config.logs.enabled, false)
  assert.equal(Object.isFrozen(fiber.config), true)
  assert.equal(Object.isFrozen(fiber.config.tools), true)
  await fiber.dispose()
})

test('official runtime diagnostic subscriptions isolate rejected observers in observe and apply modes', async t => {
  for (const mode of ['observe', 'apply']) {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(defineContentToolFixture({ name: 'fixture', description: 'fixture', parameters: {}, execute: async () => blocks('original') }))
    const records = []
    ctx.on('free-context/decision', record => { records.push(record) })
    ctx.on('free-context/decision', async () => { throw new Error('private observer error') })
    await ctx.plugin(plugin, { mode, tools: ['fixture'], minInputBytes: 0 })
    const output = await ctx.tools.execute(exec())
    assert.equal(output.isError, false)
    assert.deepEqual(output.content, blocks('original'))
    assert.equal(records.length, 1)
    assert.equal(records[0].mode, mode)
    assert.equal(records[0].reason, 'no-strategy')
  }
})
