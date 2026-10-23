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

const jsonRows = Array.from({ length: 40 }, (_, i) => ({ very_long_identifier: i, repeated_description_field: `value-${i}`, repeated_state_field: 'ok' }))
const jsonText = JSON.stringify(jsonRows)

test('production router compares baseline, observe and apply on real tools while preserving value and downstream contexts', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(defineContentToolFixture({ name: 'fixture', description: 'fixture', parameters: {}, execute: async () => blocks('tool original') }))
  const contexts = [{ role: 'user', content: blocks('additional evidence') }]
  ctx.on('tools/post-execute', async (_exec, _result, next) => ({ ...await next(), content: blocks(jsonText), additionalContexts: contexts }))
  const baseline = await ctx.tools.execute(exec())
  const records = []
  ctx.on('free-context/decision', record => { records.push(record) })
  const observe = await ctx.plugin(plugin, { mode: 'observe', tools: ['fixture'], minInputBytes: 0 })
  assert.deepEqual(await ctx.tools.execute(exec()), baseline)
  assert.equal(records.at(-1).outcome, 'observed')
  assert.equal(records.at(-1).strategy, 'json-rows-v1')
  await observe.dispose()
  const apply = await ctx.plugin(plugin, { mode: 'apply', tools: ['fixture'], minInputBytes: 0 })
  const transformed = await ctx.tools.execute(exec())
  assert.equal(transformed.isError, false)
  assert.equal(JSON.parse(transformed.content[0].text).format, 'dsh-json-rows')
  assert.deepEqual(transformed.value, baseline.value)
  assert.deepEqual(transformed.additionalContexts, baseline.additionalContexts)
  assert.equal(records.at(-1).outcome, 'selected')
  await apply.dispose()
  assert.deepEqual(await ctx.tools.execute(exec()), baseline)
})

test('real runtime preserves results for unlisted tools, excessive savings threshold, PTC, failure and value decisions', async t => {
  for (const scenario of ['unlisted', 'threshold', 'ptc', 'failure', 'value']) {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(defineContentToolFixture({ name: 'fixture', description: 'fixture', parameters: {}, execute: async () => {
      if (scenario === 'failure') throw new Error('fixture failure')
      return blocks(jsonText)
    } }))
    if (scenario === 'value') ctx.on('tools/post-execute', async (_exec, _result, next) => ({ ...await next(), value: blocks('replacement value') }))
    const execution = scenario === 'ptc' ? { ...exec(), parent: 'parent-call' } : exec()
    const baseline = await ctx.tools.execute(execution)
    const records = []
    ctx.on('free-context/decision', record => { records.push(record) })
    await ctx.plugin(plugin, { mode: 'apply', tools: [scenario === 'unlisted' ? 'other' : 'fixture'], minInputBytes: 0, minSavingsTokens: scenario === 'threshold' ? 1000000 : 32 })
    assert.deepEqual(await ctx.tools.execute(execution), baseline)
    assert.equal(records.at(-1).reason, { unlisted: 'ineligible', threshold: 'no-strategy', ptc: 'ptc-internal', failure: 'tool-failure', value: 'value-replacement' }[scenario])
  }
})

test('real runtime cancellation after candidate selection does not return compressed content', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(defineContentToolFixture({ name: 'fixture', description: 'fixture', parameters: {}, execute: async () => blocks(jsonText) }))
  const controller = new AbortController()
  const records = []
  ctx.on('free-context/decision', async record => {
    records.push(record)
    await Promise.resolve()
    controller.abort()
  })
  await ctx.plugin(plugin, { mode: 'apply', tools: ['fixture'], minInputBytes: 0 })
  const output = await ctx.tools.execute({ ...exec(), signal: controller.signal })
  assert.equal(records[0].outcome, 'selected')
  assert.equal(output.isError, true)
  assert.equal(JSON.stringify(output.content).includes('dsh-json-rows'), false)
})

function tapLog() {
  const count = 100
  return ['TAP version 13', ...Array.from({ length: count }, (_, i) => `# Subtest: log ${i + 1}\nok ${i + 1} - log ${i + 1}\n  ---\n  duration_ms: 1.25\n  type: 'test'\n  ...`), `1..${count}`, `# tests ${count}`, '# suites 0', `# pass ${count}`, '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 100.5', ''].join('\n')
}

test('production TAP observe and apply archive exact originals through official spill-local; value stays unchanged', async t => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { default: SpillLocal } = await load('@deepseek-ai/dsh-spill-local')
  const directory = await mkdtemp(join(tmpdir(), 'free-context-tap-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const mode of ['observe', 'apply']) {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SpillLocal, { root: join(directory, mode), cleanupPeriodDays: 0 })
    const original = tapLog()
    ctx.tools.register(defineContentToolFixture({ name: 'fixture', description: 'fixture', parameters: {}, execute: async () => blocks(original) }))
    const records = []
    ctx.on('free-context/decision', record => { records.push(record) })
    await ctx.plugin(plugin, { mode, tools: ['fixture'], minInputBytes: 0, logs: { enabled: true } })
    const output = await ctx.tools.execute({ ...exec(), agent: { session: { header: { id: 'tap-integration' } } } })
    assert.equal(output.isError, false)
    assert.deepEqual(output.value, blocks(original))
    assert.equal(records[0].strategy, 'node-tap-v13')
    assert.equal(records[0].lossy, true)
    if (mode === 'observe') {
      assert.deepEqual(output.content, blocks(original))
      assert.equal(records[0].outcome, 'observed')
    } else {
      assert.ok(output.content[0].text.includes('LOSSY'))
      const reference = output.content[0].text.split('\n').find(line => line.startsWith('Original tool-result snapshot: '))
      const receipt = JSON.parse(reference.slice('Original tool-result snapshot: '.length))
      assert.equal(await readFile(receipt.locator, 'utf8'), original)
      assert.equal(records[0].outcome, 'selected')
    }
  }
})

test('production TAP missing owner/store and real storage failures retain original content', async t => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { default: SpillLocal } = await load('@deepseek-ai/dsh-spill-local')
  const directory = await mkdtemp(join(tmpdir(), 'free-context-tap-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'bad-root'), 'regular file')
  for (const scenario of ['owner', 'store', 'failure']) {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    if (scenario !== 'store') await ctx.plugin(SpillLocal, { root: join(directory, scenario === 'failure' ? 'bad-root' : 'good-root'), cleanupPeriodDays: 0 })
    const original = tapLog()
    ctx.tools.register(defineContentToolFixture({ name: 'fixture', description: 'fixture', parameters: {}, execute: async () => blocks(original) }))
    const records = []
    ctx.on('free-context/decision', record => { records.push(record) })
    await ctx.plugin(plugin, { mode: 'apply', tools: ['fixture'], minInputBytes: 0, logs: { enabled: true } })
    const execution = scenario === 'owner' ? exec() : { ...exec(), agent: { session: { header: { id: 'tap-failure' } } } }
    const output = await ctx.tools.execute(execution)
    assert.equal(output.isError, false)
    assert.deepEqual(output.content, blocks(original))
    assert.equal(records[0].outcome, 'fallback')
  }
})
