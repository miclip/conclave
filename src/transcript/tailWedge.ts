/**
 * Hold one `RewriteAwareTail.poll` open, for tests about what happens to everything behind it.
 *
 * The hold is taken INSIDE the tail's poll, which is inside the view's single read operation --
 * the same place a hung `stat` or `read` would take it. Holding the view's `poll()`/`snapshot()`
 * from outside instead wedges only the caller, and the caller giving up was never the problem:
 * `BoundedSingleFlight` already handles that. What everyone else does about the read is the
 * problem.
 *
 * Lives outside a `.test.ts` file because two suites need it -- one over the view directly and
 * one over a real adapter -- and the alternative is two copies of a prototype patch drifting
 * apart. `adapters/fakeCli.ts` and `rotation/fakeSession.ts` are the same idea.
 *
 * The patch is GLOBAL for as long as it is installed. Every user must `restore()` it, and must
 * `release()` too, or a later read inherits the hold.
 */

import { RewriteAwareTail, type ReadLease, type TailPoll } from './tail.ts'

export interface TailWedge {
  /** Hold the NEXT poll, and only that one. Nothing is held before this is called. */
  arm: () => void
  /**
   * Hold the next `count` polls, and no more.
   *
   * For a subject that RE-READS. `arm()` proves a caller survives one abandonment; a caller
   * that retries until it succeeds needs the wedge to still be there for attempt two, and then
   * to be gone, or the test cannot tell "it kept trying" from "it tried once".
   */
  armNext: (count: number) => void
  /**
   * Hold EVERY poll from now on, not just the next.
   *
   * For subjects that have a tailer of their own, and for counting. A real adapter polls on a
   * 400ms interval, so `arm()` almost always catches the tailer rather than the read the test is
   * about -- and a read the patch is not armed for goes straight through, which makes it
   * invisible to `held` and indistinguishable, to a test watching that number, from a read that
   * never happened. Holding every poll makes the wedge meet whichever read arrives, and makes
   * `calls` a complete count rather than a partial one.
   *
   * `release()` frees all of them, and `landed` is the first one to come back.
   */
  armAll: () => void
  /**
   * Every `poll` this patch has seen, held or not.
   *
   * The instrument for the invariant that matters most about a wedged read: that no SECOND
   * filesystem operation was authorised while the first was outstanding. `held` counts only the
   * ones the wedge caught, so a test watching it cannot tell "nothing else read" from "something
   * else read and was not armed for". This counts the calls themselves.
   */
  readonly calls: number
  /** True once a poll has actually been caught. A test that asserts before this proves nothing. */
  readonly taken: boolean
  /** How many polls have been caught so far. What a test waits on when it expects several. */
  readonly held: number
  /** Let the held poll proceed. Idempotent. */
  release: () => void
  /** The held poll's eventual result, once released. */
  landed: Promise<TailPoll<Record<string, any>>>
  /** Put the real `poll` back. */
  restore: () => void
}

export function wedgeOneTailPoll(): TailWedge {
  const original = RewriteAwareTail.prototype.poll
  /** How many more polls to catch. Zero until armed; `Infinity` under `armAll`. */
  let remaining = 0
  let held = 0
  let calls = 0

  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  let land!: (r: TailPoll<Record<string, any>>) => void
  const landed = new Promise<TailPoll<Record<string, any>>>((r) => {
    land = r
  })

  RewriteAwareTail.prototype.poll = async function (
    this: RewriteAwareTail<Record<string, any>>,
    lease?: ReadLease,
  ): Promise<TailPoll<Record<string, any>>> {
    calls++
    if (remaining <= 0) return original.call(this, lease)
    remaining--
    held++
    await gate
    // Released at last, and it now does what a very slow read would do: it reads, and what it
    // finds it COMMITS. Its caller may be long gone -- that is what the lease answered -- but
    // the read was never that caller's to abandon, and there is no rival reader for its records
    // to conflict with. See `TranscriptSessionView`'s `#inflight`.
    const res = await original.call(this, lease)
    // First one home wins; `land` is a resolve, so the rest are no-ops under `armAll`.
    land(res)
    return res
  }

  return {
    arm: () => {
      remaining = 1
    },
    armNext: (count: number) => {
      remaining = count
    },
    armAll: () => {
      remaining = Number.POSITIVE_INFINITY
    },
    get calls(): number {
      return calls
    },
    get taken(): boolean {
      return held > 0
    },
    get held(): number {
      return held
    },
    release,
    landed,
    restore: () => {
      RewriteAwareTail.prototype.poll = original
    },
  }
}
