import test from 'node:test'
import assert from 'node:assert/strict'
import { createVerifiedSuccessTracker, hasProtectedCommandEvidence, installVerifiedSuccessTracking } from '../src/retirement-success.js'
import { resolveRetirementConfig } from '../src/retirement.js'

function fixture() {
  const events = []
  const session = { header: { id: 'fixture' }, snapshotEvents: () => [...events], eventAt: seq => events[seq] }
  const call = { seq: 0, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call', name: 'bash', arguments: '{"command":"cat source.py"}' } }
  events.push(call)
  const controller = new AbortController()
  const exec = { callId: 'call', name: 'bash', arguments: { command: 'cat source.py' },
    token: Symbol('execution'), signal: controller.signal, agent: { session } }
  const result = { isError: false, value: { exitCode: 0, stdout: 'raise ValueError(message)\n', stderr: '' },
    content: [{ type: 'text', text: 'raise ValueError(message)\n' }] }
  const append = (content = result.content) => {
    const event = { seq: events.length, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [call.seq], data: { turn: 1, step: 1,
      message: { role: 'tool', toolCallId: 'call', isError: false, source: { callId: 'call' }, content } } }
    events.push(event)
    return event
  }
  return { session, events, call, exec, result, append, controller }
}

test('verified success is opt-in and belongs only to the token objective', () => {
  assert.equal(Object.hasOwn(resolveRetirementConfig(), 'allowVerifiedSuccess'), false)
  assert.equal(resolveRetirementConfig({ allowVerifiedSuccess: false }).allowVerifiedSuccess, false)
  assert.equal(resolveRetirementConfig({ objective: 'tokens', allowVerifiedSuccess: true }).allowVerifiedSuccess, true)
  for (const input of [{ allowVerifiedSuccess: true }, { objective: 'cost', allowVerifiedSuccess: true },
    { objective: 'tokens', allowVerifiedSuccess: 'yes' }]) assert.throws(() => resolveRetirementConfig(input))
})

test('successful evidence binds exact Session, call, arguments and final content', () => {
  const f = fixture(), tracker = createVerifiedSuccessTracker()
  const observation = tracker.begin(f.exec, f.result)
  tracker.settle(observation, f.exec, f.result, { kind: 'accept' })
  const event = f.append()
  const credential = tracker.query(f.session, f.call, event)
  assert.equal(credential.callSeq, 0)
  assert.equal(credential.callId, 'call')
  assert.match(credential.argumentsHash, /^[a-f0-9]{64}$/)
  assert.match(credential.contentHash, /^[a-f0-9]{64}$/)
  assert.equal(tracker.query({ ...f.session }, f.call, event), undefined)
  event.sourceEventSeqs = [9]
  assert.equal(tracker.query(f.session, f.call, event), undefined)
  event.sourceEventSeqs = [f.call.seq, 9]
  assert.equal(tracker.query(f.session, f.call, event), undefined)
  event.sourceEventSeqs = [f.call.seq]
  event.data.message.toolCallId = 'other'
  assert.equal(tracker.query(f.session, f.call, event), undefined)
  event.data.message.toolCallId = 'call'
  event.data.message.content = [{ type: 'text', text: 'outer changed output' }]
  assert.equal(tracker.query(f.session, f.call, event), undefined)
})

test('nonzero, stderr, uncertain value replacements and identity transitions cannot authorize', () => {
  for (const mutate of [f => { f.result.value.exitCode = 1 }, f => { f.result.value.stderr = 'warning' },
    f => { f.result.value.extra = true }, f => { f.exec.parent = Symbol('parent') }, f => { f.controller.abort() }]) {
    const f = fixture(), tracker = createVerifiedSuccessTracker()
    mutate(f)
    const observation = tracker.begin(f.exec, f.result)
    tracker.settle(observation, f.exec, f.result, { kind: 'accept' })
    assert.equal(tracker.query(f.session, f.call, f.append()), undefined)
  }
  for (const mutate of [f => { f.exec.agent.session = { ...f.session } }, f => f.controller.abort(),
    f => { f.exec.arguments.command = 'other' }, f => { f.exec.token = Symbol('other') }]) {
    const f = fixture(), tracker = createVerifiedSuccessTracker(), observation = tracker.begin(f.exec, f.result)
    mutate(f)
    tracker.settle(observation, f.exec, f.result, { kind: 'accept' })
    assert.equal(tracker.query(f.session, f.call, f.append()), undefined)
  }
  const f = fixture(), tracker = createVerifiedSuccessTracker(), observation = tracker.begin(f.exec, f.result)
  tracker.settle(observation, f.exec, f.result, { kind: 'accept', value: f.result.value })
  assert.equal(tracker.query(f.session, f.call, f.append()), undefined)
})

test('duplicate executions, duplicate call ids and disposed tracking lose authorization', () => {
  const f = fixture(), tracker = createVerifiedSuccessTracker(), observation = tracker.begin(f.exec, f.result)
  assert.equal(tracker.begin({ ...f.exec, token: Symbol('duplicate') }, f.result), undefined)
  tracker.settle(observation, f.exec, f.result, { kind: 'accept' })
  assert.equal(tracker.query(f.session, f.call, f.append()), undefined)
  const g = fixture(), other = createVerifiedSuccessTracker(), pending = other.begin(g.exec, g.result)
  other.settle(pending, g.exec, g.result, { kind: 'accept' })
  const event = g.append()
  assert.ok(other.query(g.session, g.call, event))
  g.events.push({ ...g.call, seq: 2, data: { ...g.call.data, turn: 2 } })
  assert.equal(other.query(g.session, g.call, event), undefined)
  other.dispose()
  assert.equal(other.begin(g.exec, g.result), undefined)
})

test('diagnostic guards retain masked failures even when the preview omits them', () => {
  for (const diagnostic of ['Exit code: 1', 'STDERR:\nnotice', 'Traceback (most recent call last):',
    'ValueError: invalid', 'UserWarning: invalid', 'FAILED test.py::test', 'FAIL: test', 'ERROR test',
    '2 failed, 9 passed', 'FAILED (errors=1)', 'failures=1', '[timed out]', '[sandbox: failed]',
    '[dsh-lossless-text:v1]\npartial', '[dsh-search-results:v1]\npartial',
    '{"format":"dsh-json-rows","rows":[]}', '::error file=a.py,line=8::type mismatch', '::warning::notice',
    'src/a.py:8: error: incompatible argument', 'src/a.py:8:3: warning: unused import']) {
    assert.equal(hasProtectedCommandEvidence(diagnostic), true, diagnostic)
    const f = fixture(), tracker = createVerifiedSuccessTracker()
    f.result.value.stdout = diagnostic
    tracker.settle(tracker.begin(f.exec, f.result), f.exec, f.result,
      { kind: 'accept', content: [{ type: 'text', text: 'only harmless preview' }] })
    assert.equal(tracker.query(f.session, f.call, f.append([{ type: 'text', text: 'only harmless preview' }])), undefined)
  }
  assert.equal(hasProtectedCommandEvidence('if error:\n    raise ValueError(message)\n# warning or failure handling'), false)
  for (const text of ['{"error":"E_LIMIT","failed":true}', '{"status":"failure","details":"missing required migration"}']) {
    const f = fixture(), tracker = createVerifiedSuccessTracker()
    f.result.value.stdout = text
    f.result.content = [{ type: 'text', text }]
    tracker.settle(tracker.begin(f.exec, f.result), f.exec, f.result, { kind: 'accept' })
    assert.equal(tracker.query(f.session, f.call, f.append()), undefined)
  }
})

test('lazy registration installs once and disposal removes observers and credentials', async () => {
  const listeners = new Map(), effects = []
  let postRegistrations = 0
  const ctx = { on(name, callback) {
    if (name === 'tools/post-execute') postRegistrations++
    listeners.set(name, callback)
    return () => listeners.delete(name)
  }, effect(callback) { effects.push(callback()) } }
  const tracking = installVerifiedSuccessTracking(ctx)
  assert.deepEqual([...listeners.keys()], ['tools/pre-execute'])
  const pre = listeners.get('tools/pre-execute')
  await Promise.all([pre({}, async () => ({ kind: 'allow' })), pre({}, async () => ({ kind: 'allow' }))])
  assert.equal(postRegistrations, 1)
  const f = fixture(), decision = { kind: 'accept' }
  assert.equal(await listeners.get('tools/post-execute')(f.exec, f.result, async () => decision), decision)
  const event = f.append()
  assert.ok(tracking.query(f.session, f.call, event))
  effects.forEach(dispose => dispose())
  assert.equal(listeners.size, 0)
  assert.equal(tracking.query(f.session, f.call, event), undefined)
})

test('bounded credential eviction cannot authorize an old uncommitted execution again', () => {
  const f = fixture(), tracker = createVerifiedSuccessTracker({ maxEntries: 1 })
  const first = tracker.begin(f.exec, f.result)
  const secondCall = { ...f.call, seq: 1, data: { ...f.call.data, callId: 'second' } }
  f.events.push(secondCall)
  const secondExec = { ...f.exec, callId: 'second', token: Symbol('second') }
  tracker.begin(secondExec, f.result)
  assert.equal(tracker.begin(f.exec, f.result), undefined)
  tracker.settle(first, f.exec, f.result, { kind: 'accept' })
  assert.equal(tracker.query(f.session, f.call, f.append()), undefined)
})
