import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeDevelopmentFixture, verifyDevelopmentWorkspace } from './development-fixtures.js'
import { runEvaluationProcess } from './evaluation-process.js'
import { summarizeUsage, priceUsage, validUsage } from './evaluation-accounting.js'
import { price } from './acceptance-benchmark.js'
import { acceptanceSourceHash } from './acceptance-benchmark-cli.js'

const repository = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const hash = value => createHash('sha256').update(value).digest('hex')
const contentHash = value => hash(JSON.stringify(value) ?? 'undefined')
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const groups = ['baseline-default', 'baseline-tuned', 'plugin']
const parseLines = text => text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : []
const visibleResult = value => value !== null && typeof value === 'object' && typeof value.callId === 'string' && value.callId.length > 0 && /^[a-f0-9]{64}$/.test(value.contentHash)

export function parseDevelopmentLedger(text) {
  const events = [], errors = []
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (!event || typeof event !== 'object' || Array.isArray(event) || !['model/start', 'model/end', 'tool', 'decision', 'limit', 'process/exit', 'compression/input', 'compression/output'].includes(event.type)) throw new Error('invalid event')
      events.push(event)
    } catch { errors.push({ line: index + 1, reason: 'invalid-ledger-record' }) }
  }
  return { events, errors }
}

export function reconcileDevelopmentLedger(events, { replay, pricing, model, manifestHash, ledgerComplete = true }) {
  const starts = events.filter(event => event.type === 'model/start' && event.manifestHash === manifestHash)
  const ends = events.filter(event => event.type === 'model/end' && event.manifestHash === manifestHash)
  const bound = events.every(event => event.manifestHash === manifestHash)
  const modelCalls = starts.map((start, index) => {
    const matches = ends.filter(end => end.id === start.id)
    const uniqueStart = Number.isSafeInteger(start.id) && start.id > 0 && starts.filter(other => other.id === start.id).length === 1
    const end = uniqueStart && matches.length === 1 ? matches[0] : undefined
    const visibilityComplete = Array.isArray(start.visibleToolResults) && start.visibleToolResults.every(visibleResult)
    // Keep usable counters even if metadata is damaged. The derived visibility
    // view contains safe entries; the original journal remains the raw evidence.
    return { ...start, visibleToolResults: Array.isArray(start.visibleToolResults) ? start.visibleToolResults.filter(visibleResult) : [], usage: end?.usage ?? null, finish: end?.finish ?? null,
      complete: start.id === index + 1 && Number.isSafeInteger(start.agentStep) && start.agentStep >= 0 && visibilityComplete && matches.length === 1 && end?.complete === true && validUsage(end?.usage) && ['stop', 'tool-calls'].includes(end?.finish) }
  })
  const usage = summarizeUsage(modelCalls.map(call => call.usage))
  const route = call => call.provider === (replay ? 'development-replay' : 'deepseek-official') && call.model === model
  const usageComplete = ledgerComplete && bound && starts.length > 0 && ends.length === starts.length && usage.complete && modelCalls.every(call => call.complete && route(call) && ['agent', 'auxiliary'].includes(call.kind))
  const estimatedCostUSD = !replay && usageComplete ? priceUsage(usage.usage, pricing) : null
  const pricedCalls = modelCalls.filter(call => route(call) && validUsage(call.usage) && priceUsage(call.usage, pricing) !== null)
  const knownPricedUsageUSD = replay || pricedCalls.length === 0 ? null : pricedCalls.reduce((sum, call) => sum + priceUsage(call.usage, pricing), 0)
  return { modelCalls, modelEnds: ends, usage: usage.usage, usageComplete, costComplete: estimatedCostUSD !== null, estimatedCostUSD, knownPricedUsageUSD }
}

export function inspectDevelopmentWorkflow(tools, initialHash, finalHash) {
  const failure = tools.findIndex(tool => tool.testCommand && !tool.isError && Number.isInteger(tool.exitCode) && tool.exitCode !== 0 && tool.sourceHash === initialHash)
  const changed = tools.findIndex(tool => tool.sourceHash !== initialHash)
  const success = tools.findIndex((tool, index) => index > changed && tool.testCommand && !tool.isError && tool.exitCode === 0 && tool.sourceHash === finalHash && finalHash !== initialHash)
  return { reproduced: failure >= 0, retested: success >= 0,
    workflowOrdered: failure >= 0 && changed > failure && success > changed && ['bash', 'write', 'edit'].includes(tools[changed].name) }
}

export async function readDevelopmentSessionRecords(directory, sessionId) {
  const records = []
  let bytes = 0, files = 0
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const absolute = join(path, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        bytes += (await stat(absolute)).size
        if (++files > 16 || bytes > 8 * 1024 * 1024) throw new Error('Session audit budget exceeded')
        const content = await readFile(absolute)
        const lines = parseLines(content.toString('utf8'))
        if (lines[0]?.type === 'session' && lines[0].id === sessionId && lines[0].version === 4) records.push(...lines.slice(1))
      }
    }
  }
  await visit(directory)
  return records
}

export function buildDevelopmentProfile(config) {
  const lines = ['- id: agent-default-model', '  config:', `    provider: ${config.replay ? 'development-replay' : 'deepseek-official'}`, `    model: ${JSON.stringify(config.model)}`,
    '- id: headless-runner', '  inject: [headlessStartup, developmentObservation]', '- id: agent-instructions', '  config:', '    maxBytes: 0']
  const disabled = ['session-title-llm', 'llm-deepseek-account', 'llm-pi-ai', 'spill-policy', 'tool-plugin-manager', 'tool-jobs', 'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-workflow', 'tool-skill']
  if (config.replay) disabled.push('llm-deepseek')
  for (const id of disabled) lines.push(`- id: ${id}`, '  disabled: true')
  if (!config.replay) lines.push('- id: llm-deepseek', '  config:', '    apiKeyEnv: DEEPSEEK_API_KEY', '    thinking: disabled', '    reasoningEffort: off', `    maxTokens: ${config.maxOutputTokens}`, '    streamIdleTimeoutMs: 30000')
  lines.push('- id: session-persistence-jsonl', '  config:', '    compression: none', `    root: ${JSON.stringify(config.sessions)}`,
    '- id: tool-bash', '  config:', '    enableRunInBackground: false', '    promoteOnTimeout: false',
    '- id: bash-sandbox', '  config:', '    timeoutMs: 5000', '    maxTimeoutMs: 5000',
    '- id: spill-local', '  config:', `    root: ${JSON.stringify(config.spill)}`,
    '- insert:')
  if (config.replay) lines.push('    - id: development-replay-provider', `      name: ${JSON.stringify(config.replayProvider)}`)
  lines.push('    - id: development-context-stack', `      name: ${JSON.stringify(fileURLToPath(new URL('./development-context-stack.js', import.meta.url)))}`)
  if (config.replay) lines.push('      inject: [developmentReplayReady]')
  return lines.join('\n') + '\n'
}

export async function runDevelopmentTask(fixtureId, group, { directory, replay = true, key, pricing: inputPricing, model: inputModel,
  runtimeRoot = process.env.DSH_CLI_RUNTIME_ROOT ?? '.omx/cli-runtime', maxSteps = 12, maxCalls = 16, timeoutMs = 90000, maxCostUSD = .05, onPlan, onResult } = {}) {
  if (!groups.includes(group) || typeof replay !== 'boolean' || !isAbsolute(directory ?? '')) throw new TypeError('Explicit group, mode and absolute new directory required')
  const root = join(await realpath(dirname(resolve(directory))), basename(resolve(directory)))
  const repositoryRoot = await realpath(repository)
  if (root === repositoryRoot || root.startsWith(repositoryRoot + sep)) throw new TypeError('Development workspace must be outside the repository')
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 32 || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 64 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !Number.isFinite(maxCostUSD) || maxCostUSD <= 0 || maxCostUSD > 1) throw new TypeError('Invalid development budget')
  const pricing = inputPricing === undefined ? null : freeze(JSON.parse(JSON.stringify(inputPricing)))
  const model = replay ? 'scripted' : inputModel ?? pricing?.model
  if (!replay && (typeof key !== 'string' || !key.trim() || typeof model !== 'string' || !model.trim() || typeof onPlan !== 'function' || typeof onResult !== 'function' || model !== pricing?.model || price({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, pricing) === null)) throw new TypeError('Live development requires explicit credentials, pricing and checkpoints')
  const runtime = resolve(runtimeRoot)
  const version = JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version
  if (version !== '0.2.1-rc.2') throw new Error('Unsupported official CLI runtime')
  await mkdir(root, { mode: 0o700 })
  const { directory: workspace, fixture } = await materializeDevelopmentFixture(fixtureId, join(root, 'workspace'))
  const home = join(root, 'home'), profile = join(home, 'profiles/headless')
  await mkdir(profile, { recursive: true, mode: 0o700 })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } } }), { flag: 'wx', mode: 0o600 })
  const config = { runId: randomUUID(), group, replay, model, pricing, workspace, maxSteps, maxCalls, maxCostUSD,
    tools: ['bash', 'read', 'grep'], instructionMaxBytes: 0, maxOutputTokens: 4096, policyInstallationOrder: ['compression-input', 'free-context-if-enabled', 'compression-output', 'native-spill', 'observer'], plugin: group === 'plugin', maxInlineTokens: group === 'baseline-default' ? 12500 : 1200,
    sessions: join(home, 'sessions'), spill: join(root, 'spill'), ledger: join(root, 'ledger.jsonl'), runtimePackage: join(runtime, 'package.json'),
    testCommands: ['node --test test/json-codec.test.js', 'node --test --test-reporter=tap test/json-codec.test.js'],
    ...(replay ? { replayProvider: fileURLToPath(new URL('./development-replay-provider.js', import.meta.url)), controlSource: fileURLToPath(new URL('../test/fixtures/development/json-output-limit/control/json-codec.js', import.meta.url)) } : {}) }
  const patch = buildDevelopmentProfile(config)
  const plan = { version: 'development-task-v1', fixtureId, fixtureManifestHash: fixture.manifestHash, configuration: config, timeoutMs, shutdownGraceMs: 6000,
    runtimeVersion: version, runtimeLockHash: hash(await readFile(join(runtime, 'package-lock.json'))), sourceTreeHash: await acceptanceSourceHash(repository), patchHash: hash(patch) }
  plan.manifestHash = contentHash(plan)
  freeze(plan)
  await writeFile(join(root, 'plan.json'), JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 })
  await onPlan?.(plan)
  const observer = join(root, 'observer.json'), patchPath = join(root, 'patch.yml')
  await writeFile(observer, JSON.stringify({ ...config, manifestHash: plan.manifestHash }), { flag: 'wx', mode: 0o600 })
  await writeFile(patchPath, patch, { flag: 'wx', mode: 0o600 })
  await writeFile(config.ledger, '', { flag: 'wx', mode: 0o600 })
  const execution = await runEvaluationProcess(process.execPath, [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'headless', '--patch', patchPath, '--json', fixture.prompt], {
    cwd: workspace, timeoutMs, shutdownGraceMs: plan.shutdownGraceMs, maxOutputBytes: 2 * 1024 * 1024,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1', DSH_DEVELOPMENT_CONFIG: observer, ...(!replay ? { DEEPSEEK_API_KEY: key } : {}) } })
  await writeFile(join(root, 'cli.jsonl'), execution.stdout, { flag: 'wx', mode: 0o600 })
  let events = [], cli = [], persisted = [], auditReadable = false, ledgerReadable = false
  const auditErrors = []
  try {
    const ledger = parseDevelopmentLedger(await readFile(config.ledger, 'utf8'))
    events = ledger.events
    auditErrors.push(...ledger.errors)
    ledgerReadable = ledger.errors.length === 0 && events.length > 0
    if (events.length === 0) auditErrors.push({ reason: 'ledger-empty' })
  } catch { auditErrors.push({ reason: 'ledger-unreadable' }) }
  try {
    cli = parseLines(execution.stdout)
    persisted = await readDevelopmentSessionRecords(config.sessions, cli.find(event => event.type === 'session')?.sessionId)
    auditReadable = ledgerReadable && events.every(event => event.manifestHash === plan.manifestHash) && persisted.length > 0
  } catch { auditErrors.push({ reason: 'session-or-cli-unreadable' }) }
  const accounting = reconcileDevelopmentLedger(events, { replay, pricing, model, manifestHash: plan.manifestHash, ledgerComplete: ledgerReadable })
  const tools = events.filter(event => event.type === 'tool')
  const persistedTools = persisted.filter(event => event.type === 'tool/result').map(event => ({ callId: event.data.message.toolCallId, contentHash: contentHash(event.data.message.content) }))
  const persistenceComplete = auditReadable && tools.length > 0 && tools.every(tool => persistedTools.some(result => result.callId === tool.callId && result.contentHash === tool.contentHash))
  const exits = events.filter(event => event.type === 'process/exit' && event.manifestHash === plan.manifestHash)
  const toolCleanupConfirmed = execution.cleaned && !execution.escalated && exits.length === 1 && Array.isArray(exits[0].activeTools) && exits[0].activeTools.length === 0
  const verification = toolCleanupConfirmed ? await verifyDevelopmentWorkspace(fixtureId, workspace) : { passed: false, reason: 'cli-process-cleanup-failed' }
  const initialHash = fixture.manifest.files['workspace/src/json-codec.js'].sha256
  const { reproduced, retested, workflowOrdered } = inspectDevelopmentWorkflow(tools, initialHash, verification.sourceHash)
  const structuredValuesPreserved = tools.every(tool => tool.valueHash === tool.finalValueHash)
  const turns = persisted.filter(event => event.type === 'turn/end')
  const steps = persisted.filter(event => event.type === 'step/start').length
  const stepsRecorded = steps > 0 && steps <= maxSteps && accounting.modelCalls.filter(call => call.kind === 'agent').length >= steps
  const passed = execution.exitCode === 0 && execution.stopReason === null && toolCleanupConfirmed && cli.at(-1)?.type === 'final' && verification.passed && workflowOrdered && reproduced && retested && persistenceComplete && structuredValuesPreserved && stepsRecorded && turns.length > 0 && turns.every(event => event.data.reason.kind === 'completed')
  const result = freeze({ task: fixtureId, group, replay, plan, passed, verification, reproduced, retested, workflowOrdered, persistenceComplete, structuredValuesPreserved, stepsRecorded,
    usageKind: replay ? 'synthetic-replay' : 'provider-reported', ...accounting, steps, tools: tools.map(tool => ({ ...tool, modelVisible: accounting.modelCalls.some(call => call.visibleToolResults?.some(value => value.callId === tool.callId && value.contentHash === tool.contentHash)) })),
    auditErrors, decisions: events.filter(event => event.type === 'decision'), limits: events.filter(event => event.type === 'limit'),
    turnEnds: turns.map(event => ({ kind: event.data.reason.kind })),
    transformations: events.filter(event => event.type === 'decision' && event.outcome === 'selected').map(event => {
      const tool = tools.find(tool => tool.callId === event.callId)
      return { callId: event.callId, strategy: event.strategy, finalResultPersisted: Boolean(tool && persistedTools.some(result => result.callId === tool.callId && result.contentHash === tool.contentHash)),
        finalResultModelVisible: Boolean(tool && accounting.modelCalls.some(call => call.visibleToolResults?.some(result => result.callId === tool.callId && result.contentHash === tool.contentHash))), contentHash: tool?.contentHash ?? null }
    }),
    withinBudget: replay || accounting.costComplete && accounting.estimatedCostUSD <= maxCostUSD,
    replayComplete: replay && passed && accounting.usageComplete,
    cli: { pid: execution.pid, exitCode: execution.exitCode, stopReason: execution.stopReason, cleaned: toolCleanupConfirmed, processGroupCleaned: execution.cleaned, gracefulStop: execution.gracefulStop, escalated: execution.escalated, stderrHash: hash(execution.stderr) },
    claimBoundary: 'One historical coding task with fixed tests. Scripted replay uses a known repair and synthetic usage; it cannot prove model repair quality or comparative net savings.' })
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
  await onResult?.(result)
  return result
}
