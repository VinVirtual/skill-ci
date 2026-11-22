import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig, loadConfig, ConfigError, DEFAULTS, STARTER_CONFIG } from '../src/lib/config.mjs'
import { parseYaml } from '../src/lib/yaml.mjs'
import { globToRegExp, matchesAny, listFiles } from '../src/lib/files.mjs'
import { makeRepo, cleanup } from './helpers.mjs'

after(cleanup)

test('defaults: every check on, fail on errors, 15 MB media budget', () => {
  const c = resolveConfig({})
  assert.equal(c['fail-on'], 'error')
  assert.ok(Object.values(c.checks).every(Boolean))
  assert.equal(c.media['max-total-mb'], 15)
  assert.equal(c.test.command, null)
})

test('user values merge over defaults without touching the defaults object', () => {
  const c = resolveConfig({ checks: { install: false }, media: { 'max-file-mb': 2 } })
  assert.equal(c.checks.install, false)
  assert.equal(c.checks.demo, true)
  assert.equal(c.media['max-file-mb'], 2)
  assert.equal(c.media['max-total-mb'], 15)
  assert.equal(DEFAULTS.checks.install, true)
})

test('an unknown key is an error with a did-you-mean hint', () => {
  assert.throws(() => resolveConfig({ ignroe: [] }), (e) => e instanceof ConfigError && /did you mean "ignore"/.test(e.message))
  assert.throws(() => resolveConfig({ checks: { instal: false } }), /did you mean "checks.install"/)
})

test('wrong types are errors that name the setting', () => {
  assert.throws(() => resolveConfig({ checks: { install: 'no' } }), /checks.install must be true or false/)
  assert.throws(() => resolveConfig({ test: { timeout: -5 } }), /test.timeout must be a number above 0/)
  assert.throws(() => resolveConfig({ 'fail-on': 'sometimes' }), /fail-on must be one of error, warning, never/)
  assert.throws(() => resolveConfig({ ignore: [1, 2] }), /list of text values/)
})

test('a single string is accepted where a list is expected', () => {
  assert.deepEqual(resolveConfig({ ignore: 'vendor/**' }).ignore, ['vendor/**'])
})

test('name must be kebab-case; demo needs outputs; paths stay inside the repo', () => {
  assert.throws(() => resolveConfig({ name: 'My Skill' }), /kebab-case/)
  assert.throws(() => resolveConfig({ demo: { command: 'make demo' } }), /demo.outputs/)
  assert.throws(() => resolveConfig({ demo: { command: 'x', outputs: ['../secret/*'] } }), /inside the repository/)
})

test('the starter config parses and validates', () => {
  const c = resolveConfig(parseYaml(STARTER_CONFIG))
  assert.equal(c.media['max-total-mb'], 15)
})

test('loadConfig reads .skill-ci.yml and reports YAML errors with the file and line', () => {
  const dir = makeRepo(null, { git: false, files: { '.skill-ci.yml': 'checks:\n  demo: false\n' } })
  assert.equal(loadConfig(dir).config.checks.demo, false)
  writeFileSync(join(dir, '.skill-ci.yml'), 'a: 1\na: 2\n')
  assert.throws(() => loadConfig(dir), (e) => e instanceof ConfigError && /\.skill-ci\.yml line 2/.test(e.message))
  assert.throws(() => loadConfig(dir, 'nope.yml'), /not found/)
})

test('globs: *, **, ?, braces and any-depth names', () => {
  assert.ok(globToRegExp('*.md').test('README.md'))
  assert.ok(globToRegExp('*.md').test('docs/deep/x.md'))
  assert.ok(!globToRegExp('docs/*.md').test('docs/a/b.md'))
  assert.ok(globToRegExp('docs/**/*.md').test('docs/a/b.md'))
  assert.ok(globToRegExp('docs/**/*.md').test('docs/b.md'))
  assert.ok(globToRegExp('tests/fixtures/**').test('tests/fixtures/a/b/c.txt'))
  assert.ok(globToRegExp('out/*.{png,jpg}').test('out/a.jpg'))
  assert.ok(globToRegExp('file?.txt').test('file1.txt'))
  assert.ok(globToRegExp('vendor/').test('vendor/x/y.js'))
  assert.ok(matchesAny('a/b.min.js', ['**/*.min.js']))
})

test('listFiles in git: tracked plus untracked-but-not-ignored, never ignored files', () => {
  const dir = makeRepo(null, { files: { 'a.txt': 'a', '.gitignore': 'secret.txt\n' }, uncommitted: { 'b.txt': 'b', 'secret.txt': 's' } })
  const l = listFiles(dir)
  assert.equal(l.git, true)
  assert.deepEqual(l.files, ['.gitignore', 'a.txt', 'b.txt'])
  assert.ok(l.tracked.has('a.txt') && !l.tracked.has('b.txt'))
})

test('listFiles without git walks the tree and skips node_modules and .venv', () => {
  const dir = makeRepo(null, { git: false, files: { 'a.txt': 'a', 'node_modules/x/i.js': '', '.venv/bin/p': '', 'sub/c.md': '' } })
  assert.deepEqual(listFiles(dir).files, ['a.txt', 'sub/c.md'])
})
