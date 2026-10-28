// Synthetic interruption regression; no remote model or repair control.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const config = JSON.parse(readFileSync(process.env.DSH_DEVELOPMENT_CONFIG, 'utf8'))
const runtime = createRequire(config.runtimePackage)
const { LlmAdapter } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-llm')).href)
export const inject = ['llm', 'tools']
export function apply(ctx) {
  if (config.interruption === 'output-limit') ctx.on('tools/execute', async (_exec, next) => {
    const timer = setInterval(() => {
      if (existsSync(config.started)) { clearInterval(timer); process.stdout.write('x'.repeat(128 * 1024)) }
    }, 10)
    try { return await next() } finally { clearInterval(timer) }
  })
  ctx.llm.registerAdapter(['development-replay'], new class extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() {
      const block = { type: 'tool-call', id: 'interrupted-bash', name: 'bash', arguments: JSON.stringify({ command: 'exec node child.js', timeoutMs: 15000, description: 'Synthetic shutdown regression' }) }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }())
  ctx.provide('developmentReplayReady', Object.freeze({ ready: true }))
}
