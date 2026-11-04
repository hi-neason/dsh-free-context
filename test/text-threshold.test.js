import assert from 'node:assert/strict'
import test from 'node:test'
import { parseConfig } from '../src/config.js'
import { createContentRouter } from '../src/router.js'
import { decodeLosslessText } from '../src/lossless-text.js'
import { measureContent } from '../src/diagnostics.js'

const text = Array.from({ length: 20 }, (_, i) =>
  `src/rules/L${String(i).padStart(3, '0')}.py:${i + 10}:5: unexpected whitespace before identifier item_${i}\r\n` +
  '    Expected one space between the expression and its alias.\r\n').join('') + '唯一诊断 😀 status=1\r\n'
const content = [{ type: 'text', text }]
const config = (textOptions = {}, overrides = {}) => parseConfig({
  mode: 'apply', tools: ['fixture'], text: { enabled: true, ...textOptions }, ...overrides,
})
const exec = { name: 'fixture', callId: 'threshold' }

test('moderately repetitive diagnostics require an explicit lower text savings threshold', () => {
  assert.equal(createContentRouter(config())(content, exec), undefined)
  assert.equal(createContentRouter(config({ minSavingsRatio: 0.5 }))(content, exec), undefined)
  assert.equal(createContentRouter(config({ minSavingsRatio: 0.2 }))(content, exec), undefined)
  const candidate = createContentRouter(config({ minSavingsRatio: 0.1 }))(content, exec)
  assert.equal(candidate.strategy, 'tool-lossless-text-v1')
  assert.equal(candidate.lossy, false)
  assert.deepEqual(Buffer.from(decodeLosslessText(candidate.content[0].text)), Buffer.from(text))
  const input = measureContent(content), output = measureContent(candidate.content)
  assert.ok(output.bytes <= input.bytes * 0.9 && output.bytes > input.bytes * 0.8)
  assert.ok(output.estimatedTokens <= input.estimatedTokens * 0.9)
})

test('lower text threshold retains full-frame, token and minimum absolute savings guards', () => {
  assert.equal(createContentRouter(config({ minSavingsRatio: 0.1 }, { minSavingsTokens: 200 }))(content, exec), undefined)
  const inputBytes = measureContent(content).bytes
  for (const outputTokens of [95, 100, 101]) {
    assert.equal(createContentRouter(config({ minSavingsRatio: 0.1 }, { minSavingsTokens: 0 }), {
      estimator: bytes => bytes === inputBytes ? 100 : outputTokens,
    })(content, exec), undefined)
  }
  assert.equal(createContentRouter(config({ minSavingsRatio: 0 }, { minSavingsTokens: 0 }), {
    estimator: () => 100,
  })(content, exec), undefined)
  const framed = [{ ...content[0], metadata: 'x'.repeat(10000) }]
  assert.equal(createContentRouter(config({ minSavingsRatio: 0.1 }))(framed, exec), undefined)
})

test('lower generic text threshold does not lower the artifact read threshold', async () => {
  const route = createContentRouter(config({ minSavingsRatio: 0.1 }, {
    tools: ['read'], readText: { enabled: true, encodeArtifacts: true },
  }), {
    getReadClassifier: () => ({ classify: inputPath => ({ kind: 'artifact', complete: true, inputPath, canonicalPath: inputPath }) }),
    getStore: () => assert.fail('no snapshot'),
  })
  assert.equal(await route(content, { ...exec, name: 'read' }, { readPath: '/work/diagnostics.txt' }), undefined)
})
