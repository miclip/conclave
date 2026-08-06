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
import { complete } from './complete.ts'

function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-complete-'))
  mkdirSync(join(dir, 'src', 'relay'), { recursive: true })
  writeFileSync(join(dir, 'src', 'relay', 'relay.ts'), '')
  writeFileSync(join(dir, 'src', 'relay', 'run.ts'), '')
  writeFileSync(join(dir, 'README.md'), '')
  mkdirSync(join(dir, '.git'), { recursive: true })
  return dir
}

test('a leading > addresses a participant', () => {
  const dir = tree()
  const r = complete('>a', 2, dir)
  assert.equal(r?.line, '>advisor ')
  assert.equal(r?.cursor, 9)
})

test('ambiguous participants complete as far as they agree, and report the rest', () => {
  // Repeated tabs converge rather than cycling, so a wrong guess is never silently chosen.
  const dir = tree()
  const r = complete('>', 1, dir)
  assert.deepEqual(r?.candidates, ['advisor', 'implementer'])
  assert.equal(r?.line, '>', 'nothing is agreed beyond the sigil')
})

test('@ is always a path, wherever it appears', () => {
  // It used to depend on position, because `@` carried both meanings. `>` took addressing,
  // so `@` now means what it means in Claude Code and Codex — including once forwarded.
  const dir = tree()
  const r = complete('look at @src/relay/rel', 22, dir)
  assert.equal(r?.line, 'look at @src/relay/relay.ts ')
})

test('a directory completes with its separator, so the next tab descends', () => {
  const dir = tree()
  const r = complete('see @src', 8, dir)
  assert.equal(r?.line, 'see @src/', 'no trailing space, or the next tab cannot descend')
  const next = complete(r!.line, r!.cursor, dir)
  assert.equal(next?.line, 'see @src/relay/', 'and it does descend')
})

test('dotfiles stay hidden unless asked for', () => {
  // `@` would otherwise offer `.git` ahead of anything useful.
  const dir = tree()
  const shown = complete('see @', 5, dir)
  assert.ok(!(shown?.candidates ?? []).some((c) => c.startsWith('.')))
  const asked = complete('see @.g', 7, dir)
  assert.ok((asked?.candidates ?? [asked?.line ?? '']).some((c) => c.includes('.git')))
})

test('a leading @ still completes a path, not a participant', () => {
  // The old rule would have offered `advisor` here. There is no such rule now.
  const dir = tree()
  const r = complete('@RE', 3, dir)
  assert.equal(r?.line, '@README.md ')
})

test('no sigil under the cursor completes nothing', () => {
  const dir = tree()
  assert.equal(complete('just typing', 11, dir), undefined)
  assert.equal(complete('mail me at foo@bar', 18, dir), undefined, 'an email is not a path')
  assert.equal(complete('a > b', 5, dir), undefined, 'a > mid-line is not addressing')
})
