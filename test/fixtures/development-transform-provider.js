// Synthetic conversion-path regression only, not a coding or savings benchmark.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { decodeLosslessText } from '../../src/lossless-text.js'
const config = JSON.parse(readFileSync(process.env.DSH_DEVELOPMENT_CONFIG, 'utf8'))
const runtime = createRequire(process.env.DSH_CLI_RUNTIME_PACKAGE)
const { LlmAdapter } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-llm')).href)
const { defineContentToolFixture } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-tools')).href)
export const inject = ['llm', 'tools']
export function apply(ctx) {
  if (config.suppressCandidate) ctx.on('free-context/decision', event => event.outcome === 'selected' ? new Promise(() => {}) : undefined)
  const rows = Array.from({ length: 70 }, (_, i) => ({ record_identifier: i, repeated_description_field: `value-${i}`, repeated_state_field: 'ok' }))
  ctx.tools.register(defineContentToolFixture({ name: 'cli_fixture', description: 'Return synthetic repeated JSON for observer ordering.', parameters: {}, execute: async () => [{ type: 'text', text: JSON.stringify(rows) }] }))
  ctx.llm.registerAdapter(['development-replay'], new class extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      const tools = request.messages.filter(message => message.role === 'tool')
      if (config.readFixture && tools.length) {
        const visible = tools.at(-1).content[0].text
        const restored = visible.startsWith('[dsh-lossless-text:')
          ? decodeLosslessText(visible.split('\n\nOriginal tool-result snapshot: ')[0]) : visible
        if (!restored.includes('UNIQUE_READ_FACT')) throw new Error('Model-visible read lacks required fact')
      }
      const block = tools.length
        ? { type: 'text', text: 'CONVERSION_OBSERVED' }
        : config.readFixture ? { type: 'tool-call', id: 'conversion-fixture', name: 'read', arguments: JSON.stringify({ file_path: config.readFixture }) }
          : { type: 'tool-call', id: 'conversion-fixture', name: 'cli_fixture', arguments: '{}' }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    }
  }())
  ctx.provide('developmentReplayReady', Object.freeze({ ready: true }))
}
