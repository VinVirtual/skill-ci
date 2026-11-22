import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { toMarkdown, toConsole, cell, where, linkBaseFrom } from '../src/report/markdown.mjs'
import { annotation, writeOutputs, badge } from '../src/report/github.mjs'
import { markdownToHtml, summaryPage, inline } from '../src/report/html.mjs'
import { makeRepo, cleanup, CLI, cleanEnv } from './helpers.mjs'

after(cleanup)

const report = (over = {}) => ({
  tool: 'skill-ci', version: '0.1.0', root: '/r', name: 'demo-skill', configFile: null, failOn: 'error', result: 'fail', durationMs: 1234,
  totals: { errors: 1, warnings: 1, notices: 0 }, demoFiles: [],
  checks: [
    { id: 'skill-md', title: 'SKILL.md', status: 'fail', note: 'SKILL.md', findings: [{ rule: 'skill-md/name-mismatch', level: 'error', message: 'name "a|b" <script>', file: 'SKILL.md', line: 2, hint: 'Rename it.' }] },
    { id: 'footguns', title: 'Script safety', status: 'warn', note: '', findings: [{ rule: 'footguns/shell-true', level: 'warning', message: '`shell: true` runs a shell', file: 'a b.mjs', line: 7 }] },
    { id: 'install', title: 'Fresh-clone install test', status: 'skip', note: 'commands not run (--no-run)', findings: [] },
  ],
  ...over,
})

test('cell escapes pipes, HTML, Markdown and control characters but leaves code spans readable', () => {
  assert.equal(cell('a|b <x>\nnext'), 'a\\|b &lt;x&gt; next')
  assert.equal(cell('use `a<b|c>` now'), 'use `a<b\\|c>` now')
})

test('markdown summary: headline, check table, findings with rule ids, footer', () => {
  const md = toMarkdown(report())
  assert.match(md, /^## skill-ci: `demo-skill` failed/)
  assert.match(md, /\*\*1 error, 1 warning, 0 notices\*\*/)
  assert.match(md, /\| ✗ fail \| SKILL.md \| 1 \|/)
  assert.match(md, /name "a\\\|b" &lt;script&gt;/)
  assert.match(md, /Fix: Rename it\./)
  assert.match(md, /`skill-md\/name-mismatch`/)
  assert.match(md, /default settings \(no \.skill-ci\.yml\)/)
  assert.ok(!md.includes('<script>'))
})

test('markdown summary links file:line to the commit on GitHub', () => {
  const base = linkBaseFrom({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: 'abc' })
  assert.equal(base, 'https://github.com/o/r/blob/abc/')
  assert.equal(where({ file: 'a b.mjs', line: 7 }, base), '[`a b.mjs:7`](https://github.com/o/r/blob/abc/a%20b.mjs#L7)')
  assert.equal(linkBaseFrom({}), null)
})

test('long finding lists are cut with a pointer to the full list', () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ rule: 'secrets/email', level: 'error', message: `m${i}`, file: 'f', line: i + 1 }))
  const md = toMarkdown(report({ checks: [{ id: 'secrets', title: 'Secrets', status: 'fail', findings: many, note: '' }] }))
  assert.match(md, /and 5 more/)
})

test('test output is folded into a details block', () => {
  const md = toMarkdown(report({ checks: [{ id: 'install', title: 'Fresh-clone install test', status: 'fail', note: '', findings: [], details: { test: { command: 'npm test', code: 1, seconds: 2.1, output: 'not ok 1 ```x```' } } }] }))
  assert.match(md, /<details><summary>Test output: <code>npm test<\/code>, exit 1, 2.1 s<\/summary>/)
  assert.match(md, /````text\nnot ok 1 ```x```\n````/) // the fence is longer than any backtick run inside
})

test('annotations escape newlines, colons and commas', () => {
  assert.equal(annotation({ rule: 'a/b', level: 'warning', message: 'x\ny 100%', file: 'dir,1/f:2.js', line: 3 }), '::warning file=dir%2C1/f%3A2.js,line=3,title=skill-ci a/b::x y 100%25')
  assert.match(annotation({ rule: 'a/b', level: 'notice', message: 'm' }), /^::notice title=/)
  assert.match(annotation({ rule: 'a/b', level: 'error', message: 'm', file: 'f' }, { prefix: 'sub/' }), /file=sub\/f/)
})

test('step outputs use heredoc syntax for multi-line values', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'skill-ci-out-')), 'out')
  writeFileSync(file, '')
  writeOutputs(file, { result: 'pass', 'demo-files': 'a\nb' })
  const text = readFileSync(file, 'utf8')
  assert.match(text, /^result=pass\ndemo-files<<(SKILL_CI_[0-9a-f]+)\na\nb\n\1\n$/)
})

test('badge JSON follows the shields.io endpoint schema', () => {
  assert.deepEqual(badge(report()), { schemaVersion: 1, label: 'skill-ci', message: '1 error', color: 'red' })
  assert.deepEqual(badge(report({ result: 'warn', totals: { errors: 0, warnings: 3, notices: 0 } })), { schemaVersion: 1, label: 'skill-ci', message: 'passing, 3 warnings', color: 'yellow' })
  assert.equal(badge(report({ result: 'pass', totals: { errors: 0, warnings: 0, notices: 0 } })).color, 'brightgreen')
})

test('HTML rendering: tables, status pills, links, code, no raw script tags', () => {
  const md = toMarkdown(report(), { linkBase: 'https://github.com/o/r/blob/abc/' })
  const html = markdownToHtml(md)
  assert.match(html, /<table>/)
  assert.match(html, /<span class="pill fail">✗ fail<\/span>/)
  assert.match(html, /<a href="https:\/\/github.com\/o\/r\/blob\/abc\/SKILL.md#L2"><code>SKILL.md:2<\/code><\/a>/)
  assert.ok(!html.includes('<script>'))
  assert.equal(inline('a <img src=x onerror=alert(1)> b'), 'a &lt;img src=x onerror=alert(1)&gt; b')
  const page = summaryPage(md)
  assert.match(page, /Content-Security-Policy/)
  assert.match(page, /prefers-color-scheme: dark/)
})

test('console report lists checks, findings and the result line', () => {
  const text = toConsole(report())
  assert.match(text, /FAIL SKILL.md/)
  assert.match(text, /error   SKILL.md:2  name "a\|b" <script>  \[skill-md\/name-mismatch\]/)
  assert.match(text, /Result: FAIL  1 error, 1 warning, 0 notices/)
})

const cli = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts })

test('CLI: check on the good fixture exits 0 and writes summary, HTML and badge', () => {
  const dir = makeRepo('good-skill')
  const out = mkdtempSync(join(tmpdir(), 'skill-ci-cli-'))
  const r = cli(['check', dir, '--summary', join(out, 's.md'), '--html', join(out, 's.html'), '--badge', join(out, 'b.json'), '--no-color'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /Result: PASS/)
  assert.match(readFileSync(join(out, 's.md'), 'utf8'), /good-skill` passed/)
  assert.ok(existsSync(join(out, 's.html')))
  assert.equal(JSON.parse(readFileSync(join(out, 'b.json'), 'utf8')).message, 'passing')
})

test('CLI: the bad fixture exits 1; --json prints the report', () => {
  const dir = makeRepo('bad-skill')
  const r = cli(['check', dir, '--json', '--no-run'])
  assert.equal(r.status, 1)
  const rep = JSON.parse(r.stdout)
  assert.equal(rep.result, 'fail')
  assert.ok(rep.totals.errors >= 5)
})

test('CLI: --github writes annotations, the job summary and step outputs', () => {
  const dir = makeRepo('bad-skill')
  const out = mkdtempSync(join(tmpdir(), 'skill-ci-gh-'))
  writeFileSync(join(out, 'summary'), '')
  writeFileSync(join(out, 'output'), '')
  const env = cleanEnv({ GITHUB_STEP_SUMMARY: join(out, 'summary'), GITHUB_OUTPUT: join(out, 'output'), GITHUB_WORKSPACE: dir, GITHUB_REPOSITORY: 'o/bad-skill', GITHUB_SERVER_URL: 'https://github.com', GITHUB_SHA: 'abc' })
  const r = cli(['check', dir, '--github', '--no-run'], { env })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^::error file=SKILL.md,line=2,title=skill-ci skill-md\/name-not-kebab::/m)
  assert.match(readFileSync(join(out, 'summary'), 'utf8'), /blob\/abc\/SKILL.md#L2/)
  assert.match(readFileSync(join(out, 'output'), 'utf8'), /^result=fail$/m)
  assert.match(readFileSync(join(out, 'output'), 'utf8'), /^exit-code=1$/m)
})

test('CLI: usage and config errors exit 2 with a clear message', () => {
  assert.equal(cli(['check', '--fail-on', 'often']).status, 2)
  assert.match(cli(['check', '--bogus']).stderr, /unknown option --bogus/)
  assert.match(cli(['check', '--only', 'nope']).stderr, /unknown check "nope"/)
  assert.match(cli(['check', '--summary']).stderr, /--summary needs a value/)
  assert.match(cli(['check', '/definitely/not/here']).stderr, /not a folder/)
  const dir = makeRepo('good-skill', { files: { '.skill-ci.yml': 'chekcs: {}\n' } })
  const r = cli(['check', dir])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /unknown setting "chekcs" \(did you mean "checks"\?\)/)
})

test('CLI: init writes a starter config once; help and version work', () => {
  const dir = makeRepo(null, { git: false })
  assert.equal(cli(['init', dir]).status, 0)
  assert.ok(existsSync(join(dir, '.skill-ci.yml')))
  assert.match(cli(['init', dir]).stdout, /already exists/)
  assert.match(cli(['help']).stdout, /Usage:/)
  assert.match(cli(['--version']).stdout, /^\d+\.\d+\.\d+/)
  assert.match(cli(['rules']).stdout, /skill-md/)
})
