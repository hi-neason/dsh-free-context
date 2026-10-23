import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { prepareDiagnosticEvidence, validateDiagnosticSelection } from 'dsh-free-context/diagnostic-evidence'

const budgets = { maxInputBytes: 10000, maxBlocks: 20 }
const source = ['INFO: starting compilation', 'src/main.ts(12,3): error TS2322: 错误 😀\n  Type string is not assignable.\n  at src/caller.ts:8:2',
  'DEBUG: repeated progress details', 'Status: failed; Errors: 1', 'Exit code: 2'].join('\n\n')

test('prepares source hashes, exact UTF-16 spans, line ranges and required diagnostic/status blocks', () => {
  const result = prepareDiagnosticEvidence(source, budgets)
  assert.equal(result.status, 'prepared')
  assert.equal(result.sourceHash, createHash('sha256').update(source).digest('hex'))
  assert.deepEqual(result.requiredIds, ['d2', 'd4', 'd5'])
  assert.deepEqual([result.spans[1].startLine, result.spans[1].endLine], [3, 5])
  assert.ok(result.spans[1].guards.codes.includes('TS2322'))
  assert.ok(result.spans[1].guards.locations.includes('src/caller.ts:8:2'))
  for (const span of result.spans) assert.equal(span.text, source.slice(span.start, span.end))
  assert.equal(Object.isFrozen(result.spans[1].guards.locations), true)
})

test('selection reconstructs only original blocks in source order, never model-provided quotations', () => {
  const prepared = prepareDiagnosticEvidence(source, budgets)
  const selected = validateDiagnosticSelection(source, prepared, ['d5', 'd2', 'd4'])
  assert.equal(selected.status, 'selected')
  assert.deepEqual(selected.selectedIds, ['d2', 'd4', 'd5'])
  assert.equal(selected.spans[0].text, prepared.spans[1].text)
  assert.ok(selected.text.includes('Type string is not assignable.'))
  assert.equal(selected.text.includes('repeated progress'), false)
  // Authentic source extraction is asserted here, not model task quality.
})

test('refuses omitted status/error/path context, unknown IDs, duplicate IDs and forged source/manifests', () => {
  const prepared = prepareDiagnosticEvidence(source, budgets)
  for (const ids of [[], ['d2'], ['d2', 'd4', 'd5', 'x'], ['d2', 'd2', 'd4', 'd5'], ['rewritten quote']]) {
    assert.equal(validateDiagnosticSelection(source, prepared, ids).status, 'declined')
  }
  assert.equal(validateDiagnosticSelection(source + 'changed', prepared, prepared.requiredIds).reason, 'source-hash-mismatch')
  const forged = structuredClone(prepared)
  forged.requiredIds = ['d2']
  assert.equal(validateDiagnosticSelection(source, forged, ['d2']).reason, 'invalid-evidence-manifest')
  const changed = structuredClone(prepared)
  changed.spans[1].start++
  assert.equal(validateDiagnosticSelection(source, changed, changed.requiredIds).reason, 'invalid-evidence-manifest')
  assert.equal(validateDiagnosticSelection(source, { ...prepared, spans: null }, ['d2']).reason, 'invalid-evidence-manifest')
})

test('informational labels cannot hide error codes, locations or status in continuations', () => {
  for (const line of ['ERROR: failed', 'ERR_CONNECTION_RESET', 'src/main.ts:9:2', 'Exit status: 1',
    'INFO: process exited with code 1', 'DEBUG: result=success']) {
    const prepared = prepareDiagnosticEvidence(`INFO: details\n  ${line}\n\nDEBUG: background`, budgets)
    assert.equal(prepared.status, 'prepared')
    assert.deepEqual(prepared.requiredIds, ['d1'])
  }
})

test('unknown formats decline; standalone informational logs do not become diagnostic evidence', () => {
  for (const text of ['arbitrary prose', 'INFO: progress', 'ERROR: problem\n\nunclassified source',
    'ERROR: ```code```', '\u001b[31mERROR: color', 'ERROR: \ud800']) {
    assert.equal(prepareDiagnosticEvidence(text, budgets).status, 'declined', text)
  }
})

test('byte/block limits and CRLF offsets are exact', () => {
  const text = 'ERROR: 中文\r\n  detail\r\n\r\nStatus: failed'
  const result = prepareDiagnosticEvidence(text, budgets)
  assert.equal(result.status, 'prepared')
  assert.equal(result.spans[1].startLine, 4)
  assert.equal(result.spans[0].text, 'ERROR: 中文\r\n  detail')
  assert.equal(prepareDiagnosticEvidence(text, { ...budgets, maxInputBytes: text.length }).reason, 'input-byte-budget')
  assert.equal(prepareDiagnosticEvidence(text, { ...budgets, maxBlocks: 1 }).reason, 'diagnostic-block-budget')
  assert.throws(() => prepareDiagnosticEvidence(text, { ...budgets, maxBlocks: 0 }))
})
