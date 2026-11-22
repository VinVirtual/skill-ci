// Test helpers: throwaway copies of the fixtures as real git repositories, and fake secrets built at run time
// (so no secret-looking string is ever committed in this repository).
import { cpSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/lib/config.mjs'
import { buildContext } from '../src/lib/context.mjs'

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
export const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs')

const made = []
export function cleanup() { while (made.length) rmSync(made.pop(), { recursive: true, force: true }) }

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=skill-ci test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' })

/**
 * Copies a fixture (or starts empty) into a temp folder called `name`, writes extra files, and commits.
 * options: { name, files: { path: text }, uncommitted: { path: text }, git: true }
 */
export function makeRepo(fixture, { name = fixture ?? 'some-skill', files = {}, uncommitted = {}, git: useGit = true } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'skill-ci-test-'))
  made.push(parent)
  const dir = join(parent, name)
  if (fixture) cpSync(join(FIXTURES, fixture), dir, { recursive: true })
  else mkdirSync(dir, { recursive: true })
  const write = (map) => { for (const [p, text] of Object.entries(map)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), text) } }
  write(files)
  if (useGit) {
    git(dir, 'init', '-q')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'fixture', '--allow-empty')
  }
  write(uncommitted)
  return dir
}

/** Fake credentials, assembled so this file itself contains none. */
export const FAKE = {
  aws: 'AKIA' + 'Q3J7RW2KL9MZ8TV4',
  github: 'ghp' + '_' + 'a1B2c3D4e5F6g7H8i9J0'.repeat(2).slice(0, 36),
  anthropic: 'sk-' + 'ant-api03-' + 'k9Lm2Pq7Rs' + 'Y7z'.repeat(10),
  privateKey: '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END ' + 'OPENSSH PRIVATE KEY-----',
  email: 'jane.' + 'maintainer' + '@' + 'mailbox-co.net',
  slack: 'xox' + 'b-' + '123456789012-abcdefABCDEF',
  google: 'AIza' + 'Sy' + 'A'.repeat(33),
  home: '/' + 'home/' + 'alice',
  macHome: '/' + 'Users/' + 'bob',
}

/** A context over a folder, as the checks receive it. */
export function ctxFor(dir, user = {}) {
  return buildContext(dir, resolveConfig(user), { env: {} })
}
