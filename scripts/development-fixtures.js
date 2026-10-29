import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BYTE_BUDGET_VALIDATION_CASES, BYTE_BUDGET_VALIDATION_VERSION } from './development-byte-budget-validation.js'
import { runEvaluationProcess } from './evaluation-process.js'

const byteValidator = new URL('./development-byte-budget-validation.js', import.meta.url)
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
    byteBudgetValidation: { version: BYTE_BUDGET_VALIDATION_VERSION, cases: BYTE_BUDGET_VALIDATION_CASES,
      validatorHash: digest(await readFile(byteValidator)) },
    testCommand: ['node', ...manifest.testCommand],
    // Prospective wording v3: same source/tests/82-case verification. Keep
    // progress brief after an observed analysis-only output-limit failure.
    prompt: 'Perform the work through tools. Keep each progress update to one brief sentence and the final response to a concise change and observed test result. Fix the JSON rows decoder so that repeated schema keys cannot expand a small input into unbounded decoded output. Preserve existing decoding behavior for valid data, count UTF-8 bytes precisely including JSON escaping and repeated keys, accept exact-fit output budgets, and support the output byte budget exercised by the test suite. Before changing source, reproduce the failure by running exactly node --test test/json-codec.test.js without pipes or redirections; the exit status and full test output must remain observable. Then inspect the module, change only src/json-codec.js, and rerun that exact test command after your last source edit. Prefer a small fix using the existing canonical JSON validation. The output budget concerns expansion of the restored JSON; existing input validation remains in effect. Do not change tests, package metadata or dependencies. Once the required verification is complete, finish with the change and observed test result.' }
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
  const { validatorHash } = fixture.byteBudgetValidation
  const validatorUnchanged = async () => {
    try { return digest(await readFile(byteValidator)) === validatorHash } catch { return false }
  }
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
  if (!await validatorUnchanged()) return { passed: false, reason: 'validator-changed-during-verification' }
  const byteRun = stopReason === null ? await runEvaluationProcess(process.execPath,
    ['--max-old-space-size=256', fileURLToPath(byteValidator), join(root, 'src/json-codec.js')],
    { cwd: root, env: { PATH: dirname(process.execPath), HOME: root, LANG: 'C', TZ: 'UTC' }, timeoutMs, maxOutputBytes: 16384 }) : null
  let byteResult = null
  try { byteResult = JSON.parse(byteRun?.stdout) } catch { /* Missing or extra output fails closed. */ }
  const expectedResult = { version: BYTE_BUDGET_VALIDATION_VERSION, cases: BYTE_BUDGET_VALIDATION_CASES,
    passedCases: byteResult?.passedCases, failedCases: byteResult?.failedCases }
  const validResult = byteRun?.stdout === `${JSON.stringify(expectedResult)}\n` &&
    Number.isSafeInteger(byteResult?.passedCases) && byteResult.passedCases >= 0 &&
    Number.isSafeInteger(byteResult?.failedCases) && byteResult.failedCases >= 0 &&
    byteResult.passedCases + byteResult.failedCases === BYTE_BUDGET_VALIDATION_CASES
  const byteBudgetValidation = { version: BYTE_BUDGET_VALIDATION_VERSION, cases: BYTE_BUDGET_VALIDATION_CASES,
    passedCases: validResult ? byteResult.passedCases : null, failedCases: validResult ? byteResult.failedCases : null,
    exitCode: byteRun?.exitCode ?? null, stopReason: byteRun?.stopReason ?? (byteRun ? null : 'historical-test-stopped'),
    cleaned: byteRun?.cleaned ?? false, outputHash: digest(JSON.stringify([byteRun?.stdout ?? '', byteRun?.stderr ?? ''])),
    validatorHash, sourceHash: before['src/json-codec.js'],
    passed: Boolean(validResult && byteRun.cleaned && byteRun.stopReason === null && byteRun.exitCode === 0 &&
      byteRun.stderr === '' && byteResult.failedCases === 0) }
  if (byteRun && !byteRun.cleaned) return { passed: false, reason: 'test-process-cleanup-failed', byteBudgetValidation }
  try { after = await workspaceHashes(root) } catch { return { passed: false, reason: 'workspace-changed-during-verification', byteBudgetValidation } }
  if (!await validatorUnchanged()) return { passed: false, reason: 'validator-changed-during-verification', byteBudgetValidation }
  if (paths.some(path => after[path] !== before[path])) {
    return { passed: false, reason: 'workspace-changed-during-verification', byteBudgetValidation }
  }
  const count = name => { const match = stdout.match(new RegExp(`^# ${name} ([0-9]+)$`, 'm')); return match ? Number(match[1]) : null }
  const tests = count('tests'), passedTests = count('pass'), failedTests = count('fail')
  return { passed: byteBudgetValidation.passed && sourceChanged && stopReason === null && exitCode === 0 && tests === fixture.manifest.expectedTests && passedTests === tests && failedTests === 0,
    byteBudgetValidation, sourceChanged, protectedFilesIntact: true, sourceHash: after['src/json-codec.js'],
    testRun: { exitCode, timedOut: stopReason === 'timeout', stopReason, tests, passedTests, failedTests, outputHash: digest(stdout) },
    claimBoundary: 'Fixed historical regression tests and independent UTF-8 boundary cases in external Node processes; no model quality, cost savings or universal correctness claim.' }
}
