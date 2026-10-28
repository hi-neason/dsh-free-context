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
