// Runs a repository's own commands (install, test, demo). That code is untrusted: in CI it may come from a pull
// request. So it gets an allow-listed environment (no tokens, no GITHUB_ENV/GITHUB_PATH/ACTIONS_* files or
// variables), a throwaway HOME and TMPDIR, a hard time limit that does not wait for escaped background
// processes, and its output is cleaned before anyone sees it.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { cleanBlock } from './sanitize.mjs'

export const TAIL_LINES = 40
export const GRACE_MS = 2000
const MAX_KEEP = 200000

/** Last n lines of text, without trailing blank lines. */
export function tail(text, n = TAIL_LINES) {
  const lines = String(text).replace(/\s+$/, '').split(/\r?\n/)
  return (lines.length > n ? [`... (${lines.length - n} earlier lines)`, ...lines.slice(-n)] : lines).join('\n')
}

/** Variables passed through to repository commands. Everything else (tokens, GITHUB_*, ACTIONS_*, RUNNER_*) is dropped. */
export const PASS_ENV = ['PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM']

/** The environment for a repository command. home is a throwaway folder used as HOME and TMPDIR. */
export function safeEnv(parent = process.env, home = tmpdir(), extra = {}) {
  const env = {}
  for (const k of PASS_ENV) if (typeof parent[k] === 'string') env[k] = parent[k]
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin'
  return { ...env, HOME: home, TMPDIR: home, TMP: home, TEMP: home, CI: 'true', SKILL_CI: '1', ...extra }
}

/** Linux: kills every process whose environment carries the run marker (catches setsid/nohup escapes). */
export function killMarked(marker) {
  let pids = []
  try { pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d)) } catch { return 0 }
  let killed = 0
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue
    let env = ''
    try { env = readFileSync(`/proc/${pid}/environ`, 'latin1') } catch { continue }
    if (env.includes(`SKILL_CI_RUN=${marker}\0`)) { try { process.kill(Number(pid), 'SIGKILL'); killed++ } catch {} }
  }
  return killed
}

/**
 * Runs `bash -c command` in cwd with a safe environment. Resolves when bash exits (or the time limit plus a
 * short grace passes), without waiting for background processes that keep the output pipes open; those, the
 * whole process group, and anything carrying the run marker are then killed.
 * -> { code, signal, timedOut, output, durationMs }
 */
export function runShell(command, { cwd, timeoutMs = 600000, env = process.env, onOutput } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const home = mkdtempSync(join(tmpdir(), 'skill-ci-home-'))
    const marker = randomBytes(12).toString('hex')
    let output = '', timedOut = false, done = false, exitCode = null, exitSignal = null
    const child = spawn('bash', ['-c', command], { cwd, env: safeEnv(env, home, { SKILL_CI_RUN: marker }), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    const keep = (chunk) => {
      const s = chunk.toString()
      onOutput?.(s)
      output += s
      if (output.length > MAX_KEEP * 2) output = output.slice(-MAX_KEEP)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const killGroup = (sig) => { try { process.kill(-child.pid, sig) } catch { try { child.kill(sig) } catch {} } }
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer); clearTimeout(graceTimer)
      killGroup('SIGKILL')
      killMarked(marker)
      child.stdout.destroy(); child.stderr.destroy()
      try { rmSync(home, { recursive: true, force: true }) } catch {}
      resolve({ code: timedOut ? (exitCode ?? 124) : exitCode, signal: exitSignal, timedOut, output: cleanBlock(output), durationMs: Date.now() - started })
    }
    let graceTimer = null
    const timer = setTimeout(() => {
      if (exitCode !== null || exitSignal !== null) return
      timedOut = true
      killGroup('SIGTERM')
      graceTimer = setTimeout(finish, GRACE_MS)
    }, timeoutMs)
    child.on('error', (e) => { output += String(e.message); exitCode = 127; finish() })
    // 'exit' fires when bash ends, even if an escaped child still holds the pipes; give the pipes a moment to drain
    child.on('exit', (code, signal) => { exitCode = code; exitSignal = signal; if (!graceTimer) graceTimer = setTimeout(finish, 200) })
    child.on('close', () => finish())
  })
}
