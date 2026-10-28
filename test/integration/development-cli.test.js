import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runDevelopmentTask, buildDevelopmentProfile } from '../../scripts/evaluate-development.js'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runEvaluationProcess } from '../../scripts/evaluation-process.js'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const runtimeRoot = resolve(process.env.DSH_CLI_RUNTIME_ROOT ?? '.omx/cli-runtime')

test('actual official CLI repairs the historical fixture in all three scripted groups with external verification', { skip: process.platform === 'win32', timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coding-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const group of ['baseline-default', 'baseline-tuned', 'plugin']) {
    const directory = join(root, group)
    const result = await runDevelopmentTask('json-output-limit', group, { directory, runtimeRoot })
    assert.equal(result.passed, true, JSON.stringify({ group, verification: result.verification, cli: result.cli, steps: result.steps, persistence: result.persistenceComplete }))
    assert.equal(result.replayComplete, true)
    assert.equal(result.verification.testRun.passedTests, 9)
    assert.equal(result.modelCalls.length, 5)
    assert.equal(result.steps, 5)
    assert.equal(result.reproduced, true)
    assert.equal(result.retested, true)
    assert.equal(result.workflowOrdered, true)
    assert.equal(result.structuredValuesPreserved, true)
    assert.equal(result.persistenceComplete, true)
    assert.equal(result.costComplete, false)
    assert.equal(result.estimatedCostUSD, null)
    assert.equal(result.plan.configuration.maxInlineTokens, group === 'baseline-default' ? 12500 : 1200)
    assert.ok(result.tools.every(tool => tool.modelVisible))
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')), result)
  }
})

test('actual CLI model step cap leaves an unsuccessful task and its counted synthetic calls', { skip: process.platform === 'win32', timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coding-cap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = await runDevelopmentTask('json-output-limit', 'plugin', { directory: join(root, 'run'), runtimeRoot, maxSteps: 1 })
  assert.equal(result.passed, false)
  assert.equal(result.replayComplete, false)
  assert.equal(result.cli.cleaned, true)
  assert.equal(result.verification.passed, false)
  assert.equal(result.modelCalls.length, 1)
  assert.ok(result.limits.some(limit => limit.reason === 'max-steps'))
})

test('failed live plan checkpoint prevents spawning a model process and does not persist credentials', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coding-checkpoint-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'run')
  const key = 'private-test-sentinel-never-sent'
  const pricing = { currency: 'USD', model: 'model', sourceUrl: 'https://example.test/pricing', verifiedDate: '2026-10-28', ratePeriod: 'test', uncached: 1, cacheRead: .1, output: 2 }
  await assert.rejects(runDevelopmentTask('json-output-limit', 'plugin', { directory, runtimeRoot, replay: false, key, pricing,
    onPlan(plan) { assert.equal(JSON.stringify(plan).includes(key), false); assert.equal(Object.isFrozen(plan.configuration), true); throw new Error('checkpoint unavailable') }, onResult() {} }), /checkpoint unavailable/)
  await assert.rejects(readFile(join(directory, 'ledger.jsonl')), error => error.code === 'ENOENT')
  assert.equal((await readFile(join(directory, 'plan.json'), 'utf8')).includes(key), false)
})


test('external ancestor instructions cannot alter the controlled coding task', { skip: process.platform === 'win32', timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coding-ancestor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.git'))
  const marker = 'EXTERNAL_INSTRUCTION_MUST_NOT_ENTER_CODING_CONTEXT_20261028'
  await writeFile(join(root, 'AGENTS.md'), marker)
  const directory = join(root, 'run')
  const result = await runDevelopmentTask('json-output-limit', 'plugin', { directory, runtimeRoot })
  assert.equal(result.replayComplete, true)
  const files = (await readdir(join(directory, 'home/sessions'), { recursive: true })).filter(path => path.endsWith('.jsonl'))
  for (const file of files) assert.equal((await readFile(join(directory, 'home/sessions', file), 'utf8')).includes(marker), false)
})

test('a damaged billing journal preserves known synthetic calls and explicitly fails audit', { skip: process.platform === 'win32', timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coding-ledger-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'run')
  let inserted = false, injecting = Promise.resolve()
  const timer = setInterval(async () => {
    if (inserted) return
    try {
      const text = await readFile(join(directory, 'ledger.jsonl'), 'utf8')
      if (!inserted && text.includes('model/end')) { inserted = true; injecting = appendFile(join(directory, 'ledger.jsonl'), 'invalid-journal-record\n'); await injecting }
    } catch {}
  }, 1)
  let result
  try { result = await runDevelopmentTask('json-output-limit', 'plugin', { directory, runtimeRoot }) }
  finally { clearInterval(timer); await injecting }
  assert.equal(inserted, true)
  assert.equal(result.passed, false)
  assert.equal(result.modelCalls.length, 5)
  assert.equal(result.modelEnds.length, 5)
  assert.equal(result.usage.inputTokens, 50)
  assert.equal(result.usageComplete, false)
  assert.ok(result.auditErrors.some(error => error.reason === 'invalid-ledger-record'))
})

test('final observer hashes match compression, downstream native spill, durable results and model inputs', { skip: process.platform === 'win32', timeout: 90000 }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-coding-transform-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  for (const maxInlineTokens of [1200, 128]) {
    const root = join(base, String(maxInlineTokens)), home = join(root, 'home')
    await mkdir(join(home, 'profiles/headless'), { recursive: true })
    await writeFile(join(home, 'profiles/headless/package.json'), JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } } }))
    const config = { replay: true, model: 'scripted', plugin: true, tools: ['cli_fixture'], maxInlineTokens, workspace: root, sessions: join(home, 'sessions'), spill: join(root, 'spill'), ledger: join(root, 'ledger.jsonl'),
      replayProvider: fileURLToPath(new URL('../fixtures/development-transform-provider.js', import.meta.url)), maxSteps: 4, maxCalls: 4, maxCostUSD: 1, runtimePackage: join(runtimeRoot, 'package.json'), testCommands: [], manifestHash: `synthetic-conversion-${maxInlineTokens}` }
    await writeFile(config.ledger, '')
    const observer = join(root, 'observer.json'), patch = join(root, 'patch.yml')
    await writeFile(observer, JSON.stringify(config)); await writeFile(patch, buildDevelopmentProfile(config))
    const child = await runEvaluationProcess(process.execPath, [join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'headless', '--patch', patch, '--json', 'Call cli_fixture, then acknowledge its output.'], { cwd: root, timeoutMs: 30000,
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1', DSH_DEVELOPMENT_CONFIG: observer, DSH_CLI_RUNTIME_PACKAGE: join(runtimeRoot, 'package.json') } })
    assert.equal(child.exitCode, 0)
    const ledger = (await readFile(config.ledger, 'utf8')).trim().split('\n').map(JSON.parse)
    const tool = ledger.find(event => event.type === 'tool')
    assert.ok(ledger.some(event => event.type === 'decision' && event.outcome === 'selected'))
    assert.notEqual(tool.contentHash, tool.valueHash)
    assert.equal(tool.valueHash, tool.finalValueHash)
    assert.ok(ledger.some(event => event.type === 'model/start' && event.visibleToolResults.some(value => value.callId === tool.callId && value.contentHash === tool.contentHash)))
    const files = (await readdir(config.sessions, { recursive: true })).filter(path => path.endsWith('.jsonl'))
    const rows = (await Promise.all(files.map(path => readFile(join(config.sessions, path), 'utf8')))).flatMap(text => text.trim().split('\n').map(JSON.parse))
    const persisted = rows.find(event => event.type === 'tool/result')
    assert.equal(hash(persisted.data.message.content), tool.contentHash)
    if (maxInlineTokens === 1200) assert.equal(JSON.parse(persisted.data.message.content[0].text).format, 'dsh-json-rows')
    else assert.ok((await readdir(config.spill, { recursive: true })).length > 0)
  }
})
