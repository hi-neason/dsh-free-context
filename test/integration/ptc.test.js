import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import * as Plugin from '../../src/index.js'
import { decodeJsonRows } from '../../src/json-codec.js'

const runtime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
const load = name => import(pathToFileURL(runtime.resolve(`@deepseek-ai/${name}`)).href)
const { Context } = await load('cordis')
const { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } = await load('dsh-agent-loop-testkit')
const { defineTool } = await load('dsh-tools')
const { NodePtcRuntime } = await load('dsh-ptc-runtime-node')
const blocks = text => [{ type: 'text', text }]

test('official Node PTC bridge preserves internal values/logs and compresses only final run_code content', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-context-ptc-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, tools: { mode: 'ptc' } })
  for (const name of ['dsh-subprocess-local', 'dsh-sandbox-local']) {
    const module = await load(name)
    await ctx.plugin(module.default ?? module)
  }
  const { default: SandboxPolicy } = await load('dsh-sandbox-policy')
  await ctx.plugin(SandboxPolicy, { mode: 'read-only' })
  await ctx.plugin(NodePtcRuntime, { timeoutMs: 15000, maxTimeoutMs: 15000 })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create('ptc-compression', {}, { cwd: directory })
  const rows = Array.from({ length: 80 }, (_, i) => ({ record_identifier: `job-${i}`,
    deployment_environment: 'production', processing_status: 'ready', retry_count: i === 40 ? 7 : 0 }))
  const originalValue = { checkpoint: 'immutable', rows }
  const originalSnapshot = structuredClone(originalValue)
  const innerContent = blocks(JSON.stringify(rows))
  ctx.tools.register(defineTool({ name: 'fixture', description: 'Structured PTC fixture', parameters: {},
    output: { schema: { type: 'json' }, render: () => innerContent },
    execute: async () => originalValue,
  }))
  const records = []
  ctx.on('free-context/decision', record => records.push(record))
  const code = `const value = await tools.fixture({});
if (value.checkpoint !== 'immutable' || value.rows[40].retry_count !== 7) throw new Error('program value corrupted');
console.log(JSON.stringify(value.rows));`
  const run = callId => ctx.tools.execute({ name: 'run_code', callId,
    arguments: { code, description: 'Verify structured fields and print rows', timeoutMs: 15000 },
    agent, signal: new AbortController().signal })
  const baseline = await run('baseline')
  assert.equal(baseline.isError, false, JSON.stringify(baseline.content))
  assert.deepEqual(JSON.parse(baseline.content[0].text), rows)
  for (const mode of ['observe', 'apply']) {
    records.length = 0
    const fiber = await ctx.plugin(Plugin, { mode, tools: ['run_code'], minInputBytes: 0 })
    const output = await run(mode)
    assert.equal(output.isError, false, JSON.stringify(output.content))
    assert.deepEqual(output.value, baseline.value, 'canonical run_code logs/result remain untouched')
    assert.deepEqual(originalValue, originalSnapshot)
    const dispatch = agent.session.snapshotEvents().find(event => event.type === 'tool/ptc-dispatch' && event.data.rootCallId === mode)
    assert.ok(dispatch, 'the actual bridge persists the internal dispatch')
    assert.equal(dispatch.data.parentCallId, mode)
    assert.equal(dispatch.data.isError, false)
    assert.deepEqual(dispatch.data.content, innerContent, 'internal presentation log must remain original')
    assert.ok(records.some(record => record.tool === 'fixture' && record.reason === 'ptc-internal'))
    const final = records.find(record => record.tool === 'run_code')
    assert.equal(final.strategy, 'json-rows-v1')
    assert.ok(final.input.bytes > final.output.bytes)
    if (mode === 'observe') {
      assert.equal(final.outcome, 'observed')
      assert.deepEqual(output.content, baseline.content)
    } else {
      assert.equal(final.outcome, 'selected')
      assert.deepEqual(JSON.parse(decodeJsonRows(output.content[0].text)), rows)
      assert.ok(Buffer.byteLength(output.content[0].text) < Buffer.byteLength(baseline.content[0].text))
    }
    await fiber.dispose()
    records.length = 0
    assert.deepEqual((await run(`unloaded-${mode}`)).content, baseline.content)
    assert.deepEqual(records, [])
  }
})
