/**
 * Run code at a chosen point INSIDE a single `RewriteAwareTail.poll` -- between the reads it
 * makes, where #167 lives.
 *
 * `tailWedge.ts` holds a whole poll from the outside, which is the right instrument for "what
 * does everyone behind this read do while it hangs". It is the wrong instrument here, where the
 * question is what the poll does to ITSELF: `poll()` verifies its prefix and reads its suffix,
 * and the bug was that nothing held the file still between the two. A wedge that can only stop
 * the poll before it starts or after it finishes cannot get between them.
 *
 * The seam is `open` itself, and it IS reachable -- which is worth stating plainly, because both
 * #167 and an earlier draft of this file claimed the opposite. A builtin's ESM named exports
 * really are read-only bindings: assigning to the namespace throws, and assigning to the CJS
 * exports object underneath appears to do nothing. That last part is where the wrong conclusion
 * came from. The assignment lands; what was missing is the step that republishes it.
 * `syncBuiltinESMExports()` re-derives the builtin's ESM named exports from the CJS exports
 * object, and because those are LIVE bindings, every importer follows -- including modules that
 * imported and destructured `open` long before the patch existed. So:
 *
 *   createRequire(import.meta.url)('node:fs/promises').open = patched
 *   syncBuiltinESMExports()
 *
 * and `tail.ts` calls the patch, with no module-graph surgery and no ordering constraint on when
 * this file is imported relative to its subject.
 *
 * THE TRIGGER IS A COMPLETED READ, NOT AN OPEN, and that choice is the difference between a test
 * that survives the fix and one that quietly stops testing anything. Counting opens ties the test
 * to the THREE-open structure the bug had; restructure `poll()` to open once and read once -- the
 * actual fix -- and an "open number two" trigger never fires at all. The rewrite would never
 * happen, the projection would come out clean, and the test would go green because it did
 * nothing, which is indistinguishable from green because the bug is gone. A completed read still
 * exists under any structure, so the mutation still lands.
 *
 * `fired` exists so a test can prove the callback ran. Assert it.
 *
 * ONE CONSTRAINT: the patch is process-wide while it is installed. `syncBuiltinESMExports` is not
 * scoped to one importer -- every module in the process that imported `open` gets the patched one
 * -- so the read ordinals count ANY `fs/promises.open` read, not only the tail's. `node --test`
 * gives each test file its own process, and the armed windows are the inside of a single
 * `await tail.poll()`, which is what keeps that honest. `restore()` puts the original back and
 * re-syncs; every user must call it.
 */

import { createRequire, syncBuiltinESMExports } from 'node:module'
import type { FileHandle } from 'node:fs/promises'

/** Called immediately after an intercepted read resolves, and awaited before it returns. */
type AfterRead = () => void | Promise<void>

/** Marks our own patch, so a second install without a `restore()` is an error and not a stack. */
const PATCHED = Symbol.for('conclave.fsWedge.patched')

export interface FsWedge {
  /**
   * Start counting from the next completed read. Ordinals passed to `at()` and `short()` are
   * relative to this, so a test can ignore however many reads the polls before it happened to
   * make. Also clears anything armed but never reached, and resets `fired`.
   */
  arm: () => void
  /** Run `fn` immediately after the `n`th read to COMPLETE since `arm()`. */
  at: (n: number, fn: AfterRead) => void
  /**
   * Run `fn` after the `n`th `open` since `arm()` resolves, BEFORE its handle is handed back --
   * so before anything is asked of it, sizing included.
   *
   * This is the only interval in which the path and the file descriptor can come to disagree,
   * which makes it the only place a test can tell `fh.stat()` from `stat(path)`. Firing between
   * the sizing call and the read cannot: by then a path-`stat` has already resolved the path,
   * while it still pointed at the inode the handle holds, so both spellings compute the same
   * size from the same file and the mutation is inert.
   */
  atOpen: (n: number, fn: AfterRead) => void
  /**
   * `stat()` calls made ON A HANDLE since `arm()`.
   *
   * Sizing from the handle rather than the path is a load-bearing choice and nothing else
   * observes it directly: a poll that sized from the path would still be sizing something. This
   * counts the calls, so "the size came from the handle" is pinned structurally as well as by
   * the behaviour `atOpen` provokes.
   */
  readonly handleStats: number
  /**
   * Make the `n`th read since `arm()` report `bytesRead` however much it really read.
   *
   * Short reads are the case no test can provoke honestly -- they need a signal, an obliging
   * network filesystem, or a write landing inside the syscall -- and they are the case with the
   * worst consequences, so leaving the branch unexecuted was not an option.
   */
  short: (n: number, bytesRead: number) => void
  /**
   * How many callbacks have run since `arm()`. A test that does not assert this proves nothing:
   * a trigger that never fires produces a clean projection, and clean-because-nothing-happened is
   * indistinguishable from clean-because-it-works.
   */
  readonly fired: number
  /** Reads completed since `arm()`. */
  readonly sinceArm: number
  /** Put the real `open` back and republish it. Idempotent. */
  restore: () => void
}

export function wedgeTailReads(): FsWedge {
  const fsp = createRequire(import.meta.url)('node:fs/promises')
  const realOpen = fsp.open
  if (realOpen[PATCHED]) {
    throw new Error('fsWedge: already installed -- restore() the previous wedge first')
  }

  let pending = new Map<number, AfterRead>()
  let openPending = new Map<number, AfterRead>()
  let shorts = new Map<number, number>()
  let reads = 0
  let armedAt = 0
  let opens = 0
  let openArmedAt = 0
  let handleStats = 0
  let fired = 0

  const patched = async (...args: unknown[]): Promise<FileHandle> => {
    const fh: FileHandle = await realOpen(...args)
    opens++
    const onOpen = openPending.get(opens - openArmedAt)
    if (onOpen) {
      openPending.delete(opens - openArmedAt)
      fired++
      await onOpen()
    }
    return new Proxy(fh, {
      get(target, prop) {
        // `target` as the receiver throughout: `FileHandle`'s accessors and methods are bound to
        // real internal state, and handing them the proxy instead is how this kind of wrapper
        // usually breaks.
        const value = Reflect.get(target, prop, target)
        if (typeof value !== 'function') return value
        if (prop === 'stat') {
          return async (...statArgs: unknown[]) => {
            handleStats++
            return Reflect.apply(value, target, statArgs)
          }
        }
        if (prop !== 'read') return value.bind(target)
        return async (...readArgs: unknown[]) => {
          const real = await Reflect.apply(value, target, readArgs)
          reads++
          const ordinal = reads - armedAt
          const forced = shorts.get(ordinal)
          // The buffer keeps the bytes the kernel actually put in it and only the COUNT is
          // falsified, because that is what a real short read looks like: the caller is told how
          // far it may trust a buffer, not handed a shorter one.
          const result = forced === undefined ? real : { ...(real as object), bytesRead: forced }
          if (forced !== undefined) shorts.delete(ordinal)
          const fn = pending.get(ordinal)
          if (fn) {
            // Delete first: the callback provokes I/O of its own, and an interceptor that can
            // re-enter its own ordinal is an infinite regress rather than a test.
            pending.delete(ordinal)
            fired++
            await fn()
          }
          return result
        }
      },
    })
  }
  Object.defineProperty(patched, PATCHED, { value: true })

  fsp.open = patched
  syncBuiltinESMExports()

  return {
    arm: () => {
      armedAt = reads
      openArmedAt = opens
      handleStats = 0
      fired = 0
      pending = new Map()
      openPending = new Map()
      shorts = new Map()
    },
    at: (n, fn) => {
      pending.set(n, fn)
    },
    atOpen: (n, fn) => {
      openPending.set(n, fn)
    },
    short: (n, bytesRead) => {
      shorts.set(n, bytesRead)
    },
    get fired() {
      return fired
    },
    get handleStats() {
      return handleStats
    },
    get sinceArm() {
      return reads - armedAt
    },
    restore: () => {
      pending = new Map()
      openPending = new Map()
      shorts = new Map()
      if (fsp.open === patched) {
        fsp.open = realOpen
        syncBuiltinESMExports()
      }
    },
  }
}
