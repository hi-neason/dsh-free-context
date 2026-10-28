// Opt-in response-contract check only. It never reads expected answer facts.
export function containsPlaceholder(value) {
  const pending = [value]
  const placeholder = /^(?:unknown|unavailable|unspecified|null|n\/a|not (?:available|found|provided|specified|present)(?: in (?:the )?(?:source|output|result))?|unable to (?:determine|find|locate))\.?$/i
  while (pending.length) {
    const item = pending.pop()
    if (item === null || typeof item === 'string' && (!item.trim() || placeholder.test(item.trim()))) return true
    if (item && typeof item === 'object') pending.push(...Object.values(item))
  }
  return false
}

const schemaTypes = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))

// Deliberately small JSON Schema subset. No constants, enums or answer facts.
// Type unions are leaves: they allow alternatives without declaring a tuple's
// positions, length or values. Structural keywords require one concrete type.
export function validateResponseSchema(schema) {
  if (schema === undefined) return
  const active = new Set()
  let nodes = 0
  function visit(node, depth) {
    if (!plain(node) || active.has(node) || depth > 12 || ++nodes > 128) throw new TypeError('Invalid or excessive response schema')
    const union = Array.isArray(node.type)
    if (union ? node.type.length < 1 || node.type.length > schemaTypes.length || [...node.type].some(type => !schemaTypes.includes(type)) || new Set(node.type).size !== node.type.length : !schemaTypes.includes(node.type)) throw new TypeError('Invalid response schema type')
    const allowed = node.type === 'object' ? ['type', 'properties', 'required', 'additionalProperties'] : node.type === 'array' ? ['type', 'items'] : ['type']
    if (Reflect.ownKeys(node).some(key => !allowed.includes(key))) throw new TypeError('Unsupported response schema keyword')
    active.add(node)
    if (node.type === 'object') {
      if (node.properties !== undefined && !plain(node.properties)) throw new TypeError('Invalid response schema properties')
      if (node.required !== undefined && (!Array.isArray(node.required) || node.required.length > 128 || [...node.required].some(key => typeof key !== 'string' || key.length > 128) || new Set(node.required).size !== node.required.length)) throw new TypeError('Invalid response schema required keys')
      if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') throw new TypeError('Invalid response schema additionalProperties')
      if (Reflect.ownKeys(node.properties ?? {}).some(key => typeof key !== 'string')) throw new TypeError('Invalid response schema property key')
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        if (key.length > 128) throw new TypeError('Excessive response schema key')
        visit(child, depth + 1)
      }
    } else if (node.type === 'array') visit(node.items, depth + 1)
    active.delete(node)
  }
  visit(schema, 0)
}

export function responseSchemaIssues(value, schema) {
  validateResponseSchema(schema)
  if (schema === undefined) return []
  const issues = []
  let visited = 0
  function inspect(actual, node, path) {
    if (issues.length >= 8) return
    if (++visited > 4096) { issues.push(`${path}: response exceeds validation budget`); return }
    const types = Array.isArray(node.type) ? node.type : [node.type]
    const valid = types.some(type => type === 'object' ? plain(actual) : type === 'array' ? Array.isArray(actual) : type === 'null' ? actual === null : type === 'integer' ? Number.isInteger(actual) : type === 'number' ? typeof actual === 'number' && Number.isFinite(actual) : typeof actual === type)
    if (!valid) { issues.push(`${path}: expected ${types.join(' or ')}`); return }
    if (node.type === 'object') {
      // Report declared paths only; do not echo arbitrary response keys/values.
      for (const key of node.required ?? []) if (!Object.hasOwn(actual, key) && issues.length < 8) issues.push(`${path}[${JSON.stringify(key)}]: required property missing`)
      if (node.additionalProperties === false && Object.keys(actual).some(key => !Object.hasOwn(node.properties ?? {}, key)) && issues.length < 8) issues.push(`${path}: undeclared properties are not allowed`)
      for (const [key, child] of Object.entries(node.properties ?? {})) if (Object.hasOwn(actual, key)) inspect(actual[key], child, `${path}[${JSON.stringify(key)}]`)
    } else if (node.type === 'array') {
      for (let i = 0; i < actual.length && issues.length < 8; i++) inspect(actual[i], node.items, `${path}[${i}]`)
    }
  }
  inspect(value, schema, '$')
  return issues
}

export const phaseResponseSchema = (fixture, phase) => Object.hasOwn(phase, 'responseSchema') ? phase.responseSchema : fixture.responseSchema
