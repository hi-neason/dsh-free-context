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
