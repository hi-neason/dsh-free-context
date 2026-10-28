import assert from 'node:assert/strict'
import test from 'node:test'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
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
  assert.equal(fixed.byteBudgetValidation.version, 'json-output-utf8-v1')
  assert.equal(fixed.byteBudgetValidation.cases, 82)
  assert.equal(fixed.byteBudgetValidation.passedCases, 82)
  assert.equal(fixed.byteBudgetValidation.failedCases, 0)
  assert.equal(fixed.byteBudgetValidation.sourceHash, fixed.sourceHash)
  assert.match(fixed.byteBudgetValidation.validatorHash, /^[a-f0-9]{64}$/)
  assert.equal(Object.keys(fixture.files).some(path => path.includes('validation')), false)
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


test('external byte oracle rejects an undercounted control escape even when historical tests pass', { skip: process.platform === 'win32' }, async t => {
  const { directory } = await workspace(t)
  const control = await readFile(new URL('./fixtures/development/json-output-limit/control/json-codec.js', import.meta.url), 'utf8')
  // Simulate a hand-written counter that mistakes a six-byte escape for two.
  const faulty = control.replace('if (outputBytes > maxOutputBytes)', "if (outputBytes - (JSON.stringify(row).includes('\\\\u0001') ? 4 : 0) > maxOutputBytes)")
  assert.notEqual(faulty, control)
  await writeFile(join(directory, 'src/json-codec.js'), faulty)
  const result = await verifyDevelopmentWorkspace(id, directory)
  assert.equal(result.testRun.passedTests, 9)
  assert.equal(result.passed, false)
  assert.ok(result.byteBudgetValidation.failedCases > 0)
})

test('external byte validation rejects output noise, exceptions, mutations and unbounded execution', { skip: process.platform === 'win32' }, async t => {
  const control = await readFile(new URL('./fixtures/development/json-output-limit/control/json-codec.js', import.meta.url), 'utf8')
  const variants = [
    ['noise', "console.log('unexpected')"],
    ['exception', "throw new Error('candidate import failed')"],
    ['mutation', "await (await import('node:fs/promises')).appendFile(new URL('./json-codec.js', import.meta.url), '\\n// mutation')"],
    ['timeout', 'await new Promise(resolve => setTimeout(resolve, 5000))'],
    ['output-limit', "console.log('x'.repeat(20000))"],
  ]
  for (const [name, action] of variants) await t.test(name, async t => {
    const { directory } = await workspace(t)
    await writeFile(join(directory, 'src/json-codec.js'), control + `\nif (process.argv[1]?.endsWith('development-byte-budget-validation.js')) { ${action} }\n`)
    const result = await verifyDevelopmentWorkspace(id, directory, { timeoutMs: 1000 })
    assert.equal(result.passed, false)
    if (name === 'mutation') assert.equal(result.reason, 'workspace-changed-during-verification')
    else {
      assert.equal(result.testRun.passedTests, 9)
      assert.equal(result.byteBudgetValidation.passed, false)
      assert.equal(result.byteBudgetValidation.cleaned, true)
      if (name === 'timeout') assert.equal(result.byteBudgetValidation.stopReason, 'timeout')
      if (name === 'output-limit') assert.equal(result.byteBudgetValidation.stopReason, 'output-limit')
    }
  })
})


test('fixture validation identity binds the external validator without materializing it', async () => {
  const fixture = await loadDevelopmentFixture(id)
  const bytes = await readFile(new URL('../scripts/development-byte-budget-validation.js', import.meta.url))
  assert.deepEqual(fixture.byteBudgetValidation, {
    version: 'json-output-utf8-v1', cases: 82,
    validatorHash: createHash('sha256').update(bytes).digest('hex'),
  })
  assert.deepEqual(Object.keys(fixture.byteBudgetValidation), ['version', 'cases', 'validatorHash'])
  assert.deepEqual(Object.keys(fixture.files).sort(), ['LICENSE', 'package.json', 'src/json-codec.js', 'test/json-codec.test.js'])
})

test('historical test-stage validator mutation fails against its pre-execution identity', { skip: process.platform === 'win32' }, async t => {
  // Copy the harness and fixture into isolation; never mutate the repository validator.
  const base = await mkdtemp(join(tmpdir(), 'dsh-validator-identity-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  await mkdir(join(base, 'scripts'))
  await writeFile(join(base, 'package.json'), '{"type":"module"}')
  for (const name of ['development-fixtures.js', 'development-byte-budget-validation.js', 'evaluation-process.js']) {
    await cp(new URL(`../scripts/${name}`, import.meta.url), join(base, 'scripts', name))
  }
  await cp(new URL('./fixtures/development/json-output-limit/', import.meta.url), join(base, 'test/fixtures/development/json-output-limit'), { recursive: true })
  const isolated = await import(pathToFileURL(join(base, 'scripts/development-fixtures.js')).href)
  const { directory } = await isolated.materializeDevelopmentFixture(id, join(base, 'work'))
  const control = await readFile(new URL('./fixtures/development/json-output-limit/control/json-codec.js', import.meta.url), 'utf8')
  const validator = join(base, 'scripts/development-byte-budget-validation.js')
  await writeFile(join(directory, 'src/json-codec.js'), control + `\nif (!process.argv[1]?.endsWith('development-byte-budget-validation.js')) await (await import('node:fs/promises')).appendFile(${JSON.stringify(validator)}, '\\n// changed during historical tests');\n`)
  const result = await isolated.verifyDevelopmentWorkspace(id, directory)
  assert.equal(result.passed, false)
  assert.equal(result.reason, 'validator-changed-during-verification')
})
