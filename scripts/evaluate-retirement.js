import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { agentCompletion, agentFixtures, groups, runAgentFixture, evaluationConsoleReplacer } from './evaluate-agent.js'
import { retirementEvidenceHash } from './calibrate-retirement.js'

// Declared before execution, deliberately testable against actual remaining requests.
export const retirementAssumptions = Object.freeze({ enabled: true, tools: ['fixture'], retainRecentResults: 0,
  minAgeSteps: 1, minModelUses: 1, minStepsBetweenRetirements: 1,
  minimumFutureRequests: 200, pricing: { uncachedInputPerMillion: .3, cacheReadPerMillion: .006 },
  expectedRecoveryCost: 0, safetyMargin: .25 })

export async function evaluateRetirement(options = {}) {
  if (options.model !== undefined && options.model !== 'deepseek-flash') {
    throw new TypeError('This declared flash-peak stress scenario requires model deepseek-flash')
  }
  const fixture = (await agentFixtures()).find(item => item.kind === 'tap')
  fixture.query += ' After your first read, recheck the fixture result in history. If it now contains a retirement snapshot reference, you MUST read that snapshot before answering, even if an earlier read already gave the duration. Use a targeted read window when possible. Do not call fixture again. Your final answer MUST be the JSON object only: no recheck narrative, commentary or Markdown.'
  const tasks = []
  for (const group of groups) tasks.push(await runAgentFixture(fixture, group, { ...options, historyRetirement: retirementAssumptions }))
  const plugin = tasks.find(task => task.group === 'plugin')
  const activated = plugin.retirements.some(record => record.reason === 'retired')
  const completion = agentCompletion(tasks, options)
  const { answer, ...fixtureEvidence } = fixture
  return { evaluationKind: options.replay ? 'history-retirement-agent-replay' : 'history-retirement-live-agent',
    model: options.model ?? 'deepseek-flash', runId: options.runId ?? null, provenance: options.provenance ?? null,
    fixture: fixtureEvidence, fixtureHash: retirementEvidenceHash(fixtureEvidence), policyHash: retirementEvidenceHash(retirementAssumptions),
    scenario: 'optimistic-forecast-stress',
    rationale: 'The first declared 100-request horizon was rejected by the live economic gate. A declared 200-request stress horizon activates the rewrite to test recovery and accounting, not forecast accuracy or realistic savings.',
    assumptions: retirementAssumptions, assumptionPriceBasis: { model: 'deepseek-flash', currency: 'USD', ratePeriod: 'peak', verifiedDate: '2026-10-23', sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/' }, groupOrder: groups, ...completion,
    completed: completion.completed && activated && plugin.snapshotRecovered,
    activated, tasks,
    realizedCostDeltaUSD: Object.fromEntries(tasks.filter(task => task.group !== 'plugin').map(task => [task.group,
      plugin.estimatedCostUSD === null || task.estimatedCostUSD === null ? null : plugin.estimatedCostUSD - task.estimatedCostUSD])),
    limitations: ['One fixed task per group, fixed order and shared provider cache; not a causal estimate.',
      'Future 200 requests and zero recovery cost are declared prediction assumptions, not realized facts. Compare actualPostRetirementSteps and measured whole-task cost.',
      'This short task has far fewer actual remaining requests; the optimistic horizon and zero recovery assumption are unsuitable for predicting its realized benefit.',
      'Positive realizedCostDeltaUSD means the plugin cost more than that baseline. Preserve negative outcomes.'] }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    const get = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
    const file = get('--credential-file')
    const key = file ? (await readFile(file, 'utf8')).trim() : process.env.DEEPSEEK_API_KEY
    const prices = get('--pricing-file') ? JSON.parse(await readFile(get('--pricing-file'), 'utf8')) : undefined
    const report = await evaluateRetirement({ key, prices, replay: args.includes('--replay'), model: get('--model') })
    console.log(JSON.stringify(report, evaluationConsoleReplacer, 2))
    if (!report.completed) process.exitCode = 1
  } catch {
    console.error('Retirement evaluation failed; no credential or provider response body printed.')
    process.exitCode = 1
  }
}
