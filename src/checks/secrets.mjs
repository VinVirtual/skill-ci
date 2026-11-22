// Secrets and personal data in the tree: key formats, private keys, emails, home paths and sensitive files.
// Every pattern has bounded repetition, long lines are scanned in overlapping chunks (never skipped), and the
// whole scan runs inside a time budget, so a hostile repository can neither hide a key nor stall the job.
import { posix } from 'node:path'
import { finding, mask, suppressed } from '../lib/context.mjs'
import { globToRegExp, matchesAny, readText, MAX_TEXT_BYTES } from '../lib/files.mjs'
import { homePaths } from '../lib/markdown.mjs'
import { chunks, LINE_CHUNK } from '../lib/sanitize.mjs'

/** Key formats with a recognisable prefix. level defaults to error. */
export const SECRET_RULES = [
  { id: 'private-key', label: 'private key', re: /-----BEGIN (?:[A-Z0-9]{1,20} ){0,4}PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'aws-access-key', label: 'AWS access key id', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { id: 'aws-secret-key', label: 'AWS secret access key', re: /\baws_?secret_?access_?key["']?\s{0,5}[:=]\s{0,5}["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi },
  { id: 'github-token', label: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g },
  { id: 'gitlab-token', label: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,64}\b/g },
  { id: 'anthropic-key', label: 'Anthropic API key', re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,300}/g },
  { id: 'openai-key', label: 'OpenAI API key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,200}T3BlbkFJ[A-Za-z0-9_-]{20,200}|\bsk-proj-[A-Za-z0-9_-]{40,300}|\bsk-[A-Za-z0-9]{48}\b/g },
  { id: 'openrouter-key', label: 'OpenRouter key', re: /\bsk-or-v1-[a-f0-9]{64}\b/g },
  { id: 'groq-key', label: 'Groq API key', re: /\bgsk_[A-Za-z0-9]{52}\b/g },
  { id: 'slack-token', label: 'Slack token', re: /\bxox[abposr]-[0-9A-Za-z-]{10,200}/g },
  { id: 'slack-webhook', label: 'Slack webhook URL', re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{1,20}\/B[A-Z0-9]{1,20}\/[A-Za-z0-9]{20,64}/g },
  { id: 'discord-bot-token', label: 'Discord bot token', re: /\b[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,38}\b/g },
  { id: 'telegram-bot-token', label: 'Telegram bot token', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  { id: 'google-api-key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'stripe-key', label: 'Stripe secret key', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,200}\b/g },
  { id: 'stripe-test-key', label: 'Stripe test key', level: 'warning', re: /\b(?:sk|rk)_test_[0-9A-Za-z]{20,200}\b/g },
  { id: 'sendgrid-key', label: 'SendGrid API key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { id: 'twilio-key', label: 'Twilio API key', re: /\bSK[0-9a-fA-F]{32}\b/g },
  { id: 'huggingface-token', label: 'Hugging Face token', re: /\bhf_[A-Za-z0-9]{30,64}\b/g },
  { id: 'npm-token', label: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'npm-auth-token', label: 'npm _authToken', re: /_authToken\s{0,5}=\s{0,5}["']?([^\s"'$]{10,200})/g },
  { id: 'pypi-token', label: 'PyPI token', re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,300}/g },
  { id: 'digitalocean-token', label: 'DigitalOcean token', re: /\bdo[pro]_v1_[a-f0-9]{64}\b/g },
  { id: 'azure-storage-key', label: 'Azure storage account key', re: /\bAccountKey=([A-Za-z0-9+/=]{40,100})/g },
  { id: 'bearer-token', label: 'bearer token in an Authorization header', re: /\bAuthorization["']?\s{0,5}[:=]\s{0,5}["']?Bearer\s{1,5}([A-Za-z0-9._~+/=-]{20,500})/gi },
  { id: 'jwt', label: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,2000}\.eyJ[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,2000}/g },
  { id: 'url-password', label: 'password in a URL', re: /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@'"]{1,128}:([^\s:/@'"$<{]{6,128})@[\w.-]{1,253}/gi },
]

/** key = value assignments that look like a hard-coded secret (quoted, or unquoted in env/YAML style). Warnings. */
const ASSIGN_QUOTED = /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|private[_-]?key|password|passwd)["']?\s{0,5}[:=]\s{0,5}["']([^"'\s]{12,200})["']/gi
const ASSIGN_BARE = /(?:^|[\s;{,])(?:export\s+)?(?:[A-Z0-9_]{0,40}(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)|api[_-]?key|password|passwd|secret|token)\s{0,5}[:=]\s{0,5}([^\s"'#,;)(\]{}$<>`]{12,200})(?=\s|$|[;,])/gi
const PLACEHOLDER_VALUE = /^(?:x+|\*+|\.+)$|your|example|placeholder|changeme|change[_-]me|dummy|redacted|sample|fake|<|\$\{|process\.env|os\.environ|getenv|env\(|\{\{|test[_-]?(key|token|secret)|not[_-]?a[_-]?real|^sk-\.\.\./i
/** Documentation-style fake keys (AWS's own examples contain EXAMPLE) and obvious stand-in URL passwords. */
const PLACEHOLDER_SECRET = /example|dummy|placeholder|redacted|fake|x{8,}/i
const PLACEHOLDER_PASSWORD = /^(?:secret|password|passwd|pass|pwd|hunter2|token|changeme|pa\$\$word)$/i

const EMAIL_RE = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}][\p{L}\p{N}._%+-]{0,63}@[\p{L}][\p{L}\p{N}-]{0,62}(?:\.[\p{L}\p{N}-]{1,63}){0,8}\.[\p{L}]{2,24}(?![\p{L}\p{N}-])/gu
const FILE_EXT_TLD = /\.(png|jpe?g|gif|svg|webp|avif|ico|js|mjs|cjs|ts|tsx|jsx|css|scss|json|py|md|html?|txt|wasm|map|vue|svelte|lock|ya?ml|toml|glb|gltf|stl|obj|mp[34]|wav|zip|gz|sh|rs|go|rb|java|kt|swift|min)$/i
export const DEFAULT_ALLOWED_EMAILS = ['*@users.noreply.github.com', 'noreply@*', 'no-reply@*', '*@noreply.*', '*@example.com', '*@example.org', '*@example.net', '*@*.example.com', '*@*.example.org', '*@*.example.net', '*@*.example', '*@*.test', '*@*.invalid', '*@*.localhost', '*@localhost', 'git@github.com', 'git@gitlab.com', 'git@bitbucket.org']

/** Files whose name says they hold credentials. */
const SENSITIVE_FILES = [
  [/(^|\/)\.env(\.(local|production|prod|development|dev|staging))?$/i, 'environment file'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i, 'SSH private key'],
  [/\.(pem|key|p12|pfx|jks|keystore)$/i, 'key or certificate store'],
  [/(^|\/)\.npmrc$/i, 'npm config (may hold a token)'],
  [/(^|\/)\.pypirc$/i, 'PyPI config (may hold a token)'],
  [/(^|\/)\.netrc$/i, 'netrc credentials'],
  [/(^|\/)credentials(\.json)?$/i, 'credentials file'],
]

export { LINE_CHUNK }
export const SCAN_BUDGET_MS = 60000
const MAX_ALLOW_REGEX = 200

const emailGlob = (g) => globToRegExp(g.toLowerCase())

/** True when an email address is a placeholder, a version string or allow-listed. */
export function emailAllowed(email, extra = []) {
  const e = email.toLowerCase()
  const domain = e.split('@')[1]
  if (FILE_EXT_TLD.test(domain)) return true
  if (domain.split('.').some((label) => /^\d+$/.test(label))) return true // pkg@v1.2.3.beta, a version, not a host
  return [...DEFAULT_ALLOWED_EMAILS, ...extra].some((g) => { try { return emailGlob(g).test(e) } catch { return false } })
}

/** True when a user regex has a quantified group that is itself quantified (catastrophic backtracking). */
export const riskyRegex = (src) => /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(src)

/** Parses an allowlist file: literal values, /regexes/ (short, without nested quantifiers) and path:<glob> lines. */
export function parseAllowlist(text) {
  const out = { values: [], patterns: [], paths: [], rejected: [] }
  for (const raw of String(text).split(/\r?\n/).slice(0, 2000)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('path:')) out.paths.push(line.slice(5).trim())
    else if (/^\/.+\/[a-z]*$/.test(line)) {
      const end = line.lastIndexOf('/')
      const src = line.slice(1, end)
      if (src.length > MAX_ALLOW_REGEX || riskyRegex(src)) { out.rejected.push(line.slice(0, 40)); continue }
      try { out.patterns.push(new RegExp(src, line.slice(end + 1).replace(/[gy]/g, ''))) } catch { out.values.push(line) }
    } else out.values.push(line)
  }
  return out
}

const allowedValue = (value, allow) => allow.values.includes(value) || allow.patterns.some((re) => re.test(String(value).slice(0, 600)))

export { chunks }

/** Lines of 64 base64 characters in a row: the body of a PEM key whose header was removed. */
const PEM_BODY_LINE = /^\s{0,8}[A-Za-z0-9+/]{64}\s*$/
const PEM_RUN = 5

/** Scans one text. -> findings (file and line filled in). */
export function scanText(text, file, { allow = parseAllowlist(''), allowEmails = [], disabled = () => false, skipHomePaths = false, allowInline = true } = {}) {
  const out = []
  const seen = new Set()
  const lines = text.split(/\r?\n/)
  const add = (rule, level, message, line, value) => {
    if (disabled(rule)) return
    if (value !== undefined && allowedValue(value, allow)) return
    if (suppressed(lines[line - 1] ?? '', rule, allowInline)) return
    const key = `${rule}\0${line}\0${value ?? message}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(finding(rule, level, message, { file, line }))
  }
  let pemRun = 0
  for (const [k, line] of lines.entries()) {
    const n = k + 1
    if (PEM_BODY_LINE.test(line)) { if (++pemRun === PEM_RUN) add('secrets/key-body', 'warning', `${PEM_RUN} or more lines of 64 base64 characters in a row: possibly a key body without its BEGIN line.`, n - PEM_RUN + 1) }
    else pemRun = 0
    const found = new Set()
    for (const { text: piece, offset } of chunks(line)) {
      for (const r of SECRET_RULES) {
        for (const m of piece.matchAll(r.re)) {
          const value = m[1] ?? m[0]
          if (r.id !== 'private-key' && PLACEHOLDER_SECRET.test(value)) continue
          if ((r.id === 'url-password' || r.id === 'npm-auth-token' || r.id === 'bearer-token') && (PLACEHOLDER_VALUE.test(value) || PLACEHOLDER_PASSWORD.test(value))) continue
          found.add(value)
          add(`secrets/${r.id}`, r.level ?? 'error', `Looks like ${/^[aeiouAEIOU]/.test(r.label) ? 'an' : 'a'} ${r.label}: ${r.id === 'private-key' ? m[0] : mask(value)}.`, n, value)
        }
      }
      for (const re of [ASSIGN_QUOTED, ASSIGN_BARE]) {
        for (const m of piece.matchAll(re)) {
          const v = m[1]
          if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(v)) continue // a URL, not a credential (passwords in URLs have their own rule)
          if (found.has(v) || [...found].some((f) => v.includes(f)) || PLACEHOLDER_VALUE.test(v) || /^[a-z]+(?:[._-][a-z]+)*$/.test(v)) continue
          if (re === ASSIGN_BARE && !(/[A-Za-z]/.test(v) && /\d/.test(v)) ) continue
          if (re === ASSIGN_BARE && /[./]/.test(v) && !/[+=]/.test(v) && /^[\w./-]+$/.test(v) && /\.\w{2,4}$/.test(v)) continue // a file name
          add('secrets/hardcoded-credential', 'warning', `A credential seems to be written into the file: ${mask(v)}.`, n, v)
        }
      }
      for (const m of piece.matchAll(EMAIL_RE)) {
        if (emailAllowed(m[0], allowEmails)) continue
        const at = offset + m.index
        if (/[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/@]{0,128}$/i.test(line.slice(Math.max(0, at - 200), at))) continue // user:pass@host in a URL
        const domain = m[0].split('@')[1]
        add('secrets/email', 'error', `Email address at ${domain} (personal data in a public repo).`, n, m[0])
      }
    }
  }
  // one finding per user name per file, at its first line, so a log full of one path stays readable
  const homes = new Map()
  for (const h of skipHomePaths ? [] : homePaths(text)) {
    if (homes.has(h.user)) { homes.get(h.user).count++; continue }
    homes.set(h.user, { ...h, count: 1, line: text.slice(0, h.index).split('\n').length })
  }
  for (const h of homes.values()) {
    add('secrets/home-path', 'warning', `Absolute home path "${h.match}" reveals the local user name "${h.user}"${h.count > 1 ? ` (${h.count} times in this file)` : ''}.`, h.line, h.match)
  }
  return out
}

/** Replaces anything that looks like a secret or an email in free text (command output) before it is published. */
export function redactText(text) {
  let s = String(text)
  // a private key block: everything from BEGIN to END (or to the end of the output) goes
  s = s.replace(/-----BEGIN (?:[A-Z0-9]{1,20} ){0,4}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{1,60}-----|$)/g, '[redacted private key]')
  for (const r of SECRET_RULES) s = s.replace(r.re, (m, g1) => (typeof g1 === 'string' && g1 ? m.replace(g1, `[redacted ${r.label}]`) : `[redacted ${r.label}]`))
  s = s.replace(/\b(Authorization["']?\s{0,5}[:=]\s{0,5}["']?(?:Basic|Bearer|Token|Digest)\s{1,5})[^\s"']{4,500}/gi, '$1[redacted]')
  s = s.replace(/\b((?:Set-)?Cookie["']?\s{0,5}[:=]\s{0,5})[^\n]{1,2000}/gi, '$1[redacted]')
  s = s.replace(ASSIGN_QUOTED, (m, v) => m.replace(v, '[redacted]'))
  s = s.replace(ASSIGN_BARE, (m, v) => m.replace(v, '[redacted]'))
  // a bare 40-character AWS secret on a line that talks about AWS or secrets
  s = s.split('\n').map((line) => (/aws|secret/i.test(line) ? line.replace(/(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g, '[redacted]') : line)).join('\n')
  // PEM-style bodies without a header: runs of 64-character base64 lines
  s = s.replace(/(?:^[ \t]{0,8}[A-Za-z0-9+/]{64}[ \t]*\n){4,}(?:^[ \t]{0,8}[A-Za-z0-9+/=]{1,64}[ \t]*$\n?)?/gm, '[redacted key body]\n')
  s = s.replace(EMAIL_RE, (m) => (emailAllowed(m) ? m : '[redacted email]'))
  return s
}

/** Anything that could not be scanned is an error: a secret could hide there. */
function unscanned(file, info) {
  if (info.skipped === 'too-large') return finding('secrets/not-scanned', 'error', `Not scanned: over ${MAX_TEXT_BYTES / 1024 / 1024} MB. Remove it or keep it out of the repository.`, { file })
  if (info.skipped === 'unreadable' || info.skipped === 'binary') return finding('secrets/not-scanned', 'error', 'Not scanned: could not be read.', { file })
  return null
}

/** Key formats only, over the printable strings of a binary file (emails and paths there are mostly metadata). */
export function scanStrings(strings, file, { allow = parseAllowlist(''), disabled = () => false } = {}) {
  const out = []
  const seen = new Set()
  for (const line of strings.split('\n')) {
    for (const { text: piece } of chunks(line)) {
      for (const r of SECRET_RULES) {
        for (const m of piece.matchAll(r.re)) {
          const value = m[1] ?? m[0]
          const rule = `secrets/${r.id}`
          if (disabled(rule) || PLACEHOLDER_SECRET.test(value) && r.id !== 'private-key' || allowedValue(value, allow) || seen.has(rule + value)) continue
          seen.add(rule + value)
          out.push(finding(rule, r.level ?? 'error', `Looks like ${/^[aeiouAEIOU]/.test(r.label) ? 'an' : 'a'} ${r.label} inside a binary file: ${r.id === 'private-key' ? m[0] : mask(value)}.`, { file }))
        }
      }
    }
  }
  return out
}

export function checkSecrets(ctx, { budgetMs = SCAN_BUDGET_MS } = {}) {
  const findings = []
  const listName = ctx.config.secrets.allowlist
  let allow = parseAllowlist('')
  if (listName && ctx.exists(listName)) {
    const info = readText(ctx.abs(listName))
    if (info.text !== undefined) allow = parseAllowlist(info.text.slice(0, 256 * 1024))
    for (const r of allow.rejected) findings.push(finding('secrets/allowlist-regex', 'warning', `Allowlist regex refused (longer than ${MAX_ALLOW_REGEX} characters or with nested repetition): ${r}...`, { file: listName }))
  }
  for (const link of ctx.symlinks) findings.push(finding('secrets/symlink', 'notice', 'Symbolic link: not followed, not scanned.', { file: link }))
  const deadline = Date.now() + budgetMs
  let scanned = 0, left = 0
  for (const file of ctx.files) {
    if (file === listName || matchesAny(file, allow.paths)) continue
    for (const [re, what] of SENSITIVE_FILES) {
      if (re.test(file) && !/\.(example|sample|template|dist)$/i.test(file) && !ctx.disabled('secrets/sensitive-file')) {
        findings.push(finding('secrets/sensitive-file', 'error', `${posix.basename(file)} looks like a ${what}; it should not be committed.`, { file, hint: 'Remove it from git (git rm --cached) and add it to .gitignore; rotate anything it held.' }))
      }
    }
    if (Date.now() > deadline) { left++; continue }
    const info = ctx.readInfo(file)
    if (info.text === undefined && typeof info.strings === 'string') { scanned++; findings.push(...scanStrings(info.strings, file, { allow, disabled: ctx.disabled })); continue }
    if (info.text === undefined) { const f = unscanned(file, info); if (f) findings.push(f); continue }
    scanned++
    // SKILL.md home paths are already errors in the SKILL.md check
    const skipHomePaths = ctx.config.checks['skill-md'] && file.split('/').pop() === 'SKILL.md'
    findings.push(...scanText(info.text, file, { allow, allowEmails: ctx.config.secrets['allow-emails'], disabled: ctx.disabled, skipHomePaths, allowInline: ctx.allowInline }))
  }
  if (left) findings.push(finding('secrets/not-scanned', 'error', `The scan ran out of its ${Math.round(budgetMs / 1000)} s budget; ${left} file(s) were not scanned.`))
  return { findings, note: `${scanned} files scanned` }
}

