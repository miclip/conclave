/**
 * #168: the rewrite path consumes a half-written record and loses it forever.
 *
 * `RewriteAwareTail.poll()` trims to the last complete line on the APPEND path, and says why:
 * "a partially-written record must not be parsed, and must not poison the prefix digest." The
 * REWRITE path takes the whole buffer as-is. That is the wrong way round -- a rewrite IS a
 * writer writing, which is precisely when a poll is most likely to catch a record half done.
 *
 * The damage is not that the partial record is dropped from the OUTPUT. `parseJsonLine` drops
 * the fragment, and dropping an unparseable fragment is correct. The damage is that it is
 * consumed from the INPUT at the same time: `#offset` advances past the partial bytes and
 * `#prefixDigest` is taken over them. When the writer finishes the record, those same leading
 * bytes are still a valid prefix, so the next poll sees no rewrite and consumes only the tail
 * fragment -- which does not parse either. No poll ever delivers the record. A transient
 * becomes permanent.
 *
 * Records are fixed-width for the same reason as in `rewriteMidPoll.test.ts`: the bug is about
 * byte ranges, so the test controls them exactly rather than hoping.
 *
 *   {"r":"a"}\n   10 bytes    the file starts as a,b                      -> 20 bytes
 *   {"r":"x"}\n   10 bytes    rewritten to complete x plus partial y      -> 18 bytes
 *   {"r":"y"      8 bytes     ...the missing `}\n` arrives next           -> 20 bytes
 *
 * Assertions are on the poll RECORD and on `consumedBytes`, not on anything rendered from
 * them, and the two tests below split the claim deliberately:
 *
 *   the settled projection   what a consumer ends up holding. This is the CONSEQUENCE, and it
 *                            has to be reached by running the whole sequence -- a test that
 *                            stopped at the offending poll would prove a number was wrong
 *                            without proving anything was lost.
 *   `consumedBytes`          the MECHANISM, pinned separately so a fix cannot satisfy the
 *                            first by some other route while leaving the offset banked over
 *                            bytes that were never delivered.
 *
 * The last section covers the case #168 flagged as needing a decision rather than an assumption:
 * a rewritten file with NO complete line at all. The answer taken here is to report the rewrite
 * and consume nothing -- offset 0, the empty digest, `all: []`. Reporting it is not optional,
 * because what the consumer holds is void whether or not there is anything to replace it with;
 * consuming nothing follows from there being no coherent prefix to bank. The record in flight is
 * not skipped by this, and the test says so: with the offset at zero the next poll reads it as
 * an ordinary append, whole.
 *
 *   node --test src/transcript/partialRewrite.test.ts
 */

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tempDirAsync } from '../testkit/tempDir.ts'
import { RewriteAwareTail, parseJsonLine } from './tail.ts'

/** Nine bytes plus a newline, so every record occupies exactly ten. */
const rec = (r: string) => `{"r":"${r}"}\n`
const REC = 10

/** `{"r":"y"` -- the record as far as the writer has got. */
const PARTIAL = rec('y').slice(0, -2)
const PARTIAL_BYTES = 8

const BEFORE = rec('a') + rec('b')
const MID = rec('x') + PARTIAL
const AFTER = rec('x') + rec('y')

const ids = (records: Array<Record<string, any>>) => records.map((v) => v.r)

interface Poll {
  appended: Array<Record<string, any>>
  rewritten: boolean
  all?: Array<Record<string, any>>
}

/** `rewritten` voids what came before -- that is the contract, so replacing on it is the point. */
const applyPoll = (projection: string[], poll: Poll): string[] =>
  poll.rewritten ? ids(poll.all ?? []) : [...projection, ...ids(poll.appended)]

async function scratch(t: TestContext): Promise<string> {
  const dir = await tempDirAsync(t, 'conclave-168')
  return join(dir, 'transcript.jsonl')
}

/**
 * The three polls of #168, run to completion, with every poll record returned.
 *
 * No wedge and no seam: unlike #167 this bug needs no race at all. Each rewrite happens between
 * polls, in the plainest possible way, and the loss still happens -- which is the point. The
 * only thing being simulated is a writer that has not finished its last line, and files are
 * regularly observed in that state without anyone racing anything.
 */
async function threePolls(path: string) {
  await writeFile(path, BEFORE)
  const tail = new RewriteAwareTail(path, parseJsonLine)
  let projection: string[] = []

  const p1: Poll = await tail.poll()
  projection = applyPoll(projection, p1)
  assert.equal(p1.rewritten, false)
  assert.deepEqual(ids(p1.appended), ['a', 'b'], 'first poll reads the file as it stands')
  assert.equal(tail.consumedBytes, 2 * REC, 'both complete records consumed')

  // The rewrite, caught mid-write: x is complete, y is not.
  await writeFile(path, MID)
  assert.equal(MID.length, REC + PARTIAL_BYTES)

  const p2: Poll = await tail.poll()
  const consumedAfterRewrite = tail.consumedBytes
  projection = applyPoll(projection, p2)

  // Both of these already hold. They are here to fix which poll is the rewrite, so that a
  // failure below is unambiguously about what that poll CONSUMED rather than about the
  // sequence having drifted.
  assert.equal(p2.rewritten, true, 'a shorter file with different content is a rewrite')
  assert.deepEqual(ids(p2.all ?? []), ['x'], 'only the complete record is parseable')
  assert.deepEqual(ids(p2.appended), [], 'a rewrite appends nothing')

  // The writer finishes the record it was in the middle of. Nothing else changes.
  await writeFile(path, AFTER)

  const p3: Poll = await tail.poll()
  projection = applyPoll(projection, p3)

  return { p1, p2, p3, projection, tail, consumedAfterRewrite }
}

/**
 * The delivery, poll by poll, which is the half `settled` cannot see.
 *
 * A projection that ends up right can be reached wrongly -- `y` arriving twice and a consumer
 * that happens to dedupe, or arriving as a second `rewritten` that silently voids and rebuilds
 * everything. Neither is an append, and the caller is entitled to know the difference: `all`
 * means throw away what you had. So the poll RECORDS are pinned, not just their sum.
 */
test('the completed record arrives as a plain append, exactly once', async (t) => {
  const path = await scratch(t)
  const { p3, tail } = await threePolls(path)

  assert.equal(p3.rewritten, false, 'finishing a record is not a rewrite of the file')
  assert.equal(p3.all, undefined, 'and must not void what the consumer just rebuilt')
  assert.deepEqual(ids(p3.appended), ['y'], 'y, once')
  assert.equal(tail.consumedBytes, AFTER.length, 'and the file is now fully consumed')

  // The fourth poll: nothing has touched the file, so it must find nothing. A tail that
  // re-delivered here would be handing `y` to the consumer twice.
  const p4: Poll = await tail.poll()
  assert.equal(p4.rewritten, false)
  assert.deepEqual(ids(p4.appended), [], 'an unchanged file yields nothing')
  assert.equal(p4.all, undefined)
  assert.equal(tail.consumedBytes, AFTER.length, 'and the offset stands still')
})

/**
 * The consequence. `y` is a complete, well-formed record sitting in a file the tail is still
 * tailing, and no poll from here on will ever hand it to anyone.
 *
 * The fourth poll is not padding: it is the tail's last chance. Nothing touches the file after
 * `AFTER` is written, so if the projection has not caught up by then it never will -- which is
 * exactly the difference between a poll that lagged by one and a poll that banked a digest it
 * can never fail.
 */
test('a record still being written when the file is rewritten is delivered once it is complete', async (t) => {
  const path = await scratch(t)
  const { p2, p3, projection, tail, consumedAfterRewrite } = await threePolls(path)

  const settled = applyPoll(projection, await tail.poll())

  assert.deepEqual(
    settled,
    ['x', 'y'],
    `the projection must settle on what the file actually holds. ` +
      `The rewrite poll reported all=${JSON.stringify(ids(p2.all ?? []))} and consumed ` +
      `${consumedAfterRewrite} of ${MID.length} bytes -- ${consumedAfterRewrite - REC} of them ` +
      `a record that was still being written -- so the poll after it saw an intact prefix ` +
      `(rewritten=${p3.rewritten}) and read only the fragment left over ` +
      `(appended=${JSON.stringify(ids(p3.appended))}), which does not parse. ` +
      `y is in the file and no poll will ever deliver it.`,
  )
  assert.equal(tail.consumedBytes, AFTER.length, 'and the whole file is accounted for')
})

/**
 * The mechanism, pinned on its own so that a fix has to move the offset rather than merely
 * arrange for the record to arrive some other way.
 *
 * Ten, not eighteen: the rewritten file contains exactly one complete line, and consuming a
 * byte more than that is consuming something no poll reported. The digest is not asserted
 * directly -- it has no accessor and does not need one. It shows itself in the poll that
 * follows: a digest taken over bytes the offset does not cover would make the next prefix check
 * compare the wrong range, and the first test is what fails when it does.
 */
test('a rewrite banks only the bytes it actually consumed', async (t) => {
  const path = await scratch(t)
  const { consumedAfterRewrite } = await threePolls(path)

  assert.equal(
    consumedAfterRewrite,
    REC,
    `the rewritten file was ${MID.length} bytes: one complete record and ${PARTIAL_BYTES} bytes ` +
      `of a record still being written. Only the complete record was delivered, so only the ` +
      `complete record may be consumed.`,
  )
})

/**
 * The case #168 flagged as a decision rather than an assumption: the rewrite is caught so early
 * that the file has no complete line in it at all.
 *
 * There is nothing to trim TO here, and the two obligations pull apart. Consuming nothing is
 * forced -- an offset can only be banked over a prefix that means something, and eight bytes of
 * a record in flight mean nothing. Reporting the rewrite is the part that looks awkward, because
 * it hands the consumer `rewritten: true` with an empty `all`, which reads like a poll that
 * found nothing. It is not: the consumer's `a, b` are gone from the file, and a poll that stayed
 * quiet to avoid the awkward shape would leave it holding two records the transcript no longer
 * contains -- the precise failure this whole class exists to prevent.
 *
 * So `all: []` is an answer, and a true one. The file contains no complete record. That is a
 * state a transcript is genuinely in for as long as it takes a writer to finish a line, and the
 * cost of saying so is one rebuild of something that had to be rebuilt anyway.
 */
const NAKED = '{"r":"z"' // 8 bytes, no newline: the whole file is one unfinished record
const WHOLE = rec('z')

test('a rewrite with no complete line consumes nothing and reports the rewrite', async (t) => {
  const path = await scratch(t)
  await writeFile(path, BEFORE)
  const tail = new RewriteAwareTail(path, parseJsonLine)

  const p1: Poll = await tail.poll()
  assert.deepEqual(ids(p1.appended), ['a', 'b'])
  assert.equal(tail.consumedBytes, 2 * REC)

  await writeFile(path, NAKED)
  const p2: Poll = await tail.poll()

  assert.equal(p2.rewritten, true, 'the consumer still holds a,b, and they are gone from the file')
  assert.deepEqual(ids(p2.all ?? []), [], 'nothing in the file is a complete record yet')
  assert.deepEqual(ids(p2.appended), [], 'a rewrite appends nothing')
  assert.equal(tail.consumedBytes, 0, 'there is no coherent prefix to bank, so bank none')

  const projection = applyPoll(applyPoll([], p1), p2)
  assert.deepEqual(projection, [], 'the consumer is left holding nothing, which is what the file holds')
})

/**
 * The other half of the same decision, and the one that makes it safe: banking nothing must cost
 * nothing. `z` is mid-flight when the rewrite is seen, so it must arrive whole afterwards --
 * as an APPEND, because with the offset at zero the poll that follows is reading a file whose
 * prefix it has consumed none of, which is exactly an empty tail reading a new file.
 *
 * Getting an append rather than a second `rewritten` here matters beyond tidiness. The digest
 * banked over zero bytes is the empty digest, so a rewrite reported now would mean the tail had
 * decided its own untouched offset no longer matched -- which would be incoherent, and would
 * void a projection that has nothing in it to void.
 */
test('a record that was alone and unfinished is delivered whole by the next poll', async (t) => {
  const path = await scratch(t)
  await writeFile(path, BEFORE)
  const tail = new RewriteAwareTail(path, parseJsonLine)
  await tail.poll()

  await writeFile(path, NAKED)
  const p2: Poll = await tail.poll()
  assert.equal(p2.rewritten, true)

  // The writer finishes the line. Nothing else changes.
  await writeFile(path, WHOLE)

  const p3: Poll = await tail.poll()
  assert.equal(p3.rewritten, false, 'an offset of zero has nothing to fail a prefix check against')
  assert.deepEqual(ids(p3.appended), ['z'], 'the record is not skipped by having been passed over')
  assert.equal(tail.consumedBytes, WHOLE.length)

  const p4: Poll = await tail.poll()
  assert.deepEqual(ids(p4.appended), [], 'and it is delivered once')
  assert.equal(tail.consumedBytes, WHOLE.length)
})

/**
 * The LAST complete line, not the first.
 *
 * Every other case in this file rewrites to a file holding exactly one complete record, which
 * makes "scan forward to a newline" and "scan back to the last newline" the same instruction.
 * They are not the same instruction, and the difference is a whole record rather than a byte:
 * stopping at the first newline reports one record out of however many the rewritten file
 * actually contains, banks an offset short by the rest, and leaves the consumer with a
 * projection that matches no state the file was ever in.
 *
 * Found by mutating `lastIndexOf` to `indexOf` and watching every test above stay green.
 */
const MULTI = rec('p') + rec('q') + PARTIAL // two complete records and a third in flight
const MULTI_DONE = rec('p') + rec('q') + rec('y')

test('a rewrite with several complete records keeps all of them, and stops at the last', async (t) => {
  const path = await scratch(t)
  await writeFile(path, BEFORE)
  const tail = new RewriteAwareTail(path, parseJsonLine)
  await tail.poll()
  assert.equal(tail.consumedBytes, 2 * REC)

  await writeFile(path, MULTI)
  assert.equal(MULTI.length, 2 * REC + PARTIAL_BYTES)

  const p2: Poll = await tail.poll()
  assert.equal(p2.rewritten, true)
  assert.deepEqual(ids(p2.all ?? []), ['p', 'q'], 'both complete records, not just the first')
  assert.equal(tail.consumedBytes, 2 * REC, 'through the LAST newline, and no further')

  // And the record that was in flight still arrives, as an append, on top of the other two.
  await writeFile(path, MULTI_DONE)
  const p3: Poll = await tail.poll()
  assert.equal(p3.rewritten, false)
  assert.deepEqual(ids(p3.appended), ['y'])
  assert.equal(tail.consumedBytes, MULTI_DONE.length)

  const projection = applyPoll(applyPoll([], p2), p3)
  assert.deepEqual(projection, ['p', 'q', 'y'])
})
