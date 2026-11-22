// README basics: present, an install command, a licence section, working relative links and badges.
import { posix } from 'node:path'
import { finding } from '../lib/context.mjs'
import { relativeLinks, resolveFrom, markdownLines } from '../lib/markdown.mjs'

const README_RE = /^readme(\.(md|markdown|rst|txt))?$/i
const INSTALL_RE = /\bgit clone\b|\bnpx\s+\S|\bnpm (?:i|install)\s+(?:-g\s+)?\S|\bpip3? install\b|\buv (?:tool|pip) install\b|\bpipx install\b|\bclaude (?:plugin|mcp) (?:install|add)\b|\/plugin (?:install|marketplace)\b|\bbrew install\b|\bcp -[rR]\b|\bgh repo clone\b/

export const findReadme = (files) => files.find((f) => !f.includes('/') && README_RE.test(f)) ?? null

/** Install-command lines: { text, line }. */
export function installLines(text) {
  return markdownLines(text).filter((l) => INSTALL_RE.test(l.line)).map((l) => ({ text: l.line.trim(), line: l.n }))
}

/** For `git clone <url> <dest>` lines: the folder the clone lands in. */
export function cloneTarget(line) {
  const m = line.match(/\bgit clone\s+(?:(?:--?[\w-]+(?:[= ]\S+)?)\s+)*(\S+)(?:\s+([^\s#;&|]+))?/)
  if (!m) return null
  const url = m[1].replace(/[`'"]/g, '')
  const repo = url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop()
  const dest = m[2] ? m[2].replace(/[`'"]/g, '').replace(/\/+$/, '') : null
  return { url, repo, folder: dest ? dest.split('/').pop() : repo, explicit: Boolean(dest) }
}

export function lintReadme(text, { file = 'README.md', name = null, exists = () => true } = {}) {
  const out = []
  const add = (rule, level, message, line, extra = {}) => out.push(finding(`readme/${rule}`, level, message, { file, line, ...extra }))
  if (text.trim().length < 200) add('too-short', 'warning', `The README is only ${text.trim().length} characters; say what the skill does, how to install it and how to use it.`, 1)
  const lines = markdownLines(text)
  if (!lines.some((l) => !l.code && /^#\s+\S/.test(l.line)) && !/^\S.*\n=+\s*$/m.test(text)) add('no-title', 'notice', 'The README has no top-level "# Title" heading.', 1)

  const installs = installLines(text)
  if (installs.length === 0) add('no-install', 'warning', 'The README has no install command.', 1, { hint: name ? `For example: git clone https://github.com/<you>/${name} ~/.claude/skills/${name}` : 'For example: git clone <url> ~/.claude/skills/<name>' })
  for (const l of installs) {
    const clone = cloneTarget(l.text)
    if (!clone || !name) continue
    if (clone.repo !== name) continue // cloning another skill (a dependency), not this one
    if (/\.claude\/skills\//.test(l.text) && clone.folder !== name) add('install-folder', 'error', `The install command clones into "${clone.folder}", but the skill is named "${name}"; Claude Code expects the folder to match.`, l.line)
  }

  if (!/licen[cs]e/i.test(text)) add('no-licence-section', 'warning', 'The README never mentions the licence.', 1, { hint: 'Add a "## License" section that names it and links to LICENSE.' })

  for (const l of relativeLinks(text)) {
    const target = resolveFrom(file, l.target)
    if (target === null) add('link-outside', 'warning', `Link "${l.target}" points outside the repository.`, l.line)
    else if (!exists(target)) add(l.image ? 'missing-image' : 'missing-file', l.image ? 'error' : 'warning', `${l.image ? 'Image' : 'Link'} "${l.target}" is not in the repository${l.image ? ', so it shows as broken on GitHub' : ''}.`, l.line)
  }

  for (const { line, n, code } of lines) {
    if (code) continue
    for (const m of line.matchAll(/actions\/workflows\/([\w.-]+\.ya?ml)\/badge\.svg/g)) {
      if (!exists(`.github/workflows/${m[1]}`)) add('badge-workflow', 'warning', `The badge points at workflow ${m[1]}, which is not in .github/workflows/.`, n)
    }
  }
  return out
}

export function checkReadme(ctx) {
  const file = findReadme(ctx.files)
  if (!file) return { findings: [finding('readme/missing', 'error', 'No README at the repository root.', { file: 'README.md' })], note: 'missing' }
  const text = ctx.read(file)
  if (text === null) return { findings: [finding('readme/unreadable', 'error', `${file} could not be read as text.`, { file })] }
  return { findings: lintReadme(text, { file, name: ctx.repoName, exists: ctx.exists }), note: posix.basename(file) }
}
