#!/usr/bin/env bash
# Checks what skill-ci needs and prints how to fix anything missing. Works on Linux and macOS.
#   Needed:   Node.js 20+ (22 recommended), git, bash
#   Optional: playwright-core and Chrome, only to re-render docs/summary.png (scripts/screenshot.mjs)
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "MISS  node (version 20 or newer)"
  echo "      install Node.js from https://nodejs.org, or with nvm or brew"
  exit 1
fi
exec node "$D/src/cli.mjs" env
