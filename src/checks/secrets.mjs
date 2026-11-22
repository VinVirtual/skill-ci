// Secrets and personal data in the tree: key formats, private keys, emails, home paths and sensitive files.
import { readFileSync, existsSync } from 'node:fs'
import { posix } from 'node:path'
import { finding, mask, suppressed } from '../lib/context.mjs'
import { globToRegExp, matchesAny } from '../lib/files.mjs'
import { homePaths } from '../lib/markdown.mjs'

/** Key formats with a recognisable prefix. Each is an error. */
export const SECRET_RULES = [
  { id: 'private-key', label: 'private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'aws-access-key', label: 'AWS access key id', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', label: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g },
  { id: 'anthropic-key', label: 'Anthropic API key', re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', label: 'OpenAI API key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|\bsk-proj-[A-Za-z0-9_-]{40,}/g },
  { id: 'slack-token', label: 'Slack token', re: /\bxox[abposr]-[0-9A-Za-z-]{10,}/g },
  { id: 'slack-webhook', label: 'Slack webhook URL', re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/g },
  { id: 'google-api-key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'stripe-key', label: 'Stripe secret key', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g },
  { id: 'huggingface-token', label: 'Hugging Face token', re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { id: 'npm-token', label: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'jwt', label: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: 'url-password', label: 'password in a URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:([^\s:/@'"$<{]{6,})@[\w.-]+/gi },
]

/** key = "value" assignments that look like a hard-coded secret. A warning: these have false positives. */
const ASSIGN_RE = /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|private[_-]?key|password|passwd)["']?\s*[:=]\s*["']([^"'\s]{12,})["']/gi
const PLACEHOLDER_VALUE = /^(?:x+|\*+|\.+)$|your|example|placeholder|changeme|change[_-]me|dummy|redacted|sample|fake|<|\$\{|process\.env|os\.environ|getenv|env\(|\{\{|test[_-]?(key|token|secret)|not[_-]?a[_-]?real|^sk-\.\.\./i

/** Documentation-style fake keys (AWS's own examples contain EXAMPLE) and obvious stand-in URL passwords. */
const PLACEHOLDER_SECRET = /example|dummy|placeholder|redacted|fake|x{8,}/i
const PLACEHOLDER_PASSWORD = /^(?:secret|password|passwd|pass|pwd|hunter2|token|changeme|pa\$\$word)$/i

const EMAIL_RE = /(?<![\w.%+-])[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}(?![\w-])/g
const FILE_EXT_TLD = /\.(png|jpe?g|gif|svg|webp|avif|ico|js|mjs|cjs|ts|tsx|jsx|css|scss|json|py|md|html?|txt|wasm|map|vue|svelte|lock|ya?ml|toml|glb|gltf|stl|obj|mp[34]|wav|zip|gz|sh|rs|go|rb|java|kt|swift|min)$/i
export const DEFAULT_ALLOWED_EMAILS = ['*@users.noreply.github.com', 'noreply@*', 'no-reply@*', '*@noreply.*', '*@example.com', '*@example.org', '*@example.net', '*@*.example.com', '*@*.example.org', '*@*.example.net', '*@*.example', '*@*.test', '*@*.invalid', '*@*.localhost', '*@localhost', 'git@github.com', 'git@gitlab.com', 'git@bitbucket.org']

/** Files whose name says they hold credentials. */
const SENSITIVE_FILES = [
  [/(^|\/)\.env(\.(local|production|prod|development|dev|staging))?$/i, 'environment file'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i, 'SSH private key'],
  [/\.(pem|key|p12|pfx|jks|keystore)$/i, 'key or certificate store'],
  [/(^|\/)\.npmrc$/i, 'npm config (may hold a token)'],
  [/(^|\/)\.netrc$/i, 'netrc credentials'],
  [/(^|\/)credentials(\.json)?$/i, 'credentials file'],
]

const emailGlob = (g) => globToRegExp(g.toLowerCase())

/** True when an email address is a placeholder or allow-listed. */
export function emailAllowed(email, extra = []) {
  const e = email.toLowerCase()
  const domain = e.split('@')[1]
  if (FILE_EXT_TLD.test(domain)) return true
  return [...DEFAULT_ALLOWED_EMAILS, ...extra].some((g) => emailGlob(g).test(e))
}

/** Parses an allowlist file: literal values, /regexes/ and path:<glob> lines. */
export function parseAllowlist(text) {
  const out = { values: [], patterns: [], paths: [] }
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('path:')) out.paths.push(line.slice(5).trim())
    else if (/^\/.+\/[a-z]*$/.test(line)) {
      const end = line.lastIndexOf('/')
      try { out.patterns.push(new RegExp(line.slice(1, end), line.slice(end + 1).replace(/[gy]/g, ''))) } catch { out.values.push(line) }
    } else out.values.push(line)
  }
  return out
}

const allowedValue = (value, allow) => allow.values.includes(value) || allow.patterns.some((re) => re.test(value))

/** Scans one text. -> findings (file and line filled in). */
export function scanText(text, file, { allow = parseAllowlist(''), allowEmails = [], disabled = () => false, skipHomePaths = false } = {}) {
  const out = []
  const lines = text.split(/\r?\n/)
  const add = (rule, level, message, line, value) => {
    if (disabled(rule)) return
    if (value !== undefined && allowedValue(value, allow)) return
    if (suppressed(lines[line - 1] ?? '', rule)) return
    out.push(finding(rule, level, message, { file, line }))
  }
  for (const [k, line] of lines.entries()) {
    const n = k + 1
    if (line.length > 20000) continue
    for (const r of SECRET_RULES) {
      for (const m of line.matchAll(r.re)) {
        const value = m[1] ?? m[0]
        if (r.id !== 'private-key' && PLACEHOLDER_SECRET.test(value)) continue
        if (r.id === 'url-password' && (PLACEHOLDER_VALUE.test(value) || PLACEHOLDER_PASSWORD.test(value))) continue
        add(`secrets/${r.id}`, 'error', `Looks like ${/^[aeiouAEIOU]/.test(r.label) ? 'an' : 'a'} ${r.label}: ${r.id === 'private-key' ? m[0] : mask(value)}.`, n, value)
      }
    }
    for (const m of line.matchAll(ASSIGN_RE)) {
      if (PLACEHOLDER_VALUE.test(m[1]) || /^[a-z]+(?:[._-][a-z]+)*$/.test(m[1])) continue
      add('secrets/hardcoded-credential', 'warning', `A credential seems to be written into the file: ${mask(m[1])}.`, n, m[1])
    }
    for (const m of line.matchAll(EMAIL_RE)) {
      if (emailAllowed(m[0], allowEmails)) continue
      if (/[a-z][a-z0-9+.-]*:\/\/[^\s/@]*$/i.test(line.slice(Math.max(0, m.index - 200), m.index))) continue // user:pass@host in a URL
      const [local, domain] = m[0].split('@')
      add('secrets/email', 'error', `Email address ${local[0]}***@${domain} (personal data in a public repo).`, n, m[0])
    }
  }
  // one finding per user name per file, at its first line, so a log full of one path stays readable
  const homes = new Map()
  for (const h of skipHomePaths ? [] : homePaths(text)) {
    const key = h.user
    if (homes.has(key)) { homes.get(key).count++; continue }
    homes.set(key, { ...h, count: 1, line: text.slice(0, h.index).split('\n').length })
  }
  for (const h of homes.values()) {
    add('secrets/home-path', 'warning', `Absolute home path "${h.match}" reveals the local user name "${h.user}"${h.count > 1 ? ` (${h.count} times in this file)` : ''}.`, h.line, h.match)
  }
  return out
}

export function checkSecrets(ctx) {
  const findings = []
  const listName = ctx.config.secrets.allowlist
  let allow = parseAllowlist('')
  if (listName && existsSync(ctx.abs(listName))) allow = parseAllowlist(readFileSync(ctx.abs(listName), 'utf8'))
  let scanned = 0, skipped = 0
  for (const file of ctx.files) {
    if (file === listName || matchesAny(file, allow.paths)) continue
    for (const [re, what] of SENSITIVE_FILES) {
      if (re.test(file) && !/\.(example|sample|template|dist)$/i.test(file) && !ctx.disabled('secrets/sensitive-file')) {
        findings.push(finding('secrets/sensitive-file', 'error', `${posix.basename(file)} looks like a ${what}; it should not be committed.`, { file, hint: 'Remove it from git (git rm --cached) and add it to .gitignore; rotate anything it held.' }))
      }
    }
    const info = ctx.readInfo(file)
    if (info.text === undefined) { if (info.skipped === 'too-large') skipped++; continue }
    scanned++
    // SKILL.md home paths are already errors in the SKILL.md check
    const skipHomePaths = ctx.config.checks['skill-md'] && file.split('/').pop() === 'SKILL.md'
    findings.push(...scanText(info.text, file, { allow, allowEmails: ctx.config.secrets['allow-emails'], disabled: ctx.disabled, skipHomePaths }))
  }
  if (skipped) findings.push(finding('secrets/not-scanned', 'notice', `${skipped} text file(s) over 2 MB were not scanned.`))
  return { findings, note: `${scanned} files scanned` }
}
