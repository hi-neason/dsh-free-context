import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

const exec = promisify(execFile)
const runtime = resolve(process.env.DSH_CLI_RUNTIME_ROOT ?? '.omx/cli-runtime')
const bin = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const plugin = fileURLToPath(new URL('../../src/index.js', import.meta.url))
const fixture = fileURLToPath(new URL('../fixtures/cli-provider.js', import.meta.url))
const jsonLines = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

test('official CLI loads plugin, preserves tool value, resumes persisted history and exits with policy off', { timeout: 120000 }, async t => {
  assert.equal(JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'))).version, '0.2.1-rc.2')
  const directory = await mkdtemp(join(tmpdir(), 'free-context-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  const profile = join(home, 'profiles/headless')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } } }))
  const patch = join(directory, 'acceptance.patch.yml')
  const patchText = [
    '- id: agent-default-model', '  config:', '    provider: cli-local', '    model: deterministic',
    '- id: session-title-llm', '  disabled: true',
    '- id: llm-deepseek', '  disabled: true',
    '- id: llm-deepseek-account', '  disabled: true',
    '- id: llm-pi-ai', '  disabled: true',
    '- insert:', '    - id: cli-provider', `      name: ${JSON.stringify(fixture)}`,
    '    - id: free-context', `      name: ${JSON.stringify(plugin)}`, '      config:',
    '        mode: apply', '        tools: [cli_fixture]', '        minInputBytes: 0', '',
  ].join('\n')
  await writeFile(patch, patchText)
  const evidence = join(directory, 'evidence.jsonl')
  const env = { PATH: process.env.PATH, HOME: directory, DSH_HOME: home, DSH_AGENTS_HOME: join(directory, 'agents'), DSH_TELEMETRY_DISABLED: '1', DSH_CLI_RUNTIME_PACKAGE: join(runtime, 'package.json'), DSH_CLI_EVIDENCE: evidence }
  async function run(args = [], mode = 'apply') {
    const result = await exec(process.execPath, [bin, '--profile', 'headless', '--patch', patch, '--json', ...args, 'Inspect the fixed dataset'], { cwd: directory, env: { ...env, DSH_CLI_EXPECT_MODE: mode }, timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 })
    const events = jsonLines(result.stdout)
    assert.equal(events.at(-1).type, 'final', result.stderr)
    assert.equal(events.at(-1).text, 'CLI_ACCEPTANCE_OK')
    return events
  }
  const first = await run()
  const session = first.find(event => event.type === 'session')
  assert.equal(typeof session?.sessionId, 'string')
  const initialEvidence = jsonLines(await readFile(evidence, 'utf8'))
  assert.equal(initialEvidence.filter(event => event.type === 'tool').length, 1)
  assert.equal(initialEvidence.find(event => event.type === 'decision').event.outcome, 'selected')
  const second = await run(['--session-id', session.sessionId])
  assert.equal(second.find(event => event.type === 'session').sessionId, session.sessionId)
  const resumedEvidence = jsonLines(await readFile(evidence, 'utf8')).slice(initialEvidence.length)
  assert.equal(resumedEvidence.filter(event => event.type === 'tool').length, 0, 'resume must reuse the persisted tool result')
  assert.ok(resumedEvidence.find(event => event.type === 'request').messages.some(message => message.role === 'tool'))
  // Restart with the policy explicitly disabled and exercise a new actual tool call.
  await writeFile(patch, patchText.replace('mode: apply', 'mode: off'))
  const beforeOff = initialEvidence.length + resumedEvidence.length
  await run([], 'off')
  const offEvidence = jsonLines(await readFile(evidence, 'utf8')).slice(beforeOff)
  assert.equal(offEvidence.filter(event => event.type === 'tool').length, 1)
  assert.equal(offEvidence.filter(event => event.type === 'decision').length, 0)
  const offTool = offEvidence.find(event => event.type === 'tool')
  assert.deepEqual(offTool.content, offTool.value)
})
