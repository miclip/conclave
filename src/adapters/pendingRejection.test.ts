/**
 * A rejected pending slot must not end the process (#267).
 *
 * #263 contained a listener that THROWS: `HookReceiver.#dispatch` wraps `emit` in try/catch and
 * hands the fault on as `listener_error`. A listener that REJECTS walks straight past that --
 * a rejection is delivered to the promise, not up the call stack -- and a rejected promise with
 * no handler is an `unhandledRejection`, whose default action ends the process.
 *
 * Observed, not theorised: a run on 0.5.36 died exactly this way, with #263's containment in its
 * own stack catching correctly and catching the wrong kind of failure.
 *
 * THE WINDOW is the retry. `send()` holds ONE claim across both attempts and says why -- "the
 * window between a corrupted prompt and its re-send is exactly when a second caller could type
 * into the gap, so the retry does not release the slot" -- and while it awaits
 * `#recoverForRetry` it is awaiting RECOVERY, not `keyed`. A hook arriving then rejects a slot
 * nobody is waiting on.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'

/** Resolved from this file, not from the cwd a runner happens to have. */
const REPO = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Whether a rejection with no handler is reported to the process.
 *
 * Node fires `unhandledRejection` on a later tick, so this settles a macrotask after the
 * rejection rather than immediately. The listener is installed for the duration and removed
 * afterwards: leaving one behind would suppress the default for every test that follows, which
 * is the same class of mistake as the bug under test.
 */
async function unhandledFrom(reject: () => void): Promise<unknown[]> {
  const seen: unknown[] = []
  const onUnhandled = (e: unknown): void => {
    seen.push(e)
  }
  const had = process.listeners('unhandledRejection').slice()
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', onUnhandled)
  try {
    reject()
    // Two macrotasks: one for the rejection to settle, one for the report to arrive.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
    for (const l of had) process.on('unhandledRejection', l as never)
  }
  return seen
}

test('#267 the detector itself reports an unhandled rejection', async () => {
  // Without this, a passing test below would prove only that the detector never fires.
  const seen = await unhandledFrom(() => {
    void new Promise((_resolve, rejectIt) => rejectIt(new Error('deliberately unhandled')))
  })
  assert.equal(seen.length, 1, 'the detector must see a genuinely unhandled rejection')
})

test('#267 a promise carrying a no-op catch is not reported, and still rejects for its awaiter', async () => {
  // THE SHAPE OF THE FIX, asserted rather than described. `.catch()` returns a NEW promise and
  // leaves the original rejected, so an awaiter still sees the error and the runtime no longer
  // counts it as nobody's.
  let rejectIt: (e: Error) => void = () => {}
  const keyed = new Promise<never>((_r, rj) => {
    rejectIt = rj
  })
  void keyed.catch(() => {})

  const seen = await unhandledFrom(() => rejectIt(new Error('handled by the guard')))
  assert.equal(seen.length, 0, 'a slot with a handler attached must not reach unhandledRejection')

  await assert.rejects(keyed, /handled by the guard/, 'and the awaiter still gets the error')
})

test('#267 both adapters attach the guard where the claim is made', () => {
  // Pinned on the SOURCE because the window it covers -- a hook landing while `send()` awaits
  // `#recoverForRetry` -- is a race this suite cannot schedule deterministically. Read the file
  // rather than claim a behavioural test that does not exist: a reader deserves to know which
  // of the two this is.
  for (const path of ['src/adapters/claude.ts', 'src/adapters/codex.ts']) {
    const src = readFileSync(join(REPO, path), 'utf8')
    const claim = src.indexOf('const keyed = new Promise<TurnKey>')
    assert.ok(claim > 0, `${path}: the claim site must still exist`)
    const guard = src.indexOf('void keyed.catch(() => {})', claim)
    assert.ok(guard > claim, `${path}: the claim must be guarded before it can be rejected`)
    assert.ok(
      guard - claim < 2000,
      `${path}: the guard must stay with the claim it protects, not drift into another method`,
    )
  }
})
