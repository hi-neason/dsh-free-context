import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { acceptanceFixturesV4 } from '../fixtures/acceptance/tasks-v4.js'
import { acceptanceFixturesV3 } from '../fixtures/acceptance/tasks-v3.js'
import { runAgentFixture } from '../../scripts/evaluate-agent.js'
import { acceptanceReplayAdapterV4, createAcceptancePlanV4, summarizeAcceptanceV4 } from '../../scripts/acceptance-benchmark-v4.js'

for (const id of ['history-retirement-short', 'history-retirement-stress']) for (const group of ['baseline-default', 'baseline-tuned', 'plugin']) {
  test(`v4 ${id}/${group} obtains locators from visible messages before lifecycle decisions`, async () => {
    const fixture = acceptanceFixturesV4().find(task => task.id === id)
    const previous = acceptanceFixturesV3().find(task => task.id === id)
    assert.equal(fixture.discoverSourcePath, true)
    assert.equal(previous.discoverSourcePath, undefined)
    assert.equal(fixture.text, previous.text)
    assert.deepEqual(fixture.expected, previous.expected)
    assert.deepEqual(fixture.historyRetirement, previous.historyRetirement)
    let first = true
    const result = await runAgentFixture(fixture, group, { replay: true, composeWithTunedNative: true, validationFeedbackLimit: 2, maxSteps: 12, timeoutMs: 120000,
      historyRetirement: fixture.historyRetirement,
      adapterFactory: options => {
        const restricted = new Proxy(options, { get(target, key) {
          if (!['LlmAdapter', 'fixture'].includes(key)) throw new Error('Hidden replay evidence accessed')
          if (key === 'fixture') return new Proxy(target.fixture, { get(task, name) {
            if (!['id', 'discoverSourcePath'].includes(name)) throw new Error('Hidden fixture evidence accessed')
            return task[name]
          } })
          return target[key]
        } })
        const adapter = acceptanceReplayAdapterV4(restricted), stream = adapter.stream.bind(adapter)
        adapter.stream = async function* (request) {
          if (first) { first = false; assert.equal(JSON.stringify(request.messages).includes('Original fixture path:'), false) }
          yield* stream(request)
        }
        return adapter
      } })
    assert.equal(result.passed, true, JSON.stringify({ id, group, phases: result.phaseResults, retirements: result.retirements }))
    assert.equal(result.correctionCount, 0)
    assert.equal(result.estimatedCostUSD, null)
    assert.equal(result.configuration.maxInlineTokens, group === 'baseline-default' ? 12500 : 1200)
    const retired = result.retirements.filter(row => row.reason === 'retired')
    const stress = id === 'history-retirement-stress' && group === 'plugin'
    assert.equal(result.modelCalls.length, stress ? 4 : 3)
    assert.equal(retired.length, stress ? 1 : 0)
    const reads = result.toolCalls.filter(call => call.name === 'read')
    assert.equal(reads[0].readOriginal, true)
    assert.ok(reads.every(call => call.readWindow.requested.offset === 1 && call.readWindow.requested.limit === 1))
    if (group === 'plugin') {
      if (stress) {
        assert.equal(retired[0].beforeStep, 3)
        assert.equal(retired[0].actualPostRetirementSteps, 2)
        assert.equal(reads[1].readSnapshot, true)
        assert.ok(result.modelCalls.at(-1).visibleToolResults.some(row => row.callId === reads[1].callId))
      } else assert.ok(result.retirements.some(row => row.reason === 'economic-gate' && row.economics.adopt === false && row.economics.minimumFutureRequests === 2))
    }
  })
}

test('pre-discovery v4 manifests cannot be mixed into the revised protocol', () => {
  const revised = createAcceptancePlanV4()
  const prior = structuredClone(revised)
  // Reconstruct the historical protocol, including its original response cap.
  prior.experimentSettings.maxOutputTokens = 120
  for (const task of prior.tasks.filter(task => task.historyRetirement)) delete task.discoverSourcePath
  delete prior.manifestHash
  prior.manifestHash = createHash('sha256').update(JSON.stringify(prior)).digest('hex')
  assert.equal(prior.manifestHash, '9d5dbd5aad3a18ead8203d78420a168adf09f5a53a94d696e9ef9c5d375961ba')
  assert.notEqual(prior.manifestHash, revised.manifestHash)
  assert.equal(summarizeAcceptanceV4(prior, [], { replay: true }).planValid, false)
  assert.equal(summarizeAcceptanceV4(revised, [], { replay: true }).planValid, true)
})
