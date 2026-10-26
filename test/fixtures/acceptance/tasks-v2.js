import { acceptanceFixtures } from './tasks.js'

const historyText = ['Revision: original. Checkpoint value: 73.625.', ...Array.from({ length: 35 }, (_, i) => `History background ${i}: ordinary deployment observations and explanatory prose are retained for later verification.`)].join('\n') + '\n'
const historyAnswer = text => ({ revision: 'original', checkpoint: Number(text.match(/Checkpoint value: ([\d.]+)\./)[1]) })
const retirementBase = { enabled: true, tools: ['fixture'], minInputBytes: 1024, retainRecentResults: 0, minAgeSteps: 1, minModelUses: 1, minStepsBetweenRetirements: 1,
  pricing: { uncachedInputPerMillion: .3, cacheReadPerMillion: .006 }, expectedRecoveryCost: 0, safetyMargin: .25 }

export function acceptanceFixturesV2() {
  const fixtures = acceptanceFixtures().map(task => ({ ...task, tier: task.experiment ? 'experimental' : 'core' }))
  const nested = fixtures.find(task => task.id === 'json-nested-precision')
  nested.query = 'Call fixture. Return ONLY the value of the top-level field named exact, NOT the surrounding object or items. Preserve all types and decimal/integer strings verbatim. Return only that JSON object without Markdown or commentary.'
  const previousTap = fixtures.find(task => task.id === 'experiment-diagnostic-evidence')
  previousTap.id = 'experiment-diagnostic-tap-fallback'
  previousTap.expectedFallback = 'unrecognized-diagnostic-block'
  previousTap.adoptionRequired = false
  previousTap.coverage = ['diagnostic-tap-fallback', 'followup-quality']
  const compilerText = [...Array.from({ length: 24 }, (_, i) => `INFO build stage ${i}: ${'Ordinary compilation progress for the current package. '.repeat(10)}`),
    'src/alpha.ts(17,4): error TS2322: string is not assignable to number\n  const count: number = label',
    'src/beta.ts:29:8: warning TS6133: unused variable cache',
    'Status: FAILED\nErrors: 1\nWarnings: 1\nexit code: 2'].join('\n\n')
  const compilerExpected = { diagnostics: [{ path: 'src/alpha.ts', line: 17, column: 4, severity: 'error', code: 'TS2322' }, { path: 'src/beta.ts', line: 29, column: 8, severity: 'warning', code: 'TS6133' }], exitCode: 2 }
  fixtures.push({ id: 'experiment-diagnostic-compiler', kind: 'acceptance', tier: 'experimental', experiment: 'diagnostic-evidence', coverage: ['experiment-diagnostic-evidence', 'compiler-errors', 'status-preservation'], text: compilerText,
    phases: [0, 1].map(() => ({ query: 'Call fixture. Report every error and warning in source order as {"diagnostics":[{"path":STRING,"line":NUMBER,"column":NUMBER,"severity":STRING,"code":STRING}],"exitCode":NUMBER}. Return only JSON without Markdown.', expected: compilerExpected })),
    answer: text => ({ diagnostics: [...text.matchAll(/(src\/\w+\.ts)(?:\((\d+),(\d+)\)|:(\d+):(\d+)): (error|warning) (TS\d+):/g)].map(m => ({ path: m[1], line: Number(m[2] ?? m[4]), column: Number(m[3] ?? m[5]), severity: m[6], code: m[7] })), exitCode: Number(text.match(/exit code: (\d+)/)[1]) }) })
  for (const stress of [false, true]) fixtures.push({ id: stress ? 'history-retirement-stress' : 'history-retirement-short', kind: 'acceptance', tier: stress ? 'quality-only' : 'core', historyRetirement: { ...retirementBase, minimumFutureRequests: stress ? 1000 : 2 },
    requireSnapshot: true, requireReadEachPhase: true, expectedRetirement: stress, text: historyText,
    coverage: stress ? ['history-retirement', 'post-retirement-snapshot-recovery', 'optimistic-forecast-stress-not-savings'] : ['history-economic-decline', 'short-horizon-two'],
    query: 'Call fixture exactly once, then read the original source. Before answering recheck the fixture result in history: if it now contains a retirement snapshot locator, you MUST read that exact snapshot using read before answering. Do not call fixture again and do not substitute the original path for a retirement snapshot. Report {"revision":STRING,"checkpoint":NUMBER} from source evidence. Return only JSON without Markdown.',
    expected: { revision: 'original', checkpoint: 73.625 }, answer: historyAnswer })
  return fixtures
}
