import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

async function finishProcessGroup(pid) {
  if (!pid) return
  try { process.kill(-pid, 'SIGKILL') } catch (error) { if (error.code === 'ESRCH') return; if (error.code !== 'EPERM') throw error }
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(-pid, 0) } catch (error) { if (error.code === 'ESRCH') return; if (error.code !== 'EPERM') throw error }
    await delay(10)
  }
  throw new Error('Verification process group cleanup unconfirmed')
}

export async function runEvaluationProcess(command, args, { cwd, env, timeoutMs = 15000, maxOutputBytes = 512 * 1024, shutdownGraceMs = 0 } = {}) {
  if (process.platform === 'win32') throw new Error('Evaluation requires POSIX process groups')
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some(arg => typeof arg !== 'string') || !isAbsolute(cwd ?? '')) throw new TypeError('Invalid evaluation command')
  if (!env || typeof env !== 'object' || Array.isArray(env) || ![Object.prototype, null].includes(Object.getPrototypeOf(env)) || Reflect.ownKeys(env).some(key => typeof key !== 'string' || typeof env[key] !== 'string')) throw new TypeError('Explicit string environment required')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 4 * 1024 * 1024) throw new TypeError('Invalid evaluation process budget')
  if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs < 0 || shutdownGraceMs > 10000) throw new TypeError('Invalid shutdown grace')
  return new Promise(resolveResult => {
    const child = spawn(command, args, { cwd, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = [], errors = []
    let size = 0, stopReason = null, signalErrorCode = null, escalationTimer, gracefulStop = false, escalated = false
    const killGroup = () => {
      if (child.pid) try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') signalErrorCode ??= error.code ?? 'UNKNOWN' }
    }
    const stop = reason => {
      if (stopReason !== null) return
      stopReason = reason
      if (shutdownGraceMs > 0) {
        gracefulStop = true
        // Signal only the owner so its public shutdown handler can join
        // separately managed tool ranges before their controller disappears.
        try { child.kill('SIGTERM') } catch (error) { signalErrorCode ??= error.code ?? 'UNKNOWN' }
        escalationTimer = setTimeout(() => { escalated = true; killGroup() }, shutdownGraceMs)
      } else killGroup()
    }
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    const collect = (chunk, stdout) => {
      if (stopReason !== null) return
      size += chunk.length
      if (size > maxOutputBytes) { stop('output-limit'); return }
      if (stdout) chunks.push(chunk); else errors.push(chunk)
    }
    child.stdout.on('data', chunk => collect(chunk, true))
    child.stderr.on('data', chunk => collect(chunk, false))
    child.once('error', () => { stopReason ??= 'spawn-error' })
    child.once('close', async exitCode => {
      clearTimeout(timer)
      clearTimeout(escalationTimer)
      let cleaned = true
      try { await finishProcessGroup(child.pid) } catch { cleaned = false }
      resolveResult({ pid: child.pid ?? null, stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8'), exitCode, stopReason, cleaned, signalErrorCode, gracefulStop, escalated })
    })
  })
}
