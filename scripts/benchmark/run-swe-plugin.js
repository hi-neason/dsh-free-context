import { execFile } from 'node:child_process'
import { promisify, isDeepStrictEqual } from 'node:util'
import { readFile, writeFile, appendFile, mkdir, readdir, copyFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { acceptanceSourceHash } from '../acceptance-benchmark-cli.js'
import { safeFailure, validUsage } from '../evaluation-accounting.js'
import { runSweCanaryTask, dockerCommand, completeCall } from './swe-canary-agent.js'
import { clearContainerProcesses, scorePatch } from './run-swe-canary.js'
import { pricedCNY, recoverPairedCalls, additionalRecoveredCost, totalTokens } from './run-swe-paired.js'
import { validatePriorAccounting } from './settled-budget.js'

const execute = promisify(execFile)
const run = (command, args) => execute(command, args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024 })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const self = fileURLToPath(import.meta.url)
const eps = 1e-9
const groups = ['baseline-default', 'baseline-tuned']
const expectedIds = ['django__django-16116', 'django__django-12273', 'matplotlib__matplotlib-22871', 'sphinx-doc__sphinx-7910', 'sympy__sympy-12419']
const protocolKeys = ['model', 'thinking', 'reasoningEffort', 'maxOutputTokens', 'maxSteps', 'maxCalls', 'timeoutMs', 'maxTaskCNY', 'costGuard', 'pricing', 'cnyPricing', 'nativeInlineTokens', 'pluginConfiguration']

export function pluginSchedule(ids) {
  if (!isDeepStrictEqual(ids, expectedIds)) throw new Error('Exactly the frozen five tasks required')
  return ids.map((instanceId, taskIndex) => ({ instanceId, taskIndex, slot: taskIndex, repetition: 0, group: 'plugin' }))
}

export function actualTaskLimit(config, knownStudyCNY) {
  if (!Number.isFinite(config.priorKnownCNY) || config.priorKnownCNY < 35.1021018 || !Number.isFinite(knownStudyCNY) || knownStudyCNY < 0) throw new Error('Prior spent and accrued usage must be retained')
  const remainingCNY = Math.min(50 - config.priorKnownCNY - knownStudyCNY, 70 - 18.02921736 - config.priorKnownCNY - knownStudyCNY)
  const ratio = Math.max(...['uncached', 'cacheRead', 'output'].map(key => config.cnyPricing[key] / config.pricing[key]))
  return { remainingCNY, maxTaskUSD: Math.max(0, Math.min(config.maxTaskCNY, remainingCNY)) / ratio }
}

export function comparePlugin(baseline, report) {
  const complete = report.finished === true && report.accountingComplete === true && report.sourceAfterMatches === true && report.withinBudget === true && !report.stoppedReason && report.tasks.length === 5 &&
    report.tasks.every((row, index) => row.instanceId === expectedIds[index] && row.group === 'plugin' && row.result.usageComplete === true && validUsage(row.result.usage) && row.result.patchStatus === 'complete' && row.quality.infrastructureError === false && typeof row.quality.resolved === 'boolean' && row.quality.report?.[row.instanceId] && Number.isFinite(row.costCNY))
  if (!complete) return { complete: false, design: 'historical-cross-time-baseline-comparison', comparisons: null }
  const tokens = report.tasks.reduce((sum, row) => sum + totalTokens(row.result.usage), 0)
  const solved = report.tasks.filter(row => row.quality.resolved).length
  const costCNY = report.tasks.reduce((sum, row) => sum + row.costCNY, 0)
  return { complete: true, design: 'historical-cross-time-baseline-comparison', plugin: { tasks: 5, solved, totalTokens: tokens, costCNY }, comparisons: groups.map(group => ({ group,
    solvedDifference: solved - baseline.totals[group].solved,
    qualityObservedEqual: report.tasks.every(row => baseline.rows.find(item => item.group === group && item.instanceId === row.instanceId).resolved === row.quality.resolved),
    qualityNoRegression: report.tasks.every(row => !baseline.rows.find(item => item.group === group && item.instanceId === row.instanceId).resolved || row.quality.resolved),
    regressions: report.tasks.filter(row => baseline.rows.find(item => item.group === group && item.instanceId === row.instanceId).resolved && !row.quality.resolved).map(row => row.instanceId),
    improvements: report.tasks.filter(row => !baseline.rows.find(item => item.group === group && item.instanceId === row.instanceId).resolved && row.quality.resolved).map(row => row.instanceId),
    tokenSavingsRatio: 1 - tokens / baseline.totals[group].totalTokens,
    costSavingsRatio: 1 - costCNY / baseline.totals[group].costCNY,
    tasks: report.tasks.map(row => {
      const prior = baseline.rows.find(item => item.group === group && item.instanceId === row.instanceId)
      return { instanceId: row.instanceId, baselineResolved: prior.resolved, pluginResolved: row.quality.resolved, baselineTokens: prior.totalTokens, pluginTokens: totalTokens(row.result.usage), tokenSavingsRatio: 1 - totalTokens(row.result.usage) / prior.totalTokens }
    }) })) }
}

export function parseArguments(args) {
  const options = { run: false }
  const names = { '--baseline': 'baselineFile', '--reference-plan': 'referencePlan', '--root': 'root', '--plugin-config': 'pluginConfig', '--prior-spent-cny': 'priorKnownCNY', '--prior-accounting-file': 'priorAccountingFile' }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run' && !options.run) { options.run = true; continue }
    const name = names[args[i]]
    if (!name || options[name] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid arguments')
    options[name] = args[++i]
  }
  for (const key of ['baselineFile', 'referencePlan', 'root', 'priorKnownCNY']) if (options[key] === undefined) throw new Error(`Required: ${key}`)
  options.priorKnownCNY = Number(options.priorKnownCNY)
  if (!Number.isFinite(options.priorKnownCNY) || options.priorKnownCNY < 35.1021018) throw new Error('Prior spent cannot undercut known historical usage')
  return options
}

export async function preparePluginStudy(options) {
  const baselineFile = resolve(options.baselineFile), referencePlan = resolve(options.referencePlan), root = resolve(options.root)
  const bytes = await readFile(baselineFile), baseline = JSON.parse(bytes)
  const sidecar = join(dirname(baselineFile), 'baseline.sha256')
  if ((await readFile(sidecar, 'utf8')).trim() !== `${hash(bytes)}  baseline.json`) throw new Error('Frozen baseline checksum mismatch')
  const referenceBytes = await readFile(referencePlan), reference = JSON.parse(referenceBytes)
  if (baseline.version !== 'swe-verified-five-frozen-baselines-v1' || hash(referenceBytes) !== baseline.source.referencePlanHash || !isDeepStrictEqual(baseline.identities, reference.identities)) throw new Error('Frozen reference mismatch')
  for (const key of protocolKeys) if (!isDeepStrictEqual(baseline.protocol[key], reference.config[key])) throw new Error(`Protocol drift: ${key}`)
  const scheduled = pluginSchedule(baseline.identities.map(row => row.instanceId))
  if (baseline.rows.length !== 10) throw new Error('Expected ten frozen baseline rows')
  for (const group of groups) {
    const rows = baseline.rows.filter(row => row.group === group)
    if (rows.length !== 5 || expectedIds.some(id => rows.filter(row => row.instanceId === id).length !== 1) || rows.some(row => typeof row.resolved !== 'boolean' || !validUsage(row.usage) || totalTokens(row.usage) !== row.totalTokens || pricedCNY(row.usage, baseline.protocol.cnyPricing) === null || !Number.isFinite(row.costCNY) || Math.abs(pricedCNY(row.usage, baseline.protocol.cnyPricing) - row.costCNY) > eps)) throw new Error('Invalid frozen baseline rows')
    const total = baseline.totals[group]
    if (total.tasks !== 5 || total.solved !== rows.filter(row => row.resolved).length || total.totalTokens !== rows.reduce((sum, row) => sum + row.totalTokens, 0) || Math.abs(total.costCNY - rows.reduce((sum, row) => sum + row.costCNY, 0)) > eps) throw new Error('Frozen totals mismatch')
  }
  const config = { ...reference.config, root, priorKnownCNY: options.priorKnownCNY, authorizedAdditionalCNY: 50 }
  if (options.pluginConfig) config.pluginConfiguration = JSON.parse(await readFile(options.pluginConfig))
  const priorAccounting = options.priorAccountingFile
    ? await validatePriorAccounting(options.priorAccountingFile, config.priorKnownCNY, config.cnyPricing, root)
    : undefined
  const limit = actualTaskLimit(config, 0)
  const fixed = [ [baselineFile, hash(bytes)], [sidecar, hash(await readFile(sidecar))], [referencePlan, baseline.source.referencePlanHash],
    [config.selectionFile, baseline.source.selectionHash],
    ['scripts/benchmark/swe-grade.py', baseline.compatibility.gradingHash],
    ['scripts/benchmark/run-swe-canary.js', baseline.compatibility.evaluationAdapterHash],
    ['scripts/benchmark/swe-canary-agent.js', baseline.compatibility.evaluationAgentHash],
    ['.omx/integration-runtime/package-lock.json', baseline.compatibility.runtimeLockHash] ]
  for (const item of baseline.artifacts) {
    const file = resolve(dirname(baselineFile), item.file)
    if (!file.startsWith(dirname(baselineFile) + '/')) throw new Error('Baseline artifact escapes directory')
    fixed.push([file, item.sha256])
  }
  for (const task of baseline.identities) fixed.push([task.taskFile, task.expected.taskHash], [task.evalScript, task.expected.evalScriptHash], [task.preflightFile, task.preflightHash])
  if (options.pluginConfig) fixed.push([resolve(options.pluginConfig), hash(await readFile(options.pluginConfig))])
  if (priorAccounting) for (const item of priorAccounting.hashes) fixed.push([item.file, item.sha256])
  const sourceTreeHash = await acceptanceSourceHash(process.cwd())
  async function frozen() {
    if (await acceptanceSourceHash(process.cwd()) !== sourceTreeHash) return false
    for (const [file, sha256] of fixed) if (hash(await readFile(file)) !== sha256) return false
    return !priorAccounting || await priorAccounting.verifyInventory()
  }
  if (!await frozen()) throw new Error('Frozen baseline, evaluator, runtime or task drift')
  const plan = { version: 'swe-plugin-historical-comparison-v1', createdAt: new Date().toISOString(), root, config, scheduled, identities: baseline.identities, sourceTreeHash,
    ...(priorAccounting ? { priorAccounting: { ...priorAccounting.audit, file: priorAccounting.file, sha256: priorAccounting.sha256 } } : {}),
    baselineFile, baselineHash: hash(bytes), referencePlan, pluginConfigurationChanged: !isDeepStrictEqual(config.pluginConfiguration, baseline.protocol.pluginConfiguration),
    hashes: fixed.map(([file, sha256]) => ({ file, sha256 })),
    budget: { priorKnownCNY: config.priorKnownCNY, remainingCNY: limit.remainingCNY, reservationCNY: 0, historicalPriorCNY: 18.02921736, cumulativeAuthorizedCNY: 70 },
    design: 'Historical cross-time baseline comparison; only plugin reruns. Five previously observed tasks, not a held-out or full benchmark score; no statistical equivalence claim.' }
  return { plan, baseline, frozen, ...(priorAccounting ? { priorAccounting } : {}) }
}

async function archiveSources(root) {
  const files = []
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, item.name)
      if (item.isDirectory()) await walk(file)
      else if (item.isFile() && file.endsWith('.js')) files.push(file)
    }
  }
  for (const directory of ['src', 'scripts', 'test']) await walk(directory)
  files.push('package.json', 'scripts/benchmark/swe-grade.py')
  const index = []
  for (const file of files.sort()) {
    const target = join(root, 'source', file)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(file, target)
    index.push({ file, sha256: hash(await readFile(target)) })
  }
  await writeFile(join(root, 'source-index.json'), JSON.stringify(index, null, 2), { flag: 'wx', mode: 0o600 })
}

export async function runPluginStudy(options) {
  const { plan, baseline, frozen, priorAccounting } = await preparePluginStudy(options)
  const root = plan.root
  const config = plan.config
  for (const task of plan.identities) {
    const image = JSON.parse((await run('docker', ['image', 'inspect', '--platform', 'linux/amd64', task.imageReference])).stdout)[0]
    if (image.Id !== task.imageId || image.Architecture !== 'amd64') throw new Error('Pinned image drift')
  }
  await mkdir(root, { mode: 0o700 })
  await archiveSources(root)
  if (priorAccounting) await writeFile(join(root, 'prior-accounting.json'), priorAccounting.ledgerBytes, { flag: 'wx', mode: 0o600 })
  await writeFile(join(root, 'study-plan.json'), JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 })
  await copyFile(self, join(root, 'runner.mjs'))
  await writeFile(join(root, 'config.json'), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 })
  if (!await frozen()) throw new Error('Freeze changed during archive; no model call made')
  const report = { plan, tasks: [], knownStudyCostCNY: 0, priorKnownCNY: config.priorKnownCNY, accountingComplete: true, finished: false }
  const save = () => writeFile(join(root, 'study-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  const append = value => appendFile(join(root, 'study-journal.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 })
  await mkdir(join(root, 'runs'), { mode: 0o700 })
  await save()
  const key = (await readFile(config.credentialFile, 'utf8')).trim()
  for (const slot of plan.scheduled) {
    if (!await frozen()) { report.stoppedReason = 'source-or-runtime-drift'; break }
    const limit = actualTaskLimit(config, report.knownStudyCostCNY)
    if (limit.remainingCNY <= 0) { report.stoppedReason = 'study-budget-actual'; break }
    const task = plan.identities[slot.taskIndex], row = JSON.parse(await readFile(task.taskFile))
    const name = `dsh-fc-canary-plugin-${hash(root).slice(0, 12)}-${slot.slot}`
    const directory = join(root, 'runs', `${slot.slot}-${slot.instanceId}-${slot.group}`)
    let created = false, accountedCNY = 0, stage = 'container-create'
    await append({ type: 'slot/start', ...slot, reservedCNY: 0, actualCapCNY: Math.min(config.maxTaskCNY, limit.remainingCNY), containerName: name })
    try {
      await run('docker', ['run', '-d', '--platform', 'linux/amd64', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '4g', '--cpus', '2', '--name', name, '--entrypoint', '/bin/bash', task.imageReference, '-lc', 'sleep infinity'])
      created = true
      stage = 'baseline-reset'
      await run('docker', ['exec', '-w', '/testbed', name, 'git', 'config', 'core.fileMode', 'false'])
      await run('docker', ['exec', '-w', '/testbed', name, 'git', 'reset', '--hard', task.baseCommit])
      if ((await run('docker', ['exec', '-w', '/testbed', name, 'git', 'diff', '--binary', task.baseCommit])).stdout.trim()) throw new Error('Image baseline dirty')
      stage = 'agent-task'
      const result = await runSweCanaryTask({ directory, containerName: name, instanceId: slot.instanceId, baseCommit: task.baseCommit,
        problemStatement: row.problem_statement, key, pricing: config.pricing, group: slot.group, model: config.model, thinking: config.thinking, reasoningEffort: config.reasoningEffort,
        nativeInlineTokens: config.nativeInlineTokens, costGuard: config.costGuard, pluginConfiguration: config.pluginConfiguration, maxOutputTokens: config.maxOutputTokens,
        maxSteps: config.maxSteps, maxCalls: config.maxCalls, timeoutMs: config.timeoutMs, maxCostUSD: limit.maxTaskUSD,
        commandExecutor: (container, command, signal) => dockerCommand(container, `source /opt/miniconda3/bin/activate testbed >/dev/null\n${command}`, signal),
        beforePatchExport: ({ containerName }) => clearContainerProcesses(containerName) })
      accountedCNY = result.modelCalls.reduce((sum, call) => sum + (pricedCNY(call.usage, config.cnyPricing) ?? 0), 0)
      report.knownStudyCostCNY += accountedCNY
      const recovered = recoverPairedCalls(await readFile(join(directory, 'model-calls.jsonl'), 'utf8'), config.cnyPricing)
      report.accountingComplete &&= result.usageComplete && result.modelCalls.every(completeCall) && pricedCNY(result.usage, config.cnyPricing) !== null &&
        !recovered.invalid && recovered.unknownCalls === 0 && Math.abs(recovered.knownCNY - accountedCNY) <= eps
      await run('docker', ['rm', '-f', name]); created = false
      if (!await frozen()) throw new Error('Scoring inputs changed')
      stage = 'independent-evaluation'
      const quality = result.patchStatus === 'complete' ? await scorePatch({ containerName: `${name}-eval`, image: task.imageReference,
        patchFile: join(directory, 'model.patch'), evalScript: task.evalScript, directory: join(directory, 'evaluation'), taskFile: task.taskFile,
        harnessRoot: resolve(config.harnessRoot), expected: task.expected }) : { resolved: false, reason: 'patch-unavailable' }
      const record = { ...slot, result, quality, costCNY: result.usageComplete ? pricedCNY(result.usage, config.cnyPricing) : null,
        actualTaskCapCNY: Math.min(config.maxTaskCNY, limit.remainingCNY), actualTaskCapReached: accountedCNY >= Math.min(config.maxTaskCNY, limit.remainingCNY) }
      report.tasks.push(record)
      await append({ type: 'slot/end', ...slot, resolved: quality.resolved, tokens: totalTokens(result.usage), costCNY: record.costCNY, stop: result.stoppedReason })
      console.log(JSON.stringify({ ...slot, resolved: quality.resolved, agentCompleted: result.agentCompleted, tokens: totalTokens(result.usage), costCNY: record.costCNY, stop: result.stoppedReason }))
      if (!report.accountingComplete) report.stoppedReason = 'incomplete-accounting'
      else if (quality.infrastructureError) report.stoppedReason = 'evaluator-infrastructure-error'
      else if (report.priorKnownCNY + report.knownStudyCostCNY >= config.authorizedAdditionalCNY && slot.slot !== plan.scheduled.at(-1).slot) report.stoppedReason = 'study-budget-actual'
    } catch (error) {
      report.stoppedReason = 'study-execution-error'
      report.incompleteSlot = slot
      report.accountingComplete = false
      let recovered = { knownCNY: 0, unknownCalls: null, invalid: true }
      try { recovered = recoverPairedCalls(await readFile(join(directory, 'model-calls.jsonl'), 'utf8'), config.cnyPricing) } catch {}
      report.knownStudyCostCNY += additionalRecoveredCost(accountedCNY, recovered.knownCNY)
      await append({ type: 'slot/interrupted', ...slot, stage, failure: safeFailure(error), recovery: recovered })
    } finally {
      if (created) try { await run('docker', ['rm', '-f', name]) } catch { report.stoppedReason = 'task-container-cleanup-failed'; report.cleanupFailure = { containerName: name, slot: slot.slot } }
      await save()
    }
    if (report.stoppedReason) break
  }
  try { report.sourceAfterMatches = await frozen() } catch { report.sourceAfterMatches = false }
  report.combinedKnownCNY = report.priorKnownCNY + report.knownStudyCostCNY
  report.withinBudget = report.combinedKnownCNY <= config.authorizedAdditionalCNY + eps &&
    plan.budget.historicalPriorCNY + report.combinedKnownCNY <= plan.budget.cumulativeAuthorizedCNY + eps
  if (!report.sourceAfterMatches) report.stoppedReason = 'source-or-runtime-drift'
  if (!report.withinBudget) report.stoppedReason = 'budget-overrun'
  report.finished = report.tasks.length === 5 && new Set(report.tasks.map(row => `${row.instanceId}/${row.group}`)).size === 5 && report.accountingComplete && !report.stoppedReason
  report.comparison = comparePlugin(baseline, report)
  report.finished &&= report.comparison.complete
  if (!report.finished && !report.stoppedReason) report.stoppedReason = 'incomplete-official-results'
  await save()
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArguments(process.argv.slice(2))
  if (options.run) {
    const report = await runPluginStudy(options)
    console.log(JSON.stringify({ finished: report.finished, stoppedReason: report.stoppedReason, comparison: report.comparison }, null, 2))
    process.exitCode = report.finished ? 0 : 1
  } else {
    const { plan } = await preparePluginStudy(options)
    console.log(JSON.stringify({ mode: 'plan-only', paidCalls: 0, plan }, null, 2))
  }
}
