import test from 'node:test'
import assert from 'node:assert/strict'
import { containsPlaceholder } from '../scripts/evaluation-contract.js'

test('response predicate inspects only actual JSON values and whole placeholders', () => {
  for (const value of [null, '', 'UNKNOWN', 'Not available in source', 'Unable to determine.', { nested: ['n/a'] }]) assert.equal(containsPlaceholder(value), true)
  for (const value of [0, false, 'Unknown Unknowns', { unknown: 'Mira', null: 'Osaka' }, ['Ezra', 7]]) assert.equal(containsPlaceholder(value), false)
})
