import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, writeFileSync, mkdtempSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { budget, checkMedia, isMedia } from '../src/checks/media.mjs'
import { inferCommands, checkInstall, cleanupClone } from '../src/checks/install.mjs'
import { checkDemo, globBase, collectOutputs } from '../src/checks/demo.mjs'
import { runShell, tail } from '../src/lib/exec.mjs'
import { runChecks, exitCodeFor } from '../src/run.mjs'
import { makeRepo, ctxFor, cleanup } from './helpers.mjs'

after(cleanup)

const MB = 1024 * 1024
const rules = (list) => list.map((f) => f.rule)

test('media budget: per-file and total limits, near-budget notice, large non-media files', () => {
  const over = budget([{ file: 'a.mp4', bytes: 6 * MB }, { file: 'b.png', bytes: 10 * MB }, { file: 'c.txt', bytes: 1 }], { maxFileMB: 5, maxTotalMB: 15 })
  assert.deepEqual(rules(over.findings).sort(), ['media/file-too-large', 'media/file-too-large', 'media/total-too-large'])
  assert.deepEqual(rules(budget([{ file: 'a.gif', bytes: 13 * MB }], { maxFileMB: 20, maxTotalMB: 15 }).findings), ['media/total-near-budget'])
  assert.deepEqual(rules(budget([{ file: 'data.bin', bytes: 11 * MB }]).findings), ['media/large-file'])
  assert.deepEqual(budget([{ file: 'x.png', bytes: MB }]).findings, [])
})

test('media extensions are matched case-insensitively', () => {
  assert.ok(isMedia('docs/Demo.MP4'))
  assert.ok(isMedia('a/b.glb'))
  assert.ok(!isMedia('a/b.mjs'))
})

test('checkMedia counts only committed files', () => {
  const dir = makeRepo('good-skill', { uncommitted: { 'out/huge.png': Buffer.alloc(6 * MB) } })
  const res = checkMedia(ctxFor(dir))
  assert.deepEqual(res.findings, [])
  assert.match(res.note, /1 media files/)
})

test('inferCommands: npm with and without dependencies, pytest, make, nothing', () => {
  const npm = makeRepo('good-skill', { git: false })
  assert.deepEqual(inferCommands(npm), { install: null, test: 'npm test', source: 'package.json scripts.test' })
  const deps = makeRepo(null, { git: false, files: { 'package.json': '{"scripts":{"test":"node --test"},"dependencies":{"x":"1"}}', 'package-lock.json': '{}' } })
  assert.equal(inferCommands(deps).install, 'npm ci --no-audit --no-fund')
  const py = makeRepo(null, { git: false, files: { 'tests/test_a.py': 'def test_a(): pass\n', 'requirements.txt': 'pyyaml\n' } })
  assert.match(inferCommands(py).install, /venv.*-r requirements.txt.*else.*system python3/)
  assert.match(inferCommands(py).test, /pytest/)
  const ci = makeRepo(null, { git: false, files: { '.github/workflows/test.yml': 'jobs:\n  t:\n    steps:\n      - run: npm install --no-audit\n      - run: ./my-skill test\n', 'tests/test_a.py': '' } })
  assert.deepEqual(inferCommands(ci), { install: null, test: './my-skill test', source: 'test step in .github/workflows/test.yml' })
  const make = makeRepo(null, { git: false, files: { Makefile: 'test:\n\techo ok\n' } })
  assert.equal(inferCommands(make).test, 'make test')
  assert.equal(inferCommands(makeRepo(null, { git: false, files: { 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' } })).test, null)
  assert.match(inferCommands(makeRepo(null, { git: false, files: { 'package.json': '{oops' } })).error, /not valid JSON/)
})

test('install: the good fixture passes its tests in a fresh clone, and the clone is removed', async () => {
  const dir = makeRepo('good-skill')
  const base = mkdtempSync(join(tmpdir(), 'skill-ci-base-'))
  const ctx = ctxFor(dir)
  const res = await checkInstall(ctx, { tmpBase: base })
  cleanupClone(ctx)
  assert.deepEqual(res.findings, [])
  assert.equal(res.details.test.code, 0)
  assert.match(res.note, /npm test.*passed/)
  assert.deepEqual(readdirSync(base), [])
})

test('install: a relative temp folder works (the clone lands inside it)', async () => {
  const dir = makeRepo('good-skill')
  const base = mkdtempSync(join(tmpdir(), 'skill-ci-rel-'))
  const prev = process.cwd()
  process.chdir(base)
  try {
    const res = await checkInstall(ctxFor(dir), { tmpBase: '.' })
    assert.deepEqual(res.findings, [])
    assert.equal(res.details.test.code, 0)
  } finally { process.chdir(prev) }
})

test('install: a file that is only in the working copy makes the fresh clone fail', async () => {
  const dir = makeRepo('bad-skill', { uncommitted: { 'local-data.json': '{"ok": true}' } })
  const res = await checkInstall(ctxFor(dir))
  assert.deepEqual(rules(res.findings), ['install/test-failed'])
  assert.match(res.details.test.output, /local-data\.json/)
})

test('install: not a git repo, no commits, no test command, uncommitted changes notice', async () => {
  assert.deepEqual(rules((await checkInstall(ctxFor(makeRepo('good-skill', { git: false })))).findings), ['install/not-git'])
  const noTest = makeRepo(null, { files: { 'README.md': '# x\n' }, uncommitted: { 'README.md': '# changed\n' } })
  assert.deepEqual(rules((await checkInstall(ctxFor(noTest))).findings), ['install/uncommitted', 'install/no-test-command'])
})

test('install: test.command and timeout from the config are used', async () => {
  const dir = makeRepo('good-skill')
  const res = await checkInstall(ctxFor(dir, { test: { command: 'sleep 5', timeout: 0.5 } }))
  assert.deepEqual(rules(res.findings), ['install/test-failed'])
  assert.match(res.findings[0].message, /did not finish within 0.5 s/)
})

test('demo: runs the command and collects fresh outputs', async () => {
  const dir = makeRepo('good-skill')
  const res = await checkDemo(ctxFor(dir, { demo: { command: 'node scripts/hello.mjs out/hello.txt Ada', outputs: ['out/*.txt'] } }))
  assert.deepEqual(res.findings, [])
  assert.equal(res.demoFiles.length, 1)
  assert.ok(existsSync(res.demoFiles[0]))
  assert.equal(res.details.files[0].fresh, true)
})

test('demo: a failing command, no outputs and stale outputs', async () => {
  const dir = makeRepo('good-skill', { files: { 'out/old.txt': 'x' } })
  utimesSync(join(dir, 'out', 'old.txt'), new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3))
  const fail = await checkDemo(ctxFor(dir, { demo: { command: 'exit 3', outputs: ['nothing/*.png'] } }))
  assert.deepEqual(rules(fail.findings), ['demo/failed', 'demo/no-outputs'])
  // committed files are in the clone already; a demo that writes nothing leaves them older than the run
  const stale = await checkDemo(ctxFor(dir, { demo: { command: 'true', outputs: ['docs/*.svg'] } }))
  assert.deepEqual(rules(stale.findings), ['demo/stale-outputs'])
  assert.equal((await checkDemo(ctxFor(dir))).skipped, true)
})

test('globBase and collectOutputs', () => {
  assert.equal(globBase('out/img/*.png'), 'out/img')
  assert.equal(globBase('**/*.png'), '')
  assert.equal(globBase('out/report.html'), 'out')
  const dir = makeRepo(null, { git: false, files: { 'out/a.png': 'a', 'out/sub/b.png': 'b', 'out/c.txt': 'c', 'node_modules/d.png': 'd' } })
  assert.deepEqual(collectOutputs(dir, ['out/**/*.png', '**/*.png']).map((f) => f.file), ['out/a.png', 'out/sub/b.png'])
  assert.deepEqual(collectOutputs(dir, ['out/c.txt']).map((f) => f.file), ['out/c.txt'])
})

test('runShell keeps output, reports exit codes and kills on timeout', async () => {
  const ok = await runShell('echo out; echo err >&2; exit 4', { cwd: tmpdir() })
  assert.equal(ok.code, 4)
  assert.match(ok.output, /out/)
  assert.match(ok.output, /err/)
  const slow = await runShell('sleep 10', { cwd: tmpdir(), timeoutMs: 200 })
  assert.equal(slow.timedOut, true)
  assert.ok(slow.durationMs < 5000)
  assert.equal(tail(Array.from({ length: 50 }, (_, i) => i).join('\n'), 3), '... (47 earlier lines)\n47\n48\n49')
})

test('runChecks on the good fixture: everything passes, including install and demo', async () => {
  const dir = makeRepo('good-skill')
  const report = await runChecks(dir)
  assert.equal(report.result, 'pass', JSON.stringify(report.checks.flatMap((c) => c.findings), null, 1))
  assert.deepEqual(report.checks.map((c) => c.status), ['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass'])
  assert.equal(report.demoFiles.length, 1)
  assert.equal(exitCodeFor(report), 0)
})

test('runChecks on the bad fixture fails every static check; --no-run skips commands', async () => {
  const dir = makeRepo('bad-skill')
  const report = await runChecks(dir, { run: false })
  const status = Object.fromEntries(report.checks.map((c) => [c.id, c.status]))
  assert.deepEqual(status, { 'skill-md': 'fail', readme: 'fail', license: 'fail', secrets: 'pass', footguns: 'warn', media: 'pass', install: 'skip', demo: 'skip' })
  assert.equal(exitCodeFor(report), 1)
  // the SKILL.md home path is reported once, by the SKILL.md check, not again by the secrets scan
  assert.equal(report.checks.flatMap((c) => c.findings).filter((f) => /home-path/.test(f.rule)).length, 1)
})

test('fail-on, disable and turned-off checks change the outcome', async () => {
  const dir = makeRepo('good-skill', { files: { 'scripts/x.sh': 'python3 -c "print(1)"\n' } })
  const warn = await runChecks(dir, { run: false })
  assert.equal(warn.result, 'warn')
  assert.equal(exitCodeFor(warn), 0)
  assert.equal(exitCodeFor(await runChecks(dir, { run: false, failOn: 'warning' })), 1)
  writeFileSync(join(dir, '.skill-ci.yml'), 'disable: [footguns/python-c-without-I]\nchecks:\n  demo: false\n')
  const quiet = await runChecks(dir, { run: false })
  assert.equal(quiet.result, 'pass')
  assert.equal(quiet.checks.find((c) => c.id === 'demo').note, 'turned off in .skill-ci.yml')
})
