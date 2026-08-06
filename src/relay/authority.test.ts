/**
 * Authority conflicts: an advisor undoing what it could not see.
 *
 * The detector is a heuristic and is deliberately biased. A false positive costs one pause
 * the human resolves in a word; a false negative leaves the status quo, where the
 * implementer decides alone and three live runs produced three different answers. So these
 * tests care much more about the misses than the noise.
 *
 *   node --test src/relay/authority.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { describeConflict, detectConflict, extractTokens, originOf } from './authority.ts'
import type { RelayMessage } from './message.ts'

function restricted(text: string, seq = 4): RelayMessage {
  return {
    seq,
    at: 0,
    from: 'human',
    fromRank: 'human',
    to: ['implementer'],
    kind: 'aside',
    text,
    visibility: 'restricted',
    excluded: ['advisor'],
  }
}

test('tokens are drawn from filenames, paths, quoted spans and identifiers', () => {
  const t = extractTokens(
    'Without reading any file, tell me the word you chose earlier, then write it into two.txt.',
  )
  assert.ok(t.includes('two.txt'))
  // Plain prose must not become a token, or every instruction matches every aside.
  assert.ok(!t.includes('word'))
  assert.ok(!t.includes('file'))

  const t2 = extractTokens('Name the function with the prefix `ZQX_` — for example ZQX_add.')
  assert.ok(t2.includes('ZQX_'))
  assert.ok(t2.includes('ZQX_add'))
})

test('the live case fires: an advisor removing a file an aside asked for', () => {
  // From the 30-minute pause run, verbatim except the absolute path — a tracked source
  // file may not hardcode a home directory, which the config suite enforces and which
  // caught this file on its first commit.
  const origin = originOf(
    restricted('Without reading any file, tell me the word you chose earlier, then write it into two.txt.'),
  )
  const conflict = detectConflict(
    'Remove /repo/.conclave/scratch-pause/two.txt, leave one.txt unchanged, and wait.',
    [origin],
  )
  assert.ok(conflict, 'this is the case the whole mechanism exists for')
  assert.equal(conflict.verb.toLowerCase(), 'remove')
  assert.deepEqual(conflict.matched, ['two.txt'])
})

test('path segments are not tokens, or every absolute path matches every other', () => {
  // Observed live: an aside and an instruction both naming absolute paths in this checkout
  // matched on `coding-repl` and `scratch-authority`. Over-detection is the safe direction
  // in general; a detector that fires on the repository name is not over-detection, it is
  // noise, and noise is what stops a pause being read.
  const t = extractTokens('Also create /repo/checkout/.conclave/scratch-authority/two.txt with the word.')
  assert.ok(t.includes('two.txt'), 'the basename is the useful handle')
  assert.ok(t.some((x) => x.endsWith('scratch-authority/two.txt')), 'and the full path is kept')
  assert.ok(!t.includes('checkout'), 'a repository name must not be a token')
  assert.ok(!t.includes('scratch-authority'), 'nor an intermediate directory')
})

test('a path in the instruction matches a bare filename in the aside', () => {
  // The aside says `two.txt`; the advisor says an absolute path. Basename matching is what
  // makes those the same thing.
  const origin = originOf(restricted('write it into two.txt'))
  assert.ok(detectConflict('Please delete /tmp/scratch/two.txt now.', [origin]))
})

test('a reversal with no reference to the aside is ordinary traffic', () => {
  const origin = originOf(restricted('write it into two.txt'))
  assert.equal(detectConflict('Remove the unused import from src/relay/relay.ts.', [origin]), undefined)
})

test('a reference to the aside with no reversal is ordinary traffic', () => {
  // Advisors mention files constantly. Only undoing is the conflict.
  const origin = originOf(restricted('write it into two.txt'))
  assert.equal(detectConflict('Add a second line to two.txt.', [origin]), undefined)
})

test('an artifact attributed after the fact is matched too', () => {
  // The aside may name nothing the advisor later references — but the file it produced
  // will be. Attribution is what covers that.
  const origin = originOf(restricted('Do the thing we discussed, quietly.'))
  assert.deepEqual(origin.tokens, [])
  origin.artifacts.push('src/generated/notes.ts')
  const conflict = detectConflict('Revert src/generated/notes.ts, it should not be checked in.', [origin])
  assert.ok(conflict)
  assert.deepEqual(conflict.matched, ['src/generated/notes.ts'])
})

test('`restore` counts, because it reverses a removal', () => {
  const origin = originOf(restricted('Delete the legacy shim at src/compat.ts.'))
  assert.ok(detectConflict('Restore src/compat.ts — removing it broke the build.', [origin]))
})

test('an unrestricted message can never produce a conflict', () => {
  // An instruction everyone saw cannot be reversed by someone who could not see it. Only
  // `restricted` messages become origins, and this asserts the property at the source.
  const open: RelayMessage = { ...restricted('write it into two.txt'), visibility: 'normal', excluded: [] }
  assert.equal(open.visibility, 'normal')
  const origin = originOf(open)
  assert.deepEqual(origin.excluded, [], 'nobody was excluded, so nobody can be surprised by it')
})

test('the description gives the human both sides and never a recommendation', () => {
  const origin = originOf(restricted('write it into two.txt'))
  origin.artifacts.push('.conclave/scratch/two.txt')
  const conflict = detectConflict('Remove two.txt and wait.', [origin])!
  const text = describeConflict(conflict)

  assert.ok(text.includes('two.txt'))
  assert.ok(text.includes('withheld from: advisor'))
  assert.ok(text.includes('changes attributed to it'))
  assert.ok(text.includes('the advisor now says'))
  // §9: assembled, not narrated. It must not tell the human what to conclude.
  assert.ok(/may\s+be correcting a genuine mistake/.test(text))
  assert.ok(!/should (continue|abort|refuse)/i.test(text))
})
