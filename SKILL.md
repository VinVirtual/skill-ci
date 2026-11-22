---
name: skill-ci
description: Check a Claude Code skill repository the way a careful maintainer would before publishing it, locally or as a GitHub Action. Lints SKILL.md (frontmatter, kebab-case name that matches the folder, description present and at most 1024 characters, body, referenced files, home paths), the README (install command, licence) and LICENSE; scans the tree for secrets and personal data (key formats, private keys, emails, home paths) with an allowlist; clones the repo to a temp folder and runs its test command there; runs a configured demo and uploads its files as workflow artifacts; holds committed media to a size budget; and warns about script footguns (python -c without -I, shell=True, exec with strings, curl | sh, unpinned actions) with file:line. Writes a Markdown job summary and a shields.io badge. Use when the user wants to check, lint, audit or "get ready to publish" a skill, asks "is my skill ready", "why won't my skill load", "add CI to my skill repo", or wants a pre-release check of SKILL.md.
---

# skill-ci

Runs the checks a maintainer does by hand before publishing a skill: **SKILL.md** → **README** → **LICENSE** → **secrets** → **script safety** → **media budget** → **fresh-clone test** → **demo**. Plain Node 20+ and git, no packages to install. The same code runs as a command and as a GitHub Action.

Skill folder: `~/.claude/skills/skill-ci/` (written below as `$S`). Every command is `$S/skill-ci <command>`.

```
$S/skill-ci                  the command line (check, init, rules, env, test)
$S/action.yml                the GitHub Action (composite; runs src/cli.mjs)
$S/src/checks/               one file per check
$S/examples/                 a workflow to copy, and the example reports
```

## Workflow

1. **Check the machine**: `$S/check_env.sh`. Node 20+, git and bash.
2. **First pass without running anything**: `$S/skill-ci check <repo> --no-run --verbose`. This reads files only. Show the user the errors first, then the warnings.
3. **Full pass**: `$S/skill-ci check <repo> --verbose`. This also clones the repo's last commit into a temp folder and runs its test command there (`test.command` in `.skill-ci.yml`, else inferred from `package.json`, the test step of the repo's CI workflow, pytest files or a Makefile), then runs the demo if one is configured. It runs the repo's own code, so only do it for a repo the user trusts (their own).
4. **Fix with the user**, one finding at a time. Every finding names its rule (`skill-md/name-mismatch`) and usually a fix. Do not change the user's skill without asking.
5. **CI**: copy `examples/skill-ci.yml` to the repo's `.github/workflows/`. It runs on pushes and pull requests, writes the job summary, annotates files, and uploads the demo files.
6. **Settings**: `$S/skill-ci init <repo>` writes a starter `.skill-ci.yml` with every key and its default.

## What each check looks at

- **SKILL.md**: frontmatter present and valid YAML; `name` present, kebab-case, at most 64 characters, matching the folder (or the repository name for a root SKILL.md); `description` present, at most 1024 characters, no XML tags, says when to use it; a body; linked files exist; inline-code paths under the skill's own folders exist; no absolute home paths. Every SKILL.md in the repo is checked, so plugin repos with `skills/<name>/SKILL.md` work.
- **README**: present; an install command; `git clone ... ~/.claude/skills/<folder>` lands in a folder named like the skill; mentions the licence; relative links and images exist; a workflow badge points at a workflow that exists.
- **LICENSE**: present, recognised (MIT, Apache-2.0, GPL, BSD, ISC, MPL, Unlicense, CC0), no `[year]` placeholders, agrees with `package.json`.
- **Secrets and personal data**: private keys, AWS, GitHub, Anthropic, OpenAI, Slack, Google, Stripe, Hugging Face and npm tokens, JWTs, passwords in URLs (errors); hard-coded `password = "..."` (warning); personal emails (noreply and example domains are fine); home paths that name a user; committed `.env`, `.pem` or `id_rsa` files. Values are masked in every report.
- **Script safety** (warnings): `python -c` without `-I`, `shell: true` / `shell=True`, child_process `exec`, `os.system`, `eval`, `curl | sh`, `rm -rf "$VAR"/`, `chmod 777`, TLS checks off, `yaml.load`; in workflows, actions not pinned by SHA, `pull_request_target`, no `permissions:`, event text pasted into `run:`.
- **Media budget**: committed images, video, audio, 3D and PDF files; 5 MB per file and 15 MB in total by default.

## Options

`--no-run`, `--only skill-md,readme`, `--fail-on error|warning|never`, `--name <expected-name>`, `--summary out.md`, `--html out.html`, `--badge badge.json`, `--json`, `--timeout <seconds>`, `--keep-clone`, `--verbose`. Exit codes: 0 passed, 1 failed, 2 usage or config error.

## False positives

Findings are pattern matches. Before telling the user something is a leak or a hole, open the line. Test files that hold fake secrets on purpose are common. Silence a real false positive in one of three ways, narrowest first: a `skill-ci: allow <rule-id>` comment on the line; the value (or `path:<glob>`) in `.skill-ci-allow`; `disable: [rule-id]` in `.skill-ci.yml`.

## Troubleshooting

- **name-mismatch on a root SKILL.md**: the expected name comes from the folder (or from `GITHUB_REPOSITORY` in Actions). A local checkout in a differently named folder needs `--name <skill-name>`.
- **test-failed in the fresh clone but tests pass locally**: a file the tests need is ignored or never committed. `--keep-clone` keeps the clone to look at.
- **no-test-command**: set `test.command` in `.skill-ci.yml`.
- **Python tests**: the inferred install makes a venv in the clone and installs `pytest` plus `requirements*.txt` from the network.
