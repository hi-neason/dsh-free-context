import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPostExecuteHandler } from '../src/pipeline.js'
import * as plugin from '../src/index.js'

const blocks = text => [{ type: 'text', text }]
const execution = () => ({ name: 'fixture', callId: 'call-1', signal: new AbortController().signal })
const result = () => ({ isError: false, content: blocks('original'), value: { rows: [1, 2] } })

test('waits for downstream and transforms its content while preserving decision fields and structured result', async () => {
  const original = result()
  const before = structuredClone(original)
  const contexts = [{ role: 'user', content: blocks('extra') }]
  const decision = { kind: 'accept', content: blocks('downstream'), additionalContexts: contexts }
  let downstreamDone = false
  const handler = createPostExecuteHandler(async content => {
    assert.equal(downstreamDone, true)
    assert.deepEqual(content, blocks('downstream'))
    return { content: blocks('compressed'), strategy: 'fixture' }
  }, undefined, { mode: 'apply' })
  const actual = await handler(execution(), original, async () => {
    await Promise.resolve()
    downstreamDone = true
    return decision
  })
  assert.deepEqual(actual.content, blocks('compressed'))
  assert.equal(actual.additionalContexts, contexts)
  assert.deepEqual(original, before)
  assert.deepEqual(decision.content, blocks('downstream'))
})

for (const scenario of ['block', 'value', 'failure', 'abort', 'internal']) {
  test(`bypasses ${scenario}`, async () => {
    const exec = execution()
    const output = result()
    let decision = { kind: 'accept' }
    if (scenario === 'block') decision = { kind: 'block', feedback: blocks('blocked') }
    if (scenario === 'value') decision = { kind: 'accept', value: null }
    if (scenario === 'failure') output.isError = true
    if (scenario === 'abort') exec.signal = AbortSignal.abort()
    if (scenario === 'internal') exec.parent = 'parent-call'
    const handler = createPostExecuteHandler(() => assert.fail('must not transform'))
    assert.equal(await handler(exec, output, async () => decision), decision)
  })
}

test('aborting an asynchronous transformation preserves downstream decision', async () => {
  const controller = new AbortController()
  const decision = { kind: 'accept' }
  const handler = createPostExecuteHandler(async () => {
    controller.abort()
    return { content: blocks('ignored'), strategy: 'fixture' }
  })
  assert.equal(await handler({ ...execution(), signal: controller.signal }, result(), async () => decision), decision)
})

test('mutation followed by failure cannot corrupt prior content; logging failure is isolated', async () => {
  const output = result()
  const decision = { kind: 'accept', content: blocks('downstream') }
  let warnings = 0
  const handler = createPostExecuteHandler(content => {
    content[0].text = 'mutated'
    throw new Error('private tool output')
  }, message => {
    warnings++
    assert.equal(message.includes('private'), false)
    throw new Error('logger unavailable')
  })
  assert.equal(await handler(execution(), output, async () => decision), decision)
  assert.deepEqual(decision.content, blocks('downstream'))
  assert.deepEqual(output.content, blocks('original'))
  assert.equal(warnings, 1)
})

test('no-op and malformed transformer output preserve decision identity', async () => {
  for (const replacement of [undefined, null, 'invalid']) {
    const decision = { kind: 'accept' }
    assert.equal(await createPostExecuteHandler(() => replacement)(execution(), result(), async () => decision), decision)
  }
})

test('downstream errors propagate without being mislabeled as transformation errors', async () => {
  const failure = new Error('downstream')
  await assert.rejects(createPostExecuteHandler(() => undefined)(execution(), result(), async () => { throw failure }), error => error === failure)
})

test('named function plugin registers only the prepended post-execute policy', async () => {
  assert.equal('default' in plugin, false)
  assert.deepEqual(plugin.inject, ['tools'])
  const listeners = []
  plugin.apply({ on: (...args) => listeners.push(args), logger: { warn: assert.fail }, parallel: async () => {} }, { tools: ['fixture'] })
  assert.equal(listeners.length, 1)
  const [event, handler, options] = listeners[0]
  assert.equal(event, 'tools/post-execute')
  assert.deepEqual(options, { prepend: true })
  const decision = { kind: 'accept' }
  assert.equal(await handler(execution(), result(), async () => decision), decision)
})

test('final synchronous candidate guard runs after diagnostics and rejects stale or throwing guards', async () => {
  for (const guardKind of ['stale', 'throws', 'async']) {
    let current = true
    const decision = { kind: 'accept' }
    const handler = createPostExecuteHandler(() => ({ content: blocks('candidate'), strategy: 'fixture', validate: () => {
      if (guardKind === 'throws') throw new Error('private guard details')
      if (guardKind === 'async') return Promise.reject(new Error('private async guard'))
      return current
    } }), undefined, { mode: 'apply', report: async () => { await Promise.resolve(); current = false } })
    assert.equal(await handler(execution(), result(), async () => decision), decision)
  }
})

test('candidate snapshot diagnostics copy only validated frozen public references', async () => {
  const reference = { referenceId: 'a'.repeat(64), sha256: 'b'.repeat(64), bytes: 5, sourceCallId: 'source', sessionId: 'session', purpose: 'original', locator: '/SECRET', arbitrary: 'SECRET' }
  const reports = []
  const handler = createPostExecuteHandler(() => ({content:blocks('short'),strategy:'fixture',snapshots:[reference,{...reference,sessionId:{private:'SECRET'}}]}), undefined,
    {mode:'apply',report:record=>reports.push(record)})
  await handler(execution(),result(),async()=>({kind:'accept'}))
  assert.equal(reports[0].snapshots.length,1)
  assert.equal(Object.isFrozen(reports[0].snapshots[0]),true)
  assert.equal(JSON.stringify(reports).includes('SECRET'),false)
  reference.sourceCallId='changed'
  assert.equal(reports[0].snapshots[0].sourceCallId,'source')
})
