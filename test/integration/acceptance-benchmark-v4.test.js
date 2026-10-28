import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../../scripts/acceptance-benchmark-cli.js'
import { summarizeAcceptanceV4 } from '../../scripts/acceptance-benchmark-v4.js'

test('v4 CLI runs all 117 official AgentLoop tasks with frozen contracts and durable journals', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-acceptance-v4-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const output = join(directory, 'report.json')
  assert.equal(await main(['--version', '4', '--output', output]), true)
  const report = JSON.parse(await readFile(output, 'utf8'))
  const pinned = JSON.parse(await readFile(`${output}.plan.json`, 'utf8'))
  const journal = (await readFile(`${output}.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(report.evaluationKind, 'acceptance-v4-scripted-replay')
  assert.equal(report.plan.version, 4)
  assert.deepEqual(pinned.plan, report.plan)
  assert.deepEqual(pinned.provenance, report.provenance)
  assert.equal(report.results.length, 117)
  assert.equal(journal.length, 117)
  assert.deepEqual(journal, report.results)
  assert.equal(report.stoppedReason, null)
  assert.equal(report.replayComplete, true)
  assert.equal(report.qualityComplete, true)
  assert.equal(report.configurationComplete, true)
  assert.equal(report.lifecycleComplete, true)
  assert.equal(report.fallbackComplete, true)
  assert.equal(report.costComplete, false)
  assert.equal(report.accepted, false)
  assert.equal(report.totalCostUSD, null)
  assert.equal(report.netSavingsVsTunedUSD, null)
  assert.ok(report.results.every(row => row.responseSchemaSatisfied && row.usageComplete))
  assert.equal(summarizeAcceptanceV4(report.plan, journal, { replay: true, provenance: report.provenance }).replayComplete, true)
})
