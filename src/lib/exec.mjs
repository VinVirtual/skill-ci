// Runs a repository's own commands (install, test, demo). This is running untrusted code with the job's
// privileges: the same user can read other processes' environments in /proc, the runner's files and the
// checkout's git config. Nothing here makes that safe; it only narrows what is handed over directly:
//   - an allow-listed environment and a throwaway HOME/TMPDIR,
//   - when bubblewrap (bwrap) works on this machine: a sandbox with no network, its own process and user
//     namespaces and /proc, a read-only root, empty /home and /tmp, and only the clone writable,
//   - a time limit, then a kill of the process group, the session, anything carrying the run marker and
//     anything whose working folder is inside the clone (defence in depth; a determined process can escape it).
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, readFileSync, readlinkSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
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

const BWRAP_HOME = '/tmp/skill-ci-home'

/** bubblewrap arguments for a sandbox around `dir`. Folders on PATH under /home come back read-only (tool installs). */
export function bwrapArgs(dir, { path = process.env.PATH ?? '', network = false } = {}) {
  const args = ['--unshare-all', ...(network ? ['--share-net'] : []), '--die-with-parent', '--new-session',
    '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/home', '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/root']
  const back = new Set([dirname(dirname(process.execPath))])
  for (const p of path.split(':')) if (p.startsWith('/home/') || p.startsWith('/root/')) back.add(p)
  for (const p of back) if ((p.startsWith('/home/') || p.startsWith('/root/')) && existsSync(p)) args.push('--ro-bind', p, p)
  args.push('--dir', BWRAP_HOME, '--bind', dir, dir, '--chdir', dir)
  return args
}

let bwrapOk = null
/** True when bubblewrap is installed and can create its namespaces here (it often cannot in containers or on Ubuntu 24.04 runners). */
export function bwrapAvailable() {
  if (bwrapOk !== null) return bwrapOk
  if (process.platform !== 'linux' || process.env.SKILL_CI_NO_SANDBOX === '1') return (bwrapOk = false)
  const probe = mkdtempSync(join(tmpdir(), 'skill-ci-probe-'))
  try {
    const r = spawnSync('bwrap', [...bwrapArgs(probe), 'true'], { stdio: 'ignore', timeout: 10000 })
    bwrapOk = r.status === 0
  } catch { bwrapOk = false } finally { rmSync(probe, { recursive: true, force: true }) }
  return bwrapOk
}

const procs = () => { try { return readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number) } catch { return [] } }

/**
 * Linux, best effort: kills processes left behind by a run, found by the run marker in their environment,
 * by session id, or by a working folder inside the clone.
 */
/** This process and its ancestors: never swept, even when one of them works inside the clone. */
function ancestors() {
  const out = new Set([process.pid, 1])
  let pid = process.pid
  for (let i = 0; i < 64 && pid > 1; i++) {
    try { pid = Number(readFileSync(`/proc/${pid}/stat`, 'latin1').replace(/^.*\)\s/, '').split(' ')[1]) } catch { break }
    out.add(pid)
  }
  return out
}

/** A folder narrow enough to sweep by working folder: not /, the temp folder, a home folder or a shallow system path. */
export function sweepable(root) {
  const r = resolve(root)
  const shallow = r.split(sep).filter(Boolean).length < 3
  return !shallow && r !== resolve(tmpdir()) && r !== resolve(homedir())
}

export function sweep({ marker, session, root } = {}) {
  let killed = 0
  const realRoot = root && sweepable(root) ? resolve(root) : null
  const keep = ancestors()
  for (const pid of procs()) {
    if (keep.has(pid)) continue
    let hit = false
    if (marker) { try { hit = readFileSync(`/proc/${pid}/environ`, 'latin1').includes(`SKILL_CI_RUN=${marker}\0`) } catch {} }
    if (!hit && session) { try { hit = Number(readFileSync(`/proc/${pid}/stat`, 'latin1').replace(/^.*\)\s/, '').split(' ')[3]) === session } catch {} }
    if (!hit && realRoot) { try { const cwd = readlinkSync(`/proc/${pid}/cwd`); hit = cwd === realRoot || cwd.startsWith(realRoot + sep) } catch {} }
    if (hit) { try { process.kill(pid, 'SIGKILL'); killed++ } catch {} }
  }
  return killed
}
export const killMarked = (marker) => sweep({ marker })

/**
 * Runs `bash -c command` in cwd (inside bubblewrap when sandbox and available). Resolves when bash exits or the
 * time limit plus a short grace passes, without waiting for background processes holding the output pipes;
 * leftovers are then swept. -> { code, signal, timedOut, output, durationMs, sandboxed }
 */
export function runShell(command, { cwd, timeoutMs = 600000, env = process.env, onOutput, sandbox = false, network = false } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    const sandboxed = Boolean(sandbox) && bwrapAvailable()
    const home = sandboxed ? null : mkdtempSync(join(tmpdir(), 'skill-ci-home-'))
    const marker = randomBytes(12).toString('hex')
    const childEnv = safeEnv(env, sandboxed ? BWRAP_HOME : home, { SKILL_CI_RUN: marker })
    let output = '', timedOut = false, done = false, exitCode = null, exitSignal = null
    const [cmd, args] = sandboxed ? ['bwrap', [...bwrapArgs(resolve(cwd), { path: childEnv.PATH, network }), 'bash', '-c', command]] : ['bash', ['-c', command]]
    const child = spawn(cmd, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    const keep = (chunk) => {
      const s = chunk.toString()
      onOutput?.(s)
      output += s
      if (output.length > MAX_KEEP * 2) output = output.slice(-MAX_KEEP)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const killGroup = (sig) => { try { process.kill(-child.pid, sig) } catch { try { child.kill(sig) } catch {} } }
    let graceTimer = null
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer); clearTimeout(graceTimer)
      killGroup('SIGKILL')
      sweep({ marker, session: child.pid, root: cwd })
      child.stdout.destroy(); child.stderr.destroy()
      if (home) { try { rmSync(home, { recursive: true, force: true }) } catch {} }
      resolvePromise({ code: timedOut ? (exitCode ?? 124) : exitCode, signal: exitSignal, timedOut, output: cleanBlock(output), durationMs: Date.now() - started, sandboxed })
    }
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
