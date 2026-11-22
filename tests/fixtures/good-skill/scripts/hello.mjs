#!/usr/bin/env node
// Writes a greeting for a name to a file: node scripts/hello.mjs <out-file> [name]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const greeting = (name) => `Hello, ${String(name || 'world').trim() || 'world'}!\n`

if (process.argv[1] && process.argv[1].endsWith('hello.mjs')) {
  const [out, name] = process.argv.slice(2)
  if (!out) { console.error('usage: node scripts/hello.mjs <out-file> [name]'); process.exit(2) }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, greeting(name))
}
