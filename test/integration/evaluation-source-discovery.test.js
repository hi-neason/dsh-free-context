import test from 'node:test'
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import { runAgentFixture } from '../../scripts/evaluate-agent.js'
import { acceptanceFixturesV2 } from '../fixtures/acceptance/tasks-v2.js'

const fixture = { id: 'source-discovery', kind: 'acceptance', text: 'Revision: original. Checkpoint value: 73.625.\n',
  query: 'Call fixture, then read its original source and report the checkpoint as JSON.', expected: { checkpoint: 73.625 }, requireReadEachPhase: true }
const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')

function discoveryAdapter(observed, enabled, { verifySnapshot = false } = {}) {
  return options => new class extends options.LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      let block
      const tool = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
      const results = request.messages.filter(message => message.role === 'tool')
      if (!results.length) {
        const user = request.messages.find(message => message.role === 'user' && textOf(message).startsWith(options.fixture.query))
        observed.prompt = textOf(user)
        observed.source = options.source
        if (enabled) {
          assert.equal(JSON.stringify(request).includes(options.source), false)
          assert.equal(JSON.stringify(request).includes(basename(options.source)), false)
          assert.match(basename(options.source), /^source-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.txt$/)
        } else {
          assert.equal(basename(options.source), 'original.txt')
          assert.equal(observed.prompt, `${options.fixture.query}\nOriginal fixture path: ${options.source}`)
        }
        block = tool('fixture-1', 'fixture', {})
      } else if (!observed.sourceRead) {
        observed.fixtureText = textOf(results.find(message => message.toolCallId === 'fixture-1'))
        // Discover the tool argument only from model-visible evidence, not the
        // factory's source parameter, which is used solely for test assertions.
        const locator = (enabled ? observed.fixtureText : observed.prompt).match(/^Original fixture path: ([^\n]+)$/m)?.[1]
        assert.equal(locator, options.source)
        assert.equal(await readFile(locator, 'utf8'), options.fixture.text)
        observed.sourceRead = true
        block = tool('read-source', 'read', { file_path: locator, offset: 1, limit: 1000 })
      } else if (verifySnapshot && options.snapshotPath() && !observed.snapshotRead) {
        observed.snapshotText = await readFile(options.snapshotPath(), 'utf8')
        observed.snapshotRead = true
        block = tool('read-snapshot', 'read', { file_path: options.snapshotPath(), offset: 1, limit: 1000 })
      } else {
        const sourceResult = results.find(message => message.toolCallId === 'read-source')
        assert.notEqual(sourceResult.isError, true)
        const match = textOf(sourceResult).match(/Checkpoint value: ([\d.]+)\./)
        assert.ok(match)
        block = { type: 'text', text: JSON.stringify({ checkpoint: Number(match[1]) }) }
      }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    }
  }()
}

test('source discovery hides an unpredictable filename until fixture returns the locator in every group', async () => {
  const rendered = []
  for (const group of ['baseline-default', 'baseline-tuned', 'plugin']) {
    const observed = {}
    const result = await runAgentFixture({ ...fixture, discoverSourcePath: true }, group, { replay: true, adapterFactory: discoveryAdapter(observed, true) })
    assert.equal(result.passed, true)
    assert.deepEqual(result.toolCalls.map(call => call.name), ['fixture', 'read'])
    assert.equal(result.toolCalls[1].readOriginal, true)
    assert.equal(result.toolCalls[1].isError, false)
    rendered.push(observed.fixtureText.replace(observed.source, '<source>'))
  }
  assert.deepEqual(rendered, Array(3).fill(`${fixture.text}\n\nOriginal fixture path: <source>`))
})

test('default and explicit false preserve the original prompt and byte-exact fixture output', async () => {
  const outputs = []
  for (const flag of [undefined, false]) {
    const observed = {}
    const input = { ...fixture, ...(flag !== undefined ? { discoverSourcePath: flag } : {}) }
    const result = await runAgentFixture(input, 'baseline-default', { replay: true, adapterFactory: discoveryAdapter(observed, false) })
    assert.equal(result.passed, true)
    assert.equal(observed.fixtureText, fixture.text)
    outputs.push(observed.prompt.replace(observed.source, '<source>'))
  }
  assert.equal(outputs[0], outputs[1])
})

test('the locator remains discoverable after the native 1200-token spill policy bounds long results', async () => {
  const input = { ...fixture, discoverSourcePath: true, text: fixture.text + Array.from({ length: 200 }, (_, index) => `Background ${index}: ${'ordinary context '.repeat(20)}`).join('\n') }
  for (const group of ['baseline-tuned', 'plugin']) {
    const observed = {}
    const result = await runAgentFixture(input, group, { replay: true, composeWithTunedNative: true, adapterFactory: discoveryAdapter(observed, true) })
    assert.equal(result.passed, true)
    assert.ok(observed.fixtureText.length < input.text.length)
    assert.ok(observed.fixtureText.includes(`Original fixture path: ${observed.source}`))
    assert.ok(result.toolCalls.some(call => call.readOriginal && !call.isError))
  }
})

test('discovery snapshots retain the exact incoming tool text including its source locator', async () => {
  const history = acceptanceFixturesV2().find(task => task.id === 'history-retirement-short')
  const input = { ...fixture, text: history.text, discoverSourcePath: true, requireSnapshot: true }
  const observed = {}
  const result = await runAgentFixture(input, 'plugin', { replay: true, adapterFactory: discoveryAdapter(observed, true, { verifySnapshot: true }),
    composeWithTunedNative: true, maxSteps: 12, historyRetirement: { ...history.historyRetirement, minimumFutureRequests: 200, excerptCharacters: 64 } })
  assert.equal(result.passed, true)
  assert.ok(result.retirements.some(record => record.reason === 'retired'))
  assert.equal(observed.snapshotText, observed.fixtureText)
  assert.equal(observed.snapshotText, `${input.text}\n\nOriginal fixture path: ${observed.source}`)
  assert.ok(result.toolCalls.some(call => call.name === 'read' && call.readSnapshot && !call.isError))
})

test('source discovery accepts only a boolean before any adapter or model invocation', async () => {
  let adapters = 0
  for (const value of [null, 0, 1, 'true', {}, []]) {
    await assert.rejects(runAgentFixture({ ...fixture, discoverSourcePath: value }, 'baseline-default', {
      replay: true, adapterFactory() { adapters++; throw new Error('must not run') },
    }), /Source discovery.*boolean/)
  }
  assert.equal(adapters, 0)
})
