import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measureContent } from '../src/diagnostics.js'
import { createPostExecuteHandler } from '../src/pipeline.js'

const content = [{ type: 'text', text: 'sensitive原文' }]
const exec = () => ({ name: 'read', callId: 'call-1', agent: { session: { header: { id: 'session-1' } } }, signal: new AbortController().signal })
const result = () => ({ content: structuredClone(content), value: { secret: 'structured' }, isError: false })
const candidate = () => ({ content: [{ type: 'text', text: 'short' }], strategy: 'fixture', lossy: false })

test('observe reports a candidate without mutating content or decision identity', async () => {
  const records = []
  const decision = { kind: 'accept', additionalContexts: [{ content }] }
  const output = result()
  const before = structuredClone(output)
  const handler = createPostExecuteHandler(copy => {
    copy[0].text = 'mutated copy'
    return candidate()
  }, undefined, { mode: 'observe', report: record => records.push(record), estimator: bytes => bytes })
  assert.equal(await handler(exec(), output, async () => decision), decision)
  assert.deepEqual(output, before)
  assert.equal(records.length, 1)
  const record = records[0]
  assert.equal(record.outcome, 'observed')
  assert.equal(record.sessionId, 'session-1')
  assert.equal(record.strategy, 'fixture')
  assert.equal(record.input.estimatedTokens, Buffer.byteLength(JSON.stringify(content)))
  assert.ok(record.output.bytes < record.input.bytes)
  assert.ok(record.elapsedMs >= 0)
  assert.equal(Object.isFrozen(record), true)
  const serialized = JSON.stringify(record)
  for (const secret of ['sensitive', '原文', 'structured', 'mutated copy', 'short']) assert.equal(serialized.includes(secret), false)
})

test('sync and async diagnostic failures preserve apply results and emit sanitized warnings', async () => {
  for (const report of [() => { throw new Error('sensitive') }, async () => { throw new Error('sensitive') }]) {
    const warnings = []
    const decision = { kind: 'accept', additionalContexts: [{ content }] }
    const original = result()
    const actual = await createPostExecuteHandler(candidate, message => warnings.push(message), { mode: 'apply', report })(exec(), original, async () => decision)
    assert.deepEqual(actual.content, candidate().content)
    assert.equal(actual.additionalContexts, decision.additionalContexts)
    assert.deepEqual(original.value, { secret: 'structured' })
    assert.deepEqual(warnings, ['dsh-free-context: diagnostic observer failed'])
  }
})

test('bypass reasons are traceable without processing protected content', async () => {
  for (const reason of ['blocked', 'value-replacement', 'tool-failure', 'aborted', 'ptc-internal']) {
    const records = []
    const execution = exec()
    const original = result()
    let decision = { kind: 'accept' }
    if (reason === 'blocked') decision = { kind: 'block', feedback: content }
    if (reason === 'value-replacement') decision.value = 'private'
    if (reason === 'tool-failure') original.isError = true
    if (reason === 'aborted') execution.signal = AbortSignal.abort()
    if (reason === 'ptc-internal') execution.parent = 'parent'
    const actual = await createPostExecuteHandler(() => assert.fail('must skip'), undefined, { report: record => records.push(record) })(execution, original, async () => decision)
    assert.equal(actual, decision)
    assert.equal(records[0].reason, reason)
    assert.equal(records[0].input, undefined)
  }
})

test('async cancellation reports aborted and preserves the prior decision', async () => {
  const controller = new AbortController()
  const records = []
  const decision = { kind: 'accept' }
  const handler = createPostExecuteHandler(async () => {
    await Promise.resolve()
    controller.abort()
    return candidate()
  }, undefined, { mode: 'apply', report: record => records.push(record) })
  assert.equal(await handler({ ...exec(), signal: controller.signal }, result(), async () => decision), decision)
  assert.equal(records[0].reason, 'aborted')
})

test('no strategy and ineligible records retain input metrics; estimators reject invalid output', async () => {
  for (const eligible of [true, false]) {
    const records = []
    await createPostExecuteHandler(undefined, undefined, { eligible: () => eligible, report: record => records.push(record) })(exec(), result(), async () => ({ kind: 'accept' }))
    assert.equal(records[0].reason, eligible ? 'no-strategy' : 'ineligible')
    assert.deepEqual(records[0].output, records[0].input)
  }
  assert.throws(() => measureContent(content, () => NaN), /Invalid token estimate/)
})


test('abort during an observer preserves the prior decision and reports selection, never commitment', async () => {
  const controller = new AbortController()
  const decision = { kind: 'accept' }
  const records = []
  const handler = createPostExecuteHandler(candidate, undefined, {
    mode: 'apply',
    report: async record => {
      records.push(record)
      await Promise.resolve()
      controller.abort()
    },
  })
  assert.equal(await handler({ ...exec(), signal: controller.signal }, result(), async () => decision), decision)
  assert.equal(records[0].outcome, 'selected')
  assert.equal(JSON.stringify(records).includes('committed'), false)
  assert.equal(JSON.stringify(records).includes('applied'), false)
})
