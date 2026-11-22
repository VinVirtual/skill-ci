// Renders skill-ci's own Markdown summary as a standalone HTML page that looks like a GitHub job summary.
// It handles the subset toMarkdown() writes (headings, paragraphs, tables, code blocks, details), not Markdown in general.
const ALLOWED_TAGS = /^<\/?(br|sub|details|summary|code)>$/i

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Inline Markdown: code spans, bold, links, and the few HTML tags the summary uses. Entities pass through. */
export function inline(text) {
  const parts = String(text).split(/(`[^`\n]+`)/)
  return parts.map((p, i) => {
    if (i % 2) return `<code>${esc(p.slice(1, -1).replace(/\\\|/g, '|'))}</code>`
    let s = p.replace(/\\\|/g, '|')
    s = s.replace(/<[^>]*>|&(?![a-z]+;|#\d+;)|>/gi, (m) => (ALLOWED_TAGS.test(m) ? m : esc(m)))
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(?<!\\)\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => (/^(https?:|#)/.test(href) ? `<a href="${esc(href)}">${label}</a>` : label))
    return s.replace(/\\([\\`*_[\]()!#~|])/g, '$1') // backslash escapes from escapeMd
  }).join('')
    // a link whose label is a code span was split apart above; join it back
    .replace(/\[(<code>[^<]*<\/code>)\]\(([^)\s]+)\)/g, (_, label, href) => (/^(https?:|#)/.test(href) ? `<a href="${esc(href)}">${label}</a>` : label))
}

const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim())

const STATUS_CLASS = { '✓ pass': 'pass', '▲ warn': 'warn', '✗ fail': 'fail', '○ skip': 'skip', error: 'error', warning: 'warning', notice: 'notice' }

export function markdownToHtml(md) {
  const lines = String(md).split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^(`{3,})/)
    if (fence) {
      const body = []
      for (i++; i < lines.length && lines[i] !== fence[1]; i++) body.push(lines[i])
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue }
    if (/^\|/.test(line) && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
      const head = splitRow(line)
      const align = splitRow(lines[i + 1]).map((c) => (c.endsWith(':') ? 'right' : 'left'))
      const rows = []
      for (i += 2; i < lines.length && /^\|/.test(lines[i]); i++) rows.push(splitRow(lines[i]))
      i--
      const td = (c, k, tag) => {
        const cls = STATUS_CLASS[c] ? ` class="pill ${STATUS_CLASS[c]}"` : ''
        const content = STATUS_CLASS[c] ? `<span${cls}>${esc(c)}</span>` : inline(c)
        return `<${tag}${align[k] === 'right' ? ' class="num"' : ''}>${content}</${tag}>`
      }
      out.push(`<table><thead><tr>${head.map((c, k) => td(c, k, 'th')).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, k) => td(c, k, 'td')).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    if (/^<\/?details>|^<details>/.test(line) || /^<\/details>$/.test(line)) { out.push(line.startsWith('<details>') ? `<details>${inline(line.slice(9))}` : '</details>'); continue }
    if (line.trim() === '') continue
    if (line.startsWith('> ')) {
      const quote = [line.slice(2)]
      while (i + 1 < lines.length && lines[i + 1].startsWith('> ')) quote.push(lines[++i].slice(2))
      out.push(`<blockquote>${inline(quote.join(' ').replace(/^\[!(NOTE|WARNING|TIP)\]\s*/, ''))}</blockquote>`)
      continue
    }
    const para = [line]
    while (i + 1 < lines.length && lines[i + 1].trim() !== '' && !/^(#|\||```|<details>|<\/details>)/.test(lines[i + 1])) para.push(lines[++i])
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }
  return out.join('\n')
}

const CSS = `
:root { --bg:#f6f8fa; --card:#fff; --ink:#1f2328; --muted:#59636e; --line:#d1d9e0; --code:#eff2f5;
  --pass:#1a7f37; --pass-bg:#dafbe1; --warn:#9a6700; --warn-bg:#fff8c5; --fail:#d1242f; --fail-bg:#ffebe9; --skip:#59636e; --skip-bg:#eff2f5; --note:#0969da; --note-bg:#ddf4ff; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#0d1117; --card:#151b23; --ink:#f0f6fc; --muted:#9198a1; --line:#3d444d; --code:#262c36;
  --pass:#3fb950; --pass-bg:#12261e; --warn:#d29922; --warn-bg:#272115; --fail:#f85149; --fail-bg:#25171c; --skip:#9198a1; --skip-bg:#212830; --note:#4493f8; --note-bg:#121d2f; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; }
main { max-width: 1012px; margin: 24px auto; background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 8px 24px 20px; }
.frame { font-size:12px; color:var(--muted); border-bottom:1px solid var(--line); margin:0 -24px 8px; padding:10px 24px; display:flex; gap:8px; align-items:center; }
.frame b { color: var(--ink); font-weight: 600; }
h2 { font-size: 1.5em; border-bottom: 1px solid var(--line); padding-bottom: .3em; margin: 16px 0 16px; font-weight: 600; }
h3 { font-size: 1.25em; margin: 24px 0 12px; font-weight: 600; }
p { margin: 0 0 16px; }
code { font: 85%/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--code); padding: .2em .4em; border-radius: 6px; }
pre { background: var(--code); border-radius: 6px; padding: 12px 16px; overflow: auto; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre code { background: none; padding: 0; font-size: 100%; }
table { border-collapse: collapse; margin: 0 0 16px; display: block; overflow-x: auto; max-width: 100%; }
th, td { border: 1px solid var(--line); padding: 6px 13px; vertical-align: top; text-align: left; }
th { font-weight: 600; }
tr:nth-child(2n) td { background: color-mix(in srgb, var(--code) 45%, transparent); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
sub { color: var(--muted); font-size: 85%; vertical-align: baseline; }
sub code { font-size: 90%; }
a { color: var(--note); text-decoration: none; } a:hover { text-decoration: underline; }
.pill { display:inline-block; white-space:nowrap; font-weight:600; font-size:12px; padding:0 8px; border-radius:2em; line-height:20px; }
.pill.pass { color:var(--pass); background:var(--pass-bg); } .pill.warn, .pill.warning { color:var(--warn); background:var(--warn-bg); }
.pill.fail, .pill.error { color:var(--fail); background:var(--fail-bg); } .pill.skip { color:var(--skip); background:var(--skip-bg); }
.pill.notice { color:var(--note); background:var(--note-bg); }
blockquote { margin: 0 0 16px; padding: 8px 14px; border-left: 3px solid var(--note); background: var(--note-bg); border-radius: 0 6px 6px 0; }
details { margin: 0 0 16px; } summary { cursor: pointer; color: var(--muted); }
@media (max-width: 640px) { main { margin: 0; border-radius: 0; border-width: 0; padding: 8px 16px 16px; } .frame { margin: 0 -16px 8px; padding: 10px 16px; } }
`

/** A standalone page around the rendered summary. */
export function summaryPage(md, { title = 'skill-ci summary', heading = 'skill-ci summary' } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main><div class="frame"><b>${esc(heading)}</b></div>
${markdownToHtml(md)}
</main></body></html>
`
}
