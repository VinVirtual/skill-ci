// Markdown helpers: relative links, inline-code paths and absolute home paths, with line numbers.
import { posix } from 'node:path'

/** Lines of a Markdown text with a flag for lines inside fenced code blocks. */
export function markdownLines(text) {
  const out = []
  let fence = null
  for (const [k, line] of String(text).split(/\r?\n/).entries()) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (m) {
      if (!fence) { fence = m[1]; out.push({ line, n: k + 1, code: true }); continue }
      if (m[1][0] === fence[0] && m[1].length >= fence.length) { fence = null; out.push({ line, n: k + 1, code: true }); continue }
    }
    out.push({ line, n: k + 1, code: Boolean(fence) })
  }
  return out
}

const LINK_RE = /(!?)\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*["')])?\s*\)/g
const HTML_SRC_RE = /<(?:img|a|source|video)\b[^>]*?\s(?:src|href)\s*=\s*["']([^"']+)["']/gi

/** Relative link targets outside code: { target, line, image }. URLs, mail links and #anchors are left out. */
export function relativeLinks(text) {
  const out = []
  for (const { line, n, code } of markdownLines(text)) {
    if (code) continue
    const plain = line.replace(/`[^`]*`/g, '')
    for (const m of plain.matchAll(LINK_RE)) push(m[2], n, m[1] === '!')
    for (const m of plain.matchAll(HTML_SRC_RE)) push(m[1], n, /^<(img|source|video)/i.test(m[0]))
  }
  function push(raw, n, image) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#') || raw.startsWith('//')) return
    let target = raw.split('#')[0].split('?')[0]
    try { target = decodeURIComponent(target) } catch {}
    if (target) out.push({ target, line: n, image })
  }
  return out
}

/** Inline-code tokens that look like paths: { token, line }. Fenced blocks are left out. */
export function codePaths(text) {
  const out = []
  for (const { line, n, code } of markdownLines(text)) {
    if (code) continue
    for (const m of line.matchAll(/`([^`\s]+)`/g)) {
      const t = m[1]
      if (/[*<>{}|$]/.test(t.replace(/^(\$\{?\w+\}?|~\/\.claude\/skills\/[\w.-]+)\//, ''))) continue
      if (!t.includes('/') || /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^@/.test(t)) continue
      out.push({ token: t, line: n })
    }
  }
  return out
}

/** Strips the prefixes skills use to mean "this skill's folder": $VAR/, ${VAR}/, ~/.claude/skills/<name>/, ./ */
export function stripSkillPrefix(token, name) {
  let t = token
  const m = t.match(/^(\$\{?[A-Za-z_]\w*\}?)\//)
  if (m) t = t.slice(m[0].length)
  const home = t.match(/^~\/\.claude\/skills\/([\w.-]+)\//)
  if (home) { if (name && home[1] !== name) return null; t = t.slice(home[0].length) }
  else if (t.startsWith('~') || t.startsWith('/')) return null
  return t.replace(/^\.\//, '')
}

/** Resolves a link against the file that holds it. Returns null when it climbs out of the repo. */
export function resolveFrom(fileRel, target) {
  if (target.startsWith('/')) return posix.normalize(target.slice(1))
  const p = posix.normalize(posix.join(posix.dirname(fileRel), target))
  return p.startsWith('..') ? null : p
}

const PLACEHOLDER_USERS = new Set(['you', 'your-name', 'yourname', 'your_name', 'user', 'username', 'me', 'runner', 'name', 'example', 'someone', 'shared', 'USER', 'USERNAME', 'yourusername', 'your-user'])

/** Absolute home-folder paths that name a real-looking user: { match, user, index }. */
export function homePaths(text) {
  const out = []
  const re = /(?<![\w.~$-])(?:\/home\/|\/Users\/|[A-Za-z]:\\\\?Users\\\\?)([A-Za-z0-9._-]+)(?=[\\/])/g
  for (const m of String(text).matchAll(re)) {
    if (PLACEHOLDER_USERS.has(m[1]) || PLACEHOLDER_USERS.has(m[1].toLowerCase())) continue
    out.push({ match: m[0], user: m[1], index: m.index })
  }
  return out
}
