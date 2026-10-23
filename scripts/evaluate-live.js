import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { loadFixtures, pluginContent } from './evaluate.js'

const endpoint = 'https://api.deepseek.com/chat/completions'
const usageFields = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']

export async function queryModel({ key, model, query, text, expected, fetchImpl = fetch, timeoutMs = 60000 }) {
  const started = performance.now()
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 256,
        messages: [{ role: 'user', content: `${query}\n\nTool result:\n${text}` }] }),
    })
    if (!response.ok) return { status: 'http-error', httpStatus: response.status, elapsedMs: performance.now() - started }
    const data = await response.json()
    const answer = data.choices?.[0]?.message?.content
    if (typeof answer !== 'string') return { status: 'invalid-response' }
    let actual
    try { actual = JSON.parse(answer) } catch { actual = null }
    const usage = Object.fromEntries(usageFields.filter(field => Number.isSafeInteger(data.usage?.[field]) && data.usage[field] >= 0)
      .map(field => [field, data.usage[field]]))
    return { status: 'success', actual, passed: isDeepStrictEqual(actual, expected), usage,
      usageComplete: usageFields.slice(0, 3).every(field => Object.hasOwn(usage, field)),
      finishReason: data.choices[0].finish_reason, elapsedMs: performance.now() - started }
  } catch (error) {
    return { status: error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : 'request-failed' }
  }
}

export async function evaluateLive({ key, model = 'deepseek-flash', fetchImpl = fetch, timeoutMs = 60000 }) {
  if (typeof key !== 'string' || !key.trim()) throw new TypeError('Missing explicit API credential')
  const report = { evaluationKind: 'live-single-turn-paired-qa', endpoint, model, completed: false,
    limitations: ['Single-turn questions are not complete Agent tasks or total Agent costs.',
      'Each request independently includes the same question. Provider usage is reported without claiming cache benefits.',
      'No recovery tools, retries, multi-turn planning or monetary pricing are included.'], tasks: [] }
  for (const fixture of await loadFixtures()) {
    const plugin = await pluginContent(fixture)
    const task = { id: fixture.id, candidateSelected: plugin.decision.outcome === 'selected', groups: {} }
    report.tasks.push(task)
    for (const [name, text] of [['original', fixture.text], ['plugin', plugin.content.map(block => block.text).join('\n')]]) {
      task.groups[name] = await queryModel({ key, model, query: fixture.query, text, expected: fixture.expected, fetchImpl, timeoutMs })
      if (task.groups[name].httpStatus === 401 || task.groups[name].httpStatus === 403) {
        report.stoppedReason = 'credential-rejected'
        return report
      }
    }
    task.bothPassed = Object.values(task.groups).every(group => group.status === 'success' && group.passed)
    task.providerTotalTokens = Object.fromEntries(Object.entries(task.groups).map(([name, group]) => [name, group.usage?.total_tokens ?? null]))
  }
  report.completed = report.tasks.every(task => Object.values(task.groups).every(group =>
    group.status === 'success' && group.passed && group.usageComplete))
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length % 2 || args.some((arg, index) => index % 2 === 0 && !['--credential-file', '--model'].includes(arg))) {
      throw new Error('Expected --credential-file PATH and/or --model MODEL')
    }
    const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[2 * i], args[2 * i + 1]]))
    const key = options['--credential-file'] ? (await readFile(options['--credential-file'], 'utf8')).trim() : process.env.DEEPSEEK_API_KEY
    const report = await evaluateLive({ key, model: options['--model'] })
    console.log(JSON.stringify(report, null, 2))
    if (!report.completed) process.exitCode = 1
  } catch {
    console.error('Live evaluation could not start. Supply DEEPSEEK_API_KEY or --credential-file PATH, and optionally --model MODEL. No credential was printed.')
    process.exitCode = 1
  }
}
