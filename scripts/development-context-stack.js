// Evaluation-only composition through each plugin's public apply/Config API.
// Register the hooks synchronously in order; profile insertion alone does not
// guarantee registration order across modules with different loading times.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createFilesystemReadClassifier } from '../src/read-source-classifier.js'
import { apply as applyFreeContext } from '../src/index.js'
import { apply as applyBoundary } from './development-compression-boundary.js'
import { apply as applyObserver } from './development-cli-observer.js'
const config = Object.freeze(JSON.parse(readFileSync(process.env.DSH_DEVELOPMENT_CONFIG, 'utf8')))
const runtime = createRequire(config.runtimePackage)
const nativeSpill = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-spill-policy')).href)
export const inject = ['llm', 'tools']
export async function apply(ctx) {
  applyBoundary(ctx, { position: 'input' })
  if (config.readText?.enabled) {
    if (!config.plugin || config.readText.classifier !== 'filesystem-host-v1' || config.readText.minimumSavingsRatio !== 0.5) throw new Error('Invalid development read policy')
    // This isolated profile has exactly one artifact backend: SpillLocal.
    // Its frozen root covers native spills and plugin snapshots; no other backend is loaded.
    ctx.provide('freeContextReadClassifier', createFilesystemReadClassifier({
      sourceRoots: [config.workspace], artifactRoots: [config.spill], artifactInventoryComplete: true,
    }))
  }
  if (config.plugin) applyFreeContext(ctx, { mode: 'apply', tools: config.tools, minInputBytes: 0,
    ...(config.encodeToolText === true ? { text: { enabled: true } } : {}),
    ...(config.readText?.enabled ? { readText: { enabled: true, ...(config.readText.encodeArtifacts === true ? { encodeArtifacts: true } : {}) } } : {}) })
  applyBoundary(ctx, { position: 'output' })
  nativeSpill.apply(ctx, nativeSpill.Config({ maxInlineTokens: config.maxInlineTokens }))
  await applyObserver(ctx)
}
