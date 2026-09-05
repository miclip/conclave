/**
 * `waitFor` is the thing that replaces a guessed sleep, so what it guarantees is worth pinning
 * exactly. Three claims, and each one is a way the sleep it replaces was wrong:
 *
 *   - it returns as soon as the condition holds, rather than after a duration
 *   - it does not return at all if the condition never holds, which a sleep always did
 *   - what it throws NAMES the condition, because the whole complaint in #197 was that a
 *     precondition failure was being reported as a finding about the subject
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { ConditionNeverMet, waitFor } from './waitFor.ts'

test('waitFor returns as soon as the condition holds, not after a duration', async () => {
  let ready = false
  setTimeout(() => (ready = true), 40)

  const started = Date.now()
  await waitFor(() => ready, { within: 5_000, describe: 'the flag to flip', pollMs: 5 })
  const took = Date.now() - started

  // The bound is 5s and this returns in tens of ms. A sleep sized to the bound would not, and a
  // sleep sized to the delay would be the guess this exists to remove.
  assert.ok(took < 1_000, `returned in ${took}ms, so it waited for the condition and not the bound`)
})

test('waitFor costs nothing when the condition already holds', async () => {
  const started = Date.now()
  await waitFor(() => true, { within: 5_000, describe: 'a condition already true', pollMs: 500 })
  const took = Date.now() - started
  // Polled BEFORE sleeping. Getting this backwards would put a poll interval on the front of
  // every wait in the suite, which is how "wait for the effect" acquires a reputation for slow.
  assert.ok(took < 400, `returned in ${took}ms without paying a poll interval first`)
})

test('waitFor throws when the condition never holds, naming the condition', async () => {
  await assert.rejects(
    () => waitFor(() => false, { within: 60, describe: 'the child to receive any byte', pollMs: 5 }),
    (err: unknown) => {
      assert.ok(err instanceof ConditionNeverMet, 'a typed failure, so a caller can tell it apart')
      // The message is the deliverable. `nothing arrived at all from a 8205 B write` was the old
      // one and it described the wrong layer.
      assert.match(String((err as Error).message), /the child to receive any byte/)
      assert.match(String((err as Error).message), /never happened/)
      return true
    },
  )
})

test('waitFor waits at least its bound before giving up', async () => {
  const started = Date.now()
  await assert.rejects(() => waitFor(() => false, { within: 120, describe: 'never', pollMs: 5 }))
  const took = Date.now() - started
  // A bound that gives up early is a margin again, and a margin is what #197 is about.
  assert.ok(took >= 120, `gave up after ${took}ms, having promised to wait 120ms`)
})

test('waitFor does not overshoot its bound by a whole poll interval', async () => {
  // The last sleep is clamped to what is left. Without the clamp a 120ms bound polled at 500ms
  // waits 500ms, and every such wait in the suite pays for it.
  const started = Date.now()
  await assert.rejects(() => waitFor(() => false, { within: 120, describe: 'never', pollMs: 500 }))
  const took = Date.now() - started
  assert.ok(took < 400, `gave up after ${took}ms, close to the 120ms bound rather than the poll interval`)
})
