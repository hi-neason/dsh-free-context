import test from 'node:test'
import assert from 'node:assert/strict'
import { runEvaluationProcess } from '../scripts/evaluation-process.js'

test('evaluation subprocess budgets and environment reject before execution', { skip: process.platform === 'win32' }, async () => {
  const options = { cwd: process.cwd(), env: {}, timeoutMs: 1000 }
  for (const change of [{ cwd: 'relative' }, { env: undefined }, { env: { KEY: 42 } }, { timeoutMs: 0 }, { maxOutputBytes: Infinity }]) {
    await assert.rejects(runEvaluationProcess(process.execPath, ['-e', 'process.exit(0)'], { ...options, ...change }), TypeError)
  }
})

test('evaluation subprocess retains real exit status and both streams after owned group cleanup', { skip: process.platform === 'win32' }, async () => {
  const result = await runEvaluationProcess(process.execPath, ['-e', "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"], { cwd: process.cwd(), env: {}, timeoutMs: 1000 })
  assert.equal(result.exitCode, 3)
  assert.equal(result.stdout, 'out')
  assert.equal(result.stderr, 'err')
  assert.equal(result.cleaned, true)
  assert.equal(result.stopReason, null)
})

test('cleanup requires group disappearance even when a racing signal reports EPERM', { skip: process.platform === 'win32' }, async () => {
  const original = process.kill
  for (const confirmGone of [true, false]) {
    let inspected = false
    process.kill = function(pid, signal) {
      if (pid < 0 && (signal === 'SIGKILL' || !confirmGone && signal === 0)) {
        inspected = true
        throw Object.assign(new Error('test-only permission race'), { code: 'EPERM' })
      }
      return original.call(process, pid, signal)
    }
    try {
      const result = await runEvaluationProcess(process.execPath, ['-e', 'process.exit(0)'], { cwd: process.cwd(), env: {}, timeoutMs: 1000 })
      assert.equal(inspected, true)
      assert.equal(result.exitCode, 0)
      assert.equal(result.cleaned, confirmGone)
    } finally { process.kill = original }
  }
})
