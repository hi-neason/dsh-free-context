// Evaluation-only composition through each plugin's public apply/Config API.
// Register the hooks synchronously in order; profile insertion alone does not
// guarantee registration order across modules with different loading times.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { apply as applyFreeContext } from '../src/index.js'
import { apply as applyBoundary } from './development-compression-boundary.js'
import { apply as applyObserver } from './development-cli-observer.js'
const config = Object.freeze(JSON.parse(readFileSync(process.env.DSH_DEVELOPMENT_CONFIG, 'utf8')))
const runtime = createRequire(config.runtimePackage)
const nativeSpill = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-spill-policy')).href)
export const inject = ['llm', 'tools']
export async function apply(ctx) {
  applyBoundary(ctx, { position: 'input' })
  if (config.plugin) applyFreeContext(ctx, { mode: 'apply', tools: config.tools, minInputBytes: 0 })
  applyBoundary(ctx, { position: 'output' })
  nativeSpill.apply(ctx, nativeSpill.Config({ maxInlineTokens: config.maxInlineTokens }))
  await applyObserver(ctx)
}
