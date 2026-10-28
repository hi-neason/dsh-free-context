import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFilesystemReadClassifier } from '../src/read-source-classifier.js'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-source-classifier-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), artifact = join(source, 'artifacts'), other = join(root, 'source-other')
  for (const path of [source, artifact, other]) await mkdir(path, { recursive: true })
  const file = join(source, 'ordinary.txt'), snapshot = join(artifact, 'snapshot.txt'), outside = join(other, 'other.txt')
  for (const path of [file, snapshot, outside]) await writeFile(path, 'same arbitrary content')
  const config = { sourceRoots: [source], artifactRoots: [artifact], artifactInventoryComplete: true }
  return { root, source, artifact, other, file, snapshot, outside, config, classifier: createFilesystemReadClassifier(config) }
}

test('source classification requires an explicit complete host inventory and binds both paths', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.classifier.classify(f.file), { kind: 'source', reason: 'complete-host-inventory', inputPath: f.file, canonicalPath: f.file, complete: true })
  for (const config of [{}, { ...f.config, artifactInventoryComplete: false }, { ...f.config, artifactRoots: [] }]) {
    assert.equal((await createFilesystemReadClassifier(config).classify(f.file)).kind, 'unknown')
  }
  assert.equal((await createFilesystemReadClassifier({ ...f.config, sourceRoots: [] }).classify(f.file)).kind, 'unknown')
  assert.equal(Object.isFrozen(await f.classifier.classify(f.file)), true)
  assert.equal(Object.isFrozen(f.classifier), true)
})

test('artifact roots win overlapping source roots and content cannot grant source provenance', async t => {
  const f = await fixture(t)
  assert.equal((await f.classifier.classify(f.snapshot)).kind, 'artifact')
  assert.equal((await f.classifier.classify(f.outside)).kind, 'unknown')
  const same = createFilesystemReadClassifier({ ...f.config, artifactRoots: [f.source] })
  assert.equal((await same.classify(f.file)).kind, 'artifact')
})

test('relative and opaque references are unknown, never resolved against cwd or decoded', async t => {
  const f = await fixture(t)
  for (const path of [undefined, null, {}, '', 'ordinary.txt', 'spill:123', `file://${f.file}`, `${f.file}\0suffix`]) {
    const result = await f.classifier.classify(path)
    assert.equal(result.kind, 'unknown')
    assert.equal(result.canonicalPath, null)
  }
})

test('canonical containment rejects prefix collisions, traversal and symlink escapes', async t => {
  const f = await fixture(t)
  const escape = join(f.source, 'escape'), recovery = join(f.source, 'recovery'), local = join(f.source, 'local')
  await symlink(f.outside, escape)
  await symlink(f.snapshot, recovery)
  await symlink(f.file, local)
  assert.equal((await f.classifier.classify(escape)).kind, 'unknown')
  assert.equal((await f.classifier.classify(recovery)).kind, 'artifact')
  assert.equal((await f.classifier.classify(local)).kind, 'source')
  assert.equal((await f.classifier.classify(`${f.source}/../source-other/other.txt`)).kind, 'unknown')
  const artifactAlias = join(f.artifact, 'source-link')
  await symlink(f.file, artifactAlias)
  assert.equal((await f.classifier.classify(artifactAlias)).kind, 'artifact')
})

test('hard links, directories and missing files never establish source', async t => {
  const f = await fixture(t)
  await link(f.file, join(f.other, 'hard-link'))
  assert.equal((await f.classifier.classify(f.file)).reason, 'multiple-file-links')
  assert.equal((await f.classifier.classify(f.source)).reason, 'not-regular-file')
  assert.equal((await f.classifier.classify(join(f.source, 'missing'))).kind, 'unknown')
})

test('every root is checked each time and broken or non-directory roots fail closed', async t => {
  const f = await fixture(t)
  assert.equal((await f.classifier.classify(f.file)).kind, 'source')
  await rm(f.artifact, { recursive: true })
  assert.equal((await f.classifier.classify(f.file)).kind, 'unknown')
  await writeFile(f.artifact, 'not a directory')
  assert.equal((await f.classifier.classify(f.file)).kind, 'unknown')
  await rm(f.artifact)
  await mkdir(f.artifact)
  assert.equal((await f.classifier.classify(f.file)).kind, 'source')
  const missingSource = createFilesystemReadClassifier({ ...f.config, sourceRoots: [f.source, join(f.root, 'missing-root')] })
  assert.equal((await missingSource.classify(f.file)).kind, 'unknown')
})

test('unreadable source is unknown when current user access can enforce permissions', async t => {
  const f = await fixture(t)
  if (process.getuid?.() === 0) return t.skip('Root bypasses file read permission')
  await chmod(f.file, 0)
  t.after(() => chmod(f.file, 0o600).catch(() => {}))
  assert.equal((await f.classifier.classify(f.file)).kind, 'unknown')
})

test('configuration is validated and copied, with no session or process registration dependency', async t => {
  const f = await fixture(t)
  for (const config of [{ sourceRoots: 'x' }, { sourceRoots: ['relative'] }, { artifactRoots: [null] }, { artifactInventoryComplete: 'true' }]) {
    assert.throws(() => createFilesystemReadClassifier(config), TypeError)
  }
  f.config.sourceRoots.push(f.other)
  f.config.artifactRoots.length = 0
  assert.equal((await f.classifier.classify(f.outside)).kind, 'unknown')
  assert.equal((await f.classifier.classify(f.snapshot)).kind, 'artifact')
  const restarted = createFilesystemReadClassifier({ sourceRoots: [f.source], artifactRoots: [f.artifact], artifactInventoryComplete: true })
  assert.deepEqual(await restarted.classify(f.file), await f.classifier.classify(f.file))
  assert.deepEqual(await restarted.classify(f.snapshot), await f.classifier.classify(f.snapshot))
})
