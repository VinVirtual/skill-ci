// .skill-ci.yml: defaults, loading and validation. Unknown keys are errors, so a typo never silently turns a check off.
import { existsSync, lstatSync, openSync, readSync, closeSync, constants } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { parseYaml, YamlError } from './yaml.mjs'
import { globToRegExp } from './files.mjs'
import { cleanLine } from './sanitize.mjs'

export const CONFIG_FILES = ['.skill-ci.yml', '.skill-ci.yaml']

export const CHECK_IDS = ['skill-md', 'readme', 'license', 'secrets', 'footguns', 'media', 'install', 'demo']

export const DEFAULTS = Object.freeze({
  name: null,
  skills: null,
  ignore: [],
  disable: [],
  'fail-on': 'error',
  checks: Object.fromEntries(CHECK_IDS.map((id) => [id, true])),
  test: { install: null, command: null, timeout: 600 },
  demo: { command: null, outputs: [], timeout: 600 },
  media: { 'max-file-mb': 5, 'max-total-mb': 15, 'max-other-file-mb': 10, 'max-repo-mb': 50 },
  'max-runtime': 1800,
  secrets: { allowlist: '.skill-ci-allow', 'allow-emails': [] },
  footguns: { ignore: ['vendor/**', 'third_party/**', '**/*.min.js', 'dist/**'] },
})

export class ConfigError extends Error {}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v)

/** Closest known key, for "did you mean" hints. */
function closest(key, options) {
  let best = null, bestScore = Infinity
  for (const o of options) {
    const d = editDistance(key, o)
    if (d < bestScore) { best = o; bestScore = d }
  }
  return bestScore <= Math.max(2, Math.floor(key.length / 3)) ? best : null
}

export function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, k) => k)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

const KINDS = {
  name: 'string?', skills: 'strings?', ignore: 'strings', disable: 'strings', 'fail-on': 'enum:error|warning|never',
  'checks.*': 'boolean',
  'test.install': 'string?', 'test.command': 'string?', 'test.timeout': 'seconds',
  'demo.command': 'string?', 'demo.outputs': 'strings', 'demo.timeout': 'seconds',
  'media.max-file-mb': 'positive', 'media.max-total-mb': 'positive', 'media.max-other-file-mb': 'positive', 'media.max-repo-mb': 'positive',
  'max-runtime': 'seconds',
  'secrets.allowlist': 'string?', 'secrets.allow-emails': 'strings',
  'footguns.ignore': 'strings',
}

function checkKind(path, value) {
  const kind = KINDS[path] ?? KINDS[path.replace(/\.[^.]+$/, '.*')]
  const bad = (want) => new ConfigError(`${path} must be ${want}, not ${typeOf(value)}${typeof value === 'string' ? ` "${cleanLine(value).slice(0, 60)}"` : ''}`)
  if (kind === 'string?') { if (value !== null && typeof value !== 'string') throw bad('text'); return value }
  if (kind === 'boolean') { if (typeof value !== 'boolean') throw bad('true or false'); return value }
  if (kind === 'seconds' || kind === 'positive') { if (typeof value !== 'number' || !(value > 0) || !Number.isFinite(value)) throw bad('a number above 0'); return value }
  if (kind?.startsWith('enum:')) { const opts = kind.slice(5).split('|'); if (!opts.includes(value)) throw bad(`one of ${opts.join(', ')}`); return value }
  if (kind === 'strings' || kind === 'strings?') {
    if (value === null && kind === 'strings?') return null
    const list = typeof value === 'string' ? [value] : value
    if (!Array.isArray(list) || list.some((v) => typeof v !== 'string' || v === '')) throw bad('a list of text values')
    return list
  }
  throw new ConfigError(`unknown setting ${path}`)
}

/** Merges a parsed config over the defaults, validating every key. */
export function resolveConfig(user = {}) {
  if (user === null) user = {}
  if (typeOf(user) !== 'object') throw new ConfigError('the config must be a map of settings')
  const out = structuredClone({ ...DEFAULTS, checks: { ...DEFAULTS.checks } })
  for (const [key, value] of Object.entries(user)) {
    if (!(key in DEFAULTS)) {
      const hint = closest(key, Object.keys(DEFAULTS))
      throw new ConfigError(`unknown setting "${cleanLine(key).slice(0, 60)}"${hint ? ` (did you mean "${hint}"?)` : ''}`)
    }
    const def = DEFAULTS[key]
    if (def && typeof def === 'object' && !Array.isArray(def)) {
      if (value === null) continue
      if (typeOf(value) !== 'object') throw new ConfigError(`${key} must be a map of settings, not ${typeOf(value)}`)
      for (const [sub, v] of Object.entries(value)) {
        if (!(sub in def)) {
          const hint = closest(sub, Object.keys(def))
          throw new ConfigError(`unknown setting "${cleanLine(key)}.${cleanLine(sub).slice(0, 60)}"${hint ? ` (did you mean "${key}.${hint}"?)` : ''}`)
        }
        out[key][sub] = checkKind(`${key}.${sub}`, v)
      }
    } else out[key] = checkKind(key, value)
  }
  if (out.name !== null && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(out.name)) throw new ConfigError(`name "${out.name}" must be kebab-case (lowercase letters, digits and hyphens)`)
  if (out.demo.command && out.demo.outputs.length === 0) throw new ConfigError('demo.outputs must list the files the demo writes (globs such as "out/*.png")')
  for (const g of [...out.demo.outputs, ...(out.skills ?? [])]) {
    if (isAbsolute(g) || g.split('/').includes('..')) throw new ConfigError(`"${cleanLine(g).slice(0, 60)}" must be a path inside the repository`)
    if (g.split('/').includes('.git')) throw new ConfigError('demo.outputs and skills may not point into .git')
  }
  for (const g of [...out.ignore, ...out.demo.outputs, ...out.footguns.ignore, ...out.secrets['allow-emails']]) {
    try { globToRegExp(g) } catch (e) { throw new ConfigError(e.message) }
  }
  return out
}

export const MAX_CONFIG_BYTES = 64 * 1024

/** Reads a config file: a regular file (never a symlink, which could point outside the repo), at most 64 KB. */
export function readConfigText(file) {
  const st = lstatSync(file)
  if (st.isSymbolicLink()) throw new ConfigError('the config file is a symbolic link; it must be a regular file in the repository')
  if (!st.isFile()) throw new ConfigError('the config path is not a regular file')
  if (st.size > MAX_CONFIG_BYTES) throw new ConfigError(`the config file is over ${MAX_CONFIG_BYTES / 1024} KB`)
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try { const buf = Buffer.alloc(st.size); readSync(fd, buf, 0, st.size, 0); return buf.toString('utf8') } finally { closeSync(fd) }
}

/** Finds and reads the config. -> { config, file } (file null when none). Throws ConfigError on a bad file. */
export function loadConfig(root, explicit = null) {
  const candidates = explicit ? [isAbsolute(explicit) ? explicit : join(root, explicit)] : CONFIG_FILES.map((f) => join(root, f))
  for (const file of candidates) {
    if (!existsSync(file)) { if (explicit) throw new ConfigError(`config file not found: ${cleanLine(explicit)}`); continue }
    let parsed
    try { parsed = parseYaml(readConfigText(file)) } catch (e) {
      if (e instanceof YamlError) throw new ConfigError(`${explicit ?? file.slice(root.length + 1)} ${e.message}`)
      throw e
    }
    try { return { config: resolveConfig(parsed), file } } catch (e) {
      if (e instanceof ConfigError) throw new ConfigError(`${explicit ?? file.slice(root.length + 1)}: ${e.message}`)
      throw e
    }
  }
  return { config: resolveConfig({}), file: null }
}

/** The starter config written by `skill-ci init`. */
export const STARTER_CONFIG = `# skill-ci settings. Every key is optional; these are the defaults unless noted.
# Pull requests can edit this file. For untrusted pull requests run with --lock-config (action input
# lock-config: "true"), which ignores ignore, disable, fail-on, checks, allowlists and inline allow comments.
# name: my-skill            # expected SKILL.md name (default: the repository or folder name)
# skills: [ "." ]           # folders that hold a SKILL.md (default: every SKILL.md in the repo)
ignore: []                  # globs left out of every check, e.g. "tests/fixtures/**"
disable: []                 # rule ids to turn off, e.g. "readme/no-licence-section"
fail-on: error              # error | warning | never

checks:                     # turn whole checks on or off
  skill-md: true
  readme: true
  license: true
  secrets: true
  footguns: true
  media: true
  install: true             # clone the repo to a temp folder and run the test command
  demo: true                # only runs when demo.command is set

test:
  install: null             # e.g. "npm ci" (default: worked out from package.json / requirements files)
  command: null             # e.g. "npm test" (default: worked out from package.json, pytest or a Makefile)
  timeout: 600              # seconds

demo:
  command: null             # e.g. "./bin/demo --out out"
  outputs: []               # globs of files the demo writes; uploaded as workflow artifacts
  timeout: 600

media:
  max-file-mb: 5            # any committed image, video, audio, 3D model, archive or model weight
  max-total-mb: 15          # all of those together
  max-other-file-mb: 10     # any other committed file
  max-repo-mb: 50           # everything committed

max-runtime: 1800           # seconds for all repository commands together

secrets:
  allowlist: .skill-ci-allow   # one value per line; "path:<glob>" skips files
  allow-emails: []             # e.g. "*@your-company.example"
`
