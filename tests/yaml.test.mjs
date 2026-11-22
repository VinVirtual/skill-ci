import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseYaml, splitFrontmatter, stripComment, YamlError } from '../src/lib/yaml.mjs'

test('plain key-value pairs and core types', () => {
  assert.deepEqual(parseYaml('a: 1\nb: 2.5\nc: true\nd: null\ne: ~\nf: text here\ng: -3\nh: yes'), { a: 1, b: 2.5, c: true, d: null, e: null, f: 'text here', g: -3, h: 'yes' })
})

test('a colon inside a plain value stays part of the value', () => {
  assert.deepEqual(parseYaml('description: Does X: then Y. Use when asked.'), { description: 'Does X: then Y. Use when asked.' })
})

test('nested maps and lists, including lists at the key indent', () => {
  const doc = 'checks:\n  install: false\n  demo: true\nignore:\n- "tests/**"\n- vendor/**\nnested:\n  list:\n    - a\n    - b'
  assert.deepEqual(parseYaml(doc), { checks: { install: false, demo: true }, ignore: ['tests/**', 'vendor/**'], nested: { list: ['a', 'b'] } })
})

test('lists of maps', () => {
  assert.deepEqual(parseYaml('items:\n  - name: a\n    size: 1\n  - name: b\n    size: 2'), { items: [{ name: 'a', size: 1 }, { name: 'b', size: 2 }] })
})

test('flow lists and maps, also over several lines', () => {
  assert.deepEqual(parseYaml('a: [1, "two", \'three\', {x: 1}]\nb: {k: [y, z]}\nc: [\n  p,\n  q\n]'), { a: [1, 'two', 'three', { x: 1 }], b: { k: ['y', 'z'] }, c: ['p', 'q'] })
})

test('double-quoted escapes and single-quoted doubled quotes', () => {
  assert.deepEqual(parseYaml('a: "tab\\there \\"q\\" \\u00e9"\nb: \'it\'\'s\''), { a: 'tab\there "q" é', b: "it's" })
})

test('comments are removed, but not a # inside a value or quotes', () => {
  assert.deepEqual(parseYaml('# head\na: x # note\nb: http://h/p#frag\nc: "a # b"'), { a: 'x', b: 'http://h/p#frag', c: 'a # b' })
  assert.equal(stripComment("x: 'a # b' # c"), "x: 'a # b'")
})

test('literal and folded block scalars with chomping', () => {
  const doc = 'lit: |\n  one\n  two\nfold: >\n  one\n  two\n\n  para\nstrip: |-\n  x\nkeep: |+\n  y\n\nend: 1'
  assert.deepEqual(parseYaml(doc), { lit: 'one\ntwo\n', fold: 'one two\npara\n', strip: 'x', keep: 'y\n\n', end: 1 })
})

test('plain and quoted scalars continue on more-indented lines', () => {
  assert.deepEqual(parseYaml('a: first\n  second\nb: "q1\n  q2"\nc: 3'), { a: 'first second', b: 'q1 q2', c: 3 })
})

test('duplicate keys are an error with the line number', () => {
  assert.throws(() => parseYaml('a: 1\nb: 2\na: 3'), (e) => e instanceof YamlError && e.line === 3 && /duplicate key "a"/.test(e.message))
})

test('tabs used for indentation are refused', () => {
  assert.throws(() => parseYaml('a:\n\tb: 1'), /tab/)
})

test('unterminated strings and brackets are errors', () => {
  assert.throws(() => parseYaml('a: "open'), /unterminated/)
  assert.throws(() => parseYaml('a: [1, 2'), YamlError)
  assert.throws(() => parseYaml("a: 'x' trailing"), /unterminated|after/)
})

test('anchors, aliases, tags and multiple documents are refused, not guessed', () => {
  assert.throws(() => parseYaml('a: &x 1'), /not supported/)
  assert.throws(() => parseYaml('a: *x'), /not supported/)
  assert.throws(() => parseYaml('a: !!str 1'), /not supported/)
  assert.throws(() => parseYaml('a: 1\n---\nb: 2'), /multiple documents/)
})

test('bad indentation is an error', () => {
  assert.throws(() => parseYaml('a: 1\n   b: 2'), /indentation/)
  assert.throws(() => parseYaml('  a: 1'), /column 0/)
})

test('an empty document is null', () => {
  assert.equal(parseYaml(''), null)
  assert.equal(parseYaml('# only a comment\n'), null)
})

test('splitFrontmatter separates YAML and body and reports body line', () => {
  const fm = splitFrontmatter('---\nname: x\ndescription: y\n---\n\n# Title\n')
  assert.equal(fm.present, true)
  assert.deepEqual(fm.data, { name: 'x', description: 'y' })
  assert.equal(fm.bodyLine, 5)
  assert.match(fm.body, /# Title/)
})

test('splitFrontmatter: missing, unclosed and invalid frontmatter', () => {
  assert.equal(splitFrontmatter('# no frontmatter').present, false)
  assert.equal(splitFrontmatter('---\nname: x\n# never closed').unclosed, true)
  const bad = splitFrontmatter('---\nname: x\nname: y\n---\nbody')
  assert.equal(bad.present, true)
  assert.match(bad.error, /duplicate/)
  assert.equal(bad.errorLine, 3)
})

test('a byte-order mark and CRLF line endings are accepted', () => {
  const fm = splitFrontmatter('\uFEFF---\r\nname: x\r\ndescription: y\r\n---\r\nbody\r\n')
  assert.deepEqual(fm.data, { name: 'x', description: 'y' })
})
