// Fresh-clone install test: clone the committed repo into a temp folder and run its install and test commands there,
// the way a new user would get it. Files that only exist in the working copy (ignored, untracked) are not there.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { finding } from '../lib/context.mjs'
import { runShell, tail } from '../lib/exec.mjs'
import { cleanLine } from '../lib/sanitize.mjs'
import { redactText } from './secrets.mjs'

const NPM_DEFAULT_TEST = /no test specified/

/** Works out install and test commands from the files in dir. -> { install, test, source } or { error }. */
export function inferCommands(dir) {
  const has = (f) => existsSync(join(dir, f))
  const read = (f) => { try { return readFileSync(join(dir, f), 'utf8') } catch { return '' } }
  if (has('package.json')) {
    let pkg
    try { pkg = JSON.parse(read('package.json')) } catch (e) { return { error: `package.json is not valid JSON: ${e.message}` } }
    const test = pkg?.scripts?.test
    if (typeof test === 'string' && test.trim() && !NPM_DEFAULT_TEST.test(test)) {
      const deps = ['dependencies', 'devDependencies', 'optionalDependencies'].some((k) => pkg[k] && Object.keys(pkg[k]).length)
      const install = deps ? (has('package-lock.json') || has('npm-shrinkwrap.json') ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund') : null
      return { install, test: 'npm test', source: 'package.json scripts.test' }
    }
  }
  const fromCi = workflowTestCommand(dir)
  if (fromCi) return { install: null, test: fromCi.command, source: `test step in ${fromCi.file}` }
  const pyproject = read('pyproject.toml')
  const pytestish = has('pytest.ini') || has('conftest.py') || has('tests/conftest.py') || /\[tool\.pytest/.test(pyproject) || /\[tool:pytest\]/.test(read('setup.cfg')) || has('tox.ini')
  if (pytestish || (has('tests') && hasPythonTests(dir))) {
    const reqs = ['requirements-dev.txt', 'requirements-test.txt', 'requirements.txt'].filter(has)
    return { install: pythonInstall(reqs), test: PY_TEST, source: 'pytest' }
  }
  if (has('Makefile') && /^test\s*:/m.test(read('Makefile'))) return { install: null, test: 'make test', source: 'Makefile test target' }
  return { install: null, test: null, source: null }
}

const VENV = '.skill-ci-venv'
// A venv in the clone when python3 can make one; otherwise (no python3-venv package) the system python3 as it is.
export function pythonInstall(reqs) {
  const pip = `${VENV}/bin/python -I -m pip install -q --disable-pip-version-check pytest${reqs.map((r) => ` -r ${r}`).join('')}`
  return `if python3 -I -m venv ${VENV} >/dev/null 2>&1; then ${pip}; else rm -rf ${VENV}; echo "skill-ci: python3 -m venv is not available here (install python3-venv); testing with the system python3 and no extra packages"; fi`
}
export const PY_TEST = `if [ -x ${VENV}/bin/python ]; then ${VENV}/bin/python -m pytest -q; else python3 -m pytest -q; fi`

/** The first single-line `run:` step in .github/workflows that runs tests (not an install or setup step). */
export function workflowTestCommand(dir) {
  const wdir = join(dir, '.github', 'workflows')
  let files = []
  try { files = readdirSync(wdir).filter((f) => /\.ya?ml$/.test(f)).sort() } catch { return null }
  for (const f of files) {
    let text = ''
    try { text = readFileSync(join(wdir, f), 'utf8') } catch { continue }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:-\s*)?run:\s*(.+?)\s*$/)
      if (!m || /^[|>]/.test(m[1])) continue
      const cmd = m[1].replace(/^(["'])(.*)\1$/, '$2')
      if (/\btest\b/.test(cmd) && !/\b(install|apt-get|apt|setup|checkout|echo)\b|\$\{\{/.test(cmd)) return { command: cmd, file: `.github/workflows/${f}` }
    }
  }
  return null
}

function hasPythonTests(dir) {
  try { return readdirSync(join(dir, 'tests'), { recursive: true }).some((f) => /(^|\/)test_[^/]*\.py$/.test(String(f).split('\\').join('/'))) } catch { return false }
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Clones root (its committed HEAD) into a new temp folder named after the repo, with no remote left behind. */
export function freshClone(root, name, base = tmpdir()) {
  const parent = mkdtempSync(join(resolve(base), 'skill-ci-clone-'))
  const dest = join(parent, name)
  try {
    git(parent, ['clone', '--quiet', '--no-hardlinks', '--no-recurse-submodules', '--', root, dest])
    // the origin would point back at the real checkout (and its credentials); repository code gets no map to it
    git(dest, ['remote', 'remove', 'origin'])
  } catch (e) {
    rmSync(parent, { recursive: true, force: true })
    throw new Error(`git clone failed: ${cleanLine(String(e.stderr || e.message).trim().split('\n').pop()).slice(0, 200)}`)
  }
  return { parent, dest }
}

/** The one throwaway clone shared by the install test and the demo. -> { dest } or { error, findings, note, skipped } */
export function prepareClone(ctx, { tmpBase } = {}) {
  if (ctx.clone) return ctx.clone
  if (!ctx.isGitRoot) {
    const sub = ctx.isGit
    ctx.clone = { skipped: true, notRun: true, findings: [finding(sub ? 'install/subfolder' : 'install/not-git', 'warning', sub ? 'A subfolder of a git repository: the fresh-clone test and demo were not run.' : 'Not a git repository, so a fresh clone cannot be tested.')], note: sub ? 'subfolder; not run' : 'not a git repo; not run' }
    return ctx.clone
  }
  try { git(ctx.root, ['rev-parse', '--verify', 'HEAD']) } catch {
    ctx.clone = { notRun: true, findings: [finding('install/no-commits', 'error', 'The repository has no commits yet; a clone would be empty.')], note: 'no commits' }
    return ctx.clone
  }
  try { ctx.clone = freshClone(ctx.root, ctx.repoName, tmpBase) } catch (e) {
    ctx.clone = { notRun: true, findings: [finding('install/clone-failed', 'error', e.message)], note: 'clone failed' }
  }
  return ctx.clone
}

/** Removes the shared clone (unless keep). */
export function cleanupClone(ctx, { keep = false } = {}) {
  if (ctx.clone?.parent && !keep) rmSync(ctx.clone.parent, { recursive: true, force: true })
}

function describeRun(label, command, r, seconds) {
  if (r.timedOut) return `${label} \`${command}\` did not finish within ${seconds} s.`
  return `${label} \`${command}\` failed with exit code ${r.code}${r.signal ? ` (${r.signal})` : ''}.`
}

/** Runs a repository command in the clone within the run's time budget. */
export async function runInClone(ctx, command, seconds) {
  const timeoutMs = Math.max(100, Math.min(seconds * 1000, ctx.remainingMs ? ctx.remainingMs() : Infinity))
  const r = await runShell(command, { cwd: ctx.clone.dest, timeoutMs, env: process.env })
  return { r, details: { command, code: r.code, seconds: +(r.durationMs / 1000).toFixed(1), output: redactText(tail(r.output)) }, limit: +(timeoutMs / 1000).toFixed(1) }
}

export async function checkInstall(ctx, { tmpBase, log = () => {} } = {}) {
  const findings = []
  const details = {}
  const clone = prepareClone(ctx, { tmpBase })
  if (!clone.dest) return { skipped: clone.skipped, notRun: true, findings: [...clone.findings], note: clone.note }
  let dirty = ''
  try { dirty = git(ctx.root, ['status', '--porcelain', '--untracked-files=no']).trim() } catch {}
  if (dirty) findings.push(finding('install/uncommitted', 'notice', `${dirty.split('\n').length} changed file(s) are not committed, so the clone tests the last commit without them.`))
  details.clone = clone.dest
  const cfg = ctx.config.test
  const inferred = inferCommands(clone.dest)
  if (inferred.error) { findings.push(finding('install/bad-package-json', 'error', inferred.error, { file: 'package.json' })); return { findings, details, note: 'bad package.json', notRun: true } }
  const install = cfg.install ?? inferred.install
  const test = cfg.command ?? inferred.test
  details.source = cfg.command ? '.skill-ci.yml test.command' : inferred.source
  if (!test) {
    findings.push(finding('install/no-test-command', 'warning', 'No test command found, so the fresh clone was not tested.', { hint: 'Set test.command in .skill-ci.yml, or add a "test" script to package.json.' }))
    return { findings, details, note: 'cloned; no test command', notRun: true }
  }
  if (install) {
    log(`install: ${cleanLine(install)}`)
    const { r, details: d, limit } = await runInClone(ctx, install, cfg.timeout)
    details.install = d
    if (r.code !== 0 || r.timedOut) {
      findings.push(finding('install/install-failed', 'error', describeRun('Install', install, r, limit)))
      return { findings, details, note: 'install failed' }
    }
  }
  log(`test: ${cleanLine(test)}`)
  const { r, details: d, limit } = await runInClone(ctx, test, cfg.timeout)
  details.test = d
  if (r.code !== 0 || r.timedOut) findings.push(finding('install/test-failed', 'error', describeRun('In a fresh clone, the test command', test, r, limit), { hint: 'Run it in a fresh clone yourself: a file that is ignored or never committed is the usual cause.' }))
  return { findings, details, note: `\`${test}\` ${r.code === 0 && !r.timedOut ? 'passed' : 'failed'} in ${d.seconds} s` }
}
