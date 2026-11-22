---
name: good-skill
description: Writes a friendly greeting file for a name, as a tiny example of a well-kept skill. Use when the user asks for a greeting file, says "greet Ada", or wants to see how a skill repository is laid out.
---

# good-skill

Writes `out/hello.txt` with a greeting.

## Workflow

1. Run `scripts/hello.mjs` with the output path: `node scripts/hello.mjs out/hello.txt Ada`.
2. Read the file back and show it to the user.

Options and examples are in [references/usage.md](references/usage.md).

## Troubleshooting

- "Cannot find module": run the command from the skill folder (`~/.claude/skills/good-skill/`).
