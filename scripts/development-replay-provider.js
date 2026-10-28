// Deterministic control only; never loaded in live evaluations.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const config = JSON.parse(readFileSync(process.env.DSH_DEVELOPMENT_CONFIG, 'utf8'))
export const inject = ['llm']
export async function apply(ctx) {
  if (!config.replay) throw new Error('Scripted provider is replay-only')
  const runtime = createRequire(config.runtimePackage)
  const { LlmAdapter } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-llm')).href)
  const control = readFileSync(config.controlSource, 'utf8')
  ctx.llm.registerAdapter(['development-replay'], new class extends LlmAdapter {
    index = 0
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() {
      const tool = (name, args) => ({ type: 'tool-call', id: `development-${this.index}`, name, arguments: JSON.stringify(args) })
      const actions = [
        () => tool('bash', { command: config.testCommands[0], description: 'Reproduce historical regression', timeoutMs: 5000 }),
        () => tool('read', { file_path: 'src/json-codec.js', offset: 1, limit: 300 }),
        () => tool('write', { file_path: 'src/json-codec.js', content: control }),
        () => tool('bash', { command: config.testCommands[0], description: 'Verify repair', timeoutMs: 5000 }),
        () => ({ type: 'text', text: 'Scripted historical repair and tests completed.' }),
      ]
      const block = actions[this.index++]?.()
      if (!block) throw new Error('Scripted development protocol exceeded')
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    }
  }())
  ctx.provide('developmentReplayReady', Object.freeze({ ready: true }))
}
