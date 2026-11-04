import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { offlineEvaluationEnvironment, officialEvaluationShell } from '../../scripts/benchmark/run-swe-canary.js'

const execute = promisify(execFile)
test('official task environment can prepare its editable install offline', {
  skip: process.env.RUN_SWE_CANARY_ENV_TEST !== '1', timeout: 60000,
}, async () => {
  const { stdout } = await execute('docker', ['run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--cap-drop', 'ALL',
    ...offlineEvaluationEnvironment.flatMap(value => ['-e', value]), '--entrypoint', '/opt/miniconda3/envs/testbed/bin/python',
    process.env.SWE_CANARY_IMAGE ?? 'dsh-free-context-swe-sql3109:20261029', '-m', 'pip', 'install', '--dry-run', '--no-deps', '-e', '/testbed'], { timeout: 55000, maxBuffer: 2 * 1024 * 1024 })
  assert.match(stdout, /Would install sqlfluff-0\.12\.0/)
  assert.doesNotMatch(stdout, /Installing build dependencies/)
})

test('official evaluation captures test stdout between xtrace markers on stderr', {
  skip: process.env.RUN_SWE_CANARY_ENV_TEST !== '1', timeout: 30000,
}, async () => {
  const script = "printf '%s\\n' 'set -x' \": '>>>>> Start Test Output'\" \"printf 'PASSED test_case\\n'\" \": '>>>>> End Test Output'\" > /official-eval.sh\n" + officialEvaluationShell
  const { stdout } = await execute('docker', ['run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--cap-drop', 'ALL',
    '--entrypoint', '/bin/bash', process.env.SWE_CANARY_IMAGE ?? 'dsh-free-context-swe-sql3109:20261029', '-c', script], { timeout: 25000 })
  assert.match(stdout, />>>>> Start Test Output[\s\S]*PASSED test_case[\s\S]*>>>>> End Test Output/)
})
