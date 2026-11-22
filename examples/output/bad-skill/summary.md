## skill-ci: `bad-skill` failed

> [!WARNING]
> This run ran repository code with this job's privileges (sandboxed with bubblewrap: no network unless enabled, own /proc, empty /home and /tmp).

**10 errors, 18 warnings, 0 notices** across 7 checks in 0.7 s.

| Result | Check | Errors | Warnings | Details |
|---|---|--:|--:|---|
| ✗ fail | SKILL.md | 5 | 1 | SKILL.md |
| ✗ fail | README | 1 | 3 | README.md |
| ✗ fail | Licence | 1 |  | missing |
| ✗ fail | Secrets and personal data | 2 |  | 11 files scanned |
| ▲ warn | Script safety |  | 14 | 9 files checked |
| ✓ pass | Media size budget |  |  | 0 media files, 0.00 MB of 15 MB |
| ✗ fail | Fresh-clone install test | 1 |  | `npm test` failed in 0.6 s |
| ○ skip | Demo |  |  | no demo.command set |

### SKILL.md

| Level | Where | Finding |
|---|---|---|
| error | `SKILL.md:1` | The frontmatter has no description; Claude uses it to decide when to load the skill. <sub>`skill-md/description-missing`</sub> |
| error | `SKILL.md:2` | name "Bad\_Skill" is not kebab-case \(lowercase letters, digits and single hyphens\).<br><sub>Fix: Try "bad-skill".</sub> <sub>`skill-md/name-not-kebab`</sub> |
| error | `SKILL.md:2` | name "Bad\_Skill" does not match the repository name "bad-skill".<br><sub>Fix: Claude Code finds a skill by its folder; installing with git clone gives the folder the repository's name. Rename one so both read "bad-skill" or "Bad\_Skill".</sub> <sub>`skill-md/name-mismatch`</sub> |
| error | `SKILL.md:5` | Linked file "references/guide.md" is not in the repository. <sub>`skill-md/missing-file`</sub> |
| error | `SKILL.md:7` | Absolute home path "/home/alice/..." will not exist on anyone else's machine.<br><sub>Fix: Use a path relative to the skill folder, or \~/.claude/skills/&lt;name&gt;/.</sub> <sub>`skill-md/home-path`</sub> |
| warning | `SKILL.md:7` | `scripts/missing-helper.py` names a path that is not in the repository. <sub>`skill-md/missing-path`</sub> |

### README

| Level | Where | Finding |
|---|---|---|
| error | `README.md:3` | Image "docs/demo.gif" is not in the repository, so it shows as broken on GitHub. <sub>`readme/missing-image`</sub> |
| warning | `README.md:1` | The README is only 53 characters; say what the skill does, how to install it and how to use it. <sub>`readme/too-short`</sub> |
| warning | `README.md:1` | The README has no install command.<br><sub>Fix: For example: git clone https\://github.com/&lt;you&gt;/bad-skill \~/.claude/skills/bad-skill</sub> <sub>`readme/no-install`</sub> |
| warning | `README.md:1` | The README never mentions the licence.<br><sub>Fix: Add a "\#\# License" section that names it and links to LICENSE.</sub> <sub>`readme/no-licence-section`</sub> |

### Licence

| Level | Where | Finding |
|---|---|---|
| error | `LICENSE` | No LICENSE file at the repository root; without one nobody may legally reuse the skill.<br><sub>Fix: Add a LICENSE file \(MIT is common for skills\).</sub> <sub>`license/missing`</sub> |

### Secrets and personal data

| Level | Where | Finding |
|---|---|---|
| error | `config.js:2` | Looks like an AWS access key id: \[hidden, 20 chars\]. <sub>`secrets/aws-access-key`</sub> |
| error | `notes/maintainers.md:3` | Email address at quietmail.net \(personal data in a public repo\). <sub>`secrets/email`</sub> |

### Script safety

| Level | Where | Finding |
|---|---|---|
| warning | `.github/workflows/ci.yml:1` | The workflow sets no top-level permissions, so its token gets the repository default \(often write\).<br><sub>Fix: Add "permissions: contents: read" at the top level.</sub> <sub>`footguns/no-permissions`</sub> |
| warning | `.github/workflows/ci.yml:2` | `pull_request_target` runs with secrets and write access on code from forks.<br><sub>Fix: Use pull\_request unless you are sure no fork code is checked out or run.</sub> <sub>`footguns/pull-request-target`</sub> |
| warning | `.github/workflows/ci.yml:7` | Action actions/checkout@v4 is pinned to a movable tag or branch, not a commit SHA.<br><sub>Fix: Pin to the full 40-character commit SHA, e.g. uses: actions/checkout@&lt;sha&gt; \# v4.2.2</sub> <sub>`footguns/unpinned-action`</sub> |
| warning | `.github/workflows/ci.yml:8` | Untrusted event text is pasted into a run: script \(script injection\).<br><sub>Fix: Pass it through env: and use "$VAR" in the script.</sub> <sub>`footguns/script-injection`</sub> |
| warning | `scripts/convert.mjs:5` | `exec()` runs its command string through a shell, and this one builds the string from variables \(command injection if any of them comes from input\).<br><sub>Fix: Use execFile/spawn with an argument list instead.</sub> <sub>`footguns/exec-string`</sub> |
| warning | `scripts/convert.mjs:6` | `shell: true` runs the command through a shell, so spaces, quotes, $\(\) and ; in any argument are interpreted.<br><sub>Fix: Pass the program and an argument list with shell off.</sub> <sub>`footguns/shell-true`</sub> |
| warning | `scripts/convert.mjs:7` | `eval`/`new Function` runs a string as code. <sub>`footguns/eval`</sub> |
| warning | `scripts/convert.sh:3` | Downloads a script and pipes it straight into a shell; nothing checks what was downloaded.<br><sub>Fix: Download to a file, verify a checksum or signature, then run it.</sub> <sub>`footguns/curl-pipe-shell`</sub> |
| warning | `scripts/convert.sh:4` | `python -c` without -I: Python puts the current folder first on its import path, so a planted json.py \(or any module name\) in that folder runs instead.<br><sub>Fix: Use `python -I -c ...` \(isolated mode\).</sub> <sub>`footguns/python-c-without-I`</sub> |
| warning | `scripts/convert.sh:5` | `rm -r` on "$VAR/..." deletes from / when the variable is empty.<br><sub>Fix: Use "${VAR:?}/..." so an empty variable stops the script.</sub> <sub>`footguns/rm-rf-variable`</sub> |
| warning | `scripts/convert.sh:6` | Mode 777 lets every user on the machine change the file. <sub>`footguns/chmod-777`</sub> |
| warning | `scripts/helper.py:8` | `shell=True` runs the command through a shell, so spaces, quotes, $\(\) and ; in any argument are interpreted.<br><sub>Fix: Pass a list of arguments with shell=False.</sub> <sub>`footguns/shell-true`</sub> |
| warning | `scripts/helper.py:9` | `os.system`/`os.popen` runs a string through a shell.<br><sub>Fix: Use subprocess.run\(\[...\]\) with a list of arguments.</sub> <sub>`footguns/os-system`</sub> |
| warning | `scripts/helper.py:11` | `yaml.load` without SafeLoader can build arbitrary Python objects from the file.<br><sub>Fix: Use yaml.safe\_load.</sub> <sub>`footguns/unsafe-yaml-load`</sub> |

### Fresh-clone install test

| Level | Where | Finding |
|---|---|---|
| error | — | In a fresh clone, the test command `npm test` failed with exit code 1.<br><sub>Fix: Run it in a fresh clone yourself: a file that is ignored or never committed is the usual cause.</sub> <sub>`install/test-failed`</sub> |

<details><summary>Test output: <code>npm test</code>, exit 1, 0.6 s</summary>

```text

> bad-skill@0.0.1 test
> node --test

✖ reads the local data file (1.511688ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 131.799538

✖ failing tests:

test at tests/data.test.mjs:5:1
✖ reads the local data file (1.511688ms)
  Error: ENOENT: no such file or directory, open '/tmp/skill-ci-clone-W9udU2/bad-skill/local-data.json'
      at readFileSync (node:fs:483:20)
      at TestContext.<anonymous> (file:///tmp/skill-ci-clone-W9udU2/bad-skill/tests/data.test.mjs:6:27)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.start (node:internal/test_runner/test:1262:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {
    errno: -2,
    code: 'ENOENT',
    syscall: 'open',
    path: '/tmp/skill-ci-clone-W9udU2/bad-skill/local-data.json'
  }
```

</details>

<sub>skill-ci 0.1.0 · default settings (no .skill-ci.yml) · findings marked warning are worth a look, not proof of a problem</sub>
