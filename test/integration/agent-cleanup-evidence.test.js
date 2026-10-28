import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

const env = { ...process.env, DSH_RUNTIME_ROOT: resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime'),
  DSH_CLI_RUNTIME_ROOT: resolve(process.env.DSH_CLI_RUNTIME_ROOT ?? '.omx/cli-runtime') }
const moduleUrl = name => new URL(`../../${name}`, import.meta.url).href
const child = async source => JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim())
const fixtureImports = `const { runAgentFixture } = await import(${JSON.stringify(moduleUrl('scripts/evaluate-agent.js'))});
const { retirementDiscoveryFixtureV4 } = await import(${JSON.stringify(moduleUrl('test/fixtures/acceptance/retirement-v4.js'))});
const { retirementDiscoveryAdapter } = await import(${JSON.stringify(moduleUrl('test/fixtures/retirement-discovery-provider.js'))});`

function retained(result) {
  assert.equal(result.thrown, null)
  assert.equal(result.row.modelCalls.length, 3)
  assert.equal(result.row.usage.inputTokens, 30)
  assert.equal(result.row.usage.outputTokens, 15)
  assert.equal(result.row.usageComplete, false)
  assert.equal(result.row.passed, false)
  assert.equal(result.row.estimatedCostUSD, null)
  assert.equal(result.row.cleanup.complete, false)
  assert.ok(result.row.cleanup.failures.length > 0)
  assert.ok(result.row.cleanup.failures.every(failure => typeof failure.phase === 'string'))
  assert.equal(JSON.stringify(result.row).includes('private cleanup error'), false)
}

test('an injected rejection after real fiber disposal preserves the completed AgentLoop ledger', { timeout: 30000 }, async () => {
  const result = await child(`import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const originalMkdtemp = fs.mkdtemp, originalRm = fs.rm, created = new Set();
fs.mkdtemp = async (...args) => {
  const path = await originalMkdtemp(...args);
  if (basename(path).startsWith('dsh-agent-eval-') && resolve(dirname(path)) === resolve(tmpdir())) created.add(path);
  return path;
};
syncBuiltinESMExports();
${fixtureImports}
let row = null, thrown = null;
try {
  row = await runAgentFixture(retirementDiscoveryFixtureV4(), 'baseline-default', { replay: true, adapterFactory: retirementDiscoveryAdapter,
    configureContext(ctx) {
      const original = ctx.fiber.dispose.bind(ctx.fiber);
      // Isolated fault injection after real cleanup, not a claim that Cordis
      // propagates errors thrown by ordinary registered effect disposers.
      ctx.fiber.dispose = async () => { await original(); throw Object.assign(new Error('private cleanup error'), {code:'EACCES'}); };
    } });
} catch (error) { thrown = error.code ?? error.name; }
finally {
  fs.mkdtemp = originalMkdtemp; syncBuiltinESMExports();
  for (const path of created) await originalRm(path,{recursive:true,force:true});
}
console.log(JSON.stringify({row,thrown}));`)
  retained(result)
})
