import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptanceFixturesV3 } from './fixtures/acceptance/tasks-v3.js'
import { acceptanceFixturesV4 } from './fixtures/acceptance/tasks-v4.js'
import { createAcceptancePlanV3 } from '../scripts/acceptance-benchmark-v3.js'
import { validateResponseSchema, responseSchemaIssues, phaseResponseSchema } from '../scripts/evaluation-contract.js'

test('prospective v4 declares every response shape while preserving all thirteen original tasks and facts', () => {
  const old = acceptanceFixturesV3(), fixtures = acceptanceFixturesV4()
  assert.equal(fixtures.length, 13)
  assert.deepEqual(fixtures.map(task => task.id), old.map(task => task.id))
  for (const [i, task] of fixtures.entries()) {
    const previous = old[i]
    assert.equal(task.text, previous.text)
    assert.equal(task.answer.toString(), previous.answer.toString())
    const phases = task.phases ?? [{ query: task.query, expected: task.expected }]
    const before = previous.phases ?? [{ query: previous.query, expected: previous.expected }]
    for (const [index, phase] of phases.entries()) {
      assert.deepEqual(phase.expected, before[index].expected)
      assert.ok(phase.query.startsWith(before[index].query))
      const schema = phaseResponseSchema(task, phase)
      assert.doesNotThrow(() => validateResponseSchema(schema))
      assert.ok(schema)
      assert.deepEqual(responseSchemaIssues(phase.expected, schema), [])
      assert.ok(responseSchemaIssues({ wrapped: phase.expected }, schema).length)
    }
    for (const key of ['coverage', 'requireReadEachPhase', 'requireFixtureEachPhase', 'requireSnapshot', 'historyRetirement', 'expectedRetirement', 'expectedFallback', 'adoptionRequired', 'tier', 'experiment', 'ptc', 'edit', 'editedText', 'rejectPlaceholderValues']) assert.deepEqual(task[key], previous[key])
    assert.equal(task.discoverSourcePath, task.historyRetirement ? true : previous.discoverSourcePath)
  }
})

test('format contracts contain no source values and never turn factual mistakes into quality passes', () => {
  const fixtures = acceptanceFixturesV4()
  const service = fixtures.find(task => task.id === 'experiment-task-independent')
  for (const phase of service.phases) {
    const serialized = JSON.stringify(phase.responseSchema)
    for (const fact of ['Mira', 'Ezra', 'Osaka', 'Bergen', 'amber', 'cobalt']) assert.equal(serialized.includes(fact), false)
    const wrong = { service: 'invented', owner: 'fictional', region: 'elsewhere' }
    assert.deepEqual(responseSchemaIssues(wrong, phase.responseSchema), [])
    assert.notDeepEqual(wrong, phase.expected)
  }
  const precise = fixtures.find(task => task.id === 'json-nested-precision')
  assert.deepEqual(responseSchemaIssues({ decimal: 'changed', integer: 'changed', missing: true, variants: [17, null, []] }, precise.responseSchema), [])
  assert.ok(responseSchemaIssues({ ...precise.expected, variants: 'not-an-array' }, precise.responseSchema).length)
  assert.equal(JSON.stringify(precise.responseSchema).includes(precise.expected.decimal), false)
  assert.equal(JSON.stringify(precise.responseSchema).includes(precise.expected.integer), false)
})

test('v4 fixture construction is isolated and cannot mutate frozen v3 protocols or other calls', () => {
  const prior = JSON.stringify(createAcceptancePlanV3())
  const fixtures = acceptanceFixturesV4()
  fixtures[0].responseSchema.properties.processing_status.type = 'null'
  fixtures[0].expected.processing_status = 'changed-by-caller'
  fixtures[0].coverage.push('not-original-coverage')
  assert.equal(acceptanceFixturesV4()[0].responseSchema.properties.processing_status.type, 'string')
  assert.equal(JSON.stringify(createAcceptancePlanV3()), prior)
})
