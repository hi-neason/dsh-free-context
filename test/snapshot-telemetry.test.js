import assert from 'node:assert/strict'
import test from 'node:test'
import { installSnapshotTracking } from 'dsh-free-context/snapshot-telemetry'

function setup(options) {
  const handlers = new Map()
  const events = []
  const ctx = { on(event, fn) { handlers.set(event, fn); return () => handlers.delete(event) }, parallel(event, record) { events.push({ event, record }) } }
  const tracking = installSnapshotTracking(ctx, options)
  const session = { header: { id: 'session' } }
  const exec = { name: 'read', callId: 'recover', arguments: { file_path: '/private/exact' }, agent: { session } }
  const receipt = { locator: '/private/exact', retrievalHint: 'SECRET', sessionId: 'session', callId: 'original', sha256: 'a'.repeat(64), bytes: 20 }
  const result = { content: [{ type: 'text', text: 'SECRET' }], value: { path: receipt.locator, offset: 2, totalLines: 3, lines: [{ number: 2, text: 'SECRET' }] } }
  const handler = async (exec, result, next) => {
    const decision = await handlers.get('tools/post-execute')(exec, result, next)
    const final = decision.kind === 'block' ? { content: [], isError: true } : { ...result, ...Object.hasOwn(decision, 'content') ? { content: decision.content } : {}, ...Object.hasOwn(decision, 'value') ? { value: decision.value } : {} }
    handlers.get('tools/result')(exec, final)
    return decision
  }
  return { tracking, events, exec, receipt, result, handler, handlers, ctx }
}
test('snapshot association and recovery range are sanitized and never claim full verification', async () => {
  const { tracking, events, exec, receipt, result, handler } = setup()
  const reference = tracking.record(exec, receipt)
  assert.equal(reference.referenceId.length, 64)
  const decision = { kind: 'accept' }
  assert.equal(await handler(exec, result, async () => decision), decision)
  assert.equal(events[1].record.outcome, 'success')
  assert.equal(events[1].record.startLine, 2)
  assert.equal(events[1].record.endLine, 2)
  assert.equal(events[1].record.verifiedFull, false)
  assert.equal(events[1].record.referenceId, reference.referenceId)
  for (const secret of ['/private', 'SECRET', 'locator', 'retrievalHint', 'arguments']) assert.equal(JSON.stringify(events).includes(secret), false)
})
test('status boundaries, exact locator and session-object ownership fail closed', async () => {
  const { tracking, events, exec, receipt, result, handler } = setup()
  tracking.record(exec, receipt)
  for (const [decision, changes, expected] of [[{kind:'block'}, {}, 'blocked'], [{kind:'accept', content:[]}, {}, 'modified'], [{kind:'accept'}, {isError:true}, 'failed'], [{kind:'accept',content:[]}, {isError:true}, 'failed']]) {
    await handler(exec, {...result,...changes}, async()=>decision)
    assert.equal(events.at(-1).record.outcome,expected)
    assert.equal(events.at(-1).record.startLine,undefined)
  }
  await handler({...exec,signal:AbortSignal.abort()},result,async()=>({kind:'accept'}))
  assert.equal(events.at(-1).record.outcome,'cancelled')
  const count = events.length
  await handler({...exec,agent:{session:{header:{id:'session'}}}},result,async()=>({kind:'accept'}))
  await handler({...exec,arguments:{file_path:'/private/./exact'}},result,async()=>({kind:'accept'}))
  assert.equal(events.length,count)
})
test('bounded eviction, explicit re-registration, disposal and throwing observers do not affect results', async () => {
  const { tracking, events, exec, receipt, result, handler, ctx } = setup({maxEntriesPerSession:1})
  tracking.record(exec,receipt)
  tracking.record(exec,{...receipt,locator:'/other'})
  const count=events.length
  await handler(exec,result,async()=>({kind:'accept'}))
  assert.equal(events.length,count)
  ctx.parallel=()=>{throw Error('SECRET')}
  assert.ok(tracking.record(exec,receipt))
  assert.equal((await handler(exec,result,async()=>({kind:'accept'}))).kind,'accept')
  tracking.dispose()
  assert.equal(tracking.record(exec,receipt),undefined)
})

test('lookup returns frozen original receipt only for registered owner and honors eviction/disposal', () => {
  const { tracking, exec, receipt } = setup({ maxEntriesPerSession: 1 })
  const reference = tracking.record(exec, receipt)
  const saved = tracking.lookup(exec, reference.referenceId)
  assert.deepEqual(saved, receipt)
  assert.equal(Object.isFrozen(saved), true)
  receipt.locator = '/mutated'
  assert.equal(saved.locator, '/private/exact')
  assert.equal(tracking.lookup({ ...exec, agent: { session: { header: { id: 'session' } } } }, reference.referenceId), undefined)
  exec.agent.session.header.id = 'other'
  assert.equal(tracking.lookup(exec, reference.referenceId), undefined)
  exec.agent.session.header.id = 'session'
  tracking.record(exec, receipt)
  assert.equal(tracking.lookup(exec, reference.referenceId), undefined)
  tracking.dispose()
  assert.equal(tracking.lookup(exec, reference.referenceId), undefined)
})

test('final observation requires a live baseline and checks final content and value', async () => {
  for (const change of ['content', 'value', 'same-replacement', 'final-error', 'cancelled', 'evicted', 're-registered', 'owner', 'session-id', 'disposed', 'missing']) {
    const { tracking, events, exec, receipt, result, handlers } = setup({ maxEntriesPerSession: 1 })
    tracking.record(exec, receipt)
    const finalObserver = handlers.get('tools/result')
    if (change !== 'missing') {
      await handlers.get('tools/post-execute')(exec, result, async () => change === 'same-replacement' ? { kind: 'accept', content: result.content } : { kind: 'accept' })
      assert.equal(events.length, 1, 'post-execute must not emit recovery')
    }
    const final = structuredClone(result)
    if (change === 'content') final.content = []
    if (change === 'value') final.value = { ...result.value, lines: [] }
    if (change === 'final-error') final.isError = true
    if (change === 'cancelled') exec.signal = AbortSignal.abort()
    if (change === 'evicted') tracking.record(exec, { ...receipt, locator: '/other' })
    if (change === 're-registered') tracking.record(exec, receipt)
    if (change === 'owner') exec.agent = { session: { header: { id: 'session' } } }
    if (change === 'session-id') exec.agent.session.header.id = 'changed'
    if (change === 'disposed') tracking.dispose()
    const count = events.length
    assert.equal(finalObserver(exec, final), undefined)
    if (['content', 'value', 'same-replacement'].includes(change)) {
      assert.equal(events.at(-1).record.outcome, 'modified')
      assert.equal(events.at(-1).record.startLine, undefined)
      assert.equal(events.at(-1).record.verifiedFull, false)
    } else if (change === 'final-error' || change === 'cancelled') {
      assert.equal(events.at(-1).record.outcome, change === 'final-error' ? 'failed' : 'cancelled')
      assert.equal(events.at(-1).record.startLine, undefined)
    } else assert.equal(events.length, count)
    const after = events.length
    finalObserver(exec, final)
    assert.equal(events.length, after, 'final event consumes the baseline')
  }
})
