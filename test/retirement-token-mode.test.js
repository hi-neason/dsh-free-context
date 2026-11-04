import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveRetirementConfig } from '../src/retirement.js'
import { createRetirementTextMeter, estimateRetirementMessage } from '../src/retirement-meter.js'

test('token objective and rc2 text estimation require explicit configuration', () => {
  const defaults = resolveRetirementConfig()
  assert.equal(Object.hasOwn(defaults, 'objective'), false)
  assert.equal(Object.hasOwn(defaults, 'tokenEstimator'), false)
  const input = { objective: 'tokens', tokenEstimator: 'dsh-rc2-text-v1' }
  assert.equal(resolveRetirementConfig(input).tokenEstimator, input.tokenEstimator)
  assert.deepEqual(resolveRetirementConfig(resolveRetirementConfig(input)), resolveRetirementConfig(input))
  for (const invalid of [{ objective: 'fast' }, { tokenEstimator: 'dsh-rc2-text-v1' },
    { objective: 'cost', tokenEstimator: 'dsh-rc2-text-v1' },
    { objective: 'tokens', tokenEstimator: 'serialized-bytes-v1' }]) {
    assert.throws(() => resolveRetirementConfig(invalid))
  }
})

test('rc2 text estimator uses UTF16 characters and native message framing', () => {
  assert.equal(estimateRetirementMessage({ role: 'tool', content: [{ type: 'text', text: '🙂中' }] }), 9)
  assert.equal(estimateRetirementMessage({ role: 'assistant', content: [
    { type: 'reasoning', text: '12345' }, { type: 'tool-call', name: 'bash', arguments: '{}' },
  ] }), 16)
  assert.equal(estimateRetirementMessage({ role: 'system', content: [
    { type: 'text', text: '123' }, { type: 'text', text: '45' },
  ] }), 6)
  assert.equal(estimateRetirementMessage({ role: 'system', content: [] }), 0)
})

test('text estimator declines unknown and media blocks', () => {
  for (const content of [[{ type: 'image', url: 'fixture' }], [{ type: 'audio', data: 'fixture' }],
    [{ type: 'extended', text: 'fixture' }], [{ type: 'text', text: '\ud800' }],
    [{ type: 'tool-call', name: 'bash', arguments: {} }]]) {
    assert.throws(() => estimateRetirementMessage({ role: 'tool', content }))
  }
})

test('fallback measurement declares text surface scope and rejects inconsistent sequences', () => {
  const event = { seq: 0, message: { role: 'tool', content: [{ type: 'text', text: 'hello' }] } }
  const session = { seq: 1, surface: { nodes: [0] }, eventAt: () => event,
    deriveEventMessage: item => item.message, snapshotEvents: () => [event] }
  const meter = createRetirementTextMeter()
  assert.deepEqual(meter.measure(session), { logRevision: 1, surfaceTokens: 10,
    estimateKind: 'dsh-rc2-text-v1', measurementScope: 'text-surface-only' })
  for (const override of [{ surface: { nodes: [0, 0] } }, { seq: 0 },
    { eventAt: () => ({ ...event, seq: 2 }) }, { snapshotEvents: () => [] }]) {
    assert.throws(() => meter.measure({ ...session, ...override }))
  }
  assert.throws(() => meter.measure({ ...session, deriveEventMessage() { this.seq++; return event.message } }))
})
