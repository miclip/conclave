/**
 * Rotation as a transaction.
 *
 * The property under test throughout is: after this returns, exactly one implementer
 * session is alive, and it is the right one. Everything else — the handoff sections, the
 * check comparison — exists to decide which.
 *
 *   node --test src/rotation/rotate.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RelayMessage } from '../relay/message.ts'
import { fakeExchange, FakeRotationSession } from './fakeSession.ts'
import { UNKNOWN_GENERATION } from './handoff.ts'
import { rotate, type RotationDeps } from './rotate.ts'
import { checkCommand, checkRelevance } from './record.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-rotate-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 42\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

const HANDOFF = `## BRIEF
Finish the rotation transaction.

## STATE
Record and handoff are written; the transaction is not.

## DECISIONS
- none

## EVIDENCE
The implementer reports the suite green. I have not run it myself.

## FILES
- work.ts

## DISAGREEMENT
- Whether a flaky check should block

## NEXT
Write the rollback path.`

/** A replacement that runs the checks and reports honestly. */
const HONEST = 'CHECK 1: exit 0\n\nRead work.ts, ran the check, everything matches the handoff.'

function deps(root: string, replacement: FakeRotationSession, over: Partial<RotationDeps> = {}): RotationDeps {
  return {
    root,
    exchange: fakeExchange,
    startReplacement: async () => replacement,
    checks: ['exit 0'],
    checkTimeoutMs: 30_000,
    ...over,
  }
}

test('a successful rotation terminates the old session and keeps the new one', async () => {
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  const advisor = new FakeRotationSession('advisor', 'codex', [HANDOFF])
  const fresh = new FakeRotationSession('fresh', 'claude', [HONEST])

  const r = await rotate({ old, advisor, reason: 'context exhausted', deps: deps(dir, fresh) })

  assert.equal(r.status, 'rotated')
  assert.equal(old.state, 'terminated')
  assert.equal(old.closedAs, 'graceful')
  assert.equal(fresh.state, 'running')
  // The transaction is a state machine, and the path through it is part of the contract:
  // a session may not be terminated without having been frozen first.
  assert.deepEqual(old.transitions, ['quiesced', 'rotating', 'terminated'])
})

test('the handoff carries the advisor’s narrative and the orchestrator’s record', async () => {
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  old.compactionGeneration = 2
  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, new FakeRotationSession('fresh', 'claude', [HONEST])),
  })

  assert.equal(r.status, 'rotated')
  if (r.status !== 'rotated') return
  assert.equal(r.handoff.narrative.nextAction, 'Write the rollback path.')
  assert.deepEqual(r.handoff.narrative.openDisagreement, ['Whether a flaky check should block'])
  // The record is the orchestrator's, not the advisor's: the advisor cannot see files.
  assert.equal(r.handoff.record.files[0]!.path, 'work.ts')
  assert.ok(r.handoff.record.files[0]!.digest)
  assert.equal(r.handoff.record.head?.length, 40)
  assert.equal(r.handoff.compactionGeneration, 2, 'the degradation signal travels with the handoff')
})

test('a snapshot that could not be re-read records the generation as unknown, and still rotates', async () => {
  /**
   * The handoff is the one document nobody re-derives.
   *
   * `snapshot()` on both adapters is contained: a transcript that will not answer hands back the last
   * projection the view built rather than rejecting, which is what stops a wedged transcript
   * from stranding a session that has already been quiesced. Rotation snapshots the original
   * right there, at quiesce, on the path most likely to meet that fallback.
   *
   * The turns in a fallback are as true as they were at the last read. `compactionGeneration`
   * is a different kind of claim -- it is the mechanical evidence that the participant lost
   * context, the reason the rotation is defensible at all -- and taking it from a read that
   * could not be repeated records a transcript state nobody observed as though it had been
   * checked. It is also stale in the one direction that matters: a compaction that happened
   * while the reader was wedged is exactly what is missing from it.
   *
   * Recording that it is unknown does NOT abort. The decision to rotate was made before this
   * point and on other grounds, and refusing here would leave a frozen session that only this
   * function knows is frozen.
   */
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  old.compactionGeneration = 2
  old.containedFallback = true
  const notes: string[] = []

  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, new FakeRotationSession('fresh', 'claude', [HONEST]), { note: (m) => notes.push(m) }),
  })

  assert.equal(r.status, 'rotated', 'an unverifiable signal is not a reason to strand a quiesced session')
  if (r.status !== 'rotated') return
  assert.equal(
    r.handoff.compactionGeneration,
    UNKNOWN_GENERATION,
    'the stale 2 is not recorded as the degradation signal of the session being replaced',
  )
  assert.notEqual(r.handoff.compactionGeneration, 2)
  assert.ok(
    notes.some((n) => n.includes('unverified')),
    `and the operator is told why, rather than finding "unknown" in a document: ${JSON.stringify(notes)}`,
  )
  // Everything else in the handoff is unaffected: the narrative and the record do not come
  // from the snapshot, and the turns in a fallback are still what the last real read saw.
  assert.equal(r.handoff.narrative.nextAction, 'Write the rollback path.')
  assert.equal(r.handoff.record.files[0]!.path, 'work.ts')
})

test('an unparseable handoff rolls back before any replacement is started', async () => {
  // The parse happens before the start precisely so this case costs nothing: no session
  // has been created and none has been destroyed.
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', [HONEST])
  let started = false

  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', ['I think we should start fresh, roughly where we left off.']),
    reason: 'context exhausted',
    deps: deps(dir, fresh, {
      startReplacement: async () => {
        started = true
        return fresh
      },
    }),
  })

  assert.equal(r.status, 'rolled_back')
  if (r.status !== 'rolled_back') return
  assert.equal(r.reason, 'handoff_incomplete')
  assert.ok(r.detail.includes('BRIEF'))
  assert.equal(started, false, 'nothing should be started against a handoff that cannot be read')
  assert.equal(old.state, 'running', 'the original must be back in service')
  assert.deepEqual(old.transitions, ['quiesced', 'running'])
})

test('a replacement that cannot start leaves the original working', async () => {
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, new FakeRotationSession('fresh', 'claude'), {
      startReplacement: async () => {
        throw new Error('hook trust preflight failed')
      },
    }),
  })

  assert.equal(r.status, 'rolled_back')
  if (r.status !== 'rolled_back') return
  assert.equal(r.reason, 'replacement_start_failed')
  assert.ok(r.detail.includes('preflight'))
  assert.equal(old.state, 'running')
  // The handoff survives the failure: it was authored, and the next attempt need not
  // spend another advisor turn re-deriving it.
  assert.ok(r.handoff)
})

// --- the window between the freeze and the start ------------------------------------------

/**
 * From `quiesce()` to `startReplacement()` nothing was inside the rollback's care.
 *
 * A quiesced session is alive, holds everything it knew, and refuses work. That is what makes
 * rotation a transaction -- and it is also what makes an escaped throw in this window worse
 * than a failed rotation: the only code that knows the seat was frozen is `rotate()` itself, so
 * a throw past its own rollback leaves a session nobody will ever unfreeze. The relay's seat is
 * then permanently unable to accept a turn, and nothing in the run reports why.
 *
 * Three real things throw here. The advisor's exchange travels a transport that dies. The
 * snapshot reads the child's transcript, and a read the view has given up on rejects rather
 * than answering. `capture()` shells out to `git` and to the project's own checks.
 */

test('a snapshot that cannot be taken rolls back rather than leaving the original quiesced', async () => {
  // The transcript read the view abandoned, arriving at the one caller with the most to lose.
  // `rotate()` takes this snapshot AFTER the freeze, to carry the compaction generation into
  // the handoff, and before this it went straight out of the function.
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  old.snapshot = async () => {
    throw new Error('transcript read abandoned after 10000ms without answering')
  }
  let started = false

  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, new FakeRotationSession('fresh', 'claude', [HONEST]), {
      startReplacement: async () => {
        started = true
        return new FakeRotationSession('fresh', 'claude', [HONEST])
      },
    }),
  })

  assert.equal(r.status, 'rolled_back')
  if (r.status !== 'rolled_back') return
  assert.equal(r.reason, 'handoff_not_recorded')
  assert.ok(r.detail.includes('snapshot'), `the reason must name the stage that failed: ${r.detail}`)
  assert.equal(started, false, 'nothing is created against a handoff that was never recorded')
  assert.equal(old.state, 'running', 'the original is back in service, not stranded frozen')
  assert.deepEqual(old.transitions, ['quiesced', 'running'])
})

test('an advisor whose transport dies mid-handoff rolls back', async () => {
  // The widest part of the window: the first thing after the freeze, and a whole model turn
  // long. `handoff_incomplete` covers an advisor that ANSWERED badly; this is one that did not
  // answer at all, which is a different fault and used to be no result at all.
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')

  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, new FakeRotationSession('fresh', 'claude', [HONEST]), {
      exchange: async () => {
        throw new Error('transport lost')
      },
    }),
  })

  assert.equal(r.status, 'rolled_back')
  if (r.status !== 'rolled_back') return
  assert.equal(r.reason, 'handoff_not_recorded')
  assert.ok(r.detail.includes('transport lost'))
  assert.equal(old.state, 'running')
  assert.deepEqual(old.transitions, ['quiesced', 'running'])
})

test('the guarded window reaches all the way to the replacement’s start', async () => {
  // The far edge of it. `afterCapture` is the last thing that happens before
  // `startReplacement()`, and it is strictly after `capture()` inside the same block -- so a
  // throw here rolling back is also the answer for the capture, which shells out to `git` and
  // to the project's checks and can fail for reasons that have nothing to do with either
  // session. There is no cheap portable way to make `capture()` itself throw: it tolerates a
  // missing repository and a missing file by recording them as absent, which is deliberate.
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  let started = false

  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, new FakeRotationSession('fresh', 'claude', [HONEST]), {
      startReplacement: async () => {
        started = true
        return new FakeRotationSession('fresh', 'claude', [HONEST])
      },
      hooks: {
        afterCapture: async () => {
          throw new Error('the barrier gave way')
        },
      },
    }),
  })

  assert.equal(r.status, 'rolled_back')
  if (r.status !== 'rolled_back') return
  assert.equal(r.reason, 'handoff_not_recorded')
  assert.ok(r.detail.includes('the barrier gave way'))
  assert.equal(started, false)
  assert.equal(old.state, 'running')
  assert.deepEqual(old.transitions, ['quiesced', 'running'])
})

test('the guarded window reaches back to the line that merely SAYS the session was frozen', async () => {
  /**
   * The near edge of it, and the narrowest gap in the whole transaction: one statement.
   *
   * `note` is the caller's function. It writes to a REPL, a log, a stream something else may
   * have closed, and it was called immediately after `quiesce()` with nothing around it -- so a
   * throw from the NARRATION left the original frozen, alive, holding everything it knew, and
   * unable to accept work, with no caller anywhere holding the knowledge that it had to be
   * unquiesced. The same strand `handoff_not_recorded` exists to prevent, reached by the one
   * line in the block that does no work.
   *
   * Only this message throws. The later notes must still be delivered normally, or the test
   * would pass for the wrong reason.
   */
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  let started = false
  const delivered: string[] = []

  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, new FakeRotationSession('fresh', 'claude', [HONEST]), {
      startReplacement: async () => {
        started = true
        return new FakeRotationSession('fresh', 'claude', [HONEST])
      },
      note: (text) => {
        if (text.includes('quiesced')) throw new Error('the log stream is closed')
        delivered.push(text)
      },
    }),
  })

  assert.equal(r.status, 'rolled_back')
  if (r.status !== 'rolled_back') return
  assert.equal(r.reason, 'handoff_not_recorded')
  assert.ok(
    r.detail.includes('the post-quiesce notification'),
    `the stage that threw has to be nameable, or "handoff_not_recorded" says nothing: ${r.detail}`,
  )
  assert.ok(r.detail.includes('the log stream is closed'), r.detail)
  assert.equal(started, false, 'nothing was created: the failure is before the advisor is even asked')
  assert.equal(old.state, 'running')
  assert.deepEqual(old.transitions, ['quiesced', 'running'], 'frozen and put straight back')
  assert.deepEqual(delivered, [], 'and the run got no further: no handoff was recorded either')
})

test('a rotation that cannot BEGIN puts both sessions back', async () => {
  /**
   * The only failure with two live sessions in it.
   *
   * `beginRotation()` sits between the replacement's start and the acceptance block, and it was
   * bare: `await old.beginRotation()`, no handler. On a real adapter that transition is
   * announced over the same transport as everything else and can reject on a session that
   * quiesced perfectly well a moment earlier -- and when it did, the throw left `rotate()` with
   * the original still frozen AND the replacement running and unreferenced. Both lost at once,
   * which is the precise shape every other rollback in this file exists to make impossible.
   *
   * It is also not `replacement_start_failed`: nothing is wrong with the replacement. The
   * unhealthy session is the original, and that is what a caller deciding whether to try again
   * needs to be told.
   */
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  old.beginRotationThrows = 'the pty is gone'
  let replacement: FakeRotationSession | undefined

  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, new FakeRotationSession('fresh', 'claude', [HONEST]), {
      startReplacement: async () => {
        replacement = new FakeRotationSession('fresh', 'claude', [HONEST])
        return replacement
      },
    }),
  })

  assert.equal(r.status, 'rolled_back')
  if (r.status !== 'rolled_back') return
  assert.equal(r.reason, 'rotation_not_begun')
  assert.notEqual(r.reason, 'replacement_start_failed', 'the replacement started fine; the original refused')
  assert.ok(r.detail.includes('the pty is gone'), r.detail)

  assert.equal(old.state, 'running', 'the original is back in service, not left frozen')
  assert.deepEqual(old.transitions, ['quiesced', 'running'], 'and it never entered `rotating`')

  assert.ok(replacement, 'precondition: the replacement really was started before this failed')
  assert.equal(replacement.state, 'terminated', 'the one that was started is not left running unreferenced')
  assert.equal(replacement.closedAs, 'abandoned', 'abandoned rather than graceful: it proved nothing')
  assert.deepEqual(replacement.received, [], 'and it was never told anything, so nothing is half-transferred')

  // The handoff is authored and captured by this point, and a retry should not have to spend
  // another advisor turn re-deriving it.
  assert.ok(r.handoff)
})

test('a repository that diverged during the transfer rolls back and abandons the replacement', async () => {
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', [HONEST])

  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, fresh, {
      exchange: async (session, text) => {
        // Something rewrites the file the handoff depends on while the replacement is
        // being verified. This is the case §7a's step 6 exists for: without rollback the
        // replacement carries on from a state it never reproduced, and silently.
        if (session === fresh) writeFileSync(join(dir, 'work.ts'), 'export const answer = 0\n')
        return fakeExchange(session, text)
      },
    }),
  })

  assert.equal(r.status, 'rolled_back')
  if (r.status !== 'rolled_back') return
  assert.equal(r.reason, 'repository_diverged')
  assert.ok(r.detail.includes('work.ts'))
  assert.equal(old.state, 'running', 'the work is not stranded between two sessions')
  assert.equal(fresh.state, 'terminated')
  assert.equal(fresh.closedAs, 'abandoned')
})

test('a replacement claiming a result the arbiter did not observe is refused', async () => {
  // The failure this catches is not a replacement that reports a mismatch — that is a
  // working transfer. It is one that reports agreement it never observed.
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', ['CHECK 1: exit 0\n\nAll good.'])

  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, fresh, { checks: ['exit 3'] }),
  })

  assert.equal(r.status, 'rolled_back')
  if (r.status !== 'rolled_back') return
  assert.equal(r.reason, 'replacement_could_not_reproduce')
  assert.ok(r.detail.includes('reported as exit 0'))
  assert.ok(r.detail.includes('observed 3'))
  assert.equal(old.state, 'running')
  assert.equal(fresh.closedAs, 'abandoned')
})

test('silence about the checks is a failed transfer, not an implied pass', async () => {
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', ['Looks fine to me, I have the context.'])

  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, fresh),
  })

  assert.equal(r.status, 'rolled_back')
  if (r.status !== 'rolled_back') return
  assert.equal(r.reason, 'replacement_could_not_reproduce')
  assert.ok(r.detail.includes('no reported exit code'))
})

test('a check failing identically before and after is a reproduced state, not a divergence', async () => {
  // Rotation verifies continuity, not health. Refusing to rotate out of a red tree would
  // strand exactly the session that most needs replacing -- so a check that exits the same
  // way on both sides is a successful transfer, and the failure is carried forward
  // explicitly rather than being either ignored or treated as a blocker.
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', [
    'CHECK 1: exit 3\n\nThe suite is red, and the handoff calls it green. Flagging that.',
  ])
  const notes: string[] = []

  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, fresh, { checks: ['exit 3'], note: (n) => notes.push(n) }),
  })

  assert.equal(r.status, 'rotated')
  if (r.status !== 'rotated') return
  assert.deepEqual(r.acceptance.claimMismatches, [], 'the replacement reported what was there')
  assert.deepEqual(r.acceptance.divergences, [])
  // The advisor wrote "the implementer reports the suite green" from prose it could not
  // check. This is the one place that account and the arbiter's can be seen to disagree.
  assert.equal(r.acceptance.carriedFailures.length, 1)
  assert.equal(r.acceptance.carriedFailures[0]!.exitCode, 3)
  assert.ok(notes.some((n) => n.includes('carried forward failing')))
  assert.ok(r.handoff.narrative.evidence.includes('suite green'))
})

test('a note that throws AFTER the commit cannot undo a rotation that already happened', async () => {
  /**
   * The last window in the transaction, and the only one where rolling back is incoherent.
   *
   * Everything between the quiesce and the commit ends in a handoff or a rollback -- that is
   * what the guarded block is for, and three tests above pin it. Past `old.close('graceful')`
   * there is nothing to roll back TO: the original's context is given up, the replacement has
   * proved it can reproduce the state, and the transfer is done.
   *
   * The reporting lines sat inside the same handler anyway. So a `note` that threw -- a REPL, a
   * log, a stream something else had closed -- was caught by the acceptance catch, which called
   * `rollback()`, which called `unquiesce()` on a session that had just been terminated, which
   * throws, which escapes `rotate()`. The caller got an exception for a rotation that had
   * SUCCEEDED, and no reference to the live replacement it was now responsible for.
   *
   * Only the completion message throws here. That is deliberate: it is the first line past the
   * commit, so it proves the guard is on the near side of the window rather than somewhere
   * later, and the carried-failure line after it proves one broken write does not silence the
   * rest of the report.
   */
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  // A check that fails identically on both sides, so there is a carried-failure note to deliver
  // after the one that throws. Without it nothing follows the completion line and "the rest of
  // the report survives" would be untested.
  const fresh = new FakeRotationSession('fresh', 'claude', [
    'CHECK 1: exit 3\n\nThe suite is red, and the handoff calls it green. Flagging that.',
  ])
  const delivered: string[] = []

  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, fresh, {
      checks: ['exit 3'],
      note: (text) => {
        if (text.includes('rotation complete')) throw new Error('the log stream is closed')
        delivered.push(text)
      },
    }),
  })

  assert.equal(r.status, 'rotated', 'the rotation happened, and saying so badly does not unmake it')
  if (r.status !== 'rotated') return

  // Both sessions are where a successful rotation leaves them. Under the old handler the
  // original would have been asked to unquiesce here, from `terminated`.
  assert.equal(old.state, 'terminated', 'the original stays committed, not dragged back')
  assert.equal(old.closedAs, 'graceful')
  assert.deepEqual(old.transitions, ['quiesced', 'rotating', 'terminated'])
  assert.equal(fresh.state, 'running', 'and the replacement is live and returned to the caller')
  assert.equal(r.replacement, fresh)

  // The result is whole: a caller that has to take over this replacement gets what it needs.
  assert.ok(r.handoff)
  assert.equal(r.acceptance.carriedFailures.length, 1)

  // One broken write, not a silenced report.
  assert.ok(
    delivered.some((n) => n.includes('carried forward failing')),
    `reporting continues past the line that threw: ${JSON.stringify(delivered)}`,
  )
  assert.ok(
    !delivered.some((n) => n.includes('rotation complete')),
    'precondition: the completion message really did throw rather than being delivered',
  )
})

test('an exchange that throws mid-acceptance does not strand the original in `rotating`', async () => {
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', [HONEST])

  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, fresh, {
      exchange: async (session, text) => {
        if (session === fresh) throw new Error('transport lost')
        return fakeExchange(session, text)
      },
    }),
  })

  assert.equal(r.status, 'rolled_back')
  if (r.status !== 'rolled_back') return
  assert.ok(r.detail.includes('transport lost'))
  assert.equal(old.state, 'running')
  // And it is reported as what it is (#76). A send that never completed produced no observed
  // turn, so the gate was not FAILED, it could not be applied -- and telling the operator their
  // replacement could not reproduce the state invites a retry that will do the same thing.
  assert.equal(r.reason, 'acceptance_unobservable')
  assert.match(r.detail, /NO replacement can pass/)
})

test('a replacement that answers with nothing at all is unobservable, not unable to reproduce', async () => {
  // The other half of the same distinction, and the one a live run actually produced: the
  // exchange RETURNS, and there is nothing in it. A transcript that yields no prose after a
  // completed turn is what a wedged transport looks like from inside the transaction.
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  const mute = new FakeRotationSession('mute', 'claude') // no scripted replies: every turn is empty

  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, mute, { transportEvidence: () => ['mute emitted 0 event(s) since it was started'] }),
  })

  assert.equal(r.status, 'rolled_back')
  if (r.status !== 'rolled_back') return
  assert.equal(r.reason, 'acceptance_unobservable')
  assert.match(r.detail, /no prose at all/)
  assert.match(r.detail, /upstream of rotation/)
  assert.deepEqual(r.evidence, ['mute emitted 0 event(s) since it was started'])
  // The gate is not weakened by any of this: the original is back, and nothing was swapped.
  assert.equal(old.state, 'running')
  assert.equal(mute.closedAs, 'abandoned')
})

test('a replacement that answers wrongly is still `replacement_could_not_reproduce`', async () => {
  // The distinction only means something if the other side of it survives. A replacement that
  // SPOKE and got the exit code wrong is a bad draw, and retrying it may well help -- which is
  // the advice the unobservable reason must not be allowed to swallow.
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  const wrong = new FakeRotationSession('wrong', 'claude', ['CHECK 1: exit 1\n\nI ran it and it failed.'])

  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, wrong),
  })

  assert.equal(r.status, 'rolled_back')
  if (r.status !== 'rolled_back') return
  assert.equal(r.reason, 'replacement_could_not_reproduce')
  assert.equal(r.evidence, undefined, 'transport evidence belongs only to the claim that rests on it')
})

test('human constraints are replayed separately, at human rank, before the handoff', async () => {
  // Folded into the advisor's prose they would arrive as a suggestion from a peer. The
  // envelope is the only thing that tells the recipient who is talking.
  const dir = repo()
  const constraint: RelayMessage = {
    seq: 4,
    at: 0,
    from: 'human',
    fromRank: 'human',
    to: ['implementer'],
    kind: 'constraint',
    text: 'Never stage with git add -A while a session is live.',
    visibility: 'normal',
    excluded: [],
  }
  const fresh = new FakeRotationSession('fresh', 'claude', ['Understood.', HONEST])

  const r = await rotate({
    old: new FakeRotationSession('old', 'claude'),
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, fresh, { constraints: [constraint] }),
  })

  assert.equal(r.status, 'rotated')
  assert.equal(fresh.received.length, 2)
  assert.ok(fresh.received[0]!.includes('FROM THE HUMAN'))
  assert.ok(fresh.received[0]!.includes('git add -A'))
  assert.ok(fresh.received[1]!.includes('## BRIEF'), 'the handoff arrives after the constraints')
})

test('rotating a session that is not running is a programming error, not a rollback', async () => {
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  await old.quiesce()
  await assert.rejects(
    rotate({
      old,
      advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
      reason: 'context exhausted',
      deps: deps(dir, new FakeRotationSession('fresh', 'claude', [HONEST])),
    }),
    /cannot rotate a session in state 'quiesced'/,
  )
})

test('a rotation cannot begin against a session that is still accepting work', async () => {
  const s = new FakeRotationSession('s', 'claude')
  await assert.rejects(() => s.beginRotation(), /quiesce the session first/)
})

test('an informational check that does not reproduce does not roll the rotation back (#9)', async () => {
  // A check can reproduce faithfully and still say nothing about the transferred artifact.
  // Refusing a transfer on one of those strands the session that most needed replacing, for
  // a reason unconnected to the work.
  //
  // Relevance is declared HERE, by the orchestrator, in the deps the caller supplies. A
  // replacement classifying its own checks would be grading its own transfer.
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  const fresh = new FakeRotationSession(
    'fresh',
    'claude',
    // Reports check 1 correctly and check 2 wrongly. Check 2 is informational.
    ['CHECK 1: exit 0\nCHECK 2: exit 0\n\nRan both; the artifact matches the handoff.'],
  )

  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    deps: deps(dir, fresh, {
      checks: ['exit 0', { command: 'exit 3', relevance: 'informational' }],
    }),
  })

  assert.equal(r.status, 'rotated', 'an informational disagreement must not block the transfer')
  if (r.status !== 'rotated') return
  // Reported, not discarded: the operator still learns the replacement got it wrong.
  assert.equal(r.acceptance.claimMismatches.length, 0, 'nothing blocking')
  assert.equal(r.acceptance.advisoryMismatches.length, 1)
  assert.match(r.acceptance.advisoryMismatches[0]!, /exit 3/)
  assert.match(r.acceptance.advisoryMismatches[0]!, /\[informational\]/, 'the reader is told why it did not block')
  assert.equal(old.closedAs, 'graceful', 'the old session was actually given up')
})

test('the same disagreement on a required check still rolls back', async () => {
  // The control. Without it the test above only proves that something did not happen, which
  // is equally consistent with the comparison having stopped working altogether.
  const dir = repo()
  const old = new FakeRotationSession('old', 'claude')
  const fresh = new FakeRotationSession('fresh', 'claude', [
    'CHECK 1: exit 0\nCHECK 2: exit 0\n\nRan both; the artifact matches the handoff.',
  ])

  const r = await rotate({
    old,
    advisor: new FakeRotationSession('advisor', 'codex', [HANDOFF]),
    reason: 'context exhausted',
    // Identical, except that the second check is required.
    deps: deps(dir, fresh, { checks: ['exit 0', 'exit 3'] }),
  })

  assert.equal(r.status, 'rolled_back')
  if (r.status !== 'rolled_back') return
  assert.equal(r.reason, 'replacement_could_not_reproduce')
  assert.match(r.detail, /exit 3/)
  assert.equal(old.state, 'running', 'the original is back in service')
})

test('a bare string check stays required, so an existing configuration is not weakened', () => {
  // Relevance arrived after checks did. Defaulting a plain string to anything but `required`
  // would silently downgrade a gate someone configured before the distinction existed.
  assert.equal(checkRelevance('npm test'), 'required')
  assert.equal(checkCommand('npm test'), 'npm test')
  assert.equal(checkRelevance({ command: 'npm run lint', relevance: 'unrelated' }), 'unrelated')
})
