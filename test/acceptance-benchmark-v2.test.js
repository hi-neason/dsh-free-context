import assert from 'node:assert/strict'
import test from 'node:test'
import { createAcceptancePlan } from '../scripts/acceptance-benchmark.js'
import { createAcceptancePlanV2, evaluateAcceptanceV2, summarizeAcceptanceV2 } from '../scripts/acceptance-benchmark-v2.js'
import { acceptanceFixturesV2 } from './fixtures/acceptance/tasks-v2.js'
import { prepareDiagnosticEvidence } from '../src/diagnostic-evidence.js'
import { safeFailure, summarizeUsage } from '../scripts/evaluation-accounting.js'

test('v1 remains frozen while v2 fixes scope and declares balanced composition/feedback/stress', () => {
  assert.equal(createAcceptancePlan().manifestHash, '60aa7bf8d390f8dbc64205a0e9e17f8c537b5d0ff050067f6b18c7b2fd82473d')
  const plan = createAcceptancePlanV2()
  assert.equal(plan.version, 2)
  assert.equal(plan.runs.length, 117)
  assert.equal(plan.criteria.validationFeedbackLimit, 2)
  for (const task of plan.tasks) for (const group of ['baseline-default', 'baseline-tuned', 'plugin']) assert.deepEqual(plan.runs.filter(run => run.task === task.id && run.group === group).map(run => run.position).sort(), [0, 1, 2])
  assert.deepEqual(plan.tasks.find(task => task.id === 'json-nested-precision').expected, createAcceptancePlan().tasks.find(task => task.id === 'json-nested-precision').expected)
  assert.match(plan.tasks.find(task => task.id === 'json-nested-precision').query, /ONLY the value of the top-level field named exact/)
  const stress = plan.tasks.find(task => task.id === 'history-retirement-stress')
  assert.equal(stress.tier, 'quality-only')
  assert.equal(plan.tasks.find(task => task.id === 'history-retirement-short').historyRetirement.minimumFutureRequests, 2)
})
test('supported compiler fixture is admitted while TAP remains explicit unsupported fallback', () => {
  for (const fixture of acceptanceFixturesV2()) {
    for (const [phase, spec] of (fixture.phases ?? [fixture]).entries()) assert.deepEqual(fixture.answer(fixture.edit && phase ? fixture.editedText : fixture.text, phase), spec.expected)
    if (fixture.experiment !== 'diagnostic-evidence') continue
    const admission = prepareDiagnosticEvidence(fixture.text, { maxInputBytes: 100000, maxBlocks: 1000 })
    assert.equal(admission.status, fixture.adoptionRequired === false ? 'declined' : 'prepared')
  }
})
test('safe errors retain only allowlisted category/code and preflight cannot invoke runner', async () => {
  assert.deepEqual(safeFailure({ name: 'SecretName', code: 'secret-key', message: 'provider secret body' }), { category: 'unknown' })
  assert.deepEqual(safeFailure({ name: 'TimeoutError', message: 'secret' }), { category: 'timeout', name: 'TimeoutError' })
  assert.equal(summarizeUsage([{ inputTokens: 1, outputTokens: 2 }]).complete, true)
  let calls = 0
  await assert.rejects(evaluateAcceptanceV2({ replay: false, key: 'test', runner() { calls++ } }), /provenance/)
  assert.equal(calls, 0)
  const report = await evaluateAcceptanceV2({ runner() { throw { code: 'EACCES', message: 'provider secret body' } } })
  assert.equal(report.stoppedReason, 'runner-exception')
  assert.equal(report.results[0].failure.category, 'filesystem')
  assert.equal(JSON.stringify(report).includes('provider secret body'), false)
  assert.equal(report.fullAccepted, false)
  assert.equal(summarizeAcceptanceV2(createAcceptancePlanV2(), [], { replay: true }).coreAccepted, false)
})
