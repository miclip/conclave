/**
 * Tab completion, and the two meanings of `@`.
 *
 *   node --test src/repl/complete.test.ts
 */

import { strict as assert } from 'node:assert'
import {  } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import { suggest } from './complete.ts'

function tree(t: TestContext): string {
  const dir = tempDir(t, 'conclave-complete')
  mkdirSync(join(dir, 'src', 'relay'), { recursive: true })
  writeFileSync(join(dir, 'src', 'relay', 'relay.ts'), '')
  writeFileSync(join(dir, 'src', 'relay', 'run.ts'), '')
  writeFileSync(join(dir, 'README.md'), '')
  mkdirSync(join(dir, '.git'), { recursive: true })
  return dir
}


const CMDS = ['/pause', '/continue', '/abort', '/help']

test('> offers both participants and the default, so the default is discoverable', (t) => {
  // Plain text reaching both is the one part of addressing you learn by NOT doing
  // something. Listing it beside the narrowing options makes the whole choice legible.
  const dir = tree(t)
  const r = suggest('>', 1, dir, CMDS)
  assert.deepEqual(r?.items, ['>advisor', '>implementer', '>both'])
  assert.equal(r?.start, 0)
  assert.equal(r?.end, 1)
})

test('> narrows as it is typed', (t) => {
  const dir = tree(t)
  assert.deepEqual(suggest('>i', 2, tree(t), CMDS)?.items, ['>implementer'])
  assert.equal(suggest('>zz', 3, dir, CMDS), undefined)
})

test('> offers the seats that are actually running, not a fixed pair', (t) => {
  // #93. The menu listed `advisor` and `implementer` whatever the run was, so a session with
  // two implementer seats was taught that the second one -- visible in the box, named by
  // `/state`, routable by the transport all along -- could not be addressed. The list comes
  // from `relay.participants` now, which is the same list the relay resolves an address
  // against, so what the menu offers and what routing accepts cannot drift apart.
  const dir = tree(t)
  const seats = ['advisor', 'implementer', 'implementer-2', 'reviewer']
  assert.deepEqual(suggest('>', 1, dir, CMDS, seats)?.items, [
    '>advisor',
    '>implementer',
    '>implementer-2',
    '>reviewer',
    '>both',
  ])
  // Narrowing keeps the seat whose id is a PREFIX of another's. `>implementer` is itself a
  // seat, so typing it whole must still offer it rather than only the longer one.
  assert.deepEqual(suggest('>implementer', 12, dir, CMDS, seats)?.items, ['>implementer', '>implementer-2'])
  assert.deepEqual(suggest('>implementer-', 13, dir, CMDS, seats)?.items, ['>implementer-2'])
})

test('a slash offers commands, but only as the first token', (t) => {
  const dir = tree(t)
  assert.deepEqual(suggest('/c', 2, dir, CMDS)?.items, ['/continue'])
  assert.equal(suggest('say a/b', 7, dir, CMDS), undefined, 'a slash in prose is a slash')
})

test('@ offers paths, and the span replaces the sigil too', (t) => {
  const dir = tree(t)
  const r = suggest('look @src/rel', 13, dir, CMDS)
  assert.deepEqual(r?.items, ['@src/relay/'])
  // start covers the `@`, so accepting replaces the whole token rather than doubling it.
  assert.equal(r?.start, 5)
  assert.equal(r?.end, 13)
  assert.equal(r?.suffix, '', 'a directory gets no trailing space; the next key descends')
})

test('nothing to suggest returns nothing rather than an empty menu', (t) => {
  const dir = tree(t)
  assert.equal(suggest('ordinary prose', 14, dir, CMDS), undefined)
  assert.equal(suggest('', 0, dir, CMDS), undefined)
})

test('dotfiles stay hidden unless asked for', (t) => {
  // `@` would otherwise offer `.git` ahead of anything useful.
  const dir = tree(t)
  assert.ok(!(suggest('see @', 5, dir, CMDS)?.items ?? []).some((c) => c.startsWith('@.')))
  assert.ok((suggest('see @.g', 7, dir, CMDS)?.items ?? []).some((c) => c.includes('.git')))
})
