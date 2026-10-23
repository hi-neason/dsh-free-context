import { isEligibleInput, parseConfig } from './config.js'
export { Config } from './config.js'
import { createPostExecuteHandler } from './pipeline.js'

export const name = 'dsh-free-context'
export const inject = ['tools']

/** Register a pass-through policy until a validated compression strategy is enabled. */
export function apply(ctx, input) {
  const config = parseConfig(input)
  if (config.mode === 'off' || config.tools.length === 0 || (!config.json.enabled && !config.logs.enabled)) return
  ctx.on('tools/post-execute', createPostExecuteHandler(
    undefined,
    message => ctx.logger.warn(message),
    {
      mode: config.mode,
      eligible: (exec, bytes) => isEligibleInput(config, exec.name, bytes),
      report: record => ctx.parallel('free-context/decision', record),
    },
  ), { prepend: true })
}
