# skill-ci

[![test](https://github.com/VinVirtual/skill-ci/actions/workflows/test.yml/badge.svg)](https://github.com/VinVirtual/skill-ci/actions/workflows/test.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Check a Claude Code skill repository the way a careful maintainer would before publishing it. One GitHub Action, and the same checks as a local command.

![The skill-ci job summary for a deliberately broken skill: 10 errors and 18 warnings across SKILL.md, README, licence, secrets, script safety and a fresh-clone test that fails because a data file was never committed](docs/summary.png)

The routine it replaces: open SKILL.md and check the frontmatter, compare the name with the folder, count the description, click every link, look for a licence, grep for keys and email addresses, clone the repo somewhere clean and run the tests, check the media sizes, and read the scripts for `shell=True` and `curl | sh`. skill-ci does all of it on every push and writes the result as a job summary.

It is plain Node.js (20+) and git. No packages to install, no Docker.

## What it checks

| Check | Errors | Warnings |
|---|---|---|
| **SKILL.md** (every one in the repo) | no frontmatter or invalid YAML; `name` missing, not kebab-case, over 64 characters, or not matching the folder (the repository name for a root SKILL.md); `description` missing, over 1024 characters or holding XML tags; empty body; linked file missing; absolute home path | description too short or never says when to use the skill; body over 500 lines; inline-code path under the skill's own folders missing; name with a reserved word |
| **README** | missing; image missing; `git clone ... ~/.claude/skills/<folder>` into a folder not named like the skill | no install command; no licence mention; broken relative link; badge for a workflow that does not exist |
| **LICENSE** | missing or empty | `[year]`-style placeholders; MIT/BSD/ISC without a copyright line; `package.json` names a different licence |
| **Secrets and personal data** | private keys; AWS key ids and secret keys; GitHub, GitLab, Anthropic, OpenAI (new and legacy), OpenRouter, Groq, Slack, Discord, Telegram, Google, Stripe, SendGrid, Twilio, Hugging Face, npm, PyPI and DigitalOcean tokens; Azure storage keys; bearer tokens in `Authorization` headers; npm `_authToken`; JWTs; passwords in URLs; personal email addresses (any script); committed `.env`, `.pem`, `id_rsa`, `.npmrc`, `.pypirc` | hard-coded `password = "..."` or `API_KEY=...`; Stripe test keys; key bodies without a header; home paths that name a user; files that could not be scanned |
| **Script safety** | | `python -c` without `-I`; `shell: true` / `shell=True`; child_process `exec`/`execSync` (stronger when the string is built from variables); `os.system`; `eval` / `new Function`; `curl \| sh`; `rm -rf "$VAR"/`; `chmod 777`; TLS checks off; `yaml.load`. Workflows: actions not pinned by SHA, `pull_request_target`, no `permissions:`, event text pasted into `run:` |
| **Media budget** | a committed media file (images, video, audio, 3D, archives, model weights) over 5 MB; all of them over 15 MB; any other file over 10 MB; the whole repository over 50 MB | |
| **Fresh-clone test** | the repo's tests fail in a clean clone of the last commit | no test command found |
| **Demo** | the configured demo command fails or writes nothing | the outputs were not rewritten |

Every finding carries a rule id (`skill-md/name-mismatch`), a file and line where there is one, and usually a fix. Secret values are never printed: reports give their type and length only.

Script safety findings are warnings on purpose. They are patterns worth a second look, not proof of a hole: `shell: true` with a fixed command is fine. Read the line.

## Install

As a GitHub Action, add [`examples/skill-ci.yml`](examples/skill-ci.yml) to your skill repository as `.github/workflows/skill-ci.yml`:

```yaml
on: { push: { branches: [main] }, pull_request: {} }   # pull_request, never pull_request_target
permissions:
  contents: read
# ...
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: VinVirtual/skill-ci@<full commit SHA> # v0.1.0
```

Read [Security](#security) before turning it on for a repository that takes pull requests.

As a local command (and as a skill, so Claude can run it for you):

```bash
git clone https://github.com/VinVirtual/skill-ci ~/.claude/skills/skill-ci
~/.claude/skills/skill-ci/check_env.sh
```

## Quick start

```bash
S=~/.claude/skills/skill-ci
$S/skill-ci check path/to/my-skill --no-run    # read files only: SKILL.md, README, LICENSE, secrets, scripts, media
$S/skill-ci check path/to/my-skill             # also: clone, run the tests, run the demo
$S/skill-ci check . --summary out.md --html out.html --badge badge.json
$S/skill-ci init path/to/my-skill              # write a starter .skill-ci.yml
```

Exit codes: 0 passed, 1 failed, 2 usage or config error. Warnings do not fail the run unless you pass `--fail-on warning`.

## Configuration

Everything is optional. `.skill-ci.yml` at the repository root:

```yaml
name: my-skill                 # expected SKILL.md name (default: repository or folder name)
ignore: [ "tests/fixtures/**" ]  # left out of every check
disable: [ readme/no-install ] # rule ids (or whole checks) to turn off
fail-on: error                 # error | warning | never
checks: { install: true, demo: true }
test:
  install: npm ci              # default: worked out from package.json, requirements*.txt
  command: npm test            # default: package.json "test", else the test step in .github/workflows, pytest, or `make test`
  timeout: 600
demo:
  command: node scripts/demo.mjs --out out
  outputs: [ "out/*.png", "out/*.mp4" ]   # uploaded as a workflow artifact
media: { max-file-mb: 5, max-total-mb: 15, max-other-file-mb: 10, max-repo-mb: 50 }
max-runtime: 1800              # seconds for all repository commands together
secrets:
  allowlist: .skill-ci-allow   # one value per line, /regex/ lines, or path:<glob>
  allow-emails: [ "*@my-company.example" ]
footguns:
  ignore: [ "vendor/**", "third_party/**", "dist/**", "**/*.min.js" ]   # the default; a list here replaces it
```

Unknown keys are errors with a "did you mean" hint, so a typo never turns a check off quietly. To silence one line, add a comment with `skill-ci: allow` (optionally followed by rule ids) on it.

## Security

skill-ci reads files that anyone who opens a pull request can write, and its fresh-clone test and demo run the repository's own commands. Treat both as hostile. What skill-ci does about it:

- **Repository commands run with an allow-listed environment**: `PATH`, locale and `TZ`, plus `CI`, `SKILL_CI` and a throwaway `HOME`/`TMPDIR`. Tokens and every `GITHUB_*`, `ACTIONS_*` and `RUNNER_*` variable are dropped, so the code cannot write `$GITHUB_ENV`/`$GITHUB_PATH` or reach the runtime token.
- **They run in a throwaway clone with its origin remote removed**, never in your checkout; that includes the demo. Its output files are copied out (regular files only, no symlinks, nothing from `.git`, at most 200 files and 500 MB) before the clone is deleted.
- **Hard time limits**: each command has its own limit (`test.timeout`, `demo.timeout`), and `max-runtime` (1800 s) covers all of them together. When the limit passes, the whole process group is killed, plus anything that slipped out with `setsid`. skill-ci does not wait for background processes.
- **Fork pull requests and `pull_request_target` runs are untrusted by default.** No repository command runs (the summary says "fresh-clone test not run"), and the overrides a pull request could use to hide findings are ignored. `trust-pull-requests: "true"` turns this off; don't.
- **`lock-config: "true"`** (CLI `--lock-config`) ignores those overrides on every run: `ignore`, `disable`, `fail-on`, `checks`, `.skill-ci-allow`, `allow-emails`, `footguns.ignore` and inline `skill-ci: allow` comments. To keep your own settings anyway, check out the base branch's `.skill-ci.yml` somewhere outside the repository folder and pass it as `config`.
- **Output is cleaned before it is published.** Control characters and ANSI escapes are removed, Markdown outside code spans is escaped, and every printed line except the annotations sits inside `::stop-commands::<random>`. Secrets and emails in test output are redacted. Secret values never appear, only their length. The summary stays under 1 MB.
- **Symlinks are never followed** (not read, not sized, not uploaded), the config file must be a regular file under 64 KB, and errors never quote file content.
- **Scans cannot be dodged by format.** UTF-16 files are decoded, long lines are scanned in overlapping pieces, unknown binaries and files over 20 MB are reported as not scanned (a warning, so `fail-on: warning` catches them), and every pattern has bounded repetition inside a time budget.

What your workflow must do: trigger on `pull_request`, not `pull_request_target` with a checkout of the pull request head. Keep `persist-credentials: false` and `permissions: contents: read`. Give the job no secrets. Pin skill-ci to a full commit SHA. [`examples/skill-ci.yml`](examples/skill-ci.yml) does all of this.

What remains: repository code still runs as the runner's user on that machine. It can read files the user can read (with `persist-credentials: false` the checkout holds no token) and use the network. Run the fresh-clone test only where that is acceptable; `run-commands: "false"` turns it off.

## Action inputs and outputs

| Input | Default | |
|---|---|---|
| `path` | `.` | folder of the skill repository |
| `config` | | config file, if not `.skill-ci.yml` |
| `fail-on` | from config | `error`, `warning` or `never` |
| `run-commands` | `true` | `false` skips the fresh-clone test and the demo, so no repository code runs (always skipped for fork pull requests and `pull_request_target`) |
| `lock-config` | `false` | `true` ignores the in-repo settings that could hide findings (always on for fork pull requests) |
| `trust-pull-requests` | `false` | `true` runs commands and honours overrides for fork pull requests too; not recommended |
| `badge-file` | | write a [shields.io endpoint](https://shields.io/badges/endpoint-badge) badge JSON here |
| `artifact-name` | `skill-ci-demo` | name of the demo artifact |
| `node-version` | `22` | empty uses the runner's Node |

Outputs: `result` (`pass`, `warn`, `fail`), `errors`, `warnings`, `tests-run`, `badge`. The action writes the job summary, adds file:line annotations to the pull request, uploads the demo files (with a pinned `actions/upload-artifact`), and fails the step last, so the artifact is uploaded even when checks fail.

## How it works

1. **File list**: what git would publish (tracked files plus untracked ones that are not ignored). Outside git, a walk that skips `node_modules`, `.venv` and similar.
2. **Static checks** read those files: SKILL.md (with a small built-in YAML reader for frontmatter), README, LICENSE, the secrets scan, the script scan (strings and comments are stripped from JS and Python first, Markdown is scanned only inside code), and the media sizes.
3. **Fresh-clone test**: `git clone` of the last commit into a temp folder named after the repository (origin removed), then the install and test commands there, with a scrubbed environment and a time limit. The clone is deleted afterwards (`--keep-clone` keeps it).
4. **Demo**: the configured command in the same throwaway clone; the files that match `demo.outputs` are copied to a temp folder for upload.
5. **Report**: console text, Markdown (the job summary), HTML (`--html`), JSON (`--json`) and the badge.

## The example

[`examples/make-example.mjs`](examples/make-example.mjs) runs skill-ci on the two test fixtures and writes [`examples/output/`](examples/output/) and the screenshots in `docs/`:

- `good-skill`: a tidy skill with tests and a demo. Every check passes, the demo writes `out/hello.txt` ([summary](examples/output/good-skill/summary.md), [screenshot](docs/summary-pass.png)).
- `bad-skill`: broken on purpose, with a fake AWS key and a made-up email address planted at run time, and a data file its tests read that was never committed. It fails with 10 errors and 18 warnings; the fresh-clone test fails with `ENOENT: local-data.json` while the same tests pass in the working copy ([summary](examples/output/bad-skill/summary.md), [screenshot](docs/summary.png)).

## Limits

- **Pattern matching, not analysis.** The secrets and script checks match patterns line by line. They miss secrets split across lines or encoded, and they flag test files that hold fake secrets on purpose. Use the allowlist for those.
- **Fake keys that look real are still reported.** Values containing `EXAMPLE`, `dummy` or `placeholder` and stand-in URL passwords (`secret`, `password`) are skipped; anything else is not guessed at.
- The YAML reader covers what frontmatter and the config use (maps, lists, flow collections, quoted, plain and block scalars). Anchors, aliases, tags and multiple documents are refused with a clear error rather than guessed.
- The fresh-clone test runs the repository's own commands. Only run it on code you trust; `--no-run` (or `run-commands: "false"`) reads files only. Python projects get a venv in the clone, and `pip` needs the network.
- Media budget counts committed files only; Git LFS pointers count as their small pointer size.
- Tested on Linux (Node 22 and 24). It needs `bash` and `git`; macOS should work, Windows has not been tested.

## Development

```bash
./skill-ci test      # 152 tests with node --test: the YAML reader, config validation, globs, every check on
                     # strings and on throwaway git repos built from the fixtures, fresh clones, the demo,
                     # Markdown/HTML/annotation/badge output, the command line end to end, and security
                     # regressions (env scrubbing, timeouts that escape with setsid, symlinks, injection into
                     # workflow commands and the summary, pattern timing on hostile input, locked config)
```

The workflow in [`.github/workflows/test.yml`](.github/workflows/test.yml) runs the tests, then runs the action itself on both fixtures (the good one must pass and upload its demo, the bad one must fail with at least 5 errors) and on this repository. Fake secrets in the tests are assembled at run time, so none is committed.

## License

MIT, see [`LICENSE`](LICENSE).
