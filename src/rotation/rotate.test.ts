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
import { rotate, type RotationDeps } from './rotate.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-rotate-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 42\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

const HANDOFF = `## GOAL
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
  assert.ok(r.detail.includes('GOAL'))
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
  assert.ok(fresh.received[1]!.includes('## GOAL'), 'the handoff arrives after the constraints')
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
