import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateDiagnosticTrial } from '../../scripts/evaluate-diagnostic-trial.js'

// Prerequisites: installed official dsh integration runtime and /usr/bin/clang.
// Unit tests use explicitly synthetic capture data and do not require Clang.
test('diagnostic trial runs three balanced repeats through official AgentLoop and native policy', async () => {
  let checkpointed = false
  const report = await evaluateDiagnosticTrial({ onPlan(plan) { assert.equal(plan.runs.length, 18); checkpointed = true } })
  assert.equal(checkpointed, true)
  assert.equal(report.plan.controlCapture.compiler, '/usr/bin/clang')
  assert.match(report.plan.controlCapture.runs[0].stderr, /error:/)
  assert.match(report.plan.controlCapture.runs[1].stderr, /warning:/)
  assert.equal(report.stoppedReason, null)
  assert.equal(report.replayComplete, true, JSON.stringify(report.results.map(row => ({ task: row.task, group: row.group, passed: row.passed, failure: row.failure, phases: row.phaseResults, experiments: row.experiments }))))
  assert.equal(report.accepted, false)
  assert.equal(report.candidate.experimentalCoverage, true)
  assert.equal(report.results.length, 18)
})

test('auto prompt encoding remains pinned through official diagnostic replay', async () => {
  const report = await evaluateDiagnosticTrial({ promptEncoding: 'auto' })
  assert.equal(report.plan.experimentalConfig.promptEncoding, 'auto')
  assert.equal(report.replayComplete, true)
  assert.equal(report.candidate.experimentalCoverage, true)
  assert.equal(report.accepted, false)
})
