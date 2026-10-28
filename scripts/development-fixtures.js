import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { runEvaluationProcess } from './evaluation-process.js'

const capture = new URL('../test/fixtures/development/json-output-limit/', import.meta.url)
const manifestHash = '2451a3721d67cc2ad9bf4385ab7330c74fe2fe7635c156a14a9d115637d8cb7a'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const id = 'json-output-limit'
const paths = ['LICENSE', 'package.json', 'src/json-codec.js', 'test/json-codec.test.js']
export const listDevelopmentFixtures = () => [id]

export async function loadDevelopmentFixture(fixtureId) {
  if (fixtureId !== id) throw new TypeError('Unknown development fixture')
  const bytes = await readFile(new URL('manifest.json', capture))
  if (digest(bytes) !== manifestHash) throw new Error('Development fixture manifest mismatch')
  const manifest = JSON.parse(bytes)
  const files = {}
  for (const [name, entry] of Object.entries(manifest.files)) {
    const content = await readFile(new URL(name, capture))
    if (digest(content) !== entry.sha256) throw new Error('Development fixture content mismatch')
    if (name.startsWith('workspace/')) files[name.slice('workspace/'.length)] = content.toString('utf8')
  }
  return { id, manifestHash, manifest, files,
    testCommand: ['node', ...manifest.testCommand],
    prompt: 'Fix the JSON rows decoder so that repeated schema keys cannot expand a small input into unbounded decoded output. Preserve existing decoding behavior for valid data, count UTF-8 bytes precisely, and support the output byte budget exercised by the test suite. Reproduce the failure with node --test test/json-codec.test.js, inspect the module, change only src/json-codec.js, and rerun all tests. Do not change tests, package metadata or dependencies. Report the change and observed test result.' }
}

export async function materializeDevelopmentFixture(fixtureId, directory) {
  const fixture = await loadDevelopmentFixture(fixtureId)
  const root = resolve(directory)
  // A new directory is mandatory; never reset an existing user checkout.
  await mkdir(root, { mode: 0o700 })
  for (const path of paths) {
    await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 })
    await writeFile(join(root, path), fixture.files[path], { flag: 'wx', mode: 0o600 })
  }
  return { directory: await realpath(root), fixture }
}

async function workspaceHashes(root) {
  if (!(await lstat(root)).isDirectory()) throw new Error('Workspace must be a real directory')
  const hashes = {}
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory)) {
      const path = relative ? `${relative}/${entry}` : entry
      const absolute = join(directory, entry)
      const stat = await lstat(absolute)
      if (stat.isSymbolicLink()) throw new Error('Workspace symlinks are not allowed')
      if (stat.isDirectory()) {
        if (!['src', 'test'].includes(path)) throw new Error('Unexpected workspace directory')
        await visit(absolute, path)
      } else {
        if (!stat.isFile() || !paths.includes(path)) throw new Error('Unexpected workspace file')
        hashes[path] = digest(await readFile(absolute))
      }
    }
  }
  await visit(root)
  if (Object.keys(hashes).length !== paths.length) throw new Error('Workspace files missing')
  return hashes
}

export async function verifyDevelopmentWorkspace(fixtureId, directory, { timeoutMs = 15000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('Invalid development test timeout')
  if (process.platform === 'win32') throw new Error('Development verification requires POSIX process groups')
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or later is required')
  const fixture = await loadDevelopmentFixture(fixtureId)
  const root = resolve(directory)
  let before
  try { before = await workspaceHashes(root) } catch { return { passed: false, reason: 'invalid-workspace' } }
  const protectedFiles = paths.filter(path => !fixture.manifest.allowedEditPaths.includes(path))
  if (protectedFiles.some(path => before[path] !== fixture.manifest.files[`workspace/${path}`].sha256)) return { passed: false, reason: 'protected-files-changed' }
  const sourceChanged = before['src/json-codec.js'] !== fixture.manifest.files['workspace/src/json-codec.js'].sha256
  const run = await runEvaluationProcess(process.execPath, ['--max-old-space-size=256', ...fixture.manifest.testCommand], { cwd: root, env: { PATH: dirname(process.execPath), HOME: root, LANG: 'C', TZ: 'UTC' }, timeoutMs })
  const { stdout, exitCode, stopReason } = run
  if (!run.cleaned) return { passed: false, reason: 'test-process-cleanup-failed' }
  let after
  try { after = await workspaceHashes(root) } catch { return { passed: false, reason: 'workspace-changed-during-verification' } }
  if (paths.some(path => after[path] !== before[path])) return { passed: false, reason: 'workspace-changed-during-verification' }
  const count = name => { const match = stdout.match(new RegExp(`^# ${name} ([0-9]+)$`, 'm')); return match ? Number(match[1]) : null }
  const tests = count('tests'), passedTests = count('pass'), failedTests = count('fail')
  return { passed: sourceChanged && stopReason === null && exitCode === 0 && tests === fixture.manifest.expectedTests && passedTests === tests && failedTests === 0,
    sourceChanged, protectedFilesIntact: true, sourceHash: after['src/json-codec.js'],
    testRun: { exitCode, timedOut: stopReason === 'timeout', stopReason, tests, passedTests, failedTests, outputHash: digest(stdout) },
    claimBoundary: 'Fixed historical regression tests in an external Node process; no model quality, cost savings or universal correctness claim.' }
}
