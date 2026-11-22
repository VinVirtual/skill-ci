// Runs every enabled check over one repository and returns a report object.
import { resolve } from 'node:path'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { loadConfig, ConfigError } from './lib/config.mjs'
import { buildContext, statusOf } from './lib/context.mjs'
import { checkSkillMd } from './checks/skill-md.mjs'
import { checkReadme } from './checks/readme.mjs'
import { checkLicense } from './checks/license.mjs'
import { checkSecrets } from './checks/secrets.mjs'
import { checkFootguns } from './checks/footguns.mjs'
import { checkMedia } from './checks/media.mjs'
import { checkInstall } from './checks/install.mjs'
import { checkDemo } from './checks/demo.mjs'

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

export const CHECKS = [
  { id: 'skill-md', title: 'SKILL.md', run: checkSkillMd },
  { id: 'readme', title: 'README', run: checkReadme },
  { id: 'license', title: 'Licence', run: checkLicense },
  { id: 'secrets', title: 'Secrets and personal data', run: checkSecrets },
  { id: 'footguns', title: 'Script safety', run: checkFootguns },
  { id: 'media', title: 'Media size budget', run: checkMedia },
  { id: 'install', title: 'Fresh-clone install test', run: checkInstall, executes: true },
  { id: 'demo', title: 'Demo', run: checkDemo, executes: true },
]

/**
 * options: config (path), run (false skips install and demo), only (list of check ids), failOn, name,
 *          timeout (seconds), keepClone, tmpBase, log(message), env
 */
export async function runChecks(dir, options = {}) {
  const root = resolve(dir)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new ConfigError(`not a folder: ${dir}`)
  const { config, file: configFile } = loadConfig(root, options.config ?? null)
  if (options.name) config.name = options.name
  if (options.failOn) config['fail-on'] = options.failOn
  if (options.timeout) { config.test.timeout = options.timeout; config.demo.timeout = options.timeout }
  const ctx = buildContext(root, config, { env: options.env ?? process.env })
  const log = options.log ?? (() => {})
  const started = Date.now()
  const checks = []
  const demoFiles = []
  for (const c of CHECKS) {
    const t0 = Date.now()
    const base = { id: c.id, title: c.title }
    let skipReason = null
    if (!config.checks[c.id]) skipReason = 'turned off in .skill-ci.yml'
    else if (options.only && !options.only.includes(c.id)) skipReason = 'not selected'
    else if (c.executes && options.run === false) skipReason = 'commands not run (--no-run)'
    if (skipReason) { checks.push({ ...base, status: 'skip', findings: [], note: skipReason, ms: 0 }); continue }
    log(`${c.title}...`)
    let res
    try {
      res = await c.run(ctx, { keep: options.keepClone, tmpBase: options.tmpBase, log })
    } catch (e) {
      res = { findings: [{ rule: `${c.id}/crashed`, level: 'error', message: `The check itself failed: ${e.message}` }] }
    }
    const findings = (res.findings ?? []).filter((f) => !ctx.disabled(f.rule))
    const status = res.skipped && !findings.some((f) => f.level !== 'notice') ? 'skip' : statusOf(findings)
    checks.push({ ...base, status, findings, note: res.note ?? '', details: res.details, ms: Date.now() - t0 })
    if (res.demoFiles) demoFiles.push(...res.demoFiles)
  }
  const all = checks.flatMap((c) => c.findings)
  const totals = { errors: count(all, 'error'), warnings: count(all, 'warning'), notices: count(all, 'notice') }
  return {
    tool: 'skill-ci',
    version: VERSION,
    root,
    name: ctx.repoName,
    configFile: configFile ? configFile.slice(root.length + 1) : null,
    failOn: config['fail-on'],
    result: totals.errors ? 'fail' : totals.warnings ? 'warn' : 'pass',
    totals,
    durationMs: Date.now() - started,
    checks,
    demoFiles,
  }
}

const count = (list, level) => list.filter((f) => f.level === level).length

/** Exit code for a report under its fail-on setting: 1 when it should fail the build. */
export function exitCodeFor(report) {
  if (report.failOn === 'never') return 0
  if (report.totals.errors > 0) return 1
  if (report.failOn === 'warning' && report.totals.warnings > 0) return 1
  return 0
}
