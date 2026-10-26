import { readFile, writeFile, appendFile, readdir, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluateAcceptance, acceptanceCriteria } from './acceptance-benchmark.js'
import { evaluateAcceptanceV2, acceptanceCriteriaV2 } from './acceptance-benchmark-v2.js'

/** Hash actual source/fixtures, including uncommitted changes, before any provider call. */
export async function acceptanceSourceHash(root) {
  const entries = []
  async function visit(directory) {
    for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
      const name = join(directory, item.name)
      if (item.isDirectory()) await visit(name)
      else if (item.isFile() && name.endsWith('.js')) entries.push(name)
    }
  }
  for (const directory of ['src', 'scripts', 'test']) await visit(directory)
  const hash = createHash('sha256')
  for (const file of [...entries, 'package.json'].sort()) {
    const bytes = await readFile(join(root, file))
    hash.update(`${file}\0${bytes.byteLength}\0`).update(bytes)
  }
  return hash.digest('hex')
}

export async function main(args = process.argv.slice(2)) {
  const valued = new Set(['--credential-file', '--pricing-file', '--output', '--seed', '--version'])
  const values = {}
  let live = false
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (key === '--live' && !live) { live = true; continue }
    if (!valued.has(key) || values[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw new TypeError('Invalid benchmark arguments')
    values[key] = args[++index]
  }
  const version = values['--version'] ?? '1'
  if (!['1', '2'].includes(version)) throw new TypeError('Benchmark version must be 1 or 2')
  const evaluate = version === '2' ? evaluateAcceptanceV2 : evaluateAcceptance
  const criteria = version === '2' ? acceptanceCriteriaV2 : acceptanceCriteria
  if (live && (!values['--credential-file'] || !values['--pricing-file'])) throw new TypeError('Live benchmark requires credential and pricing files')
  const root = fileURLToPath(new URL('..', import.meta.url))
  const output = resolve(values['--output'] ?? join(root, '.omx/acceptance/benchmark-replay.json'))
  const journal = `${output}.jsonl`
  await mkdir(dirname(output), { recursive: true })
  // Reserve the output before any credential/provider work; checking only at
  // final publication would waste a paid run when an output already exists.
  await writeFile(output, JSON.stringify({ status: 'running', startedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 })
  await writeFile(journal, '', { flag: 'wx', mode: 0o600 })
  const key = live ? (await readFile(resolve(values['--credential-file']), 'utf8')).trim() : undefined
  const pricing = live ? JSON.parse(await readFile(resolve(values['--pricing-file']), 'utf8')) : undefined
  const runtime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT ?? join(root, '.omx/integration-runtime'), 'package.json'))
  const runtimeVersion = JSON.parse(await readFile(runtime.resolve('@deepseek-ai/dsh-agent-loop-testkit/package.json'), 'utf8')).version
  const runtimeLockHash = createHash('sha256').update(await readFile(runtime.resolve('./package-lock.json'))).digest('hex')
  const provenance = { runtimeVersion, runtimeLockHash,
    repositoryCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceTreeHash: await acceptanceSourceHash(root), model: pricing?.model,
    cacheCondition: criteria.cacheCondition }
  const report = await evaluate({ replay: !live, key, pricing, provenance,
    ...(values['--seed'] !== undefined ? { seed: Number(values['--seed']) } : {}),
    onResult: async record => {
      await appendFile(journal, JSON.stringify(record) + '\n')
      console.log(`${record.runId}: ${record.passed ? 'quality-pass' : 'quality-fail'}; calls=${record.modelCalls?.length ?? 0}; usage=${record.usageComplete === true ? 'complete' : 'incomplete'}`)
    } })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'w', mode: 0o600 })
  console.log(JSON.stringify({ report: output, runs: report.results.length, qualityComplete: report.qualityComplete,
    costComplete: report.costComplete, experimentalCoverage: report.experimentalCoverage,
    netSavingsVsTunedUSD: report.netSavingsVsTunedUSD, accepted: report.accepted, coreAccepted: report.coreAccepted, fullAccepted: report.fullAccepted, replayComplete: report.replayComplete, stoppedReason: report.stoppedReason }))
  return live ? report.accepted : report.replayComplete
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { if (!await main()) process.exitCode = 1 }
  catch { console.error('Acceptance benchmark failed; credentials and provider error bodies are not printed.'); process.exitCode = 1 }
}
