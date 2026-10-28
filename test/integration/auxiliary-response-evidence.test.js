import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { runAgentFixture, priceUsage, evaluationConsoleReplacer } from '../../scripts/evaluate-agent.js'
import { acceptanceReplayAdapter } from '../../scripts/acceptance-benchmark.js'
import { acceptanceFixtures } from '../fixtures/acceptance/tasks.js'

const hash = text => createHash('sha256').update(text).digest('hex')
const usage = { inputTokens: 17, outputTokens: 120, cacheReadTokens: 3, cacheWriteTokens: 0 }
const prices = { currency: 'USD', uncached: .3, cacheRead: .006, output: 1.2, sourceUrl: 'https://example.test/synthetic' }
const config = { admission: 'measured-trial', mode: 'apply', selectionMode: 'task-independent', tools: ['fixture'], provider: 'replay', model: 'acceptance-selector-replay',
  maxInputBytes: 100000, maxPromptBytes: 120000, maxOutputBytes: 100000, maxOutputTokens: 120, maxArtifactBytes: 160000, timeoutMs: 30000, maxParagraphs: 100,
  maxCalls: 1, maxTotalCost: 1, maxCallCost: 1, pricing: { currency: 'USD', uncachedInputPerMillion: .3, cacheReadPerMillion: .006, cacheWritePerMillion: 0, outputPerMillion: 1.2 } }

async function replay(texts, indexes) {
  const base = acceptanceFixtures().find(task => task.experiment === 'task-independent')
  const fixture = { ...base, phases: base.phases.slice(0, 1) }
  const emitted = []
  const observed = []
  const requests = []
  const row = await runAgentFixture(fixture, 'plugin', { replay: true, experimentalConfig: config, prices,
    adapterFactory(options) {
      const adapter = acceptanceReplayAdapter(options)
      const stream = adapter.stream.bind(adapter)
      adapter.stream = async function* (request) {
        const before = JSON.stringify(request.messages)
        requests.push({ kind: request.model === config.model ? 'auxiliary' : 'agent', messages: before })
        if (request.model !== config.model) { yield* stream(request); assert.equal(JSON.stringify(request.messages), before); return }
        const chunks = texts.flatMap((text, ordinal) => { const index = indexes?.[ordinal] ?? ordinal; return [{ type: 'block-start', index: ordinal, blockType: 'text' }, { type: 'block-end', index, block: { type: 'text', text } }] })
        chunks.push({ type: 'usage', usage }, { type: 'finish', reason: { kind: 'max-tokens' } })
        for (const chunk of chunks) { emitted.push(chunk); yield chunk }
        assert.equal(JSON.stringify(request.messages), before)
      }
      return adapter
    }, configureContext(ctx) {
      ctx.on('llm/stream', (request, next) => (async function* () {
        for await (const chunk of next()) { if (request.model === config.model) observed.push(chunk); yield chunk }
      })())
    } })
  assert.equal(row.passed, !indexes, JSON.stringify({ failure: row.failure, stoppedReason: row.stoppedReason, phaseResults: row.phaseResults, experiments: row.experiments, calls: row.toolCalls }))
  assert.deepEqual(row.adoptions, [])
  assert.equal(row.experiments.length, 1)
  assert.notEqual(row.experiments[0].reason, 'selected')
  const auxiliary = row.modelCalls.filter(call => call.kind === 'auxiliary')
  assert.equal(auxiliary.length, 1)
  if (indexes) {
    assert.equal(row.stoppedReason, 'incomplete-model-usage')
    assert.equal(row.modelCalls.length, 2)
    assert.equal(row.feedback.length, 0)
    assert.equal(row.cleanup.complete, true)
    assert.equal(auxiliary[0].finish, null)
    assert.equal(auxiliary[0].complete, false)
    assert.equal(row.usageComplete, false)
    observed.forEach((chunk, index) => assert.equal(chunk, emitted[index]))
    return auxiliary[0].observedAuxiliaryTextBlocks
  }
  assert.equal(auxiliary[0].finish, 'max-tokens')
  assert.equal(auxiliary[0].complete, true) // accounting completeness is not response validity
  assert.deepEqual(auxiliary[0].usage, usage)
  assert.equal(row.experiments[0].estimatedCost, priceUsage(usage, prices))
  const main = row.modelCalls.filter(call => call.kind === 'agent')
  assert.ok(main.every(call => !Object.hasOwn(call, 'observedAuxiliaryTextBlocks')))
  assert.equal(row.usageComplete, true)
  assert.equal(row.usage.inputTokens, main.length * 10 + usage.inputTokens)
  assert.equal(row.usage.outputTokens, main.length * 5 + usage.outputTokens)
  assert.equal(priceUsage(row.usage, prices), priceUsage({ inputTokens: main.length * 10 + 17, outputTokens: main.length * 5 + 120, cacheReadTokens: 3, cacheWriteTokens: 0 }, prices))
  assert.equal(row.estimatedCostUSD, null)
  assert.equal(observed.length, emitted.length)
  observed.forEach((chunk, index) => assert.equal(chunk, emitted[index]))
  assert.ok(requests.filter(request => request.kind === 'agent').every(request => !request.messages.includes('partial-marker')))
  return auxiliary[0].observedAuxiliaryTextBlocks
}

test('real AgentLoop records exact observed auxiliary text despite max-tokens and invalid JSON, without adoption', async () => {
  const text = '{"selectedIds":["p1"],"partial-marker":"中文😀\r\n'
  const evidence = await replay([text])
  assert.deepEqual(evidence, { bytes: Buffer.byteLength(text), sha256: hash(text), blockCount: 1,
    omitted: false, blocks: [{ index: 0, bytes: Buffer.byteLength(text), sha256: hash(text), text }] })
})

test('auxiliary capture enforces total UTF-8 byte budget without retaining truncated text', async () => {
  const prefix = 'partial-marker'
  const large = '😀'.repeat(4096)
  const evidence = await replay([prefix, large])
  assert.equal(evidence.bytes, Buffer.byteLength(prefix + large))
  assert.equal(evidence.sha256, hash(prefix + large))
  assert.equal(evidence.omitted, true)
  assert.deepEqual(evidence.blocks, [
    { index: 0, bytes: Buffer.byteLength(prefix), sha256: hash(prefix), text: prefix },
    { index: 1, bytes: Buffer.byteLength(large), sha256: hash(large), omitted: true },
  ])
  const exact = await replay([large])
  assert.equal(exact.blocks[0].text, large)
  assert.equal(exact.omitted, false)
})

test('auxiliary capture retains at most 16 block records and hashes all observed text', async () => {
  const texts = Array.from({ length: 17 }, (_, i) => `partial-marker-${i}`)
  const evidence = await replay(texts)
  assert.equal(evidence.blockCount, 17)
  assert.equal(evidence.blocks.length, 16)
  assert.equal(evidence.bytes, Buffer.byteLength(texts.join('')))
  assert.equal(evidence.sha256, hash(texts.join('')))
  assert.equal(evidence.omitted, true)
  assert.deepEqual(evidence.blocks.map(block => block.text), texts.slice(0, 16))
  const exact = await replay(texts.slice(0, 16))
  assert.equal(exact.blockCount, 16)
  assert.equal(exact.omitted, false)
})


test('malformed provider indexes cannot enlarge diagnostic metadata or leak arbitrary bodies', async () => {
  const indexes = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'private-index-body'.repeat(2000), { body: 'private-index-body' }]
  for (const index of indexes) {
    const evidence = await replay(['partial-marker'], [index])
    assert.equal(evidence.blocks.length, 1)
    assert.equal(evidence.blocks[0].index, null)
    assert.equal(JSON.stringify(evidence).includes('private-index-body'), false)
  }
})


test('console redaction is total for valid evidence and malformed same-named answer fields', () => {
  for (const value of [null, false, 42, 'private-raw-body', [], { blocks: null }, { blocks: 'private-raw-body' },
    { blocks: [{ text: 'private-raw-body', index: { body: 'private-raw-body' } }], bytes: 16, sha256: 'private-raw-body' }]) {
    const report = { modelCalls: [{ observedAuxiliaryTextBlocks: value }], answer: { observedAuxiliaryTextBlocks: value }, usageComplete: true }
    const serialized = JSON.stringify(report, evaluationConsoleReplacer)
    assert.equal(serialized.includes('private-raw-body'), false)
    assert.deepEqual(JSON.parse(serialized), { modelCalls: [{ observedAuxiliaryTextBlocks: { consoleTextOmitted: true } }],
      answer: { observedAuxiliaryTextBlocks: { consoleTextOmitted: true } }, usageComplete: true })
  }
})
