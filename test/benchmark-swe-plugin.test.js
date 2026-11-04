import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { pluginSchedule, parseArguments, actualTaskLimit, comparePlugin, preparePluginStudy } from '../scripts/benchmark/run-swe-plugin.js'

const ids = ['django__django-16116', 'django__django-12273', 'matplotlib__matplotlib-22871', 'sphinx-doc__sphinx-7910', 'sympy__sympy-12419']
const usage = { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 5 }
const baseline = { rows: ['baseline-default', 'baseline-tuned'].flatMap(group => ids.map((instanceId, index) => ({ group, instanceId, resolved: index !== 1, totalTokens: 70 }))), totals: Object.fromEntries(['baseline-default', 'baseline-tuned'].map(group => [group, { solved: 4, totalTokens: 350, costCNY: 10 }])) }
const report = () => ({ finished: true, accountingComplete: true, sourceAfterMatches: true, withinBudget: true, tasks: ids.map((instanceId, index) => ({ instanceId, group: 'plugin', result: { usageComplete: true, usage: { ...usage }, patchStatus: 'complete' }, quality: { resolved: index !== 1, infrastructureError: false, report: { [instanceId]: {} } }, costCNY: 1 })) })

test('only fixed five plugin tasks are scheduled', () => {
  assert.deepEqual(pluginSchedule(ids).map(row => row.group), Array(5).fill('plugin'))
  assert.throws(() => pluginSchedule(ids.slice(1)))
  assert.throws(() => pluginSchedule([...ids].reverse()))
})

test('CLI defaults to no paid execution and requires prior accounting', () => {
  const args = ['--baseline', 'b', '--reference-plan', 'p', '--root', 'r', '--prior-spent-cny', '35.1021018']
  assert.equal(parseArguments(args).run, false)
  assert.equal(parseArguments([...args, '--run']).run, true)
  assert.throws(() => parseArguments(args.slice(0, -2)))
  assert.throws(() => parseArguments([...args.slice(0, -1), '0']))
  assert.throws(() => parseArguments([...args, '--model', 'other']))
})

test('actual usage budget has no reservations and retains past charges', () => {
  const config = { priorKnownCNY: 35.1021018, maxTaskCNY: 4, pricing: { uncached: 1.32, cacheRead: .044, output: 3.96 }, cnyPricing: { uncached: 9, cacheRead: .3, output: 27 } }
  assert.equal(actualTaskLimit(config, 0).remainingCNY, 50 - config.priorKnownCNY)
  assert.equal(actualTaskLimit(config, 15).maxTaskUSD, 0)
  assert.throws(() => actualTaskLimit({ ...config, priorKnownCNY: 0 }, 0))
  assert.throws(() => actualTaskLimit(config, NaN))
})

test('valid official failure counts, and comparison includes full tokens', () => {
  const result = comparePlugin(baseline, report())
  assert.equal(result.complete, true)
  assert.equal(result.plugin.solved, 4)
  assert.equal(result.plugin.totalTokens, 175)
  assert.equal(result.comparisons[0].tokenSavingsRatio, .5)
  assert.equal(result.comparisons[0].qualityObservedEqual, true)
})

test('equal aggregate score cannot conceal a regression', () => {
  const data = report()
  data.tasks[0].quality.resolved = false
  data.tasks[1].quality.resolved = true
  const result = comparePlugin(baseline, data).comparisons[0]
  assert.equal(result.solvedDifference, 0)
  assert.equal(result.qualityObservedEqual, false)
  assert.equal(result.qualityNoRegression, false)
  assert.deepEqual(result.regressions, [ids[0]])
  assert.deepEqual(result.improvements, [ids[1]])
})

test('missing accounting, evaluation, coverage or drift suppresses full comparison', () => {
  for (const mutate of [r => r.tasks.pop(), r => r.accountingComplete = false, r => r.sourceAfterMatches = false,
    r => r.tasks[0].result.usage = null, r => r.tasks[0].quality.infrastructureError = true,
    r => r.tasks[0].quality.report = null, r => r.tasks[0].costCNY = null,
    r => r.tasks[0].result.patchStatus = 'unavailable', r => r.withinBudget = false]) {
    const data = report(); mutate(data)
    assert.equal(comparePlugin(baseline, data).comparisons, null)
  }
})

test('baseline checksum and reference drift rejected before runtime or model use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swe-plugin-'))
  try {
    const file = join(root, 'baseline.json')
    await writeFile(file, '{}')
    await writeFile(join(root, 'baseline.sha256'), 'invalid')
    const options = { baselineFile: file, referencePlan: join(root, 'reference.json'), root: join(root, 'new-run'), priorKnownCNY: 35.1021018 }
    await assert.rejects(preparePluginStudy(options), /checksum/)
    await writeFile(join(root, 'baseline.sha256'), `${createHash('sha256').update('{}').digest('hex')}  baseline.json\n`)
    await writeFile(options.referencePlan, '{}')
    await assert.rejects(preparePluginStudy(options), /reference mismatch/)
    await assert.rejects(readFile(join(options.root, 'study-plan.json')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
