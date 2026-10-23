import { isDeepStrictEqual } from 'node:util'
import { isEligibleInput } from './config.js'
import { measureContent } from './diagnostics.js'
import { decodeJsonRows, encodeJsonRows } from './json-codec.js'

/** Route only supported single-text results. All budgets include content-block framing. */
export function createContentRouter(config, { estimator } = {}) {
  return (content, exec) => {
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text' ||
        typeof content[0].text !== 'string' || !config.json.enabled) return undefined
    const input = measureContent(content, estimator)
    if (!isEligibleInput(config, exec.name, input.bytes)) return undefined
    const block = content[0]
    const encoded = encodeJsonRows(block.text, { maxInputBytes: config.maxInputBytes })
    // Codec only accepts object arrays, so its object envelope cannot be encoded twice.
    if (encoded === undefined) return undefined
    const replacement = [{ ...block, text: encoded }]
    const output = measureContent(replacement, estimator)
    if (output.bytes >= input.bytes || output.estimatedTokens >= input.estimatedTokens ||
        input.estimatedTokens - output.estimatedTokens < config.minSavingsTokens) return undefined
    const restored = decodeJsonRows(encoded, { maxInputBytes: config.maxInputBytes })
    if (!isDeepStrictEqual(JSON.parse(restored), JSON.parse(block.text))) return undefined
    return { content: replacement, strategy: 'json-rows-v1', lossy: false }
  }
}
