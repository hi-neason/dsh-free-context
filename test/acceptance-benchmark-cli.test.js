import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, acceptanceSourceHash } from '../scripts/acceptance-benchmark-cli.js'

test('acceptance CLI rejects ambiguous routing and missing live credentials before I/O', async () => {
  for (const args of [['--live'], ['--live', '--live'], ['--credential-file'], ['--unknown'], ['--seed', '1', '--seed', '2'], ['--version', '4']]) {
    await assert.rejects(main(args), TypeError)
  }
})

test('source provenance includes actual file bytes and names, excluding runtime artifacts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['src', 'scripts', 'test', '.omx']) await mkdir(join(root, name))
  await writeFile(join(root, 'package.json'), '{}')
  await writeFile(join(root, 'src/index.js'), 'export const value = 1\n')
  const before = await acceptanceSourceHash(root)
  await writeFile(join(root, '.omx/private.json'), '{"ignored":true}')
  assert.equal(await acceptanceSourceHash(root), before)
  await writeFile(join(root, 'src/index.js'), 'export const value = 2\n')
  assert.notEqual(await acceptanceSourceHash(root), before)
})

test('existing output refuses live execution before credential or provider work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'acceptance-output-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const output = join(directory, 'existing.json')
  await writeFile(output, '{"preserve":true}')
  for (const version of ['1', '2', '3']) await assert.rejects(main(['--version', version, '--live', '--credential-file', join(directory, 'missing-key'), '--pricing-file', join(directory, 'missing-prices'), '--output', output]), error => error.code === 'EEXIST')
})
