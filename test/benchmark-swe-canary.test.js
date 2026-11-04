import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dockerArgs, readSpill, budgetBlock, completeCall, callReservation, runSweCanaryTask } from '../scripts/benchmark/swe-canary-agent.js'
const pricing = { currency: 'USD', uncached: .3, cacheRead: .006, output: 1.2, sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/' }
test('Docker command is passed as one container argument without host interpolation', () => {
  assert.deepEqual(dockerArgs('safe-container', 'echo $(whoami); cat /x'), ['exec', '-w', '/testbed', 'safe-container', 'bash', '-lc', 'echo $(whoami); cat /x'])
  assert.throws(() => dockerArgs('--privileged', 'x'))
})
test('spill reads reject traversal and symlinks outside the run', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'swe-path-')); t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'spill')); await writeFile(join(dir, 'secret'), 'secret'); await writeFile(join(dir, 'spill', 'ok'), 'a\nb')
  await symlink(join(dir, 'secret'), join(dir, 'spill', 'escape'))
  await assert.rejects(readSpill(join(dir, 'spill'), '../secret'))
  await assert.rejects(readSpill(join(dir, 'spill'), 'escape'))
  assert.deepEqual((await readSpill(join(dir, 'spill'), 'ok', 2, 1)).lines, ['b'])
})
test('budget guards unknown usage, call cap and conservative reserve', () => {
  assert.equal(budgetBlock([{ usage: null }], .001, 20, 1, pricing), 'incomplete-usage')
  assert.equal(budgetBlock([], .01, 0, 1, pricing), 'max-calls')
  assert.equal(budgetBlock([], .02, 20, .01, pricing), 'max-cost-reserve')
  assert.ok(callReservation({ messages: [] }, 2048, pricing) > 2048 * 1.2 / 1e6)
})
test('official AgentLoop replay executes restricted tool and persists call and session evidence', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'swe-agent-')); t.after(() => rm(root, { recursive: true, force: true })); const directory = join(root, 'run')
  const commands = []
  const result = await runSweCanaryTask({ directory, baseCommit: '38c31c99f6be6c2ffcc9e4132387edb7af8c5d06', containerName: 'prepared', instanceId: 'synthetic', problemStatement: 'Inspect repository.', pricing, group: 'plugin', maxCostUSD: .03,
    commandExecutor: async (container, command) => { commands.push([container, command]); return { stdout: command.includes('--binary') ? 'patch' : 'file content', stderr: '', exitCode: 0 } },
    adapterFactory: ({ LlmAdapter }) => new class extends LlmAdapter {
      calls = 0
      async resolveModel(provider, model) { return { provider, id: model, name: model } }
      async *stream() {
        const block = ++this.calls === 1 ? { type: 'tool-call', id: 'bash-1', name: 'bash', arguments: '{"command":"cat README.md"}' } : { type: 'text', text: 'Inspected.' }
        yield { type: 'block-start', index: 0, blockType: block.type }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } }
        yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
      }
    }() })
  assert.equal(result.failure, null)
  assert.equal(result.modelCalls.length, 2)
  assert.equal(result.model, 'deepseek-flash')
  assert.equal(result.thinking, 'disabled')
  assert.equal(result.reasoningEffort, 'off')
  assert.equal(result.maxOutputTokens, 2048)
  assert.equal(result.costGuard, 'request-reserve')
  assert.equal(result.configuration.limits.costGuard, 'request-reserve')
  assert.equal(result.nativeInlineTokens, 1200)
  assert.equal(result.pluginConfiguration.minInputBytes, 1024)
  assert.equal(result.usageComplete, true)
  assert.equal(result.toolCalls[0].valuePreserved, true)
  assert.equal(result.modelCalls[1].visibleToolResults[0].contentHash, result.toolCalls[0].contentHash)
  assert.equal(commands[0][1], 'cat README.md')
  assert.equal(commands.at(-1)[1], 'git add -N -- . && git -c core.fileMode=false diff --binary 38c31c99f6be6c2ffcc9e4132387edb7af8c5d06')
  await assert.rejects(runSweCanaryTask({ directory, baseCommit: result.baseCommit, containerName: 'prepared', instanceId: 'synthetic', problemStatement: 'x', pricing, group: 'plugin', adapterFactory: () => null }), { code: 'EEXIST' })
  assert.equal((await readFile(join(directory, 'model-calls.jsonl'), 'utf8')).trim().split('\n').length, 4)
  assert.ok(JSON.parse(await readFile(join(directory, 'session-events.json'), 'utf8')).some(e => e.type === 'tool/result'))
})

test('partial usage followed by stream failure is unknown and prevents another call', () => {
  const record = { usage: { inputTokens: 100, outputTokens: 10 }, finish: 'stop', streamCompleted: false }
  assert.equal(completeCall(record), false)
  assert.equal(budgetBlock([record], .001, 20, 1, pricing), 'incomplete-usage')
  assert.equal(completeCall({ ...record, streamCompleted: true }), true)
  assert.equal(completeCall({ ...record, streamCompleted: true, finish: 'unexpected' }), false)
})

test('real AgentLoop partial usage then disconnect remains incomplete', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'swe-disconnect-')); t.after(() => rm(root, { recursive: true, force: true }))
  let providerCalls = 0
  const result = await runSweCanaryTask({ directory: join(root, 'run'), baseCommit: '38c31c99f6be6c2ffcc9e4132387edb7af8c5d06', containerName: 'prepared', instanceId: 'synthetic', problemStatement: 'Inspect repository.', pricing, group: 'baseline-default',
    commandExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }), beforePatchExport: async () => false,
    adapterFactory: ({ LlmAdapter }) => new class extends LlmAdapter {
      async resolveModel(provider, model) { return { provider, id: model, name: model } }
      async *stream() {
        providerCalls++
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
        throw new Error('Synthetic disconnect')
      }
    }() })
  assert.equal(providerCalls, 1)
  assert.equal(result.usageComplete, false)
  assert.equal(result.costUSD, null)
  assert.equal(result.stoppedReason, 'incomplete-usage')
  assert.equal(result.patchStatus.state, 'unavailable')
  await assert.rejects(readFile(join(root, 'run', 'model.patch')), { code: 'ENOENT' })
})

test('configured AgentLoop freezes model, provider limits and plugin settings across all arms', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'swe-config-')); t.after(() => rm(root, { recursive: true, force: true }))
  for (const group of ['baseline-default', 'baseline-tuned', 'plugin']) {
    const pluginConfiguration = { mode: 'apply', tools: ['bash'], minInputBytes: 512, text: { enabled: true, minSavingsRatio: .1 } }
    const taskPricing = { ...pricing, model: 'deepseek-v4-pro' }
    let captured
    const result = await runSweCanaryTask({ directory: join(root, group), baseCommit: '38c31c99f6be6c2ffcc9e4132387edb7af8c5d06',
      containerName: 'prepared', instanceId: 'synthetic', problemStatement: 'Inspect repository.', pricing: taskPricing, group,
      model: 'deepseek-v4-pro', thinking: 'enabled', reasoningEffort: 'high', maxOutputTokens: 8192, nativeInlineTokens: 2400,
      pluginConfiguration, maxCostUSD: 1,
      commandExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      adapterFactory: ({ LlmAdapter, configuration }) => {
        captured = configuration
        // Mutation after async setup must not change the policy or recorded price.
        pluginConfiguration.text.minSavingsRatio = .9
        taskPricing.output = 999
        return new class extends LlmAdapter {
          async resolveModel(provider, model) { assert.equal(model, 'deepseek-v4-pro'); return { provider, id: model, name: model } }
          async *stream(request) {
            assert.equal(request.model, 'deepseek-v4-pro')
            yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          }
        }()
      } })
    assert.equal(result.failure, null)
    assert.equal(result.model, 'deepseek-v4-pro')
    assert.equal(result.modelCalls[0].model, 'deepseek-v4-pro')
    assert.equal(result.nativeInlineTokens, 2400)
    assert.deepEqual(captured.providerConfiguration, { apiKeyEnv: 'DEEPSEEK_API_KEY', thinking: 'enabled', reasoningEffort: 'high', maxTokens: 8192,
      streamIdleTimeoutMs: 30000, retryPolicy: { mode: 'normal', maxRetries: 0 } })
    assert.equal(captured.limits.maxOutputTokens, 8192)
    assert.equal(result.pricing.output, pricing.output)
    assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.providerConfiguration.retryPolicy))
    if (group === 'plugin') {
      assert.equal(result.pluginConfiguration.text.minSavingsRatio, .1)
      assert.equal(result.pluginConfiguration.minInputBytes, 512)
      assert.ok(Object.isFrozen(result.pluginConfiguration.text))
    } else {
      assert.equal(result.pluginConfiguration, null)
      assert.deepEqual(result.decisions, [])
    }
    assert.deepEqual(JSON.parse(await readFile(join(root, group, 'result.json'), 'utf8')).configuration, captured)
  }
})

test('benchmark rejects model price mismatch and mode/tool or provider configuration drift before starting', async () => {
  const base = { model: 'deepseek-v4-pro', pricing: { ...pricing, model: 'deepseek-v4-pro' }, group: 'plugin' }
  await assert.rejects(runSweCanaryTask({ ...base, pricing: { ...pricing, model: 'deepseek-flash' } }), /match pricing.model/)
  for (const input of [{ thinking: 'true' }, { thinking: 'disabled', reasoningEffort: 'high' }, { thinking: 'enabled', reasoningEffort: 'off' }, { reasoningEffort: 'medium' }]) {
    await assert.rejects(runSweCanaryTask({ ...base, ...input }), /thinking\/reasoningEffort/)
  }
  for (const pluginConfiguration of [{ mode: 'observe', tools: ['bash'] }, { mode: 'apply', tools: ['read'] }]) {
    await assert.rejects(runSweCanaryTask({ ...base, pluginConfiguration }), /mode apply and tools bash/)
  }
  await assert.rejects(runSweCanaryTask({ ...base, nativeInlineTokens: 0 }), /nativeInlineTokens/)
})


test('actual usage guard ignores reservation but preserves complete usage and call limits', () => {
  const record = { streamCompleted: true, finish: 'stop', usage: { inputTokens: 1000000, outputTokens: 0 } }
  assert.equal(budgetBlock([], 999, 20, .3, pricing, 'actual-usage'), null)
  assert.equal(budgetBlock([record], 999, 20, .31, pricing, 'actual-usage'), null)
  assert.equal(budgetBlock([record], 0, 20, .3, pricing, 'actual-usage'), 'max-cost-actual')
  assert.equal(budgetBlock([record], 0, 20, .29, pricing, 'actual-usage'), 'max-cost-actual')
  assert.equal(budgetBlock([record], 0, 1, 1, pricing, 'actual-usage'), 'max-calls')
  for (const invalid of [{ ...record, streamCompleted: false }, { ...record, usage: null },
    { ...record, usage: { ...record.usage, cacheWriteTokens: 1 } }]) {
    assert.equal(budgetBlock([invalid], 0, 20, 1, pricing, 'actual-usage'), 'incomplete-usage')
  }
})

test('invalid cost guard is rejected before setup', async () => {
  for (const costGuard of ['none', '', null, true]) {
    await assert.rejects(runSweCanaryTask({ costGuard }), /Invalid costGuard/)
  }
})

test('AgentLoop actual cost policy allows small-cost calls and stops only after accrued limit', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'swe-actual-cost-')); t.after(() => rm(root, { recursive: true, force: true }))
  for (const [name, costGuard, maxCostUSD, expectedCalls] of [
    ['reserve', 'request-reserve', .00002, 0],
    ['actual-complete', 'actual-usage', .00002, 2],
    ['actual-capped', 'actual-usage', .000008, 1]
  ]) {
    let calls = 0
    const directory = join(root, name)
    const result = await runSweCanaryTask({ directory, baseCommit: '38c31c99f6be6c2ffcc9e4132387edb7af8c5d06',
      containerName: 'prepared', instanceId: 'synthetic', problemStatement: 'Inspect repository.', pricing,
      group: 'baseline-default', costGuard, maxCostUSD,
      commandExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      adapterFactory: ({ LlmAdapter, configuration }) => {
        assert.equal(configuration.limits.costGuard, costGuard)
        assert.ok(Object.isFrozen(configuration.limits))
        return new class extends LlmAdapter {
          async resolveModel(provider, model) { return { provider, id: model, name: model } }
          async *stream() {
            const block = ++calls === 1
              ? { type: 'tool-call', id: 'bash-1', name: 'bash', arguments: '{"command":"cat README.md"}' }
              : { type: 'text', text: 'Inspected.' }
            yield { type: 'block-start', index: 0, blockType: block.type }
            yield { type: 'block-end', index: 0, block }
            yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } }
            yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
          }
        }()
      } })
    assert.equal(calls, expectedCalls)
    assert.equal(result.modelCalls.length, expectedCalls)
    assert.equal(result.costGuard, costGuard)
    const stored = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
    assert.equal(stored.costGuard, costGuard)
    assert.equal(stored.configuration.limits.costGuard, costGuard)
    if (costGuard === 'actual-usage') {
      assert.equal(result.usageComplete, true)
      assert.ok(Math.abs(result.costUSD - expectedCalls * .000009) < 1e-12)
      assert.ok(result.modelCalls.every(record => record.reservedUSD === 0))
    }
    if (name === 'reserve') assert.equal(result.stoppedReason, 'max-cost-reserve')
    if (name === 'actual-capped') assert.equal(result.stoppedReason, 'max-cost-actual')
    if (name === 'actual-complete') assert.equal(result.failure, null)
  }
})
