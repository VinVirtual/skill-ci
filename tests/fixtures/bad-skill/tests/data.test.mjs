import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('reads the local data file', () => {
  const data = JSON.parse(readFileSync(new URL('../local-data.json', import.meta.url), 'utf8'))
  assert.equal(data.ok, true)
})
