#!/usr/bin/env node
// skill-ci command line: check a Claude Code skill repository the way a careful maintainer would before publishing.
import { writeFileSync, appendFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFileSync } from 'node:child_process'
import { runChecks, exitCodeFor, VERSION, CHECKS } from './run.mjs'
import { ConfigError, STARTER_CONFIG, CHECK_IDS } from './lib/config.mjs'
import { toMarkdown, toConsole, linkBaseFrom } from './report/markdown.mjs'
import { annotations, writeOutputs, badge } from './report/github.mjs'
import { summaryPage } from './report/html.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const HELP = `skill-ci ${VERSION}: check a Claude Code skill repository before publishing it.

Usage:
  skill-ci check [dir]     run every check (default dir: .)
  skill-ci init [dir]      write a starter .skill-ci.yml (never overwrites)
  skill-ci rules           list the checks
  skill-ci env             check Node and git
  skill-ci test            run skill-ci's own tests
  skill-ci help | --version

Options for check:
  --config FILE        config file (default: .skill-ci.yml in dir)
  --no-run             skip the fresh-clone install test and the demo (no repo code is run)
  --only a,b           run only these checks (${CHECK_IDS.join(', ')})
  --fail-on LEVEL      error (default), warning or never
  --name NAME          expected skill name (default: the repository or folder name)
  --summary FILE       write the Markdown summary to FILE
  --html FILE          write the summary as a standalone HTML page
  --badge FILE         write a shields.io endpoint badge JSON
  --json               print the full report as JSON instead of text
  --github             GitHub Actions mode: annotations, job summary, step outputs
  --timeout SECONDS    time limit for each install, test and demo command (default 600)
  --tmp DIR            where the temp clone goes (default: the system temp folder)
  --keep-clone         keep the temp clone and print where it is
  --verbose            show notices, fix hints and failing test output
  --no-color           plain text

Exit codes: 0 passed, 1 failed (per --fail-on), 2 usage or config error.
`

const VALUE_FLAGS = new Set(['--config', '--only', '--fail-on', '--name', '--summary', '--html', '--badge', '--tmp', '--timeout'])
const BOOL_FLAGS = new Set(['--no-run', '--json', '--github', '--keep-clone', '--verbose', '--no-color', '--quiet'])

export function parseArgs(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, inlineVal] = a.split(/=(.*)/s)
      if (VALUE_FLAGS.has(k)) {
        const v = inlineVal ?? argv[++i]
        if (v === undefined || (inlineVal === undefined && v.startsWith('--'))) throw new UsageError(`${k} needs a value`)
        out.flags[k.slice(2)] = v
      } else if (BOOL_FLAGS.has(k)) {
        if (inlineVal !== undefined) throw new UsageError(`${k} takes no value`)
        out.flags[k.slice(2)] = true
      } else throw new UsageError(`unknown option ${k}`)
    } else if (a === '-h') out._.push('help')
    else out._.push(a)
  }
  return out
}

class UsageError extends Error {}

async function cmdCheck(args) {
  const dir = args._[1] ?? '.'
  const f = args.flags
  if (args._.length > 2) throw new UsageError('check takes one folder')
  const only = f.only ? f.only.split(',').map((s) => s.trim()).filter(Boolean) : null
  for (const id of only ?? []) if (!CHECK_IDS.includes(id)) throw new UsageError(`unknown check "${id}" (checks: ${CHECK_IDS.join(', ')})`)
  if (f['fail-on'] && !['error', 'warning', 'never'].includes(f['fail-on'])) throw new UsageError('--fail-on must be error, warning or never')
  const timeout = f.timeout === undefined ? undefined : Number(f.timeout)
  if (timeout !== undefined && !(timeout > 0)) throw new UsageError('--timeout must be a number of seconds above 0')
  const env = process.env
  const github = Boolean(f.github)
  const quiet = f.json || f.quiet
  const report = await runChecks(dir, {
    config: f.config, run: !f['no-run'], only, failOn: f['fail-on'], name: f.name, keepClone: f['keep-clone'],
    tmpBase: f.tmp, timeout, log: quiet ? () => {} : (m) => process.stderr.write(`  ... ${m}\n`),
  })
  const md = toMarkdown(report, { linkBase: github ? linkBaseFrom(env) : null })
  const write = (file, text) => { mkdirSync(dirname(resolve(file)), { recursive: true }); writeFileSync(file, text) }
  if (f.summary) write(f.summary, md)
  if (f.html) write(f.html, summaryPage(md, { title: `skill-ci: ${report.name}` }))
  if (f.badge) write(f.badge, JSON.stringify(badge(report), null, 2) + '\n')
  if (github) {
    const prefix = env.GITHUB_WORKSPACE && resolve(env.GITHUB_WORKSPACE) !== report.root && report.root.startsWith(resolve(env.GITHUB_WORKSPACE) + '/')
      ? report.root.slice(resolve(env.GITHUB_WORKSPACE).length + 1) + '/' : ''
    for (const line of annotations(report, { prefix })) process.stdout.write(line + '\n')
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md) // appended: one step may hold several summaries
    if (env.GITHUB_OUTPUT) {
      writeOutputs(env.GITHUB_OUTPUT, {
        result: report.result, errors: report.totals.errors, warnings: report.totals.warnings, notices: report.totals.notices,
        'exit-code': exitCodeFor(report), 'demo-files': report.demoFiles.join('\n'), badge: f.badge ? resolve(f.badge) : '',
      })
    }
  }
  if (f.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  else process.stdout.write(toConsole(report, { color: !f['no-color'] && process.stdout.isTTY && !env.NO_COLOR, verbose: f.verbose }))
  if (f['keep-clone']) {
    const clone = report.checks.find((c) => c.id === 'install')?.details?.clone
    if (clone && !f.json) process.stdout.write(`  clone kept at ${clone}\n`)
  }
  return exitCodeFor(report)
}

function cmdInit(args) {
  const dir = resolve(args._[1] ?? '.')
  const file = join(dir, '.skill-ci.yml')
  if (existsSync(file)) { process.stdout.write(`${file} already exists; left as it is.\n`); return 0 }
  writeFileSync(file, STARTER_CONFIG)
  process.stdout.write(`wrote ${file}\n`)
  return 0
}

function cmdRules() {
  const lines = CHECKS.map((c) => `  ${c.id.padEnd(10)} ${c.title}${c.executes ? '  (runs repo commands; off with --no-run)' : ''}`)
  process.stdout.write(`Checks:\n${lines.join('\n')}\n\nEvery finding names its rule id (e.g. skill-md/name-mismatch). Turn one off with "disable:" in .skill-ci.yml,\nor on one line with a "skill-ci: allow <rule-id>" comment.\n`)
  return 0
}

function cmdEnv() {
  let ok = true
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 20) process.stdout.write(`ok    node ${process.versions.node}\n`)
  else { ok = false; process.stdout.write(`MISS  node 20 or newer (found ${process.versions.node}); install it from https://nodejs.org or with nvm\n`) }
  try { process.stdout.write(`ok    ${execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()}\n`) } catch {
    ok = false; process.stdout.write('MISS  git; install it (apt install git, brew install git) for the file list and the fresh-clone test\n')
  }
  try { execFileSync('bash', ['-c', 'true']); process.stdout.write('ok    bash (runs the test and demo commands)\n') } catch {
    ok = false; process.stdout.write('MISS  bash; the install test and demo run their commands with bash\n')
  }
  return ok ? 0 : 1
}

function cmdTest() {
  const dir = join(ROOT, 'tests')
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => join(dir, f))
  const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
  return r.status ?? 1
}

export async function main(argv) {
  if (argv[0] === '--version' || argv[0] === '-v') { process.stdout.write(`${VERSION}\n`); return 0 }
  if (argv[0] === '--help') argv = ['help']
  let args
  try { args = parseArgs(argv) } catch (e) { process.stderr.write(`skill-ci: ${e.message}\n`); return 2 }
  const cmd = args._[0] ?? 'help'
  try {
    if (cmd === 'check') return await cmdCheck(args)
    if (cmd === 'init') return cmdInit(args)
    if (cmd === 'rules') return cmdRules()
    if (cmd === 'env') return cmdEnv()
    if (cmd === 'test') return cmdTest()
    if (cmd === 'help') { process.stdout.write(HELP); return 0 }
    process.stderr.write(`skill-ci: unknown command "${cmd}"\n\n${HELP}`)
    return 2
  } catch (e) {
    if (e instanceof UsageError || e instanceof ConfigError) { process.stderr.write(`skill-ci: ${e.message}\n`); return 2 }
    throw e
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
