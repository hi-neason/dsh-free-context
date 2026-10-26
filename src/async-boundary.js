/** Stop waiting without claiming to cancel work owned by an external service. */
export function waitForBoundary(start, { signal, timeoutMs }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new RangeError('Invalid boundary timeoutMs')
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let timer
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(reject, signal.reason ?? new DOMException('Aborted', 'AbortError'))
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      const error = new Error('External operation exceeded its wait deadline')
      error.name = 'TimeoutError'
      error.code = 'BOUNDARY_TIMEOUT'
      finish(reject, error)
    }, timeoutMs)
    // Both settlements remain observed after timeout/abort, preventing late
    // rejections or successful work from changing the caller's decision.
    Promise.resolve().then(() => {
      signal?.throwIfAborted()
      return start()
    }).then(value => finish(resolve, value), error => finish(reject, error))
  })
}
