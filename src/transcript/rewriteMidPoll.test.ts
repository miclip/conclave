/**
 * #167: a poll verifies its prefix against one reading of the file and takes its suffix from
 * another, so a rewrite that lands in between is not reported as a rewrite at all.
 *
 * The prefix digest is not an optimisation, it is the mechanism -- `tail.ts`'s own header says
 * so. Everything the view holds stays live exactly as long as the bytes it was derived from are
 * still the file's prefix, and `poll()` is the only thing that ever checks. So a check that
 * passes against a state the file has already left does not merely return stale data; it
 * certifies, to every consumer downstream, that history was NOT rewritten at the one moment it
 * was. The poll reports an APPEND, the consumer keeps what it had, and the projection it ends up
 * with is half one file and half another -- a state the transcript never contained.
 *
 * These tests put a real rewrite in that gap. `fsWedge.ts` explains how the gap is reached --
 * `fs/promises.open` is patched and republished with `syncBuiltinESMExports()` -- and why the
 * trigger is a completed READ rather than an open: so that this file keeps performing its
 * mutation under a poll restructured to read once, instead of silently performing none.
 *
 * Records are fixed-width on purpose. The bug is about byte ranges surviving into a file that no
 * longer means the same thing by them, so the test has to control those ranges exactly rather
 * than hope.
 *
 * Assertions are on the poll RECORD, not on anything rendered from it. Build the projection a
 * consumer would build -- replace on `rewritten`, append otherwise -- and hold it to two things:
 *
 *   after the rewritten poll   it must match SOME single state the file was in. Two answers are
 *                              coherent and either is accepted, because they belong to two
 *                              defensible fixes: [x,y,z] detected the rewrite and voided what
 *                              came before, [a,b,c] read the pre-rewrite file consistently and
 *                              leaves the catching up to the next poll.
 *   once it settles            it must match what the file ACTUALLY contains. This is the half
 *                              that says the damage is permanent rather than transient: it is
 *                              what distinguishes a poll that lagged by one from a poll that
 *                              banked a digest of the rewritten file and can therefore never
 *                              notice.
 *
 * `[a,b,z]` satisfies neither. That is the failure.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wedgeTailReads } from './fsWedge.ts'
import { RewriteAwareTail, parseJsonLine, type ReadLease } from './tail.ts'

// No ordering constraint: the patch reaches `tail.ts` through the live binding whether it was
// imported before this line or after it.
const wedge = wedgeTailReads()

after(() => wedge.restore())

/** Nine bytes plus a newline, so every record occupies exactly ten. */
const rec = (r: string) => `{"r":"${r}"}\n`
const REC = 10

const BEFORE = ['a', 'b', 'c']
const AFTER = ['x', 'y', 'z']

const ids = (records: Array<Record<string, any>>) => records.map((v) => v.r)

interface Poll {
  appended: Array<Record<string, any>>
  rewritten: boolean
  all?: Array<Record<string, any>>
}

/**
 * One poll's worth of the consumer's model. `rewritten` voids what came before -- that is the
 * whole contract -- so replacing on it is not a shortcut, it is the behaviour under test.
 */
const applyPoll = (projection: string[], poll: Poll): string[] =>
  poll.rewritten ? ids(poll.all ?? []) : [...projection, ...ids(poll.appended)]

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'conclave-167-'))
  after(() => rm(dir, { recursive: true, force: true }))
  return join(dir, 'transcript.jsonl')
}

/**
 * Drive a tail into a poll and rewrite the file the moment that poll's first read comes back.
 *
 * `replace` is how the rewrite lands; compaction does it both ways and the two are not the same
 * race. Rewriting in place keeps the inode, so even a poll holding one handle open across itself
 * would go on to see the new bytes; renaming a fresh file over the path swaps the inode, so a
 * held handle would keep reading the old one. Only the second is addressed by holding a handle,
 * which is why both are here.
 */
async function pollAcrossRewrite(path: string, replace: (path: string, bytes: string) => Promise<void>) {
  const before = BEFORE.slice(0, 2).map(rec).join('')
  await writeFile(path, before)

  const tail = new RewriteAwareTail(path, parseJsonLine)
  let projection: string[] = []

  const p1 = await tail.poll()
  projection = applyPoll(projection, p1)
  assert.deepEqual(projection, ['a', 'b'], 'first poll should read the file as it stands')
  assert.equal(tail.consumedBytes, 2 * REC)

  // An ordinary append. Nothing about it is unusual; it is only what the poll is reaching for
  // when the rewrite arrives.
  await writeFile(path, before + rec('c'))

  const after_ = AFTER.map(rec).join('')
  assert.equal(after_.length, BEFORE.length * REC, 'the rewrite must occupy the same range')

  wedge.arm()
  // The first read of the poll is the one that establishes what the poll believes about the
  // file. Everything the poll does afterwards is entitled to assume that belief still holds.
  wedge.at(1, () => replace(path, after_))

  const p2: Poll = await tail.poll()
  projection = applyPoll(projection, p2)

  return { p2, projection, tail }
}

const inPlace = async (path: string, bytes: string) => writeFile(path, bytes)

const byRename = async (path: string, bytes: string) => {
  const tmp = `${path}.compacted`
  await writeFile(tmp, bytes)
  await rename(tmp, path)
}

const modes = [
  ['rewritten in place', inPlace],
  ['replaced by rename', byRename],
] as const

for (const [how, replace] of modes) {
  test(`a transcript ${how} mid-poll is not reported as a plain append`, async () => {
    const path = await scratch()
    const { p2, projection, tail } = await pollAcrossRewrite(path, replace)

    assert.equal(wedge.fired, 1, 'the rewrite must actually have been performed inside the poll')

    const coherent = [AFTER, BEFORE].map((s) => JSON.stringify(s))
    assert.ok(
      coherent.includes(JSON.stringify(projection)),
      `projection ${JSON.stringify(projection)} belongs to no single state of the file: ` +
        `it was ${JSON.stringify(BEFORE)} before the rewrite and ${JSON.stringify(AFTER)} after. ` +
        `poll reported rewritten=${p2.rewritten}, appended=${JSON.stringify(ids(p2.appended))}.`,
    )

    // Nothing changes the file from here, so the next poll is the tail's last chance to notice.
    // A poll that banked a digest taken FROM the rewritten file has nothing left to compare
    // against and reports no change, which is what makes the mixture permanent.
    const p3: Poll = await tail.poll()
    const settled = applyPoll(projection, p3)
    assert.deepEqual(settled, AFTER, 'the projection must settle on what the file actually holds')
    assert.equal(tail.consumedBytes, BEFORE.length * REC)
  })
}

/**
 * The control, and it is not a formality. Everything above rests on the claim that the ONLY
 * difference between a healthy poll and the broken one is what happens in the gap -- so the seam
 * has to be shown to change nothing when it does nothing. A redirected `open` and a proxied
 * `read` that perturbed the poll on their own would produce the same red as the bug does.
 */
test('with nothing done mid-poll, the same poll reads the append correctly', async () => {
  const path = await scratch()
  const { p2, projection } = await pollAcrossRewrite(path, async () => {})

  assert.equal(wedge.fired, 1, 'the seam still reached its trigger point')
  assert.equal(p2.rewritten, false)
  assert.deepEqual(ids(p2.appended), ['c'])
  assert.deepEqual(projection, BEFORE)
})

/**
 * The other thing that can happen in the same gap: not the FILE changing under the read, but the
 * read's authorisation expiring while it is in flight.
 *
 * These are the same window and opposite obligations. A rewrite mid-poll means the poll must not
 * report an append; a lease expiring mid-poll means the poll must not report ANYTHING -- and,
 * more particularly, must not leave `#offset` or `#prefixDigest` moved, because the read that
 * replaces it starts from those and a half-committed abandonment either hands its records to
 * nobody or hands the same range to two readers.
 *
 * Worth pinning here rather than trusting to `readLease.test.ts`, because the single-buffer poll
 * MOVED this check. It used to sit between the `stat` and the reads; it now sits after the open,
 * the fstat, the read and the close. The behaviour is supposed to be identical and only the cost
 * different, which is exactly the kind of claim that wants a test rather than a comment.
 *
 * Neither commit is asserted by reaching into the tail. `consumedBytes` shows the offset
 * directly, and the digest shows itself in the NEXT poll: had the abandoned read banked a digest
 * over all thirty bytes while leaving the offset at twenty, the following poll would compare a
 * twenty-byte prefix against it, fail, and report a rewrite. Getting a plain append of `c` back
 * is the proof that neither half moved.
 */
test('a lease abandoned after the read commits nothing, and the next poll still gets the append', async () => {
  const path = await scratch()
  await writeFile(path, rec('a') + rec('b'))

  const tail = new RewriteAwareTail(path, parseJsonLine)
  assert.deepEqual(ids((await tail.poll()).appended), ['a', 'b'])
  assert.equal(tail.consumedBytes, 2 * REC)

  await writeFile(path, rec('a') + rec('b') + rec('c'))

  // Live when the poll starts, expired the instant its read comes back -- a deadline passing
  // while the filesystem was busy, which is the only way this is ever reached in production.
  let expired = false
  const lease: ReadLease = {
    get abandoned() {
      return expired
    },
  }

  wedge.arm()
  wedge.at(1, () => {
    expired = true
  })

  const abandonedPoll = await tail.poll(lease)
  assert.equal(wedge.fired, 1, 'the lease must actually have expired inside the poll')

  assert.equal(abandonedPoll.abandoned, true, 'the poll must say it is a non-answer')
  assert.deepEqual(abandonedPoll.appended, [], 'a non-answer carries no records')
  assert.equal(abandonedPoll.rewritten, false)
  assert.equal(abandonedPoll.all, undefined)
  assert.equal(tail.consumedBytes, 2 * REC, 'the offset must not have moved')

  // The replacement read, with nobody having given up on it.
  const live = await tail.poll()
  assert.equal(live.abandoned, undefined)
  assert.equal(live.rewritten, false, 'a digest left alone still matches; a clobbered one would not')
  assert.deepEqual(ids(live.appended), ['c'], 'the append the abandoned read declined to commit')
  assert.equal(tail.consumedBytes, 3 * REC)
})

/**
 * The check before the commit, on its own.
 *
 * The test above proves a poll does not commit under an expired lease, but not WHICH check stops
 * it: mutation says either one alone is enough when the lease expires before both, and only
 * removing both turns it red. That leaves the interesting claim untested -- that the second check
 * is not redundant now that no I/O separates it from the first.
 *
 * It is not redundant because `abandoned` is a live reading against a DEADLINE:
 * `boundedReconcile` answers it with `released || Date.now() >= deadlineAt`, so it can turn over
 * between two consecutive synchronous reads of it. Reproducing that with a clock would be a race;
 * reproducing it by counting reads of the getter is the same shape and deterministic. This lease
 * is live the first time it is consulted and expired the second, which is exactly a deadline
 * passing in between.
 */
test('a lease that expires between the two checks is caught by the one before the commit', async () => {
  const path = await scratch()
  await writeFile(path, rec('a') + rec('b'))

  const tail = new RewriteAwareTail(path, parseJsonLine)
  await tail.poll()
  await writeFile(path, rec('a') + rec('b') + rec('c'))

  let consulted = 0
  const lease: ReadLease = {
    get abandoned() {
      return ++consulted >= 2
    },
  }

  const poll = await tail.poll(lease)
  assert.equal(consulted, 2, 'the poll must consult the lease again before committing')
  assert.equal(poll.abandoned, true, 'an expiry after the first check must still stop the commit')
  assert.deepEqual(poll.appended, [])
  assert.equal(tail.consumedBytes, 2 * REC, 'the offset must not have moved')

  const live = await tail.poll()
  assert.equal(live.rewritten, false, 'a digest left alone still matches; a clobbered one would not')
  assert.deepEqual(ids(live.appended), ['c'])
  assert.equal(tail.consumedBytes, 3 * REC)
})

/**
 * A read that came back short is a failed read, and the poll must reject rather than believe it.
 *
 * The tempting reading is that a short read means a shorter file, and that believing it is the
 * conservative direction: worst case a spurious rewrite, which costs a re-read. That is wrong,
 * and wrong in the expensive direction. A fragment whose prefix no longer matches goes to the
 * REWRITE branch, and that branch does not trim to the last complete line (#168) -- so it would
 * set `#offset` past half a record and bank a digest over it, and the record is then never
 * delivered by any poll. A short read would MANUFACTURE silent record loss out of a file that
 * was never malformed. Rejecting costs one retry; believing costs a record, permanently.
 *
 * Measured, not argued. Against a variant that believes the short read, this exact case gives:
 *
 *   poll 2   rewritten=true, all=["a"], consumedBytes=18   -- `b` dropped, offset past its half
 *   poll 3   rewritten=false, appended=["c"]               -- prefix still matches, so no alarm
 *
 * `b` is on disk, whole and well-formed, from the first byte to the last. No poll ever hands it
 * to anyone.
 *
 * Nothing about the file here is wrong -- thirty well-formed bytes, three complete records. Only
 * the read is short, which is why the wedge has to falsify the COUNT rather than the file: a real
 * short read hands back a full buffer and tells you how far to trust it.
 */
test('a short read is rejected, commits nothing, and the next poll recovers the append', async () => {
  const path = await scratch()
  await writeFile(path, rec('a') + rec('b'))

  const tail = new RewriteAwareTail(path, parseJsonLine)
  await tail.poll()
  assert.equal(tail.consumedBytes, 2 * REC)

  await writeFile(path, rec('a') + rec('b') + rec('c'))

  wedge.arm()
  // 18 of 30: below the consumed offset, so the fragment would fail the prefix check and take
  // the untrimmed rewrite path -- and 18 lands mid-record, which is what makes that path lose one.
  wedge.short(1, 18)

  await assert.rejects(
    () => tail.poll(),
    (e: unknown) => e instanceof Error && /short read.*18 of 30/.test(e.message),
    'the poll must reject rather than treat a fragment as the file',
  )

  assert.equal(tail.consumedBytes, 2 * REC, 'a rejected read must not have moved the offset')

  // The read is not retried inside the poll -- that would be the second window the single read
  // exists to close -- so recovery is simply the next poll, from an offset that never moved.
  const live = await tail.poll()
  assert.equal(live.rewritten, false, 'a digest left alone still matches; a clobbered one would not')
  assert.deepEqual(ids(live.appended), ['c'], 'the append the failed read declined to commit')
  assert.equal(tail.consumedBytes, 3 * REC)
})

/**
 * Where the size comes from: the HANDLE, not the path.
 *
 * `fh.stat()` and `stat(this.path)` are indistinguishable almost everywhere, which is what makes
 * this worth a test rather than a sentence in a header. They differ in exactly one interval --
 * between the `open` and the sizing call -- because that is the only moment at which the path and
 * the descriptor can come to disagree about which file they mean. A rename lands there: the
 * handle keeps the inode it opened, the path now names a different one.
 *
 * So the trigger is on the OPEN, not on the read and not on the stat. Firing between the sizing
 * call and the read would prove nothing: a path-`stat` has resolved by then, while the path still
 * pointed at the handle's inode, so both spellings compute the same size from the same file. It
 * was checked, and the mutation is inert there.
 *
 * The replacement is deliberately a DIFFERENT length from the original -- four records against
 * three -- because equal lengths hide the bug. Sizing from the path yields 40 for a descriptor
 * holding 30 bytes, so the read comes up short and #167's own short-read guard turns it into a
 * rejection. Sizing from the handle yields 30, the read is whole, and the poll answers coherently
 * from the file it actually holds.
 *
 * Two assertions pin it, one structural and one behavioural, because either alone is weaker than
 * it looks. `handleStats` says the poll asked the HANDLE for the size -- a poll that asked the
 * path would still be sizing something, and nothing else downstream would notice. The projection
 * says the answer was right.
 */
test('the size comes from the handle: a rename between open and sizing still reads coherently', async () => {
  const path = await scratch()
  const before = BEFORE.slice(0, 2).map(rec).join('')
  await writeFile(path, before)

  const tail = new RewriteAwareTail(path, parseJsonLine)
  assert.deepEqual(ids((await tail.poll()).appended), ['a', 'b'])

  await writeFile(path, before + rec('c'))

  // Four records where the original had three, so the two spellings of "how big is it" disagree.
  const replacement = ['x', 'y', 'z', 'w']
  const after_ = replacement.map(rec).join('')
  assert.notEqual(after_.length, BEFORE.length * REC, 'the lengths must differ or nothing is pinned')

  wedge.arm()
  wedge.atOpen(1, () => byRename(path, after_))

  const p2: Poll = await tail.poll()
  assert.equal(wedge.fired, 1, 'the rename must have landed between the open and the sizing')
  assert.equal(wedge.handleStats, 1, 'the poll must have taken its size from the handle, not the path')

  assert.equal(p2.rewritten, false, 'the handle still holds the pre-rename inode')
  assert.deepEqual(ids(p2.appended), ['c'], 'a coherent read of the file the handle actually holds')
  assert.equal(tail.consumedBytes, BEFORE.length * REC)

  // The path is re-resolved next poll, which is where the replacement is supposed to surface.
  const p3: Poll = await tail.poll()
  assert.equal(p3.rewritten, true, 'the next poll opens the path afresh and sees the replacement')
  assert.deepEqual(ids(p3.all ?? []), replacement)
  assert.equal(tail.consumedBytes, replacement.length * REC)
})
