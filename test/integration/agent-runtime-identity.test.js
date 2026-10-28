import test from 'node:test'
import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { agentRuntimePackagePath } from '../../scripts/evaluate-agent.js'

test('AgentLoop exposes the module-bound runtime identity even after environment changes', async () => {
  const expected = await realpath(join(resolve(process.env.DSH_RUNTIME_ROOT ?? '.omx/integration-runtime'), 'package.json'))
  assert.equal(await realpath(agentRuntimePackagePath), expected)
  const prior = process.env.DSH_RUNTIME_ROOT
  try {
    process.env.DSH_RUNTIME_ROOT = '/not-the-runtime-already-loaded'
    const cached = await import('../../scripts/evaluate-agent.js')
    assert.equal(await realpath(cached.agentRuntimePackagePath), expected)
  } finally {
    if (prior === undefined) delete process.env.DSH_RUNTIME_ROOT
    else process.env.DSH_RUNTIME_ROOT = prior
  }
})
