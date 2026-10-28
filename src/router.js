import { isDeepStrictEqual } from 'node:util'
import { isEligibleInput } from './config.js'
import { measureContent } from './diagnostics.js'
import { decodeJsonRows, encodeJsonRows } from './json-codec.js'
import { reduceNodeTap } from './log-reducer.js'
import { encodeLosslessText } from './lossless-text.js'
import { waitForBoundary } from './async-boundary.js'
import { archiveOriginal, formatSnapshotReference } from './snapshot.js'

/** Route only supported single-text results. All budgets include content-block framing. */
export function createContentRouter(config, { estimator, getStore = () => undefined, onSnapshot = () => undefined,
  getReadClassifier = () => undefined } = {}) {
  return (content, exec, { readPath } = {}) => {
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text' ||
        typeof content[0].text !== 'string') return undefined
    const input = measureContent(content, estimator)
    if (!isEligibleInput(config, exec.name, input.bytes)) return undefined
    const block = content[0]
    const smaller = replacement => {
      const output = measureContent(replacement, estimator)
      return output.bytes < input.bytes && output.estimatedTokens < input.estimatedTokens &&
        input.estimatedTokens - output.estimatedTokens >= config.minSavingsTokens
    }
    if (exec.name === 'read' && config.readText.enabled) {
      return (async () => {
        // A registry miss is not source evidence. Only an authoritative host
        // classifier may grant source classification for this execution path.
        const classifier = getReadClassifier()
        if (typeof classifier?.classify !== 'function' || typeof readPath !== 'string') return undefined
        const classified = await waitForBoundary(() => classifier.classify(readPath), { signal: exec.signal, timeoutMs: 1000 })
        if (exec.signal?.aborted || classified?.kind !== 'source' || classified.complete !== true ||
            classified.inputPath !== readPath || typeof classified.canonicalPath !== 'string') return undefined
        const encoded = encodeLosslessText(block.text, { maxInputBytes: config.maxInputBytes, maxOutputBytes: config.maxInputBytes })
        if (encoded === undefined || !smaller([{ ...block, text: encoded }])) return undefined
        const receipt = await archiveOriginal(getStore(), exec, block.text, { maxBytes: config.maxInputBytes })
        let snapshot
        try { snapshot = onSnapshot(exec, receipt, 'original') } catch {}
        const replacement = [{ ...block, text: `${encoded}\n\n${formatSnapshotReference(receipt)}` }]
        const output = measureContent(replacement, estimator)
        // A strong gate avoids obscuring modestly repetitive code merely to
        // save a few estimated tokens. All recovery framing is included.
        if (exec.signal?.aborted || !smaller(replacement) || output.bytes * 2 > input.bytes ||
            output.estimatedTokens * 2 > input.estimatedTokens) return undefined
        return { content: replacement, strategy: 'read-lossless-text-v1', lossy: false, snapshots: snapshot ? [snapshot] : [] }
      })()
    }
    if (config.json.enabled) {
      const encoded = encodeJsonRows(block.text, { maxInputBytes: config.maxInputBytes })
      // Codec only accepts object arrays, so its object envelope cannot be encoded twice.
      if (encoded !== undefined) {
        const replacement = [{ ...block, text: encoded }]
        if (!smaller(replacement)) return undefined
        const restored = decodeJsonRows(encoded, {
          maxInputBytes: config.maxInputBytes, maxOutputBytes: config.maxInputBytes,
        })
        if (!isDeepStrictEqual(JSON.parse(restored), JSON.parse(block.text))) return undefined
        return { content: replacement, strategy: 'json-rows-v1', lossy: false }
      }
    }
    if (!config.logs.enabled) return undefined
    const draft = reduceNodeTap(block.text)
    if (!draft || !smaller([{ ...block, text: draft.text }])) return undefined
    return (async () => {
      // Even observe mode archives before constructing an actual recoverable candidate.
      const receipt = await archiveOriginal(getStore(), exec, block.text, { maxBytes: config.maxInputBytes })
      let snapshot
      try { snapshot = onSnapshot(exec, receipt, 'original') } catch {}
      const replacement = [{ ...block, text: `${draft.text}\n\n${formatSnapshotReference(receipt)}` }]
      if (exec.signal?.aborted || !smaller(replacement)) return undefined
      return { content: replacement, strategy: 'node-tap-v13', lossy: true, snapshots: snapshot ? [snapshot] : [] }
    })()
  }
}
