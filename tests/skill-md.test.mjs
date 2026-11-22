import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { lintSkill, checkSkillMd, toKebab } from '../src/checks/skill-md.mjs'
import { makeRepo, ctxFor, cleanup, FAKE } from './helpers.mjs'

after(cleanup)

const GOOD_DESC = 'Writes greeting files for names. Use when the user asks for a greeting file or says "greet Ada".'
const skill = (fm, body = '\n# x\n\nDo the thing.\n') => `---\n${fm}\n---\n${body}`
const rules = (res) => res.findings.map((f) => f.rule)

test('a well-formed SKILL.md has no findings', () => {
  assert.deepEqual(lintSkill(skill(`name: greet\ndescription: ${GOOD_DESC}`), { expectedName: 'greet' }).findings, [])
})

test('no frontmatter, unclosed frontmatter and invalid YAML are errors', () => {
  assert.deepEqual(rules(lintSkill('# just markdown\n')), ['skill-md/no-frontmatter'])
  assert.deepEqual(rules(lintSkill('---\nname: x\n')), ['skill-md/frontmatter-unclosed'])
  const bad = lintSkill('---\nname: x\nname: y\n---\nbody')
  assert.deepEqual(rules(bad), ['skill-md/frontmatter-yaml'])
  assert.equal(bad.findings[0].line, 3)
})

test('name: missing, not kebab-case, too long, reserved word', () => {
  assert.ok(rules(lintSkill(skill(`description: ${GOOD_DESC}`))).includes('skill-md/name-missing'))
  const notKebab = lintSkill(skill(`name: My_Skill\ndescription: ${GOOD_DESC}`))
  assert.ok(rules(notKebab).includes('skill-md/name-not-kebab'))
  assert.match(notKebab.findings.find((f) => f.rule === 'skill-md/name-not-kebab').hint, /my-skill/)
  assert.ok(rules(lintSkill(skill(`name: ${'a'.repeat(65)}\ndescription: ${GOOD_DESC}`))).includes('skill-md/name-too-long'))
  assert.ok(rules(lintSkill(skill(`name: claude-helper\ndescription: ${GOOD_DESC}`))).includes('skill-md/name-reserved'))
  assert.ok(rules(lintSkill(skill(`name: a--b\ndescription: ${GOOD_DESC}`))).includes('skill-md/name-not-kebab'))
  assert.ok(rules(lintSkill(skill(`name: 42\ndescription: ${GOOD_DESC}`))).includes('skill-md/name-not-text'))
})

test('name must match the folder (or repository) name, on the name line', () => {
  const res = lintSkill(skill(`description: ${GOOD_DESC}\nname: greeter`), { expectedName: 'greet' })
  const f = res.findings.find((x) => x.rule === 'skill-md/name-mismatch')
  assert.ok(f)
  assert.equal(f.line, 3)
  assert.match(f.message, /"greeter".*"greet"/)
})

test('description: missing, empty, too long (counted in characters), XML tags', () => {
  assert.ok(rules(lintSkill(skill('name: a'))).includes('skill-md/description-missing'))
  assert.ok(rules(lintSkill(skill('name: a\ndescription: ""'))).includes('skill-md/description-missing'))
  const long = lintSkill(skill(`name: a\ndescription: ${'é'.repeat(1025)}`))
  assert.ok(rules(long).includes('skill-md/description-too-long'))
  assert.match(long.findings.find((f) => f.rule === 'skill-md/description-too-long').message, /1025 characters/)
  assert.ok(!rules(lintSkill(skill(`name: a\ndescription: ${'Use when x. '.repeat(85)}`))).includes('skill-md/description-too-long'))
  assert.ok(rules(lintSkill(skill(`name: a\ndescription: Makes <b>bold</b> text. Use when asked.`))).includes('skill-md/description-xml'))
})

test('a folded (>) description is measured after folding', () => {
  const res = lintSkill(skill(`name: a\ndescription: >\n  Writes greeting files.\n  Use when the user asks for one.`))
  assert.deepEqual(rules(res), [])
})

test('description warnings: too short, no "when to use"', () => {
  assert.ok(rules(lintSkill(skill('name: a\ndescription: Greets.'))).includes('skill-md/description-short'))
  assert.ok(rules(lintSkill(skill('name: a\ndescription: Writes greeting files for names in several languages and styles.'))).includes('skill-md/description-no-trigger'))
})

test('an empty body is an error; a very long body is a warning', () => {
  assert.ok(rules(lintSkill(`---\nname: a\ndescription: ${GOOD_DESC}\n---\n\n  \n`)).includes('skill-md/body-empty'))
  assert.ok(rules(lintSkill(skill(`name: a\ndescription: ${GOOD_DESC}`, '\n' + 'line\n'.repeat(501)))).includes('skill-md/body-long'))
})

test('absolute home paths are errors with their line; placeholders are fine', () => {
  const res = lintSkill(skill(`name: a\ndescription: ${GOOD_DESC}`, `\nRun ${FAKE.home}/bin/x.\nOr ${FAKE.macHome}/y/z.\nNot /home/you/x or ~/x.\n`))
  const homes = res.findings.filter((f) => f.rule === 'skill-md/home-path')
  assert.deepEqual(homes.map((f) => f.line), [6, 7])
})

test('links to missing files are errors; URLs and anchors are ignored; existing files pass', () => {
  const exists = (p) => ['references/a.md', 'references', 'docs', 'docs/x.png'].includes(p)
  const body = '\n[a](references/a.md) [b](references/b.md) [w](https://example.com/x) [h](#top) ![i](docs/x.png) ![j](docs/y.png)\n'
  const res = lintSkill(skill(`name: a\ndescription: ${GOOD_DESC}`, body), { exists })
  const missing = res.findings.filter((f) => f.rule === 'skill-md/missing-file')
  assert.deepEqual(missing.map((f) => f.message.match(/"([^"]+)"/)[1]), ['references/b.md', 'docs/y.png'])
  assert.equal(missing[0].line, 6)
})

test('inline-code paths are checked only under folders the skill has, with skill-root prefixes removed', () => {
  const exists = (p) => ['scripts', 'scripts/run.sh', 'references', 'references/x.md'].includes(p)
  const body = '\n`scripts/run.sh` `$S/scripts/gone.sh` `~/.claude/skills/a/references/x.md` `~/.claude/skills/a/references/nope.md` `evals/cases.jsonl` `scripts/*.sh` `~/.claude/skills/other/scripts/q.sh`\n'
  const res = lintSkill(skill(`name: a\ndescription: ${GOOD_DESC}`, body), { exists })
  assert.deepEqual(res.findings.filter((f) => f.rule === 'skill-md/missing-path').map((f) => f.message.match(/`([^`]+)`/)[1]), ['$S/scripts/gone.sh', '~/.claude/skills/a/references/nope.md'])
})

test('links inside fenced code blocks are not checked', () => {
  const res = lintSkill(skill(`name: a\ndescription: ${GOOD_DESC}`, '\n```md\n[x](missing.md)\n```\n'), { exists: () => false })
  assert.deepEqual(rules(res), [])
})

test('checkSkillMd: the good fixture passes; root SKILL.md must match the repository name', () => {
  const good = makeRepo('good-skill')
  assert.deepEqual(checkSkillMd(ctxFor(good)).findings, [])
  const renamed = makeRepo('good-skill', { name: 'greeting-tool' })
  assert.deepEqual(checkSkillMd(ctxFor(renamed)).findings.map((f) => f.rule), ['skill-md/name-mismatch'])
  assert.deepEqual(checkSkillMd(ctxFor(renamed, { name: 'good-skill' })).findings, [])
})

test('checkSkillMd: multi-skill repos match each skill to its folder and catch duplicate names', () => {
  const s = (n) => skill(`name: ${n}\ndescription: ${GOOD_DESC}`)
  const dir = makeRepo(null, { name: 'pack', files: { 'skills/alpha/SKILL.md': s('alpha'), 'skills/beta/SKILL.md': s('alpha'), 'tests/fixtures/x/SKILL.md': '# ignored' } })
  const res = checkSkillMd(ctxFor(dir, { ignore: ['tests/fixtures/**'] }))
  assert.deepEqual(res.findings.map((f) => f.rule).sort(), ['skill-md/duplicate-name', 'skill-md/name-mismatch'])
  assert.equal(res.note, '2 skills')
})

test('checkSkillMd: no SKILL.md at all is an error', () => {
  const dir = makeRepo(null, { files: { 'README.md': '# x' } })
  assert.deepEqual(checkSkillMd(ctxFor(dir)).findings.map((f) => f.rule), ['skill-md/missing'])
})

test('checkSkillMd: the bad fixture shows every SKILL.md problem', () => {
  const dir = makeRepo('bad-skill')
  const got = new Set(checkSkillMd(ctxFor(dir)).findings.map((f) => f.rule))
  for (const r of ['skill-md/name-not-kebab', 'skill-md/name-mismatch', 'skill-md/description-missing', 'skill-md/home-path', 'skill-md/missing-file', 'skill-md/missing-path']) assert.ok(got.has(r), r)
})

test('toKebab suggests a usable name', () => {
  assert.equal(toKebab('My_Skill'), 'my-skill')
  assert.equal(toKebab('PDFTools v2'), 'pdftools-v2')
  assert.equal(toKebab('!!!'), 'my-skill')
})
