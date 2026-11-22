// Runs a declared shell command (from .skill-ci.yml or inferred) with a timeout, keeping the tail of its output.
import { spawn } from 'node:child_process'

export const TAIL_LINES = 40

/** Last n lines of text, without trailing blank lines. */
export function tail(text, n = TAIL_LINES) {
  const lines = String(text).replace(/\s+$/, '').split(/\r?\n/)
  return (lines.length > n ? [`... (${lines.length - n} earlier lines)`, ...lines.slice(-n)] : lines).join('\n')
}

/**
 * Runs `bash -c command` in cwd. The whole process group is killed on timeout.
 * -> { code, signal, timedOut, output, durationMs }
 */
export function runShell(command, { cwd, timeoutMs = 600000, env = process.env, onOutput } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    let output = '', timedOut = false
    // NODE_TEST_CONTEXT would make a nested `node --test` report to our runner instead of exiting non-zero
    const { NODE_TEST_CONTEXT, ...cleanEnv } = env
    const child = spawn('bash', ['-c', command], { cwd, env: { ...cleanEnv, CI: env.CI ?? 'true' }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    const keep = (chunk) => {
      const s = chunk.toString()
      onOutput?.(s)
      output += s
      if (output.length > 400000) output = output.slice(-200000)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 3000).unref()
    }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, signal: null, timedOut, output: String(e.message), durationMs: Date.now() - started }) })
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, output, durationMs: Date.now() - started }) })
  })
}
