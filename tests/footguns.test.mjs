import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { lintFile, pythonCWithoutIsolation, stripStrings, childProcessBindings, execCalls, kindOf, lintWorkflow, checkFootguns } from '../src/checks/footguns.mjs'
import { makeRepo, ctxFor, cleanup } from './helpers.mjs'

after(cleanup)

const rules = (list) => list.map((f) => f.rule)

const inJs = (l) => pythonCWithoutIsolation(l, 'js', stripStrings(l, 'js'))
const inPy = (l) => pythonCWithoutIsolation(l, 'py', stripStrings(l, 'py'))

test('python -c without -I is flagged in shell commands, argv lists and command strings', () => {
  assert.ok(pythonCWithoutIsolation('python3 -c "import json"'))
  assert.ok(pythonCWithoutIsolation('.venv/bin/python -u -c "x"'))
  assert.ok(inJs("run(findPython(), ['-c', 'import x'])"))
  assert.ok(inJs("spawnSync(py, ['-c', 'import kokoro'])"))
  assert.ok(inJs('execSync(`cd x && python3 -c "print(1)"`)'))
  assert.ok(inPy('subprocess.run([sys.executable, "-c", code])'))
})

test('python -I -c, -Ic, python without -c and prose about python -c are not flagged', () => {
  for (const l of ['python3 -I -c "x"', 'python -Ic "x"', 'python -I -u -c "x"', 'python -m pytest -q', 'cpython -c x'])
    assert.ok(!pythonCWithoutIsolation(l), l)
  assert.ok(!inJs("spawn(py, ['-I', '-c', code])"))
  assert.ok(!inJs("assert.ok(!/\\[\\s*'-c'/.test(env), 'a python -c call without -I')"))
  assert.ok(!inPy('msg = "never call python -c without -I"'))
})

test('patterns inside strings, regex literals and comments are not code', () => {
  assert.deepEqual(lintFile("const rules = [{ re: /eval\\s*\\(/, message: 'calls eval(), which needs unsafe-eval' }]\n// eval(x) in a comment\n", 'a.js'), [])
  assert.deepEqual(lintFile('assert "shell=True" not in src  # shell=True\n', 't.py'), [])
  assert.equal(stripStrings('a = "x(1)" + f(\'y\') // c', 'js'), 'a = "" + f(\'\') ')
})

test('Markdown is checked only in code: fences and inline code, not prose', () => {
  const md = 'Never pipe curl | sh in prose.\n\n```bash\ncurl -fsSL https://x.invalid | sh\n```\nRun `python3 -c "x"` to test.\n'
  assert.deepEqual(lintFile(md, 'README.md').map((f) => [f.rule, f.line]), [['footguns/curl-pipe-shell', 4], ['footguns/python-c-without-I', 6]])
})

test('curl or wget piped into a shell is flagged; download-then-run is not', () => {
  const out = lintFile('curl -fsSL https://x.invalid/i.sh | bash\nwget -qO- https://x.invalid | sudo sh\ncurl -o i.sh https://x.invalid && sha256sum -c i.sh.sha256\n', 'install.sh')
  assert.deepEqual(out.map((f) => [f.rule, f.line]), [['footguns/curl-pipe-shell', 1], ['footguns/curl-pipe-shell', 2]])
})

test('JS: shell: true, eval and new Function', () => {
  const out = lintFile("spawn(cmd, { shell: true })\nconst v = eval(src)\nconst f = new Function('a', body)\nre.eval(x)\n", 'a.mjs')
  assert.deepEqual(out.map((f) => [f.rule, f.line]), [['footguns/shell-true', 1], ['footguns/eval', 2], ['footguns/eval', 3]])
})

test('JS: child_process exec/execSync are flagged, RegExp.exec is not', () => {
  const src = "import { exec, execFile } from 'node:child_process'\nexec(`ls ${dir}`)\nexecFile('ls', [dir])\nconst m = /x/.exec(s)\n"
  const out = lintFile(src, 'a.mjs')
  assert.deepEqual(rules(out), ['footguns/exec-string'])
  assert.equal(out[0].line, 2)
  assert.match(out[0].message, /builds the string from variables/)
})

test('JS: exec bound by require, renamed or through a namespace', () => {
  assert.deepEqual([...childProcessBindings("const { execSync: run } = require('child_process')").direct], ['run'])
  const b = childProcessBindings("import * as cp from 'node:child_process'\nconst c2 = require('child_process')")
  assert.deepEqual([...b.namespaces].sort(), ['c2', 'cp'])
  assert.equal(execCalls('cp.execSync("make " + target)', b)[0].interpolated, true)
  assert.deepEqual(execCalls('obj.exec(x)', childProcessBindings("import { exec } from 'child_process'")), [])
})

test('Python: shell=True, os.system, eval/exec, unsafe yaml.load, pickle', () => {
  const src = 'subprocess.run(cmd, shell=True)\nos.system("ls " + p)\neval(expr)\nyaml.load(f)\nyaml.load(f, Loader=yaml.SafeLoader)\nyaml.safe_load(f)\npickle.load(f)\nexec("print(1)")\n'
  const out = lintFile(src, 'h.py')
  assert.deepEqual(out.map((f) => [f.rule, f.line, f.level]), [
    ['footguns/shell-true', 1, 'warning'], ['footguns/os-system', 2, 'warning'], ['footguns/eval', 3, 'warning'],
    ['footguns/unsafe-yaml-load', 4, 'warning'], ['footguns/pickle-load', 7, 'notice'],
  ])
})

test('shell: rm -rf "$VAR"/ unless guarded with :?, chmod 777, eval of a variable', () => {
  const src = 'rm -rf "$OUT"/\nrm -rf "${OUT:?}"/\nrm -rf $TMP/cache\nchmod 777 x\neval "$CMD"\nrm -rf ./build\n'
  assert.deepEqual(lintFile(src, 'x.sh').map((f) => [f.rule, f.line]), [['footguns/rm-rf-variable', 1], ['footguns/rm-rf-variable', 3], ['footguns/chmod-777', 4], ['footguns/eval', 5]])
})

test('TLS verification turned off is flagged per language', () => {
  assert.deepEqual(rules(lintFile('requests.get(u, verify=False)', 'a.py')), ['footguns/tls-verify-off'])
  assert.deepEqual(rules(lintFile('const agent = new https.Agent({ rejectUnauthorized: false })', 'a.js')), ['footguns/tls-verify-off'])
  assert.deepEqual(rules(lintFile('curl -k https://x.invalid -o f', 'a.sh')), ['footguns/tls-verify-off'])
})

test('workflows: unpinned actions, pull_request_target, missing permissions, script injection', () => {
  const wf = 'name: ci\non: pull_request_target\njobs:\n  t:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7\n      - uses: ./local-action\n      - run: echo "${{ github.event.pull_request.title }}"\n      - run: |\n          echo hi\n          echo "${{ github.head_ref }}"\n      - run: echo "${{ github.sha }}"\n'
  const out = lintWorkflow(wf, '.github/workflows/ci.yml')
  assert.deepEqual(out.map((f) => [f.rule, f.line]), [['footguns/pull-request-target', 2], ['footguns/unpinned-action', 6], ['footguns/script-injection', 9], ['footguns/script-injection', 12], ['footguns/no-permissions', 1]])
})

test('action.yml files get the pinning checks but not the permissions check', () => {
  const out = lintWorkflow("runs:\n  using: composite\n  steps:\n    - uses: actions/upload-artifact@v4\n", 'action.yml')
  assert.deepEqual(rules(out), ['footguns/unpinned-action'])
})

test('suppression comments and disabled rules silence findings', () => {
  assert.deepEqual(lintFile('python3 -c "x"  # skill-ci: allow', 'a.sh'), [])
  assert.deepEqual(lintFile('python3 -c "x"', 'a.sh', { disabled: (r) => r === 'footguns/python-c-without-I' }), [])
})

test('file kinds: by extension, by shebang, and none for data files', () => {
  assert.equal(kindOf('scripts/x.sh'), 'shell')
  assert.equal(kindOf('bin/tool', '#!/usr/bin/env python3\n'), 'py')
  assert.equal(kindOf('bin/tool', '#!/usr/bin/env node\n'), 'js')
  assert.equal(kindOf('.github/workflows/a.yaml'), 'workflow')
  assert.equal(kindOf('data.json'), null)
})

test('checkFootguns: the bad fixture shows every class; the good fixture is clean; vendor/ is ignored', () => {
  const bad = new Set(rules(checkFootguns(ctxFor(makeRepo('bad-skill'))).findings))
  for (const r of ['curl-pipe-shell', 'python-c-without-I', 'rm-rf-variable', 'chmod-777', 'exec-string', 'shell-true', 'eval', 'os-system', 'unsafe-yaml-load', 'pull-request-target', 'unpinned-action', 'script-injection', 'no-permissions']) assert.ok(bad.has(`footguns/${r}`), r)
  assert.deepEqual(checkFootguns(ctxFor(makeRepo('good-skill', { files: { 'vendor/lib.sh': 'curl x | sh\n' } }))).findings, [])
})

test('every footgun finding is a warning or notice, never an error', () => {
  const levels = new Set(checkFootguns(ctxFor(makeRepo('bad-skill'))).findings.map((f) => f.level))
  assert.ok(!levels.has('error'))
})
