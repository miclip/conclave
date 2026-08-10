/**
 * LIVE — the rollback branch, against real sessions.
 *
 * The last unobserved branch of the mechanism. Both passing live rotations took the
 * promotion path, so leak-free abandonment has only ever been reasoned about plus tested
 * against fakes — and the one time it ran for real, it leaked a Claude process for 26
 * minutes and nobody noticed until the orchestrator refused to exit.
 *
 * Acceptance is forced to fail **deterministically and from outside the participants**. The
 * check tests for a sentinel file, and the test creates that file at a causally defined
 * point rather than at a guessed time:
 *
 *   captured at handoff              sentinel absent   exit 0
 *   ← rotate() awaits `hooks.afterCapture`; the test creates the sentinel there
 *   re-run at acceptance             sentinel present  exit 1
 *
 * That produces `check_exit_changed`, which is blocking, so the transaction rolls back for
 * `repository_diverged`. Nothing about it depends on either model behaving badly — a
 * rollback triggered by provoking a participant would be testing the participant, not the
 * transaction.
 *
 * The first attempt keyed the flip to wall-clock time and did not trigger: `flipAt` was
 * computed at test start, but capture happens after relay startup, the implementer's first
 * turn AND the advisor's handoff turn, so the check was already failing when the record was
 * taken. Same exit code on both sides is a *reproduced state*, and the rotation correctly
 * proceeded — the product was right and the trigger was mistimed. The window between the
 * two captures was 28 seconds and its offset from test start is not predictable, so no
 * choice of constant is safe.
 *
 * A poll on the orchestrator's log got the ordering right, but only probabilistically ahead
 * of the replacement: the sentinel was guaranteed to follow capture and merely likely to
 * precede everything else. `afterCapture` is a barrier, so "nothing downstream of capture
 * observed the old state" holds by construction rather than by a timing that happened to
 * work. That distinction is the difference between a proof and a passing test.
 *
 * Four properties, all of which the offline suite asserts against fakes:
 *
 *   1. the replacement is terminated
 *   2. the original is unquiesced and back in service
 *   3. the work is not stranded — the run continues on the original
 *   4. NO CHILD PROCESS SURVIVES
 *
 * Four is the one that only exists here. A fake session's `close()` sets a field; a real
 * one has to convince a CLI holding a PTY to die.
 *
 *   ORCH_LIVE_ROLLBACK=1 node --test src/rotation/rotate.rollback.live.test.ts
 *
 * Spawns three real sessions and uses real quota.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { defaultRegistry } from '../registry/builtin.ts'
import { Relay } from '../relay/relay.ts'
import type { RunOutcome } from '../relay/run.ts'

const skip =
  process.env.ORCH_LIVE_ROLLBACK === '1'
    ? false
    : 'set ORCH_LIVE_ROLLBACK=1 (spawns three real sessions, uses quota)'

/** Live `claude` children of this orchestrator, by the settings dir only it passes. */
function liveChildren(): string[] {
  try {
    return execFileSync('/usr/bin/pgrep', ['-fl', 'orch-claude'], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes('--settings'))
      .map((l) => l.trim())
  } catch {
    return []
  }
}

test('a failed acceptance rolls back against real sessions, leaking nothing', { skip }, async (t) => {
  const repo = join(import.meta.dirname, '..', '..')
  const work = join(repo, '.conclave', 'scratch-rollback')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  t.after(() => rmSync(work, { recursive: true, force: true }))

  // Lives under gitignored `.conclave/`, so creating it cannot dirty the working tree --
  // which is exactly why its removal has to be asserted DIRECTLY. Repository cleanliness
  // cannot prove transaction scratch cleanup for anything inside an ignored directory.
  const sentinel = join(repo, '.conclave', 'rollback-sentinel')
  let sentinelAtCapture: boolean | undefined
  let flippedAt = 0
  rmSync(sentinel, { force: true })
  t.after(() => rmSync(sentinel, { force: true }))
  // Exit 0 while absent, 1 once present. A function of one file and nothing else.
  const CHECK = `sh -c 'test ! -f ${sentinel}'`

  const before = liveChildren().length
  const startedBefore = liveChildren()
  const treeBefore = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })

  const relay = await Relay.start({
    registry: defaultRegistry(),
    cwd: repo,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 4,
    rotation: {
      checks: [CHECK],
      checkTimeoutMs: 120_000,
      // The barrier. Nothing after capture -- not the replacement's own run of the check,
      // not the acceptance capture -- can observe the pre-flip world.
      hooks: {
        afterCapture: async () => {
          sentinelAtCapture = existsSync(sentinel)
          writeFileSync(sentinel, 'the check fails from here on\n')
          flippedAt = Date.now()
        },
      },
    },
  })
  t.after(() => relay.stop())

  const run = relay.start(
    `Work only inside ${work}. Create a file called note.txt containing one sentence about ` +
      `what you did, then wait for the next instruction. Touch nothing outside that directory.`,
  )

  // Rotate only once there is real state to transfer.
  const armed = Date.now() + 420_000
  while (Date.now() < armed && !relay.log.some((m) => m.kind === 'report')) {
    await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(relay.log.some((m) => m.kind === 'report'), 'the implementer should have reported first')

  const pause = await run.requestPause('rotating to test the rollback branch')
  assert.ok(pause)

  const impl = relay.participants.find((p) => p.rank === 'implementer')!
  const original = impl.session
  const duringRotation = liveChildren().length

  const rotateStarted = Date.now()
  const result = await run.rotateImplementer('mechanism test: acceptance is rigged to fail')

  // Record what the clock actually did, so a surprising pass or failure is diagnosable
  // rather than merely flaky-looking. These are the two runs the comparison rests on.
  const recorded = result.handoff?.record.checks[0]
  const observed = result.acceptance?.observed.checks[0]
  console.log(`\n    [flip]        ${flippedAt ? `at epoch ${Math.floor(flippedAt / 1000)}, ${((flippedAt - rotateStarted) / 1000).toFixed(1)}s into the rotation` : 'NEVER FIRED'}`)
  console.log(`    [capture]     exit ${recorded?.exitCode} at epoch ${Math.floor((result.handoff?.record.at ?? 0) / 1000)}`)
  console.log(`    [acceptance]  exit ${observed?.exitCode} at epoch ${Math.floor((result.acceptance?.observed.at ?? 0) / 1000)}`)
  console.log(`    [rotation]    took ${((Date.now() - rotateStarted) / 1000).toFixed(1)}s`)
  console.log(`    [divergences] ${JSON.stringify(result.acceptance?.divergences ?? [])}`)

  // The trigger has to have fired, or this proves nothing. A rotation that simply
  // succeeded is an untriggered test, not a passing one.
  assert.equal(
    result.status,
    'rolled_back',
    `acceptance was expected to fail on a clock-flipped check but the rotation ${result.status}. ` +
      `The sentinel ${flippedAt ? 'was' : 'was NEVER'} created; capture exit ${recorded?.exitCode}, ` +
      `acceptance exit ${observed?.exitCode}. Equal exit codes are a reproduced state, not a divergence.`,
  )
  assert.equal(result.reason, 'repository_diverged', `rolled back for the wrong reason: ${result.detail}`)
  // Both exit codes, explicitly. The rollback must rest on 0 → 7 and nothing else.
  assert.equal(recorded?.exitCode, 0, 'the check must have passed when the handoff was captured')
  assert.equal(observed?.exitCode, 1, 'and failed when acceptance re-ran it')
  assert.ok(
    result.acceptance?.divergences.some((d) => d.kind === 'check_exit_changed' && d.severity === 'blocking'),
    'the rollback must be caused by the exit-code divergence, not by something incidental',
  )

  // The barrier held: capture ran in a world without the sentinel, everything after it did
  // not. Structural, not timing.
  assert.equal(sentinelAtCapture, false, 'the marker must not have existed when the record was captured')
  assert.ok(flippedAt > 0, 'afterCapture must have run')
  assert.equal(existsSync(sentinel), true, 'the marker must exist by the time acceptance ran')

  // Like-for-like. If the two captures had run different commands the divergence would be
  // `check_missing`, and the rollback would prove something else entirely.
  assert.equal(recorded?.command, CHECK)
  assert.equal(observed?.command, CHECK)
  assert.equal(recorded!.command, observed!.command, 'the same declared check, byte for byte')

  // ONLY the environment changed. No file moved, HEAD did not move, and the tree gained
  // nothing -- so the transaction rejected a changed *result*, not a changed repository.
  assert.deepEqual(
    (result.acceptance?.divergences ?? []).filter((d) => d.kind !== 'check_exit_changed'),
    [],
    'nothing but the check result may have diverged',
  )

  // 1 & 2. The transaction's own guarantee.
  assert.equal(impl.session, original, 'the participant must still hold the original')
  assert.equal(original.state, 'running', 'the original is back in service, not stranded')

  // 4. No child survives. This is the property that only exists live: a fake `close()`
  //    sets a field, a real one has to convince a CLI holding a PTY to die. The first live
  //    rollback leaked one for 26 minutes and was only noticed because node would not exit.
  const settle = Date.now() + 30_000
  while (Date.now() < settle && liveChildren().length > duringRotation) {
    await new Promise((r) => setTimeout(r, 500))
  }
  const after = liveChildren().length
  assert.equal(
    after,
    duringRotation,
    `the abandoned replacement leaked a process.\n  before rotation: ${duringRotation}\n  now: ${after}\n` +
      liveChildren().map((l) => `    ${l.slice(0, 100)}`).join('\n'),
  )
  assert.ok(after >= before, 'sanity: the original must still be running')

  // 3. The work is not stranded — the restored session can still be driven.
  const turnsBefore = (await original.snapshot()).turns.length
  run.injectConstraint('Add a second sentence to note.txt.', { only: 'implementer' })
  await run.continue()

  let outcome: RunOutcome
  const pauses: string[] = []
  for (;;) {
    const s = await run.settled()
    if (s.kind === 'ended') {
      outcome = s.outcome
      break
    }
    pauses.push(`${s.pause.reason}: ${s.pause.detail}`)
    console.log(`\n    [paused after rollback] ${s.pause.reason}: ${s.pause.detail}`)
    if (pauses.length > 3) {
      await run.abort('too many pauses to be a working session')
      break
    }
    await run.continue()
  }

  assert.notEqual(outcome!.reason, 'escalated', `the restored session could not continue: ${outcome!.detail}`)
  assert.ok(
    (await original.snapshot()).turns.length > turnsBefore,
    'the restored original took real turns after the failed transfer',
  )

  console.log(`\n    [rolled back] ${result.reason}: ${result.detail}`)
  console.log(`    [replacement prose]\n${(result.acceptance?.prose ?? '(none)').split('\n').slice(0, 12).map((l) => `      ${l}`).join('\n')}`)

  // --- teardown is part of the claim -----------------------------------------------
  // Stop explicitly rather than leaving it to `t.after`, so the post-conditions can be
  // asserted. `stop()` is idempotent, so the after-hook remains harmless.
  await relay.stop()

  const settled2 = Date.now() + 30_000
  while (Date.now() < settled2 && liveChildren().length > before) {
    await new Promise((r) => setTimeout(r, 500))
  }
  assert.deepEqual(
    liveChildren().filter((l) => !startedBefore.includes(l)),
    [],
    'no participant process may survive teardown',
  )
  assert.equal(existsSync(join(repo, '.conclave', 'session.lock')), false, 'the session lock must be released')

  // The working tree must be exactly as dirty as it was, plus nothing. The scratch dir is
  // inside gitignored `.conclave/`, so intentional test artifacts do not appear here.
  const treeAfter = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
  assert.equal(treeAfter, treeBefore, 'the run must not have changed the working tree')

  // Asserted directly, because `.conclave/` is gitignored and the tree check above is blind
  // to everything in it. A leaked trip-wire is invisible and would poison the next run --
  // the same shape as the frozen-corpus contamination this project has already had once.
  rmSync(sentinel, { force: true })
  assert.equal(existsSync(sentinel), false, 'the trip-wire must not outlive the test')
  rmSync(work, { recursive: true, force: true })
  assert.equal(existsSync(work), false, 'the transaction scratch directory must not outlive the test')
})
