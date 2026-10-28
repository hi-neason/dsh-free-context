import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDevelopmentFixtures, loadDevelopmentFixture, materializeDevelopmentFixture, verifyDevelopmentWorkspace } from '../scripts/development-fixtures.js'

const id = 'json-output-limit'
async function workspace(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-history-fixture-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const { directory, fixture } = await materializeDevelopmentFixture(id, join(base, 'work'))
  return { base, directory, fixture }
}

test('captured genuine regression fails old source and passes its historical repair with all tests unchanged', { skip: process.platform === 'win32' }, async t => {
  assert.deepEqual(listDevelopmentFixtures(), [id])
  const { directory, fixture } = await workspace(t)
  assert.equal(fixture.manifest.oldCommit, '916fe21d7a2e6568f61fd417e6b3b39eb2c89529')
  assert.equal(Object.keys(fixture.files).some(path => path.includes('control')), false)
  const baseline = await verifyDevelopmentWorkspace(id, directory)
  assert.equal(baseline.passed, false)
  assert.equal(baseline.sourceChanged, false)
  assert.equal(baseline.testRun.tests, 9)
  assert.equal(baseline.testRun.passedTests, 8)
  const control = await readFile(new URL('./fixtures/development/json-output-limit/control/json-codec.js', import.meta.url))
  await writeFile(join(directory, 'src/json-codec.js'), control)
  const fixed = await verifyDevelopmentWorkspace(id, directory)
  assert.equal(fixed.passed, true)
  assert.equal(fixed.protectedFilesIntact, true)
  assert.equal(fixed.testRun.passedTests, 9)
})

test('a fabricated successful suite or changed package cannot replace the protected historical tests', { skip: process.platform === 'win32' }, async t => {
  const { directory, fixture } = await workspace(t)
  await writeFile(join(directory, 'test/json-codec.test.js'), "console.log('# tests 9\\n# pass 9\\n# fail 0')\n")
  assert.deepEqual(await verifyDevelopmentWorkspace(id, directory), { passed: false, reason: 'protected-files-changed' })
  await writeFile(join(directory, 'test/json-codec.test.js'), fixture.files['test/json-codec.test.js'])
  await writeFile(join(directory, 'package.json'), '{}')
  assert.equal((await verifyDevelopmentWorkspace(id, directory)).reason, 'protected-files-changed')
})

test('fixture creation cannot overwrite an existing directory and verification rejects symlinks or extra files', { skip: process.platform === 'win32' }, async t => {
  const { base, directory } = await workspace(t)
  await assert.rejects(materializeDevelopmentFixture(id, directory), error => error.code === 'EEXIST')
  await writeFile(join(directory, 'extra.js'), 'export {}')
  assert.equal((await verifyDevelopmentWorkspace(id, directory)).passed, false)
  await rm(join(directory, 'extra.js'))
  await rm(join(directory, 'src/json-codec.js'))
  await symlink(join(base, 'outside.js'), join(directory, 'src/json-codec.js'))
  assert.equal((await verifyDevelopmentWorkspace(id, directory)).reason, 'invalid-workspace')
  await assert.rejects(loadDevelopmentFixture('other'), TypeError)
})

test('a timed-out test worker cannot mutate files after verification returns', { skip: process.platform === 'win32' }, async t => {
  const { base, directory, fixture } = await workspace(t)
  const marker = join(base, 'late-marker')
  await writeFile(join(directory, 'src/json-codec.js'), fixture.files['src/json-codec.js'] + `\nawait new Promise(resolve => setTimeout(resolve, 700));\nawait (await import('node:fs/promises')).writeFile(${JSON.stringify(marker)}, 'late');\n`)
  const result = await verifyDevelopmentWorkspace(id, directory, { timeoutMs: 200 })
  assert.equal(result.passed, false)
  assert.equal(result.testRun?.timedOut, true)
  await new Promise(resolve => setTimeout(resolve, 900))
  await assert.rejects(readFile(marker), error => error.code === 'ENOENT')
})

test('output-limit termination also removes the owned test workers', { skip: process.platform === 'win32' }, async t => {
  const { base, directory, fixture } = await workspace(t)
  const marker = join(base, 'late-output-marker')
  await writeFile(join(directory, 'src/json-codec.js'), fixture.files['src/json-codec.js'] + `\nconsole.log('x'.repeat(600000));\nawait new Promise(resolve => setTimeout(resolve, 700));\nawait (await import('node:fs/promises')).writeFile(${JSON.stringify(marker)}, 'late');\n`)
  const result = await verifyDevelopmentWorkspace(id, directory, { timeoutMs: 2000 })
  assert.equal(result.passed, false)
  assert.equal(result.testRun?.stopReason, 'output-limit')
  await new Promise(resolve => setTimeout(resolve, 900))
  await assert.rejects(readFile(marker), error => error.code === 'ENOENT')
})
