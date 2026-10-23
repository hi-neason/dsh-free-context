import { installSnapshotTracking } from './snapshot-telemetry.js'
import { isEligibleInput, parseConfig } from './config.js'
export { Config } from './config.js'
import { createContentRouter } from './router.js'
import { createPostExecuteHandler } from './pipeline.js'
import { installReadTracking } from './read-lifecycle.js'
import { installRetirement } from './retirement.js'

export const name = 'dsh-free-context'
export const inject = ['tools']

/** Register the configured model-facing content policy and diagnostic observer. */
export function apply(ctx, input) {
  const config = parseConfig(input)
  if (config.mode === 'off') return
  const snapshotTracking = config.retirement.enabled || (config.tools.length && config.logs.enabled) ? installSnapshotTracking(ctx) : undefined
  if (config.retirement.enabled) {
    const readTracking = config.retirement.tools.includes('read') ? installReadTracking(ctx) : undefined
    installRetirement(ctx, config.retirement, { readTracking, mode: config.mode, onSnapshot: snapshotTracking?.record,
      onDecision: record => ctx.parallel('free-context/retirement', record) })
  }
  if (config.tools.length === 0 || (!config.json.enabled && !config.logs.enabled)) return
  ctx.on('tools/post-execute', createPostExecuteHandler(
    createContentRouter(config, { getStore: () => ctx.get('spillStore'), onSnapshot: snapshotTracking?.record }),
    message => ctx.logger.warn(message),
    {
      mode: config.mode,
      eligible: (exec, bytes) => isEligibleInput(config, exec.name, bytes),
      report: record => ctx.parallel('free-context/decision', record),
    },
  ), { prepend: true })
}
