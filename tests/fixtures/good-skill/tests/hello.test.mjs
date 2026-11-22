import { test } from 'node:test'
import assert from 'node:assert/strict'
import { greeting } from '../scripts/hello.mjs'

test('greets by name', () => assert.equal(greeting('Ada'), 'Hello, Ada!\n'))
test('falls back to world', () => assert.equal(greeting(''), 'Hello, world!\n'))
