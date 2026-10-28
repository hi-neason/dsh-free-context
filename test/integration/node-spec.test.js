import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as FreeContext from '../../src/index.js'
import { verifySnapshot } from '../../src/recovery.js'

const runtime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
const load = name => import(pathToFileURL(runtime.resolve(`@deepseek-ai/${name}`)).href)
const { Context } = await load('cordis')
const { default: SystemPrompt } = await load('dsh-system-prompt')
const { default: Tools, defineContentToolFixture } = await load('dsh-tools')
const { default: SpillLocal } = await load('dsh-spill-local')
const SpillPolicy = await load('dsh-spill-policy')
const execute = promisify(execFile)

test('actual Node spec report is reduced through official tools and native spill with exact original snapshot', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-node-spec-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  const environment = { ...process.env, NO_COLOR: '1' }
  delete environment.FORCE_COLOR
  delete environment.NODE_TEST_CONTEXT
  const { stdout, stderr } = await execute(process.execPath, ['--test', '--test-reporter=spec',
    'test/config.test.js', 'test/json-codec.test.js', 'test/selector-prompt.test.js'],
  { cwd: fileURLToPath(new URL('../..', import.meta.url)), timeout: 10000, maxBuffer: 1024 * 1024, env: environment })
  assert.equal(stderr, '')
  assert.match(stdout, /ℹ fail 0/)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(SpillLocal, { root: join(directory, 'spill'), cleanupPeriodDays: 0 })
  const original = [{ type: 'text', text: stdout }]
  ctx.tools.register(defineContentToolFixture({ name: 'node-tests', description: 'Actual Node unit suite output', parameters: {}, execute: async () => original }))
  await ctx.plugin(FreeContext, { mode: 'apply', tools: ['node-tests'], minInputBytes: 0, json: { enabled: false }, logs: { enabled: true } })
  await ctx.plugin(SpillPolicy, { maxInlineTokens: 1200 })
  const result = await ctx.tools.execute({ name: 'node-tests', callId: 'actual-node-spec', arguments: {}, signal: new AbortController().signal,
    agent: { session: { header: { id: 'node-spec-integration' } } } })
  assert.equal(result.isError, false)
  assert.deepEqual(result.value, original)
  const preview = result.content[0].text
  assert.match(preview, /LOSSY Node spec/)
  assert.match(preview, /ℹ fail 0/)
  assert.doesNotMatch(preview, /Full formatted result stored at/)
  assert.ok(Buffer.byteLength(preview) < Buffer.byteLength(stdout))
  const receipt = JSON.parse(preview.match(/Original tool-result snapshot: (\{[^\n]+\})/)[1])
  const saved = await readFile(receipt.locator)
  assert.equal(saved.toString('utf8'), stdout)
  verifySnapshot(receipt, saved)
})
