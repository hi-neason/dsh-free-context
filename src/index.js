import { isEligibleInput, parseConfig } from './config.js'
export { Config } from './config.js'
import { createContentRouter } from './router.js'
import { createPostExecuteHandler } from './pipeline.js'

export const name = 'dsh-free-context'
export const inject = ['tools']

/** Register the configured model-facing content policy and diagnostic observer. */
export function apply(ctx, input) {
  const config = parseConfig(input)
  if (config.mode === 'off' || config.tools.length === 0 || (!config.json.enabled && !config.logs.enabled)) return
  ctx.on('tools/post-execute', createPostExecuteHandler(
    createContentRouter(config),
    message => ctx.logger.warn(message),
    {
      mode: config.mode,
      eligible: (exec, bytes) => isEligibleInput(config, exec.name, bytes),
      report: record => ctx.parallel('free-context/decision', record),
    },
  ), { prepend: true })
}
