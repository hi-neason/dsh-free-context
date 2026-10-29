import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileDevelopmentLedger, runDevelopmentTask, inspectDevelopmentWorkflow, parseDevelopmentLedger } from '../scripts/evaluate-development.js'
const pricing = { currency: 'USD', sourceUrl: 'https://example.test/pricing', model: 'model', uncached: 1, cacheRead: .1, output: 2 }
const binding = { replay: false, pricing, model: 'model', manifestHash: 'bound' }
const start = { type: 'model/start', manifestHash: 'bound', id: 1, provider: 'deepseek-official', model: 'model', kind: 'agent', agentStep: 1, visibleToolResults: [] }
const end = { type: 'model/end', manifestHash: 'bound', id: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, finish: 'stop', complete: true }

test('development cost accounting reconciles every start/end and rejects incomplete or foreign ledgers', () => {
  const valid = reconcileDevelopmentLedger([start, end], binding)
  assert.equal(valid.usageComplete, true)
  assert.equal(valid.estimatedCostUSD, .00002)
  for (const events of [[start], [start, end, end], [{ ...start, provider: 'foreign' }, end], [start, { ...end, usage: null }], [{ ...start, manifestHash: 'other' }, end], [{ ...start, id: 2 }, { ...end, id: 2 }]]) {
    const result = reconcileDevelopmentLedger(events, binding)
    assert.equal(result.costComplete, false)
    assert.equal(result.estimatedCostUSD, null)
  }
  const replay = reconcileDevelopmentLedger([{ ...start, provider: 'development-replay', model: 'scripted' }, end], { ...binding, replay: true, model: 'scripted' })
  assert.equal(replay.usageComplete, true)
  assert.equal(replay.costComplete, false)
  assert.equal(replay.knownPricedUsageUSD, null)
})

test('live development cannot start without explicit credentials, prices and durable checkpoints', async () => {
  await assert.rejects(runDevelopmentTask('json-output-limit', 'plugin', { directory: '/tmp/not-created-development-fixture', replay: false }), TypeError)
  await assert.rejects(runDevelopmentTask('json-output-limit', 'unknown', { directory: '/tmp/not-created-development-fixture' }), TypeError)
})


test('development workflow cannot credit reversed tests or an unobserved mutation', () => {
  const failure = { name: 'bash', testCommand: true, isError: false, exitCode: 1, sourceHash: 'old' }
  const edit = { name: 'write', sourceHash: 'fixed' }
  const success = { name: 'bash', testCommand: true, isError: false, exitCode: 0, sourceHash: 'fixed' }
  assert.equal(inspectDevelopmentWorkflow([failure, edit, success], 'old', 'fixed').workflowOrdered, true)
  for (const tools of [[success, failure, edit], [failure, success], [failure, { ...edit, name: 'read' }, success], [edit, failure, success]]) {
    assert.equal(inspectDevelopmentWorkflow(tools, 'old', 'fixed').workflowOrdered, false)
  }
})


test('damaged or truncated ledger retains valid call costs but never certifies complete usage', () => {
  const raw = [JSON.stringify(start), 'damaged-record', JSON.stringify(end)].join('\n')
  const parsed = parseDevelopmentLedger(raw)
  assert.equal(parsed.errors.length, 1)
  const result = reconcileDevelopmentLedger(parsed.events, { ...binding, ledgerComplete: parsed.errors.length === 0 })
  assert.equal(result.modelCalls.length, 1)
  assert.equal(result.usage.inputTokens, 10)
  assert.equal(result.knownPricedUsageUSD, .00002)
  assert.equal(result.costComplete, false)
  assert.equal(result.estimatedCostUSD, null)
  const truncated = parseDevelopmentLedger(raw + '\n' + JSON.stringify({ ...start, id: 2 }) + '\n{"type":"model/end"')
  const partial = reconcileDevelopmentLedger(truncated.events, { ...binding, ledgerComplete: false })
  assert.equal(partial.modelCalls.length, 2)
  assert.equal(partial.modelCalls[1].usage, null)
  assert.equal(partial.knownPricedUsageUSD, .00002)
  assert.equal(partial.costComplete, false)
})


test('ambiguous duplicated starts cannot count the same provider usage twice', () => {
  const result = reconcileDevelopmentLedger([start, start, end], binding)
  assert.equal(result.costComplete, false)
  assert.equal(result.estimatedCostUSD, null)
  assert.equal(result.knownPricedUsageUSD, null)
  assert.equal(result.usage.inputTokens, 0)
  assert.ok(result.modelCalls.every(call => call.usage === null && call.complete === false))
  assert.equal(result.modelEnds.length, 1)
  assert.equal(result.modelEnds[0].usage.inputTokens, 10)
})

test('malformed nested visibility metadata rejects completeness while retaining known billed usage', () => {
  for (const visibleToolResults of [[null], [undefined], [42], [{}], { callId: 'not-an-array' }]) {
    const malformed = { ...start, visibleToolResults }
    const result = reconcileDevelopmentLedger([malformed, end], binding)
    assert.equal(result.usageComplete, false)
    assert.equal(result.costComplete, false)
    assert.equal(result.knownPricedUsageUSD, .00002)
    assert.equal(result.usage.inputTokens, 10)
    assert.deepEqual(result.modelCalls[0].visibleToolResults, [])
    assert.equal(malformed.visibleToolResults, visibleToolResults)
  }
})


test('development read packing option requires an explicit boolean', async () => {
  await assert.rejects(runDevelopmentTask('json-output-limit', 'plugin', { directory: '/tmp/not-created-development-read', readText: 'true' }), TypeError)
})

test('development tool text option requires an explicit boolean', async () => {
  for (const encodeToolText of [null, 'true', 1, {}]) {
    await assert.rejects(runDevelopmentTask('json-output-limit', 'plugin', {
      directory: '/tmp/not-created-development-text', encodeToolText,
    }), /encodeToolText must be a boolean/)
  }
})


test('artifact read packing cannot start without explicit boolean read packing', async () => {
  for (const settings of [{ encodeArtifacts: true }, { readText: true, encodeArtifacts: 'true' }]) {
    await assert.rejects(runDevelopmentTask('json-output-limit', 'plugin', { directory: '/tmp/not-created-artifact-read', ...settings }), TypeError)
  }
})

test('explicit complete max-tokens terminal is billed without reviving historical incomplete records', () => {
  const terminal = { ...end, finish: 'max-tokens' }
  const billed = reconcileDevelopmentLedger([start, terminal], binding)
  assert.equal(billed.usageComplete, true)
  assert.equal(billed.costComplete, true)
  assert.equal(billed.estimatedCostUSD, .00002)
  assert.equal(billed.modelCalls.length, 1)
  for (const altered of [{ complete: false }, { usage: null }, { usage: { ...end.usage, outputTokens: -1 } }, { finish: 'error' }, { finish: null }]) {
    const rejected = reconcileDevelopmentLedger([start, { ...terminal, ...altered }], binding)
    assert.equal(rejected.usageComplete, false)
    assert.equal(rejected.costComplete, false)
    assert.equal(rejected.estimatedCostUSD, null)
    if (!Object.hasOwn(altered, 'usage')) assert.equal(rejected.knownPricedUsageUSD, .00002)
  }
  for (const events of [[start, terminal, terminal], [start, start, terminal], [{ ...start, model: 'foreign' }, terminal],
    [start, { ...terminal, manifestHash: 'foreign' }], [{ ...start, id: 2 }, { ...terminal, id: 2 }]]) {
    assert.equal(reconcileDevelopmentLedger(events, binding).costComplete, false)
  }
})

test('observer prices complete truncation, enforces budget, and rejects failed or unmetered streams', async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'development-observer-metering-'))
  const priorConfig = process.env.DSH_DEVELOPMENT_CONFIG
  const priorExit = new Set(process.listeners('exit'))
  try {
    for (const scenario of ['complete', 'transport-after-finish', 'missing-usage', 'invalid-usage', 'error']) {
      const ledger = join(root, `${scenario}.jsonl`), config = join(root, `${scenario}.json`)
      await writeFile(ledger, '')
      await writeFile(config, JSON.stringify({ ledger, workspace: root, replay: false, pricing, manifestHash: 'bound', maxSteps: 12, maxCalls: 16, maxCostUSD: .00001 }))
      process.env.DSH_DEVELOPMENT_CONFIG = config
      const observer = await import(`../scripts/development-cli-observer.js?scenario=${scenario}`)
      const handlers = new Map()
      await observer.apply({ on(name, handler) { handlers.set(name, handler) }, provide() {} })
      const request = { provider: 'deepseek-official', model: 'model', tools: [{}], messages: [] }
      const run = () => handlers.get('llm/stream')(request, () => (async function* () {
        if (scenario !== 'missing-usage') yield { type: 'usage', usage: scenario === 'invalid-usage' ? { ...end.usage, outputTokens: -1 } : end.usage }
        yield { type: 'finish', reason: { kind: scenario === 'error' ? 'error' : 'max-tokens' } }
        if (scenario === 'transport-after-finish') throw new Error('synthetic transport failure')
      })())
      let failure
      try { for await (const chunk of run()) assert.ok(chunk.type) } catch (error) { failure = error }
      assert.equal(Boolean(failure), scenario === 'transport-after-finish')
      const events = parseDevelopmentLedger(await readFile(ledger, 'utf8')).events
      assert.equal(events.at(-1).complete, scenario === 'complete')
      const observed = reconcileDevelopmentLedger(events, binding)
      assert.equal(observed.costComplete, scenario === 'complete')
      if (scenario === 'complete') assert.equal(observed.estimatedCostUSD, .00002)
      await assert.rejects(async () => { for await (const chunk of run()) assert.fail(`unexpected ${chunk.type}`) }, /budget unavailable/)
      const finalEvents = parseDevelopmentLedger(await readFile(ledger, 'utf8')).events
      assert.equal(finalEvents.at(-1).reason, scenario === 'complete' ? 'model-budget' : 'incomplete-cost-accounting')
    }
  } finally {
    if (priorConfig === undefined) delete process.env.DSH_DEVELOPMENT_CONFIG
    else process.env.DSH_DEVELOPMENT_CONFIG = priorConfig
    for (const listener of process.listeners('exit')) if (!priorExit.has(listener)) process.removeListener('exit', listener)
    await rm(root, { recursive: true, force: true })
  }
})
