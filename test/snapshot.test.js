import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { archiveOriginal, formatSnapshotReference } from 'dsh-free-context/snapshot'

function execution() {
  return { agent: { session: { header: { id: 'session-a' } } }, name: 'read', callId: 'call-a' }
}

function backend(onSave = () => {}) {
  return { async saveText(input) {
    await onSave(input)
    return { locator: 'opaque:backend/key?not=a/path', bytes: Buffer.byteLength(input.content),
      retrievalHint: 'Use backend reader with this exact opaque locator.' }
  } }
}

test('saves full Unicode text with exact owner/source/hash and immutable opaque receipt', async () => {
  const text = '原文😀\r\n  preserved\t\n'
  let saved
  const receipt = await archiveOriginal(backend(input => { saved = structuredClone(input) }), execution(), text)
  assert.deepEqual(saved, { owner: { sessionId: 'session-a' },
    source: { kind: 'tool', toolName: 'read', callId: 'call-a', label: 'result' },
    suggestedName: 'free-context-original.txt', content: text })
  assert.equal(receipt.sha256, createHash('sha256').update(text).digest('hex'))
  assert.equal(receipt.bytes, Buffer.byteLength(text))
  assert.equal(receipt.locator, 'opaque:backend/key?not=a/path')
  assert.equal(Object.isFrozen(receipt), true)
  assert.throws(() => { receipt.callId = 'different' }, TypeError)
  const guidance = formatSnapshotReference(receipt)
  assert.ok(guidance.includes(JSON.stringify(receipt)))
  assert.match(guidance, /read\/grep/)
  assert.match(guidance, /SHA-256/)
  assert.match(guidance, /partial read/)
})

test('captures source text before later source mutation', async () => {
  const source = { text: 'original' }
  let captured
  const receipt = await archiveOriginal(backend(input => {
    captured = input.content
    source.text = 'changed later'
  }), execution(), source.text)
  assert.equal(captured, 'original')
  assert.equal(receipt.sha256, createHash('sha256').update('original').digest('hex'))
})

test('rejects missing ownership, tool and call identifiers without saving', async () => {
  let saves = 0
  const store = backend(() => { saves++ })
  for (const exec of [{}, { ...execution(), agent: undefined },
    { ...execution(), callId: '' }, { ...execution(), name: ' ' }]) {
    await assert.rejects(archiveOriginal(store, exec, 'original'))
  }
  assert.equal(saves, 0)
})

test('storage failures and invalid backend receipts never yield a receipt', async () => {
  const failure = new Error('storage failed')
  await assert.rejects(archiveOriginal({ saveText: async () => { throw failure } }, execution(), 'x'),
    error => error === failure)
  for (const result of [undefined, { locator: '', bytes: 1, retrievalHint: 'read' },
    { locator: 'opaque:x', bytes: 2, retrievalHint: 'read' },
    { locator: 'opaque:x', bytes: 1, retrievalHint: '' }]) {
    await assert.rejects(archiveOriginal({ saveText: async () => result }, execution(), 'x'))
  }
})

test('abort before save prevents storage; abort during save prevents receipt adoption', async () => {
  const before = new AbortController()
  before.abort()
  let saves = 0
  await assert.rejects(archiveOriginal(backend(() => { saves++ }),
    { ...execution(), signal: before.signal }, 'x'), { name: 'AbortError' })
  assert.equal(saves, 0)
  const during = new AbortController()
  await assert.rejects(archiveOriginal(backend(() => { during.abort() }),
    { ...execution(), signal: during.signal }, 'x'), { name: 'AbortError' })
})

test('UTF-8 limit is exact and invalid text or limits fail before save', async () => {
  let saves = 0
  const store = backend(() => { saves++ })
  await archiveOriginal(store, execution(), '中', { maxBytes: 3 })
  await assert.rejects(archiveOriginal(store, execution(), '中', { maxBytes: 2 }))
  for (const maxBytes of [0, -1, Infinity, 1.5]) {
    await assert.rejects(archiveOriginal(store, execution(), 'x', { maxBytes }))
  }
  await assert.rejects(archiveOriginal(store, execution(), '\ud800'))
  await assert.rejects(archiveOriginal(store, execution(), null))
  assert.equal(saves, 1)
})

test('call, tool and session changes during save cannot misattribute a receipt', async () => {
  for (const mutate of [exec => { exec.callId = 'call-b' }, exec => { exec.name = 'grep' },
    exec => { exec.agent.session.header.id = 'session-b' }]) {
    const exec = execution()
    await assert.rejects(archiveOriginal(backend(() => mutate(exec)), exec, 'x'), /identity changed/)
  }
})

test('abort stops waiting for uncooperative storage and late success cannot yield a receipt', async () => {
  const controller = new AbortController()
  let release, started
  const began = new Promise(resolve => { started = resolve })
  const store = { saveText() { started(); return new Promise(resolve => { release = resolve }) } }
  const operation = archiveOriginal(store, { ...execution(), signal: controller.signal }, 'x')
  await began
  controller.abort()
  const outcome = await Promise.race([operation.then(() => 'receipt', error => error.name),
    new Promise(resolve => setTimeout(() => resolve('still-waiting'), 50))])
  release({ locator: 'late', retrievalHint: 'read', bytes: 1 })
  assert.equal(outcome, 'AbortError')
})

test('storage deadlines and pending-save limits bound uncooperative backend work', async () => {
  let calls = 0
  const releases = []
  const store = { saveText() { calls++; return new Promise((resolve, reject) => releases.push({ resolve, reject })) } }
  const one = archiveOriginal(store, execution(), 'x', { timeoutMs: 5, maxPendingSaves: 1 })
  await assert.rejects(one, { name: 'TimeoutError' })
  await assert.rejects(archiveOriginal(store, execution(), 'x', { maxPendingSaves: 1 }), /pending/i)
  assert.equal(calls, 1)
  releases[0].reject(new Error('late storage failure'))
  await new Promise(resolve => setImmediate(resolve))
  const next = archiveOriginal(store, execution(), 'x', { maxPendingSaves: 1 })
  await new Promise(resolve => setImmediate(resolve))
  releases[1].resolve({ locator: 'ok', retrievalHint: 'read', bytes: 1 })
  assert.equal((await next).locator, 'ok')
})
