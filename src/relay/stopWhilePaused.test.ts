/**
 * Tearing a run down while a human is holding it (#142).
 *
 *   node --test src/relay/stopWhilePaused.test.ts
 *
 * `relay.stop()` ends the RUN -- it emits `run_end`, stops the clock and closes the sessions --
 * but the `RunHandle` is settled only by `#loop`'s completion callbacks, and during a pause the
 * loop is parked on the promise `pauseAt()` returned. Nothing resolved it, so nothing completed,
 * so nothing settled: `run.state` stayed `paused` forever, `result()` never resolved, and a
 * caller awaiting the end of a run it had just stopped waited for an event that could not come.
 *
 * #112 made that observable rather than merely untidy. The handle's suspension ledger now feeds
 * the duration ceiling and is REPORTED -- `runReport` publishes `pausedMs` and `activeMs` off the
 * relay, which reads them through the handle -- so a ledger left open on a stopped run reports a
 * suspension that is still running on a run that has ended. The figures were not just stale; they
 * moved, for as long as the object lived.
 *
 * ## What these drive, and why on an injected clock
 *
 * A real relay, with real halt sites, because the defect is in how `stop()` and `#halt` interleave
 * and a handle exercised directly cannot interleave with anything -- `pauseBudget.test.ts` says
 * as much where it tests `settle()` on its own and declines to claim it is testing `stop()`.
 *
 * `RelayOptions.now` moves the ceiling's clock and nothing else, so "the ledger closes where the
 * run stopped" can be an equality: every millisecond these runs experience is put there by the
 * test, and time advanced AFTER the stop is time a correct implementation must not count.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Verdict } from '../contract/outcome.ts'
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { runReport } from './report.ts'
import { Relay, type RelayOptions } from './relay.ts'
import { resolutionFor } from './resolution.ts'
import { RunHandle, type RunControl, type RunPause } from './run.ts'

/** A turn that came back with nothing to steer on, which is what a `turn_incomplete` halt is for. */
const TIMED_OUT: Verdict = {
  outcome: 'timed_out',
  confidence: 'uncertain',
  provenance: [{ source: 'orchestrator', detail: 'past the watchdog at 600s with no Stop' }],
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** A clock a test moves by hand. Starts somewhere plausible so a stray `Date.now()` is obvious. */
function clockFrom(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-stop-paused-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 42\n')
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

function registryOf(queues: Record<string, AgentSession[]>): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, sessions] of Object.entries(queues)) {
    const remaining = [...sessions]
    r.register({
      id: agent,
      displayName: agent,
      capabilities: {
        agent,
        readinessSignal: 'unknown',
        turnKeySource: 'prompt_id',
        outcomes: {
          completed: 'observed',
          cancelled: 'reasoned_but_unverified',
          permission_refused: 'reasoned_but_unverified',
          process_exited: 'reasoned_but_unverified',
          timed_out: 'reasoned_but_unverified',
          transport_lost: 'reasoned_but_unverified',
          unknown_abnormal_end: 'reasoned_but_unverified',
        },
      },
      deadlines: NO_DEADLINE_CLOCKS,
      launch: { command: agent, baseArgs: [] },
      async create() {
        const next = remaining.shift()
        if (!next) throw new Error(`no session left for ${agent}`)
        return next
      },
    })
  }
  return r
}

async function relayOf(
  cwd: string,
  advisor: FakeRotationSession,
  impl: FakeRotationSession,
  over: Partial<RelayOptions> = {},
): Promise<Relay> {
  return Relay.start({
    registry: registryOf({ codex: [advisor], claude: [impl] }),
    cwd,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 6,
    ...over,
  })
}

/** Enough scripted turns that nothing but the test ends these runs. */
function endlessly(prefix: string): string[] {
  return Array.from({ length: 40 }, (_, i) => `${prefix} ${i + 1}.`)
}

// ---------------------------------------------------------------------------------------
// The defect itself: a run stopped while a human is holding it.
// ---------------------------------------------------------------------------------------

test('a run stopped while paused ends, and says it was stopped', async (t) => {
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const relay = await relayOf(
    dir,
    new FakeRotationSession('advisor', 'codex', endlessly('Keep going')),
    new FakeRotationSession('impl', 'claude', endlessly('Did step')),
  )

  const run = relay.start('Keep the work moving.')
  const pause = await run.requestPause('the operator stepped away')
  assert.ok(pause, 'the run is parked in front of an operator')
  assert.equal(run.state, 'paused')

  await relay.stop()

  assert.equal(run.state, 'ended', 'stopping the relay ends the run it was holding')
  assert.equal(run.pause, undefined, 'and there is no longer a decision in front of anyone')
  // The whole point: this promise is what a supervising caller awaits, and before #142 it never
  // settled. A rejection would be a different failure and is not caught here on purpose.
  const outcome = await run.result()
  assert.equal(outcome.reason, 'stopped')
})

test('the suspension ledger closes where the run stopped, not where the object dies', async (t) => {
  // The reported figures have to be TRUE after `stop()`, not merely present. A ledger left open
  // keeps accruing against a run that ended, so `pausedMs` grows and `activeMs` -- which is
  // wall-clock less the paused total -- shrinks, on a run nothing is doing anything to.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const clock = clockFrom()
  const impl = new FakeRotationSession('impl', 'claude', endlessly('Did step'))
  /** A minute of work per working turn, so active time is a number the test chose. */
  impl.onSend = () => {
    if (impl.received.length - 1 === 0) return
    clock.advance(MINUTE)
  }
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', endlessly('Keep going')), impl, {
    now: clock.now,
  })

  const run = relay.start('Keep the work moving.')
  assert.ok(await run.requestPause('the operator stepped away'))
  const activeAtPause = relay.activeMs
  clock.advance(20 * MINUTE)
  assert.equal(relay.pausedMs, 20 * MINUTE, 'the unanswered pause is time already spent waiting')

  await relay.stop()
  const pausedAtStop = relay.pausedMs
  const activeAtStop = relay.activeMs
  assert.equal(pausedAtStop, 20 * MINUTE, 'the ledger closed at the stop, having counted the whole pause')
  assert.equal(activeAtStop, activeAtPause, 'and a suspended run accrued no active time while it waited')

  // A report is not assembled at the instant a run ends: teardown happens, snapshots are awaited,
  // and a front end may write the document later still. Every one of those is time after the stop.
  clock.advance(HOUR)
  assert.equal(relay.pausedMs, pausedAtStop, 'no suspension is still running on a run that ended')
  assert.equal(relay.activeMs, activeAtStop, "and the ceiling's own reading does not move either")
  // On the HANDLE too, and this is the assertion with teeth. `#end` calls `#stopClock`, which
  // snapshots the relay's two figures the instant the run ends -- so the pair above would sit
  // still even with the ledger underneath them running away, and the untruth would surface only
  // to a reader holding the handle. `suspendedMs` is where #112 keeps the figure and where the
  // ceiling reads it from, so it is what has to stop.
  assert.equal(run.suspendedMs, 20 * MINUTE, 'the ledger itself closed, not just the copy taken off it')

  const report = await runReport(relay, {
    goal: 'Keep the work moving.',
    outcome: await run.result(),
    startedAt: clock.now() - HOUR,
    build: 'test',
  })
  assert.equal(report.pausedMs, pausedAtStop)
  assert.equal(report.activeMs, activeAtStop)
  assert.equal(report.outcome.reason, 'stopped')
})

// ---------------------------------------------------------------------------------------
// What must not change.
// ---------------------------------------------------------------------------------------

test('a run stopped mid-turn ends too, and is not reported as the fault its teardown caused', async (t) => {
  // The other half of the same hole, and the reason this fix is at `stop()` rather than at the
  // pause. Measured before anything was changed, because "unchanged" is a claim about what was
  // there rather than about what one would expect:
  //
  //   - stopped with a turn genuinely in flight, `#exchange` was polling for a `turn_end` from a
  //     session `stop()` had just closed. It never arrived. `run.state` stayed `running`,
  //     `result()` never settled. Same defect as the paused case, different await.
  //   - stopped in the window where the loop was between sends, the send threw and `#loop`'s
  //     catch settled the handle `transport_failed: cannot send to a session in state
  //     'terminated'`. That one did settle, and settled UNTRUE: the stream said `run_end:
  //     stopped`, the handle said the transport had failed, and the fault it named was the
  //     operator's own teardown, reported back to them as though the CLI had dropped.
  //
  // Both now end as `stopped`, which is what `run_end` said all along. That is a deliberate
  // change to the second case rather than a side effect: a handle and a stream describing one
  // run must not disagree about how it ended.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const impl = new FakeRotationSession('impl', 'claude', endlessly('Did step'))
  // Withholds `turn_end` on the implementer's first working turn: a long real turn, held open by
  // the test rather than by a timer, so the stop below lands mid-turn every time.
  impl.holdTurn = 1
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', endlessly('Keep going')), impl)

  const run = relay.start('Keep the work moving.')
  for (let i = 0; i < 600 && !impl.holding; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(impl.holding, 'the child was sent work and has not been allowed to answer')
  assert.equal(run.state, 'running', 'nothing is in front of an operator; this is the mid-turn case')

  await relay.stop()

  assert.equal(run.state, 'ended')
  assert.equal((await run.result()).reason, 'stopped')

  // The caller is unblocked, which is what this fixes. The LOOP is not: `#exchange` has no
  // timeout of its own by design -- the adapter's watchdog owns that clock -- so it is still
  // polling every 250ms for a `turn_end` from a session that has been closed, on a timer nothing
  // unrefs. Released here so this file's process can exit, and named rather than hidden: an
  // orphaned poll surviving `stop()` is a different defect from this one, which is about the
  // handle -- and this fix does not depend on the loop unwinding, which is why it is not blocked
  // on it. Filed as #143.
  impl.releaseTurn()
})

test('a run that already ended keeps the reason it ended for', async (t) => {
  // Teardown is not a second outcome, and `stop()` is called on every finished run by whatever
  // owns the relay. A `done` run that reported `stopped` because someone cleaned up after it
  // would be the same class of untrue figure this issue is about, in the field readers read first.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const relay = await relayOf(
    dir,
    new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE']),
    new FakeRotationSession('impl', 'claude', ['ack', 'Did it.']),
  )

  const run = relay.start('Do the one thing.')
  const ended = await run.result()
  assert.equal(ended.reason, 'done')

  await relay.stop()
  assert.equal(run.state, 'ended')
  assert.equal((await run.result()).reason, 'done', "the first terminal outcome is the run's outcome")
})

// ---------------------------------------------------------------------------------------
// Ended is terminal. `settle()` unblocks the loop; it does not stop it, so the halt site the
// loop walks into next must not be able to undo the ending.
// ---------------------------------------------------------------------------------------

test('a halt reached after the run was stopped raises no pause, and cannot restart the ledger', async (t) => {
  // The race the fix has to survive, driven rather than argued.
  //
  // `stop()` settles the handle, but nothing stops the LOOP: it is unblocked, not cancelled, and
  // it carries on to whichever halt site was next. Here that is arranged exactly -- the turn is
  // held open, the relay is stopped while it is held, and only then is the turn released with a
  // `timed_out` verdict, which is the one thing that sends `#halt` to raise a `turn_incomplete`
  // pause. So the halt runs, deterministically, on a handle whose run is already over.
  //
  // Left unguarded that call flipped `state` back to `paused` on an ended run, reopened the
  // suspension ledger `settle()` had just closed, and parked on a question nothing would ever
  // answer -- every symptom of this issue restored one halt site later, with #112's figures
  // untrue again beside them.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const clock = clockFrom()
  const impl = new FakeRotationSession('impl', 'claude', endlessly('Did step'))
  impl.holdTurn = 1
  impl.endTurn = { index: 1, verdict: TIMED_OUT }
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', endlessly('Keep going')), impl, {
    now: clock.now,
  })

  const run = relay.start('Keep the work moving.')
  for (let i = 0; i < 600 && !impl.holding; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(impl.holding, 'the turn is open and the loop is inside it')

  await relay.stop()
  assert.equal(run.state, 'ended')
  const notesAtStop = relay.log.filter((m) => m.kind === 'note').length

  // NOW the halt site is reached, on an ended run.
  impl.releaseTurn()
  await new Promise((r) => setTimeout(r, 300))
  clock.advance(HOUR)

  assert.equal(run.state, 'ended', 'a late halt does not resurrect an ended run')
  assert.equal(run.pause, undefined, 'and raises no pause for a decision nobody can take')
  assert.equal(run.suspendedMs, 0, 'the ledger never reopened: this run was never suspended at all')
  assert.equal(relay.pausedMs, 0)
  assert.equal((await run.result()).reason, 'stopped', 'and the outcome it was settled with stands')
  // The routing log must not claim a decision point that never existed. A `paused (...)` note is
  // the log's account of a moment a human was at, and a reader reconstructing the run afterwards
  // would find one with no pause under it and no answer after it.
  const notes = relay.log.filter((m) => m.kind === 'note').map((m) => m.text)
  assert.ok(
    !notes.slice(notesAtStop).some((n) => n.startsWith('paused (')),
    `no pause was announced after the stop:\n${notes.slice(notesAtStop).join('\n')}`,
  )
})

/** A control surface that does nothing, for a handle driven directly. */
function inertControl(): RunControl {
  return {
    rotate: async () => {
      throw new Error('not used')
    },
    rotationTarget: () => undefined,
    constrain: () => {
      throw new Error('not used')
    },
    requestStop: () => {},
    requestPause: () => {},
  }
}

function pauseShape(): Omit<RunPause, 'at'> {
  return {
    reason: 'turn_incomplete',
    resolution: resolutionFor({ reason: 'turn_incomplete', participant: 'implementer' }, { rotationArmed: false }),
    detail: 'implementer turn ended timed_out (uncertain)',
    evidence: [],
    options: ['continue', 'abort'],
    atSeq: 1,
  }
}

test('pauseAt on an ended handle installs nothing, tells nobody, and starts no clock', async () => {
  // The invariant on its own, because the relay test above proves it through one halt site and
  // this is a property of the handle at every one of them -- including sites this file does not
  // reach and halt sites not yet written. Each assertion is a separate way the old behaviour
  // showed itself: the state, the pause a poller would read, the ledger the ceiling reads, and
  // the watcher that was already told the run had ended.
  const clock = clockFrom()
  const handle = new RunHandle(inertControl(), { now: clock.now })
  handle.settle({ reason: 'stopped' })

  const deciding = handle.pauseAt(pauseShape())
  assert.equal(await deciding, undefined, 'no decision, because there is nobody left to take one')
  assert.equal(handle.state, 'ended')
  assert.equal(handle.pause, undefined)
  clock.advance(HOUR)
  assert.equal(handle.suspendedMs, 0, 'an ended run accrues no suspension')
  assert.equal((await handle.result()).reason, 'stopped')
  // What an observer arriving after all of it is told. `untilPause()` answers from the handle's
  // own state, so a resurrected pause would be handed straight to it -- a supervisor that had
  // already been told the run ended, being offered a decision about it a moment later.
  assert.equal(await handle.untilPause(), undefined, 'a later watcher is told the run ended, not shown a pause')
})
