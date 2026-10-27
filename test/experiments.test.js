import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as plugin from 'dsh-free-context/experiments'
import { formatSnapshotReference } from '../src/snapshot.js'
import { parseExperimentConfig } from '../src/experiment-config.js'

const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} explains general background in ordinary prose. ${'This sentence provides further descriptive context. '.repeat(10)}`).join('\n\n')
const settings = overrides => ({ mode: 'apply', tools: ['read'], provider: 'fake', model: 'fake-model',
  maxInputBytes: 40000, maxPromptBytes: 50000, maxOutputBytes: 1000, maxOutputTokens: 100,
  maxArtifactBytes: 60000, timeoutMs: 1000, maxParagraphs: 50, maxCacheEntries: 2, protectedTerms: [],
  pricing: { currency: 'USD', uncachedInputPerMillion: 1, cacheReadPerMillion: 0.1, outputPerMillion: 1 },
  minimumFutureRequests: 1000, futureCacheReadPerMillion: 0.1, expectedRecoveryCost: 0, safetyMargin: 0.1, maxCallCost: 1,
  ...overrides })
const execution = () => ({ name: 'read', callId: 'call-1', agent: { session: { header: { id: 'session-1' } } }, signal: new AbortController().signal })
const result = () => ({ isError: false, content: [{ type: 'text', text }], value: { unchanged: true } })
function setup(overrides = {}, behavior = {}) {
  const events = []
  const saves = []
  const calls = []
  const store = { async saveText(input) {
    await behavior.onSave?.()
    if (behavior.storageFailure) throw new Error('private storage detail')
    saves.push(input)
    return { locator: `spill://fixture/${saves.length}`, bytes: Buffer.byteLength(input.content), retrievalHint: 'Use exact snapshot.' }
  } }
  let handler
  const ctx = {
    on: (_event, callback) => { handler = callback }, logger: { warn() {} },
    get: name => name === 'freeContextQuery' ? behavior.queryProvider : name === 'spillStore' && !behavior.noStore ? store : undefined,
    parallel: async (event, record) => { if (['free-context/experiment', 'free-context/decision'].includes(event)) events.push({ event, record }); await behavior.onReport?.(event) },
    llm: { async * stream(request) {
      calls.push(request)
      await behavior.onRequest?.()
      if (behavior.cancel) behavior.cancel.abort()
      const response = behavior.responseFor ? behavior.responseFor(request) : behavior.invalidResponse ? '{"selectedIds":[]}' : '{"selectedIds":["p1"]}'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: response }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
      if (!behavior.noUsage) yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, ...(behavior.write ? { cacheWriteTokens: 20 } : {}), ...behavior.usage } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
  }
  plugin.apply(ctx, settings(overrides))
  return { handler, events, saves, calls }
}

test('disabled defaults make no hook or model calls; active configuration is strict and frozen', () => {
  plugin.apply({ on: () => assert.fail('disabled') })
  assert.deepEqual(plugin.inject, ['tools', 'llm'])
  const input = settings()
  const config = parseExperimentConfig(input)
  input.tools.push('other')
  assert.deepEqual(config.tools, ['read'])
  assert.equal(Object.isFrozen(config.pricing), true)
  for (const invalid of [{ unexpected: true }, { tools: ['read', 'read'] }, { mode: 'apply', tools: ['read'] }, { pricing: { currency: 'bad' } }, { maxCallCost: -1 }]) assert.throws(() => parseExperimentConfig(invalid), TypeError)
})

test('apply archives original and full auxiliary audit before returning a candidate with real references', async () => {
  const { handler, events, saves, calls } = setup()
  const original = result()
  const contexts = [{ role: 'user', content: [{ type: 'text', text: 'context' }] }]
  const decision = { kind: 'accept', additionalContexts: contexts }
  const actual = await handler(execution(), original, async () => decision)
  assert.notEqual(actual, decision)
  assert.equal(actual.additionalContexts, contexts)
  assert.deepEqual(original.value, { unchanged: true })
  assert.equal(saves[0].content, text)
  assert.equal(saves.length, 2)
  const manifest = JSON.parse(saves[1].content)
  assert.ok(manifest.audit.request.messages[0].content[0].text.includes(text.split('\n\n')[0]))
  assert.equal(manifest.audit.response[0].text, '{"selectedIds":["p1"]}')
  assert.equal(manifest.audit.request.provider, 'fake')
  assert.equal(manifest.callUsage.inputTokens, 100)
  assert.ok(actual.content[0].text.includes('spill://fixture/1'))
  assert.ok(actual.content[0].text.includes('spill://fixture/2'))
  assert.ok(actual.content[0].text.includes('UTF-16'))
  assert.equal(calls.length, 1)
  const associations = events.find(item => item.event === 'free-context/decision').record.snapshots
  assert.equal(associations.length, 2)
  assert.deepEqual(associations.map(ref => ref.purpose), ['original', 'audit'])
  assert.equal(JSON.stringify(associations).includes('spill://'), false)
  const report = events.find(item => item.event === 'free-context/experiment').record
  assert.equal(report.reason, 'selected')
  assert.ok(Math.abs(report.estimatedCost - 0.000115) < 1e-12)
  assert.equal(JSON.stringify(events).includes('ordinary prose'), false)
})

test('observe still incurs a model call and stores artifacts but preserves original decision', async () => {
  const { handler, saves, calls } = setup({ mode: 'observe' })
  const decision = { kind: 'accept' }
  assert.equal(await handler(execution(), result(), async () => decision), decision)
  assert.equal(calls.length, 1)
  assert.equal(saves.length, 2)
})

test('pre-call budgets, missing assumptions, no storage and archive failure prevent model calls', async () => {
  const scenarios = [
    [{ maxCallCost: 0 }, {}, 'call-cost-budget'],
    [{ pricing: undefined }, {}, 'missing-pricing'],
    [{ minimumFutureRequests: undefined }, {}, 'missing-economic-assumptions'],
    [{ minimumFutureRequests: 0 }, {}, 'no-predicted-benefit-before-call'],
    [{}, { noStore: true }, 'snapshot-failed'],
    [{}, { storageFailure: true }, 'snapshot-failed'],
  ]
  for (const [config, behavior, reason] of scenarios) {
    const { handler, calls, events } = setup(config, behavior)
    const decision = { kind: 'accept' }
    assert.equal(await handler(execution(), result(), async () => decision), decision)
    assert.equal(calls.length, 0)
    assert.equal(events[0].record.reason, reason)
  }
})

test('missing usage, unknown write price, invalid selections and abort never apply', async () => {
  for (const behavior of [{ noUsage: true }, { write: true }, { invalidResponse: true }, { cancel: new AbortController() }]) {
    const { handler, events } = setup({}, behavior)
    const exec = execution()
    if (behavior.cancel) exec.signal = behavior.cancel.signal
    const decision = { kind: 'accept' }
    assert.equal(await handler(exec, result(), async () => decision), decision)
    assert.notEqual(events[0].record.reason, 'selected')
    if (behavior.invalidResponse) assert.ok(events[0].record.estimatedCost > 0)
  }
})

test('cache hits reuse verified selection and origin usage without charging another model call', async () => {
  const { handler, calls, events, saves } = setup()
  const exec = execution()
  await handler(exec, result(), async () => ({ kind: 'accept' }))
  await handler(exec, result(), async () => ({ kind: 'accept' }))
  assert.equal(calls.length, 1)
  const reports = events.filter(item => item.event === 'free-context/experiment')
  assert.equal(reports[1].record.cacheHit, true)
  assert.equal(reports[1].record.estimatedCost, 0)
  assert.equal(reports[1].record.callUsage, undefined)
  assert.equal(JSON.parse(saves[3].content).originUsage.inputTokens, 100)
})

test('complete artifact references and archive budget are included before economic application', async () => {
  const { handler, events, calls, saves } = setup({ maxArtifactBytes: 1 })
  const decision = { kind: 'accept' }
  assert.equal(await handler(execution(), result(), async () => decision), decision)
  assert.equal(events[0].record.reason, 'manifest-byte-budget')
  assert.equal(calls.length, 0)
  assert.equal(saves.length, 0)
})


test('cached selections cannot bypass missing originating cache-write prices', async () => {
  const { handler, calls, events } = setup({}, { write: true })
  const exec = execution()
  const decision = { kind: 'accept' }
  assert.equal(await handler(exec, result(), async () => decision), decision)
  assert.equal(await handler(exec, result(), async () => decision), decision)
  assert.equal(calls.length, 1)
  assert.equal(events.filter(item => item.event === 'free-context/experiment').at(-1).record.reason, 'missing-priced-usage')
})


test('future main-request cache price is required and independent from auxiliary cache pricing', async () => {
  for (const override of [{ futureCacheReadPerMillion: undefined }, { futureCacheReadPerMillion: 0 }]) {
    const { handler, calls, events } = setup(override)
    const decision = { kind: 'accept' }
    assert.equal(await handler(execution(), result(), async () => decision), decision)
    assert.equal(calls.length, 0)
    assert.equal(events[0].record.reason, override.futureCacheReadPerMillion === undefined ? 'missing-economic-assumptions' : 'no-predicted-benefit-before-call')
  }
  const { handler, events } = setup({ futureCacheReadPerMillion: 1, pricing: { currency: 'USD', uncachedInputPerMillion: 1, cacheReadPerMillion: 0, outputPerMillion: 1 } })
  await handler(execution(), result(), async () => ({ kind: 'accept' }))
  assert.equal(events[0].record.reason, 'selected')
  assert.equal(events[0].record.estimatedCost, 0.00011)
})

test('explicit query service supports A/B/A without plugin restart and never infers task from tool arguments', async () => {
  let currentTask = 'Question Alpha'
  const queryProvider = { getQuery: meta => {
    assert.equal('arguments' in meta, false)
    return currentTask
  } }
  const { handler, calls, events, saves } = setup({ selectionMode: 'query-dependent', maxQueryBytes: 100 }, {
    queryProvider, responseFor: request => JSON.stringify({ selectedIds: [JSON.parse(request.messages[0].content[0].text.split('\n').at(-1)).currentTask === 'Question Alpha' ? 'p1' : 'p2'] }),
  })
  const exec = execution()
  exec.arguments = { query: 'Wrong inferred question' }
  const alpha = await handler(exec, result(), async () => ({ kind: 'accept' }))
  currentTask = 'Question Beta'
  const beta = await handler(exec, result(), async () => ({ kind: 'accept' }))
  currentTask = 'Question Alpha'
  await handler(exec, result(), async () => ({ kind: 'accept' }))
  assert.ok(alpha.content[0].text.includes('Source paragraph p1;'))
  assert.ok(beta.content[0].text.includes('Source paragraph p2;'))
  assert.equal(calls.length, 2)
  const reports = events.filter(item => item.event === 'free-context/experiment')
  assert.notEqual(reports[0].record.queryHash, reports[1].record.queryHash)
  assert.equal(reports[2].record.cacheHit, true)
  assert.equal(JSON.stringify(reports).includes('Question Alpha'), false)
  assert.notEqual(JSON.parse(saves[1].content).queryHash, JSON.parse(saves[3].content).queryHash)
})

test('missing/oversized/async queries prevent calls; changes during selection discard the stale candidate', async () => {
  for (const queryProvider of [undefined, { getQuery: () => '' }, { getQuery: () => 'x'.repeat(101) }, { getQuery: async () => { throw new Error('private') } }]) {
    const { handler, calls, saves } = setup({ selectionMode: 'query-dependent', maxQueryBytes: 100 }, { queryProvider })
    const decision = { kind: 'accept' }
    assert.equal(await handler(execution(), result(), async () => decision), decision)
    assert.equal(calls.length, 0)
    assert.equal(saves.length, 0)
  }
  let task = 'Question Alpha'
  const { handler, events } = setup({ selectionMode: 'query-dependent', maxQueryBytes: 100 }, { queryProvider: { getQuery: () => task }, onRequest: () => { task = 'Question Beta' } })
  const decision = { kind: 'accept' }
  assert.equal(await handler(execution(), result(), async () => decision), decision)
  assert.equal(events[0].record.reason, 'query-changed')
  assert.ok(events[0].record.estimatedCost > 0)
})

test('query changes or service replacement during either awaited diagnostic cannot adopt a stale candidate', async () => {
  for (const eventName of ['free-context/experiment', 'free-context/decision']) {
    for (const replacement of [false, true]) {
      let task = 'Question Alpha'
      const behavior = { queryProvider: { getQuery: () => task }, onReport: async event => {
        if (event !== eventName) return
        await Promise.resolve()
        if (replacement) behavior.queryProvider = { getQuery: () => 'Question Alpha' }
        else task = 'Question Beta'
      } }
      const { handler, calls } = setup({ selectionMode: 'query-dependent', maxQueryBytes: 100 }, behavior)
      const decision = { kind: 'accept' }
      assert.equal(await handler(execution(), result(), async () => decision), decision)
      assert.equal(calls.length, 1)
    }
  }
})

test('deterministic preparation rejects structured input before storage and prices actual prompt bytes', async () => {
  const { handler, calls, saves } = setup()
  const decision = { kind: 'accept' }
  assert.equal(await handler(execution(), { content: [{ type: 'text', text: '[' + text + ']' }] }, async () => decision), decision)
  assert.equal(calls.length, 0)
  assert.equal(saves.length, 0)
  const admitted = setup({ maxPromptBytes: 10000000, maxCallCost: 0.1 })
  await admitted.handler(execution(), result(), async () => decision)
  assert.equal(admitted.calls.length, 1)
  const report = admitted.events.find(item => item.event === 'free-context/experiment').record
  assert.equal(report.callCostUpperEstimate, (Buffer.byteLength(JSON.stringify(admitted.calls[0].messages)) + 100) / 1e6)
})

test('simultaneous experiment consumers attribute one paid call and keep originating usage', async () => {
  const { handler, calls, events, saves } = setup()
  const exec = execution()
  const outcomes = await Promise.all([handler(exec, result(), async () => ({ kind: 'accept' })), handler({ ...exec, callId: 'call-2' }, result(), async () => ({ kind: 'accept' }))])
  assert.ok(outcomes.every(outcome => outcome.content))
  assert.equal(calls.length, 1)
  const reports = events.filter(item => item.event === 'free-context/experiment').map(item => item.record)
  assert.equal(reports.filter(report => report.callUsage).length, 1)
  assert.equal(reports.filter(report => report.estimatedCost === 0).length, 1)
  const manifests = saves.filter(save => save.content.startsWith('{"version":1')).map(save => JSON.parse(save.content))
  assert.ok(manifests.every(manifest => manifest.originUsage.inputTokens === 100))
})

test('explicit native comparator cap bounds both admission and realized savings', async () => {
  const capped = setup({ comparatorTokenCap: 1200, minimumFutureRequests: 100 })
  const output = await capped.handler(execution(), result(), async () => ({ kind: 'accept' }))
  assert.equal(output.content, undefined)
  assert.equal(capped.calls.length, 0)
  assert.equal(capped.events.find(event => event.event === 'free-context/experiment').record.reason, 'no-predicted-benefit-before-call')
  assert.equal(parseExperimentConfig(settings({ comparatorTokenCap: 0 })).comparatorTokenCap, 0)
  for (const comparatorTokenCap of [-1, 1.5, Infinity]) assert.throws(() => parseExperimentConfig(settings({ comparatorTokenCap })))
})
test('completed cache evidence removes fresh-call admission fee without another model call', async () => {
  const f = setup()
  const exec = execution()
  await f.handler(exec, result(), async () => ({ kind: 'accept' }))
  await f.handler({ ...exec, callId: 'call-2' }, result(), async () => ({ kind: 'accept' }))
  const records = f.events.filter(event => event.event === 'free-context/experiment').map(event => event.record)
  assert.ok(records[0].callCostUpperEstimate > 0)
  assert.equal(records[1].cacheHit, true)
  assert.equal(records[1].callCostUpperEstimate, 0)
  assert.equal(records[1].estimatedCost, 0)
  assert.equal(f.calls.length, 1)
})

test('a candidate cannot claim savings when native cap makes baseline and candidate equally small', async () => {
  // Large synthetic horizon permits preflight only; the post-call comparator
  // must still reject zero incremental savings at the declared one-token cap.
  const f = setup({ comparatorTokenCap: 1, minimumFutureRequests: 1000000 })
  const output = await f.handler(execution(), result(), async () => ({ kind: 'accept' }))
  assert.equal(f.calls.length, 1)
  assert.equal(output.content, undefined)
  assert.equal(f.events.find(event => event.event === 'free-context/experiment').record.reason, 'insufficient-net-benefit')
})
test('eviction while archiving a captured cache hit cannot turn it into a new paid call', async () => {
  let evict = false
  let busy = false
  const exec = execution()
  const f = setup({ maxCacheEntries: 1 }, { async onSave() {
    if (!evict || busy) return
    busy = true
    const other = result()
    other.content[0].text += '\n\nDifferent content creates another selection cache entry.'
    await f.handler({ ...exec, callId: 'other-source' }, other, async () => ({ kind: 'accept' }))
  } })
  await f.handler(exec, result(), async () => ({ kind: 'accept' }))
  evict = true
  const output = await f.handler({ ...exec, callId: 'captured-original' }, result(), async () => ({ kind: 'accept' }))
  assert.ok(output.content[0].text.includes('LOSSY'))
  const record = f.events.find(event => event.event === 'free-context/experiment' && event.record.callId === 'captured-original').record
  assert.equal(record.cacheHit, true)
  assert.equal(record.llmCalled, false)
  assert.equal(record.estimatedCost, 0)
  assert.equal(f.calls.length, 2)
})

const trialSettings = overrides => ({ admission: 'measured-trial', maxCalls: 2, maxTotalCost: 1,
  minimumFutureRequests: undefined, futureCacheReadPerMillion: undefined, expectedRecoveryCost: undefined, safetyMargin: undefined,
  pricing: { currency: 'USD', uncachedInputPerMillion: 1, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1, outputPerMillion: 1 }, ...overrides })
const reports = f => f.events.filter(event => event.event === 'free-context/experiment').map(event => event.record)

test('measured trial is explicit, requires finite USD limits and complete auxiliary prices', () => {
  assert.equal(parseExperimentConfig(settings()).admission, 'forecast')
  for (const bad of [{ admission: 'trial' }, { maxCalls: undefined }, { maxCalls: 0 }, { maxCalls: 1.5 },
    { maxTotalCost: undefined }, { maxTotalCost: Infinity }, { maxCallCost: undefined },
    { pricing: { currency: 'USD', uncachedInputPerMillion: 1, cacheReadPerMillion: 1, outputPerMillion: 1 } },
    { pricing: { currency: 'EUR', uncachedInputPerMillion: 1, cacheReadPerMillion: 1, cacheWritePerMillion: 1, outputPerMillion: 1 } }]) {
    assert.throws(() => parseExperimentConfig(settings(trialSettings(bad))))
  }
})

test('trial skips only profit forecasts, records N/A and permits completed cached evidence after call budget', async () => {
  const f = setup(trialSettings({ maxCalls: 1, comparatorTokenCap: 1 }))
  const exec = execution()
  assert.ok((await f.handler(exec, result(), async () => ({ kind: 'accept' }))).content)
  assert.ok((await f.handler(exec, result(), async () => ({ kind: 'accept' }))).content)
  assert.equal(f.calls.length, 1)
  assert.equal(reports(f)[0].admission, 'measured-trial')
  assert.equal(reports(f)[0].predictedSavings, null)
  assert.equal(reports(f)[1].trialBudget.calls, 1)
  assert.equal(JSON.parse(f.saves[1].content).admission, 'measured-trial')
  const changed = result(); changed.content[0].text += '\n\nDifferent evidence.'
  await f.handler(exec, changed, async () => ({ kind: 'accept' }))
  assert.equal(reports(f).at(-1).reason, 'trial-call-budget')
  assert.equal(f.calls.length, 1)
})

test('trial reserves finite money and calls atomically across concurrent different requests', async () => {
  for (const limits of [{ maxCalls: 1 }, { maxTotalCost: 0.03 }]) {
    let release
    const blocked = new Promise(resolve => { release = resolve })
    let started
    const ready = new Promise(resolve => { started = resolve })
    const f = setup(trialSettings(limits), { async onRequest() { started(); await blocked } })
    const exec = execution()
    const first = f.handler(exec, result(), async () => ({ kind: 'accept' }))
    await ready
    const changed = result(); changed.content[0].text += '\n\nDifferent evidence.'
    await f.handler({ ...exec, callId: 'concurrent' }, changed, async () => ({ kind: 'accept' }))
    assert.equal(f.calls.length, 1)
    assert.match(reports(f).at(-1).reason, /^trial-(call|cost)-budget$/)
    release(); await first
  }
})

test('unknown fees, cancellation and actual overshoot retain reservation or charge and seal fresh trial calls', async () => {
  for (const behavior of [{ noUsage: true }, { cancel: new AbortController() }, { invalidResponse: true }, { usage: { inputTokens: 2000000 } }]) {
    const f = setup(trialSettings(), behavior)
    const exec = execution()
    if (behavior.cancel) exec.signal = behavior.cancel.signal
    await f.handler(exec, result(), async () => ({ kind: 'accept' }))
    const first = reports(f)[0]
    assert.equal(first.trialBudget.sealed, true)
    assert.equal(first.trialBudget.calls, 1)
    assert.ok(first.trialBudget.committedCost > 0)
    const changed = result(); changed.content[0].text += '\n\nDifferent evidence.'
    await f.handler({ ...exec, signal: new AbortController().signal }, changed, async () => ({ kind: 'accept' }))
    assert.equal(f.calls.length, 1)
    assert.equal(reports(f).at(-1).reason, 'trial-budget-sealed')
  }
})

test('trial budget requires session identity, is isolated, and does not charge archive failure or pre-abort', async () => {
  const f = setup(trialSettings({ maxCalls: 1 }))
  await f.handler({ ...execution(), agent: undefined }, result(), async () => ({ kind: 'accept' }))
  assert.equal(f.calls.length, 0)
  assert.equal(reports(f).at(-1).reason, 'trial-session-required')
  await f.handler(execution(), result(), async () => ({ kind: 'accept' }))
  await f.handler(execution(), result(), async () => ({ kind: 'accept' }))
  assert.equal(f.calls.length, 2)
  const behavior = { storageFailure: true }
  const failed = setup(trialSettings({ maxCalls: 1 }), behavior)
  const exec = execution()
  await failed.handler(exec, result(), async () => ({ kind: 'accept' }))
  behavior.storageFailure = false
  assert.ok((await failed.handler(exec, result(), async () => ({ kind: 'accept' }))).content)
  assert.equal(failed.calls.length, 1)
})

test('trial shares one paid call, refunds duplicate reservation and keeps unknown fees sealed after cache reuse', async () => {
  const f = setup(trialSettings())
  const exec = execution()
  const outcomes = await Promise.all([f.handler(exec, result(), async () => ({ kind: 'accept' })), f.handler({ ...exec, callId: 'shared' }, result(), async () => ({ kind: 'accept' }))])
  assert.ok(outcomes.every(outcome => outcome.content))
  assert.equal(f.calls.length, 1)
  await f.handler(exec, result(), async () => ({ kind: 'accept' }))
  assert.equal(reports(f).at(-1).trialBudget.calls, 1)
  assert.ok(Math.abs(reports(f).at(-1).trialBudget.committedCost - 0.000115) < 1e-12)

  const unknown = setup(trialSettings(), { noUsage: true })
  await unknown.handler(exec, result(), async () => ({ kind: 'accept' }))
  assert.equal((await unknown.handler(exec, result(), async () => ({ kind: 'accept' }))).content, undefined)
  assert.equal(reports(unknown).at(-1).reason, 'missing-priced-usage')
  assert.equal(reports(unknown).at(-1).trialBudget.sealed, true)
  assert.equal(unknown.calls.length, 1)
})

test('trial refunds pre-call abort during archive and preserves size and protected-evidence gates', async () => {
  const controller = new AbortController()
  const f = setup(trialSettings({ maxCalls: 1 }), { onSave() { controller.abort() } })
  const exec = execution()
  await f.handler({ ...exec, signal: controller.signal }, result(), async () => ({ kind: 'accept' }))
  assert.equal(f.calls.length, 0)
  assert.equal(reports(f)[0].trialBudget.calls, 0)
  assert.ok((await f.handler(exec, result(), async () => ({ kind: 'accept' }))).content)
  for (const [override, expected] of [[{ minSavingsTokens: 100000 }, 'insufficient-size-savings'], [{ protectedTerms: ['Paragraph 2'] }, 'protected-paragraph-omitted']]) {
    const guarded = setup(trialSettings(override))
    assert.equal((await guarded.handler(execution(), result(), async () => ({ kind: 'accept' }))).content, undefined)
    assert.equal(reports(guarded)[0].reason, expected)
  }
})

test('compiler coverage is source-bound, rendered with lossy guidance, archived and subject to existing gates', async () => {
  const diagnosticText = ['INFO: ' + 'ordinary build progress '.repeat(500), 'src/main.ts:1:2: error TS2322: bad', 'Status: failed\nexit code: 1'].join('\n\n')
  const original = { isError: false, content: [{ type: 'text', text: diagnosticText }], value: { unchanged: true } }
  const behavior = { responseFor: () => '{"selectedIds":["d2","d3"]}' }
  const f = setup({ selectionMode: 'diagnostic-evidence' }, behavior)
  const output = await f.handler(execution(), original, async () => ({ kind: 'accept' }))
  assert.match(output.content[0].text, /Compiler header coverage \(supported grammar only, not semantic completeness\)/)
  assert.match(output.content[0].text, /LOSSY/)
  assert.match(output.content[0].text, /recover the original for missing evidence, completeness checks/)
  const coverage = JSON.parse(f.saves[1].content).coverage
  assert.equal(coverage.stage, 'validated-selection-before-downstream-retention')
  assert.match(output.content[0].text, /NOT final inline coverage/)
  assert.match(output.content[0].text, /recover the full spilled tool output/)
  assert.deepEqual(coverage.scanned, { compilerHeaders: 1, statusBlocks: 1 })
  assert.deepEqual(coverage.retained, coverage.scanned)
  assert.equal(coverage.sourceHash, JSON.parse(f.saves[1].content).sourceHash)
  for (const overrides of [{ protectedTerms: ['ordinary'] }, { comparatorTokenCap: 1, minimumFutureRequests: 1000000 }, { minSavingsTokens: 100000 }]) {
    const guarded = setup({ selectionMode: 'diagnostic-evidence', ...overrides }, behavior)
    const declined = await guarded.handler(execution(), original, async () => ({ kind: 'accept' }))
    assert.equal(declined.content, undefined)
  }
})
test('generic diagnostics never render compiler coverage', async () => {
  const f = setup({ selectionMode: 'diagnostic-evidence' }, { responseFor: () => '{"selectedIds":["d2"]}' })
  const original = { isError: false, content: [{ type: 'text', text: 'INFO: ' + 'ordinary progress '.repeat(500) + '\n\nERROR: generic failure' }] }
  const output = await f.handler(execution(), original, async () => ({ kind: 'accept' }))
  assert.ok(output.content)
  assert.equal(output.content[0].text.includes('Compiler header coverage'), false)
  assert.equal(JSON.parse(f.saves[1].content).coverage, undefined)
})

test('only audit reference omits duplicate prose while both receipts and recovery IDs remain intact', async () => {
  const f = setup()
  const output = await f.handler(execution(), result(), async () => ({ kind: 'accept' }))
  const text = output.content[0].text
  const refs = text.split('\n').filter(line => line.startsWith('Original tool-result snapshot: ')).map(line => JSON.parse(line.slice('Original tool-result snapshot: '.length)))
  assert.equal(refs.length, 2)
  for (const [index, receipt] of refs.entries()) {
    assert.equal(receipt.sessionId, 'session-1')
    assert.equal(receipt.callId, 'call-1')
    assert.equal(receipt.toolName, 'read')
    assert.equal(receipt.locator, `spill://fixture/${index + 1}`)
    assert.equal(receipt.bytes, Buffer.byteLength(f.saves[index].content))
    assert.equal(receipt.retrievalHint, 'Use exact snapshot.')
  }
  assert.ok(text.includes(formatSnapshotReference(refs[0])))
  assert.ok(text.endsWith(formatSnapshotReference(refs[1], { includeGuidance: false })))
  assert.equal(text.split('For full recovery, verify').length - 1, 1)
  const compact = formatSnapshotReference(refs[1], { includeGuidance: false })
  const full = formatSnapshotReference(refs[1])
  assert.ok(Buffer.byteLength(full) - Buffer.byteLength(compact) > 400)
  assert.equal(JSON.parse(f.saves[1].content).originalReceipt.sha256, refs[0].sha256)
})

test('selection diagnostics identify exact selected IDs without logging source text', async () => {
  const { createHash } = await import('node:crypto')
  const { handler, events } = setup()
  await handler(execution(), result(), async () => ({ kind: 'accept' }))
  const record = events.find(event => event.event === 'free-context/experiment').record
  assert.deepEqual(record.selectedIds, ['p1'])
  assert.equal(record.sourceHash, createHash('sha256').update(text).digest('hex'))
  assert.equal(Object.isFrozen(record.selectedIds), true)
  assert.equal(JSON.stringify(record).includes(text.split('\n\n')[0]), false)
  const declined = setup({}, { invalidResponse: true })
  await declined.handler(execution(), result(), async () => ({ kind: 'accept' }))
  assert.equal(declined.events.find(event => event.event === 'free-context/experiment').record.selectedIds, undefined)
})
