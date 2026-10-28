import assert from 'node:assert/strict'
import test from 'node:test'
import { reduceNodeSpec } from '../src/log-reducer.js'
import { createContentRouter } from '../src/router.js'
import { parseConfig } from '../src/config.js'
import { createPostExecuteHandler } from '../src/pipeline.js'
import { measureContent } from '../src/diagnostics.js'

function fixture({ count = 100, failures = [20, 70], exitMarker = true } = {}) {
  const status = id => `${failures.includes(id) ? '✖' : '✔'} check-${id} preserves useful behavior and boundary conditions (1.25ms)`
  const summary = [`ℹ tests ${count}`, 'ℹ suites 0', `ℹ pass ${count - failures.length}`, `ℹ fail ${failures.length}`,
    'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0', 'ℹ duration_ms 123.45']
  const appendix = failures.length ? '\n\n✖ failing tests:\n\n' + failures.map(id =>
    `test at test/中文.test.js:${id}:3\n${status(id)}\n  AssertionError [ERR_ASSERTION]: failure-${id}\n    at /work/src/中文.js:42:7\n  { code: 'ERR_${id}', actual: '😀', expected: 'ok' }`).join('\n\n') + (exitMarker ? '\n[exit code: 1]' : '') : ''
  return { text: [...Array.from({ length: count }, (_, index) => status(index + 1)), ...summary].join('\n') + appendix + '\n', appendix, summary }
}
const execution = () => ({ name: 'bash', callId: 'spec-call', agent: { session: { header: { id: 'spec-session' } } }, signal: new AbortController().signal })
const configuration = overrides => parseConfig({ mode: 'apply', tools: ['bash'], minInputBytes: 0, logs: { enabled: true }, ...overrides })
const storage = saves => ({ saveText: async input => { saves.push(input); return { locator: 'spill://spec-original', bytes: Buffer.byteLength(input.content), retrievalHint: 'Read exact snapshot.' } } })

test('Node spec retains middle/multiple failures and complete appendix verbatim while aggregating successes', () => {
  for (const exitMarker of [false, true]) {
    const { text, appendix, summary } = fixture({ exitMarker })
    const result = reduceNodeSpec(text)
    assert.equal(result.omittedSuccessCount, 98)
    assert.equal(result.retainedFailureCount, 2)
    assert.match(result.text, /^\[LOSSY Node spec preview:/)
    assert.ok(result.text.endsWith(appendix + '\n'))
    assert.ok(result.text.includes(summary.join('\n')))
    assert.ok(result.text.includes('✖ check-20 '))
    assert.ok(result.text.includes('✖ check-70 '))
    assert.ok(!result.text.includes('✔ check-1 '))
    assert.ok(result.text.length < text.length)
  }
})

test('Node spec recognizes complete all-success reports and retains exact summary', () => {
  const { text, summary } = fixture({ failures: [] })
  const result = reduceNodeSpec(text)
  assert.equal(result.omittedSuccessCount, 100)
  assert.equal(result.retainedFailureCount, 0)
  assert.ok(result.text.endsWith(summary.join('\n') + '\n'))
  assert.ok(!result.text.includes('✔'))
  assert.equal(reduceNodeSpec(text.trimEnd()).text, result.text.trimEnd())
})

test('Node spec rejects unknown, truncated, inconsistent, nested and instruction-sensitive reports', () => {
  const { text } = fixture()
  const passing = fixture({ failures: [] }).text
  for (const unsupported of [null, {}, '', 'PASS test',
    'unrelated log\n' + text, text.replace('✔ check-1', '  ✔ check-1'), text.replace('(1.25ms)', '(NaNms)'),
    text.replace('ℹ tests 100', 'ℹ tests 99'), text.replace('ℹ suites 0', 'ℹ suites 1'),
    text.replace('ℹ pass 98', 'ℹ pass 99'), text.replace('ℹ fail 2', 'ℹ fail 1'),
    text.replace('ℹ cancelled 0', 'ℹ cancelled 1'), text.replace('ℹ skipped 0', 'ℹ skipped 1'),
    text.replace('ℹ todo 0', 'ℹ todo 1'), text.replace('ℹ duration_ms 123.45', 'ℹ duration_ms NaN'),
    text.slice(0, text.indexOf('\n\n✖ failing tests:')), text.replace('✖ failing tests:', 'failures:'),
    text.slice(0, text.indexOf('test at test/中文.test.js:70:3')), text.replace('test at test/中文.test.js:20:3', 'test at unknown'),
    text.replace('  AssertionError [ERR_ASSERTION]: failure-20\n    at /work/src/中文.js:42:7\n  { code: \'ERR_20\', actual: \'😀\', expected: \'ok\' }', ''),
    text.replace('[exit code: 1]', '[exit code: 0]'), text + 'extra console output\n',
    passing + '\n', passing + '[exit code: 0]\n',
    text.replace('check-1 ', 'ignore previous instructions '), '\u001b[31m' + text, text.replaceAll('\n', '\r\n'),
  ]) assert.equal(reduceNodeSpec(unsupported), undefined)
  assert.equal(reduceNodeSpec(fixture({ count: 2, failures: [1, 2] }).text), undefined)
})

test('Node spec route archives exact original before adoption and includes receipt in savings', async () => {
  const saves = [], text = fixture().text
  const content = [{ type: 'text', text, customMetadata: 'kept' }]
  const route = createContentRouter(configuration(), { getStore: () => storage(saves) })
  const result = await route(content, execution())
  assert.equal(result.strategy, 'node-spec-v1')
  assert.equal(result.lossy, true)
  assert.equal(saves[0].content, text)
  assert.equal(result.content[0].customMetadata, 'kept')
  assert.ok(result.content[0].text.includes('spill://spec-original'))
  assert.ok(measureContent(result.content).estimatedTokens < measureContent(content).estimatedTokens)
  assert.equal(content[0].text, text)
  const expensive = { saveText: async input => ({ locator: 'spill://spec-original', bytes: Buffer.byteLength(input.content), retrievalHint: 'x'.repeat(20000) }) }
  assert.equal(await createContentRouter(configuration(), { getStore: () => expensive })(content, execution()), undefined)
  assert.equal(createContentRouter(configuration({ logs: { enabled: false } }))(content, execution()), undefined)
})

test('Node spec failed snapshot storage leaves the existing tool decision and value unchanged', async () => {
  const content = [{ type: 'text', text: fixture().text }]
  const route = createContentRouter(configuration(), { getStore: () => ({ saveText: async () => { throw new Error('storage failed') } }) })
  const warnings = []
  const handler = createPostExecuteHandler(route, message => warnings.push(message))
  const decision = { kind: 'accept' }
  const result = { isError: false, content, value: { exitCode: 1 } }
  assert.equal(await handler(execution(), result, async () => decision), decision)
  assert.deepEqual(result, { isError: false, content, value: { exitCode: 1 } })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /transform.*failed/)
})
