import test from 'node:test'
import assert from 'node:assert/strict'
import { createReadTracker, installReadTracking, hashReadContent } from 'dsh-free-context/read-lifecycle'

const target = { targetKey: 'opaque:target', displayPath: 'shown.txt' }
const execution = (session, callId) => ({ agent: { session }, name: 'read', callId, arguments: { limit: 9999 } })
const result = (offset, texts) => ({ isError: false, content: [{ type: 'text', text: 'unchanged' }],
  value: { path: 'shown.txt', offset, lines: texts.map((text, index) => ({ number: offset + index, text })), totalLines: 100 } })
function read(tracker, session, callId, offset, texts, version = 'v1') {
  const exec = execution(session, callId)
  tracker.observe(target, { kind: 'present', version }, exec)
  tracker.settle(exec, result(offset, texts))
}

test('only actual same-version line coverage supersedes; query is frozen and scoped', () => {
  const tracker = createReadTracker()
  const session = {}
  read(tracker, session, 'a', 2, ['two'])
  read(tracker, session, 'b', 1, ['one'])
  assert.equal(tracker.query(session, 'a').status, 'active')
  read(tracker, {}, 'foreign', 1, ['one', 'two'])
  assert.equal(tracker.query(session, 'a').status, 'active')
  read(tracker, session, 'c', 1, ['one', 'two'])
  assert.deepEqual(tracker.query(session, 'a'), { callId: 'a', targetKey: target.targetKey, version: 'v1',
    start: 2, end: 2, status: 'superseded', supersededBy: 'c', contentHash: hashReadContent(result(2, ['two']).content) })
  assert.equal(tracker.query(session, 'c').end, 2)
  assert.equal(Object.isFrozen(tracker.query(session, 'a')), true)
})

test('different versions and absence mark stale without removing records', () => {
  const tracker = createReadTracker()
  const session = {}
  read(tracker, session, 'a', 1, ['one'])
  read(tracker, session, 'b', 1, ['changed'], 'v2')
  assert.equal(tracker.query(session, 'a').status, 'stale')
  tracker.observe(target, { kind: 'absent' }, { agent: { session }, name: 'edit', callId: 'edit' })
  assert.equal(tracker.query(session, 'b').status, 'stale')
})

test('coverage without hashable model-visible content cannot supersede an older read', () => {
  const tracker = createReadTracker()
  const session = {}
  read(tracker, session, 'old', 1, ['one'])
  const exec = execution(session, 'new')
  tracker.observe(target, { kind: 'present', version: 'v1' }, exec)
  const output = result(1, ['one', 'two'])
  delete output.content
  tracker.settle(exec, output)
  assert.equal(tracker.query(session, 'old').status, 'active')
  assert.equal(tracker.query(session, 'new'), undefined)
})

test('version changes during pending read, unknown observations and repeated ids cannot supersede', () => {
  const tracker = createReadTracker()
  const session = {}
  const exec = execution(session, 'pending')
  tracker.observe(target, { kind: 'present', version: 'v1' }, exec)
  tracker.observe(target, { kind: 'present', version: 'v2' }, execution(session, 'other'))
  tracker.settle(exec, result(1, ['one']))
  assert.equal(tracker.query(session, 'pending').status, 'unknown')
  read(tracker, session, 'unknown', 1, ['one'], '')
  assert.equal(tracker.query(session, 'unknown').status, 'unknown')
  tracker.settle(execution(session, 'unobserved'), result(1, ['one']))
  assert.equal(tracker.query(session, 'unobserved').status, 'unknown')
  read(tracker, session, 'duplicate', 1, ['one'])
  read(tracker, session, 'duplicate', 1, ['one'])
  assert.equal(tracker.query(session, 'duplicate').status, 'unknown')
})

test('zero lines, partial ranges, changed line truncation and other targets do not supersede', () => {
  const tracker = createReadTracker()
  const session = {}
  read(tracker, session, 'a', 1, ['one', 'two'])
  read(tracker, session, 'empty', 1, [])
  read(tracker, session, 'partial', 1, ['one'])
  read(tracker, session, 'different-content', 1, ['o...', 'two'])
  const exec = execution(session, 'other-target')
  tracker.observe({ targetKey: 'another' }, { kind: 'present', version: 'v1' }, exec)
  tracker.settle(exec, result(1, ['one', 'two']))
  assert.equal(tracker.query(session, 'a').status, 'active')
})

test('failed, cancelled, replaced and malformed values are ignored; bounded metadata clears on dispose', () => {
  const tracker = createReadTracker({ maxEntriesPerSession: 2 })
  const session = {}
  for (const [id, change, decision] of [
    ['error', { isError: true }], ['malformed', { value: { path: 'x', lines: [] } }],
    ['blocked', {}, { kind: 'block' }], ['replaced', {}, { kind: 'accept', content: [] }],
  ]) {
    const exec = execution(session, id)
    tracker.observe(target, { kind: 'present', version: 'v1' }, exec)
    tracker.settle(exec, { ...result(1, ['one']), ...change }, decision)
    assert.equal(tracker.query(session, id), undefined)
  }
  const cancelled = { ...execution(session, 'cancelled'), signal: AbortSignal.abort() }
  tracker.observe(target, { kind: 'present', version: 'v1' }, cancelled)
  tracker.settle(cancelled, result(1, ['one']))
  assert.equal(tracker.query(session, 'cancelled'), undefined)
  read(tracker, session, 'a', 1, ['one'])
  read(tracker, session, 'b', 1, ['one'])
  read(tracker, session, 'c', 1, ['one'])
  assert.equal(tracker.query(session, 'a'), undefined)
  assert.ok(tracker.query(session, 'c'))
  tracker.dispose()
  assert.equal(tracker.query(session, 'c'), undefined)
  assert.throws(() => createReadTracker({ maxEntriesPerSession: 0 }))
})

test('pending observation eviction declines to unknown instead of borrowing another call version', () => {
  const tracker = createReadTracker({ maxEntriesPerSession: 1 })
  const session = {}
  const older = execution(session, 'older')
  tracker.observe(target, { kind: 'present', version: 'v1' }, older)
  tracker.observe(target, { kind: 'present', version: 'v1' }, execution(session, 'newer'))
  tracker.settle(older, result(1, ['one']))
  assert.equal(tracker.query(session, 'older').status, 'unknown')
})

test('installed listeners preserve result identity and swallow malformed observation failures', async () => {
  const handlers = new Map()
  const ctx = { on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) }, effect() {} }
  const installed = installReadTracking(ctx)
  assert.doesNotThrow(() => handlers.get('fs/observed')({}, {}, { get agent() { throw Error('bad') } }))
  const session = {}
  const exec = execution(session, 'a')
  const output = result(1, ['one'])
  const before = structuredClone(output)
  handlers.get('fs/observed')(target, { kind: 'present', version: 'v1' }, exec)
  const decision = { kind: 'accept' }
  assert.equal(await handlers.get('tools/post-execute')(exec, output, async () => decision), decision)
  assert.deepEqual(output, before)
  assert.equal(installed.query(session, 'a').status, 'active')
  installed.dispose()
  assert.equal(handlers.size, 0)
  assert.equal(installed.query(session, 'a'), undefined)
})
