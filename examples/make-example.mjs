#!/usr/bin/env node
// Rebuilds examples/output/ and the screenshots in docs/ by running skill-ci on the two test fixtures:
//   good-skill: a tidy skill with tests and a demo; every check passes.
//   bad-skill:  broken on purpose, plus fake credentials planted here (built at run time, never committed)
//               and a data file its tests need that is left uncommitted, so the fresh-clone test fails.
// Usage: node examples/make-example.mjs        (needs git; screenshots need playwright-core and Chrome)
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { screenshot } from '../scripts/screenshot.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'examples', 'output')
const work = mkdtempSync(join(tmpdir(), 'skill-ci-example-'))

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Example Maintainer', '-c', 'user.email=maintainer@users.noreply.github.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' })

function repo(fixture, extra = {}, uncommitted = {}) {
  const dir = join(work, fixture)
  cpSync(join(ROOT, 'tests', 'fixtures', fixture), dir, { recursive: true })
  for (const [p, text] of Object.entries(extra)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), text) }
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'Example skill')
  for (const [p, text] of Object.entries(uncommitted)) writeFileSync(join(dir, p), text)
  return dir
}

// Fake values, assembled so that no secret-looking string is stored in this repository.
const fakeKey = 'AKIA' + 'Q3J7RW2KL9MZ8TV4'
const fakeMail = 'jordan.' + 'lee' + '@' + 'quietmail.net'

async function run(name, dir) {
  const out = join(OUT, name)
  mkdirSync(out, { recursive: true })
  const r = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.mjs'), 'check', dir, '--no-color', '--verbose',
    '--summary', join(out, 'summary.md'), '--html', join(out, 'summary.html'), '--badge', join(out, 'badge.json')], { encoding: 'utf8' })
  // the console report shows the temp folder; keep the copy in the repo free of machine paths
  writeFileSync(join(out, 'console.txt'), r.stdout.split(dir).join(name).split(work).join('<tmp>'))
  console.log(`${name}: exit ${r.status}`)
  return out
}

try {
  const good = repo('good-skill')
  const bad = repo('bad-skill', {
    'config.js': `// TODO: move to an environment variable\nexport const AWS_KEY = '${fakeKey}'\n`,
    'notes/maintainers.md': `# Maintainers\n\nQuestions: ${fakeMail}\n`,
  }, { 'local-data.json': '{ "ok": true }\n' })
  const goodOut = await run('good-skill', good)
  const badOut = await run('bad-skill', bad)
  for (const f of ['summary.md', 'summary.html']) {
    const p = join(badOut, f)
    writeFileSync(p, readFileSync(p, 'utf8').split(work).join('/tmp/skill-ci-example'))
  }
  if (process.argv.includes('--no-screenshots')) process.exit(0)
  await screenshot(join(badOut, 'summary.html'), join(ROOT, 'docs', 'summary.png'))
  await screenshot(join(goodOut, 'summary.html'), join(ROOT, 'docs', 'summary-pass.png'))
  console.log('wrote docs/summary.png and docs/summary-pass.png')
} finally {
  rmSync(work, { recursive: true, force: true })
}
