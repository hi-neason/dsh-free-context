import { execFile } from 'node:child_process'
import { promisify, isDeepStrictEqual } from 'node:util'
import { readFile, writeFile, appendFile, mkdir, readdir, copyFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { acceptanceSourceHash } from '../acceptance-benchmark-cli.js'
import { safeFailure } from '../evaluation-accounting.js'
import { parseConfig } from '../../src/config.js'
import { runSweCanaryTask, dockerCommand } from './swe-canary-agent.js'
import { clearContainerProcesses, scorePatch } from './run-swe-canary.js'
import { pricedCNY, recoverPairedCalls, additionalRecoveredCost, totalTokens } from './run-swe-paired.js'
import { comparePlugin } from './run-swe-plugin.js'
import { verifyPriorCalls } from './settled-budget.js'

const execute = promisify(execFile)
const run = (command, args) => execute(command, args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024 })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const self = fileURLToPath(import.meta.url)
const model = 'deepseek-flash'
const groups = ['baseline-default', 'baseline-tuned', 'plugin']
const ids = ['django__django-16116', 'django__django-12273', 'matplotlib__matplotlib-22871', 'sphinx-doc__sphinx-7910', 'sympy__sympy-12419']
const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-8
const requireValue = (value, message) => { if (!value) throw new Error(message) }

export function flashSchedule(taskIds, pluginOnly = false) {
  requireValue(isDeepStrictEqual(taskIds, ids), 'Exactly the original frozen five tasks required')
  return ids.flatMap((instanceId, taskIndex) => (pluginOnly ? ['plugin'] : groups.map((_, position) => groups[(taskIndex + position) % groups.length]))
    .map(group => ({ instanceId, taskIndex, group, repetition: 0 }))).map((slot, index) => ({ ...slot, slot: index }))
}

export function validateFlashPricing(input) {
  const { pricing, cnyPricing } = input
  requireValue(pricing?.model === model && pricing.currency === 'USD' && pricing.uncached === .3 && pricing.cacheRead === .006 && pricing.output === 1.2 &&
    cnyPricing?.currency === 'CNY' && cnyPricing.uncached === 2 && cnyPricing.cacheRead === .04 && cnyPricing.output === 8,
  'Verified deepseek-flash uniform peak tariffs required')
  requireValue(pricing.documentedModelVersion === 'DeepSeek-V4.1-Flash-1017' && pricing.verifiedDate === '2026-11-04' &&
    pricing.sourceUrl === 'https://api-docs.deepseek.com/quick_start/pricing/' && cnyPricing.sourceUrl === 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  'Flash pricing provenance mismatch')
  return { pricing, cnyPricing }
}

export function flashTaskLimit(config, knownStudyCNY) {
  requireValue(Number.isFinite(config.priorKnownCNY) && config.priorKnownCNY >= 0 && Number.isFinite(knownStudyCNY) && knownStudyCNY >= 0,
    'Complete prior and accrued cost required')
  const remainingCNY = Math.min(50 - config.priorKnownCNY - knownStudyCNY, 70 - 18.02921736 - config.priorKnownCNY - knownStudyCNY)
  const ratio = Math.max(...['uncached', 'cacheRead', 'output'].map(key => config.cnyPricing[key] / config.pricing[key]))
  return { remainingCNY, maxTaskUSD: Math.max(0, Math.min(4, remainingCNY)) / ratio }
}

export async function validateFlashPrior(file, currentRoot) {
  const bytes = await readFile(file), ledger = JSON.parse(bytes), fixed = [[resolve(file), hash(bytes)]]
  requireValue(ledger.version === 'swe-flash-prior-accounting-v1' && ledger.accountingComplete === true &&
    ledger.authorizedAdditionalCNY === 50 && ledger.historicalPriorCNY === 18.02921736 && ledger.cumulativeAuthorizedCNY === 70,
  'Complete reconciled Flash prior accounting required')
  requireValue(ledger.inputHashes && Object.keys(ledger.inputHashes).length > 0 && Array.isArray(ledger.components) && ledger.components.length > 0,
    'Prior evidence and components required')
  for (const [name, sha256] of Object.entries(ledger.inputHashes)) {
    requireValue(typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256) && hash(await readFile(name)) === sha256, 'Prior evidence checksum mismatch')
    fixed.push([resolve(name), sha256])
  }
  const scopes = new Set(), coveredReports = new Set()
  const evidenceHashes = new Map(Object.entries(ledger.inputHashes).map(([name, sha256]) => [resolve(name), sha256]))
  const directory = dirname(resolve(currentRoot))
  let sum = 0
  for (const component of ledger.components) {
    requireValue(typeof component.scope === 'string' && component.scope && !scopes.has(component.scope) &&
      ['settled-wallet', 'observed-peak'].includes(component.mode) && Number.isFinite(component.costCNY) && component.costCNY >= 0,
    'Invalid or duplicate prior component')
    scopes.add(component.scope)
    requireValue(component.evidenceHash === ledger.inputHashes[component.evidenceFile], 'Unbound prior component evidence')
    const evidence = JSON.parse(await readFile(component.evidenceFile))
    requireValue(evidence.allChecksPass === true && (evidence.decision === 'eligible' || evidence.accountingComplete === true) &&
      evidence.checks && Object.keys(evidence.checks).length > 0 && Object.values(evidence.checks).every(value => value === true),
    'Prior component accounting remains incomplete')
    requireValue(typeof component.amountField === 'string' && component.amountField.length > 0, 'Prior component amount field required')
    let amount = evidence
    for (const key of component.amountField.split('.')) {
      requireValue(amount && Object.hasOwn(amount, key), 'Prior component amount is absent')
      amount = amount[key]
    }
    requireValue(near(Number(amount), component.costCNY), 'Prior component amount mismatch')
    if (component.mode === 'settled-wallet') {
      const required = { 'nov2-nov3-settled': 'oldScopeWalletCNY', 'nov4-pro-history-settled': 'actualProviderWalletCNY', 'nov4-flash-parent-settled': 'actualProviderWalletCNY' }
      requireValue(required[component.scope] === component.amountField && evidence.inputHashes, 'Unknown settled scope')
      for (const [name, sha256] of Object.entries(evidence.inputHashes)) {
        requireValue(evidenceHashes.get(resolve(name)) === sha256, 'Settled scope evidence is not fully bound')
      }
      if (component.scope === 'nov4-flash-parent-settled') requireValue(isDeepStrictEqual(evidence.budgetComponent?.scope, ['flash-study-20261104-v1']),
        'Flash settlement must cover exact parent only')
      const phases = component.scope === 'nov2-nov3-settled' ? evidence.scopes?.flatMap(scope => scope.phases) : evidence.budgetComponent?.scope
      requireValue(Array.isArray(phases) && phases.length > 0 && new Set(phases).size === phases.length, 'Settled financial scope is absent or duplicated')
      if (component.scope !== 'nov2-nov3-settled') requireValue(evidence.budgetComponent.mode === 'settled-wallet' &&
        near(Number(evidence.budgetComponent.costCNY), component.costCNY), 'Settled financial amount mismatch')
      const proofHashes = new Map(Object.entries(evidence.inputHashes).map(([name, sha256]) => [resolve(name), sha256]))
      for (const phase of phases) {
        requireValue(typeof phase === 'string' && /^[\w-]+$/.test(phase), 'Invalid settled study identity')
        const reportFile = join(directory, phase, 'study-report.json')
        requireValue(proofHashes.has(reportFile) && evidenceHashes.has(reportFile) && !coveredReports.has(reportFile), 'Missing or doubly counted settled study')
        coveredReports.add(reportFile)
      }
    } else {
      requireValue(typeof component.reportFile === 'string' && evidenceHashes.has(resolve(component.reportFile)), 'Observed study report required')
      const report = JSON.parse(await readFile(component.reportFile))
      requireValue(report.finished && report.accountingComplete && report.sourceAfterMatches && report.withinBudget && !report.stoppedReason &&
        report.plan?.config.model === model && Array.isArray(report.tasks), 'Observed Flash study remains incomplete')
      validateFlashPricing(report.plan.config)
      let observed = 0
      for (const row of report.tasks) {
        const rawFile = join(dirname(resolve(component.reportFile)), 'runs', `${row.slot}-${row.instanceId}-${row.group}`, 'model-calls.jsonl')
        requireValue(evidenceHashes.has(rawFile), 'Unbound observed usage')
        const cost = verifyPriorCalls(row.result, await readFile(rawFile, 'utf8'), report.plan.config.cnyPricing)
        requireValue(row.result.model === model && near(cost, row.costCNY), 'Observed Flash usage mismatch')
        observed += cost
      }
      requireValue(report.tasks.length === report.plan.scheduled.length && near(observed, report.knownStudyCostCNY) && near(observed, component.costCNY),
        'Observed study component mismatch')
      requireValue(!coveredReports.has(resolve(component.reportFile)), 'Duplicate observed cost scope')
      coveredReports.add(resolve(component.reportFile))
    }
    sum += component.costCNY
  }
  requireValue(scopes.has('nov2-nov3-settled') && scopes.has('nov4-pro-history-settled'), 'Required settled history is missing')
  requireValue(near(sum, ledger.priorKnownCNY), 'Prior components must sum exactly once')
  async function inventory() {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      if (!child.isDirectory() || resolve(directory, child.name) === resolve(currentRoot)) continue
      const reportFile = join(directory, child.name, 'study-report.json')
      try { await readFile(reportFile) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      requireValue(evidenceHashes.has(reportFile) && coveredReports.has(reportFile), 'Prior ledger omits a study cost component')
      const runs = join(directory, child.name, 'runs')
      let entries = []
      try { entries = await readdir(runs, { withFileTypes: true }) } catch (error) { if (error.code !== 'ENOENT') throw error }
      for (const entry of entries.filter(item => item.isDirectory())) {
        const journal = join(runs, entry.name, 'model-calls.jsonl')
        try { await readFile(journal) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
        requireValue(evidenceHashes.has(journal), 'Prior ledger omits an attempted run')
      }
    }
    return true
  }
  await inventory()
  return { ledger, bytes, fixed, inventory }
}

export function parseArguments(args) {
  const result = { run: false, pluginOnly: false }
  const names = { '--baseline': 'baselineFile', '--reference-plan': 'referencePlan', '--root': 'root', '--pricing-file': 'pricingFile',
    '--prior-accounting-file': 'priorAccountingFile', '--plugin-config': 'pluginConfig' }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--run' && !result.run) { result.run = true; continue }
    if (args[index] === '--plugin-only' && !result.pluginOnly) { result.pluginOnly = true; continue }
    const key = names[args[index]]
    requireValue(key && result[key] === undefined && args[index + 1] && !args[index + 1].startsWith('--'), 'Invalid Flash runner arguments')
    result[key] = args[++index]
  }
  for (const key of Object.values(names)) requireValue(result[key], `Required: ${key}`)
  return result
}

export async function prepareFlashStudy(options) {
  const root = resolve(options.root), baselineFile = resolve(options.baselineFile), referencePlan = resolve(options.referencePlan)
  const baselineBytes = await readFile(baselineFile), baseline = JSON.parse(baselineBytes)
  const sidecar = join(dirname(baselineFile), 'baseline.sha256')
  requireValue((await readFile(sidecar, 'utf8')).trim() === `${hash(baselineBytes)}  baseline.json`, 'Frozen task source checksum mismatch')
  const referenceBytes = await readFile(referencePlan), reference = JSON.parse(referenceBytes)
  requireValue(baseline.version === 'swe-verified-five-frozen-baselines-v1' && hash(referenceBytes) === baseline.source.referencePlanHash &&
    isDeepStrictEqual(baseline.identities, reference.identities), 'Frozen task reference mismatch')
  const scheduled = flashSchedule(baseline.identities.map(task => task.instanceId), options.pluginOnly)
  const priceBytes = await readFile(options.pricingFile), prices = validateFlashPricing(JSON.parse(priceBytes))
  const pluginBytes = await readFile(options.pluginConfig), pluginConfiguration = JSON.parse(pluginBytes)
  const parsed = parseConfig(pluginConfiguration)
  requireValue(parsed.mode === 'apply' && isDeepStrictEqual(parsed.tools, ['bash']), 'Flash plugin requires apply mode and bash tools')
  if (!options.pluginOnly) requireValue(parsed.executionHints?.enabled === true && !parsed.retirement.enabled && !parsed.checkpoint?.enabled,
    'Initial Flash cohort requires explicit execution-hint configuration')
  const prior = await validateFlashPrior(resolve(options.priorAccountingFile), root)
  const config = { root, selectionFile: reference.config.selectionFile, credentialFile: reference.config.credentialFile,
    harnessRoot: reference.config.harnessRoot, model, thinking: 'enabled', reasoningEffort: 'high',
    nativeInlineTokensByGroup: { 'baseline-default': 12500, 'baseline-tuned': 1200, plugin: 1200 },
    maxOutputTokens: 8192, maxSteps: 64, maxCalls: 80, timeoutMs: 900000, maxTaskCNY: 4, costGuard: 'actual-usage',
    ...prices, pluginConfiguration, priorKnownCNY: prior.ledger.priorKnownCNY, authorizedAdditionalCNY: 50 }
  const fixed = [[baselineFile, hash(baselineBytes)], [sidecar, hash(await readFile(sidecar))], [referencePlan, hash(referenceBytes)],
    [resolve(options.pricingFile), hash(priceBytes)], [resolve(options.pluginConfig), hash(pluginBytes)],
    [resolve(config.selectionFile), baseline.source.selectionHash],
    ['scripts/benchmark/swe-grade.py', baseline.compatibility.gradingHash],
    ['scripts/benchmark/run-swe-canary.js', baseline.compatibility.evaluationAdapterHash],
    ['.omx/integration-runtime/package-lock.json', baseline.compatibility.runtimeLockHash], ...prior.fixed]
  const evaluationAgentHash = hash(await readFile('scripts/benchmark/swe-canary-agent.js'))
  fixed.push(['scripts/benchmark/swe-canary-agent.js', evaluationAgentHash])
  for (const task of baseline.identities) fixed.push([task.taskFile, task.expected.taskHash], [task.evalScript, task.expected.evalScriptHash], [task.preflightFile, task.preflightHash])
  for (const artifact of baseline.artifacts) {
    const file = resolve(dirname(baselineFile), artifact.file)
    requireValue(file.startsWith(dirname(baselineFile) + '/'), 'Frozen artifact escapes directory')
    fixed.push([file, artifact.sha256])
  }
  if (options.pluginOnly) {
    requireValue(baseline.protocol.model === model && baseline.compatibility.evaluationAgentHash === evaluationAgentHash, 'Flash baseline and common agent required')
    for (const key of ['model', 'thinking', 'reasoningEffort', 'nativeInlineTokensByGroup', 'maxOutputTokens', 'maxSteps', 'maxCalls', 'timeoutMs', 'maxTaskCNY', 'costGuard', 'pricing', 'cnyPricing']) {
      requireValue(isDeepStrictEqual(baseline.protocol[key], config[key]), `Flash protocol drift: ${key}`)
    }
  }
  const sourceTreeHash = await acceptanceSourceHash(process.cwd())
  async function frozen() {
    if (await acceptanceSourceHash(process.cwd()) !== sourceTreeHash) return false
    for (const [file, sha256] of fixed) if (hash(await readFile(file)) !== sha256) return false
    return prior.inventory()
  }
  requireValue(await frozen(), 'Frozen Flash inputs changed')
  const plan = { version: 'swe-flash-three-arm-v1', createdAt: new Date().toISOString(), root, config, scheduled,
    identities: baseline.identities, sourceTreeHash, taskSourceBaseline: baselineFile, taskSourceBaselineHash: hash(baselineBytes), referencePlan,
    comparisonModel: model, pluginOnly: options.pluginOnly === true, hashes: fixed.map(([file, sha256]) => ({ file: resolve(file), sha256 })),
    compatibility: { ...baseline.compatibility, evaluationAgentHash },
    budget: { priorKnownCNY: config.priorKnownCNY, remainingCNY: flashTaskLimit(config, 0).remainingCNY,
      reservationCNY: 0, historicalPriorCNY: 18.02921736, authorizedAdditionalCNY: 50, cumulativeAuthorizedCNY: 70 },
    design: options.pluginOnly ? 'Flash-only historical baseline comparison' : 'Fixed five-task Flash-only three-arm pilot with rotating order' }
  return { plan, baseline, frozen, prior }
}

export function flashComparison(report, frozenBaseline) {
  const complete = report.finished === true && report.accountingComplete === true && report.sourceAfterMatches === true && report.withinBudget === true &&
    report.plan.config.model === model && report.tasks.length === report.plan.scheduled.length &&
    report.tasks.every(row => row.result.model === model && row.result.nativeInlineTokens === report.plan.config.nativeInlineTokensByGroup[row.group] && row.result.simulated === false && row.result.usageComplete && row.result.patchStatus === 'complete' &&
      row.quality.infrastructureError === false && typeof row.quality.resolved === 'boolean' &&
      row.quality.report?.[row.instanceId]?.resolved === row.quality.resolved && row.quality.report[row.instanceId].infra_failure === false && Number.isFinite(row.costCNY))
  if (!complete) return { complete: false, model, comparisons: null }
  const rowKey = row => `${row.instanceId}/${row.group}`
  requireValue(new Set(report.tasks.map(rowKey)).size === report.plan.scheduled.length &&
    report.plan.scheduled.every(slot => report.tasks.some(row => rowKey(row) === rowKey(slot))), 'Flash task coverage mismatch')
  const controls = report.tasks.filter(row => row.group !== 'plugin')
  const baseline = report.plan.pluginOnly ? frozenBaseline : baselineFromRows(report, controls)
  requireValue(baseline?.protocol.model === model, 'Cross-model comparison forbidden')
  const pluginReport = { ...report, tasks: ids.map(id => report.tasks.find(row => row.instanceId === id && row.group === 'plugin')) }
  return { ...comparePlugin(baseline, pluginReport), model }
}

function baselineFromRows(report, controls) {
  const rows = controls.map(row => ({ group: row.group, instanceId: row.instanceId, usage: row.result.usage, totalTokens: totalTokens(row.result.usage),
    resolved: row.quality.resolved, costCNY: row.costCNY }))
  const totals = Object.fromEntries(groups.slice(0, 2).map(group => {
    const selected = rows.filter(row => row.group === group)
    requireValue(selected.length === 5, 'Ten complete Flash controls required')
    return [group, { tasks: 5, solved: selected.filter(row => row.resolved).length,
      totalTokens: selected.reduce((sum, row) => sum + row.totalTokens, 0), costCNY: selected.reduce((sum, row) => sum + row.costCNY, 0) }]
  }))
  return { version: 'swe-verified-five-frozen-baselines-v1', protocol: report.plan.config, rows, totals }
}

export async function freezeFlashBaselines(report) {
  requireValue(!report.plan.pluginOnly && flashComparison(report).complete, 'Complete Flash cohort required before freezing controls')
  const root = join(report.plan.root, 'frozen-baselines')
  await mkdir(root, { mode: 0o700 })
  const controls = report.tasks.filter(row => row.group !== 'plugin'), baseline = baselineFromRows(report, controls), artifacts = []
  for (const row of controls) {
    const runName = `${row.slot}-${row.instanceId}-${row.group}`
    const runRoot = join(report.plan.root, 'runs', runName)
    const storedResult = JSON.parse(await readFile(join(runRoot, 'result.json')))
    const raw = await readFile(join(runRoot, 'model-calls.jsonl'), 'utf8')
    const grade = JSON.parse(await readFile(join(runRoot, 'evaluation/official-grade.json')))
    requireValue(isDeepStrictEqual(storedResult, row.result) && isDeepStrictEqual(grade.report, row.quality.report) &&
      near(verifyPriorCalls(storedResult, raw, report.plan.config.cnyPricing), row.costCNY), 'Flash baseline artifacts do not match scored results')
    for (const file of ['result.json', 'model-calls.jsonl', 'evaluation/official-grade.json']) {
      const target = join(root, runName, file)
      await mkdir(dirname(target), { recursive: true })
      const bytes = await readFile(join(report.plan.root, 'runs', runName, file))
      await writeFile(target, bytes, { flag: 'wx', mode: 0o444 })
      artifacts.push({ file: `${runName}/${file}`, sha256: hash(bytes) })
    }
  }
  const planFile = join(report.plan.root, 'study-plan.json')
  Object.assign(baseline, { identities: report.plan.identities, artifacts, compatibility: report.plan.compatibility,
    source: { referencePlan: planFile, referencePlanHash: hash(await readFile(planFile)), sourceTreeHash: report.plan.sourceTreeHash,
      selectionHash: hash(await readFile(report.plan.config.selectionFile)) } })
  const bytes = Buffer.from(JSON.stringify(baseline, null, 2) + '\n')
  await writeFile(join(root, 'baseline.json'), bytes, { flag: 'wx', mode: 0o444 })
  await writeFile(join(root, 'baseline.sha256'), `${hash(bytes)}  baseline.json\n`, { flag: 'wx', mode: 0o444 })
  await writeFile(join(root, 'tasks.csv'), ['group,instanceId,resolved,totalTokens,inputTokens,cacheReadTokens,cacheWriteTokens,outputTokens,costCNY',
    ...baseline.rows.map(row => [row.group, row.instanceId, row.resolved, row.totalTokens, ...['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'].map(key => row.usage[key] ?? 0), row.costCNY].join(','))].join('\n') + '\n', { flag: 'wx', mode: 0o444 })
  await writeFile(join(root, 'checksums.sha256'), artifacts.map(item => `${item.sha256}  ${item.file}`).join('\n') + '\n', { flag: 'wx', mode: 0o444 })
  return { file: join(root, 'baseline.json'), sha256: hash(bytes), model }
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

export async function runFlashStudy(options, services = {}) {
  const command = services.command ?? run, taskRunner = services.taskRunner ?? runSweCanaryTask, scorer = services.scorer ?? scorePatch
  const { plan, baseline, frozen, prior } = await (services.prepare ?? prepareFlashStudy)(options)
  requireValue(plan.config.model === model, 'Only deepseek-flash may run')
  const root = plan.root, config = plan.config
  for (const task of plan.identities) {
    const image = JSON.parse((await command('docker', ['image', 'inspect', '--platform', 'linux/amd64', task.imageReference])).stdout)[0]
    requireValue(image.Id === task.imageId && image.Architecture === 'amd64', 'Pinned image drift')
  }
  await mkdir(root, { mode: 0o700 })
  await archiveSources(root)
  await writeFile(join(root, 'prior-accounting.json'), prior.bytes, { flag: 'wx', mode: 0o600 })
  await writeFile(join(root, 'study-plan.json'), JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 })
  await writeFile(join(root, 'config.json'), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 })
  await copyFile(self, join(root, 'runner.mjs'))
  requireValue(await frozen(), 'Freeze changed before provider setup')
  const report = { plan, tasks: [], priorKnownCNY: config.priorKnownCNY, knownStudyCostCNY: 0, accountingComplete: true, finished: false }
  const save = () => writeFile(join(root, 'study-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  const journal = value => appendFile(join(root, 'study-journal.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 })
  await mkdir(join(root, 'runs'), { mode: 0o700 })
  await save()
  const key = (await readFile(config.credentialFile, 'utf8')).trim()
  for (const slot of plan.scheduled) {
    if (!await frozen()) { report.stoppedReason = 'source-or-input-drift'; break }
    const limit = flashTaskLimit(config, report.knownStudyCostCNY)
    if (limit.remainingCNY <= 0) { report.stoppedReason = 'study-budget-actual'; break }
    const task = plan.identities[slot.taskIndex], problem = JSON.parse(await readFile(task.taskFile))
    const name = `dsh-fc-canary-flash-${hash(root).slice(0, 12)}-${slot.slot}`, names = [name, `${name}-eval`]
    const directory = join(root, 'runs', `${slot.slot}-${slot.instanceId}-${slot.group}`)
    const claimed = [], attempted = new Set()
    let accountedCNY = 0, stage = 'container-preflight'
    async function containerId(container) {
      const result = await command('docker', ['ps', '-aq', '--filter', `name=^/${container}$`, '--no-trunc'])
      const value = result.stdout.trim()
      requireValue(!value || /^[a-f0-9]{64}$/.test(value), 'Ambiguous owned container identity')
      return value
    }
    async function cleanup(container) {
      if (!claimed.includes(container) || !attempted.has(container)) return
      const id = await containerId(container)
      if (id) await command('docker', ['rm', '-f', id])
    }
    await journal({ type: 'slot/start', ...slot, reservedCNY: 0, actualCapCNY: Math.min(4, limit.remainingCNY), containerName: name })
    try {
      for (const container of names) { requireValue(!await containerId(container), 'Container name already exists'); claimed.push(container) }
      stage = 'container-create'
      attempted.add(name)
      await command('docker', ['run', '-d', '--platform', 'linux/amd64', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '4g', '--cpus', '2', '--name', name, '--entrypoint', '/bin/bash', task.imageReference, '-lc', 'sleep infinity'])
      await command('docker', ['exec', '-w', '/testbed', name, 'git', 'config', 'core.fileMode', 'false'])
      await command('docker', ['exec', '-w', '/testbed', name, 'git', 'reset', '--hard', task.baseCommit])
      requireValue(!(await command('docker', ['exec', '-w', '/testbed', name, 'git', 'diff', '--binary', task.baseCommit])).stdout.trim(), 'Image baseline dirty')
      stage = 'agent-task'
      const result = await taskRunner({ directory, containerName: name, instanceId: slot.instanceId, baseCommit: task.baseCommit,
        problemStatement: problem.problem_statement, key, pricing: config.pricing, group: slot.group, model,
        thinking: config.thinking, reasoningEffort: config.reasoningEffort, nativeInlineTokens: config.nativeInlineTokensByGroup[slot.group], costGuard: 'actual-usage',
        pluginConfiguration: config.pluginConfiguration, maxOutputTokens: 8192, maxSteps: 64, maxCalls: 80, timeoutMs: 900000,
        maxCostUSD: limit.maxTaskUSD, commandExecutor: (container, commandText, signal) => dockerCommand(container, `source /opt/miniconda3/bin/activate testbed >/dev/null\n${commandText}`, signal),
        beforePatchExport: ({ containerName }) => clearContainerProcesses(containerName) })
      accountedCNY = result.modelCalls.reduce((sum, call) => sum + (pricedCNY(call.usage, config.cnyPricing) ?? 0), 0)
      report.knownStudyCostCNY += accountedCNY
      const raw = await readFile(join(directory, 'model-calls.jsonl'), 'utf8'), recovered = recoverPairedCalls(raw, config.cnyPricing)
      report.knownStudyCostCNY += additionalRecoveredCost(accountedCNY, recovered.knownCNY)
      accountedCNY = Math.max(accountedCNY, recovered.knownCNY)
      try { requireValue(near(verifyPriorCalls(result, raw, config.cnyPricing), accountedCNY), 'Call cost mismatch') }
      catch { report.accountingComplete = false }
      requireValue(result.model === model && result.simulated === false, 'Real Flash result required')
      await cleanup(name)
      requireValue(await frozen(), 'Scoring inputs changed')
      stage = 'independent-evaluation'
      if (result.patchStatus === 'complete') attempted.add(names[1])
      const quality = result.patchStatus === 'complete' ? await scorer({ containerName: names[1], image: task.imageReference,
        patchFile: join(directory, 'model.patch'), evalScript: task.evalScript, directory: join(directory, 'evaluation'), taskFile: task.taskFile,
        harnessRoot: resolve(config.harnessRoot), expected: task.expected }) : { resolved: false, infrastructureError: true, reason: 'patch-unavailable' }
      const row = { ...slot, result, quality, costCNY: report.accountingComplete ? pricedCNY(result.usage, config.cnyPricing) : null,
        actualTaskCapCNY: Math.min(4, limit.remainingCNY) }
      report.tasks.push(row)
      await journal({ type: 'slot/end', ...slot, resolved: quality.resolved, tokens: result.usageComplete ? totalTokens(result.usage) : null, costCNY: row.costCNY })
      console.log(JSON.stringify({ ...slot, resolved: quality.resolved, tokens: result.usageComplete ? totalTokens(result.usage) : null, costCNY: row.costCNY }))
      if (!report.accountingComplete) report.stoppedReason = 'incomplete-accounting'
      else if (quality.infrastructureError) report.stoppedReason = 'evaluator-infrastructure-error'
    } catch (error) {
      report.stoppedReason = 'study-execution-error'; report.accountingComplete = false; report.incompleteSlot = slot
      let recovered = { knownCNY: 0, unknownCalls: null, invalid: true }
      try { recovered = recoverPairedCalls(await readFile(join(directory, 'model-calls.jsonl'), 'utf8'), config.cnyPricing) } catch {}
      report.knownStudyCostCNY += additionalRecoveredCost(accountedCNY, recovered.knownCNY)
      await journal({ type: 'slot/interrupted', ...slot, stage, failure: safeFailure(error), recovery: recovered })
    } finally {
      for (const container of claimed) try { await cleanup(container) } catch { report.stoppedReason = 'container-cleanup-failed'; report.cleanupFailure = { container, slot: slot.slot } }
      await save()
    }
    if (report.stoppedReason) break
  }
  try { report.sourceAfterMatches = await frozen() } catch { report.sourceAfterMatches = false }
  report.combinedKnownCNY = config.priorKnownCNY + report.knownStudyCostCNY
  report.withinBudget = report.combinedKnownCNY <= 50 + 1e-8 && 18.02921736 + report.combinedKnownCNY <= 70 + 1e-8
  if (!report.sourceAfterMatches) report.stoppedReason = 'source-or-input-drift'
  if (!report.withinBudget) report.stoppedReason = 'budget-overrun'
  report.finished = report.tasks.length === plan.scheduled.length && report.accountingComplete && !report.stoppedReason
  report.comparison = flashComparison(report, baseline)
  report.finished &&= report.comparison.complete
  if (!report.finished && !report.stoppedReason) report.stoppedReason = 'incomplete-official-results'
  if (report.finished && !plan.pluginOnly) {
    try { report.frozenBaselines = await freezeFlashBaselines(report) }
    catch (error) {
      report.finished = false
      report.stoppedReason = 'baseline-freeze-failed'
      report.freezeFailure = safeFailure(error)
      report.comparison = { complete: false, model, comparisons: null }
    }
  }
  await save()
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArguments(process.argv.slice(2))
  if (options.run) {
    const report = await runFlashStudy(options)
    console.log(JSON.stringify({ finished: report.finished, stoppedReason: report.stoppedReason, comparison: report.comparison, frozenBaselines: report.frozenBaselines }, null, 2))
    process.exitCode = report.finished ? 0 : 1
  } else {
    const { plan } = await prepareFlashStudy(options)
    console.log(JSON.stringify({ mode: 'plan-only', paidCalls: 0, plan }, null, 2))
  }
}
