// The demo: run the configured command in the repository and collect the files it writes, for upload as artifacts.
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { finding } from '../lib/context.mjs'
import { runShell, tail } from '../lib/exec.mjs'
import { globToRegExp, SKIP_DIRS } from '../lib/files.mjs'
import { formatMB } from './media.mjs'

/** The folder part of a glob before its first wildcard ("out/img/*.png" -> "out/img"). */
export function globBase(glob) {
  const parts = glob.replace(/^\.\//, '').split('/')
  const base = []
  for (const p of parts) { if (/[*?[{]/.test(p)) break; base.push(p) }
  if (base.length === parts.length) base.pop()
  return base.join('/')
}

/** Files under root that match any of the globs: [{ file, abs, bytes, mtimeMs }]. */
export function collectOutputs(root, globs) {
  const seen = new Map()
  for (const g of globs) {
    const re = globToRegExp(g)
    const start = join(root, ...globBase(g).split('/').filter(Boolean))
    const walk = (dir, depth) => {
      if (depth > 12) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const abs = join(dir, e.name)
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs, depth + 1); continue }
        if (!e.isFile()) continue
        const rel = relative(root, abs).split(sep).join('/')
        if (re.test(rel) && !seen.has(rel)) {
          const st = statSync(abs)
          seen.set(rel, { file: rel, abs, bytes: st.size, mtimeMs: st.mtimeMs })
        }
      }
    }
    try { if (statSync(start).isFile()) { const rel = relative(root, start).split(sep).join('/'); if (re.test(rel)) { const st = statSync(start); seen.set(rel, { file: rel, abs: start, bytes: st.size, mtimeMs: st.mtimeMs }) } continue } } catch { continue }
    walk(start, 0)
  }
  return [...seen.values()].sort((a, b) => a.file.localeCompare(b.file))
}

export async function checkDemo(ctx, { log = () => {} } = {}) {
  const { command, outputs, timeout } = ctx.config.demo
  if (!command) return { skipped: true, findings: [], note: 'no demo.command set' }
  const started = Date.now() - 1000
  log(`demo: ${command}`)
  const r = await runShell(command, { cwd: ctx.root, timeoutMs: timeout * 1000, env: { ...process.env, SKILL_CI: '1' } })
  const details = { command, code: r.code, seconds: +(r.durationMs / 1000).toFixed(1), output: tail(r.output) }
  const findings = []
  if (r.timedOut) findings.push(finding('demo/timeout', 'error', `The demo \`${command}\` did not finish within ${timeout} s.`))
  else if (r.code !== 0) findings.push(finding('demo/failed', 'error', `The demo \`${command}\` failed with exit code ${r.code}.`))
  const files = collectOutputs(ctx.root, outputs)
  details.files = files.map((f) => ({ file: f.file, size: formatMB(f.bytes), fresh: f.mtimeMs >= started }))
  if (files.length === 0) findings.push(finding('demo/no-outputs', 'error', `The demo wrote no file matching ${outputs.join(', ')}.`))
  else if (!files.some((f) => f.mtimeMs >= started)) findings.push(finding('demo/stale-outputs', 'warning', 'Every demo output is older than this run; the demo did not write them.'))
  for (const f of files) if (f.bytes === 0) findings.push(finding('demo/empty-output', 'warning', 'The demo wrote an empty file.', { file: f.file }))
  return { findings, details, demoFiles: files.map((f) => f.abs), note: `${files.length} output file(s)` }
}
