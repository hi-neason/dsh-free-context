import { createHash } from 'node:crypto'

const STRATEGY = 'diagnostic-evidence-selection-v1'
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex')
const severity = /\b(?:error|warning|warn|fatal|exception|failed|failure)\b/i
const statusLine = /^(?:exit(?:\s+(?:code|status))?\s*[:=]\s*-?\d+|(?:PASS|FAIL|FAILED|PASSED|SUCCESS|FAILURE)\b|(?:Tests?|Test Suites?|Suites?|Errors?|Warnings?|Failures?|Summary|Status|Result)\s*[:=])/i
const diagnosticStart = /^(?:(?:ERROR|WARN(?:ING)?|FATAL|EXCEPTION)\b|.+(?:\(\d+(?:,\d+)?\)|:\d+(?::\d+)?):?\s*(?:error|warning|fatal|note)\b)/i
const informationalStart = /^(?:(?:INFO|DEBUG|TRACE)(?::|\s)|\[(?:info|debug|trace)\])/i
const embeddedStatus = /\b(?:exit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))?\s*[:=]?\s*-?\d+|(?:status|result|errors?|warnings?|failures?)\s*[:=])/i

// Deliberately narrow, line-anchored location grammar: both line and column
// are required. Occurrences count individually, including within INFO blocks.
const compilerHeader = /^[ \t]*(?:[A-Za-z]:[\\/])?[^:\r\n()]+(?:\(\d+,\d+\)|:\d+:\d+):[ \t]+(?:error|warning|note|fatal error)(?:[ \t]+[A-Z][A-Z0-9_-]*)?:[^\r\n]*/gm

function selectionCoverage(text, verified, selected) {
  const headers = [...text.matchAll(compilerHeader)]
  if (!headers.length) return undefined
  const statusBlocks = verified.spans.filter(span => span.text.split(/\r?\n/).some(line => statusLine.test(line.trim())))
  const contains = (start, end) => selected.some(span => span.start <= start && span.end >= end)
  const scanned = Object.freeze({ compilerHeaders: headers.length, statusBlocks: statusBlocks.length })
  const retained = Object.freeze({ compilerHeaders: headers.filter(match => contains(match.index, match.index + match[0].length)).length,
    statusBlocks: statusBlocks.filter(span => contains(span.start, span.end)).length })
  if (scanned.compilerHeaders !== retained.compilerHeaders || scanned.statusBlocks !== retained.statusBlocks) return declined('diagnostic-coverage-mismatch')
  return Object.freeze({ grammarVersion: 'compiler-location-headers-v1', stage: 'validated-selection-before-downstream-retention', sourceHash: verified.sourceHash, scanned, retained })
}

function guardsFor(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim())
  return {
    status: lines.filter(line => statusLine.test(line) || embeddedStatus.test(line)),
    severity: lines.filter(line => severity.test(line)),
    codes: [...new Set(text.match(/\b(?:TS\d+|ERR_[A-Z0-9_]+|E[A-Z][A-Z0-9_]*|[A-Z]{2,10}\d{2,})\b/g) ?? [])],
    locations: [...new Set(text.match(/(?:[A-Za-z]:[\\/]|\.?\.?\/|[A-Za-z0-9_.-]+[\\/])[^\s<>"'`]+|\b[A-Za-z0-9_.-]+\.[A-Za-z]{1,10}(?::\d+(?::\d+)?|\(\d+(?:,\d+)?\))/g) ?? [])],
  }
}

const declined = reason => ({ status: 'declined', reason })

/**
 * Narrow deterministic admission for blank-line-separated compiler diagnostic,
 * status, and INFO/DEBUG/TRACE blocks. Unknown block starts decline the whole
 * input. A multiline block is indivisible, preserving its continuation context.
 * Guards are conservative lexical matches, not a complete diagnostic grammar.
 * Authentic quotations do not prove evidence completeness or task equivalence.
 * Offsets are UTF-16 indexes into the exact source, end-exclusive; lines are 1-based.
 */
export function prepareDiagnosticEvidence(text, { maxInputBytes, maxBlocks } = {}) {
  if (![maxInputBytes, maxBlocks].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('Positive safe integer maxInputBytes and maxBlocks are required')
  }
  if (typeof text !== 'string' || !text.trim() || !text.isWellFormed()) return declined('unsupported-diagnostics')
  if (Buffer.byteLength(text) > maxInputBytes) return declined('input-byte-budget')
  if (/```|~~~|\u001b/.test(text)) return declined('unsupported-diagnostic-format')
  const boundaries = []
  let start = 0
  for (const match of text.matchAll(/\r?\n[ \t]*(?:\r?\n)+/g)) {
    if (text.slice(start, match.index).trim()) boundaries.push({ start, end: match.index })
    start = match.index + match[0].length
  }
  if (text.slice(start).trim()) boundaries.push({ start, end: text.length })
  if (boundaries.length > maxBlocks) return declined('diagnostic-block-budget')
  const spans = []
  for (const [index, boundary] of boundaries.entries()) {
    const block = text.slice(boundary.start, boundary.end)
    const firstLine = block.split(/\r?\n/, 1)[0].trim()
    if (!diagnosticStart.test(firstLine) && !statusLine.test(firstLine) && !informationalStart.test(firstLine)) {
      return declined('unrecognized-diagnostic-block')
    }
    const guards = guardsFor(block)
    // Diagnostic blocks (including notes) stay mandatory even if a lexical
    // guard misses their details. Only explicit informational blocks can drop.
    const required = !informationalStart.test(firstLine) || Object.values(guards).some(values => values.length > 0) || [...block.matchAll(compilerHeader)].length > 0
    for (const values of Object.values(guards)) Object.freeze(values)
    const startLine = text.slice(0, boundary.start).split('\n').length
    spans.push(Object.freeze({ id: `d${index + 1}`, ...boundary, text: block, startLine,
      endLine: startLine + block.split('\n').length - 1, required, guards: Object.freeze(guards) }))
  }
  const requiredIds = spans.filter(span => span.required).map(span => span.id)
  if (!requiredIds.length) return declined('no-diagnostic-evidence')
  return Object.freeze({ status: 'prepared', strategy: STRATEGY, sourceHash: hash(text),
    spans: Object.freeze(spans), requiredIds: Object.freeze(requiredIds) })
}

/** Validate IDs and provenance; reconstruct quotations exclusively from source. */
export function validateDiagnosticSelection(text, prepared, selectedIds) {
  if (typeof text !== 'string' || prepared?.status !== 'prepared' || prepared.strategy !== STRATEGY ||
    hash(text) !== prepared.sourceHash) return declined('source-hash-mismatch')
  if (!Array.isArray(prepared.spans) || !prepared.spans.length || !Array.isArray(prepared.requiredIds) ||
    prepared.spans.some(span => !span || typeof span !== 'object' || typeof span.id !== 'string')) {
    return declined('invalid-evidence-manifest')
  }
  if (!Array.isArray(selectedIds) || !selectedIds.length || new Set(selectedIds).size !== selectedIds.length ||
    selectedIds.some(id => typeof id !== 'string' || !prepared.spans.some(span => span.id === id))) {
    return declined('invalid-selection')
  }
  if (prepared.requiredIds.some(id => !selectedIds.includes(id))) return declined('protected-diagnostic-omitted')
  // Re-derive admission and guards to avoid trusting a caller-supplied forged
  // requiredIds/spans object or changed offsets, even if its hash was copied.
  const verified = prepareDiagnosticEvidence(text, { maxInputBytes: Math.max(1, Buffer.byteLength(text)), maxBlocks: Math.max(1, prepared.spans.length) })
  if (verified.status !== 'prepared' || JSON.stringify(verified) !== JSON.stringify(prepared)) return declined('invalid-evidence-manifest')
  const spans = Object.freeze(verified.spans.filter(span => selectedIds.includes(span.id)))
  const coverage = selectionCoverage(text, verified, spans)
  if (coverage?.status === 'declined') return coverage
  return Object.freeze({ status: 'selected', strategy: STRATEGY, sourceHash: verified.sourceHash,
    ...(coverage ? { coverage } : {}),
    selectedIds: Object.freeze(spans.map(span => span.id)), spans,
    text: spans.map(span => `[Source diagnostic ${span.id}; lines ${span.startLine}-${span.endLine}; UTF-16 ${span.start}:${span.end}]\n${text.slice(span.start, span.end)}`).join('\n\n') })
}
