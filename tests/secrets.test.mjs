import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { scanText, emailAllowed, parseAllowlist, checkSecrets } from '../src/checks/secrets.mjs'
import { mask } from '../src/lib/context.mjs'
import { makeRepo, ctxFor, cleanup, FAKE } from './helpers.mjs'

after(cleanup)

const rules = (list) => list.map((f) => f.rule)

test('key formats are found with their line and never printed in full', () => {
  const text = `a = 1\nkey = "${FAKE.aws}"\ntoken: ${FAKE.github}\nx=${FAKE.anthropic}\n${FAKE.slack}\n${FAKE.google}\n`
  const out = scanText(text, 'config.js')
  assert.deepEqual(rules(out), ['secrets/aws-access-key', 'secrets/github-token', 'secrets/anthropic-key', 'secrets/slack-token', 'secrets/google-api-key'])
  assert.deepEqual(out.map((f) => f.line), [2, 3, 4, 5, 6])
  for (const f of out) for (const v of Object.values(FAKE)) assert.ok(!f.message.includes(v), `${f.rule} leaks the value`)
})

test('documentation placeholders are not reported: EXAMPLE keys and stand-in URL passwords', () => {
  assert.deepEqual(scanText('AKIA' + 'IOSFODNN7EXAMPLE', 'docs.md'), [])
  assert.deepEqual(scanText('ghp_' + 'EXAMPLEexample0123456789abcdefghijkl', 'docs.md'), [])
  assert.deepEqual(scanText('https://user:' + 'secret' + '@github.com/acme/tool', 'a.js'), [])
})

test('private key blocks are found', () => {
  const out = scanText(`x\n${FAKE.privateKey}\n`, 'id')
  assert.deepEqual(rules(out), ['secrets/private-key'])
  assert.equal(out[0].line, 2)
})

test('personal emails are errors and masked; noreply and example addresses are fine', () => {
  const out = scanText(`Contact ${FAKE.email}\nCommits: 123+x@users.noreply.github.com\nTest: a@example.com, noreply@company.io, git@github.com:o/r.git\n`, 'README.md')
  assert.deepEqual(rules(out), ['secrets/email'])
  assert.ok(!out[0].message.includes(FAKE.email))
  assert.match(out[0].message, /at mailbox-co\.net/)
})

test('things that only look like emails are not flagged', () => {
  for (const s of ['icon@2x.png', 'react@18.3.1', '@types/node', 'pkg@1.2.3', 'logo@3x.webp', 'foo@bar.mjs'])
    assert.deepEqual(scanText(s, 'f'), [], s)
})

test('a password inside a URL is one finding, not also an email', () => {
  const out = scanText('db = "postgres://admin:' + 's3cr3tpass' + '@db.internal/app"', 'f')
  assert.deepEqual(rules(out), ['secrets/url-password'])
})

test('hard-coded credential assignments are warnings; placeholders and env lookups are not', () => {
  assert.deepEqual(rules(scanText('const password = "' + 'Tr0ub4dor&3xyz' + '"', 'a.js')), ['secrets/hardcoded-credential'])
  assert.equal(scanText('api_key = "' + 'Zx81Hq20Lm55Kp' + '"', 'a.py')[0].level, 'warning')
  for (const s of ['password = "your-password-here"', 'api_key: "${API_KEY}"', 'token = "process.env.TOKEN"', 'password: "xxxxxxxxxxxxxxxx"', 'secret_key = "changeme-please"'])
    assert.deepEqual(scanText(s, 'a.js'), [], s)
})

test('home paths are warnings in the tree scan', () => {
  const out = scanText(`cd ${FAKE.home}/work\n`, 'notes.md')
  assert.deepEqual(rules(out), ['secrets/home-path'])
  assert.equal(out[0].level, 'warning')
})

test('allowlist: literal values, /regex/ lines and path: globs', () => {
  const allow = parseAllowlist(`# comment\n${FAKE.aws}\n/^ghp_/\npath:tests/**\n`)
  assert.deepEqual(allow.paths, ['tests/**'])
  assert.deepEqual(scanText(`${FAKE.aws} ${FAKE.github}`, 'a', { allow }), [])
})

test('inline "skill-ci: allow" suppresses a line, optionally only for named rules', () => {
  assert.deepEqual(scanText(`k = "${FAKE.aws}" # skill-ci: allow`, 'a'), [])
  assert.deepEqual(scanText(`k = "${FAKE.aws}" # skill-ci: allow secrets/aws-access-key`, 'a'), [])
  assert.deepEqual(rules(scanText(`k = "${FAKE.aws}" # skill-ci: allow secrets/email`, 'a')), ['secrets/aws-access-key'])
})

test('allow-emails globs and the default allowed domains', () => {
  assert.ok(emailAllowed('me@corp.example'))
  assert.ok(emailAllowed('dev@team.test'))
  assert.ok(emailAllowed('a' + '@mycorp.io', ['*@mycorp.io']))
  assert.ok(!emailAllowed(FAKE.email))
})

test('checkSecrets walks the repo, flags sensitive files and honours the allowlist file', () => {
  const dir = makeRepo('good-skill', { files: { 'config.js': `export const k = "${FAKE.aws}"\n`, '.env': 'TOKEN=1\n', 'keys/deploy.pem': 'x', 'notes.md': `mail ${FAKE.email}\n` } })
  const res = checkSecrets(ctxFor(dir))
  assert.deepEqual(rules(res.findings).sort(), ['secrets/aws-access-key', 'secrets/email', 'secrets/sensitive-file', 'secrets/sensitive-file'])
  const allowed = makeRepo('good-skill', { files: { 'config.js': `export const k = "${FAKE.aws}"\n`, '.skill-ci-allow': `${FAKE.aws}\n` } })
  assert.deepEqual(checkSecrets(ctxFor(allowed)).findings, [])
})

test('binary files are skipped; .env.example is not a sensitive file', () => {
  const dir = makeRepo(null, { files: { 'img.bin': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(FAKE.aws)]), '.env.example': 'TOKEN=\n' } })
  assert.deepEqual(checkSecrets(ctxFor(dir)).findings, [])
})

test('mask shows no character of the value, only its length', () => {
  assert.equal(mask('abcdefghij'), '[hidden, 10 chars]')
  assert.ok(!mask('ghp_secretvalue').includes('ghp'))
})
