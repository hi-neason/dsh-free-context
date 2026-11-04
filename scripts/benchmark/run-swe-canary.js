import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { acceptanceSourceHash } from '../acceptance-benchmark-cli.js'
import { validUsage } from '../evaluation-accounting.js'
import { runSweCanaryTask, dockerCommand, completeCall } from './swe-canary-agent.js'

const exec = promisify(execFile)
const sha = data => createHash('sha256').update(data).digest('hex')
const groups = ['baseline-default', 'baseline-tuned', 'plugin']
// pip maps negative boolean environment options to their destination value:
// build_isolation=0 disables isolation and uses the preinstalled offline build tools.
// Some official images add pytest -rA to tox.ini. Resetting to the task's base
// commit removes that reporting-only tweak; restore per-test status reporting.
export const offlineEvaluationEnvironment = Object.freeze(['PIP_NO_INDEX=1', 'PIP_NO_BUILD_ISOLATION=0', 'PYTEST_ADDOPTS=-rA'])
export const officialEvaluationShell = 'exec bash /official-eval.sh 2>&1'
const run = (command, args, timeout = 60000) => exec(command, args, { timeout, maxBuffer: 16 * 1024 * 1024 })
export const cnyCost = usage => validUsage(usage) && !(usage.cacheWriteTokens > 0) ? (usage.inputTokens * 2 + (usage.cacheReadTokens ?? 0) * .04 + usage.outputTokens * 8) / 1e6 : null
export function recoverKnownCalls(text) {
  const starts = new Set(), ends = new Map()
  let invalid = false
  for (const line of text.split('\n').filter(Boolean)) {
    let record
    try { record = JSON.parse(line) } catch { invalid = true; continue }
    if (record.type === 'start') starts.add(record.id)
    if (record.type === 'end') {
      if (ends.has(record.id) && JSON.stringify(ends.get(record.id)) !== JSON.stringify(record)) { invalid = true; continue }
      ends.set(record.id, record)
    }
  }
  const knownCNY = [...ends.values()].reduce((sum, record) => sum + (cnyCost(record.usage) ?? 0), 0)
  const unknownCalls = [...starts].filter(id => !ends.has(id) || cnyCost(ends.get(id).usage) === null || !completeCall(ends.get(id))).length
  return { knownCNY, unknownCalls, journalInvalid: invalid }
}

export async function clearContainerProcesses(containerName) {
  if (!/^dsh-fc-canary-[a-z0-9-]+$/.test(containerName)) throw new Error('Unowned container')
  const script = `import os,signal,time
me=os.getpid()
def live():
 result=[]
 for name in os.listdir('/proc'):
  if not name.isdigit() or int(name) in (1,me): continue
  try:
   state=open('/proc/'+name+'/stat').read().split(') ',1)[1].split()[0]
   if state!='Z': result.append(int(name))
  except (FileNotFoundError,ProcessLookupError): pass
 return result
for attempt in range(5):
 for pid in live():
  try: os.kill(pid,signal.SIGKILL)
  except ProcessLookupError: pass
 time.sleep(.05)
assert not live(), 'live task processes remain'
print('TASK_PROCESSES_CLEAN')`
  const result = await run('docker', ['exec', containerName, '/opt/miniconda3/bin/python', '-c', script])
  return result.stdout.trim() === 'TASK_PROCESSES_CLEAN'
}

export async function scorePatch({ containerName, image, patchFile, evalScript, directory, taskFile, harnessRoot, expected, python = 'python3' }) {
  await mkdir(directory, { recursive: false, mode: 0o700 })
  const logFile = join(directory, 'test_output.txt')
  const taskBytes = await readFile(taskFile), evalBytes = await readFile(evalScript)
  if (expected && (sha(taskBytes) !== expected.taskHash || sha(evalBytes) !== expected.evalScriptHash || sha(await readFile('scripts/benchmark/swe-grade.py')) !== expected.gradingHash)) throw new Error('Evaluation source drift')
  const frozenTask = join(directory, 'frozen-task.json'), frozenEval = join(directory, 'eval.sh')
  await writeFile(frozenTask, taskBytes, { flag: 'wx', mode: 0o600 })
  // Docker cp can preserve a host UID. World-readable files inside the private
  // evaluator avoid requiring DAC_OVERRIDE; the host directory remains 0700.
  await writeFile(frozenEval, evalBytes, { flag: 'wx', mode: 0o644 })
  let containerCreated = false
  try {
    await run('docker', ['run', '-d', '--platform', 'linux/amd64', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '4g', '--cpus', '2', '--name', containerName, '--entrypoint', '/bin/bash', image, '-lc', 'sleep infinity'])
    containerCreated = true
    await run('docker', ['exec', '-w', '/testbed', containerName, 'git', 'config', 'core.fileMode', 'false'])
    const taskIdentity = JSON.parse(taskBytes)
    await run('docker', ['exec', '-w', '/testbed', containerName, 'git', 'reset', '--hard', taskIdentity.base_commit])
    const patch = await readFile(patchFile, 'utf8')
    if (patch.trim()) {
      const frozenPatch = join(directory, 'model.patch')
      await writeFile(frozenPatch, patch, { flag: 'wx', mode: 0o644 })
      await run('docker', ['cp', frozenPatch, `${containerName}:/tmp/model.patch`])
      try { await run('docker', ['exec', '-w', '/testbed', containerName, 'git', 'apply', '--binary', '/tmp/model.patch']) }
      catch (error) {
        if (typeof error.code !== 'number') throw error
        await writeFile(join(directory, 'patch-apply-error.txt'), `${error.stdout ?? ''}\n${error.stderr ?? ''}`)
        return { resolved: false, patchApplied: false, infrastructureError: false }
      }
    }
    await run('docker', ['cp', frozenEval, `${containerName}:/official-eval.sh`])
    let output
    // Merge inside the container so xtrace markers and test stdout retain order.
    try { output = await run('docker', ['exec', ...offlineEvaluationEnvironment.flatMap(value => ['-e', value]), containerName, 'bash', '-c', officialEvaluationShell], 300000) }
    catch (error) {
      if (error.killed || error.code === 'ETIMEDOUT') {
        await writeFile(logFile, `${error.stdout ?? ''}\n${error.stderr ?? ''}`)
        return { resolved: false, testTimeout: true, infrastructureError: false, classification: 'ambiguous: patch or environment may cause timeout' }
      }
      if (typeof error.code !== 'number') throw error
      output = error
    }
    // Preserve both streams. Official parser recognizes test markers and exact IDs.
    await writeFile(logFile, `${output.stdout ?? ''}\n${output.stderr ?? ''}`)
    await run(python, [resolve('scripts/benchmark/swe-grade.py'), '--harness-root', harnessRoot, '--task-file', frozenTask, '--patch-file', patchFile, '--log-file', logFile, '--output', join(directory, 'official-grade.json')])
    const graded = JSON.parse(await readFile(join(directory, 'official-grade.json'), 'utf8'))
    const task = JSON.parse(taskBytes)
    const official = graded.report?.[task.instance_id]
    if (typeof official?.resolved !== 'boolean') throw new Error('Missing official quality result')
    return { ...graded, resolved: official.resolved, infrastructureError: official.infra_failure === true }
  } catch (error) {
    await writeFile(join(directory, 'execution-error.json'), JSON.stringify({ stage: 'independent-evaluation', code: typeof error.code === 'number' ? error.code : null, killed: error.killed === true }))
    return { resolved: false, infrastructureError: true }
  } finally {
    if (containerCreated) try { await run('docker', ['rm', '-f', containerName]) }
    catch {
      await writeFile(join(directory, 'cleanup-error.json'), JSON.stringify({ containerName, complete: false }))
      throw new Error('Evaluation container cleanup failed')
    }
  }
}

export async function runSweCanaryStudy(config) {
  const limits = config.profile === 'coding-calibration-v2'
    ? { repetitions: 1, maxTaskUSD: .1, maxStudyCNY: 2, maxSteps: 64, maxCalls: 80, timeoutMs: 600000, version: 'public-swe-dev-resource-calibration-v2' }
    : { repetitions: 3, maxTaskUSD: .03, maxStudyCNY: 1.8, maxSteps: 20, maxCalls: 24, timeoutMs: 300000, version: 'public-swe-dev-canary-v1' }
  const root = resolve(config.root)
  const taskFile = resolve(config.taskFile)
  const task = JSON.parse(await readFile(taskFile, 'utf8'))
  const pricing = JSON.parse(await readFile(resolve(config.pricingFile), 'utf8'))
  if (pricing.model !== 'deepseek-flash' || pricing.uncached !== .3 || pricing.cacheRead !== .006 || pricing.output !== 1.2) throw new Error('This canary requires the verified fixed Flash comparison tariff')
  if (config.profile && config.profile !== 'coding-calibration-v2') throw new Error('Unknown calibration profile')
  if (config.repetitions !== limits.repetitions || config.maxTaskUSD !== limits.maxTaskUSD || config.maxStudyCNY !== limits.maxStudyCNY || config.newUnknownReserveCNY !== 2.2 || config.userLimitCNY !== 20 || !Number.isFinite(config.priorReserveCNY) || config.priorReserveCNY < 0) throw new Error('Explicit bounded canary plan required')
  if (config.priorReserveCNY + config.maxStudyCNY + config.newUnknownReserveCNY > config.userLimitCNY) throw new Error('Cumulative user budget exceeded')
  const preflight = JSON.parse(await readFile(resolve(config.preflightFile), 'utf8'))
  if (preflight.taskId !== task.instance_id || preflight.oracleResolved !== true || preflight.emptyResolved !== false || preflight.verified !== true) throw new Error('Official scoring preflight must pass before paid calls')
  const inspect = JSON.parse((await run('docker', ['image', 'inspect', config.image])).stdout)[0]
  if (inspect.Id !== preflight.imageId || inspect.Architecture !== 'amd64') throw new Error('Image identity drift')
  const sourceTreeHash = await acceptanceSourceHash(process.cwd())
  const gradingHash = sha(await readFile('scripts/benchmark/swe-grade.py'))
  const runtimeLockHash = sha(await readFile('.omx/integration-runtime/package-lock.json'))
  const expected = { taskHash: sha(await readFile(taskFile)), evalScriptHash: sha(await readFile(resolve(config.evalScript))), gradingHash }
  if (preflight.taskHash !== expected.taskHash || preflight.evalScriptHash !== expected.evalScriptHash || preflight.gradingHash !== gradingHash) throw new Error('Scoring preflight identity mismatch')
  const preflightHash = sha(await readFile(resolve(config.preflightFile)))
  const frozen = async () => await acceptanceSourceHash(process.cwd()) === sourceTreeHash && sha(await readFile('scripts/benchmark/swe-grade.py')) === gradingHash && sha(await readFile('.omx/integration-runtime/package-lock.json')) === runtimeLockHash && sha(await readFile(taskFile)) === expected.taskHash && sha(await readFile(resolve(config.evalScript))) === expected.evalScriptHash && sha(await readFile(resolve(config.preflightFile))) === preflightHash
  const scheduled = []
  const offset = config.profile === 'coding-calibration-v2' ? 1 : 0
  for (let repetition = 0; repetition < limits.repetitions; repetition++) for (let position = 0; position < 3; position++) scheduled.push({ repetition, group: groups[(position + repetition + offset) % 3], slot: scheduled.length })
  const plan = { version: limits.version, taskId: task.instance_id, dataset: 'SWE-bench/SWE-bench', split: 'dev', repetitions: limits.repetitions, scheduled, sourceTreeHash, gradingHash, runtimeLockHash,
    head: (await run('git', ['rev-parse', 'HEAD'])).stdout.trim(), ...expected, imageId: inspect.Id, preflightHash, configuration: config,
    profile: 'official AgentLoop restricted bash/read profile; not full dsh CLI', limits: { ...limits, maxOutputTokens: 2048, cpu: 2, ram: '4g' },
    pluginConfiguration: { tools: ['bash'], json: true, text: true, logs: true, search: false, readText: false, modelExperiments: false },
    limitations: ['one development task; no Verified test score', 'provider cache not isolated', 'logical provider usage, not independent HTTP billing audit', 'amd64 emulation on arm64 host', 'fixed comparison tariff, not an invoice'], pricing }
  await writeFile(join(root, 'study-plan.json'), JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 })
  const report = { planHash: sha(JSON.stringify(plan)), plan, tasks: [], knownStudyCostCNY: 0, accountingComplete: true, finished: false }
  const save = () => writeFile(join(root, 'study-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  const append = event => appendFile(join(root, 'study-journal.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 })
  await mkdir(join(root, 'runs'), { mode: 0o700 })
  await save()
  // Credentials stay in the host provider environment, outside the task container.
  const key = (await readFile(resolve(config.credentialFile), 'utf8')).trim()
  for (const slot of scheduled) {
    if (!await frozen()) { report.stoppedReason = 'source-or-runtime-drift'; break }
    // Reserve one full three-group block at each block boundary.
    const remainingInBlock = 3 - slot.slot % 3
    const reservedTaskCNY = limits.maxTaskUSD * 20 / 3 // Equal verified USD/CNY tariff ratios, not an FX conversion.
    if (report.knownStudyCostCNY + remainingInBlock * reservedTaskCNY > config.maxStudyCNY + 1e-12) { report.stoppedReason = 'study-budget'; break }
    const name = `dsh-fc-canary-${config.runSuffix}-${slot.slot}`
    const directory = join(root, 'runs', `${slot.slot}-${slot.group}-r${slot.repetition}`)
    await append({ type: 'slot/start', ...slot, reservedCNY: reservedTaskCNY, containerName: name })
    let created = false, accountedCNY = 0, stage = 'container-create'
    try {
      await run('docker', ['run', '-d', '--platform', 'linux/amd64', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '4g', '--cpus', '2', '--name', name, '--entrypoint', '/bin/bash', inspect.Id, '-lc', 'sleep infinity'])
      created = true
      stage = 'baseline-reset'
      await run('docker', ['exec', '-w', '/testbed', name, 'git', 'config', 'core.fileMode', 'false'])
      await run('docker', ['exec', '-w', '/testbed', name, 'git', 'reset', '--hard', task.base_commit])
      const baseline = await run('docker', ['exec', '-w', '/testbed', name, 'git', '-c', 'core.fileMode=false', 'diff', '--binary', task.base_commit])
      if (baseline.stdout.trim()) throw new Error('Task image not at declared baseline tree')
      stage = 'agent-task'
      const result = await runSweCanaryTask({ directory, containerName: name, instanceId: task.instance_id, baseCommit: task.base_commit, problemStatement: task.problem_statement, key, pricing, group: slot.group,
        maxSteps: limits.maxSteps, maxCalls: limits.maxCalls, maxCostUSD: limits.maxTaskUSD, maxOutputTokens: 2048, timeoutMs: limits.timeoutMs,
        commandExecutor: (container, command, signal) => dockerCommand(container, `source /opt/miniconda3/bin/activate testbed >/dev/null\n${command}`, signal),
        beforePatchExport: ({ containerName }) => clearContainerProcesses(containerName) })
      const knownCNY = result.modelCalls.reduce((sum, call) => sum + (cnyCost(call.usage) ?? 0), 0)
      report.knownStudyCostCNY += knownCNY
      accountedCNY = knownCNY
      report.accountingComplete &&= result.usageComplete && result.costUSD !== null
      let quality = { resolved: false, reason: 'patch-unavailable' }
      if (!await frozen()) throw new Error('Scoring inputs changed during task')
      stage = 'independent-evaluation'
      if (result.patchStatus === 'complete') quality = await scorePatch({ containerName: `${name}-eval`, image: inspect.Id, patchFile: join(directory, 'model.patch'), evalScript: resolve(config.evalScript), directory: join(directory, 'evaluation'), taskFile, harnessRoot: resolve(config.harnessRoot), expected, python: config.python ?? 'python3' })
      const record = { ...slot, result, quality, costCNY: result.usageComplete ? cnyCost(result.usage) : null }
      report.tasks.push(record)
      await append({ type: 'slot/end', ...slot, resolved: quality.resolved, usageComplete: result.usageComplete, costCNY: record.costCNY })
      await save()
      console.log(JSON.stringify({ slot: slot.slot, group: slot.group, repetition: slot.repetition, resolved: quality.resolved, agentCompleted: result.agentCompleted, usageComplete: result.usageComplete, tokens: Object.values(result.usage).reduce((a, b) => a + b, 0), costCNY: record.costCNY, stop: result.stoppedReason }))
      if (!report.accountingComplete) { report.stoppedReason = 'incomplete-accounting'; break }
      if (quality.infrastructureError) { report.stoppedReason = 'evaluator-infrastructure-error'; break }
    } catch (error) {
      report.stoppedReason = 'study-execution-error'
      report.incompleteSlot = slot
      report.accountingComplete = false
      let recovered = { knownCNY: 0, unknownCalls: null, journalInvalid: true }
      try { recovered = recoverKnownCalls(await readFile(join(directory, 'model-calls.jsonl'), 'utf8')) } catch {}
      if (accountedCNY === 0) report.knownStudyCostCNY += recovered.knownCNY
      await append({ type: 'slot/interrupted', ...slot, name: error.name, stage, recovery: recovered, unknownContingencyReservedCNY: config.newUnknownReserveCNY })
      break
    } finally {
      if (created) try { await run('docker', ['rm', '-f', name]) }
      catch { report.stoppedReason = 'task-container-cleanup-failed'; report.cleanupFailure = { containerName: name, slot: slot.slot } }
      await save()
    }
    if (report.stoppedReason) break
  }
  report.sourceAfterMatches = await frozen()
  if (!report.sourceAfterMatches) report.stoppedReason = 'source-or-runtime-drift'
  report.withinBudget = report.knownStudyCostCNY <= config.maxStudyCNY + 1e-12 && config.priorReserveCNY + report.knownStudyCostCNY + config.newUnknownReserveCNY <= config.userLimitCNY + 1e-12
  if (!report.withinBudget) report.stoppedReason = 'budget-overrun'
  report.finished = report.tasks.length === scheduled.length && report.accountingComplete && !report.stoppedReason
  await save()
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] !== '--config' || !process.argv[3] || process.argv.length !== 4) throw new Error('Explicit config path required')
    const report = await runSweCanaryStudy(JSON.parse(await readFile(resolve(process.argv[3]), 'utf8')))
    if (!report.finished) process.exitCode = 1
  } catch { console.error('Canary setup failed; no credentials or provider error bodies printed.'); process.exitCode = 1 }
}
