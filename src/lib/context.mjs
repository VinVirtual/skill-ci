// What every check receives: the repo root, its config, its file list and cached readers.
import { basename, join, posix } from 'node:path'
import { realpathSync } from 'node:fs'
import { listFiles, dirsOf, matchesAny, readText } from './files.mjs'

export const LEVELS = ['error', 'warning', 'notice']

/** A finding. rule is "check/rule-id"; file is posix-relative; line is 1-based. */
export function finding(rule, level, message, extra = {}) {
  if (!LEVELS.includes(level)) throw new Error(`bad level ${level}`)
  return { rule, level, message, ...extra }
}

/** Works out the repository name: config, then $GITHUB_REPOSITORY when it is this checkout, then the folder name. */
export function repoNameFor(root, config, env = process.env) {
  if (config.name) return config.name
  let real = root
  try { real = realpathSync(root) } catch {}
  if (env.GITHUB_REPOSITORY && env.GITHUB_WORKSPACE) {
    let ws = env.GITHUB_WORKSPACE
    try { ws = realpathSync(ws) } catch {}
    if (ws === real) return env.GITHUB_REPOSITORY.split('/').pop()
  }
  return basename(real)
}

export function buildContext(root, config, { env = process.env, listing } = {}) {
  const list = listing ?? listFiles(root)
  const ignored = (rel) => matchesAny(rel, config.ignore)
  const files = list.files.filter((f) => !ignored(f))
  const all = new Set(list.files)
  const dirs = dirsOf(list.files)
  const cache = new Map()
  return {
    root,
    config,
    env,
    isGit: list.git,
    repoName: repoNameFor(root, config, env),
    files,
    tracked: list.tracked,
    ignored,
    abs: (rel) => join(root, ...rel.split('/')),
    /** Text of a listed file, or null for binary, huge or unreadable files. */
    read(rel) {
      if (!cache.has(rel)) cache.set(rel, readText(join(root, ...rel.split('/'))))
      return cache.get(rel).text ?? null
    },
    readInfo(rel) {
      if (!cache.has(rel)) cache.set(rel, readText(join(root, ...rel.split('/'))))
      return cache.get(rel)
    },
    /** True when a path (file or folder) is part of the repo as a fresh clone would have it. */
    exists(rel) {
      const p = posix.normalize(rel).replace(/\/$/, '')
      return all.has(p) || dirs.has(p)
    },
    disabled: (rule) => config.disable.includes(rule) || config.disable.includes(rule.split('/')[0]),
  }
}

/** Status of a check from its findings. */
export function statusOf(findings) {
  if (findings.some((f) => f.level === 'error')) return 'fail'
  if (findings.some((f) => f.level === 'warning')) return 'warn'
  return 'pass'
}

/** Masks a secret for display: the first 4 characters, then its length. */
export function mask(value) {
  const v = String(value)
  if (v.length <= 6) return '*'.repeat(v.length)
  return `${v.slice(0, 4)}${'*'.repeat(4)} (${v.length} chars)`
}

/** Line number (1-based) of a character offset. */
export function lineAt(text, offset) {
  let n = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/** Inline suppression comment: "skill-ci: allow" (optionally followed by rule ids). */
export function suppressed(lineText, rule) {
  const m = lineText.match(/skill-ci:\s*allow\b([^\n]*)/i)
  if (!m) return false
  const ids = m[1].match(/[a-z0-9-]+\/[a-z0-9-]+/g)
  return !ids || ids.includes(rule)
}
