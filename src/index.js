import { createPostExecuteHandler } from './pipeline.js'

export const name = 'dsh-free-context'
export const inject = ['tools']

/** Register a pass-through policy until a validated compression strategy is enabled. */
export function apply(ctx) {
  ctx.on('tools/post-execute', createPostExecuteHandler(
    undefined,
    message => ctx.logger.warn(message),
  ), { prepend: true })
}
