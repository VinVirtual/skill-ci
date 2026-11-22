// The Markdown job summary (GitHub's $GITHUB_STEP_SUMMARY) and the plain console report.
// Everything interpolated here can come from a hostile repository: control characters are removed and Markdown
// syntax outside code spans is escaped, so a file name cannot add a link, an image or a heading to the summary.
import { cleanLine, cleanBlock } from '../lib/sanitize.mjs'

export const MAX_ROWS = 40
export const MAX_SUMMARY_BYTES = 1000 * 1000

export const STATUS_LABEL = { pass: '✓ pass', warn: '▲ warn', fail: '✗ fail', skip: '○ skip' }
const RESULT_WORD = { pass: 'passed', warn: 'passed with warnings', fail: 'failed' }

/** Escapes Markdown and HTML syntax in plain text. */
export const escapeMd = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_[\]()!#~|])/g, '\\$1')

/** Text for a Markdown table cell: one line, code spans kept (with | escaped), everything else escaped. */
export function cell(text) {
  return cleanLine(text).split(/(`[^`]+`)/).map((part, i) => (i % 2 ? part.replace(/\|/g, '\\|') : escapeMd(part))).join('')
}

/** A code span for a value; values that hold a backtick are escaped as plain text instead. */
export function code(value) {
  const s = cleanLine(value)
  return s.includes('`') ? escapeMd(s) : `\`${s.replace(/\|/g, '\\|')}\``
}

const htmlEsc = (s) => cleanLine(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A fenced block whose fence is longer than any backtick run inside. */
function fenced(text) {
  const body = cleanBlock(text)
  const longest = Math.max(2, ...(body.match(/`+/g) || []).map((r) => r.length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}text\n${body}\n${fence}`
}

/** Link base for file:line references on GitHub, from the Actions environment. */
export function linkBaseFrom(env = process.env) {
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_SHA) return null
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/blob/${env.GITHUB_SHA}/`
}

export function where(f, linkBase = null) {
  if (!f.file) return '—'
  const label = `${f.file}${f.line ? `:${f.line}` : ''}`
  if (!linkBase) return code(label)
  const href = linkBase + cleanLine(f.file).split('/').map(encodeURIComponent).join('/') + (f.line ? `#L${Number(f.line)}` : '')
  return `[${code(label)}](${href.replace(/[()\s]/g, encodeURIComponent)})`
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`
const LEVEL_ORDER = { error: 0, warning: 1, notice: 2 }

/** Renders a report as GitHub-flavoured Markdown. */
export function toMarkdown(report, options = {}) {
  let md = renderMarkdown(report, options)
  if (Buffer.byteLength(md) > MAX_SUMMARY_BYTES) md = renderMarkdown(report, { ...options, maxRows: 10, tailLines: 10 })
  if (Buffer.byteLength(md) > MAX_SUMMARY_BYTES) {
    md = Buffer.from(md).subarray(0, MAX_SUMMARY_BYTES - 200).toString('utf8').replace(/\uFFFD*$/, '')
    md += '\n\n</details>\n\n...the summary was cut at 1 MB. Run `skill-ci check` locally for the full report.\n'
  }
  return md
}

function renderMarkdown(report, { linkBase = null, maxRows = MAX_ROWS, tailLines = Infinity } = {}) {
  const { totals } = report
  const out = []
  const word = report.result !== 'fail' && report.testsNotRun ? `${RESULT_WORD[report.result]} (fresh-clone test not run)` : RESULT_WORD[report.result]
  out.push(`## skill-ci: ${code(report.name)} ${word}`)
  out.push('')
  if (report.testsNotRun) { out.push('> [!NOTE]\n> The fresh-clone test did not run (see the table), so this result covers the static checks only.'); out.push('') }
  if (report.untrusted) { out.push(`Untrusted run (${cleanLine(report.untrusted)}): the repository's commands were not run.`); out.push('') }
  if (report.configLocked) { out.push('In-repository overrides (ignore, disable, allowlists, inline allow comments) were ignored: `lock-config` is on.'); out.push('') }
  out.push(`**${plural(totals.errors, 'error')}, ${plural(totals.warnings, 'warning')}, ${plural(totals.notices, 'notice')}** across ${report.checks.filter((c) => c.status !== 'skip').length} checks in ${seconds(report.durationMs)}.${report.failOn !== 'error' ? ` Fails on: ${report.failOn}.` : ''}`)
  out.push('')
  out.push('| Result | Check | Errors | Warnings | Details |')
  out.push('|---|---|--:|--:|---|')
  for (const c of report.checks) {
    const e = c.findings.filter((f) => f.level === 'error').length
    const w = c.findings.filter((f) => f.level === 'warning').length
    out.push(`| ${STATUS_LABEL[c.status]} | ${cell(c.title)} | ${e || ''} | ${w || ''} | ${cell(c.note || '')} |`)
  }
  for (const c of report.checks) {
    const findings = [...c.findings].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0))
    const runs = ['install', 'test'].map((k) => c.details?.[k] && { k, ...c.details[k] }).filter(Boolean)
    if (c.id === 'demo' && c.details?.command) runs.push({ k: 'demo', ...c.details })
    if (!findings.length && !runs.length && !(c.id === 'demo' && c.details?.files?.length)) continue
    out.push('')
    out.push(`### ${c.title}`)
    if (findings.length) {
      out.push('')
      out.push('| Level | Where | Finding |')
      out.push('|---|---|---|')
      for (const f of findings.slice(0, maxRows)) {
        out.push(`| ${f.level} | ${where(f, linkBase)} | ${cell(f.message)}${f.hint ? `<br><sub>Fix: ${cell(f.hint)}</sub>` : ''} <sub>${code(f.rule)}</sub> |`)
      }
      if (findings.length > maxRows) out.push(`\n...and ${findings.length - maxRows} more. Run \`skill-ci check\` locally, or see the annotations, for the full list.`)
    }
    if (c.id === 'demo' && c.details?.files?.length) {
      out.push('')
      out.push(`Demo outputs (uploaded as a workflow artifact): ${c.details.files.slice(0, maxRows).map((f) => `${code(f.file)} (${cell(f.size)})`).join(', ')}`)
    }
    for (const r of runs) {
      out.push('')
      out.push(`<details><summary>${r.k === 'demo' ? 'Demo' : r.k === 'install' ? 'Install' : 'Test'} output: <code>${htmlEsc(r.command)}</code>, exit ${htmlEsc(r.code)}, ${htmlEsc(r.seconds)} s</summary>`)
      out.push('')
      const lines = String(r.output || '(no output)').split('\n')
      out.push(fenced(lines.length > tailLines ? lines.slice(-tailLines).join('\n') : lines.join('\n')))
      out.push('')
      out.push('</details>')
    }
  }
  out.push('')
  out.push(`<sub>skill-ci ${cell(report.version)}${report.configFile ? ` · config: ${cell(report.configFile)}` : ' · default settings (no .skill-ci.yml)'} · findings marked warning are worth a look, not proof of a problem</sub>`)
  return out.join('\n') + '\n'
}

/** Plain text for the terminal. color: use ANSI colours. verbose: include notices. */
export function toConsole(report, { color = false, verbose = false } = {}) {
  const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
  const tone = { pass: 32, warn: 33, fail: 31, skip: 90, error: 31, warning: 33, notice: 36 }
  const out = [`skill-ci ${report.version}  ${paint(1, cleanLine(report.name))}  ${paint(90, cleanLine(report.root))}`]
  for (const c of report.checks) {
    const label = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' }[c.status]
    out.push(`  ${paint(tone[c.status], label.padEnd(5))}${c.title.padEnd(28)}${paint(90, cleanLine(c.note || ''))}`)
    for (const f of c.findings) {
      if (f.level === 'notice' && !verbose) continue
      const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}  ` : ''
      out.push(`         ${paint(tone[f.level], f.level.padEnd(8))}${loc}${f.message}${paint(90, `  [${f.rule}]`)}`)
      if (f.hint && verbose) out.push(`                 ${paint(90, `fix: ${f.hint}`)}`)
    }
    if (c.details?.test && c.details.test.code !== 0 && verbose) out.push(cleanBlock(c.details.test.output).split('\n').map((l) => `           | ${l}`).join('\n'))
  }
  const t = report.totals
  out.push(`  ${paint(tone[report.result], `Result: ${report.result.toUpperCase()}${report.testsNotRun && report.result !== 'fail' ? ' (fresh-clone test not run)' : ''}`)}  ${plural(t.errors, 'error')}, ${plural(t.warnings, 'warning')}, ${plural(t.notices, 'notice')}  (${seconds(report.durationMs)})`)
  return out.join('\n') + '\n'
}
