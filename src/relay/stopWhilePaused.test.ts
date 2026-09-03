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
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { Verdict } from '../contract/outcome.ts'
import type { AgentEvent, AgentSession, CloseMode } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { tempDir } from '../testkit/tempDir.ts'
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

function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-stop-paused')
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

/**
 * A session whose graceful close ENDS the turn that was open, the way a reconciling adapter does.
 *
 * `FakeRotationSession.close()` records the mode and terminates, and emits nothing -- which is the
 * right default, because it is also what every adapter does in the case #143 exists for. This is
 * the other case, and it has to be a session rather than a `setTimeout` in the test: the whole
 * question is whether the relay uses a verdict produced INSIDE `close('graceful')`, so the release
 * has to happen there and nowhere else.
 *
 * `ClaudeSession` is the shape being imitated: `#reconcileFromTranscript()` runs before the pty is
 * terminated, so the close is what establishes the verdict for a turn the transcript had not yet
 * shown as finished.
 */
class ReconcilingSession extends FakeRotationSession {
  /**
   * How long the reconcile takes, and it has to be LONGER than the relay's own poll cadence.
   *
   * Reading a transcript is file I/O and takes real time, so a close that establishes a verdict
   * does not do it instantaneously. That delay is also what gives this test teeth: a relay that
   * left its poll when it noticed the stop, rather than when the close returned, would be gone
   * before the verdict existed -- and with an instant reconcile it would still find one, because
   * the poll's own next tick would happen to arrive after the release. The number therefore has
   * to sit on the far side of that tick, or the test passes for the wrong reason.
   */
  reconcileMs = 500

  override async close(mode: CloseMode = 'graceful'): Promise<void> {
    if (mode === 'graceful' && this.holding) {
      await new Promise((r) => setTimeout(r, this.reconcileMs))
      this.releaseTurn()
    }
    await super.close(mode)
  }
}

/**
 * A session whose close produces the verdict immediately and whose STREAM is slow to hand it on.
 *
 * The other way the same report gets lost, and the one a grace period cannot cover. `close()`
 * returns promptly here -- the verdict exists the moment it is called -- but the event takes
 * `lagMs` to cross the relay's forwarding reader, which is where every real adapter's events also
 * travel. Any fixed grace is a bet on that crossing being quick, and this is the case that
 * collects on the bet.
 *
 * The lag is applied only once the close has begun, so the turn itself runs at normal speed and
 * nothing else in the run is slowed down to make the point.
 */
class LaggingSession extends FakeRotationSession {
  /** Comfortably past the poll cadence, so no tick can rescue a relay that guessed. */
  lagMs = 600
  #closing = false

  override events(): AsyncIterable<AgentEvent> {
    const base = super.events()[Symbol.asyncIterator]()
    const lag = (): Promise<void> => new Promise((r) => setTimeout(r, this.lagMs))
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          const step = await base.next()
          if (this.#closing) await lag()
          return step
        },
      }),
    }
  }

  override async close(mode: CloseMode = 'graceful'): Promise<void> {
    // Set BEFORE the release, so the reader that is already parked on this turn is the one that
    // gets slowed down. Setting it after would let the verdict through at full speed and leave
    // the test asserting nothing.
    this.#closing = true
    if (mode === 'graceful' && this.holding) this.releaseTurn()
    await super.close(mode)
  }
}

// ---------------------------------------------------------------------------------------
// The defect itself: a run stopped while a human is holding it.
// ---------------------------------------------------------------------------------------

test('a run stopped while paused ends, and says it was stopped', async (t) => {
  const dir = repo(t)
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
  const dir = repo(t)
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
  const dir = repo(t)
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

  // The LOOP is unblocked too, and that is #143. This turn is never released -- `releaseTurn()`
  // used to be called here purely so the file's process could exit, because the poll went on
  // waiting forever on a 250ms timer nothing unrefs. It is gone: the poll leaves when the session
  // it is waiting on has been closed, so there is nothing left holding the process open and
  // nothing to release. The fake's `close()` emits no `turn_end` under any circumstances, which
  // is the honest floor -- no adapter this project has GUARANTEES one either (see `Relay#closed`).
  assert.ok(impl.holding, 'the turn was never released; nothing but the close ended this run')

  // And the run says what it lost. This note is what a reader has instead of a report: the
  // routing log shows the instruction going out and nothing coming back, and without this they
  // cannot tell that from a seat that is still thinking. It was unreachable before #143 -- the
  // loop never unwound to write it, and on the exception path the re-raised turn had already been
  // taken off every list the note counts.
  const unfinished = relay.log.filter((m) => m.kind === 'note' && m.text.startsWith('the run ended with'))
  assert.equal(unfinished.length, 1, `exactly one unfinished-turn note:\n${relay.log.map((m) => m.text).join('\n')}`)
  assert.match(unfinished[0]!.text, /1 seat turn\(s\) unfinished: t-1\b/, 'and it names the task whose report was lost')
  assert.match(unfinished[0]!.text, /never reached the advisor/)
})

test('a turn_end that arrives during the graceful close is used, not discarded', async (t) => {
  // The other side of the line #143 draws, and the reason the poll does not leave on `#stopped`.
  //
  // `ClaudeSession.close('graceful')` reconciles from the transcript BEFORE it terminates the
  // pty, so a graceful close is often the thing that ESTABLISHES a verdict for the turn that was
  // open. A poll that left the instant it saw the stop flag would throw that verdict away -- and
  // losing a report is worse than the leak it was fixing, because the run can no longer account
  // for work that is sitting on disk.
  //
  // So the session here does what a reconciling adapter does: the held turn ends, with its
  // verdict, inside `close('graceful')`. The turn must complete normally -- report recorded,
  // nothing called lost -- even though the relay was already stopped when it arrived.
  const dir = repo(t)
  const impl = new ReconcilingSession('impl', 'claude', endlessly('Did step'))
  impl.holdTurn = 1
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', endlessly('Keep going')), impl)

  const run = relay.start('Keep the work moving.')
  for (let i = 0; i < 600 && !impl.holding; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(impl.holding, 'the child was sent work and has not been allowed to answer')

  await relay.stop()

  assert.equal(run.state, 'ended')
  assert.equal((await run.result()).reason, 'stopped', 'the run still ended because it was stopped')
  assert.equal(impl.closedAs, 'graceful')
  assert.equal(impl.holding, false, 'the close ended the turn rather than abandoning it')

  // The verdict was used: the turn came back, and its report is in the log as a report rather
  // than as an absence. `t-1` is the only task this run admitted.
  const reports = relay.log.filter((m) => m.kind === 'report' && m.from === 'implementer')
  assert.equal(reports.length, 1, `the report reached the log:\n${relay.log.map((m) => `${m.kind}: ${m.text}`).join('\n')}`)
  assert.equal(reports[0]!.text, 'Did step 2.', 'and it is the prose the turn actually produced')

  // And nothing calls it lost. A note naming `t-1` here would mean the relay had discarded a
  // verdict it was handed, which is the failure this half of the test exists to catch.
  const unfinished = relay.log.filter((m) => m.kind === 'note' && m.text.startsWith('the run ended with'))
  assert.deepEqual(unfinished.map((m) => m.text), [], 'no turn was unfinished: the one that was open ended')
})

test('a turn_end delivered long after the close returns is still used', async (t) => {
  // The same verdict, arriving by the slow road.
  //
  // `close('graceful')` produces it promptly here and then returns; what takes time is the RELAY's
  // own forwarding reader handing it on -- 600ms, comfortably past the poll's 250ms cadence. An
  // implementation that allowed the forwarder a fixed grace and then gave up would lose this
  // report, and would do it intermittently, which is the worst way to lose one.
  //
  // So the wait is a barrier rather than a duration: `stop()` fires the abandonment signal only
  // once the close has returned AND that reader has drained, which is a fact about the stream
  // instead of a bet on its speed. `AgentSession.events()` ending with the session is what makes
  // the barrier terminate, and is now stated in the contract.
  const dir = repo(t)
  const impl = new LaggingSession('impl', 'claude', endlessly('Did step'))
  impl.holdTurn = 1
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', endlessly('Keep going')), impl)

  const run = relay.start('Keep the work moving.')
  for (let i = 0; i < 600 && !impl.holding; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(impl.holding, 'the child was sent work and has not been allowed to answer')

  await relay.stop()

  assert.equal((await run.result()).reason, 'stopped')
  const reports = relay.log.filter((m) => m.kind === 'report' && m.from === 'implementer')
  assert.equal(reports.length, 1, `the report reached the log:\n${relay.log.map((m) => `${m.kind}: ${m.text}`).join('\n')}`)
  assert.equal(reports[0]!.text, 'Did step 2.', 'and it is the prose the turn actually produced')
  const unfinished = relay.log.filter((m) => m.kind === 'note' && m.text.startsWith('the run ended with'))
  assert.deepEqual(unfinished.map((m) => m.text), [], 'nothing was lost: the verdict merely took its time arriving')
})

test('a close that FAILS still hands on what it said before it failed (#143)', async (t) => {
  // The exceptional path, and the one an independent review found open. `stop()` awaited the
  // forwarder only when `close()` resolved; a close that rejected went straight to the `finally`
  // and fired the abandonment signal, so a `turn_end` already in flight across `#attach` was
  // thrown away by the teardown that provoked it. Discarding a verdict is worse than the leak
  // this change is about, which is what makes it the failure worth a test of its own.
  //
  // A real adapter reaches this shape easily: `close('graceful')` reconciles the transcript --
  // establishing and emitting the verdict -- and then terminates the pty, stops the receiver, or
  // drains stdin, any of which can reject after the useful work is done.
  //
  // The other half is in the adapters. Each closes its event queue in a `finally` now, so a
  // throwing close still ends the iteration; without that, draining here on the exceptional path
  // would have replaced a discarded verdict with a hang.
  const dir = repo(t)
  const impl = new LaggingSession('impl', 'claude', endlessly('Did step'))
  impl.holdTurn = 1
  impl.closeThrows = 'terminate: pty refused to die'
  const relay = await relayOf(dir, new FakeRotationSession('advisor', 'codex', endlessly('Keep going')), impl)

  const run = relay.start('Keep the work moving.')
  for (let i = 0; i < 600 && !impl.holding; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(impl.holding, 'the child was sent work and has not been allowed to answer')

  await assert.rejects(() => relay.stop(), /pty refused to die/, 'the close really did fail')

  // The verdict it produced on its way out is used, exactly as it is when the close succeeds.
  assert.equal((await run.result()).reason, 'stopped')
  const reports = relay.log.filter((m) => m.kind === 'report' && m.from === 'implementer')
  assert.equal(
    reports.length,
    1,
    `the report survived the failed close:\n${relay.log.map((m) => `${m.kind}: ${m.text}`).join('\n')}`,
  )
  assert.equal(reports[0]!.text, 'Did step 2.')
  const unfinished = relay.log.filter((m) => m.kind === 'note' && m.text.startsWith('the run ended with'))
  assert.deepEqual(unfinished.map((m) => m.text), [], 'nothing was abandoned: the verdict arrived')
})

test('a run that already ended keeps the reason it ended for', async (t) => {
  // Teardown is not a second outcome, and `stop()` is called on every finished run by whatever
  // owns the relay. A `done` run that reported `stopped` because someone cleaned up after it
  // would be the same class of untrue figure this issue is about, in the field readers read first.
  const dir = repo(t)
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
  const dir = repo(t)
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
