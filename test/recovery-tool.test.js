import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { installSnapshotTracking } from '../src/snapshot-telemetry.js'
import { installSnapshotRecovery } from '../src/recovery-tool.js'

function setup(text = '\ufeff中😀\r\nline\r\n', options = {}) {
  let tool
  let removed = false
  const ctx = { on() { return () => {} }, parallel() {}, tools: { register(value) { tool = value; return () => { removed = true } } } }
  const tracking = installSnapshotTracking(ctx)
  const session = { header: { id: 'owner' } }
  const exec = { agent: { session }, signal: new AbortController().signal }
  const bytes = Buffer.from(text)
  const receipt = { locator: 'opaque:original', callId: 'original', sessionId: 'owner', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }
  const reference = tracking.record(exec, receipt)
  const state = { reads: 0, bytes }
  const readPage = async (locator, { offset, length }) => {
    assert.equal(locator, receipt.locator)
    state.reads++
    return state.bytes.subarray(offset, offset + length)
  }
  const installation = installSnapshotRecovery(ctx, { tracking, readPage, pageCharacters: 3, ...options })
  return { tool, tracking, installation, exec, referenceId: reference.referenceId, text, state, removed: () => removed }
}

test('tool pages preserve exact codepoints and distinguish snapshot verification from partial page', async () => {
  const { tool, exec, referenceId, text } = setup()
  let restored = ''
  let offset = 0
  do {
    const page = await tool.execute({ referenceId, offset }, exec)
    assert.equal(page.snapshotVerified, true)
    assert.equal(page.offset, offset)
    assert.ok(Array.from(page.text).length <= 3)
    assert.equal(page.text.isWellFormed(), true)
    restored += page.text
    if (page.nextOffset === null) break
    assert.equal(page.pageComplete, false)
    offset = page.nextOffset
  } while (true)
  assert.equal(restored, text)
})

test('unknown owners, forks, fabricated locators and invalid ranges fail before I/O', async () => {
  const { tool, exec, referenceId, state } = setup()
  for (const args of [{ referenceId: 'f'.repeat(64) }, { referenceId, locator: 'opaque:forged' },
    { referenceId, offset: -1 }, { referenceId, limit: 4 }, { referenceId, limit: 0 }, { referenceId, offset: 1.5 }]) {
    await assert.rejects(tool.execute(args, exec))
  }
  await assert.rejects(tool.execute({ referenceId }, { ...exec, agent: { session: { header: { id: 'owner' } } } }))
  await assert.rejects(tool.execute({ referenceId }, { ...exec, agent: { session: { header: { id: 'fork' } } } }))
  assert.equal(state.reads, 0)
})

test('full integrity check precedes even first page and output budget rejects oversized configuration', async () => {
  const { tool, exec, referenceId, state } = setup()
  state.bytes = Buffer.from(state.bytes)
  state.bytes[state.bytes.length - 1] ^= 1
  await assert.rejects(tool.execute({ referenceId }, exec), /hash/)
  assert.throws(() => setup('x', { pageCharacters: 1000000 }), /pageCharacters/)
  const capped = setup('too large', { maxBytes: 2 })
  await assert.rejects(capped.tool.execute({ referenceId: capped.referenceId }, capped.exec), /limit/)
})

test('disposal, registry clearing, cancellation and expired snapshots fail closed', async () => {
  const one = setup()
  one.installation.dispose()
  assert.equal(one.removed(), true)
  await assert.rejects(one.tool.execute({ referenceId: one.referenceId }, one.exec), /disposed/)
  const two = setup()
  two.tracking.dispose()
  await assert.rejects(two.tool.execute({ referenceId: two.referenceId }, two.exec), /reference/)
  const three = setup()
  await assert.rejects(three.tool.execute({ referenceId: three.referenceId }, { ...three.exec, signal: AbortSignal.abort() }))
  assert.equal(three.state.reads, 0)
  three.state.bytes = Buffer.alloc(0)
  await assert.rejects(three.tool.execute({ referenceId: three.referenceId }, three.exec), /ended/)
})

test('registry identity changes during I/O prevent delivery of an otherwise valid page', async () => {
  let invalidate
  const item = setup('text', { readPage: async (_, { offset, length }) => {
    invalidate()
    return Buffer.from('text').subarray(offset, offset + length)
  } })
  invalidate = () => { item.exec.agent.session.header.id = 'changed' }
  await assert.rejects(item.tool.execute({ referenceId: item.referenceId }, item.exec), /ownership/)
})

test('empty snapshot is complete and out-of-range offsets do not return misleading empty pages', async () => {
  const empty = setup('')
  const page = await empty.tool.execute({ referenceId: empty.referenceId }, empty.exec)
  assert.equal(page.pageComplete, true)
  assert.equal(page.nextOffset, null)
  assert.equal(page.text, '')
  await assert.rejects(empty.tool.execute({ referenceId: empty.referenceId, offset: 1 }, empty.exec), /offset/)
})
