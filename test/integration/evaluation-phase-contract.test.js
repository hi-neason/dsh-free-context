import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgentFixture } from '../../scripts/evaluate-agent.js'
import { acceptanceFixtures } from '../fixtures/acceptance/tasks.js'
import { acceptanceReplayAdapter } from '../../scripts/acceptance-benchmark.js'

test('each requested phase must consume a new successful fixture result', async () => {
  const fixture = acceptanceFixtures()[0]
  fixture.requireFixtureEachPhase = true
  fixture.phases = [0, 1].map(() => ({ query: fixture.query, expected: fixture.expected }))
  const adapterFactory = options => {
    const adapter = acceptanceReplayAdapter(options)
    const stream = adapter.stream.bind(adapter)
    adapter.stream = async function* (request) {
      if (options.phase() === 0) { yield* stream(request); return }
      // Deliberately correct facts with no new phase tool call must still fail.
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(fixture.expected) } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    return adapter
  }
  const result = await runAgentFixture(fixture, 'baseline-tuned', { replay: true, adapterFactory, validationFeedbackLimit: 2 })
  assert.equal(result.phaseResults[0].passed, true)
  assert.equal(result.passed, false)
  assert.equal(result.requiredTools, false)
  assert.equal(result.phaseResults[1].passed, true) // Correct facts alone do not satisfy the tool contract.
  assert.equal(result.feedback.length, 2)
})

test('read trace records numeric windows without leaking paths or claiming byte verification', async () => {
  const fixture = acceptanceFixtures()[0]
  for (const offset of [1, 10000]) {
    const adapterFactory = options => {
      const adapter = acceptanceReplayAdapter(options)
      const stream = adapter.stream.bind(adapter)
      adapter.stream = async function* (request) {
        for await (const chunk of stream(request)) {
          if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' && chunk.block.name === 'read') {
            const args = JSON.parse(chunk.block.arguments)
            yield { ...chunk, block: { ...chunk.block, arguments: JSON.stringify({ ...args, offset, limit: 1000 }) } }
          } else yield chunk
        }
      }
      return adapter
    }
    const result = await runAgentFixture(fixture, 'baseline-tuned', { replay: true, adapterFactory })
    const read = result.toolCalls.find(call => call.name === 'read')
    assert.deepEqual(read.readWindow.requested, { offset, limit: 1000 })
    assert.equal(read.readWindow.byteVerified, false)
    if (offset === 1) {
      assert.equal(read.readWindow.returned.offset, 1)
      assert.equal(read.readWindow.returned.coversAllReportedLines, true)
    } else {
      assert.ok(read.isError || read.readWindow.returned?.lineCount === 0)
      assert.notEqual(read.readWindow.returned?.coversAllReportedLines, true)
    }
    assert.equal(JSON.stringify(read.readWindow).includes('file_path'), false)
    assert.equal(JSON.stringify(read.readWindow).includes('job-40'), false)
  }
})

test('opt-in placeholder feedback is bounded, source-independent and charged for every group', async () => {
  const fixture = { ...acceptanceFixtures()[0], rejectPlaceholderValues: true }
  for (const group of ['baseline-default', 'baseline-tuned', 'plugin']) {
    const adapterFactory = options => {
      const adapter = acceptanceReplayAdapter(options)
      const stream = adapter.stream.bind(adapter)
      let replaced = false
      adapter.stream = async function* (request) {
        for await (const chunk of stream(request)) {
          if (!replaced && chunk.type === 'block-end' && chunk.block.type === 'text') {
            replaced = true
            yield { ...chunk, block: { type: 'text', text: '{"processing_status":"Not available in source","retry_count":null}' } }
          } else yield chunk
        }
      }
      return adapter
    }
    const result = await runAgentFixture(fixture, group, { replay: true, adapterFactory, validationFeedbackLimit: 2 })
    assert.equal(result.passed, true)
    assert.equal(result.correctionCount, 1)
    assert.equal(result.modelCalls.length, 4)
    assert.equal(result.drafts[0].exactFacts, false)
    assert.match(JSON.stringify(result.feedback), /placeholder/)
    assert.equal(JSON.stringify(result.feedback).includes('blocked'), false)
    assert.equal(JSON.stringify(result.feedback).includes('retry_count'), false)
  }
})

test('literal unknown/null source values remain valid unless the response contract is explicitly enabled', async () => {
  const fixture = acceptanceFixtures()[0]
  fixture.text = JSON.stringify([{ record_identifier: 'job-40', processing_status: 'unknown', retry_count: null }])
  fixture.expected = { processing_status: 'unknown', retry_count: null }
  fixture.query = 'Call fixture and return its processing_status and retry_count exactly as JSON.'
  const compatible = await runAgentFixture(fixture, 'baseline-default', { replay: true, adapterFactory: acceptanceReplayAdapter })
  assert.equal(compatible.passed, true)
  assert.equal(compatible.responseContractSatisfied, true)
  const required = await runAgentFixture({ ...fixture, rejectPlaceholderValues: true }, 'baseline-default', { replay: true, adapterFactory: acceptanceReplayAdapter, validationFeedbackLimit: 2 })
  assert.equal(required.passed, false)
  assert.equal(required.responseContractSatisfied, false)
  assert.equal(required.correctionCount, 2)
  assert.equal(required.modelCalls.length, 5)
})
