import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgentFixture } from '../../scripts/evaluate-agent.js'
import { acceptanceReplayAdapter } from '../../scripts/acceptance-benchmark.js'
import { acceptanceFixtures } from '../fixtures/acceptance/tasks.js'

const schema = { type: 'object', properties: { processing_status: { type: 'string' }, retry_count: { type: 'integer' } }, required: ['processing_status', 'retry_count'], additionalProperties: false }

test('declared shape feedback corrects wrappers for every group and charges each extra call', async () => {
  for (const group of ['baseline-default', 'baseline-tuned', 'plugin']) {
    const fixture = { ...acceptanceFixtures()[0], responseSchema: schema }
    const adapterFactory = options => {
      const adapter = acceptanceReplayAdapter(options)
      const stream = adapter.stream.bind(adapter)
      let wrapped = false
      adapter.stream = async function* (request) {
        for await (const chunk of stream(request)) {
          if (!wrapped && chunk.type === 'block-end' && chunk.block.type === 'text') {
            wrapped = true
            yield { ...chunk, block: { ...chunk.block, text: JSON.stringify({ contents: JSON.parse(chunk.block.text) }) } }
          } else yield chunk
        }
      }
      return adapter
    }
    const result = await runAgentFixture(fixture, group, { replay: true, validationFeedbackLimit: 2, adapterFactory })
    assert.equal(result.passed, true)
    assert.equal(result.responseSchemaSatisfied, true)
    assert.equal(result.correctionCount, 1)
    assert.equal(result.modelCalls.length, 4)
    assert.match(JSON.stringify(result.feedback), /Response schema/)
    assert.equal(JSON.stringify(result.feedback).includes('blocked'), false)
  }
})

test('phase schema overrides the fixture and malformed schemas reject before adapter invocation', async () => {
  const base = acceptanceFixtures()[0]
  const result = await runAgentFixture({ ...base, responseSchema: { type: 'null' }, phases: [{ query: base.query, expected: base.expected, responseSchema: schema }] }, 'baseline-default', { replay: true, adapterFactory: acceptanceReplayAdapter })
  assert.equal(result.passed, true)
  let calls = 0
  await assert.rejects(runAgentFixture({ ...base, responseSchema: { type: 'object', enum: ['answer'] } }, 'baseline-default', { replay: true, adapterFactory() { calls++ } }), TypeError)
  assert.equal(calls, 0)
})

test('declared scalar/null roots parse without corrections while malformed JSON can never certify null', async () => {
  for (const [text, responseSchema, expected, passes] of [['null', { type: 'null' }, null, true], ['42', { type: 'integer' }, 42, true], ['not-json', { type: 'null' }, null, false]]) {
    const fixture = { ...acceptanceFixtures()[0], responseSchema, expected }
    const adapterFactory = options => {
      const adapter = acceptanceReplayAdapter(options)
      const stream = adapter.stream.bind(adapter)
      adapter.stream = async function* (request) {
        for await (const chunk of stream(request)) yield chunk.type === 'block-end' && chunk.block.type === 'text' ? { ...chunk, block: { ...chunk.block, text } } : chunk
      }
      return adapter
    }
    const result = await runAgentFixture(fixture, 'baseline-default', { replay: true, adapterFactory, validationFeedbackLimit: 2 })
    assert.equal(result.passed, passes)
    assert.equal(result.responseSchemaSatisfied, passes)
    assert.equal(result.correctionCount, passes ? 0 : 2)
    assert.equal(result.phaseResults[0].responseText, text)
  }
})

test('heterogeneous response types preserve precision and null while exact facts remain a separate gate', async () => {
  const fixture = { ...acceptanceFixtures().find(task => task.id === 'json-nested-precision'), responseSchema: {
    type: 'object', properties: { decimal: { type: 'string' }, integer: { type: 'string' }, missing: { type: 'null' },
      variants: { type: 'array', items: { type: ['boolean', 'number', 'string', 'object', 'null'] } } },
    required: ['decimal', 'integer', 'missing', 'variants'], additionalProperties: false,
  } }
  for (const changeFacts of [false, true]) {
    const adapterFactory = options => {
      const adapter = acceptanceReplayAdapter(options), stream = adapter.stream.bind(adapter)
      adapter.stream = async function* (request) {
        for await (const chunk of stream(request)) {
          if (changeFacts && chunk.type === 'block-end' && chunk.block.type === 'text') {
            const answer = JSON.parse(chunk.block.text)
            answer.variants = [true, 99, 'changed', { unrelated: null }]
            yield { ...chunk, block: { ...chunk.block, text: JSON.stringify(answer) } }
          } else yield chunk
        }
      }
      return adapter
    }
    const result = await runAgentFixture(fixture, 'baseline-default', { replay: true, adapterFactory, validationFeedbackLimit: 2 })
    assert.equal(result.responseSchemaSatisfied, true)
    assert.equal(result.passed, !changeFacts)
    assert.equal(result.correctionCount, 0)
    assert.equal(result.phaseResults[0].actual.missing, null)
    assert.equal(result.phaseResults[0].actual.decimal, fixture.expected.decimal)
  }
})
