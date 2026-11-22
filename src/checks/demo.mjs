// The demo: run the configured command in the throwaway clone (never in the real checkout), then copy the regular
// files it wrote into a fresh output folder for upload as workflow artifacts. Symlinks, .git and odd names are refused.
import { readdirSync, lstatSync, mkdtempSync, mkdirSync, realpathSync, openSync, fstatSync, readSync, writeSync, closeSync, constants } from 'node:fs'
import { join, relative, sep, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { finding } from '../lib/context.mjs'
import { globToRegExp, SKIP_DIRS } from '../lib/files.mjs'
import { hasControl, cleanLine } from '../lib/sanitize.mjs'
import { formatMB } from './media.mjs'
import { prepareClone, runInClone } from './install.mjs'

export const MAX_DEMO_FILES = 200
const MB = 1024 * 1024
export const MAX_DEMO_BYTES = 500 * MB

/** The folder part of a glob before its first wildcard ("out/img/*.png" -> "out/img"). */
export function globBase(glob) {
  const parts = glob.replace(/^\.\//, '').split('/')
  const base = []
  for (const p of parts) { if (/[*?[{]/.test(p)) break; base.push(p) }
  if (base.length === parts.length) base.pop()
  return base.join('/')
}

const insideGit = (rel) => rel.split('/').includes('.git')

/** Regular files under root that match any glob: [{ file, abs, bytes, mtimeMs }]. Symlinks and .git are never followed. */
export function collectOutputs(root, globs, { skipped = [] } = {}) {
  const seen = new Map()
  const consider = (abs, st) => {
    const rel = relative(root, abs).split(sep).join('/')
    if (rel.startsWith('..') || insideGit(rel) || seen.has(rel)) return
    if (!globs.some((g) => globToRegExp(g).test(rel))) return
    if (hasControl(rel)) { skipped.push(rel); return }
    seen.set(rel, { file: rel, abs, bytes: st.size, mtimeMs: st.mtimeMs })
  }
  for (const g of globs) {
    const start = join(root, ...globBase(g).split('/').filter(Boolean))
    const walk = (dir, depth) => {
      if (depth > 12 || seen.size > MAX_DEMO_FILES * 5) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const abs = join(dir, e.name)
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs, depth + 1); continue }
        if (e.isFile()) { try { consider(abs, lstatSync(abs)) } catch {} }
      }
    }
    let st
    try { st = lstatSync(start) } catch { continue }
    if (st.isFile()) consider(start, st)
    else if (st.isDirectory()) walk(start, 0)
  }
  return [...seen.values()].sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * Copies root/rel to dest only if every path component is a real folder (no symlinks), the real path is inside
 * root, and the opened file (O_NOFOLLOW) is a regular file. Reads from the open descriptor, so a swap after
 * the checks cannot redirect the copy. -> true when copied
 */
export function safeCopy(root, rel, dest) {
  let realRoot
  try { realRoot = realpathSync(root) } catch { return false }
  const parts = rel.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p === '.git')) return false
  let cur = root
  for (const [k, p] of parts.entries()) {
    cur = join(cur, p)
    let st
    try { st = lstatSync(cur) } catch { return false }
    if (st.isSymbolicLink()) return false
    if (k < parts.length - 1 && !st.isDirectory()) return false
  }
  let real
  try { real = realpathSync(cur) } catch { return false }
  if (!real.startsWith(realRoot + sep)) return false
  let fd
  try {
    fd = openSync(cur, constants.O_RDONLY | constants.O_NOFOLLOW)
    const st = fstatSync(fd)
    if (!st.isFile()) return false
    const out = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644)
    try {
      const buf = Buffer.alloc(1 << 20)
      let n
      while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) writeSync(out, buf, 0, n)
    } finally { closeSync(out) }
    return true
  } catch { return false } finally { if (fd !== undefined) closeSync(fd) }
}

export async function checkDemo(ctx, { tmpBase, log = () => {} } = {}) {
  const { command, outputs, timeout } = ctx.config.demo
  if (!command) return { skipped: true, findings: [], note: 'no demo.command set' }
  const clone = prepareClone(ctx, { tmpBase })
  if (!clone.dest) return { skipped: true, notRun: true, findings: clone.findings.map((f) => ({ ...f, level: 'notice', rule: f.rule.replace(/^install\//, 'demo/') })), note: clone.note }
  const started = Date.now() + 1 // the clone was made before this; anything newer was written by the demo
  log(`demo: ${cleanLine(command)}`)
  const { r, details, limit, refused } = await runInClone(ctx, command, timeout)
  if (refused) return { notRun: true, findings: [finding('demo/no-sandbox', 'error', 'sandbox.mode is "require" but bubblewrap is not available, so the demo was not run.')], details, note: 'not run: no sandbox' }
  const findings = []
  if (r.timedOut) findings.push(finding('demo/timeout', 'error', `The demo \`${command}\` did not finish within ${limit} s.`))
  else if (r.code !== 0) findings.push(finding('demo/failed', 'error', `The demo \`${command}\` failed with exit code ${r.code}.`))
  const skipped = []
  let files = collectOutputs(clone.dest, outputs, { skipped })
  for (const s of skipped) findings.push(finding('demo/bad-file-name', 'warning', 'A demo output has a control character in its name and was not uploaded.', { file: s }))
  if (files.length > MAX_DEMO_FILES) {
    findings.push(finding('demo/too-many-outputs', 'warning', `The demo wrote ${files.length} matching files; only the first ${MAX_DEMO_FILES} are uploaded.`))
    files = files.slice(0, MAX_DEMO_FILES)
  }
  let total = 0
  const outDir = mkdtempSync(join(resolve(tmpBase ?? tmpdir()), 'skill-ci-demo-'))
  const copies = []
  for (const f of files) {
    if (total + f.bytes > MAX_DEMO_BYTES) { findings.push(finding('demo/outputs-too-large', 'warning', `Demo outputs over ${MAX_DEMO_BYTES / MB} MB were not uploaded.`)); break }
    total += f.bytes
    const dest = join(outDir, ...f.file.split('/'))
    mkdirSync(dirname(dest), { recursive: true })
    if (!safeCopy(clone.dest, f.file, dest)) { findings.push(finding('demo/unsafe-output', 'warning', 'A demo output was replaced by a link or left the clone while it was copied; it was not uploaded.', { file: f.file })); continue }
    copies.push(dest)
  }
  details.files = files.map((f) => ({ file: f.file, size: formatMB(f.bytes), fresh: f.mtimeMs >= started }))
  if (files.length === 0) findings.push(finding('demo/no-outputs', 'error', `The demo wrote no file matching ${outputs.join(', ')}.`))
  else if (!files.some((f) => f.mtimeMs >= started)) findings.push(finding('demo/stale-outputs', 'warning', 'Every demo output is older than this run; the demo did not write them.'))
  for (const f of files) if (f.bytes === 0) findings.push(finding('demo/empty-output', 'warning', 'The demo wrote an empty file.', { file: f.file }))
  return { findings, details, demoFiles: copies, demoDir: outDir, note: `${files.length} output file(s)` }
}
