// The repository's file list (what git would publish), glob matching and safe text reading.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join, relative, sep, posix } from 'node:path'

/** Folders never walked when the repo is not a git checkout. */
export const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.scratch', '.pytest_cache', '.mypy_cache', '.tox', '.next', '.cache'])

const globCache = new Map()

/** Converts a glob to a RegExp. Supports **, *, ?, {a,b} and [abc]. A pattern without / matches at any depth. */
export function globToRegExp(glob) {
  if (globCache.has(glob)) return globCache.get(glob)
  let g = glob.replace(/\\/g, '/').replace(/^\.\//, '')
  if (g.endsWith('/')) g += '**'
  const anyDepth = !g.includes('/')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        const atStart = i === 0 || g[i - 1] === '/'
        const atEnd = i + 2 === g.length || g[i + 2] === '/'
        if (atStart && atEnd) { re += g[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += g[i + 2] === '/' ? 2 : 1; continue }
        re += '.*'; i++; continue
      }
      re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = g.indexOf('}', i)
      if (end < 0) { re += '\\{'; continue }
      re += '(?:' + g.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'
      i = end
    } else if (c === '[') {
      const end = g.indexOf(']', i)
      if (end < 0) { re += '\\['; continue }
      re += '[' + g.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'
      i = end
    } else re += c.replace(/[.+^$()|\\]/g, '\\$&')
  }
  const out = new RegExp('^' + (anyDepth ? '(?:.*/)?' : '') + re + '$')
  globCache.set(glob, out)
  return out
}

/** True when the posix path matches any of the globs. */
export function matchesAny(path, globs = []) {
  return globs.some((g) => globToRegExp(g).test(path))
}

const git = (cwd, args) => execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })

/** True when dir is the top of a git work tree (not just inside one). */
export function isGitRoot(dir) {
  if (!existsSync(join(dir, '.git'))) return false
  try { return git(dir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true' } catch { return false }
}

/**
 * Lists the repository's files as posix paths relative to root.
 * In a git checkout: tracked files plus untracked files that are not ignored (what the next commit would hold).
 * `tracked` is the subset git already has. Elsewhere: a walk that skips SKIP_DIRS.
 */
export function listFiles(root) {
  if (isGitRoot(root)) {
    try {
      const split = (s) => s.split('\0').filter(Boolean)
      const tracked = split(git(root, ['ls-files', '-z', '--cached']))
      const untracked = split(git(root, ['ls-files', '-z', '--others', '--exclude-standard']))
      const present = (p) => { try { return statSync(join(root, p)).isFile() } catch { return false } }
      const trackedSet = new Set(tracked.filter(present))
      return { git: true, files: [...new Set([...trackedSet, ...untracked.filter(present)])].sort(), tracked: trackedSet }
    } catch { /* fall back to a walk */ }
  }
  const files = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name)) }
      else if (e.isFile()) files.push(relative(root, join(dir, e.name)).split(sep).join('/'))
    }
  }
  walk(root)
  files.sort()
  return { git: false, files, tracked: new Set(files) }
}

/** The set of folders that hold at least one listed file (posix, relative). */
export function dirsOf(files) {
  const dirs = new Set([''])
  for (const f of files) {
    let d = posix.dirname(f)
    while (d && d !== '.' && !dirs.has(d)) { dirs.add(d); d = posix.dirname(d) }
  }
  return dirs
}

/** True when the first 8 KB contain a NUL byte. */
export function looksBinary(abs) {
  let fd
  try {
    fd = openSync(abs, 'r')
    const buf = Buffer.alloc(8192)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).includes(0)
  } catch { return true } finally { if (fd !== undefined) closeSync(fd) }
}

export const MAX_TEXT_BYTES = 2 * 1024 * 1024

/** Reads a file as text. Returns { text } or { skipped: 'binary' | 'too-large' | 'unreadable' }. */
export function readText(abs) {
  let size
  try { size = statSync(abs).size } catch { return { skipped: 'unreadable' } }
  if (size > MAX_TEXT_BYTES) return { skipped: 'too-large', size }
  if (looksBinary(abs)) return { skipped: 'binary', size }
  try { return { text: readFileSync(abs, 'utf8'), size } } catch { return { skipped: 'unreadable' } }
}

export const fileSize = (abs) => { try { return statSync(abs).size } catch { return 0 } }
