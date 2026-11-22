// The Markdown job summary (GitHub's $GITHUB_STEP_SUMMARY) and the plain console report.
export const MAX_ROWS = 40

export const STATUS_LABEL = { pass: '✓ pass', warn: '▲ warn', fail: '✗ fail', skip: '○ skip' }
const RESULT_WORD = { pass: 'passed', warn: 'passed with warnings', fail: 'failed' }

/** Escapes text for a Markdown table cell. Backticked code is kept, HTML is neutralised. */
export function cell(text) {
  return String(text ?? '').split(/(`[^`\n]+`)/).map((part, i) => (i % 2
    ? part.replace(/\|/g, '\\|')
    : part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'))).join('')
}

/** Link base for file:line references on GitHub, from the Actions environment. */
export function linkBaseFrom(env = process.env) {
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_SHA) return null
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/blob/${env.GITHUB_SHA}/`
}

export function where(f, linkBase = null) {
  if (!f.file) return '—'
  const label = `${f.file}${f.line ? `:${f.line}` : ''}`
  if (!linkBase) return `\`${cell(label)}\``
  const href = linkBase + f.file.split('/').map(encodeURIComponent).join('/') + (f.line ? `#L${f.line}` : '')
  return `[\`${cell(label)}\`](${href})`
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`
const LEVEL_ORDER = { error: 0, warning: 1, notice: 2 }

/** Renders a report as GitHub-flavoured Markdown. */
export function toMarkdown(report, { linkBase = null } = {}) {
  const { totals } = report
  const out = []
  out.push(`## skill-ci: \`${report.name}\` ${RESULT_WORD[report.result]}`)
  out.push('')
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
      for (const f of findings.slice(0, MAX_ROWS)) {
        out.push(`| ${f.level} | ${where(f, linkBase)} | ${cell(f.message)}${f.hint ? `<br><sub>Fix: ${cell(f.hint)}</sub>` : ''} <sub>\`${f.rule}\`</sub> |`)
      }
      if (findings.length > MAX_ROWS) out.push(`\n...and ${findings.length - MAX_ROWS} more. Run \`skill-ci check\` locally, or see the annotations, for the full list.`)
    }
    if (c.id === 'demo' && c.details?.files?.length) {
      out.push('')
      out.push(`Demo outputs (uploaded as a workflow artifact): ${c.details.files.map((f) => `\`${cell(f.file)}\` (${f.size})`).join(', ')}`)
    }
    for (const r of runs) {
      out.push('')
      out.push(`<details><summary>${r.k === 'demo' ? 'Demo' : r.k === 'install' ? 'Install' : 'Test'} output: <code>${cell(r.command)}</code>, exit ${r.code}, ${r.seconds} s</summary>`)
      out.push('')
      out.push('```text')
      out.push(String(r.output || '(no output)').replace(/```/g, "'''"))
      out.push('```')
      out.push('')
      out.push('</details>')
    }
  }
  out.push('')
  out.push(`<sub>skill-ci ${report.version}${report.configFile ? ` · config: ${cell(report.configFile)}` : ' · default settings (no .skill-ci.yml)'} · findings marked warning are worth a look, not proof of a problem</sub>`)
  return out.join('\n') + '\n'
}

/** Plain text for the terminal. color: use ANSI colours. verbose: include notices. */
export function toConsole(report, { color = false, verbose = false } = {}) {
  const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
  const tone = { pass: 32, warn: 33, fail: 31, skip: 90, error: 31, warning: 33, notice: 36 }
  const out = [`skill-ci ${report.version}  ${paint(1, report.name)}  ${paint(90, report.root)}`]
  for (const c of report.checks) {
    const label = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' }[c.status]
    out.push(`  ${paint(tone[c.status], label.padEnd(5))}${c.title.padEnd(28)}${paint(90, c.note || '')}`)
    for (const f of c.findings) {
      if (f.level === 'notice' && !verbose) continue
      const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}  ` : ''
      out.push(`         ${paint(tone[f.level], f.level.padEnd(8))}${loc}${f.message}${paint(90, `  [${f.rule}]`)}`)
      if (f.hint && verbose) out.push(`                 ${paint(90, `fix: ${f.hint}`)}`)
    }
    if (c.details?.test && c.details.test.code !== 0 && verbose) out.push(c.details.test.output.split('\n').map((l) => `           | ${l}`).join('\n'))
  }
  const t = report.totals
  out.push(`  ${paint(tone[report.result], `Result: ${report.result.toUpperCase()}`)}  ${plural(t.errors, 'error')}, ${plural(t.warnings, 'warning')}, ${plural(t.notices, 'notice')}  (${seconds(report.durationMs)})`)
  return out.join('\n') + '\n'
}
