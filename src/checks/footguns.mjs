// Security footguns in a skill's scripts, docs and workflows. Every finding is a warning (or a notice) with file:line:
// these are patterns worth a second look, not proof of a hole.
import { posix } from 'node:path'
import { finding, suppressed } from '../lib/context.mjs'
import { matchesAny } from '../lib/files.mjs'

const SHELL_EXT = /\.(sh|bash|zsh|ksh)$/i
const JS_EXT = /\.(js|mjs|cjs|ts|mts|cts|jsx|tsx)$/i
const PY_EXT = /\.py$/i
const MD_EXT = /\.(md|markdown)$/i
const WORKFLOW_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/
const ACTION_RE = /(^|\/)action\.ya?ml$/

/** The language a file is checked as: shell, js, py, md, workflow, or null (not checked). */
export function kindOf(file, text = '') {
  if (WORKFLOW_RE.test(file) || ACTION_RE.test(file)) return 'workflow'
  if (SHELL_EXT.test(file)) return 'shell'
  if (JS_EXT.test(file)) return 'js'
  if (PY_EXT.test(file)) return 'py'
  if (MD_EXT.test(file)) return 'md'
  const shebang = text.slice(0, 120).match(/^#!.*\b(bash|sh|zsh|node|python[\d.]*)\b/)
  if (shebang) return shebang[1] === 'node' ? 'js' : shebang[1].startsWith('python') ? 'py' : 'shell'
  return null
}

const PY_CMD = /\bpython(?:3(?:\.\d+)?)?(?:\.exe)?((?:\s+-[A-Za-z]+)+)\b/g
// In JS and Python source a shell command lives in a string: python must open the string or follow && ; | $(
const PY_CMD_IN_CODE = /(?:^|["'`]|&&\s*|;\s*|\|\s*|\$\()[\w./~-]*?\bpython(?:3(?:\.\d+)?)?(?:\.exe)?((?:\s+-[A-Za-z]+)+)\b/g
const PY_INDICATOR = /python|\bpy3?\b|sys\.executable|\bPY\b/i

/**
 * True when the line runs `python ... -c` without -I (isolated mode): as a shell command, or as an argv list
 * such as spawn(python, ['-c', code]). raw is the line; code is the line with strings and comments removed.
 */
export function pythonCWithoutIsolation(raw, kind = 'shell', code = raw) {
  const inCode = kind === 'js' || kind === 'py'
  for (const m of raw.matchAll(inCode ? PY_CMD_IN_CODE : PY_CMD)) {
    const flags = m[1].trim().split(/\s+/).map((f) => f.slice(1))
    const cIndex = flags.findIndex((f) => f.endsWith('c'))
    if (cIndex < 0) continue
    if (!flags.slice(0, cIndex + 1).some((f) => f.includes('I'))) return true
  }
  if (inCode && /(?:^|[[,(]\s*)["']-c["']/.test(raw) && PY_INDICATOR.test(code) && !/["']-I[a-zA-Z]*["']/.test(raw)) return true
  return false
}

/** Removes string contents, regex literals and comments from one line of JS or Python, keeping the code around them. */
export function stripStrings(line, kind) {
  let out = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (kind === 'js' && c === '/' && line[i + 1] === '/') break
    if (kind === 'js' && c === '/' && line[i + 1] === '*') { const end = line.indexOf('*/', i + 2); if (end < 0) break; i = end + 1; out += ' '; continue }
    if (kind === 'py' && c === '#') break
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < line.length && line[j] !== c) { if (line[j] === '\\') j++; j++ }
      out += c + c
      i = j
      continue
    }
    if (kind === 'js' && c === '/' && /(?:^|[=(,:[!&|?{};+\-*%<>~^]|\breturn|\btypeof)\s*$/.test(out)) {
      let j = i + 1, cls = false
      while (j < line.length && (line[j] !== '/' || cls)) { if (line[j] === '\\') j++; else if (line[j] === '[') cls = true; else if (line[j] === ']') cls = false; j++ }
      if (j < line.length) { out += '/re/'; i = j; while (/[a-z]/.test(line[i + 1] ?? '')) i++; continue }
    }
    out += c
  }
  return out
}

/** The parts of a Markdown line that are code: the whole line inside a fence, else its inline code spans. */
const mdCode = (line, inFence) => (inFence ? line : [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]).join(' ; '))

const ANY = ['shell', 'js', 'py', 'md', 'workflow']
// on: 'raw' tests the line as written (commands inside strings count); 'code' tests it with strings and comments removed
const LINE_RULES = [
  { id: 'python-c-without-I', kinds: ANY, on: 'custom', test: pythonCWithoutIsolation,
    message: '`python -c` without -I: Python puts the current folder first on its import path, so a planted json.py (or any module name) in that folder runs instead.',
    hint: 'Use `python -I -c ...` (isolated mode).' },
  { id: 'curl-pipe-shell', kinds: ANY, on: 'raw', test: (l) => /\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da|k)?sh\b/.test(l) || /\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sudo\s+)?python[\d.]*\b/.test(l),
    message: 'Downloads a script and pipes it straight into a shell; nothing checks what was downloaded.', hint: 'Download to a file, verify a checksum or signature, then run it.' },
  { id: 'shell-true', kinds: ['js'], on: 'code', test: (l) => /\bshell\s*:\s*true\b/.test(l),
    message: '`shell: true` runs the command through a shell, so spaces, quotes, $() and ; in any argument are interpreted.', hint: 'Pass the program and an argument list with shell off.' },
  { id: 'shell-true', kinds: ['py'], on: 'code', test: (l) => /\bshell\s*=\s*True\b/.test(l),
    message: '`shell=True` runs the command through a shell, so spaces, quotes, $() and ; in any argument are interpreted.', hint: 'Pass a list of arguments with shell=False.' },
  { id: 'os-system', kinds: ['py'], on: 'code', test: (l) => /(?<![\w.])os\.(?:system|popen)\s*\(/.test(l),
    message: '`os.system`/`os.popen` runs a string through a shell.', hint: 'Use subprocess.run([...]) with a list of arguments.' },
  { id: 'eval', kinds: ['js'], on: 'code', test: (l) => /(?<![\w.$])eval\s*\(|\bnew\s+Function\s*\(/.test(l),
    message: '`eval`/`new Function` runs a string as code.' },
  { id: 'eval', kinds: ['py'], on: 'code', test: (l) => /(?<![\w.])(?:eval|exec)\s*\((?!\s*["']{2}\s*[,)])/.test(l) && !/^\s*def\s/.test(l),
    message: '`eval`/`exec` runs a string as Python code.' },
  { id: 'eval', kinds: ['shell'], on: 'raw', test: (l) => /(?:^|[;&|]\s*|\bthen\s+|\bdo\s+)eval\s+["']?\$/.test(l),
    message: '`eval` of a variable runs whatever the variable holds as shell code.' },
  { id: 'rm-rf-variable', kinds: ['shell', 'md', 'workflow'], on: 'raw', test: (l) => /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\s+)+["']?\$\{?[A-Za-z_]\w*\}?["']?\/(?![^\s"']*:\?)/.test(l) && !/\$\{[A-Za-z_]\w*:\?/.test(l),
    message: '`rm -r` on "$VAR/..." deletes from / when the variable is empty.', hint: 'Use "${VAR:?}/..." so an empty variable stops the script.' },
  { id: 'chmod-777', kinds: ANY, on: 'raw', test: (l) => /\bchmod\s+(?:-R\s+)?0?777\b|chmod(?:Sync)?\([^)]*0o?777\)/.test(l),
    message: 'Mode 777 lets every user on the machine change the file.' },
  { id: 'tls-verify-off', kinds: ['py'], on: 'code', test: (l) => /\bverify\s*=\s*False\b/.test(l), message: 'TLS certificate checking is turned off (verify=False).' },
  { id: 'tls-verify-off', kinds: ['js'], on: 'code', test: (l) => /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']{0,2}\s*0/.test(l), message: 'TLS certificate checking is turned off.' },
  { id: 'tls-verify-off', kinds: ['shell', 'md', 'workflow'], on: 'raw', test: (l) => /\bcurl\b[^\n|]*\s(?:-k|--insecure)\b|\bwget\b[^\n|]*--no-check-certificate/.test(l), message: 'TLS certificate checking is turned off (curl -k / --insecure).' },
  { id: 'unsafe-yaml-load', kinds: ['py'], on: 'code', test: (l) => /\byaml\.(?:load|load_all)\s*\((?![^)]*Loader\s*=\s*(?:yaml\.)?(?:Safe|CSafe)Loader)/.test(l),
    message: '`yaml.load` without SafeLoader can build arbitrary Python objects from the file.', hint: 'Use yaml.safe_load.' },
  { id: 'pickle-load', kinds: ['py'], on: 'code', level: 'notice', test: (l) => /\bpickle\.loads?\s*\(/.test(l), message: '`pickle.load` runs code embedded in the file; only load pickles you made.' },
]

/** Names bound to child_process exec/execSync in a JS file: { direct: Set, namespaces: Set }. */
export function childProcessBindings(text) {
  const direct = new Set(), namespaces = new Set()
  const src = String(text)
  const mod = `["'](?:node:)?child_process["']`
  for (const m of src.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*${mod}`, 'g'))) addNames(m[1])
  for (const m of src.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*(?:await\\s+import|require)\\s*\\(\\s*${mod}\\s*\\)`, 'g'))) addNames(m[1])
  for (const m of src.matchAll(new RegExp(`import\\s+(?:\\*\\s+as\\s+)?([A-Za-z_$][\\w$]*)\\s+from\\s*${mod}`, 'g'))) namespaces.add(m[1])
  for (const m of src.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+import|require)\\s*\\(\\s*${mod}\\s*\\)`, 'g'))) namespaces.add(m[1])
  function addNames(list) {
    for (const part of list.split(',')) {
      const m = part.trim().match(/^(exec|execSync)(?:\s+as\s+|\s*:\s*)?([A-Za-z_$][\w$]*)?$/)
      if (m) direct.add(m[2] || m[1])
    }
  }
  return { direct, namespaces }
}

/** Calls of child_process exec/execSync on a line (they always run their string through a shell). */
export function execCalls(code, bindings, raw = code) {
  const hits = []
  const built = (name) => new RegExp(`${name.replace(/[$.]/g, '\\$&')}\\s*\\(\\s*(?:\`[^\`]*\\$\\{|["'][^"']*["']\\s*\\+|[A-Za-z_$][\\w$.]*\\s*\\+)`).test(raw)
  for (const name of bindings.direct) {
    const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\(`, 'g')
    for (const _ of code.matchAll(re)) hits.push({ name, interpolated: built(name) })
  }
  for (const ns of bindings.namespaces) {
    const re = new RegExp(`(?<![\\w$])${ns.replace(/\$/g, '\\$')}\\.(exec|execSync)\\s*\\(`, 'g')
    for (const m of code.matchAll(re)) hits.push({ name: `${ns}.${m[1]}`, interpolated: built(`${ns}.${m[1]}`) })
  }
  return hits
}

const UNTRUSTED_CONTEXT = /\$\{\{\s*github\.(?:event\.(?:issue|pull_request|comment|review|review_comment|discussion|head_commit|commits|pages|workflow_run)\b[\w.[\]*]*(?:title|body|name|message|label|ref|email|default_branch)|head_ref)\b/

/** Workflow and action files: unpinned actions, pull_request_target, missing permissions, untrusted input in run:. */
export function lintWorkflow(text, file) {
  const out = []
  const add = (id, level, message, line, hint) => out.push(finding(`footguns/${id}`, level, message, { file, line, hint }))
  const lines = text.split(/\r?\n/)
  let runIndent = -1
  const isWorkflow = WORKFLOW_RE.test(file)
  for (const [k, line] of lines.entries()) {
    const n = k + 1
    if (suppressed(line, '')) continue
    const uses = line.match(/^\s*-?\s*uses:\s*["']?([^\s"'#]+)/)
    if (uses && !uses[1].startsWith('./') && !uses[1].startsWith('docker://')) {
      const ref = uses[1].split('@')[1]
      if (!ref) add('unpinned-action', 'warning', `Action ${uses[1]} has no version at all.`, n, 'Pin it to a full commit SHA with the tag in a comment.')
      else if (!/^[0-9a-f]{40}$/.test(ref)) add('unpinned-action', 'warning', `Action ${uses[1]} is pinned to a movable tag or branch, not a commit SHA.`, n, 'Pin to the full 40-character commit SHA, e.g. uses: actions/checkout@<sha> # v4.2.2')
    }
    if (isWorkflow && /^[^#]*\bpull_request_target\b/.test(line)) add('pull-request-target', 'warning', '`pull_request_target` runs with secrets and write access on code from forks.', n, 'Use pull_request unless you are sure no fork code is checked out or run.')
    const run = line.match(/^(\s*)-?\s*run:\s*(.*)$/)
    if (run) {
      runIndent = run[1].length
      if (UNTRUSTED_CONTEXT.test(run[2])) add('script-injection', 'warning', 'Untrusted event text is pasted into a run: script (script injection).', n, 'Pass it through env: and use "$VAR" in the script.')
      continue
    }
    if (runIndent >= 0) {
      const ind = line.match(/^ */)[0].length
      if (line.trim() !== '' && ind <= runIndent) runIndent = -1
      else if (UNTRUSTED_CONTEXT.test(line)) add('script-injection', 'warning', 'Untrusted event text is pasted into a run: script (script injection).', n, 'Pass it through env: and use "$VAR" in the script.')
    }
  }
  if (isWorkflow && !/^permissions\s*:/m.test(text)) add('no-permissions', 'warning', 'The workflow sets no top-level permissions, so its token gets the repository default (often write).', 1, 'Add "permissions: contents: read" at the top level.')
  return out
}

/** Lints one file's text. -> findings */
export function lintFile(text, file, { disabled = () => false } = {}) {
  const kind = kindOf(file, text)
  if (!kind) return []
  const out = []
  const lines = text.split(/\r?\n/)
  const bindings = kind === 'js' ? childProcessBindings(text) : null
  const push = (rule, level, message, n, hint) => {
    if (disabled(rule) || suppressed(lines[n - 1] ?? '', rule)) return
    out.push(finding(rule, level, message, { file, line: n, hint }))
  }
  let fence = null
  for (const [k, line] of lines.entries()) {
    if (line.length > 5000) continue
    const n = k + 1
    let raw = line, code = line
    if (kind === 'md') {
      const f = line.match(/^\s{0,3}(`{3,}|~{3,})/)
      if (f && (!fence || f[1][0] === fence[0])) { fence = fence ? null : f[1]; continue }
      raw = code = mdCode(line, Boolean(fence))
    } else if (kind === 'shell' || kind === 'workflow') {
      if (/^\s*#/.test(line)) continue
    } else code = stripStrings(line, kind)
    if (!raw.trim()) continue
    for (const r of LINE_RULES) {
      if (!r.kinds.includes(kind)) continue
      const hit = r.on === 'custom' ? r.test(raw, kind, code) : r.test(r.on === 'code' ? code : raw)
      if (hit) push(`footguns/${r.id}`, r.level ?? 'warning', r.message, n, r.hint)
    }
    if (bindings) {
      for (const call of execCalls(code, bindings, line)) {
        push('footguns/exec-string', 'warning', `\`${call.name}()\` runs its command string through a shell${call.interpolated ? ', and this one builds the string from variables (command injection if any of them comes from input)' : ''}.`, n, 'Use execFile/spawn with an argument list instead.')
      }
    }
  }
  if (kind === 'workflow') for (const f of lintWorkflow(text, file)) if (!disabled(f.rule) && !suppressed(lines[f.line - 1] ?? '', f.rule)) out.push(f)
  return out
}

export function checkFootguns(ctx) {
  const findings = []
  let checked = 0
  for (const file of ctx.files) {
    if (matchesAny(file, ctx.config.footguns.ignore)) continue
    if (!kindOf(file) && posix.extname(file) !== '' ) continue
    const text = ctx.read(file)
    if (text === null) continue
    if (!kindOf(file, text)) continue
    checked++
    findings.push(...lintFile(text, file, { disabled: ctx.disabled }))
  }
  return { findings, note: `${checked} files checked` }
}
