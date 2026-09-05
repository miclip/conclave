/**
 * Wait for a condition to become true, or say which condition it was that never did.
 *
 * This exists because the same defect has now been fixed three times in one file and stayed
 * fixed once. A test that needs a child process to have read some bytes writes
 *
 *     await settle(1800)          // the child starts reading at 1500ms
 *     assert.ok(read().length > 0)
 *
 * and has thereby asserted a 300ms margin against a timer in ANOTHER process. On an unloaded
 * laptop the margin is enormous; on a shared CI runner it is not, and the assertion that fails
 * is the one below the sleep. So the failure reads as a finding about the subject under test --
 * `nothing arrived at all from a 8205 B write` -- when what actually happened is that the test
 * could not reach its own preconditions (#178, #197).
 *
 * Widening the sleep is the fix that does not hold, because the next runner is slower again and
 * because the number is chosen by guess each time. Waiting for the CONDITION holds at any speed
 * and is strictly stronger than any sleep: it cannot return before the thing has happened, and
 * it does not sit still after it has.
 *
 * The bound is not a margin. It is the point past which "slow" has become "never", and blowing
 * it is a real failure -- reported with `describe`, so the message names the precondition that
 * was not met rather than the assertion that never got to run.
 */

const DEFAULT_POLL_MS = 25

export class ConditionNeverMet extends Error {
  readonly waitedMs: number

  constructor(describe: string, waitedMs: number) {
    super(`waited ${waitedMs}ms for ${describe}, which never happened`)
    this.name = 'ConditionNeverMet'
    this.waitedMs = waitedMs
  }
}

/**
 * Resolve once `condition()` returns true; throw `ConditionNeverMet` if it has not within
 * `within` ms.
 *
 * `condition` is polled rather than subscribed to, because the things worth waiting for here --
 * a file a child process is appending to, a record another task writes -- offer no event to
 * subscribe to. Polling is checked FIRST, so a condition that is already true costs no delay.
 */
export async function waitFor(
  condition: () => boolean,
  opts: { within: number; describe: string; pollMs?: number },
): Promise<void> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const started = Date.now()
  for (;;) {
    if (condition()) return
    const waited = Date.now() - started
    if (waited >= opts.within) throw new ConditionNeverMet(opts.describe, waited)
    await new Promise((r) => setTimeout(r, Math.min(pollMs, opts.within - waited)))
  }
}
