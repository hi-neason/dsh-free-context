import test from 'node:test'
import assert from 'node:assert/strict'
import { containsPlaceholder } from '../scripts/evaluation-contract.js'

test('response predicate inspects only actual JSON values and whole placeholders', () => {
  for (const value of [null, '', 'UNKNOWN', 'Not available in source', 'Unable to determine.', { nested: ['n/a'] }]) assert.equal(containsPlaceholder(value), true)
  for (const value of [0, false, 'Unknown Unknowns', { unknown: 'Mira', null: 'Osaka' }, ['Ezra', 7]]) assert.equal(containsPlaceholder(value), false)
})

test('explicit response schemas check shape without any expected answer values', async () => {
  const { validateResponseSchema, responseSchemaIssues } = await import('../scripts/evaluation-contract.js')
  const schema = { type: 'object', properties: { version: { type: 'integer' }, retryLimit: { type: 'integer' } }, required: ['version', 'retryLimit'], additionalProperties: false }
  assert.doesNotThrow(() => validateResponseSchema(schema))
  assert.deepEqual(responseSchemaIssues({ version: 4, retryLimit: 99 }, schema), [])
  const issues = responseSchemaIssues({ contents: { version: 4, retryLimit: 99 } }, schema)
  assert.ok(issues.length)
  assert.equal(JSON.stringify(issues).includes('99'), false)
  assert.deepEqual(responseSchemaIssues(null, { type: 'null' }), [])
  assert.deepEqual(responseSchemaIssues([{ enabled: false }], { type: 'array', items: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] } }), [])
  assert.ok(responseSchemaIssues(Infinity, { type: 'number' }).length)
  assert.ok(responseSchemaIssues(1.5, { type: 'integer' }).length)
  assert.deepEqual(responseSchemaIssues({ anything: 'allowed without a schema' }), [])
})

test('unsupported, cyclic and unbounded response schemas fail before use', async () => {
  const { validateResponseSchema } = await import('../scripts/evaluation-contract.js')
  for (const schema of [null, [], {}, { type: 'string', enum: ['secret-answer'] }, { type: 'object', required: ['x', 'x'] }, { type: 'number', properties: {} }, { type: 'array' }]) assert.throws(() => validateResponseSchema(schema), TypeError)
  assert.throws(() => validateResponseSchema({ type: 'object', required: new Array(1) }), TypeError)
  assert.throws(() => validateResponseSchema({ type: 'object', properties: { [Symbol('key')]: { type: 'string' } } }), TypeError)
  const cyclic = { type: 'array' }; cyclic.items = cyclic
  assert.throws(() => validateResponseSchema(cyclic), TypeError)
  let deep = { type: 'string' }
  for (let i = 0; i < 40; i++) deep = { type: 'array', items: deep }
  assert.throws(() => validateResponseSchema(deep), TypeError)
})

test('bounded type unions describe heterogeneous JSON without embedding answer values', async () => {
  const { validateResponseSchema, responseSchemaIssues } = await import('../scripts/evaluation-contract.js')
  const schema = { type: 'array', items: { type: ['boolean', 'number', 'string', 'object', 'null'] } }
  assert.doesNotThrow(() => validateResponseSchema(schema))
  assert.deepEqual(responseSchemaIssues([false, 0, '0', { nested: [1, null] }, null], schema), [])
  assert.deepEqual(responseSchemaIssues([true, 17.25, 'arbitrary value', { other: 'shape is unconstrained' }], schema), [])
  assert.ok(responseSchemaIssues([[]], schema).length)
  assert.ok(responseSchemaIssues([Infinity], schema).length)
  assert.deepEqual(responseSchemaIssues(null, { type: ['string', 'null'] }), [])
  assert.deepEqual(responseSchemaIssues('arbitrary', { type: ['string', 'null'] }), [])
  assert.ok(responseSchemaIssues(5, { type: ['string', 'null'] }).length)
  for (const invalid of [[], ['unknown'], ['string', 'string'], ['string', null], new Array(1), ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']]) {
    assert.throws(() => validateResponseSchema({ type: invalid }), TypeError)
  }
  for (const keyword of ['properties', 'items', 'required', 'enum', 'const']) assert.throws(() => validateResponseSchema({ type: ['object', 'array'], [keyword]: {} }), TypeError)
})
