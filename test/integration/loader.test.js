import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const requireRuntime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
const modulePath = name => requireRuntime.resolve(name)
const load = name => import(pathToFileURL(modulePath(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
// Cordis 4.0.5 publishes FiberState as a TypeScript const enum, erased from JS.
const FiberState = { ACTIVE: 2, FAILED: 3, DISPOSED: 4 }
const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader')
const pluginPath = fileURLToPath(new URL('../../src/index.js', import.meta.url))
const blocks = [{ type: 'text', text: 'original' }]
const execute = ctx => ctx.tools.execute({
  name: 'fixture', callId: 'yaml-fixture', arguments: {}, signal: new AbortController().signal,
})

async function boot(t, mode) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-free-context-loader-'))
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const fixture = join(directory, 'fixture.mjs')
  await writeFile(fixture, `
import { defineContentToolFixture } from ${JSON.stringify(pathToFileURL(modulePath('@deepseek-ai/dsh-tools')).href)}
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register(defineContentToolFixture({
    name: 'fixture', description: 'YAML loader fixture', parameters: {},
    execute: async () => ${JSON.stringify(blocks)},
  }))
}
`)
  const yaml = join(directory, 'runtime.yaml')
  await writeFile(yaml, [
    '- id: system-prompt',
    `  name: ${JSON.stringify(modulePath('@deepseek-ai/dsh-system-prompt'))}`,
    '- id: tools',
    `  name: ${JSON.stringify(modulePath('@deepseek-ai/dsh-tools'))}`,
    '- id: fixture',
    `  name: ${JSON.stringify(fixture)}`,
    '- id: free-context',
    `  name: ${JSON.stringify(pluginPath)}`,
    '  config:',
    `    mode: ${JSON.stringify(mode)}`,
    '    tools: [fixture]',
    '    minInputBytes: 0',
    '',
  ].join('\n'))
  const decisions = []
  ctx.on('free-context/decision', record => { decisions.push(record) })
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(directory + '/').href })
  await ctx.loader.create({
    id: 'configuration',
    name: modulePath('@deepseek-ai/cordis-plugin-include'),
    config: { path: './runtime.yaml' },
  })
  await ctx.loader.await()
  for (const id of ['configuration', 'configuration:system-prompt', 'configuration:tools', 'configuration:fixture']) {
    assert.equal(ctx.loader.resolve(id).fiber.state, FiberState.ACTIVE, id)
  }
  return { ctx, decisions, entry: ctx.loader.resolve('configuration:free-context') }
}

test('official YAML loader activates observe mode and unloads its policy', async t => {
  const { ctx, decisions, entry } = await boot(t, 'observe')
  assert.equal(entry.options.name, pluginPath)
  assert.equal(entry.fiber.state, FiberState.ACTIVE)
  assert.equal(entry.fiber.config.mode, 'observe')
  const baseline = await execute(ctx)
  assert.equal(baseline.isError, false)
  assert.deepEqual(baseline.content, blocks)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].mode, 'observe')

  // Remove using the owning Include tree's local id.
  entry.parent.tree.remove(entry.options.id)
  await entry.fiber.await()
  assert.equal(entry.fiber.state, FiberState.DISPOSED)
  assert.throws(() => ctx.loader.resolve(entry.id), /cannot resolve entry/)
  assert.deepEqual(await execute(ctx), baseline)
  assert.equal(decisions.length, 1, 'unloading must remove the diagnostic policy')
})

test('official YAML loader accepts off mode without registering a policy', async t => {
  const { ctx, decisions, entry } = await boot(t, 'off')
  assert.equal(entry.fiber.state, FiberState.ACTIVE)
  assert.equal(entry.fiber.config.mode, 'off')
  const output = await execute(ctx)
  assert.equal(output.isError, false)
  assert.deepEqual(output.content, blocks)
  assert.deepEqual(decisions, [])
})

test('official YAML loader exposes invalid plugin configuration as failed', async t => {
  const { ctx, decisions, entry } = await boot(t, 'invalid-mode')
  assert.equal(entry.fiber.state, FiberState.FAILED)
  await assert.rejects(entry.fiber.await(), /mode/)
  const output = await execute(ctx)
  assert.equal(output.isError, false)
  assert.deepEqual(output.content, blocks)
  assert.deepEqual(decisions, [])
})
