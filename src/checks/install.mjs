// Fresh-clone install test: clone the committed repo into a temp folder and run its install and test commands there,
// the way a new user would get it. Files that only exist in the working copy (ignored, untracked) are not there.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { finding } from '../lib/context.mjs'
import { runShell, tail } from '../lib/exec.mjs'

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

/** Clones root (its committed HEAD) into a new temp folder named after the repo. -> path */
export function freshClone(root, name, base = tmpdir()) {
  const parent = mkdtempSync(join(resolve(base), 'skill-ci-clone-'))
  const dest = join(parent, name)
  try {
    git(parent, ['clone', '--quiet', '--no-hardlinks', '--', root, dest])
  } catch (e) {
    rmSync(parent, { recursive: true, force: true })
    throw new Error(`git clone failed: ${String(e.stderr || e.message).trim().split('\n').pop()}`)
  }
  return { parent, dest }
}

function describeRun(label, command, r, seconds) {
  if (r.timedOut) return `${label} \`${command}\` did not finish within ${seconds} s.`
  return `${label} \`${command}\` failed with exit code ${r.code}${r.signal ? ` (${r.signal})` : ''}.`
}

export async function checkInstall(ctx, { keep = false, tmpBase, log = () => {} } = {}) {
  const findings = []
  const details = {}
  if (!ctx.isGit) return { skipped: true, findings: [finding('install/not-git', 'warning', 'Not a git repository, so a fresh clone cannot be tested.')], note: 'not a git repo' }
  try { git(ctx.root, ['rev-parse', '--verify', 'HEAD']) } catch { return { findings: [finding('install/no-commits', 'error', 'The repository has no commits yet; a clone would be empty.')], note: 'no commits' } }
  let dirty = ''
  try { dirty = git(ctx.root, ['status', '--porcelain', '--untracked-files=no']).trim() } catch {}
  if (dirty) findings.push(finding('install/uncommitted', 'notice', `${dirty.split('\n').length} changed file(s) are not committed, so the clone tests the last commit without them.`))

  let clone
  try { clone = freshClone(ctx.root, ctx.repoName, tmpBase) } catch (e) { return { findings: [...findings, finding('install/clone-failed', 'error', e.message)], note: 'clone failed' } }
  details.clone = keep ? clone.dest : '(removed)'
  try {
    const cfg = ctx.config.test
    const inferred = inferCommands(clone.dest)
    if (inferred.error) { findings.push(finding('install/bad-package-json', 'error', inferred.error, { file: 'package.json' })); return { findings, details, note: 'bad package.json' } }
    const install = cfg.install ?? inferred.install
    const test = cfg.command ?? inferred.test
    details.source = cfg.command ? '.skill-ci.yml test.command' : inferred.source
    if (!test) {
      findings.push(finding('install/no-test-command', 'warning', 'No test command found, so the fresh clone was not tested.', { hint: 'Set test.command in .skill-ci.yml, or add a "test" script to package.json.' }))
      return { findings, details, note: 'cloned; no test command' }
    }
    const timeoutMs = cfg.timeout * 1000
    const env = { ...process.env, SKILL_CI: '1' }
    if (install) {
      log(`install: ${install}`)
      const r = await runShell(install, { cwd: clone.dest, timeoutMs, env })
      details.install = { command: install, code: r.code, seconds: +(r.durationMs / 1000).toFixed(1), output: tail(r.output) }
      if (r.code !== 0 || r.timedOut) {
        findings.push(finding('install/install-failed', 'error', describeRun('Install', install, r, cfg.timeout)))
        return { findings, details, note: 'install failed' }
      }
    }
    log(`test: ${test}`)
    const r = await runShell(test, { cwd: clone.dest, timeoutMs, env })
    details.test = { command: test, code: r.code, seconds: +(r.durationMs / 1000).toFixed(1), output: tail(r.output) }
    if (r.code !== 0 || r.timedOut) findings.push(finding('install/test-failed', 'error', describeRun('In a fresh clone, the test command', test, r, cfg.timeout), { hint: 'Run it in a fresh clone yourself: a file that is ignored or never committed is the usual cause.' }))
    return { findings, details, note: `\`${test}\` ${r.code === 0 && !r.timedOut ? 'passed' : 'failed'} in ${details.test.seconds} s` }
  } finally {
    if (!keep) rmSync(clone.parent, { recursive: true, force: true })
  }
}
