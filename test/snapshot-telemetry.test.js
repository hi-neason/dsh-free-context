import assert from 'node:assert/strict'
import test from 'node:test'
import { installSnapshotTracking } from 'dsh-free-context/snapshot-telemetry'

function setup(options) {
  let handler
  const events = []
  const ctx = { on(event, fn) { handler = fn; return () => {} }, parallel(event, record) { events.push({ event, record }) } }
  const tracking = installSnapshotTracking(ctx, options)
  const session = { header: { id: 'session' } }
  const exec = { name: 'read', callId: 'recover', arguments: { file_path: '/private/exact' }, agent: { session } }
  const receipt = { locator: '/private/exact', retrievalHint: 'SECRET', sessionId: 'session', callId: 'original', sha256: 'a'.repeat(64), bytes: 20 }
  const result = { content: [{ type: 'text', text: 'SECRET' }], value: { path: receipt.locator, offset: 2, totalLines: 3, lines: [{ number: 2, text: 'SECRET' }] } }
  return { tracking, events, exec, receipt, result, handler, ctx }
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
