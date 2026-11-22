// SKILL.md: frontmatter, name, description, body, referenced files and home paths.
import { posix } from 'node:path'
import { splitFrontmatter } from '../lib/yaml.mjs'
import { finding, lineAt } from '../lib/context.mjs'
import { relativeLinks, codePaths, stripSkillPrefix, resolveFrom, homePaths } from '../lib/markdown.mjs'
import { matchesAny } from '../lib/files.mjs'

export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const MAX_NAME = 64
export const MAX_DESCRIPTION = 1024
export const MAX_BODY_LINES = 500
export const MAX_MARKDOWN = 1024 * 1024
const RESERVED = ['anthropic', 'claude']
const WHEN_RE = /\b(use (it |this |this skill )?(when|whenever|for|to|if|on)|when (the user|you|someone|a user|asked)|trigger|whenever|asks? (for|to|about))\b/i

/** SKILL.md files the repo holds: config.skills folders, or every SKILL.md that is not ignored. */
export function findSkillFiles(ctx) {
  if (ctx.config.skills) return ctx.config.skills.map((d) => posix.join(posix.normalize(d), 'SKILL.md').replace(/^\.\//, ''))
  return ctx.files.filter((f) => posix.basename(f) === 'SKILL.md')
}

/** Lints one SKILL.md text. expectedName is the folder (or repo) name the skill must carry. */
export function lintSkill(text, { file = 'SKILL.md', expectedName = null, exists = () => true, nameSource = 'folder' } = {}) {
  const out = []
  const add = (rule, level, message, line, extra = {}) => out.push(finding(`skill-md/${rule}`, level, message, { file, line, ...extra }))
  const fm = splitFrontmatter(text)
  if (fm.unclosed) { add('frontmatter-unclosed', 'error', 'The frontmatter starts with --- but has no closing --- line.', 1); return { findings: out } }
  if (!fm.present) {
    add('no-frontmatter', 'error', 'SKILL.md must start with YAML frontmatter (--- name: ... description: ... ---).', 1, { hint: 'Put "---", "name: <skill-name>", "description: <what it does and when to use it>", "---" at the very top.' })
    return { findings: out }
  }
  if (fm.error) { add('frontmatter-yaml', 'error', `The frontmatter is not valid YAML: ${fm.error}.`, fm.errorLine); return { findings: out } }
  const data = fm.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) { add('frontmatter-not-map', 'error', 'The frontmatter must be a map with name and description.', 2); return { findings: out } }
  const fmLines = text.split(/\r?\n/).slice(0, fm.bodyLine - 1)
  const keyLine = (k) => { const i = fmLines.findIndex((l) => l.startsWith(`${k}:`)); return i >= 0 ? i + 1 : 1 }

  const { name, description } = data
  if (name === undefined || name === null || name === '') add('name-missing', 'error', 'The frontmatter has no name.', 1, { hint: expectedName ? `Add "name: ${expectedName}".` : undefined })
  else if (typeof name !== 'string') add('name-not-text', 'error', `name must be text, not ${typeof name}.`, keyLine('name'))
  else {
    const line = keyLine('name')
    if (name.length > MAX_NAME) add('name-too-long', 'error', `name is ${name.length} characters; the limit is ${MAX_NAME}.`, line)
    if (!NAME_RE.test(name)) add('name-not-kebab', 'error', `name "${name}" is not kebab-case (lowercase letters, digits and single hyphens).`, line, { hint: `Try "${toKebab(name)}".` })
    const reserved = RESERVED.find((r) => name.includes(r))
    if (reserved) add('name-reserved', 'warning', `name contains the reserved word "${reserved}"; the Claude API refuses such skill names on upload.`, line)
    if (expectedName && name !== expectedName) add('name-mismatch', 'error', `name "${name}" does not match the ${nameSource} name "${expectedName}".`, line, { hint: `Claude Code finds a skill by its folder; installing with git clone gives the folder the repository's name. Rename one so both read "${expectedName}" or "${name}".` })
  }

  if (description === undefined || description === null || (typeof description === 'string' && description.trim() === '')) {
    add('description-missing', 'error', 'The frontmatter has no description; Claude uses it to decide when to load the skill.', 1)
  } else if (typeof description !== 'string') add('description-not-text', 'error', `description must be text, not ${typeof description}.`, keyLine('description'))
  else {
    const line = keyLine('description')
    const len = [...description].length
    if (len > MAX_DESCRIPTION) add('description-too-long', 'error', `description is ${len} characters; the limit is ${MAX_DESCRIPTION}.`, line, { hint: 'Keep what it does and the trigger phrases; move detail into the body.' })
    if (/<\/?[A-Za-z][\w-]{0,60}[^<>]{0,300}>/.test(description)) add('description-xml', 'error', 'description contains an XML/HTML tag, which skill descriptions may not hold.', line)
    if (len < 40) add('description-short', 'warning', `description is only ${len} characters; say what the skill does and when to use it.`, line)
    else if (!WHEN_RE.test(description)) add('description-no-trigger', 'warning', 'description does not say when to use the skill (for example "Use when ...").', line)
  }

  const body = fm.body
  if (body.trim() === '') add('body-empty', 'error', 'SKILL.md has frontmatter but no instructions after it.', fm.bodyLine)
  else {
    const lines = body.replace(/\s+$/, '').split(/\r?\n/).length
    if (lines > MAX_BODY_LINES) add('body-long', 'warning', `The body is ${lines} lines; keep SKILL.md under ${MAX_BODY_LINES} lines and move detail into reference files.`, fm.bodyLine)
  }

  for (const h of homePaths(text)) add('home-path', 'error', `Absolute home path "${h.match}/..." will not exist on anyone else's machine.`, lineAt(text, h.index), { hint: 'Use a path relative to the skill folder, or ~/.claude/skills/<name>/.' })

  for (const l of relativeLinks(body)) {
    const target = resolveFrom(file, l.target)
    const line = l.line + fm.bodyLine - 1
    if (target === null) add('link-outside', 'warning', `Link "${l.target}" points outside the repository.`, line)
    else if (!exists(target)) add('missing-file', 'error', `Linked ${l.image ? 'image' : 'file'} "${l.target}" is not in the repository.`, line)
  }
  const skillName = typeof name === 'string' ? name : expectedName
  const base = posix.dirname(file) === '.' ? '' : posix.dirname(file) + '/'
  for (const c of codePaths(body)) {
    const stripped = stripSkillPrefix(c.token, skillName)
    if (!stripped) continue
    const first = stripped.split('/')[0]
    if (!first || first === '..' || !exists(base + first) || stripped === first + '/') continue
    const target = posix.normalize(base + stripped)
    if (!exists(target)) add('missing-path', 'warning', `\`${c.token}\` names a path that is not in the repository.`, c.line + fm.bodyLine - 1)
  }
  return { findings: out, data }
}

export function toKebab(s) {
  return String(s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_NAME) || 'my-skill'
}

export function checkSkillMd(ctx) {
  const files = findSkillFiles(ctx)
  const findings = []
  if (files.length === 0) {
    findings.push(finding('skill-md/missing', 'error', 'No SKILL.md found. A skill repository needs SKILL.md at its root (or in one folder per skill).', { file: 'SKILL.md' }))
    return { findings, note: 'no SKILL.md' }
  }
  const names = []
  for (const file of files) {
    if (matchesAny(file, ctx.config.ignore)) continue
    const text = ctx.exists(file) ? ctx.read(file) : null
    if (text !== null && text.length > MAX_MARKDOWN) { findings.push(finding('skill-md/too-large', 'error', `${file} is over ${MAX_MARKDOWN / 1024} KB; it was not checked.`, { file })); continue }
    if (text === null) { findings.push(finding('skill-md/missing', 'error', `${file} is not in the repository (or is not text).`, { file })); continue }
    const dir = posix.dirname(file)
    const expectedName = dir === '.' ? ctx.repoName : posix.basename(dir)
    const nameSource = dir === '.' ? (ctx.config.name ? 'configured' : 'repository') : 'folder'
    const res = lintSkill(text, { file, expectedName, exists: ctx.exists, nameSource })
    findings.push(...res.findings)
    if (res.data && typeof res.data.name === 'string') names.push(res.data.name)
  }
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  for (const d of new Set(dupes)) findings.push(finding('skill-md/duplicate-name', 'error', `Two SKILL.md files use the name "${d}".`))
  return { findings, note: files.length === 1 ? files[0] : `${files.length} skills` }
}
