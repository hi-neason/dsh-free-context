import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir, copyFile, symlink, appendFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { evaluateAcceptanceBundleV4 } from '../../scripts/evaluate-acceptance-bundle-v4.js'
import { summarizeAcceptanceBundleV4 } from '../../scripts/acceptance-bundle-v4.js'

const agentRuntimeRoot = resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime')
const cliRuntimeRoot = resolve(process.env.DSH_CLI_RUNTIME_ROOT ?? '.omx/cli-runtime')
const options = { bundleId: 'integration-bundle-v4', agentRuntimeRoot, cliRuntimeRoot, maxTotalCostUSD: 1, maxTotalCalls: 1992, knownPriorSpendUSD: .979656936, priorUnpricedCalls: 1 }
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const journal = async root => (await readFile(join(root, 'bundle-journal.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bundle-v4-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('full 138-slot official AgentLoop and real CLI replay journals immutable source/runtime evidence', { timeout: 180000 }, async t => {
  const root = join(await directory(t), 'bundle')
  let results = 0
  const report = await evaluateAcceptanceBundleV4({ ...options, rootDir: root,
    async onPlan(plan) {
      assert.deepEqual(await readJson(join(root, 'bundle-plan.json')), plan)
      assert.ok(Object.isFrozen(plan.inputs.runtimes.agent))
      assert.equal(plan.benchmarkPlan.readText, true)
      assert.equal(plan.developmentPlan.readText, true)
    },
    async onResult(row, slot, plan) {
      results++
      const configuration = slot.kind === 'development' ? row.taskPlan.configuration : row.configuration
      assert.deepEqual(configuration.readText, { enabled: slot.group === 'plugin', classifier: 'filesystem-host-v1', minimumSavingsRatio: 0.5 })
      if (slot.kind !== 'development' && slot.group === 'plugin') {
        assert.equal(row.readClassification.artifactInventoryComplete, true)
        assert.equal(row.readClassification.artifactRoots[0], join(row.readClassification.sourceRoots[0], 'spill'))
      }
      assert.ok(Object.isFrozen(row))
      const saved = await journal(root)
      const last = saved.at(-1)
      assert.equal(last.type, 'slot-result')
      assert.equal(last.slotId, slot.slotId)
      assert.deepEqual(last.record, row)
      assert.equal(last.attestation.before.sourceTreeHash, plan.inputs.provenance.sourceTreeHash)
      await Promise.resolve()
    },
  })
  assert.equal(report.stoppedReason, null, JSON.stringify({ reason: report.stoppedReason, results, checks: report.checks?.filter(row => !row.complete || !row.withinBudget) }))
  assert.equal(results, 138)
  assert.equal(report.calibrationReports.length, 4)
  assert.equal(report.benchmarkReport.results.length, 117)
  assert.equal(report.developmentReport.records.length, 9)
  assert.equal(report.attestations.length, 138)
  assert.equal(report.forecastTasks.length, 0)
  assert.equal(report.forecastSkipped, 'scripted-replay-not-calibration-evidence')
  assert.equal(report.replayComplete, true, JSON.stringify({ calibration: report.calibrationComplete, benchmark: report.benchmark?.replayComplete, dev: report.development?.replayComplete, attestations: report.attestationsComplete }))
  assert.equal(report.accepted, false)
  assert.equal(report.totalCostUSD, null)
  assert.equal(report.knownPricedUsageUSD, null)
  assert.equal(report.developmentReport.callCount, 45)
  assert.deepEqual(await readJson(join(root, 'heldout-pin.json')), report.heldoutPin)
  assert.deepEqual(await readJson(join(root, 'bundle-report.json')), report)
  const rows = await journal(root)
  assert.equal(rows.filter(row => row.type === 'slot-plan').length, 138)
  assert.equal(rows.filter(row => row.type === 'slot-result').length, 138)
  assert.equal(rows.filter(row => row.type === 'slot-not-started').length, 0)
  assert.deepEqual(rows.filter(row => row.type === 'slot-result').map(row => row.attestation), report.attestations)
  assert.deepEqual(summarizeAcceptanceBundleV4(report), Object.fromEntries(Object.keys(summarizeAcceptanceBundleV4(report)).map(key => [key, report[key]])))
})

test('existing roots reject before credential reads and invalid replay rejects before artifacts', async t => {
  const parent = await directory(t)
  const root = join(parent, 'existing')
  await mkdir(root)
  const pricing = { currency: 'USD', model: 'deepseek-flash', sourceUrl: 'https://example.test/pricing', verifiedDate: '2026-10-28', ratePeriod: 'test', uncached: .3, cacheRead: .006, cacheWrite: 0, output: 1.2 }
  await assert.rejects(evaluateAcceptanceBundleV4({ ...options, rootDir: root, replay: false, pricing, credentialFile: join(parent, 'missing-key') }), error => error.code === 'EEXIST')
  for (const replay of [null, 'false', 1]) await assert.rejects(evaluateAcceptanceBundleV4({ ...options, rootDir: join(parent, 'invalid'), replay }), /boolean/)
  await assert.rejects(readFile(join(parent, 'invalid/bundle-plan.json')), error => error.code === 'ENOENT')
})

test('awaited root checkpoint failure prevents every task and retains a stopped report', async t => {
  const root = join(await directory(t), 'checkpoint')
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { entered = resolve })
  const running = evaluateAcceptanceBundleV4({ ...options, rootDir: root, async onPlan() { entered(); await gate; throw new Error('private checkpoint error') } })
  try {
    await ready
    assert.equal((await journal(root)).filter(row => row.type === 'slot-plan').length, 0)
  } finally { release() }
  const report = await running
  assert.equal(report.stoppedReason, 'plan-checkpoint-failed')
  assert.equal(report.attestations.length, 0)
  assert.equal(report.accepted, false)
  assert.equal(report.replayComplete, false)
  assert.equal(JSON.stringify(report).includes('private checkpoint error'), false)
})

test('failed result callback preserves the first real record and prevents the next task', async t => {
  const root = join(await directory(t), 'result')
  const report = await evaluateAcceptanceBundleV4({ ...options, rootDir: root, onResult() { throw new Error('private failure') } })
  assert.equal(report.stoppedReason, 'result-checkpoint-failed')
  assert.equal(report.calibrationReports[0].tasks.length, 1)
  assert.equal(report.calibrationReports[0].tasks[0].modelCalls.length, 3)
  assert.equal(report.attestations.length, 1)
  const saved = await journal(root)
  assert.equal(saved.filter(row => row.type === 'slot-plan').length, 1)
  assert.equal(saved.filter(row => row.type === 'slot-result').length, 1)
  assert.equal(report.replayComplete, false)
})

test('insufficient global reservation is durably not-started, never zero-cost success', async t => {
  const root = join(await directory(t), 'budget')
  const report = await evaluateAcceptanceBundleV4({ ...options, rootDir: root, maxTotalCalls: 1 })
  assert.equal(report.stoppedReason, 'budget-reservation')
  assert.equal(report.attestations.length, 0)
  assert.equal(report.notStarted.length, 1)
  assert.equal(report.notStarted[0].started, false)
  assert.equal(report.calibrationReports[0].tasks.length, 0)
  assert.equal(report.totalCostUSD, null)
  assert.equal(report.replayComplete, false)
  const saved = await journal(root)
  assert.equal(saved.filter(row => row.type === 'slot-plan').length, 0)
  assert.equal(saved.filter(row => row.type === 'slot-not-started').length, 1)
})

test('a private copied CLI lock drift after plan pinning prevents the first model call', async t => {
  const parent = await directory(t)
  const runtime = join(parent, 'runtime')
  await mkdir(runtime)
  await copyFile(join(cliRuntimeRoot, 'package-lock.json'), join(runtime, 'package-lock.json'))
  await symlink(join(cliRuntimeRoot, 'node_modules'), join(runtime, 'node_modules'))
  const report = await evaluateAcceptanceBundleV4({ ...options, rootDir: join(parent, 'drift'), cliRuntimeRoot: runtime,
    async onPlan() { await appendFile(join(runtime, 'package-lock.json'), '\n') } })
  assert.equal(report.stoppedReason, 'source-or-runtime-drift')
  assert.equal(report.attestations.length, 0)
  assert.equal(report.notStarted[0].started, false)
  assert.equal(report.calibrationReports[0].tasks.length, 0)
})

test('benchmark callback failure retains the final child record and partial section', { timeout: 30000 }, async t => {
  const root = join(await directory(t), 'benchmark-partial')
  const report = await evaluateAcceptanceBundleV4({ ...options, rootDir: root,
    onResult(_row, slot) { if (slot.kind === 'benchmark') throw new Error('checkpoint unavailable') } })
  assert.equal(report.stoppedReason, 'result-checkpoint-failed')
  assert.equal(report.calibrationReports.length, 4)
  assert.ok(report.heldoutPin)
  assert.equal(report.benchmarkReport.results.length, 1)
  assert.ok(report.benchmarkReport.results[0].modelCalls.length > 0)
  assert.equal(report.benchmarkReport.stoppedReason, 'result-checkpoint-failed')
  assert.equal(report.developmentReport.records.length, 0)
  assert.equal(report.attestations.length, 13)
  assert.deepEqual((await journal(root)).filter(row => row.type === 'slot-result').at(-1).record, report.benchmarkReport.results[0])
  assert.equal(report.replayComplete, false)
})

test('development callback failure retains its raw ledger and sessions when the child cannot return', { timeout: 120000 }, async t => {
  const root = join(await directory(t), 'development-partial')
  const report = await evaluateAcceptanceBundleV4({ ...options, rootDir: root,
    onResult(_row, slot) { if (slot.kind === 'development') throw new Error('checkpoint unavailable') } })
  assert.equal(report.stoppedReason, 'result-checkpoint-failed')
  assert.equal(report.benchmarkReport.results.length, 117)
  assert.equal(report.developmentReport.records.length, 1)
  const record = report.developmentReport.records[0]
  assert.ok(record.ledgerText.includes('model/start'))
  assert.ok(record.sessionEvents.length > 0)
  assert.equal(record.result.modelCalls.length, 5)
  assert.equal(report.attestations.length, 130)
  const saved = await journal(root)
  assert.equal(saved.filter(row => row.type === 'slot-plan' && row.slot.kind === 'development').length, 1)
  assert.deepEqual(saved.filter(row => row.type === 'slot-result').at(-1).record, record)
  await assert.rejects(readFile(join(root, 'development/run-0-baseline-tuned/plan.json')), error => error.code === 'ENOENT')
  assert.equal(report.replayComplete, false)
})

test('an awaited result checkpoint suspends all later task starts', { timeout: 30000 }, async t => {
  const root = join(await directory(t), 'suspended-result')
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { entered = resolve })
  const running = evaluateAcceptanceBundleV4({ ...options, rootDir: root,
    async onResult() { entered(); await gate; throw new Error('stop after durable result') } })
  try {
    await ready
    const rows = await journal(root)
    assert.equal(rows.filter(row => row.type === 'slot-plan').length, 1)
    assert.equal(rows.filter(row => row.type === 'slot-result').length, 1)
  } finally { release() }
  const report = await running
  assert.equal(report.stoppedReason, 'result-checkpoint-failed')
  assert.equal(report.attestations.length, 1)
})

test('explicit agent runtime must match the actual module resolver before starting a bundle', async t => {
  const parent = await directory(t)
  const copied = join(parent, 'different-agent')
  await mkdir(copied)
  await assert.rejects(evaluateAcceptanceBundleV4({ ...options, rootDir: join(parent, 'bundle'), agentRuntimeRoot: copied }), /actual DSH_RUNTIME_ROOT/)
  await assert.rejects(readFile(join(parent, 'bundle/bundle-plan.json')), error => error.code === 'ENOENT')
})

test('runtime resolver changes during the awaited plan checkpoint cannot select another AgentLoop', async t => {
  const root = join(await directory(t), 'resolver-drift')
  const before = process.env.DSH_RUNTIME_ROOT
  let report
  try {
    report = await evaluateAcceptanceBundleV4({ ...options, rootDir: root,
      onPlan() { process.env.DSH_RUNTIME_ROOT = '/missing/unplanned-agent-runtime' } })
  } finally {
    if (before === undefined) delete process.env.DSH_RUNTIME_ROOT
    else process.env.DSH_RUNTIME_ROOT = before
  }
  assert.equal(report.stoppedReason, 'runtime-resolver-drift')
  assert.equal(report.attestations.length, 0)
  assert.equal(report.calibrationReports.length, 0)
  assert.equal(report.notStarted.length, 1)
  assert.equal(report.notStarted[0].started, false)
})

test('live credential files are not read until the durable plan callback succeeds', async t => {
  const parent = await directory(t)
  const root = join(parent, 'live-checkpoint')
  const pricing = { currency: 'USD', model: 'deepseek-flash', sourceUrl: 'https://example.test/pricing', verifiedDate: '2026-10-28', ratePeriod: 'test', uncached: .3, cacheRead: .006, cacheWrite: 0, output: 1.2 }
  const report = await evaluateAcceptanceBundleV4({ ...options, rootDir: root, replay: false, pricing, credentialFile: join(parent, 'missing-key'),
    async onPlan(plan) {
      assert.deepEqual(await readJson(join(root, 'bundle-plan.json')), plan)
      throw new Error('do not read credentials')
    } })
  assert.equal(report.stoppedReason, 'plan-checkpoint-failed')
  assert.equal(report.calibrationReports.length, 0)
  assert.equal(report.attestations.length, 0)
  const saved = await readFile(join(root, 'bundle-plan.json'), 'utf8')
  assert.equal(saved.includes('missing-key'), false)
  assert.equal(saved.includes('credentialFile'), false)
})

test('relative credentials stay bound to the initial cwd across an awaited plan callback', { timeout: 30000 }, async t => {
  const parent = await directory(t)
  const original = join(parent, 'original'), wrong = join(parent, 'wrong')
  await mkdir(original); await mkdir(wrong)
  await writeFile(join(wrong, 'relative.key'), 'dummy-never-used', { mode: 0o600 })
  const root = join(parent, 'credential-path')
  const pricing = { currency: 'USD', model: 'deepseek-flash', sourceUrl: 'https://example.test/pricing', verifiedDate: '2026-10-28', ratePeriod: 'test', uncached: .3, cacheRead: .006, cacheWrite: 0, output: 1.2 }
  const source = `const { evaluateAcceptanceBundleV4 } = await import(${JSON.stringify(new URL('../../scripts/evaluate-acceptance-bundle-v4.js', import.meta.url).href)});
const options = ${JSON.stringify({ ...options, rootDir: root, replay: false, pricing, credentialFile: 'relative.key', maxTotalCalls: 1 })};
options.onPlan = () => process.chdir(${JSON.stringify(wrong)});
const report = await evaluateAcceptanceBundleV4(options);
console.log(JSON.stringify({reason:report.stoppedReason,calls:report.modelCalls,attestations:report.attestations.length}));`
  // Even the old wrong-path behavior could not reach a provider: the 14-call
  // reservation exceeds this process's one-call global budget.
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
    cwd: original, env: { ...process.env, DSH_RUNTIME_ROOT: agentRuntimeRoot }, timeout: 20000,
  })
  assert.deepEqual(JSON.parse(result.stdout.trim()), { reason: 'credential-read-failed', calls: 0, attestations: 0 })
  assert.equal((await journal(root)).some(row => row.type === 'slot-plan'), false)
})

test('an earlier cached AgentLoop cannot masquerade as the newly pinned runtime root', { timeout: 30000 }, async t => {
  const parent = await directory(t)
  const other = join(parent, 'agent-copy')
  await mkdir(other)
  await copyFile(join(agentRuntimeRoot, 'package.json'), join(other, 'package.json'))
  await copyFile(join(agentRuntimeRoot, 'package-lock.json'), join(other, 'package-lock.json'))
  await symlink(join(agentRuntimeRoot, 'node_modules'), join(other, 'node_modules'))
  const root = join(parent, 'module-mismatch')
  const source = `await import(${JSON.stringify(new URL('../../scripts/evaluate-agent.js', import.meta.url).href)});
process.env.DSH_RUNTIME_ROOT = ${JSON.stringify(other)};
const { evaluateAcceptanceBundleV4 } = await import(${JSON.stringify(new URL('../../scripts/evaluate-acceptance-bundle-v4.js', import.meta.url).href)});
const report = await evaluateAcceptanceBundleV4(${JSON.stringify({ ...options, rootDir: root, agentRuntimeRoot: other })});
console.log(JSON.stringify({reason:report.stoppedReason,calls:report.modelCalls,attestations:report.attestations.length,notStarted:report.notStarted}));`
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, DSH_RUNTIME_ROOT: agentRuntimeRoot }, timeout: 20000,
  })
  const observed = JSON.parse(result.stdout.trim())
  assert.equal(observed.reason, 'runtime-module-mismatch')
  assert.equal(observed.calls, 0)
  assert.equal(observed.attestations, 0)
  assert.equal(observed.notStarted.length, 1)
  assert.equal(observed.notStarted[0].started, false)
  assert.equal((await journal(root)).some(row => row.type === 'slot-plan'), false)
})

test('a failed temporary-directory removal retains the first three calls and stops the whole bundle', { timeout: 30000 }, async () => {
  const child = async source => JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, DSH_RUNTIME_ROOT: agentRuntimeRoot, DSH_CLI_RUNTIME_ROOT: cliRuntimeRoot }, timeout: 20000, maxBuffer: 4 * 1024 * 1024,
  })).stdout.trim())
  const result = await child(`import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
const originalRm = fs.rm;
const leftovers = new Set();
const temporaryRoots = [resolve(tmpdir()), await fs.realpath(tmpdir())];
const parent = await fs.mkdtemp(join(tmpdir(), 'dsh-cleanup-evidence-'));
fs.rm = async (path, options) => {
  if (typeof path === 'string' && basename(path).startsWith('dsh-agent-eval-') && temporaryRoots.includes(resolve(dirname(path)))) {
    leftovers.add(path);
    throw Object.assign(new Error('private cleanup error'), {code:'EACCES'});
  }
  return originalRm(path, options);
};
syncBuiltinESMExports();
let report, saved, thrown = null;
try {
  const { evaluateAcceptanceBundleV4 } = await import(${JSON.stringify(new URL('../../scripts/evaluate-acceptance-bundle-v4.js', import.meta.url).href)});
  const root = join(parent, 'bundle');
  report = await evaluateAcceptanceBundleV4({rootDir:root,bundleId:'cleanup-evidence',maxTotalCostUSD:1,maxTotalCalls:1992,knownPriorSpendUSD:0,priorUnpricedCalls:0});
  saved = (await fs.readFile(join(root,'bundle-journal.jsonl'),'utf8')).trim().split('\\n').map(JSON.parse);
} catch (error) { thrown = error.code ?? error.name; }
finally {
  fs.rm = originalRm; syncBuiltinESMExports();
  for (const path of leftovers) await originalRm(path,{recursive:true,force:true});
  await originalRm(parent,{recursive:true,force:true});
}
console.log(JSON.stringify({row:report?.calibrationReports?.[0]?.tasks?.[0],report,saved,thrown,mockedDirectories:leftovers.size}));`)
  assert.equal(result.thrown, null)
  assert.equal(result.row.modelCalls.length, 3)
  assert.equal(result.row.usage.inputTokens, 30)
  assert.equal(result.row.usage.outputTokens, 15)
  assert.equal(result.row.usageComplete, false)
  assert.equal(result.row.passed, false)
  assert.equal(result.row.estimatedCostUSD, null)
  assert.equal(result.row.cleanup.complete, false)
  assert.ok(result.row.cleanup.failures.length > 0)
  assert.ok(result.row.cleanup.failures.every(failure => typeof failure.phase === 'string'))
  assert.equal(JSON.stringify(result.row).includes('private cleanup error'), false)
  assert.equal(result.mockedDirectories, 1)
  assert.equal(result.report.modelCalls, 3)
  assert.equal(result.report.stoppedReason, 'agent-cleanup-unconfirmed')
  assert.equal(result.report.calibrationReports[0].tasks.length, 1)
  assert.equal(result.report.attestations.length, 1)
  assert.equal(result.report.accepted, false)
  assert.equal(result.report.replayComplete, false)
  assert.equal(result.report.totalCostUSD, null)
  assert.equal(result.saved.filter(row => row.type === 'slot-plan').length, 1)
  assert.equal(result.saved.filter(row => row.type === 'slot-result').length, 1)
  assert.equal(result.saved.find(row => row.type === 'slot-result').record.modelCalls.length, 3)
})


test('a tighter task cost ceiling is frozen before credentials or model execution', async t => {
  const root = join(await directory(t), 'tighter-budget')
  let seen = false
  const report = await evaluateAcceptanceBundleV4({ ...options, rootDir: root, maxTaskCostUSD: .02,
    async onPlan(plan) {
      seen = true
      assert.equal(plan.inputs.maxTaskCostUSD, .02)
      assert.ok(plan.slots.every(slot => slot.budget.maxCostUSD === .02))
      assert.equal(plan.developmentPlan.taskBudget.maxCostUSD, .02)
      assert.deepEqual(await readJson(join(root, 'bundle-plan.json')), plan)
      throw new Error('Stop before credentials and model execution')
    } })
  assert.equal(seen, true)
  assert.equal(report.stoppedReason, 'plan-checkpoint-failed')
  assert.equal(report.modelCalls, 0)
  assert.equal((await journal(root)).some(row => row.type === 'slot-plan'), false)
})
