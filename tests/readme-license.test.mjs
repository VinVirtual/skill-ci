import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lintReadme, cloneTarget, checkReadme, installLines } from '../src/checks/readme.mjs'
import { lintLicense, detectLicense, checkLicense } from '../src/checks/license.mjs'
import { makeRepo, ctxFor, cleanup, FIXTURES } from './helpers.mjs'

after(cleanup)

const rules = (list) => list.map((f) => f.rule)
const filler = '\n\nThis skill does a useful thing for people who need it, and this paragraph pads the README past the short limit so only the rule under test fires.\n'

test('the good fixture README has no findings', () => {
  assert.deepEqual(checkReadme(ctxFor(makeRepo('good-skill'))).findings, [])
})

test('a missing README is an error', () => {
  assert.deepEqual(rules(checkReadme(ctxFor(makeRepo(null, { files: { 'x.txt': '' } }))).findings), ['readme/missing'])
})

test('no install command and no licence mention are warnings; a short README is flagged', () => {
  const got = rules(lintReadme('# x\n\nDoes things.\n', { name: 'x' }))
  assert.deepEqual(got.sort(), ['readme/no-install', 'readme/no-licence-section', 'readme/too-short'])
})

test('install command forms are recognised', () => {
  for (const cmd of ['git clone https://github.com/a/b ~/.claude/skills/b', 'npx skills add a/b', 'pip install foo', '/plugin install foo@bar', 'claude plugin install foo', 'cp -r foo ~/.claude/skills/'])
    assert.equal(installLines(`# t\n\n    ${cmd}\n`).length, 1, cmd)
})

test('git clone into ~/.claude/skills must land in a folder named like the skill', () => {
  const md = '# good-skill\n\n```bash\ngit clone https://github.com/o/good-skill ~/.claude/skills/goodskill\n```\n\nLicense: MIT' + filler
  const f = lintReadme(md, { name: 'good-skill' }).find((x) => x.rule === 'readme/install-folder')
  assert.ok(f)
  assert.equal(f.line, 4)
  assert.equal(f.level, 'error')
})

test('cloning another skill (a dependency) into its own folder is fine', () => {
  const md = '# good-skill\n\n    git clone https://github.com/o/good-skill ~/.claude/skills/good-skill\n    git clone https://github.com/o/helper-skill ~/.claude/skills/helper-skill\n\nLicense: MIT' + filler
  assert.deepEqual(lintReadme(md, { name: 'good-skill' }), [])
})

test('cloneTarget understands options, .git suffixes and default folders', () => {
  assert.deepEqual(cloneTarget('git clone --depth 1 https://github.com/o/r.git ~/.claude/skills/r'), { url: 'https://github.com/o/r.git', repo: 'r', folder: 'r', explicit: true })
  assert.equal(cloneTarget('git clone git@github.com:o/thing.git').folder, 'thing')
  assert.equal(cloneTarget('nothing here'), null)
})

test('missing README images are errors, missing links warnings, badge workflow must exist', () => {
  const md = '# x\n\n![d](docs/demo.gif)\n[g](guide.md)\n[![test](https://github.com/o/x/actions/workflows/test.yml/badge.svg)](https://github.com/o/x/actions)\n\ngit clone https://github.com/o/x ~/.claude/skills/x\nLicense MIT' + filler
  const out = lintReadme(md, { name: 'x', exists: () => false })
  assert.deepEqual(rules(out).sort(), ['readme/badge-workflow', 'readme/missing-file', 'readme/missing-image'])
  assert.equal(out.find((f) => f.rule === 'readme/missing-image').level, 'error')
})

test('detectLicense recognises common licences', () => {
  assert.equal(detectLicense(readFileSync(join(FIXTURES, 'good-skill', 'LICENSE'), 'utf8')), 'MIT')
  assert.equal(detectLicense('Apache License\n Version 2.0, January 2004'), 'Apache-2.0')
  assert.equal(detectLicense('GNU GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007'), 'GPL-3.0')
  assert.equal(detectLicense('This is free and unencumbered software released into the public domain.'), 'Unlicense')
  assert.equal(detectLicense('All rights reserved.'), null)
})

test('licence placeholders and a missing copyright line are warnings', () => {
  const mit = readFileSync(join(FIXTURES, 'good-skill', 'LICENSE'), 'utf8')
  assert.deepEqual(rules(lintLicense(mit.replace('2026 Example Maintainer', '[year] [fullname]')).findings), ['license/placeholder', 'license/no-copyright'])
  assert.deepEqual(lintLicense(mit).findings, [])
})

test('package.json licence must agree with LICENSE', () => {
  const mit = readFileSync(join(FIXTURES, 'good-skill', 'LICENSE'), 'utf8')
  assert.deepEqual(rules(lintLicense(mit, { packageJson: '{"license":"Apache-2.0"}' }).findings), ['license/package-mismatch'])
  assert.deepEqual(lintLicense(mit, { packageJson: '{"license":"MIT"}' }).findings, [])
})

test('missing and empty LICENSE files are errors; unknown text is a notice', () => {
  assert.deepEqual(rules(checkLicense(ctxFor(makeRepo('bad-skill'))).findings), ['license/missing'])
  assert.deepEqual(rules(lintLicense('  \n').findings), ['license/empty'])
  assert.deepEqual(lintLicense('Custom terms. Copyright 2026 A.').findings.map((f) => f.level), ['notice'])
})
