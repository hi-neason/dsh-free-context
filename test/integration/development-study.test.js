import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { evaluateDevelopmentStudy, summarizeDevelopmentStudy } from '../../scripts/evaluate-development-study.js'

const runtimeRoot = resolve(process.env.DSH_CLI_RUNTIME_ROOT ?? '.omx/cli-runtime')

test('nine balanced actual CLI coding replays persist plans before execution and independently summarize raw evidence', { skip: process.platform === 'win32', timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-development-study-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'study')
  let plans = 0, results = 0, taskPlans = 0
  const report = await evaluateDevelopmentStudy({ directory, runtimeRoot, maxTotalCostUSD: .5,
    async onPlan(plan) {
      plans++
      assert.deepEqual(JSON.parse(await readFile(join(directory, 'study-plan.json'), 'utf8')), plan)
      assert.equal(Object.isFrozen(plan.runs[0]), true)
    },
    async onTaskPlan(taskPlan, slot, studyPlan) {
      taskPlans++
      assert.equal(plans, 1)
      assert.equal(slot, studyPlan.runs[taskPlans - 1])
      assert.equal(Object.isFrozen(taskPlan.configuration), true)
      assert.equal(Object.isFrozen(slot), true)
      assert.equal(taskPlan.byteBudgetValidation.validatorHash, studyPlan.fixtureValidationHash)
      assert.equal(taskPlan.byteBudgetValidation.cases, 82)
      const saved = (await readFile(join(directory, 'study-task-plans.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
      assert.equal(saved.length, taskPlans)
      assert.equal(saved.at(-1).taskPlan.manifestHash, taskPlan.manifestHash)
      await Promise.resolve()
    },
    async onResult(record) {
      results++
      assert.equal(record.result.verification.byteBudgetValidation.passedCases, 82)
      assert.equal(record.sourceAfter.fixtureValidationHash, record.taskPlan.byteBudgetValidation.validatorHash)
      assert.equal(taskPlans, results)
      const starts = (await readFile(join(directory, 'study-task-plans.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
      assert.equal(starts.length, results)
      assert.equal(starts.at(-1).runId, record.runId)
      assert.equal(starts.at(-1).taskPlan.manifestHash, record.taskPlan.manifestHash)
      assert.equal((await readFile(join(directory, 'study-journal.jsonl'), 'utf8')).trim().split('\n').length, results)
    } })
  assert.equal(plans, 1)
  assert.equal(taskPlans, 9)
  assert.equal(results, 9, JSON.stringify({ stoppedReason: report.stoppedReason, checks: report.checks }))
  assert.equal(report.stoppedReason, null)
  assert.equal(report.qualityComplete, true)
  assert.equal(report.accountingComplete, true)
  assert.equal(report.replayComplete, true)
  assert.equal(report.callCount, 45)
  assert.equal(report.accepted, false)
  assert.equal(report.observedCostUSD, null)
  assert.equal(report.netSavingsVsTunedUSD, null)
  assert.ok(report.checks.every(check => check.elapsedMs > 0 && check.steps === 5))
  const journal = (await readFile(join(directory, 'study-journal.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(summarizeDevelopmentStudy(report.plan, journal).replayComplete, true)
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'study-report.json'), 'utf8')), report)
})

test('an awaited nested task-plan checkpoint can stop the study before any CLI or model call', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-development-task-plan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'study')
  let observed = false
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const checkpointEntered = new Promise(resolve => { entered = resolve })
  const running = evaluateDevelopmentStudy({ directory, runtimeRoot, maxTotalCostUSD: .5,
    async onTaskPlan(plan, slot, parent) {
      assert.equal(slot.runId, parent.runs[0].runId)
      const child = JSON.parse(await readFile(join(slot.directory, 'plan.json'), 'utf8'))
      assert.deepEqual(child, plan)
      entered()
      await gate
      observed = true
      throw new Error('global task reservation unavailable')
    } })
  try {
    await checkpointEntered
    await assert.rejects(readFile(join(directory, 'run-0-baseline-default/ledger.jsonl')), error => error.code === 'ENOENT')
  } finally { release() }
  const report = await running
  assert.equal(observed, true)
  assert.equal(report.stoppedReason, 'runner-exception')
  assert.equal(report.records.length, 1)
  assert.equal(report.records[0].result, null)
  assert.ok(report.records[0].taskPlan)
  assert.equal(report.callCount, 0)
  assert.equal(report.accepted, false)
  await assert.rejects(readFile(join(directory, 'run-0-baseline-default/ledger.jsonl')), error => error.code === 'ENOENT')
  await assert.rejects(readFile(join(directory, 'run-0-baseline-tuned/plan.json')), error => error.code === 'ENOENT')
})

test('study pre-call checkpoint failures and insufficient full-task reservations cannot launch a task', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-development-study-limit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'checkpoint')
  await assert.rejects(evaluateDevelopmentStudy({ directory, runtimeRoot, maxTotalCostUSD: .5,
    onPlan() { throw new Error('checkpoint unavailable') } }), /checkpoint unavailable/)
  await assert.rejects(readFile(join(directory, 'run-0-baseline-default/plan.json')), error => error.code === 'ENOENT')
  const report = await evaluateDevelopmentStudy({ directory: join(root, 'budget'), runtimeRoot, maxTotalCostUSD: .5, maxTotalCalls: 1 })
  assert.equal(report.stoppedReason, 'budget-reservation')
  assert.equal(report.records.length, 0)
  assert.equal(report.coverageComplete, false)
  assert.equal(report.accepted, false)
  assert.equal(report.knownPricedUsageUSD, null)
})

test('a failed result checkpoint retains the first complete raw record and prevents the next CLI task', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-development-study-result-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'study')
  await assert.rejects(evaluateDevelopmentStudy({ directory, runtimeRoot, maxTotalCostUSD: .5,
    onResult() { throw new Error('result checkpoint unavailable') } }), /result checkpoint unavailable/)
  const rows = (await readFile(join(directory, 'study-journal.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].result.modelCalls.length, 5)
  assert.equal(typeof rows[0].ledgerText, 'string')
  assert.ok(rows[0].sessionEvents.length > 0)
  await assert.rejects(readFile(join(directory, 'run-0-baseline-tuned/plan.json')), error => error.code === 'ENOENT')
})
