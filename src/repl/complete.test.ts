/**
 * Tab completion, and the two meanings of `@`.
 *
 *   node --test src/repl/complete.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { suggest } from './complete.ts'

function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-complete-'))
  mkdirSync(join(dir, 'src', 'relay'), { recursive: true })
  writeFileSync(join(dir, 'src', 'relay', 'relay.ts'), '')
  writeFileSync(join(dir, 'src', 'relay', 'run.ts'), '')
  writeFileSync(join(dir, 'README.md'), '')
  mkdirSync(join(dir, '.git'), { recursive: true })
  return dir
}


const CMDS = ['/pause', '/continue', '/abort', '/help']

test('> offers both participants and the default, so the default is discoverable', () => {
  // Plain text reaching both is the one part of addressing you learn by NOT doing
  // something. Listing it beside the narrowing options makes the whole choice legible.
  const dir = tree()
  const r = suggest('>', 1, dir, CMDS)
  assert.deepEqual(r?.items, ['>advisor', '>implementer', '>both'])
  assert.equal(r?.start, 0)
  assert.equal(r?.end, 1)
})

test('> narrows as it is typed', () => {
  const dir = tree()
  assert.deepEqual(suggest('>i', 2, tree(), CMDS)?.items, ['>implementer'])
  assert.equal(suggest('>zz', 3, dir, CMDS), undefined)
})

test('a slash offers commands, but only as the first token', () => {
  const dir = tree()
  assert.deepEqual(suggest('/c', 2, dir, CMDS)?.items, ['/continue'])
  assert.equal(suggest('say a/b', 7, dir, CMDS), undefined, 'a slash in prose is a slash')
})

test('@ offers paths, and the span replaces the sigil too', () => {
  const dir = tree()
  const r = suggest('look @src/rel', 13, dir, CMDS)
  assert.deepEqual(r?.items, ['@src/relay/'])
  // start covers the `@`, so accepting replaces the whole token rather than doubling it.
  assert.equal(r?.start, 5)
  assert.equal(r?.end, 13)
  assert.equal(r?.suffix, '', 'a directory gets no trailing space; the next key descends')
})

test('nothing to suggest returns nothing rather than an empty menu', () => {
  const dir = tree()
  assert.equal(suggest('ordinary prose', 14, dir, CMDS), undefined)
  assert.equal(suggest('', 0, dir, CMDS), undefined)
})

test('dotfiles stay hidden unless asked for', () => {
  // `@` would otherwise offer `.git` ahead of anything useful.
  const dir = tree()
  assert.ok(!(suggest('see @', 5, dir, CMDS)?.items ?? []).some((c) => c.startsWith('@.')))
  assert.ok((suggest('see @.g', 7, dir, CMDS)?.items ?? []).some((c) => c.includes('.git')))
})
