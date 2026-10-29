// Deterministic local provider mounted by the actual official CLI profile.
import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const installed = createRequire(process.env.DSH_CLI_PLUGIN_PACKAGE)
const { decodeJsonRows, encodeJsonRows } = await import(pathToFileURL(installed.resolve('dsh-free-context/json')).href)
const runtime = createRequire(process.env.DSH_CLI_RUNTIME_PACKAGE)
const { LlmAdapter } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-llm')).href)
const { defineContentToolFixture } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-tools')).href)
export const inject = ['llm', 'tools']
const { estimateContent } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-token-meter/estimate')).href)
const rows = Array.from({ length: process.env.DSH_CLI_EXPECT_MODE === 'off' ? 3 : 70 }, (_, i) => ({ record_identifier: i, repeated_description_field: `value-${i}`, repeated_state_field: 'ok' }))
const original = [{ type: 'text', text: JSON.stringify(rows) }]
const record = event => appendFile(process.env.DSH_CLI_EVIDENCE, JSON.stringify(event) + '\n')
class LocalProvider extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(request) {
    await record({ type: 'request', messages: request.messages })
    const results = request.messages.filter(message => message.role === 'tool')
    let block
    if (results.length === 0) block = { type: 'tool-call', id: 'cli-fixture-call', name: 'cli_fixture', arguments: '{}' }
    else {
      const result = results.at(-1)
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (process.env.DSH_CLI_EXPECT_MODE === 'off') assert.deepEqual(JSON.parse(text), rows)
      else {
        assert.equal(JSON.parse(text).format, 'dsh-json-rows')
        assert.deepEqual(JSON.parse(decodeJsonRows(text)), rows)
      }
      block = { type: 'text', text: 'CLI_ACCEPTANCE_OK' }
    }
    const tool = block.type === 'tool-call'
    yield { type: 'block-start', index: 0, blockType: tool ? 'tool-call' : 'text' }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } }
    yield { type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } }
  }
}
export function apply(ctx) {
  if (process.env.DSH_CLI_EXPECT_MODE !== 'off') {
    assert.ok(estimateContent(original) > 1200)
    assert.ok(estimateContent([{ type: 'text', text: encodeJsonRows(original[0].text) }]) < 1200)
  }
  ctx.llm.registerAdapter(['cli-local'], new LocalProvider())
  ctx.tools.register(defineContentToolFixture({ name: 'cli_fixture', description: 'Return fixed CLI acceptance data', parameters: {}, execute: async () => original }))
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.name === 'cli_fixture') {
      assert.deepEqual(result.value, original)
      assert.equal(Object.hasOwn(decision, 'value'), false)
      await record({ type: 'tool', value: result.value, content: decision.content ?? result.content })
    }
    return decision
  }, { prepend: true })
  ctx.on('free-context/decision', event => record({ type: 'decision', event }))
}
