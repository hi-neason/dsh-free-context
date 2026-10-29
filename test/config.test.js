import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, isEligibleInput, parseConfig } from '../src/config.js'
import { apply } from '../src/index.js'

test('defaults are conservative and nested configuration is copied and frozen', () => {
  assert.deepEqual(parseConfig(), {
    mode: 'observe', tools: [], minInputBytes: 1024, maxInputBytes: 1048576,
    minSavingsTokens: 32, json: { enabled: true }, logs: { enabled: false }, text: { enabled: false }, search: { enabled: false }, readText: { enabled: false, encodeArtifacts: false },
    retirement: { enabled: false, tools: [], minInputBytes: 8192, minSavingsTokens: 32,
      retainRecentResults: 4, minAgeSteps: 3, minModelUses: 2, minStepsBetweenRetirements: 1,
      phasePolicy: 'any', excerptCharacters: 256, maxEntriesPerStep: 1, maxSnapshotBytes: 1048576 },
  })
  const input = { tools: ['read'], text: { enabled: true }, json: { enabled: false }, logs: { enabled: true }, readText: { enabled: true, encodeArtifacts: true } }
  const config = parseConfig(input)
  input.tools.push('exec')
  input.json.enabled = true
  input.text.enabled = false
  assert.equal(config.text.enabled, true)
  input.readText.encodeArtifacts = false
  assert.equal(config.readText.encodeArtifacts, true)
  assert.deepEqual(config.tools, ['read'])
  assert.equal(config.json.enabled, false)
  for (const value of [config, config.tools, config.json, config.logs, config.text, config.readText]) assert.equal(Object.isFrozen(value), true)
  assert.throws(() => config.tools.push('exec'), TypeError)
})

for (const input of [null, [], true, new Date(), { unknown: true }, { mode: 'invalid' },
  { mode: undefined }, { tools: null }, { tools: [''] }, { tools: [' read'] }, { tools: ['a b'] },
  { tools: [1] }, { tools: ['read', 'read'] }, { minInputBytes: -1 }, { minInputBytes: 0.1 },
  { maxInputBytes: Infinity }, { maxInputBytes: 0 }, { minInputBytes: 20, maxInputBytes: 10 },
  { minSavingsTokens: '32' }, { minSavingsTokens: NaN }, { minSavingsTokens: Number.MAX_SAFE_INTEGER + 1 },
  { json: true }, { logs: { enabled: 'false' } }, { json: { other: true } }, { logs: { enabled: undefined } },
  { text: null }, { text: [] }, { text: { enabled: 'true' } }, { text: { enabled: undefined } }, { text: { unknown: true } },
  { readText: null }, { readText: [] }, { readText: { encodeArtifacts: 'true' } },
  { readText: { encodeArtifacts: undefined } }, { readText: { unknown: true } },
  { json: { encodeArtifacts: true } }, { logs: { encodeArtifacts: true } },
  { [Symbol('hidden')]: true }]) {
  test(`reject invalid config ${String(JSON.stringify(input))}`, () => {
    assert.throws(() => parseConfig(input), TypeError)
    assert.ok(Config['~standard'].validate(input).issues.length)
  })
}

test('eligibility uses exact tool allowlist and inclusive byte boundaries', () => {
  const config = parseConfig({ tools: ['read'], minInputBytes: 10, maxInputBytes: 20 })
  for (const bytes of [10, 15, 20]) assert.equal(isEligibleInput(config, 'read', bytes), true)
  for (const bytes of [9, 21, NaN, -1, 10.5]) assert.equal(isEligibleInput(config, 'read', bytes), false)
  assert.equal(isEligibleInput(config, 'read_file', 15), false)
  assert.equal(isEligibleInput(parseConfig(), 'read', 1024), false)
  assert.equal(isEligibleInput(parseConfig({ mode: 'off', tools: ['read'] }), 'read', 1024), false)
})

test('off, empty allowlist and disabled strategies register no hook; invalid config fails before registration', () => {
  const ctx = { on: () => assert.fail('unexpected hook') }
  for (const config of [{}, { mode: 'off', tools: ['read'] }, { tools: ['read'], json: { enabled: false }, logs: { enabled: false } }]) apply(ctx, config)
  assert.throws(() => apply(ctx, { mode: 'off', typo: true }), TypeError)
})

test('Standard Schema accepts and normalizes config synchronously', () => {
  assert.equal(Config['~standard'].version, 1)
  assert.deepEqual(Config['~standard'].validate({ tools: ['read'] }).value, parseConfig({ tools: ['read'] }))
})
