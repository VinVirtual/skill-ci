// The repository's file list (what git would publish), glob matching and safe text reading.
// Symlinks are never followed: a link to /etc/passwd or ~/.ssh must not be read, sized or uploaded.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, lstatSync, openSync, readSync, closeSync, constants } from 'node:fs'
import { join, relative, sep, posix } from 'node:path'

/** Folders never walked when the repo is not a git checkout. */
export const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.scratch', '.pytest_cache', '.mypy_cache', '.tox', '.next', '.cache'])

export const MAX_GLOB_LENGTH = 300
export const MAX_GLOB_WILDCARDS = 12
const globCache = new Map()

export class GlobError extends Error {}

/** Converts a glob to a RegExp. Supports **, *, ?, {a,b} and [abc]. A pattern without / matches at any depth.
 *  Runs of * collapse, and long or wildcard-heavy patterns are refused, so matching cannot backtrack badly. */
export function globToRegExp(glob) {
  if (globCache.has(glob)) return globCache.get(glob)
  if (glob.length > MAX_GLOB_LENGTH) throw new GlobError(`glob longer than ${MAX_GLOB_LENGTH} characters`)
  let g = glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/(\*\*\/)+/g, '**/').replace(/\*{3,}/g, '**')
  if ((g.match(/[*?]/g) || []).length > MAX_GLOB_WILDCARDS) throw new GlobError(`glob "${g.slice(0, 40)}" has more than ${MAX_GLOB_WILDCARDS} wildcards`)
  if (g.endsWith('/')) g += '**'
  const anyDepth = !g.includes('/')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        const atStart = i === 0 || g[i - 1] === '/'
        const atEnd = i + 2 === g.length || g[i + 2] === '/'
        if (atStart && atEnd) { re += g[i + 2] === '/' ? '(?:[^/]*/)*' : '.*'; i += g[i + 2] === '/' ? 2 : 1; continue }
        re += '[^/]*'; i++; continue
      }
      re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = g.indexOf('}', i)
      if (end < 0) { re += '\\{'; continue }
      re += '(?:' + g.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('|') + ')'
      i = end
    } else if (c === '[') {
      const end = g.indexOf(']', i)
      if (end < 0) { re += '\\['; continue }
      re += '[' + g.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'
      i = end
    } else re += c.replace(/[.+^$()|\\]/g, '\\$&')
  }
  re = re.replace(/(\[\^\/\]\*)+/g, '[^/]*')
  const out = new RegExp('^' + (anyDepth ? '(?:[^/]*/)*' : '') + re + '$')
  globCache.set(glob, out)
  return out
}

/** True when the posix path matches any of the globs. */
export function matchesAny(path, globs = []) {
  return globs.some((g) => globToRegExp(g).test(path))
}

const git = (cwd, args) => execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 })

/** Where dir sits in git: { inside, root } (root: dir is the top of the work tree). */
export function gitStatus(dir) {
  try {
    if (git(dir, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') return { inside: false, root: false }
    const prefix = git(dir, ['rev-parse', '--show-prefix']).trim()
    return { inside: true, root: prefix === '' }
  } catch { return { inside: false, root: false } }
}

/** True when dir is the top of a git work tree (not just inside one). */
export const isGitRoot = (dir) => gitStatus(dir).root

/** lstat without throwing. */
export const lstat = (abs) => { try { return lstatSync(abs) } catch { return null } }

/**
 * Lists the repository's files as posix paths relative to root.
 * Inside git (also for a subfolder): tracked files plus untracked files that are not ignored, from git itself,
 * so tracked files in .cache or venv folders are not missed. `tracked` is the subset git already has.
 * `symlinks` lists links, which are never read. Elsewhere: a walk that skips SKIP_DIRS.
 */
export function listFiles(root) {
  const status = gitStatus(root)
  if (status.inside) {
    try {
      const split = (s) => s.split('\0').filter(Boolean)
      const tracked = split(git(root, ['ls-files', '-z', '--cached', '--', '.']))
      const untracked = split(git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.']))
      const symlinks = new Set()
      const keep = (p) => {
        const st = lstat(join(root, p))
        if (!st) return false
        if (st.isSymbolicLink()) { symlinks.add(p); return false }
        return st.isFile()
      }
      const trackedSet = new Set(tracked.filter(keep))
      const files = [...new Set([...trackedSet, ...untracked.filter(keep)])].sort()
      return { git: true, gitRoot: status.root, files, tracked: trackedSet, symlinks: [...symlinks].sort() }
    } catch { /* fall back to a walk */ }
  }
  const files = [], symlinks = []
  const walk = (dir, depth) => {
    if (depth > 64) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const rel = () => relative(root, join(dir, e.name)).split(sep).join('/')
      if (e.isSymbolicLink()) symlinks.push(rel())
      else if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), depth + 1) }
      else if (e.isFile()) files.push(rel())
    }
  }
  walk(root, 0)
  files.sort()
  return { git: false, gitRoot: false, files, tracked: new Set(files), symlinks: symlinks.sort() }
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

/** Reads up to n bytes from the start of a regular file (never through a symlink). */
function head(abs, n) {
  let fd
  try {
    fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const buf = Buffer.alloc(n)
    return buf.subarray(0, readSync(fd, buf, 0, n, 0))
  } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
}

/** True when the first 8 KB contain a NUL byte (and no UTF-16 byte-order mark). */
export function looksBinary(abs) {
  const buf = head(abs, 8192)
  if (!buf) return true
  if (utf16Order(buf)) return false
  return buf.includes(0)
}

/** UTF-16 without a byte-order mark: most code units of the first 4 KB have a zero high byte on one side only. */
export function guessUtf16(buf) {
  const n = Math.min(buf.length, 4096) & ~1
  if (n < 16) return null
  let oddZero = 0, evenZero = 0
  for (let i = 0; i < n; i += 2) { if (buf[i] === 0) evenZero++; if (buf[i + 1] === 0) oddZero++ }
  const pairs = n / 2
  if (oddZero > pairs * 0.3 && evenZero < pairs * 0.05) return 'le'
  if (evenZero > pairs * 0.3 && oddZero < pairs * 0.05) return 'be'
  return null
}

export const MAX_STRINGS = 8 * 1024 * 1024
/** Printable runs in a binary file (ASCII, and UTF-16LE text), like `strings`, so a key inside a binary is still seen. */
export function binaryStrings(buf) {
  const latin = buf.toString('latin1')
  const out = []
  let size = 0
  for (const m of latin.matchAll(/[\x20-\x7e\t]{6,}/g)) { out.push(m[0]); size += m[0].length; if (size > MAX_STRINGS) break }
  for (const m of latin.matchAll(/(?:[\x20-\x7e]\x00){6,}/g)) { out.push(m[0].replace(/\x00/g, '')); size += m[0].length / 2; if (size > MAX_STRINGS * 1.5) break }
  return out.join('\n')
}

const utf16Order = (buf) => (buf[0] === 0xff && buf[1] === 0xfe ? 'le' : buf[0] === 0xfe && buf[1] === 0xff ? 'be' : null)

export const MAX_TEXT_BYTES = 20 * 1024 * 1024

/** Reads a file as text (UTF-8, or UTF-16 with or without a byte-order mark); binaries come with their strings.
 *  Returns { text } or { skipped: 'binary' | 'too-large' | 'unreadable' | 'symlink' }. */
export function readText(abs) {
  const st = lstat(abs)
  if (!st) return { skipped: 'unreadable' }
  if (st.isSymbolicLink()) return { skipped: 'symlink' }
  if (!st.isFile()) return { skipped: 'unreadable' }
  if (st.size > MAX_TEXT_BYTES) return { skipped: 'too-large', size: st.size }
  let buf
  try {
    const fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try { buf = readFileSync(fd) } finally { closeSync(fd) }
  } catch { return { skipped: 'unreadable' } }
  const order = utf16Order(buf) ?? (buf.subarray(0, 8192).includes(0) ? guessUtf16(buf) : null)
  if (order === 'le') return { text: buf.subarray(utf16Order(buf) ? 2 : 0).toString('utf16le'), size: st.size, encoding: 'utf-16le' }
  if (order === 'be') {
    const body = utf16Order(buf) ? buf.subarray(2) : buf
    const swapped = Buffer.from(body.subarray(0, body.length - (body.length % 2))).swap16()
    return { text: swapped.toString('utf16le'), size: st.size, encoding: 'utf-16be' }
  }
  if (buf.subarray(0, 8192).includes(0)) return { skipped: 'binary', size: st.size, strings: binaryStrings(buf) }
  return { text: buf.toString('utf8'), size: st.size }
}

/** Size of a regular file (0 for symlinks and missing files). */
export const fileSize = (abs) => { const st = lstat(abs); return st && st.isFile() ? st.size : 0 }
