import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { recoverSnapshot, verifySnapshot } from '../src/recovery.js'

const original = Buffer.from('\ufeff中😀\r\n' + 'long'.repeat(100) + '\r\n')
const receipt = { locator: 'opaque:original', bytes: original.length,
  sha256: createHash('sha256').update(original).digest('hex') }
const readPage = async (locator, { offset, length }) => {
  assert.equal(locator, receipt.locator)
  return original.subarray(offset, offset + length)
}

test('bounded byte pagination verifies full Unicode and CRLF without decoding each page', async () => {
  const recovered = await recoverSnapshot(receipt, readPage, { pageBytes: 5 })
  assert.deepEqual(recovered, original)
  assert.equal(verifySnapshot(receipt, recovered), true)
})

test('partial data, same-length corruption, extra bytes and stalled pages fail closed', async () => {
  assert.throws(() => verifySnapshot(receipt, original.subarray(1)), /byte count/)
  const corrupt = Buffer.from(original)
  corrupt[0] ^= 1
  assert.throws(() => verifySnapshot(receipt, corrupt), /hash/)
  for (const content of [original.subarray(0, 10), Buffer.concat([original, Buffer.from('x')]), corrupt]) {
    await assert.rejects(recoverSnapshot(receipt, async (_, { offset, length }) => content.subarray(offset, offset + length), { pageBytes: 7 }))
  }
  await assert.rejects(recoverSnapshot(receipt, async () => new Uint8Array()), /ended/)
  await assert.rejects(recoverSnapshot(receipt, async () => Buffer.alloc(9), { pageBytes: 8 }), /page/)
})

test('invalid receipts, budgets and byte types reject before backend I/O', async () => {
  let reads = 0
  const reader = async () => { reads++; return original }
  for (const candidate of [{ ...receipt, bytes: -1 }, { ...receipt, bytes: 1.5 },
    { ...receipt, sha256: 'wrong' }, { ...receipt, locator: '' }]) {
    await assert.rejects(recoverSnapshot(candidate, reader))
  }
  for (const options of [{ maxBytes: original.length - 1 }, { pageBytes: 0 }, { maxBytes: Infinity }]) {
    await assert.rejects(recoverSnapshot(receipt, reader, options))
  }
  assert.equal(reads, 0)
  await assert.rejects(recoverSnapshot(receipt, async () => 'decoded text'), /bytes/)
})

test('read failure, cancellation and deadline never yield a verified snapshot', async () => {
  await assert.rejects(recoverSnapshot(receipt, async () => { throw new Error('missing artifact') }), /missing artifact/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(recoverSnapshot(receipt, readPage, { signal: controller.signal }), { name: 'AbortError' })
  await assert.rejects(recoverSnapshot(receipt, async () => new Promise(() => {}), { timeoutMs: 5 }), { name: 'TimeoutError' })
})

test('receipt mutation and reused page buffers cannot change expected snapshot identity', async () => {
  const mutable = { ...receipt }
  const scratch = Buffer.alloc(5)
  const recovered = await recoverSnapshot(mutable, async (_, { offset, length }) => {
    mutable.sha256 = '0'.repeat(64)
    mutable.bytes = 0
    const page = original.subarray(offset, offset + length)
    scratch.fill(0)
    scratch.set(page)
    return scratch.subarray(0, page.length)
  }, { pageBytes: 5 })
  assert.deepEqual(recovered, original)
})

test('timeout prevents late uncooperative read from starting another page', async () => {
  let release
  let calls = 0
  const recovering = recoverSnapshot(receipt, async () => {
    calls++
    return new Promise(resolve => { release = resolve })
  }, { pageBytes: 5, timeoutMs: 5 })
  await assert.rejects(recovering, { name: 'TimeoutError' })
  release(original.subarray(0, 5))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
})

test('empty snapshots require verified empty EOF', async () => {
  const empty = { ...receipt, bytes: 0, sha256: createHash('sha256').update('').digest('hex') }
  assert.deepEqual(await recoverSnapshot(empty, async () => Buffer.alloc(0)), Buffer.alloc(0))
  await assert.rejects(recoverSnapshot(empty, async () => Buffer.from('x')), /byte count/)
})

test('timed-out reads retain callback slots until real settlement and late rejection is observed', async () => {
  const pending = []
  const reader = () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  await assert.rejects(recoverSnapshot(receipt, reader, { timeoutMs: 5, maxPendingReads: 1 }), { name: 'TimeoutError' })
  await assert.rejects(recoverSnapshot(receipt, reader, { timeoutMs: 100, maxPendingReads: 1 }), /pending read limit/)
  assert.equal(pending.length, 1)
  pending[0].reject(new Error('late backend failure'))
  await new Promise(resolve => setImmediate(resolve))
  const next = recoverSnapshot(receipt, reader, { maxPendingReads: 1 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pending.length, 2)
  pending[1].resolve(original)
  await new Promise(resolve => setImmediate(resolve))
  pending[2].resolve(Buffer.alloc(0))
  assert.deepEqual(await next, original)
})

test('aborted reads share default four-slot cap by callback identity without blocking other adapters', async () => {
  let calls = 0
  const pending = []
  const reader = () => { calls++; return new Promise(resolve => pending.push(resolve)) }
  for (let index = 0; index < 4; index++) {
    const controller = new AbortController()
    const operation = recoverSnapshot(receipt, reader, { signal: controller.signal })
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    await assert.rejects(operation, { name: 'AbortError' })
  }
  await assert.rejects(recoverSnapshot(receipt, reader), /pending read limit/)
  assert.equal(calls, 4)
  assert.deepEqual(await recoverSnapshot(receipt, readPage), original)
  for (const release of pending) release(original)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 4)
})

test('invalid pending-read limits fail before invoking backend', async () => {
  for (const maxPendingReads of [0, -1, Infinity, 1.5]) {
    await assert.rejects(recoverSnapshot(receipt, () => { throw new Error('must not call') }, { maxPendingReads }), /Invalid maxPendingReads/)
  }
})
