// Evaluation-only observers immediately before/after free-context and before
// native spill. They return the same decisions and never alter content.
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const config = Object.freeze(JSON.parse(readFileSync(process.env.DSH_DEVELOPMENT_CONFIG, 'utf8')))
export const inject = ['tools']
export function apply(ctx, { position } = {}) {
  if (!['input', 'output'].includes(position)) throw new TypeError('Explicit compression observation boundary required')
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const serialized = JSON.stringify(decision.content ?? result.content)
    appendFileSync(config.ledger, JSON.stringify({ type: `compression/${position}`, callId: exec.callId, manifestHash: config.manifestHash,
      contentHash: createHash('sha256').update(serialized).digest('hex'), bytes: Buffer.byteLength(serialized, 'utf8') }) + '\n', { mode: 0o600 })
    return decision
  }, { prepend: true })
}
