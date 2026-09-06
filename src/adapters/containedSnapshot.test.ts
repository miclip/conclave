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
import { containAdapterRunDirs, tempDir } from '../testkit/tempDir.ts'

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
containAdapterRunDirs()

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

/**
 * How long the BASELINE is given to find a read that completed inside the lease.
 *
 * Deliberately unrelated to `LEASE_MS`: this is not one lease, nor a multiple chosen to cover a
 * slow one. It is the bound past which a machine that cannot read a two-line file inside 60ms
 * even once, over hundreds of attempts, is a machine this suite cannot measure anything on.
 */
const BASELINE_MS = 10_000

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

/**
 * The baseline: a snapshot that was actually READ, waited for rather than assumed (#186).
 *
 * This establishes a precondition -- "reads work here" -- and it used to be asserted on the
 * first attempt. That held because a machine is usually fast enough, which is not a property of
 * the code. `macos-15-intel` took longer than the injected lease on one CI run, the very first
 * read came back contained, and the test failed on its own setup with `a snapshot that was read
 * is not marked as a fallback` -- a message describing the shape of the answer rather than the
 * reason for it.
 *
 * Nothing about the subject requires the FIRST read to win. A contained baseline means one read
 * was slow, not that reads do not work, so the honest response is to take another. What the
 * test cannot do without is a read that succeeded at some point, and that is what this waits
 * for.
 *
 * The bound is not a margin over the lease. It is the point past which "slow" has become
 * "reads never complete here", and blowing it says so in those words -- so the next failure on
 * the slowest runner names the runner instead of accusing the containment logic.
 */
async function readBaseline(session: AgentSession, withinMs = BASELINE_MS): Promise<SessionSnapshot> {
  const started = Date.now()
  let last: SessionSnapshot | undefined
  while (Date.now() - started < withinMs) {
    const snap = await snapshotWithin(session, 10_000)
    if (snap.containedFallback === undefined && snap.turns.length >= 1) return snap
    last = snap
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.fail(
    `no read completed inside the ${LEASE_MS}ms lease within ${withinMs}ms, so the baseline ` +
      `could not be established: every attempt came back ` +
      `${last?.containedFallback ? 'contained' : `with ${last?.turns.length ?? 0} turn(s)`}. ` +
      `This measures how fast this machine reads a file, not containment.`,
  )
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
    const before = await readBaseline(session)

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

    const before = await readBaseline(session)

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

// --- The baseline helper itself ---------------------------------------------------------
//
// `readBaseline` exists because the first read can come back contained on a slow runner
// (#186). The two tests above cannot exercise that: on every machine available here the first
// read succeeds, which is exactly why the old assertion looked correct for as long as it did.
// So the retry is driven directly, against a session that answers the way that runner did.

/** A session whose `snapshot()` returns each of `answers` in turn, then repeats the last. */
function sessionAnswering(answers: SessionSnapshot[]): { session: AgentSession; calls: () => number } {
  let n = 0
  const session = {
    async snapshot(): Promise<SessionSnapshot> {
      const at = Math.min(n, answers.length - 1)
      n += 1
      return answers[at]!
    },
  } as unknown as AgentSession
  return { session, calls: () => n }
}

const contained = (turns: number): SessionSnapshot =>
  ({ turns: Array.from({ length: turns }, () => ({})), containedFallback: true }) as unknown as SessionSnapshot

const read = (turns: number): SessionSnapshot =>
  ({ turns: Array.from({ length: turns }, () => ({})) }) as unknown as SessionSnapshot

test('#186 a contained first read is retried, not failed on', async () => {
  // The flake, as the slow runner produced it: turns were present -- so a read HAD happened at
  // some point -- and the answer was still marked contained. One slow read is not evidence that
  // reads do not work, and the test needs a read that worked, not the first one.
  const { session, calls } = sessionAnswering([contained(1), contained(1), read(1)])
  const snap = await readBaseline(session)
  assert.equal(snap.containedFallback, undefined)
  assert.equal(calls(), 3, 'it kept asking until a read came back')
})

test('#186 a baseline that never reads fails naming the machine, not the containment logic', async () => {
  // What the next failure on the slowest runner should say. The old message was `a snapshot that
  // was read is not marked as a fallback`, which describes the shape of the answer and points at
  // the code under test; the cause is that no read finished in time.
  // A short bound here on purpose: the real one is ten seconds, and what this asserts is the
  // MESSAGE on the give-up path, which is the same message at any bound.
  const { session } = sessionAnswering([contained(1)])
  const failure = await readBaseline(session, 200).then(() => undefined, (e: Error) => e)
  assert.ok(failure, 'a machine where no read ever completes must still fail')
  assert.match(failure.message, /the baseline could not be established/)
  assert.match(failure.message, /how fast this machine reads a file, not containment/)
})

test('#186 a read with no turns is not a baseline either', async () => {
  // The other half of the precondition, and it was a separate assertion before. A snapshot with
  // nothing in it is what the adapter returns before its view exists at all -- so accepting it
  // would establish "reads work" from a document that proves no read ever happened.
  const { session, calls } = sessionAnswering([read(0), read(0), read(2)])
  const snap = await readBaseline(session)
  assert.equal(snap.turns.length, 2)
  assert.equal(calls(), 3)
})
