import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgentFixture } from '../../scripts/evaluate-agent.js'
import { acceptanceFixturesV4 } from '../fixtures/acceptance/tasks-v4.js'
import { retirementDiscoveryFixtureV4, retirementDiscoveryPolicyV4, retirementDiscoveryPtcFixtureV4, retirementDiscoveryPtcPolicyV4 } from '../fixtures/acceptance/retirement-v4.js'
import { retirementDiscoveryAdapter, retirementDiscoveryPtcAdapter } from '../fixtures/retirement-discovery-provider.js'

const options = policy => ({ replay: true, composeWithTunedNative: true, validationFeedbackLimit: 2,
  maxSteps: 12, timeoutMs: 120000, historyRetirement: policy })
const withoutHiddenEvidence = factory => ({ LlmAdapter }) => factory(new Proxy({ LlmAdapter }, {
  get(target, key) {
    if (key !== 'LlmAdapter') throw new Error(`Hidden runner evidence accessed: ${String(key)}`)
    return target[key]
  },
}))

const quality = result => {
  assert.equal(result.passed, true, JSON.stringify(result))
  assert.equal(result.exactFacts, true)
  assert.equal(result.requiredTools, true)
  assert.equal(result.responseSchemaSatisfied, true)
  assert.equal(result.correctionCount, 0)
  assert.equal(result.usageKind, 'synthetic-replay')
  assert.equal(result.estimatedCostUSD, null)
}

test('discovery scope preserves v4 evidence and flags with fresh fixture/policy data', () => {
  const base = acceptanceFixturesV4().find(task => task.id === 'history-retirement-short')
  const fixture = retirementDiscoveryFixtureV4()
  assert.equal(fixture.text, base.text)
  assert.deepEqual(fixture.expected, base.expected)
  assert.deepEqual(fixture.responseSchema, base.responseSchema)
  assert.equal(fixture.requireSnapshot, base.requireSnapshot)
  assert.equal(fixture.requireReadEachPhase, base.requireReadEachPhase)
  assert.equal(fixture.discoverSourcePath, true)
  assert.ok(fixture.query.startsWith(base.query))
  fixture.expected.checkpoint = -1
  fixture.responseSchema.required.pop()
  const policy = retirementDiscoveryPolicyV4()
  policy.tools.push('changed')
  assert.deepEqual(retirementDiscoveryFixtureV4().expected, base.expected)
  assert.deepEqual(retirementDiscoveryFixtureV4().responseSchema, base.responseSchema)
  assert.deepEqual(retirementDiscoveryPolicyV4().tools, ['fixture'])
  assert.equal(retirementDiscoveryPolicyV4().minimumFutureRequests, 200)
  assert.equal(retirementDiscoveryPolicyV4().excerptCharacters, 64)
  assert.notEqual(retirementDiscoveryPtcFixtureV4().id, retirementDiscoveryFixtureV4().id)
})

for (const group of ['baseline-default', 'baseline-tuned', 'plugin']) {
  test(`direct discovery uses visible source/snapshot evidence through official AgentLoop: ${group}`, async () => {
    const result = await runAgentFixture(retirementDiscoveryFixtureV4(), group, {
      ...options(retirementDiscoveryPolicyV4()), adapterFactory: withoutHiddenEvidence(retirementDiscoveryAdapter),
    })
    quality(result)
    assert.equal(result.modelCalls.length, group === 'plugin' ? 4 : 3)
    assert.equal(result.steps, group === 'plugin' ? 4 : 3)
    assert.equal(result.configuration.maxInlineTokens, group === 'baseline-default' ? 12500 : 1200)
    assert.deepEqual(result.toolCalls.map(call => call.name), group === 'plugin' ? ['fixture', 'read', 'read'] : ['fixture', 'read'])
    const reads = result.toolCalls.filter(call => call.name === 'read')
    assert.ok(reads.every(call => !call.isError))
    assert.equal(reads[0].readOriginal, true)
    for (const call of reads) assert.deepEqual(call.readWindow.requested, { offset: 1, limit: 1 })
    const retirements = result.retirements.filter(record => record.reason === 'retired')
    assert.equal(retirements.length, group === 'plugin' ? 1 : 0)
    if (group === 'plugin') {
      assert.equal(retirements[0].beforeStep, 3)
      assert.equal(retirements[0].actualPostRetirementSteps, 2)
      assert.equal(reads[1].readSnapshot, true)
      assert.ok(result.modelCalls.at(-1).visibleToolResults.some(message => message.callId === reads[1].callId && /^[a-f0-9]{64}$/.test(message.contentHash)))
      assert.equal(result.snapshotRecoveryRequired, true)
      assert.equal(result.snapshotRecovered, true)
    }
  })
}

test('PTC batching is a separate negative control: two calls and no retirement calibration evidence', async () => {
  const result = await runAgentFixture(retirementDiscoveryPtcFixtureV4(), 'plugin', {
    ...options(retirementDiscoveryPtcPolicyV4()), adapterFactory: withoutHiddenEvidence(retirementDiscoveryPtcAdapter),
  })
  quality(result)
  assert.equal(result.modelCalls.length, 2)
  assert.equal(result.steps, 2)
  assert.equal(result.retirements.filter(record => record.reason === 'retired').length, 0)
  assert.ok(result.toolCalls.some(call => call.name === 'run_code' && !call.isError))
  assert.ok(result.toolCalls.some(call => call.name === 'read' && call.readOriginal && !call.isError))
  assert.equal(result.snapshotRecoveryRequired, false)
  assert.equal(result.recoveryCalls, 0)
})

test('adapter derives changed locators and answer values solely from visible read messages', async () => {
  class LlmAdapter {}
  const adapter = withoutHiddenEvidence(retirementDiscoveryAdapter)({ LlmAdapter })
  const next = async messages => {
    const events = []
    for await (const event of adapter.stream({ messages })) events.push(event)
    return events.find(event => event.type === 'block-end').block
  }
  const message = (toolCallId, text) => ({ role: 'tool', toolCallId, content: [{ type: 'text', text }] })
  const source = message('fixture-1', 'Original fixture path: /visible/source-other.txt')
  const read = message('read-source', 'Revision: changed. Checkpoint value: -12.5.')
  assert.deepEqual(JSON.parse((await next([source])).arguments), { file_path: '/visible/source-other.txt', offset: 1, limit: 1 })
  assert.deepEqual(JSON.parse((await next([source, read])).text), { revision: 'changed', checkpoint: -12.5 })
  const retired = message('fixture-1', 'Original tool-result snapshot: {"locator":"/visible/snapshot-other.txt"}')
  assert.deepEqual(JSON.parse((await next([retired, read])).arguments), { file_path: '/visible/snapshot-other.txt', offset: 1, limit: 1 })
  const snapshot = message('read-snapshot', 'Revision: snapshot-version. Checkpoint value: 9.125.')
  assert.deepEqual(JSON.parse((await next([retired, read, snapshot])).text), { revision: 'snapshot-version', checkpoint: 9.125 })
  await assert.rejects(next([message('fixture-1', 'No locator')]), /Missing model-visible original source locator/)
  await assert.rejects(next([source, message('read-source', 'No header')]), /Missing model-visible version\/checkpoint header/)
})
