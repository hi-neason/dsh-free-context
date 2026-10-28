import { acceptanceFixturesV3 } from './tasks-v3.js'

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const string = () => ({ type: 'string' })
const number = () => ({ type: 'number' })
// Open JSON types avoid disclosing the source's null value or the mixed array's
// positions, length and values. Exact source facts remain a separate gate.
const jsonValue = () => ({ type: ['null', 'boolean', 'number', 'string', 'object', 'array'] })
const errors = () => object({ errors: { type: 'array', items: object({ test: string(), error: string(), location: string() }) } })
const status = () => object({ processing_status: string(), retry_count: number() })
const service = () => object({ service: string(), owner: string(), region: string() })
const history = () => object({ revision: string(), checkpoint: number() })
const declaration = schema => ` Response format contract: ${JSON.stringify(schema)}. This declares fields and types only; obtain values from source evidence.`

// Prospective inputs only. Never alter or retrospectively rescore v1-v3.
export function acceptanceFixturesV4() {
  const schemas = {
    'json-repeated': [status()],
    'json-nested-precision': [object({ decimal: string(), integer: string(), missing: jsonValue(), variants: { type: 'array', items: jsonValue() } })],
    'diagnostic-middle-multiple': [errors()],
    'unknown-format': [object({ alpha: number(), omega: number() })],
    'snapshot-followup': [errors(), object({ test: string(), duration_ms: number() })],
    'changed-file': [object({ version: number(), retryLimit: number() }), object({ before: number(), after: number(), version: number() })],
    'ptc-final-output': [status()],
    'experiment-task-independent': [service(), service()],
    'experiment-query-dependent': [service(), service()],
    'experiment-diagnostic-tap-fallback': [errors(), errors()],
    'experiment-diagnostic-compiler': [object({ diagnostics: { type: 'array', items: object({ path: string(), line: number(), column: number(), severity: string(), code: string() }) }, exitCode: number() }),
      object({ diagnostics: { type: 'array', items: object({ path: string(), line: number(), column: number(), severity: string(), code: string() }) }, exitCode: number() })],
    'history-retirement-short': [history()],
    'history-retirement-stress': [history()],
  }
  return acceptanceFixturesV3().map(task => {
    const { answer, ...data } = task
    task = { ...structuredClone(data), answer }
    if (task.historyRetirement) task.discoverSourcePath = true
    const phases = schemas[task.id]
    if (!phases || phases.length !== (task.phases?.length ?? 1)) throw new Error('Incomplete v4 response schema declarations')
    return task.phases
      ? { ...task, phases: task.phases.map((phase, index) => ({ ...phase, responseSchema: phases[index], query: phase.query + declaration(phases[index]) })) }
      : { ...task, responseSchema: phases[0], query: task.query + declaration(phases[0]) }
  })
}
