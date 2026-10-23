import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveRetirementConfig, retireHistory, installRetirement } from 'dsh-free-context/retirement'

test('retirement defaults off and validates immutable detached config without financial defaults', () => {
  const defaults = resolveRetirementConfig()
  assert.equal(defaults.enabled, false)
  assert.equal(defaults.pricing, undefined)
  const input = { tools: ['read'], pricing: { cacheReadPerMillion: 1 } }
  const config = resolveRetirementConfig(input)
  input.tools.push('bash')
  input.pricing.cacheReadPerMillion = 99
  assert.deepEqual(config.tools, ['read'])
  assert.equal(config.pricing.cacheReadPerMillion, 1)
  assert.equal(Object.isFrozen(config.pricing), true)
  for (const invalid of [{ enabled: 'yes' }, { tools: ['read', 'read'] }, { minAgeSteps: -1 },
    { minSavingsTokens: 1.5 }, { maxSnapshotBytes: 0 }, { safetyMargin: 1 },
    { pricing: { typo: 1 } }, { unexpected: true }, null, new Date()]) {
    assert.throws(() => resolveRetirementConfig(invalid))
  }
})

test('missing meter and economic assumptions explicitly decline without storage', async () => {
  const services = { spillStore: { saveText() { assert.fail('must not store') } } }
  assert.deepEqual(await retireHistory({}, {}, services), [])
  assert.equal((await retireHistory({}, { enabled: true }, services))[0].reason, 'missing-token-meter')
  services.tokenMeter = { estimateMessage() {}, measure() {} }
  assert.equal((await retireHistory({}, { enabled: true }, services))[0].reason, 'missing-economic-assumptions')
  services.onDecision = async () => { throw Error('observer') }
  assert.equal((await retireHistory({}, { enabled: true }, services))[0].reason, 'missing-economic-assumptions')
})

test('pre-step installer awaits work then delegates; defaults register nothing and dispose removes listener', async () => {
  let handler
  let disposed = false
  const ctx = { on(name, callback) { assert.equal(name, 'agent/pre-step'); handler = callback; return () => { disposed = true } }, get() {} }
  installRetirement(ctx)
  assert.equal(handler, undefined)
  const off = installRetirement(ctx, { enabled: true })
  const result = { kind: 'continue' }
  let delegated = false
  assert.equal(await handler({ agent: { session: {} } }, async () => { delegated = true; return result }), result)
  assert.equal(delegated, true)
  off()
  assert.equal(disposed, true)
})
