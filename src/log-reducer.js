const duration = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const instructionLike = /ignore\s+(?:all\s+)?(?:previous|prior)|system\s+prompt|developer\s+message|忽略.{0,8}(?:指令|规则)|系统提示|<\/?(?:system|instruction)>/i

/**
 * Recognize a narrow Node TAP v13 dialect, not arbitrary TAP or console output.
 * Keep every failing block verbatim and every success status/title. Only known
 * successful duration/type metadata and duplicated Subtest labels are omitted.
 */
export function reduceNodeTap(text) {
  if (typeof text !== 'string' || text.includes('\r') || instructionLike.test(text)) return undefined
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  if (lines[0] !== 'TAP version 13') return undefined
  let cursor = 1
  let count = 0
  let successes = 0
  let failures = 0
  const retained = []
  while (lines[cursor]?.startsWith('# Subtest: ')) {
    const start = cursor
    const title = lines[cursor++].slice('# Subtest: '.length)
    if (!title || title.includes('#')) return undefined
    count++
    const status = lines[cursor++]
    const passed = status === `ok ${count} - ${title}`
    if (!passed && status !== `not ok ${count} - ${title}`) return undefined
    if (lines[cursor++] !== '  ---') return undefined
    const metadataStart = cursor
    while (cursor < lines.length && lines[cursor] !== '  ...') {
      if (!lines[cursor].startsWith('  ')) return undefined
      cursor++
    }
    if (lines[cursor++] !== '  ...') return undefined
    const metadata = lines.slice(metadataStart, cursor - 1)
    if (!metadata[0]?.startsWith('  duration_ms: ') || !duration.test(metadata[0].slice(15)) || metadata[1] !== "  type: 'test'") return undefined
    if (passed) {
      if (metadata.length !== 2) return undefined
      successes++
      retained.push(status)
    } else {
      if (!metadata.some(line => line.startsWith('  location: ')) ||
          !metadata.some(line => line.startsWith('  failureType: ')) ||
          !metadata.some(line => line.startsWith('  error: '))) return undefined
      failures++
      retained.push(lines.slice(start, cursor).join('\n'))
    }
  }
  if (!successes || lines[cursor++] !== `1..${count}`) return undefined
  const summary = [
    `# tests ${count}`, '# suites 0', `# pass ${successes}`, `# fail ${failures}`,
    '# cancelled 0', '# skipped 0', '# todo 0',
  ]
  for (const line of summary) if (lines[cursor++] !== line) return undefined
  const timing = lines[cursor++]
  if (!timing?.startsWith('# duration_ms ') || !duration.test(timing.slice(14)) || cursor !== lines.length) return undefined
  return {
    text: [
      '[LOSSY Node TAP preview: successful-test Subtest labels and duration/type metadata omitted.]',
      `Omitted detail blocks: ${successes}. Kept all ${count} status/title lines, ${failures} complete failure blocks, and summary. This is not a complete TAP stream; retrieve the original snapshot for omitted evidence.`,
      'TAP version 13', ...retained, `1..${count}`, ...summary, timing,
    ].join('\n'),
    omittedSuccessCount: successes,
    retainedFailureCount: failures,
  }
}

/** Narrow flat Node spec reports. Success titles/durations are omitted; every
 * failure status, diagnostic appendix and summary character remains available.
 */
export function reduceNodeSpec(text) {
  if (typeof text !== 'string' || !text.isWellFormed() || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text) || instructionLike.test(text)) return undefined
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
  const statusPattern = /^([✔✖]) (.+) \(((?:0|[1-9]\d*)(?:\.\d+)?)ms\)$/
  const failed = []
  let cursor = 0, successes = 0
  while (statusPattern.test(lines[cursor] ?? '')) {
    const line = lines[cursor++]
    if (line.startsWith('✔ ')) successes++
    else failed.push(line)
  }
  if (!successes) return undefined
  const summaryStart = cursor
  const summary = [`ℹ tests ${successes + failed.length}`, 'ℹ suites 0', `ℹ pass ${successes}`, `ℹ fail ${failed.length}`,
    'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0']
  for (const line of summary) if (lines[cursor++] !== line) return undefined
  const timing = lines[cursor++]
  if (!timing?.startsWith('ℹ duration_ms ') || !duration.test(timing.slice(14))) return undefined
  const summaryEnd = cursor
  if (failed.length) {
    if (lines[cursor++] !== '' || lines[cursor++] !== '✖ failing tests:' || lines[cursor++] !== '') return undefined
    for (const status of failed) {
      if (!/^test at .+:[1-9]\d*:[1-9]\d*$/.test(lines[cursor++] ?? '') || lines[cursor++] !== status) return undefined
      let diagnosticLines = 0
      while (cursor < lines.length && (lines[cursor] === '' || lines[cursor].startsWith('  '))) {
        if (lines[cursor].trim()) diagnosticLines++
        cursor++
      }
      if (!diagnosticLines) return undefined
    }
    // The official bash tool appends this marker for a nonzero command exit.
    // Keep it verbatim with the diagnostic appendix; never infer exit success.
    if (/^\[exit code: [1-9]\d*\]$/.test(lines[cursor] ?? '')) cursor++
  }
  if (cursor !== lines.length) return undefined
  const suffix = text.slice(lines.slice(0, summaryEnd).join('\n').length)
  return {
    text: [`[LOSSY Node spec preview: omitted ${successes} successful-test names and durations; retained ${failed.length} failure statuses, diagnostic appendix and summary. Retrieve the original snapshot for omitted evidence.]`,
      ...failed, ...lines.slice(summaryStart, summaryEnd)].join('\n') + suffix,
    omittedSuccessCount: successes,
    retainedFailureCount: failed.length,
  }
}
