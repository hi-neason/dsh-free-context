// Synthetic conversion-path regression only, not a coding or savings benchmark.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const runtime = createRequire(process.env.DSH_CLI_RUNTIME_PACKAGE)
const { LlmAdapter } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-llm')).href)
const { defineContentToolFixture } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-tools')).href)
export const inject = ['llm', 'tools']
export function apply(ctx) {
  const rows = Array.from({ length: 70 }, (_, i) => ({ record_identifier: i, repeated_description_field: `value-${i}`, repeated_state_field: 'ok' }))
  ctx.tools.register(defineContentToolFixture({ name: 'cli_fixture', description: 'Return synthetic repeated JSON for observer ordering.', parameters: {}, execute: async () => [{ type: 'text', text: JSON.stringify(rows) }] }))
  ctx.llm.registerAdapter(['development-replay'], new class extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      const block = request.messages.some(message => message.role === 'tool')
        ? { type: 'text', text: 'CONVERSION_OBSERVED' }
        : { type: 'tool-call', id: 'conversion-fixture', name: 'cli_fixture', arguments: '{}' }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    }
  }())
  ctx.provide('developmentReplayReady', Object.freeze({ ready: true }))
}
