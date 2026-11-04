import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, appendFile, mkdir, readdir, copyFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { acceptanceSourceHash } from '../acceptance-benchmark-cli.js'
import { validUsage, safeFailure } from '../evaluation-accounting.js'
import { runSweCanaryTask, dockerCommand, completeCall } from './swe-canary-agent.js'
import { clearContainerProcesses, scorePatch } from './run-swe-canary.js'

const execute = promisify(execFile)
const run = (cmd, args) => execute(cmd, args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024 })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const groups = ['baseline-tuned', 'plugin']
const fields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
export const totalTokens = usage => validUsage(usage) ? fields.reduce((sum, field) => sum + (usage[field] ?? 0), 0) : null

export function pricedCNY(usage, prices) {
  if (!validUsage(usage) || (usage.cacheWriteTokens ?? 0) !== 0 || prices?.currency !== 'CNY' ||
      !['uncached', 'cacheRead', 'output'].every(key => Number.isFinite(prices[key]) && prices[key] >= 0)) return null
  return (usage.inputTokens * prices.uncached + (usage.cacheReadTokens ?? 0) * prices.cacheRead + usage.outputTokens * prices.output) / 1e6
}

export function pairedSchedule(taskIds) {
  if (!Array.isArray(taskIds) || taskIds.length !== 5 || new Set(taskIds).size !== 5) throw new Error('Exactly five unique frozen tasks required')
  return taskIds.flatMap((instanceId, taskIndex) => [0, 1].map(position => ({
    instanceId, taskIndex, repetition: 0, group: groups[(position + taskIndex) % 2], slot: taskIndex * 2 + position
  })))
}

export function recoverPairedCalls(journal, prices) {
  const starts = new Set(), ends = new Map()
  let invalid = false
  for (const line of journal.split('\n').filter(Boolean)) {
    let record
    try { record = JSON.parse(line) } catch { invalid = true; continue }
    if (!Number.isSafeInteger(record.id) || record.id < 1) { invalid = true; continue }
    if (record.type === 'start') { if (starts.has(record.id)) invalid = true; starts.add(record.id) }
    else if (record.type === 'end') {
      if (ends.has(record.id)) invalid = true
      ends.set(record.id, record)
    } else invalid = true
  }
  if ([...ends.keys()].some(id => !starts.has(id))) invalid = true
  return {
    knownCNY: [...ends.values()].reduce((sum, call) => sum + (pricedCNY(call.usage, prices) ?? 0), 0),
    unknownCalls: [...starts].filter(id => !ends.has(id) || !completeCall(ends.get(id)) || pricedCNY(ends.get(id).usage, prices) === null).length,
    invalid
  }
}

// A later filesystem/evaluator failure must not erase already observed charges.
export function additionalRecoveredCost(accountedCNY, recoveredCNY) {
  return Math.max(accountedCNY, recoveredCNY) - accountedCNY
}

export function summarizePaired(report) {
  const schedule = report.plan.scheduled
  const identity = row => `${row.instanceId}/${row.group}/${row.repetition}`
  const identities = report.tasks.map(identity)
  const complete = report.finished === true && report.sourceAfterMatches === true && report.accountingComplete === true &&
    identities.length === schedule.length && new Set(identities).size === schedule.length &&
    schedule.every(row => identities.includes(identity(row))) && report.tasks.every(row => row.result?.usageComplete && row.costCNY !== null)
  const arms = groups.map(group => {
    const rows = report.tasks.filter(row => row.group === group)
    return { group, completed: rows.length, solved: rows.filter(row => row.quality.resolved).length,
      tokens: rows.reduce((sum, row) => sum + (totalTokens(row.result?.usage) ?? 0), 0),
      costCNY: rows.reduce((sum, row) => sum + (row.costCNY ?? 0), 0),
      calls: rows.reduce((sum, row) => sum + (row.result?.modelCalls.length ?? 0), 0),
      selections: rows.reduce((sum, row) => sum + (row.result?.decisions.filter(decision => decision.outcome === 'selected').length ?? 0), 0) }
  })
  const pairs = [...new Set(schedule.map(row => row.instanceId))].map(instanceId => {
    const baseline = report.tasks.find(row => row.instanceId === instanceId && row.group === groups[0])
    const plugin = report.tasks.find(row => row.instanceId === instanceId && row.group === groups[1])
    return { instanceId, baselineResolved: baseline?.quality.resolved ?? null, pluginResolved: plugin?.quality.resolved ?? null,
      baselineTokens: totalTokens(baseline?.result?.usage), pluginTokens: totalTokens(plugin?.result?.usage) }
  })
  const qualityObservedEqual = complete && arms[0].solved > 0 && pairs.every(pair => pair.baselineResolved === pair.pluginResolved)
  return { complete, arms, pairs, qualityObservedEqual,
    tokenDifferenceFraction: complete && arms[0].tokens > 0 ? 1 - arms[1].tokens / arms[0].tokens : null,
    costDifferenceFraction: complete && arms[0].costCNY > 0 ? 1 - arms[1].costCNY / arms[0].costCNY : null,
    generalQualityEquivalenceEstablished: false,
    note: 'Five tasks with one run per arm give descriptive observations only; no statistical equivalence or full Verified score.' }
}

async function archiveSources(root) {
  const files = []
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, item.name)
      if (item.isDirectory()) await walk(file)
      else if (file.endsWith('.js')) files.push(file)
    }
  }
  for (const directory of ['src', 'scripts', 'test']) await walk(directory)
  files.push('package.json', 'scripts/benchmark/swe-grade.py')
  const index = []
  for (const file of files.sort()) {
    const target = join(root, 'source', file)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(file, target)
    index.push({ file, sha256: sha(await readFile(target)) })
  }
  await writeFile(join(root, 'source-index.json'), JSON.stringify(index, null, 2), { flag: 'wx', mode: 0o600 })
}

/** Fixed five-task pilot; all predictions are graded by the untouched official evaluator. */
export async function runSwePairedStudy(input) {
  const config = structuredClone(input)
  const root = resolve(config.root)
  const selectionFile = resolve(config.selectionFile)
  const selection = JSON.parse(await readFile(selectionFile, 'utf8'))
  if (selection.sample_n !== 5 || selection.tasks.some(task => task.official_source_comparison?.status !== 'matched')) throw new Error('Frozen official task comparison required')
  const scheduled = pairedSchedule(selection.tasks.map(task => task.instance_id))
  const pricing = config.pricing, cnyPricing = config.cnyPricing
  if (config.model !== 'deepseek-v4-pro' || pricing.model !== config.model || pricing.currency !== 'USD' || pricing.uncached !== 1.32 || pricing.cacheRead !== .044 || pricing.output !== 3.96 ||
      cnyPricing.currency !== 'CNY' || cnyPricing.uncached !== 9 || cnyPricing.cacheRead !== .3 || cnyPricing.output !== 27) throw new Error('Verified frozen Pro peak tariffs required')
  if (config.thinking !== 'enabled' || config.reasoningEffort !== 'high' || config.nativeInlineTokens !== 1200 || config.maxOutputTokens !== 8192 ||
      config.maxSteps !== 64 || config.maxCalls !== 80 || config.timeoutMs !== 900000 || config.maxTaskCNY !== 4 || config.maxStudyCNY !== 40 ||
      config.newUnknownReserveCNY !== 5 || config.userLimitCNY !== 70 || config.priorReserveCNY !== 18.02921736) throw new Error('Explicit authorized pilot limits required')
  if (config.priorReserveCNY + config.maxStudyCNY + config.newUnknownReserveCNY > config.userLimitCNY) throw new Error('User budget exceeded')
  if (JSON.stringify(config.pluginConfiguration) !== JSON.stringify({ mode: 'apply', tools: ['bash'], minInputBytes: 512, json: { enabled: true }, text: { enabled: true, minSavingsRatio: .1 }, logs: { enabled: true }, search: { enabled: false }, readText: { enabled: false } })) throw new Error('Frozen plugin configuration required')
  const ratio = Math.max(...['uncached', 'cacheRead', 'output'].map(key => cnyPricing[key] / pricing[key]))
  const maxTaskUSD = config.maxTaskCNY / ratio
  const sourceTreeHash = await acceptanceSourceHash(process.cwd())
  const gradingHash = sha(await readFile('scripts/benchmark/swe-grade.py'))
  const runtimeLockHash = sha(await readFile('.omx/integration-runtime/package-lock.json'))
  const identities = []
  for (const task of selection.tasks) {
    const prepared = config.tasks.find(row => row.instanceId === task.instance_id)
    if (!prepared) throw new Error('Missing prepared task')
    const taskFile = resolve(task.protected_row_path), evalScript = resolve(task.official_source_comparison.files['eval.sh'].path)
    const row = JSON.parse(await readFile(taskFile, 'utf8'))
    const expected = { taskHash: sha(await readFile(taskFile)), evalScriptHash: sha(await readFile(evalScript)), gradingHash,
      evaluationAdapterHash: sha(await readFile('scripts/benchmark/run-swe-canary.js')) }
    const preflight = JSON.parse(await readFile(prepared.preflightFile, 'utf8'))
    const image = JSON.parse((await run('docker', ['image', 'inspect', '--platform', 'linux/amd64', prepared.image])).stdout)[0]
    if (!preflight.verified || preflight.oracleResolved !== true || preflight.emptyResolved !== false || preflight.taskId !== task.instance_id ||
        preflight.imageId !== image.Id || image.Architecture !== 'amd64' || Object.keys(expected).some(key => expected[key] !== preflight[key])) throw new Error('Official preflight identity mismatch')
    if (prepared.image !== task.image_health.digest_pinned_official_ref) throw new Error('Official digest-pinned image required')
    identities.push({ instanceId: task.instance_id, taskFile, evalScript, expected, imageId: image.Id, imageReference: prepared.image, baseCommit: row.base_commit,
      preflightFile: resolve(prepared.preflightFile), preflightHash: sha(await readFile(prepared.preflightFile)) })
  }
  const selectionHash = sha(await readFile(selectionFile))
  async function frozen() {
    if (await acceptanceSourceHash(process.cwd()) !== sourceTreeHash || sha(await readFile('scripts/benchmark/swe-grade.py')) !== gradingHash ||
        sha(await readFile('.omx/integration-runtime/package-lock.json')) !== runtimeLockHash || sha(await readFile(selectionFile)) !== selectionHash) return false
    for (const item of identities) if (sha(await readFile(item.taskFile)) !== item.expected.taskHash || sha(await readFile(item.evalScript)) !== item.expected.evalScriptHash || sha(await readFile(item.preflightFile)) !== item.preflightHash) return false
    return true
  }
  await mkdir(root, { mode: 0o700 })
  await archiveSources(root)
  const plan = { version: 'verified-five-paired-v1', createdAt: new Date().toISOString(), head: (await run('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    config, scheduled, identities, sourceTreeHash, gradingHash, runtimeLockHash, selectionHash, maxTaskUSD,
    limitations: ['Five-task stratified pilot, not the full 500-task Verified score', 'One repetition per arm; task and model variability unresolved',
      'Provider alias and cache not independently isolated; adjacent pair order alternates 3:2', 'Official dsh AgentLoop restricted bash/read profile, not full CLI',
      'amd64 emulation on arm64', 'Uniform peak priced usage estimates, not invoice; logical calls not wire billing audit'] }
  await writeFile(join(root, 'study-plan.json'), JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 })
  const report = { plan, tasks: [], knownStudyCostCNY: 0, accountingComplete: true, finished: false }
  const save = () => writeFile(join(root, 'study-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  const append = event => appendFile(join(root, 'study-journal.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 })
  await mkdir(join(root, 'runs'), { mode: 0o700 })
  await save()
  const key = (await readFile(config.credentialFile, 'utf8')).trim()
  for (const slot of scheduled) {
    if (!await frozen()) { report.stoppedReason = 'source-or-runtime-drift'; break }
    if (report.knownStudyCostCNY + (2 - slot.slot % 2) * config.maxTaskCNY > config.maxStudyCNY + 1e-9) { report.stoppedReason = 'study-budget'; break }
    const task = identities[slot.taskIndex], row = JSON.parse(await readFile(task.taskFile, 'utf8'))
    const name = `dsh-fc-canary-${config.runSuffix}-${slot.slot}`
    const directory = join(root, 'runs', `${slot.slot}-${slot.instanceId}-${slot.group}`)
    let created = false, accountedCNY = 0, stage = 'container-create'
    await append({ type: 'slot/start', ...slot, reservedCNY: config.maxTaskCNY, containerName: name })
    try {
      await run('docker', ['run', '-d', '--platform', 'linux/amd64', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '4g', '--cpus', '2', '--name', name, '--entrypoint', '/bin/bash', task.imageReference, '-lc', 'sleep infinity'])
      created = true
      stage = 'baseline-reset'
      await run('docker', ['exec', '-w', '/testbed', name, 'git', 'config', 'core.fileMode', 'false'])
      await run('docker', ['exec', '-w', '/testbed', name, 'git', 'reset', '--hard', task.baseCommit])
      if ((await run('docker', ['exec', '-w', '/testbed', name, 'git', 'diff', '--binary', task.baseCommit])).stdout.trim()) throw new Error('Image baseline dirty')
      stage = 'agent-task'
      const result = await runSweCanaryTask({ directory, containerName: name, instanceId: slot.instanceId, baseCommit: task.baseCommit,
        problemStatement: row.problem_statement, key, pricing, group: slot.group, model: config.model, thinking: config.thinking, reasoningEffort: config.reasoningEffort,
        nativeInlineTokens: config.nativeInlineTokens, pluginConfiguration: config.pluginConfiguration, maxOutputTokens: config.maxOutputTokens,
        maxSteps: config.maxSteps, maxCalls: config.maxCalls, timeoutMs: config.timeoutMs, maxCostUSD: maxTaskUSD,
        commandExecutor: (container, command, signal) => dockerCommand(container, `source /opt/miniconda3/bin/activate testbed >/dev/null\n${command}`, signal),
        beforePatchExport: ({ containerName }) => clearContainerProcesses(containerName) })
      accountedCNY = result.modelCalls.reduce((sum, call) => sum + (pricedCNY(call.usage, cnyPricing) ?? 0), 0)
      report.knownStudyCostCNY += accountedCNY
      report.accountingComplete &&= result.usageComplete && result.modelCalls.every(completeCall) && pricedCNY(result.usage, cnyPricing) !== null
      await run('docker', ['rm', '-f', name]); created = false
      if (!await frozen()) throw new Error('Scoring inputs changed')
      stage = 'independent-evaluation'
      const quality = result.patchStatus === 'complete' ? await scorePatch({ containerName: `${name}-eval`, image: task.imageReference, patchFile: join(directory, 'model.patch'),
        evalScript: task.evalScript, directory: join(directory, 'evaluation'), taskFile: task.taskFile, harnessRoot: resolve(config.harnessRoot), expected: task.expected }) : { resolved: false, reason: 'patch-unavailable' }
      const record = { ...slot, result, quality, costCNY: result.usageComplete ? pricedCNY(result.usage, cnyPricing) : null }
      report.tasks.push(record)
      await append({ type: 'slot/end', ...slot, resolved: quality.resolved, tokens: totalTokens(result.usage), costCNY: record.costCNY, stop: result.stoppedReason })
      console.log(JSON.stringify({ ...slot, resolved: quality.resolved, agentCompleted: result.agentCompleted, tokens: totalTokens(result.usage), costCNY: record.costCNY, stop: result.stoppedReason }))
      if (!report.accountingComplete) report.stoppedReason = 'incomplete-accounting'
      else if (quality.infrastructureError) report.stoppedReason = 'evaluator-infrastructure-error'
      else if (accountedCNY > config.maxTaskCNY + 1e-9) report.stoppedReason = 'task-budget-overrun'
    } catch (error) {
      report.stoppedReason = 'study-execution-error'
      report.incompleteSlot = slot
      report.accountingComplete = false
      let recovered = { knownCNY: 0, unknownCalls: null, invalid: true }
      try { recovered = recoverPairedCalls(await readFile(join(directory, 'model-calls.jsonl'), 'utf8'), cnyPricing) } catch {}
      report.knownStudyCostCNY += additionalRecoveredCost(accountedCNY, recovered.knownCNY)
      await append({ type: 'slot/interrupted', ...slot, stage, failure: safeFailure(error), recovery: recovered })
    } finally {
      if (created) try { await run('docker', ['rm', '-f', name]) } catch { report.stoppedReason = 'task-container-cleanup-failed' }
      await save()
    }
    if (report.stoppedReason) break
  }
  report.sourceAfterMatches = await frozen()
  report.withinBudget = report.knownStudyCostCNY <= config.maxStudyCNY + 1e-9 && config.priorReserveCNY + report.knownStudyCostCNY + config.newUnknownReserveCNY <= config.userLimitCNY + 1e-9
  if (!report.sourceAfterMatches) report.stoppedReason = 'source-or-runtime-drift'
  if (!report.withinBudget) report.stoppedReason = 'budget-overrun'
  report.finished = report.tasks.length === scheduled.length && report.accountingComplete && !report.stoppedReason
  report.summary = summarizePaired(report)
  await save()
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('Usage: run-swe-paired.js --config private.json')
  const report = await runSwePairedStudy(JSON.parse(await readFile(resolve(process.argv[3]), 'utf8')))
  console.log(JSON.stringify({ finished: report.finished, stoppedReason: report.stoppedReason ?? null, knownStudyCostCNY: report.knownStudyCostCNY, summary: report.summary }))
  process.exitCode = report.finished ? 0 : 1
}
