import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { buildDevelopmentProfile } from '../../scripts/evaluate-development.js'
import { runEvaluationProcess } from '../../scripts/evaluation-process.js'

const runtimeRoot = resolve(process.env.DSH_CLI_RUNTIME_ROOT ?? '.omx/cli-runtime')
for (const [interruption, ignoreTerm] of [['timeout', false], ['output-limit', false], ['timeout', true], ['output-limit', true]]) {
  test(`actual CLI joins pending bash on ${interruption}, ignore TERM=${ignoreTerm}`, { skip: process.platform === 'win32', timeout: 45000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cli-shutdown-')), home = join(root, 'home')
    let pid
    t.after(async () => {
      if (pid) try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      await rm(root, { recursive: true, force: true })
    })
    await mkdir(join(home, 'profiles/headless'), { recursive: true })
    await writeFile(join(home, 'profiles/headless/package.json'), JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } } }))
    const started = join(root, 'started.json'), late = join(root, 'late')
    await writeFile(join(root, 'child.js'), `const fs=require('node:fs');${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ''}fs.writeFileSync('started.json',JSON.stringify({pid:process.pid,time:Date.now()}));setTimeout(()=>fs.writeFileSync('late','escaped'),12000)`)
    const config = { interruption, started, replay: true, model: 'scripted', plugin: false, tools: ['bash'], maxInlineTokens: 1200,
      workspace: root, sessions: join(home, 'sessions'), spill: join(root, 'spill'), ledger: join(root, 'ledger.jsonl'),
      replayProvider: fileURLToPath(new URL('../fixtures/development-shutdown-provider.js', import.meta.url)), maxSteps: 4, maxCalls: 4, maxCostUSD: 1,
      runtimePackage: join(runtimeRoot, 'package.json'), testCommands: [], manifestHash: 'synthetic-interruption' }
    const observer = join(root, 'observer.json'), patch = join(root, 'patch.yml')
    await writeFile(config.ledger, '')
    // Test-only longer tool budget: leave startup headroom while ensuring the
    // global deadline interrupts bash before its own timeout or delayed write.
    const testPatch = buildDevelopmentProfile(config).replace('    timeoutMs: 5000\n    maxTimeoutMs: 5000', '    timeoutMs: 15000\n    maxTimeoutMs: 15000')
    assert.notEqual(testPatch, buildDevelopmentProfile(config))
    await writeFile(observer, JSON.stringify(config)); await writeFile(patch, testPatch)
    const result = await runEvaluationProcess(process.execPath, [join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'headless', '--patch', patch, '--json', 'Run the synthetic bash tool.'], {
      cwd: root, timeoutMs: interruption === 'timeout' ? 7500 : 20000, shutdownGraceMs: 6000, maxOutputBytes: 64 * 1024,
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1', DSH_DEVELOPMENT_CONFIG: observer } })
    const marker = JSON.parse(await readFile(started, 'utf8')); pid = marker.pid
    assert.equal(result.stopReason, interruption)
    assert.equal(result.gracefulStop, true)
    assert.equal(result.escalated, false)
    assert.equal(result.cleaned, true)
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
    pid = null
    const events = (await readFile(config.ledger, 'utf8')).trim().split('\n').map(JSON.parse)
    const exits = events.filter(event => event.type === 'process/exit')
    assert.equal(exits.length, 1)
    assert.deepEqual(exits[0].activeTools, [])
    await delay(Math.max(0, marker.time + 12300 - Date.now()))
    await assert.rejects(access(late), error => error.code === 'ENOENT')
  })
}
