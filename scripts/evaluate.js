import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { parseConfig } from '../src/config.js'
import { measureContent } from '../src/diagnostics.js'
import { decodeJsonRows } from '../src/json-codec.js'
import { createPostExecuteHandler } from '../src/pipeline.js'
import { createContentRouter } from '../src/router.js'

export async function loadFixtures() {
  const root = new URL('../fixtures/evaluation/', import.meta.url)
  return Promise.all((await readdir(root)).filter(name => name.endsWith('.json')).sort()
    .map(async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))))
}

/** Acceptance reads only returned content; never consults the original to fill gaps. */
export function acceptFixture(fixture, content) {
  try {
    const text = content.map(block => block.text ?? '').join('\n')
    let actual
    if (fixture.kind === 'json') {
      let value = JSON.parse(text)
      if (value?.format === 'dsh-json-rows') value = JSON.parse(decodeJsonRows(text))
      const row = value.find(item => item.record_identifier === fixture.target)
      actual = { processing_status: row.processing_status, retry_count: row.retry_count }
    } else {
      const match = text.match(/^ERROR code=(\S+) path=(\S+)$/m)
      actual = match && { code: match[1], path: match[2] }
    }
    return { passed: isDeepStrictEqual(actual, fixture.expected), actual }
  } catch {
    return { passed: false, reason: 'required-facts-unavailable' }
  }
}

export async function pluginContent(fixture) {
  const content = [{ type: 'text', text: fixture.text }]
  const config = parseConfig({ mode: 'apply', tools: ['evaluation'], minInputBytes: 0 })
  const records = []
  const handler = createPostExecuteHandler(createContentRouter(config), undefined, {
    mode: 'apply', report: record => records.push(record),
  })
  const decision = await handler({ name: 'evaluation', callId: fixture.id,
    signal: new AbortController().signal }, { content, isError: false }, async () => ({ kind: 'accept' }))
  return { content: decision.content ?? content, decision: records[0] }
}

/** Use the published native algorithm; this does not simulate Session replay or Agent turns. */
export async function nativePruners() {
  const runtime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime', 'package.json'))
  const native = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-compaction-tool-result-pruner')).href)
  const make = config => {
    const pruner = Object.create(native.ToolResultPruner.prototype)
    pruner.config = native.resolveConfig(config)
    return { config: pruner.config, apply: content => pruner.pruneContent(content) ?? content }
  }
  return { 'baseline-default': make({}), 'baseline-tuned': make({ thresholdChars: 2048, headChars: 1024, tailChars: 512 }) }
}

export async function evaluate() {
  const baselines = await nativePruners()
  const tasks = []
  for (const fixture of await loadFixtures()) {
    const original = [{ type: 'text', text: fixture.text }]
    const plugin = await pluginContent(fixture)
    const variants = Object.fromEntries(Object.entries(baselines).map(([name, baseline]) => [name, {
      content: baseline.apply(original), configuration: baseline.config, strategy: 'official-native-pruneContent',
    }]))
    variants.plugin = { content: plugin.content, strategy: plugin.decision.strategy ?? 'pass-through',
      candidateSelected: plugin.decision.outcome === 'selected', reason: plugin.decision.reason }
    tasks.push({ id: fixture.id, groups: Object.fromEntries(Object.entries(variants).map(([name, variant]) => {
      const { content, ...metadata } = variant
      return [name, { ...metadata, input: measureContent(original), output: measureContent(content),
        acceptance: acceptFixture(fixture, content) }]
    })) })
  }
  return {
    evaluationKind: 'offline-deterministic-content-microbenchmark',
    estimateKind: 'serialized-content-utf8-bytes-divided-by-three',
    limitations: [
      'Baseline labels refer only to official native pruneContent with default or declared tuned budgets, not a full default DSH runtime.',
      'Plugin group uses the actual router and post-execute pipeline; no model or Agent runs.',
      'Acceptance decodes reversible JSON with the real codec; it does not prove model comprehension.',
      'Fixtures deliberately place facts in the middle. Native Session recovery is not exercised, so a failed content-only check is not a failed DSH task.',
      'No provider token usage, cache savings, retries, recovery calls, latency or monetary savings are measured.',
    ],
    tasks,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await evaluate(), null, 2)) } catch (error) {
    console.error(`Evaluation could not run: ${error.code ?? error.name}. Install the documented official integration runtime.`)
    process.exitCode = 1
  }
}
