import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptFixture, loadFixtures, pluginContent } from '../scripts/evaluate.js'
import { evaluateLive, queryModel } from '../scripts/evaluate-live.js'

test('offline fixtures check exact facts from actual plugin output and reject missing facts', async () => {
  for (const fixture of await loadFixtures()) {
    const transformed = await pluginContent(fixture)
    assert.equal(acceptFixture(fixture, transformed.content).passed, true)
    assert.equal(acceptFixture(fixture, [{ type: 'text', text: 'facts missing' }]).passed, false)
    if (fixture.kind === 'json') {
      assert.equal(transformed.decision.outcome, 'selected')
      assert.ok(transformed.decision.output.bytes < transformed.decision.input.bytes)
    }
  }
})

test('live pairs send the same query and report actual numeric provider usage', async () => {
  const fixtures = await loadFixtures()
  const requests = []
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions')
    assert.equal(options.headers.Authorization, 'Bearer test-only')
    assert.ok(options.signal instanceof AbortSignal)
    const body = JSON.parse(options.body)
    requests.push(body)
    const fixture = fixtures.find(item => body.messages[0].content.startsWith(item.query))
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fixture.expected) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70 } }))
  }
  const result = await evaluateLive({ key: 'test-only', fetchImpl })
  assert.equal(result.completed, true)
  assert.equal(requests.length, fixtures.length * 2)
  for (const task of result.tasks) {
    assert.equal(task.bothPassed, true)
    assert.deepEqual(task.providerTotalTokens, { original: 120, plugin: 120 })
    assert.equal(task.groups.plugin.usage.prompt_cache_hit_tokens, 30)
  }
  assert.equal(JSON.stringify(result).includes('test-only'), false)
})

test('401 stops comparison and is never reported as model success or leaked body', async () => {
  let calls = 0
  const result = await evaluateLive({ key: 'secret-test', fetchImpl: async () => {
    calls++
    return new Response('secret-test', { status: 401 })
  } })
  assert.equal(calls, 1)
  assert.equal(result.completed, false)
  assert.equal(result.stoppedReason, 'credential-rejected')
  assert.equal(JSON.stringify(result).includes('secret-test'), false)
})

test('missing usage, wrong answers, and timeout remain distinct from successful quality evidence', async () => {
  const args = { key: 'test-only', model: 'fixture', query: 'q', text: 'text', expected: { code: 'x' } }
  const wrong = await queryModel({ ...args, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"code":"wrong"}' } }] })) })
  assert.equal(wrong.passed, false)
  assert.equal(wrong.usageComplete, false)
  assert.deepEqual(wrong.usage, {})
  const timeout = await queryModel({ ...args, fetchImpl: async () => { throw new DOMException('secret-test', 'TimeoutError') } })
  assert.deepEqual(timeout, { status: 'timeout' })
  const incomplete = await evaluateLive({ key: 'test-only', fetchImpl: async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 },
  })) })
  assert.equal(incomplete.completed, false)
})

test('live QA rejects contradictory or incomplete accounting and truncated correct answers', async () => {
  const fixtures = await loadFixtures()
  const valid = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70 }
  const cases = [
    { usage: { ...valid, total_tokens: 121 } },
    { usage: { ...valid, prompt_cache_miss_tokens: 71 } },
    { usage: { ...valid, prompt_cache_hit_tokens: -1 } },
    { usage: { ...valid, prompt_cache_hit_tokens: 30.5 } },
    { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
    { usage: { ...valid, prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1,
      total_tokens: Number.MAX_SAFE_INTEGER, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: Number.MAX_SAFE_INTEGER } },
    { usage: valid, finishReason: 'length' },
    { usage: valid, finishReason: 'tool_calls' },
  ]
  for (const scenario of cases) {
    const report = await evaluateLive({ key: 'test-only', fetchImpl: async (_url, options) => {
      const prompt = JSON.parse(options.body).messages[0].content
      const fixture = fixtures.find(item => prompt.startsWith(item.query))
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fixture.expected) },
        finish_reason: scenario.finishReason ?? 'stop' }], usage: scenario.usage }))
    } })
    assert.equal(report.completed, false)
    const group = report.tasks[0].groups.original
    assert.equal(group.exactFacts, true)
    assert.equal(group.usage.completion_tokens, scenario.usage.completion_tokens, 'known counts remain visible')
    if (scenario.finishReason) {
      assert.equal(group.responseComplete, false)
      assert.equal(group.passed, false)
    } else assert.equal(group.usageComplete, false)
  }
})
