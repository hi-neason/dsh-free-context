import assert from 'node:assert/strict'
import test from 'node:test'
import { runAgentFixture } from '../../scripts/evaluate-agent.js'
import { decodeLosslessText } from '../../src/lossless-text.js'

const text = 'Repeated operational explanation. '.repeat(500) + '\nMAGIC alpha=>17; omega=>29\n'
const fixture = { id: 'tool-text-visible', kind: 'acceptance', text, query: 'Call fixture and return MAGIC as JSON.', expected: { alpha: 17, omega: 29 } }

for (const [label, sourceText] of [['plain text', text], ['JSON with an unprofitable rows encoding', JSON.stringify([{ a: text }])]]) {
test(`official AgentLoop persists ${label} encoding and sends it through tuned native spill`, async () => {
  const text = sourceText
  const task = { ...fixture, text }
  const observed = []
  const result = await runAgentFixture(task, 'plugin', { replay: true, encodeToolText: true, composeWithTunedNative: true,
    adapterFactory: ({ LlmAdapter }) => new class extends LlmAdapter {
      async resolveModel(provider, model) { return { provider, id: model, name: model } }
      async *stream(request) {
        const visible = request.messages.find(message => message.role === 'tool')
        let block
        if (!visible) block = { type: 'tool-call', id: 'tool-text', name: 'fixture', arguments: '{}' }
        else {
          const encoded = visible.content[0].text
          observed.push(encoded)
          assert.equal(decodeLosslessText(encoded), text)
          const m = decodeLosslessText(encoded).match(/MAGIC alpha=>(\d+); omega=>(\d+)/)
          block = { type: 'text', text: JSON.stringify({ alpha: +m[1], omega: +m[2] }) }
        }
        yield { type: 'block-start', index: 0, blockType: block.type }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } }
        yield { type: 'finish', reason: { kind: visible ? 'stop' : 'tool-calls' } }
      }
    } })
  assert.equal(result.passed, true)
  assert.equal(result.configuration.encodeToolText, true)
  assert.equal(observed.length, 1)
  assert.ok(result.decisions.some(row => row.strategy === 'tool-lossless-text-v1' && row.outcome === 'selected'))
  assert.equal(result.recoveryCalls, 0)
  assert.equal(result.steps, 2)
})
}

test('tool text evaluation flag requires an explicit boolean', async () => {
  await assert.rejects(runAgentFixture(fixture, 'plugin', { replay: true, encodeToolText: 'true' }), /encodeToolText/)
})
