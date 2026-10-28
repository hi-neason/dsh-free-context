import { resolveRetirementConfig } from './retirement.js'

const keys = ['mode', 'tools', 'minInputBytes', 'maxInputBytes', 'minSavingsTokens', 'json', 'logs', 'text', 'readText', 'retirement']

function object(value, allowed, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${path} must be a plain object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${path}: unknown key ${String(key)}`)
  }
}

function integer(input, key, fallback) {
  const value = Object.hasOwn(input, key) ? input[key] : fallback
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${key} must be a non-negative safe integer`)
  return value
}

function strategy(input, key, fallback) {
  if (!Object.hasOwn(input, key)) return Object.freeze({ enabled: fallback })
  object(input[key], ['enabled'], key)
  const enabled = Object.hasOwn(input[key], 'enabled') ? input[key].enabled : fallback
  if (typeof enabled !== 'boolean') throw new TypeError(`${key}.enabled must be boolean`)
  return Object.freeze({ enabled })
}

function readTextStrategy(input) {
  const value = Object.hasOwn(input, 'readText') ? input.readText : {}
  object(value, ['enabled', 'encodeArtifacts'], 'readText')
  const result = {}
  for (const key of ['enabled', 'encodeArtifacts']) {
    result[key] = Object.hasOwn(value, key) ? value[key] : false
    if (typeof result[key] !== 'boolean') throw new TypeError(`readText.${key} must be boolean`)
  }
  return Object.freeze(result)
}

/** Validate and copy config so caller mutations cannot change a running policy. */
export function parseConfig(input = {}) {
  object(input, keys, 'config')
  const mode = Object.hasOwn(input, 'mode') ? input.mode : 'observe'
  if (!['observe', 'apply', 'off'].includes(mode)) throw new TypeError('mode must be observe, apply or off')
  const tools = Object.hasOwn(input, 'tools') ? input.tools : []
  if (!Array.isArray(tools)) throw new TypeError('tools must be an array of unique non-empty tool names')
  for (const name of tools) {
    if (typeof name !== 'string' || !name.trim() || name.trim() !== name || /\s/.test(name)) {
      throw new TypeError('tools must contain non-empty tool names without whitespace')
    }
  }
  if (new Set(tools).size !== tools.length) throw new TypeError('tools must not contain duplicate names')
  const minInputBytes = integer(input, 'minInputBytes', 1024)
  const maxInputBytes = integer(input, 'maxInputBytes', 1024 * 1024)
  if (maxInputBytes === 0 || minInputBytes > maxInputBytes) {
    throw new TypeError('maxInputBytes must be positive and at least minInputBytes')
  }
  return Object.freeze({
    mode, tools: Object.freeze([...tools]), minInputBytes, maxInputBytes,
    minSavingsTokens: integer(input, 'minSavingsTokens', 32),
    json: strategy(input, 'json', true), logs: strategy(input, 'logs', false),
    text: strategy(input, 'text', false), readText: readTextStrategy(input),
    retirement: resolveRetirementConfig(Object.hasOwn(input, 'retirement') ? input.retirement : {}),
  })
}

/** Exact allowlist and inclusive UTF-8 byte limits shared by future strategies. */
export function isEligibleInput(config, toolName, inputBytes) {
  return config.mode !== 'off' && config.tools.includes(toolName) &&
    Number.isSafeInteger(inputBytes) && inputBytes >= config.minInputBytes && inputBytes <= config.maxInputBytes
}

/** Synchronous Standard Schema v1 consumed by Cordis 4.0.5 resolveConfig. */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'dsh-free-context',
    validate(input) {
      try { return { value: parseConfig(input) } } catch (error) {
        return { issues: [{ message: error.message }] }
      }
    },
  }),
})
