/**
 * The session contract's `snapshot()` must answer, even when the transcript read does not.
 *
 * `TranscriptSessionView` recovers from a read that never returns by detaching it and telling
 * its caller, by rejection, that it got no answer. That is right for the queue and right for
 * the callers that carry a bound of their own -- the deadline re-check needs the rejection, or
 * its single-flight slot is never freed for the next attempt.
 *
 * It is wrong for everybody else, and "everybody else" is most of the production boundaries:
 *
 *   the report          `report.ts` snapshots every seat to describe the run; a throw there
 *                       takes down the thing that was supposed to be observing
 *   the seat record     `workspace/sessionRecord.ts`, same shape
 *   the relay           compaction generation is read off a snapshot in several places
 *   rotation            `rotate()` snapshots the original AFTER quiescing it, so a throw there
 *                       used to escape past the rollback and strand a live session frozen
 *
 * None of them passes a bound and none of them has anywhere to go with a rejection. So the
 * adapters route their public `snapshot()` through `snapshotOrLastBuilt()`, which hands back
 * the last projection built from records that were actually read, stamped with when that was.
 *
 * Driven through the REAL adapters over a stand-in child, with the wedge inside the real view
 * queue, because the claim is about what a consumer of `AgentSession` sees.
 *
 *   node --test src/adapters/containedSnapshot.test.ts
 */

import { strict as assert } from 'node:assert'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { AgentSession, SessionSnapshot } from '../contract/session.ts'
import { wedgeOneTailPoll, type TailWedge } from '../transcript/tailWedge.ts'
import { ClaudePtyHookAdapter } from './claude.ts'
import { CodexPtyHookAdapter } from './codex.ts'
import { installFakeClis } from './fakeCli.ts'
import { suiteTempDir, tempDir } from '../testkit/tempDir.ts'

/**
 * The run directories the adapters this file boots make for themselves, contained.
 *
 * `Claude.#boot` and `Codex.#boot` each `mkdtemp` a run directory under `os.tmpdir()` and
 * never remove it. That is PRODUCTION behaviour and issue #203's business, not this file's --
 * so rather than change it, the floor it lands on moves: `tmpdir()` re-reads `TMPDIR` on every
 * call, so pointing it at a directory the testkit issued puts every run directory booted here
 * inside something whose lifetime the helper already owns.
 *
 * Per FILE, and that is what makes it safe rather than a shared global: every test file runs
 * in its own process under `node --test`, so this reaches no other suite, and the tests in
 * this one stay isolated from each other exactly as before -- by `tempDir` handing each its
 * own uniquely named child of this root.
 */
const ADAPTER_TMP_ROOT = suiteTempDir('adapter-run-root')
process.env['TMPDIR'] = ADAPTER_TMP_ROOT

const { dir: RUN } = installFakeClis()

/** Both clocks far out of reach: a deadline would put a second, BOUNDED reader on the queue. */
const IDLE_MS = 120_000
const ABSOLUTE_MS = 300_000

/**
 * The view's read lease, injected rather than inherited.
 *
 * Production is `READ_LEASE_MS`, ten seconds, set far above any read that is merely slow. What
 * these tests are about is what a caller gets once a lease is SPENT, and nothing in them turns
 * on the value -- so waiting out the real one twice over is thirty-odd seconds of a suite doing
 * nothing. The adapters take the override and hand it to the view they build, so the real
 * adapter, the real view and the real read are all still under test; only the clock is smaller.
 *
 * Long enough that no healthy read on a loaded machine trips it, which is the only property the
 * number itself has to have here.
 */
const LEASE_MS = 60

/**
 * How long the contained snapshot is given to come back, derived from the injected lease.
 *
 * It waits out one lease: the tailer's held read is what everything is waiting on, and the
 * caller is answered when that read outlives the lease. It is not admitted and held for a
 * second lease of its own -- a second read is never authorised while the first is outstanding.
 * The multiplier is scheduling slack on a shared machine, not a second lease; anything past it
 * is the failure this test exists to catch, which is a rejection or a wait with no end.
 */
const PATIENCE_MS = LEASE_MS * 50

/** The tail runs on a 400ms interval, so this is several chances to be caught. */
const CATCH_MS = 3_000

function scratch(t: TestContext, prefix: string, name: string): string {
  return join(tempDir(t, prefix), name)
}

/** Arm the wedge on EVERY poll, and wait until the tail has actually walked into it. */
async function holdingEveryRead(wedge: TailWedge): Promise<void> {
  // Every poll, not just the next: the adapter has a tailer of its own on a 400ms interval, so
  // `arm()` catches that one, the snapshot below queues behind it, and by the time the queue
  // advances the tail is unpatched again -- the snapshot succeeds and proves nothing.
  wedge.armAll()
  const until = Date.now() + CATCH_MS
  while (!wedge.taken && Date.now() < until) await new Promise((r) => setTimeout(r, 25))
  assert.equal(wedge.taken, true, 'precondition: the tail must actually be holding the read')
}

/** `snapshot()`, or a failure that says which of the two ways it failed. */
async function snapshotWithin(session: AgentSession, ms: number): Promise<SessionSnapshot> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      session.snapshot(),
      new Promise<never>((_r, reject) => {
        timer = setTimeout(
          () => reject(new Error(`snapshot() never returned within ${ms}ms; the wedged read still parks it`)),
          ms,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// --- Claude -----------------------------------------------------------------------------

const userRecord = (content: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content } })

const doneRecord = (text: string): string =>
  JSON.stringify({
    type: 'assistant',
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
  })

async function claudeSessionOver(transcript: string): Promise<AgentSession> {
  const previous = process.env['ORCH_FAKE_TRANSCRIPT']
  process.env['ORCH_FAKE_TRANSCRIPT'] = transcript
  try {
    return await ClaudePtyHookAdapter.start({
      cwd: RUN,
      role: 'implementer',
      inputOwnership: 'mediated',
      watchdogMs: ABSOLUTE_MS,
      idleMs: IDLE_MS,
      readyTimeoutMs: 20_000,
      readLeaseMs: LEASE_MS,
    })
  } finally {
    if (previous === undefined) delete process.env['ORCH_FAKE_TRANSCRIPT']
    else process.env['ORCH_FAKE_TRANSCRIPT'] = previous
  }
}

test('claude: snapshot() answers from the last good read instead of rejecting', async (t) => {
  const transcript = scratch(t, 'orch-contained', 'session.jsonl')
  writeFileSync(transcript, [userRecord('first prompt'), doneRecord('first answer')].join('\n') + '\n')

  const wedge = wedgeOneTailPoll()
  let session: AgentSession | undefined
  let released = false
  try {
    session = await claudeSessionOver(transcript)
    await session.send('first prompt', { kind: 'orchestrator' })

    // The baseline, taken while reads work. Everything below is measured against it.
    const before = await snapshotWithin(session, 10_000)
    assert.ok(before.turns.length >= 1, 'precondition: the view has read the transcript at least once')
    assert.equal(before.containedFallback, undefined, 'a snapshot that was read is not marked as a fallback')

    await holdingEveryRead(wedge)

    // Written only once nothing can read it, so its ABSENCE below is evidence. A snapshot that
    // somehow got to the filesystem would show two turns; the contained one shows what the last
    // read saw, which is one.
    appendFileSync(transcript, [userRecord('second prompt'), doneRecord('second answer')].join('\n') + '\n')

    const snap = await snapshotWithin(session, PATIENCE_MS)

    assert.equal(released, false, 'and it answered with the read still held, not because the wedge lifted')
    assert.equal(
      snap.turns.length,
      before.turns.length,
      `the contained snapshot is the last one built, not a fresh read: ${JSON.stringify(
        snap.turns.map((t) => t.prompt),
      )}`,
    )
    assert.equal(
      snap.builtAt,
      before.builtAt,
      'stamped when it was actually built, so a consumer can see it is stale rather than current',
    )
    assert.equal(snap.sessionId, before.sessionId, 'and it is still this session, fully formed')
    assert.equal(snap.role, 'implementer')
    // The flag has to survive the adapter, not just the view. `snapshot()` here merges
    // adapter-known turns over the projection, and rotation reads this to decide whether the
    // `compactionGeneration` it is about to write into a handoff was ever actually observed.
    assert.equal(snap.containedFallback, true, 'the adapter carries the fallback mark through its turn merge')
  } finally {
    released = true
    wedge.release()
    wedge.restore()
    await session?.close()
  }
})

// --- Codex ------------------------------------------------------------------------------

const codexEvent = (payload: Record<string, unknown>): string =>
  JSON.stringify({ type: 'event_msg', timestamp: new Date(0).toISOString(), payload })

const started = (turnId: string): string => codexEvent({ type: 'task_started', turn_id: turnId })
const prompted = (text: string): string => codexEvent({ type: 'user_message', message: text })
const finished = (turnId: string, message: string): string =>
  codexEvent({ type: 'task_complete', turn_id: turnId, last_agent_message: message })

async function codexSessionOver(transcript: string): Promise<AgentSession> {
  const previous = process.env['ORCH_FAKE_TRANSCRIPT']
  process.env['ORCH_FAKE_TRANSCRIPT'] = transcript
  try {
    return await CodexPtyHookAdapter.start({
      cwd: RUN,
      role: 'implementer',
      inputOwnership: 'mediated',
      watchdogMs: ABSOLUTE_MS,
      idleMs: IDLE_MS,
      readyTimeoutMs: 20_000,
      readLeaseMs: LEASE_MS,
    })
  } finally {
    if (previous === undefined) delete process.env['ORCH_FAKE_TRANSCRIPT']
    else process.env['ORCH_FAKE_TRANSCRIPT'] = previous
  }
}

test('codex: snapshot() answers from the last good read instead of rejecting', async (t) => {
  const path = scratch(t, 'orch-contained-codex', 'rollout.jsonl')
  writeFileSync(
    path,
    [started('fake-turn-1'), prompted('first prompt'), finished('fake-turn-1', 'first answer')].join('\n') + '\n',
  )

  const wedge = wedgeOneTailPoll()
  let session: AgentSession | undefined
  let released = false
  try {
    session = await codexSessionOver(path)
    await session.send('first prompt', { kind: 'orchestrator' })

    const before = await snapshotWithin(session, 10_000)
    assert.ok(before.turns.length >= 1, 'precondition: the view has read the transcript at least once')
    assert.equal(before.containedFallback, undefined, 'a snapshot that was read is not marked as a fallback')

    await holdingEveryRead(wedge)
    appendFileSync(
      path,
      [started('fake-turn-2'), prompted('second prompt'), finished('fake-turn-2', 'second answer')].join('\n') + '\n',
    )

    const snap = await snapshotWithin(session, PATIENCE_MS)

    assert.equal(released, false, 'and it answered with the read still held, not because the wedge lifted')
    assert.ok(
      !snap.turns.some((t) => t.prompt === 'second prompt'),
      `the contained snapshot is the last one built, not a fresh read: ${JSON.stringify(
        snap.turns.map((t) => t.prompt),
      )}`,
    )
    assert.equal(
      snap.builtAt,
      before.builtAt,
      'stamped when it was actually built, so a consumer can see it is stale rather than current',
    )
    assert.equal(snap.sessionId, before.sessionId)
    assert.equal(snap.role, 'implementer')
    // Codex merges by union rather than overlay, so this is a genuinely different code path
    // from Claude's -- and the same guarantee has to hold across it.
    assert.equal(snap.containedFallback, true, 'the adapter carries the fallback mark through its turn merge')
  } finally {
    released = true
    wedge.release()
    wedge.restore()
    await session?.close()
  }
})
