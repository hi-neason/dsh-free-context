import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { runAgentFixture, collectSearchAdoptions } from '../../scripts/evaluate-agent.js'
import { decodeSearchResults } from '../../src/search-codec.js'

const path = '/workspace/services/billing/application/subscriptions/long-module-name/source.js'
const makeText = length => Array.from({ length }, (_, i) => `${path}:${i + 1}:VALUE_${i}=${i * 7}`).join('\n') + '\n'
const hash = content => createHash('sha256').update(JSON.stringify(content)).digest('hex')

for (const [length, adopted] of [[30, true], [300, false]]) {
  test(`official search output ${adopted ? 'reaches model exactly' : 'composes with native spill without false attribution'}`, async () => {
    const text = makeText(length)
    const fixture = { id: `search-${length}`, kind: 'text', text, query: 'Call fixture and report VALUE_17 as JSON.', expected: { value: 119 } }
    const persisted = []
    const observed = []
    const selected = []
    const result = await runAgentFixture(fixture, 'plugin', { replay: true, encodeSearchResults: true, composeWithTunedNative: true,
      configureContext(ctx) {
        ctx.on('free-context/decision', row => selected.push(row))
        ctx.on('session/event', (_session, event) => { if (event.type === 'tool/result') persisted.push(structuredClone(event)) })
        ctx.on('tools/post-execute', async (_exec, raw, next) => {
          const before = structuredClone(raw)
          const decision = await next()
          assert.deepEqual(raw, before)
          assert.equal(Object.hasOwn(decision, 'value'), false)
          return decision
        }, { prepend: true })
      },
      adapterFactory: ({ LlmAdapter }) => new class extends LlmAdapter {
        async resolveModel(provider, model) { return { provider, id: model, name: model } }
        async *stream(request) {
          const visible = request.messages.filter(row => row.role === 'tool').at(-1)
          let block
          if (!visible) block = { type: 'tool-call', id: 'search', name: 'fixture', arguments: '{}' }
          else {
            observed.push(visible)
            const presented = visible.content[0].text
            let restored
            if (adopted) { restored = decodeSearchResults(presented); assert.equal(restored, text) }
            else { assert.throws(() => decodeSearchResults(presented)); assert.match(presented, /spill|truncat|stored|saved/i); restored = presented }
            const match = restored.match(/VALUE_17=(\d+)/)
            assert.ok(match, 'Answer must derive from model-visible content')
            block = { type: 'text', text: JSON.stringify({ value: Number(match[1]) }) }
          }
          yield { type: 'block-start', index: 0, blockType: block.type }
          yield { type: 'block-end', index: 0, block }
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } }
          yield { type: 'finish', reason: { kind: visible ? 'stop' : 'tool-calls' } }
        }
      } })
    assert.equal(result.passed, true, JSON.stringify({ failure: result.failure, drafts: result.drafts }))
    assert.equal(result.configuration.encodeSearchResults, true)
    assert.equal(result.decisions.some(row => row.strategy === 'search-paths-v1' && row.outcome === 'selected'), true)
    assert.equal(result.searchAdoptions.length, adopted ? 1 : 0)
    assert.equal(result.steps, 2)
    assert.equal(result.recoveryCalls, 0)
    assert.equal(hash(persisted[0].data.message.content), hash(observed[0].content))
    if (adopted) {
      const [adoption] = result.searchAdoptions
      assert.equal(adoption.modelVisible, true)
      assert.equal(adoption.persistedContentHash, adoption.modelVisibleContentHash)
      assert.deepEqual(collectSearchAdoptions(persisted, result.modelCalls, [], text), [])
      assert.deepEqual(collectSearchAdoptions(persisted, result.modelCalls, selected, text + 'changed'), [])
      assert.equal(collectSearchAdoptions(persisted, [], selected, text)[0].modelVisible, false)
      const corrupted = structuredClone(persisted)
      corrupted[0].data.message.content[0].text += '\n'
      assert.deepEqual(collectSearchAdoptions(corrupted, result.modelCalls, selected, text), [])
    }
  })
}

test('search evaluation rejects nonboolean options before runtime setup', async () => {
  await assert.rejects(runAgentFixture({}, 'plugin', { encodeSearchResults: 'true' }), /encodeSearchResults/)
})
