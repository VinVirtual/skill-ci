// GitHub Actions output: annotations (workflow commands), step outputs and the shields.io badge JSON.
import { appendFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { cleanLine, hasControl } from '../lib/sanitize.mjs'

/** A random token for ::stop-commands::, so nothing printed in between can run a workflow command. */
export const stopToken = () => `skill-ci-${randomBytes(16).toString('hex')}`

const escData = (s) => cleanLine(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const escProp = (s) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C')

/** One workflow-command annotation line for a finding. */
export function annotation(f, { prefix = '' } = {}) {
  const cmd = f.level === 'error' ? 'error' : f.level === 'warning' ? 'warning' : 'notice'
  const props = []
  if (f.file) props.push(`file=${escProp(prefix + f.file)}`)
  if (f.line) props.push(`line=${f.line}`)
  props.push(`title=${escProp(`skill-ci ${f.rule}`)}`)
  return `::${cmd} ${props.join(',')}::${escData(f.message + (f.hint ? ` Fix: ${f.hint}` : ''))}`
}

/** Annotation lines for a report; GitHub shows at most 10 of each kind per step, so errors come first. */
export function annotations(report, options = {}) {
  const all = report.checks.flatMap((c) => c.findings)
  const order = { error: 0, warning: 1, notice: 2 }
  return all.sort((a, b) => order[a.level] - order[b.level]).map((f) => annotation(f, options))
}

/** Appends name=value pairs to the $GITHUB_OUTPUT file, using heredoc syntax for multi-line values. */
export function writeOutputs(file, values) {
  let text = ''
  for (const [k, v] of Object.entries(values)) {
    const s = String(v ?? '')
    if (k === 'demo-files' && s.split('\n').some((line) => hasControl(line))) throw new Error('a demo file name holds a control character')
    if (s.includes('\n')) {
      let delim = `SKILL_CI_${randomBytes(8).toString('hex')}`
      while (s.includes(delim)) delim = `SKILL_CI_${randomBytes(8).toString('hex')}`
      text += `${k}<<${delim}\n${s}\n${delim}\n`
    } else text += `${k}=${s}\n`
  }
  appendFileSync(file, text)
}

/** A shields.io endpoint badge: https://img.shields.io/endpoint?url=<raw url of this JSON>. */
export function badge(report, { label = 'skill-ci' } = {}) {
  const { errors, warnings } = report.totals
  if (report.result === 'fail') return { schemaVersion: 1, label, message: `${errors} error${errors === 1 ? '' : 's'}`, color: 'red' }
  if (report.result === 'warn') return { schemaVersion: 1, label, message: `passing, ${warnings} warning${warnings === 1 ? '' : 's'}${report.testsNotRun ? ', tests not run' : ''}`, color: 'yellow' }
  if (report.testsNotRun) return { schemaVersion: 1, label, message: 'passing, tests not run', color: 'yellowgreen' }
  return { schemaVersion: 1, label, message: 'passing', color: 'brightgreen' }
}
