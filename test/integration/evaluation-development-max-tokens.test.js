import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDevelopmentProfile, parseDevelopmentLedger, readDevelopmentSessionRecords, reconcileDevelopmentLedger } from '../../scripts/evaluate-development.js'
import { materializeDevelopmentFixture, verifyDevelopmentWorkspace } from '../../scripts/development-fixtures.js'
import { runEvaluationProcess } from '../../scripts/evaluation-process.js'

const runtimeRoot = resolve(process.env.DSH_CLI_RUNTIME_ROOT ?? '.omx/cli-runtime')
test('official CLI counts complete truncated output while persisted turn still fails quality', { skip: process.platform === 'win32', timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-development-truncated-')), home = join(root, 'home')
  t.after(() => rm(root, { recursive: true, force: true }))
  const { directory: workspace } = await materializeDevelopmentFixture('json-output-limit', join(root, 'workspace'))
  await mkdir(join(home, 'profiles/headless'), { recursive: true })
  await writeFile(join(home, 'profiles/headless/package.json'), JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } } }))
  const replayProvider = join(root, 'truncated-provider.mjs')
  const original = await readFile(new URL('../../scripts/development-replay-provider.js', import.meta.url), 'utf8')
  const truncated = original.replace("? 'tool-calls' : 'stop'", "? 'tool-calls' : 'max-tokens'")
  assert.notEqual(truncated, original)
  await writeFile(replayProvider, truncated)
  const config = { replay: true, model: 'scripted', plugin: false, tools: ['bash', 'read', 'grep'], maxInlineTokens: 1200,
    workspace, sessions: join(home, 'sessions'), spill: join(root, 'spill'), ledger: join(root, 'ledger.jsonl'), replayProvider,
    controlSource: fileURLToPath(new URL('../fixtures/development/json-output-limit/control/json-codec.js', import.meta.url)),
    maxSteps: 12, maxCalls: 16, maxCostUSD: .05, runtimePackage: join(runtimeRoot, 'package.json'),
    testCommands: ['node --test test/json-codec.test.js', 'node --test --test-reporter=tap test/json-codec.test.js'], manifestHash: 'synthetic-max-tokens' }
  const observer = join(root, 'observer.json'), patch = join(root, 'patch.yml')
  await writeFile(config.ledger, '')
  await writeFile(observer, JSON.stringify(config))
  await writeFile(patch, buildDevelopmentProfile(config))
  const execution = await runEvaluationProcess(process.execPath, [join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'headless', '--patch', patch, '--json', 'Repair the historical fixture and run its tests.'], {
    cwd: workspace, timeoutMs: 30000, shutdownGraceMs: 6000, maxOutputBytes: 2 * 1024 * 1024,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1', DSH_DEVELOPMENT_CONFIG: observer } })
  const ledger = parseDevelopmentLedger(await readFile(config.ledger, 'utf8'))
  assert.deepEqual(ledger.errors, [])
  const terminal = ledger.events.filter(event => event.type === 'model/end').at(-1)
  assert.equal(terminal.finish, 'max-tokens')
  assert.equal(terminal.complete, true)
  const accounting = reconcileDevelopmentLedger(ledger.events, { replay: true, model: 'scripted', manifestHash: config.manifestHash })
  assert.equal(accounting.usageComplete, true)
  assert.equal(accounting.modelCalls.length, 5)
  assert.equal(accounting.usage.inputTokens, 50)
  assert.equal(accounting.usage.outputTokens, 25)
  const cli = execution.stdout.trim().split('\n').map(JSON.parse)
  const persisted = await readDevelopmentSessionRecords(config.sessions, cli.find(event => event.type === 'session').sessionId)
  const turns = persisted.filter(event => event.type === 'turn/end')
  assert.ok(turns.length > 0)
  assert.equal(turns.every(event => event.data.reason.kind === 'completed'), false)
  assert.equal(execution.cleaned, true)
  const verification = await verifyDevelopmentWorkspace('json-output-limit', workspace)
  assert.equal(verification.passed, true) // Even a valid repair cannot excuse a truncated turn.
})
