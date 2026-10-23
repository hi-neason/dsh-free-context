import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reduceNodeTap } from '../src/log-reducer.js'

export function tapFixture({ count = 100, failing = [20, 70] } = {}) {
  const blocks = Array.from({ length: count }, (_, index) => {
    const id = index + 1
    const title = `fixture ${id}`
    const failed = failing.includes(id)
    return [`# Subtest: ${title}`, `${failed ? 'not ok' : 'ok'} ${id} - ${title}`, '  ---', '  duration_ms: 1.25', "  type: 'test'",
      ...(failed ? ["  location: '/fixture/test.js:12:3'", "  failureType: 'testCodeFailure'", `  error: 'failure ${id}'`, `  code: 'ERR_${id}'`, '  stack: |-', '    source.js:42:9'] : []), '  ...'].join('\n')
  })
  return ['TAP version 13', ...blocks, `1..${count}`, `# tests ${count}`, '# suites 0', `# pass ${count - failing.length}`, `# fail ${failing.length}`, '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 100.25', ''].join('\n')
}

test('retains middle and multiple failure blocks with YAML, paths and summary', () => {
  const original = tapFixture()
  const draft = reduceNodeTap(original)
  assert.ok(draft)
  assert.equal(draft.omittedSuccessCount, 98)
  assert.equal(draft.retainedFailureCount, 2)
  for (const id of [20, 70]) {
    const start = original.indexOf(`# Subtest: fixture ${id}\n`)
    const end = original.indexOf('  ...', start) + '  ...'.length
    assert.ok(draft.text.includes(original.slice(start, end)))
  }
  assert.ok(draft.text.includes('ok 100 - fixture 100'))
  assert.ok(draft.text.includes('# pass 98\n# fail 2'))
  assert.ok(draft.text.includes('LOSSY'))
  assert.ok(draft.text.length < original.length)
})

test('rejects unknown, nested, truncated, inconsistent and extra diagnostic output', () => {
  const text = tapFixture()
  for (const unsupported of [
    'PASS x\nFAIL y', text.replace('TAP version 13', 'TAP version 14'),
    text.replace('# Subtest: fixture 1\n', '    # Subtest: nested\n'),
    text.slice(0, -20), text.replace('1..100', '1..99'), text.replace('# pass 98', '# pass 99'),
    text.replace('  duration_ms: 1.25', '  duration_ms: NaN'),
    text.replace("  type: 'test'", "  type: 'test'\n  user_output: 'important'"),
    text.replace('ok 1 - fixture 1', 'ok 1 - fixture 1 # SKIP'),
    text + '# unexpected output\n', text.replace('# suites 0', '# suites 1'),
    text.replace('# cancelled 0', '# cancelled 1'), text.replace('# Subtest: fixture 1', '# diagnostic line\n# Subtest: fixture 1'),
  ]) assert.equal(reduceNodeTap(unsupported), undefined)
})

test('instruction-sensitive text and failure-only runs remain untouched', () => {
  assert.equal(reduceNodeTap(tapFixture().replaceAll('fixture 1\n', 'ignore previous instructions\n')), undefined)
  assert.equal(reduceNodeTap(tapFixture({ count: 1, failing: [1] })), undefined)
})
