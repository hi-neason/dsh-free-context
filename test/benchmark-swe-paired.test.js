import test from 'node:test'
import assert from 'node:assert/strict'
import { pairedSchedule, pricedCNY, totalTokens, recoverPairedCalls, summarizePaired, additionalRecoveredCost } from '../scripts/benchmark/run-swe-paired.js'

const prices = { currency: 'CNY', uncached: 9, cacheRead: .3, output: 27 }
test('lost journal after completed paid task cannot subtract known charges', () => {
  assert.equal(additionalRecoveredCost(2, 0), 0)
  assert.equal(additionalRecoveredCost(2, 1), 0)
  assert.equal(additionalRecoveredCost(2, 2), 0)
  assert.equal(additionalRecoveredCost(2, 3), 1)
  assert.equal(additionalRecoveredCost(0, 3), 3)
})
test('paired pilot alternates order with exactly one baseline and plugin per frozen task', () => {
  const schedule = pairedSchedule(['a', 'b', 'c', 'd', 'e'])
  assert.equal(schedule.length, 10)
  assert.deepEqual(schedule.map(row => row.group), ['baseline-tuned', 'plugin', 'plugin', 'baseline-tuned', 'baseline-tuned', 'plugin', 'plugin', 'baseline-tuned', 'baseline-tuned', 'plugin'])
  for (const id of ['a', 'b', 'c', 'd', 'e']) assert.deepEqual(new Set(schedule.filter(row => row.instanceId === id).map(row => row.group)), new Set(['baseline-tuned', 'plugin']))
  assert.throws(() => pairedSchedule(['a', 'b', 'c', 'd', 'd']))
  assert.throws(() => pairedSchedule(['a']))
})

test('Pro accounting ignores overlapping provider totals and preserves distinct cache fields', () => {
  const usage = { inputTokens: 100, cacheReadTokens: 1000, outputTokens: 20, totalTokens: 1120 }
  assert.equal(totalTokens(usage), 1120)
  assert.equal(pricedCNY(usage, prices), .00174)
  assert.equal(pricedCNY({ ...usage, cacheWriteTokens: 1 }, prices), null)
  assert.equal(pricedCNY({ inputTokens: 2 }, prices), null)
  assert.equal(pricedCNY(usage, { ...prices, currency: 'USD' }), null)
})

test('partial/disconnected calls retain known usage without becoming fully accounted', () => {
  const rows = [{ type: 'start', id: 1 }, { type: 'end', id: 1, usage: { inputTokens: 100, outputTokens: 20 }, streamCompleted: true, finish: 'tool-calls' },
    { type: 'start', id: 2 }, { type: 'end', id: 2, usage: { inputTokens: 100, outputTokens: 20 }, streamCompleted: false, finish: 'error' }, { type: 'start', id: 3 }]
  const journal = rows.map(row => JSON.stringify(row)).join('\n')
  const recovered = recoverPairedCalls(journal, prices)
  assert.equal(recovered.knownCNY, .00288)
  assert.equal(recovered.unknownCalls, 2)
  assert.equal(recovered.invalid, false)
  assert.equal(recoverPairedCalls(journal + '\n{', prices).invalid, true)
  assert.equal(recoverPairedCalls(journal + '\n' + JSON.stringify(rows[1]), prices).invalid, true)
})

test('paired summary suppresses incomplete savings and rejects quality equivalence for zero scores or regressions', () => {
  const scheduled = pairedSchedule(['a', 'b', 'c', 'd', 'e'])
  const tasks = scheduled.map(slot => ({ ...slot, quality: { resolved: true }, costCNY: slot.group === 'plugin' ? .01 : .02,
    result: { usageComplete: true, usage: { inputTokens: slot.group === 'plugin' ? 5 : 10, outputTokens: 0 }, modelCalls: [], decisions: [] } }))
  const report = { finished: true, accountingComplete: true, sourceAfterMatches: true, plan: { scheduled }, tasks }
  assert.equal(summarizePaired(report).tokenDifferenceFraction, .5)
  assert.equal(summarizePaired(report).qualityObservedEqual, true)
  assert.equal(summarizePaired(report).generalQualityEquivalenceEstablished, false)
  for (const field of ['finished', 'accountingComplete', 'sourceAfterMatches']) assert.equal(summarizePaired({ ...report, [field]: false }).tokenDifferenceFraction, null)
  assert.equal(summarizePaired({ ...report, tasks: tasks.slice(1) }).tokenDifferenceFraction, null)
  const regressed = structuredClone(report); regressed.tasks[1].quality.resolved = false
  assert.equal(summarizePaired(regressed).qualityObservedEqual, false)
  const zeros = structuredClone(report); zeros.tasks.forEach(row => { row.quality.resolved = false })
  assert.equal(summarizePaired(zeros).qualityObservedEqual, false)
})
