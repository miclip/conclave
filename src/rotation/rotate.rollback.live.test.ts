/**
 * LIVE — the rollback branch, against real sessions.
 *
 * The last unobserved branch of the mechanism. Both passing live rotations took the
 * promotion path, so leak-free abandonment has only ever been reasoned about plus tested
 * against fakes — and the one time it ran for real, it leaked a Claude process for 26
 * minutes and nobody noticed until the orchestrator refused to exit.
 *
 * Acceptance is forced to fail **deterministically and from outside the participants**. The
 * check is a shell command whose exit code flips on wall-clock time:
 *
 *   captured at handoff        t ≈ 0s    exit 0
 *   re-run at acceptance       t > FLIP  exit 7
 *
 * That produces `check_exit_changed`, which is blocking, so the transaction rolls back for
 * `repository_diverged`. Nothing about it depends on either model behaving badly — a
 * rollback triggered by provoking a participant would be testing the participant, not the
 * transaction.
 *
 * The margin is generous because the only assumption is "a real model turn takes longer
 * than FLIP seconds", and every observed acceptance turn has taken 30-150s. If the flip
 * does not fire the test says so and fails as untriggered, rather than passing on a
 * rotation that simply succeeded.
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
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { defaultRegistry } from '../registry/builtin.ts'
import { Relay } from '../relay/relay.ts'
import type { RunOutcome } from '../relay/run.ts'

const skip =
  process.env.ORCH_LIVE_ROLLBACK === '1'
    ? false
    : 'set ORCH_LIVE_ROLLBACK=1 (spawns three real sessions, uses quota)'

/** Seconds after which the verification check starts failing. */
const FLIP = Number(process.env.ORCH_ROLLBACK_FLIP_SECONDS ?? 45)

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

  const flipAt = Math.floor(Date.now() / 1000) + FLIP
  // Deterministic, external to both participants, and honest about what it is: the exit
  // code is a function of the clock and nothing else.
  const CHECK = `sh -c 'test $(date +%s) -lt ${flipAt}'`

  const before = liveChildren().length

  const relay = await Relay.start({
    registry: defaultRegistry(),
    cwd: repo,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxRounds: 4,
    rotation: { checks: [CHECK], checkTimeoutMs: 120_000 },
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

  const result = await run.rotateImplementer('mechanism test: acceptance is rigged to fail')

  // The trigger has to have fired, or this proves nothing. A rotation that simply
  // succeeded is an untriggered test, not a passing one.
  assert.equal(
    result.status,
    'rolled_back',
    `acceptance was expected to fail on a clock-flipped check but the rotation ${result.status}. ` +
      `Raise ORCH_ROLLBACK_FLIP_SECONDS if the acceptance turn is finishing in under ${FLIP}s.`,
  )
  assert.equal(result.reason, 'repository_diverged', `rolled back for the wrong reason: ${result.detail}`)
  assert.match(result.detail, /exit(ed)? .*0.* at handoff/i)

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
})
