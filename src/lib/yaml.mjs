// A small YAML reader for SKILL.md frontmatter and .skill-ci.yml. It covers the subset those files use:
// block maps and lists, flow [lists] and {maps}, quoted and plain scalars (also over several lines),
// block scalars (| and > with - or + chomping), comments, and the YAML 1.2 core types.
// It does not do anchors, aliases, tags or multiple documents, and says so instead of guessing.

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message)
    this.line = line
    this.reason = message
  }
}

const indentOf = (s) => s.match(/^ */)[0].length
const isBlank = (s) => /^\s*(#.*)?$/.test(s)

/** Cuts a trailing comment: a # at the start or after whitespace, outside quotes. */
export function stripComment(s) {
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s[{,:]/.test(s[i - 1])) quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd()
    }
  }
  return s.trimEnd()
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', b: '\b', f: '\f', ' ': ' ' }

function unquoteDouble(s, line) {
  let out = ''
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i]
    if (c !== '\\') { out += c; continue }
    const n = s[++i]
    if (n === 'u' || n === 'x') {
      const len = n === 'u' ? 4 : 2
      const hex = s.slice(i + 1, i + 1 + len)
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) throw new YamlError(`bad escape \\${n}${hex}`, line)
      out += String.fromCharCode(parseInt(hex, 16))
      i += len
    } else if (n in ESCAPES) out += ESCAPES[n]
    else throw new YamlError(`unknown escape \\${n}`, line)
  }
  return out
}

/** Turns one complete scalar text (already joined over lines) into a value. */
export function parseScalar(text, line) {
  const s = text.trim()
  if (s === '') return null
  if (s[0] === '"') {
    if (!closesAt(s, '"')) throw new YamlError('unterminated "string" (or text after its closing quote)', line)
    return unquoteDouble(s, line)
  }
  if (s[0] === "'") {
    if (!closesAt(s, "'")) throw new YamlError("unterminated 'string' (or text after its closing quote)", line)
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s[0] === '[' || s[0] === '{') return parseFlow(s, line)
  if (s[0] === '&' || s[0] === '*' || s.startsWith('!!') || (s[0] === '!' && s.length > 1)) throw new YamlError('anchors, aliases and tags are not supported', line)
  if (s[0] === '@' || s[0] === '`') throw new YamlError(`a plain value cannot start with ${s[0]}; quote it`, line)
  if (/^(null|Null|NULL|~)$/.test(s)) return null
  if (/^(true|True|TRUE)$/.test(s)) return true
  if (/^(false|False|FALSE)$/.test(s)) return false
  if (/^[-+]?\d+$/.test(s)) return Number(s)
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16)
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s)
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s[0] === '-' ? -Infinity : Infinity
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN
  return s
}

/** True when the quoted string that opens s closes exactly at its last character. */
function closesAt(s, q) {
  for (let i = 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') { i++; continue }
    if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") { i++; continue }
      return i === s.length - 1
    }
  }
  return false
}

/** Parses a flow collection such as [a, "b", {c: 1}]. */
export function parseFlow(s, line) {
  let i = 0
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++ }
  const fail = (m) => { throw new YamlError(m, line) }
  function value(stops) {
    ws()
    if (s[i] === '[') return list()
    if (s[i] === '{') return map()
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i]; let j = i + 1
      for (; j < s.length; j++) {
        if (q === '"' && s[j] === '\\') { j++; continue }
        if (s[j] === q) { if (q === "'" && s[j + 1] === "'") { j++; continue } break }
      }
      if (j >= s.length) fail('unterminated string in [list] or {map}')
      const out = parseScalar(s.slice(i, j + 1), line); i = j + 1; return out
    }
    let j = i
    while (j < s.length && !stops.includes(s[j])) j++
    const out = parseScalar(s.slice(i, j), line); i = j; return out
  }
  function list() {
    i++; const out = []
    for (;;) {
      ws()
      if (s[i] === ']') { i++; return out }
      if (i >= s.length) fail('unclosed [ list')
      out.push(value(',]'))
      ws()
      if (s[i] === ',') i++
      else if (s[i] !== ']') fail('expected , or ] in list')
    }
  }
  function map() {
    i++; const out = {}
    for (;;) {
      ws()
      if (s[i] === '}') { i++; return out }
      if (i >= s.length) fail('unclosed { map')
      const key = value(':,}')
      ws()
      if (s[i] !== ':') fail('expected key: value in {map}')
      i++
      const k = String(key)
      if (Object.hasOwn(out, k)) fail(`duplicate key "${k}"`)
      out[k] = value(',}')
      ws()
      if (s[i] === ',') i++
      else if (s[i] !== '}') fail('expected , or } in map')
    }
  }
  const out = value('')
  ws()
  if (i < s.length) fail(`unexpected text after the closing bracket: ${s.slice(i, i + 20)}`)
  return out
}

/** Bracket depth of a flow value (outside quotes), to know when it continues on the next line. */
function flowDepth(s) {
  let depth = 0, quote = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) { if (c === '\\' && quote === '"') i++; else if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
  }
  return { depth, open: quote !== null }
}

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s'"#\-[{?:][^:]*?|-[^\s:][^:]*?|\?[^\s:][^:]*?)\s*:(?:\s+(.*)|)$/

/** Parses a YAML document into plain objects, lists and scalars. Throws YamlError with a line number. */
export function parseYaml(text, { lineOffset = 0 } = {}) {
  const raw = String(text).replace(/^﻿/, '').split(/\r?\n/)
  let i = 0
  const lineNo = () => i + 1 + lineOffset
  const err = (m) => new YamlError(m, lineNo())

  raw.forEach((l, n) => {
    if (/^ *\t/.test(l) && !isBlank(l)) throw new YamlError('tab used for indentation; use spaces', n + 1 + lineOffset)
    if (/^(---|\.\.\.)\s*(#.*)?$/.test(l) && n > 0) throw new YamlError('multiple documents are not supported', n + 1 + lineOffset)
  })
  if (raw.length && /^---\s*(#.*)?$/.test(raw[0])) raw[0] = ''

  const skip = () => { while (i < raw.length && isBlank(raw[i])) i++ }
  const isItem = (body) => body === '-' || body.startsWith('- ') || body.startsWith('-\t')

  function block(indent) {
    skip()
    if (i >= raw.length) return null
    const body = stripComment(raw[i].slice(indentOf(raw[i])))
    if (isItem(body)) return list(indentOf(raw[i]))
    if (KEY_RE.test(body)) return map(indentOf(raw[i]))
    const first = raw[i].slice(indentOf(raw[i])); i++
    return scalarAt(first, indent - 1)
  }

  function map(ind) {
    const out = {}
    for (;;) {
      skip()
      if (i >= raw.length) break
      const cur = indentOf(raw[i])
      if (cur < ind) break
      if (cur > ind) throw err('unexpected indentation')
      const body = stripComment(raw[i].slice(cur))
      if (isItem(body)) break
      const m = body.match(KEY_RE)
      if (!m) throw err(`expected "key: value", got "${body.slice(0, 40)}"`)
      const key = String(parseScalar(m[1], lineNo()) ?? 'null')
      if (Object.hasOwn(out, key)) throw err(`duplicate key "${key}"`)
      const rest = raw[i].slice(cur).slice(raw[i].slice(cur).indexOf(':', m[1].length) + 1).replace(/^\s+/, '')
      i++
      out[key] = afterKey(rest, cur)
    }
    return out
  }

  function afterKey(rest, keyIndent) {
    const clean = stripComment(rest)
    if (clean === '') {
      skip()
      if (i >= raw.length) return null
      const ni = indentOf(raw[i])
      const body = stripComment(raw[i].slice(ni))
      if (ni > keyIndent) return block(ni)
      if (ni === keyIndent && isItem(body)) return list(ni)
      return null
    }
    if (/^[|>][+-]?\d?$/.test(clean)) return blockScalar(clean, keyIndent)
    return scalarAt(rest, keyIndent)
  }

  function list(ind) {
    const out = []
    for (;;) {
      skip()
      if (i >= raw.length) break
      const cur = indentOf(raw[i])
      if (cur < ind) break
      if (cur > ind) throw err('unexpected indentation in list')
      const full = raw[i].slice(cur)
      if (!isItem(stripComment(full))) break
      const after = full.slice(1).replace(/^\s+/, '')
      const itemIndent = cur + full.length - after.length
      const clean = stripComment(after)
      if (clean === '') {
        i++
        skip()
        out.push(i < raw.length && indentOf(raw[i]) > cur ? block(indentOf(raw[i])) : null)
      } else if (isItem(clean) || (KEY_RE.test(clean) && !/^["'[{]/.test(clean)) || (KEY_RE.test(clean) && /^["'][^"']*["']\s*:/.test(clean))) {
        raw[i] = ' '.repeat(itemIndent) + after
        out.push(isItem(clean) ? list(itemIndent) : map(itemIndent))
      } else if (/^[|>][+-]?\d?$/.test(clean)) {
        i++
        out.push(blockScalar(clean, cur))
      } else {
        i++
        out.push(scalarAt(after, cur))
      }
    }
    return out
  }

  /** A scalar that starts on the current line and may continue on more-indented lines. */
  function scalarAt(first, parentIndent) {
    const startLine = i + lineOffset
    let text = first.trim()
    const quoted = text[0] === '"' || text[0] === "'"
    const flow = text[0] === '[' || text[0] === '{'
    if (flow) {
      let st = flowDepth(text)
      while ((st.depth > 0 || st.open) && i < raw.length) {
        text += ' ' + stripComment(raw[i].trim()); i++
        st = flowDepth(text)
      }
      return parseScalar(stripComment(text), startLine)
    }
    if (quoted) {
      const q = text[0]
      let lines = [text]
      while (!closedQuote(lines.join(' '), q) && i < raw.length) { lines.push(raw[i].trim()); i++ }
      const joined = foldQuoted(lines)
      return parseScalar(stripComment(joined), startLine)
    }
    text = stripComment(text)
    const parts = [text]
    while (i < raw.length && !isBlank(raw[i]) && indentOf(raw[i]) > parentIndent) {
      const t = raw[i].trim()
      if (/^[^\s'"#][^:]*:(\s|$)/.test(t) && !text.includes(' ')) break
      parts.push(stripComment(t)); i++
    }
    return parseScalar(parts.join(' '), startLine)
  }

  function blockScalar(header, keyIndent) {
    const style = header[0]
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip'
    const lines = []
    let contentIndent = null
    while (i < raw.length) {
      const l = raw[i]
      if (l.trim() === '') { lines.push(''); i++; continue }
      const ind = indentOf(l)
      if (ind <= keyIndent) break
      if (contentIndent === null) contentIndent = ind
      if (ind < contentIndent) break
      lines.push(l.slice(contentIndent)); i++
    }
    let trailing = 0
    while (lines.length && lines[lines.length - 1] === '') { lines.pop(); trailing++ }
    let body
    if (style === '|') body = lines.join('\n')
    else {
      body = ''
      for (let k = 0; k < lines.length; k++) {
        const l = lines[k]
        if (k === 0) { body = l; continue }
        const prev = lines[k - 1]
        if (l === '') body += '\n'
        else if (prev === '' || /^\s/.test(l) || /^\s/.test(prev)) body += (prev === '' ? '' : '\n') + l
        else body += ' ' + l
      }
    }
    if (lines.length === 0) return chomp === 'keep' ? '\n'.repeat(trailing) : ''
    if (chomp === 'strip') return body
    if (chomp === 'keep') return body + '\n' + '\n'.repeat(trailing)
    return body + '\n'
  }

  skip()
  if (i >= raw.length) return null
  const first = raw[i]
  if (indentOf(first) !== 0) throw err('the document must start at column 0')
  const out = block(0)
  skip()
  if (i < raw.length) throw err('unexpected text after the document; check the indentation')
  return out
}

function closedQuote(s, q) {
  for (let k = 1; k < s.length; k++) {
    if (q === '"' && s[k] === '\\') { k++; continue }
    if (s[k] === q) { if (q === "'" && s[k + 1] === "'") { k++; continue } return true }
  }
  return false
}

/** Line folding inside a quoted scalar: line breaks become spaces, empty lines become newlines. */
function foldQuoted(lines) {
  let out = lines[0]
  for (let k = 1; k < lines.length; k++) out += lines[k] === '' ? '\n' : (out.endsWith('\n') ? '' : ' ') + lines[k]
  return out
}

/**
 * Splits a Markdown file into YAML frontmatter and body.
 * -> { present, data, body, bodyLine, error?, errorLine? }   bodyLine is the 1-based line where the body starts.
 */
export function splitFrontmatter(text) {
  const src = String(text).replace(/^﻿/, '')
  const lines = src.split(/\r?\n/)
  if (!/^---\s*$/.test(lines[0] ?? '')) return { present: false, data: null, body: src, bodyLine: 1 }
  let end = -1
  for (let k = 1; k < lines.length; k++) if (/^(---|\.\.\.)\s*$/.test(lines[k])) { end = k; break }
  if (end < 0) return { present: false, unclosed: true, data: null, body: src, bodyLine: 1, error: 'frontmatter opened with --- but never closed', errorLine: 1 }
  const yaml = lines.slice(1, end).join('\n')
  const body = lines.slice(end + 1).join('\n')
  try {
    return { present: true, data: parseYaml(yaml, { lineOffset: 1 }), body, bodyLine: end + 2 }
  } catch (e) {
    if (!(e instanceof YamlError)) throw e
    return { present: true, data: null, body, bodyLine: end + 2, error: e.reason, errorLine: e.line }
  }
}
