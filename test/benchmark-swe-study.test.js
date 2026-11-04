import test from 'node:test'
import assert from 'node:assert/strict'
import { cnyCost, recoverKnownCalls } from '../scripts/benchmark/run-swe-canary.js'
import { summarizeCanary } from '../scripts/benchmark/report-swe-canary.js'

test('CNY accounting uses verified disjoint tariff and refuses unknown counters', () => {
  assert.equal(cnyCost({ inputTokens: 10, cacheReadTokens: 100, outputTokens: 2 }), 40 / 1e6)
  assert.equal(cnyCost({ inputTokens: 10 }), null)
  assert.equal(cnyCost({ inputTokens: 10, outputTokens: 2, cacheWriteTokens: 1 }), null)
  assert.equal(cnyCost({ inputTokens: -1, outputTokens: 2 }), null)
})

test('journal recovery keeps known costs, deduplicates replayed events and marks missing attempts', () => {
  const end = { type: 'end', id: 1, usage: { inputTokens: 10, outputTokens: 5 }, streamCompleted: true, finish: 'stop' }
  const text = [{ type: 'start', id: 1 }, end, end, { type: 'start', id: 2 }].map(x => JSON.stringify(x)).join('\n')
  const recovered = recoverKnownCalls(text)
  assert.equal(recovered.knownCNY, 60 / 1e6)
  assert.equal(recovered.unknownCalls, 1)
  assert.equal(recovered.journalInvalid, false)
  assert.equal(recoverKnownCalls(text + '\n{"broken":').journalInvalid, true)
})

test('terminal disconnect retains reported subtotal while remaining incomplete', () => {
  const rows = [{ type: 'start', id: 1 }, { type: 'end', id: 1, usage: { inputTokens: 10, outputTokens: 5 }, streamCompleted: false, finish: 'error' }]
  const recovered = recoverKnownCalls(rows.map(x => JSON.stringify(x)).join('\n'))
  assert.equal(recovered.knownCNY, 60 / 1e6)
  assert.equal(recovered.unknownCalls, 1)
})

test('publication suppresses comparative claims on incomplete or source-drifted studies', () => {
  const tasks = []
  for (let repetition = 0; repetition < 3; repetition++) for (const group of ['baseline-default', 'baseline-tuned', 'plugin']) tasks.push({ repetition, group, quality: { resolved: true }, costCNY: group === 'plugin' ? .01 : .02,
    result: { usageComplete: true, costUSD: .001, usage: { inputTokens: group === 'plugin' ? 5 : 10, outputTokens: 0 }, modelCalls: [], decisions: [] } })
  const complete = { finished: true, sourceAfterMatches: true, tasks, plan: { scheduled: tasks.map(({ repetition, group }) => ({ repetition, group })) } }
  assert.equal(summarizeCanary(complete).tokenSavingsVsTuned, .5)
  assert.equal(summarizeCanary({ ...complete, sourceAfterMatches: false }).tokenSavingsVsTuned, null)
  assert.equal(summarizeCanary({ ...complete, finished: false }).tokenSavingsVsTuned, null)
  assert.equal(summarizeCanary({ ...complete, tasks: tasks.slice(0, 8) }).costSavingsVsTuned, null)
  const bad = structuredClone(complete); bad.tasks[0].result.usageComplete = false
  assert.equal(summarizeCanary(bad).tokenSavingsVsTuned, null)
})
