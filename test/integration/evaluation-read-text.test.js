import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { runAgentFixture } from '../../scripts/evaluate-agent.js'
import { decodeLosslessText } from '../../src/lossless-text.js'
import { verifySnapshot } from '../../src/recovery.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const receiptOf = text => JSON.parse(text.match(/Original tool-result snapshot: (\{[^\n]+\})/)[1])
function decodeVisible(text) {
  if (!text.startsWith('[dsh-lossless-text:v1]')) return text
  const boundary = text.indexOf('\n\nOriginal tool-result snapshot: ')
  assert.ok(boundary > 0)
  return decodeLosslessText(text.slice(0, boundary))
}
function visibleBody(text) {
  const decoded = decodeVisible(text)
  const body = decoded.match(/<content>\n([\s\S]*)\n<\/content>$/)?.[1] ?? decoded
  return body.replace(/^\d+: /gm, '').replace(/\n\n\(End of file - total \d+ lines\)$/, '')
}
function fixture() {
  const lines = ['TAP version 13']
  for (let index = 1; index <= 10; index++) {
    const title = 'Repeated diagnostic explanation. '.repeat(25) + `check-${index}`
    lines.push(`# Subtest: ${title}`, `ok ${index} - ${title}`, '  ---', `  duration_ms: ${index === 5 ? 73.625 : 0.125}`, "  type: 'test'", '  ...')
  }
  lines.push('1..10', '# tests 10', '# suites 0', '# pass 10', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 120')
  return { id: 'read-text-source-and-primary-snapshot', kind: 'tap', text: lines.join('\n'), edit: true,
    editedText: 'changed source', requireSnapshot: true,
    query: 'Call fixture. Read the original source and its encoded-read snapshot if one is provided. Replace the original source with exactly changed source, then read it to confirm. Finally read the original fixture snapshot and report the exact duration_ms for check-5 as JSON {"duration_ms":NUMBER}.',
    expected: { duration_ms: 73.625 } }
}

// This adapter sees the same tool messages as the model. The Proxy used below
// rejects attempts to obtain fixture facts, paths or callbacks from the runner.
function adapterFactory({ LlmAdapter }, observations) {
  return new class extends LlmAdapter {
    index = 0
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      const results = request.messages.filter(message => message.role === 'tool')
      const text = id => textOf(results.find(message => message.toolCallId === id))
      observations.requests.push(structuredClone(request.messages))
      const user = request.messages.filter(message => message.role === 'user').map(textOf).join('\n')
      const source = user.match(/Original fixture path: ([^\n]+)/)?.[1]
      const call = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
      let block
      switch (this.index++) {
        case 0: block = call('fixture-result', 'fixture', {}); break
        case 1: block = call('source-read', 'read', { file_path: source, offset: 1, limit: 1000 }); break
        case 2: {
          const packed = text('source-read')
          observations.decodedSource = decodeVisible(packed)
          const own = receiptOf(packed)
          const primary = receiptOf(text('fixture-result'))
          assert.notEqual(own.locator, primary.locator)
          observations.own = own
          observations.primary = primary
          block = call('own-snapshot-read', 'read', { file_path: own.locator, offset: 1, limit: 1000 })
          break
        }
        case 3:
          assert.equal(visibleBody(text('own-snapshot-read')), observations.decodedSource)
          block = call('change-source', 'write', { file_path: source, content: 'changed source' })
          break
        case 4: block = call('changed-source-read', 'read', { file_path: source }); break
        case 5:
          assert.equal(visibleBody(text('changed-source-read')), 'changed source')
          block = call('primary-snapshot-read', 'read', { file_path: receiptOf(text('fixture-result')).locator, offset: 1, limit: 1000 })
          break
        default: {
          const original = visibleBody(text('primary-snapshot-read'))
          const found = original.match(/check-5\n  ---\n  duration_ms: ([0-9.]+)/)
          assert.ok(found)
          block = { type: 'text', text: JSON.stringify({ duration_ms: Number(found[1]) }) }
        }
      }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    }
  }()
}

test('AgentLoop opt-in persists packed source reads, keeps both snapshots raw and preserves the primary pointer after editing', async () => {
  const observed = { requests: [], persisted: [], tools: [] }
  const result = await runAgentFixture(fixture(), 'plugin', { replay: true, readText: true, maxSteps: 8,
    adapterFactory: options => adapterFactory(new Proxy(options, { get(target, key) {
      if (key !== 'LlmAdapter') throw new Error('Hidden runner evidence accessed')
      return target[key]
    } }), observed),
    configureContext(ctx) {
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'tool/result') observed.persisted.push(structuredClone(event))
      })
      ctx.on('tools/post-execute', async (exec, raw, next) => {
        const decision = await next()
        const output = decision.content ?? raw.content
        observed.tools.push({ id: exec.callId, raw: structuredClone(raw), decision: structuredClone(decision), output: structuredClone(output),
          classification: exec.name === 'read' ? await ctx.get('freeContextReadClassifier').classify(raw.value?.path) : undefined })
        if (exec.callId === 'source-read') {
          const receipt = receiptOf(textOf({ content: output }))
          const bytes = await readFile(receipt.locator)
          verifySnapshot(receipt, bytes)
          assert.equal(bytes.toString('utf8'), raw.content[0].text)
          assert.equal((await stat(join(exec.agent.session.header.cwd, 'spill'))).mode & 0o777, 0o700)
        }
        return decision
      }, { prepend: true })
    } })
  assert.equal(result.passed, true, JSON.stringify({ failure: result.failure, drafts: result.drafts, toolCalls: result.toolCalls, decisions: result.decisions,
    classifications: observed.tools.map(({ id, classification }) => ({ id, classification })) }))
  assert.equal(result.snapshotRecovered, true)
  assert.equal(result.fileCorrect, true)
  assert.deepEqual(result.configuration.readText, { enabled: true, classifier: 'filesystem-host-v1', minimumSavingsRatio: 0.5 })
  assert.deepEqual(result.readClassification.artifactRoots, [join(result.readClassification.sourceRoots[0], 'spill')])
  assert.equal(result.readClassification.artifactInventoryComplete, true)
  const source = observed.tools.find(row => row.id === 'source-read')
  assert.match(source.output[0].text, /^\[dsh-lossless-text:v1\]/)
  assert.equal(Object.hasOwn(source.decision, 'value'), false)
  assert.equal(decodeVisible(source.output[0].text), source.raw.content[0].text)
  const persisted = observed.persisted.find(event => event.data.message.toolCallId === 'source-read')
  assert.deepEqual(persisted.data.message.content, source.output)
  assert.deepEqual(persisted.data.meta, source.raw.meta)
  assert.ok(result.modelCalls.some(call => call.visibleToolResults.some(visible => visible.callId === 'source-read' && visible.contentHash === hash(source.output))))
  for (const id of ['own-snapshot-read', 'primary-snapshot-read']) {
    const read = observed.tools.find(row => row.id === id)
    assert.equal(Object.hasOwn(read.decision, 'content'), false)
    assert.deepEqual(read.output, read.raw.content)
  }
  assert.equal(result.toolCalls.find(call => call.callId === 'source-read').readSnapshot, false)
  assert.equal(result.toolCalls.find(call => call.callId === 'own-snapshot-read').readSnapshot, false)
  assert.equal(result.toolCalls.find(call => call.callId === 'primary-snapshot-read').readSnapshot, true)
  assert.equal(result.recoveryCalls, 1)
  assert.equal(result.estimatedCostUSD, null)
  assert.equal(result.cleanup.complete, true)
})

test('readText is explicitly boolean and default configurations retain their existing shape', async () => {
  const task = { id: 'read-text-default', kind: 'text', text: 'value: 7', query: 'Call fixture and return JSON {"value":7}.', expected: { value: 7 } }
  await assert.rejects(runAgentFixture(task, 'plugin', { replay: true, readText: 'true' }), /readText must be a boolean/)
  const adapter = ({ LlmAdapter }) => new class extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      const visible = request.messages.find(message => message.role === 'tool')
      const block = visible ? { type: 'text', text: JSON.stringify({ value: Number(textOf(visible).match(/value: (\d+)/)[1]) }) }
        : { type: 'tool-call', id: 'fixture', name: 'fixture', arguments: '{}' }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: visible ? 'stop' : 'tool-calls' } }
    }
  }()
  for (const readText of [undefined, false, true]) {
    const result = await runAgentFixture(task, 'baseline-tuned', { replay: true, adapterFactory: adapter, ...(readText === undefined ? {} : { readText }) })
    assert.equal(result.passed, true)
    assert.equal(Object.hasOwn(result.configuration, 'readText'), readText === true)
    assert.equal(Object.hasOwn(result, 'readClassification'), false)
    if (readText === true) assert.deepEqual(result.configuration.readText, { enabled: false, classifier: 'filesystem-host-v1', minimumSavingsRatio: 0.5 })
  }
})
