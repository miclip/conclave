/**
 * What a permission prompt costs a run, and what the record says about it (#315).
 *
 *   node --test src/relay/permissionBudget.test.ts
 *
 * The reported run: `--max-minutes 45`, `--operator agent`, and the advisor's first Bash call
 * needing a permission decision that the operator did not answer for 29 minutes. The only pause
 * lasted 21 seconds, so `activeMs` crossed the ceiling with the implementer fifteen minutes into
 * a turn that was going fine, and the run was due to end `budget` the moment it reported. The
 * ceiling was enforced correctly on the wrong number: #112 stopped charging a pause to the run
 * because "the clock it was on was measuring the operator", and a prompt is the same wait --
 * the seat is blocked, dispatches nothing, and a human or an agent is being waited on -- but
 * `RunHandle` only ever opened a suspension for a pause.
 *
 * The second half: `status --json` showed the prompt live and nothing in the routing log said it
 * had ever happened. The `you allowed advisor: Bash` note was there; the 29-minute question it
 * answered was not.
 *
 * Driven on an injected clock like `pauseBudget.test.ts`, and for the same reason: every
 * millisecond these runs experience is put there by the test, so the paused and active totals
 * are equalities known before the run starts. An inequality would pass on a run that stopped for
 * the wrong reason.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { tempDir } from '../testkit/tempDir.ts'
import { readSession, recordSession } from '../workspace/sessionRecord.ts'
import { runReport } from './report.ts'
import { permissionHold, Relay, type RelayOptions } from './relay.ts'
import { resolutionFor } from './resolution.ts'
import { PAUSE_HOLD, RunHandle, type RunControl, type RunPause } from './run.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** A clock a test moves by hand. See `pauseBudget.test.ts` for why it starts where it does. */
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
  const dir = tempDir(t, 'conclave-permission-budget')
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
    maxAdvisorTurns: 4,
    ...over,
  })
}

/**
 * The same relay with a replacement queued behind the first implementer, so a rotation has a
 * session to swap in. Mirrors `rotation.test.ts`; the checks are `exit 0` because what is under
 * test here is the ledger, not the audition.
 */
async function rotatableRelayOf(
  cwd: string,
  advisor: FakeRotationSession,
  impls: FakeRotationSession[],
  over: Partial<RelayOptions> = {},
): Promise<Relay> {
  return Relay.start({
    registry: registryOf({ codex: [advisor], claude: impls }),
    cwd,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 5,
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000, onDegradation: 'candidate' },
    ...over,
  })
}

/** The handoff and acceptance a rotation audition is scripted with. As in `rotation.test.ts`. */
const HANDOFF = `## BRIEF
Keep the work moving.

## STATE
Half done.

## DECISIONS
- none

## EVIDENCE
The implementer says the check passes.

## FILES
- work.ts

## DISAGREEMENT
- none

## NEXT
Carry on.`
const ACCEPTED = 'CHECK 1: exit 0\n\nRead work.ts and ran the check. It matches.'

/** Enough scripted turns that only a ceiling can end the run. */
function endlessly(prefix: string): string[] {
  return Array.from({ length: 60 }, (_, i) => `${prefix} ${i + 1}.`)
}

/** Wait for the relay's event pump to have seen what the session just emitted. */
async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 600 && !pred(); i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(pred(), what)
}

/**
 * A seat's turn, held open at a permission prompt. The turn STARTS normally (`holdTurn`), the
 * prompt is what the adapters emit from their `PermissionRequest` hook, and the turn ends only
 * when the test releases it -- which is exactly the state a seat waiting on `/allow` is in.
 */
function prompt(seat: FakeRotationSession, tool: string, input: unknown, seq: number): void {
  seat.emit({ type: 'permission_requested', tool, input, seq, at: Date.now(), provisional: false })
}

/** Drive a run to its end, continuing through every pause without holding it. */
async function finish(run: ReturnType<Relay['start']>): Promise<{ reason: string; detail: string }> {
  for (;;) {
    const s = await run.settled()
    if (s.kind === 'ended') return { reason: s.outcome.reason, detail: s.outcome.detail ?? '' }
    await run.continue()
  }
}

// ---------------------------------------------------------------------------------------
// The ledger, driven directly: one interval, several reasons.
// ---------------------------------------------------------------------------------------

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
    armCheckpoint: () => undefined,
    checkpointContinued: () => {},
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

test('a permission hold is on the ledger while it is open and closes when released', () => {
  const clock = clockFrom()
  const handle = new RunHandle(inertControl(), { now: clock.now })
  handle.hold(permissionHold('advisor'))
  clock.advance(29 * MINUTE)
  assert.equal(handle.suspendedMs, 29 * MINUTE, 'an unanswered prompt is time already spent waiting')
  handle.releaseHold(permissionHold('advisor'))
  clock.advance(HOUR)
  assert.equal(handle.suspendedMs, 29 * MINUTE, 'and the answer closes the interval')
  // A release for a hold that was never opened is nothing, not an interval closed twice.
  handle.releaseHold(permissionHold('implementer'))
  assert.equal(handle.suspendedMs, 29 * MINUTE)
})

test('overlapping reasons are one interval, opened by the first and closed by the last', async () => {
  // A pause raised while a seat is at a prompt, answered while the prompt is still up. Charged
  // once: a flag closed by whichever reason ended first would charge the remainder to the run as
  // if it were working, and two ledgers would count the overlap twice.
  const clock = clockFrom()
  const handle = new RunHandle(inertControl(), { now: clock.now })
  handle.hold(permissionHold('advisor'))
  clock.advance(5 * MINUTE)
  const deciding = handle.pauseAt(pauseShape())
  clock.advance(10 * MINUTE)
  await handle.continue()
  await deciding
  assert.equal(handle.suspendedMs, 15 * MINUTE, 'the pause ending does not end the prompt')
  clock.advance(10 * MINUTE)
  assert.equal(handle.suspendedMs, 25 * MINUTE, 'the prompt is still holding the run')
  handle.releaseHold(permissionHold('advisor'))
  clock.advance(HOUR)
  assert.equal(handle.suspendedMs, 25 * MINUTE, 'one interval, 25 minutes, and closed')

  // The other order: a prompt raised during a pause, outliving it.
  const again = handle.pauseAt(pauseShape())
  clock.advance(MINUTE)
  handle.hold(permissionHold('implementer'))
  clock.advance(MINUTE)
  await handle.continue()
  await again
  clock.advance(MINUTE)
  handle.releaseHold(permissionHold('implementer'))
  clock.advance(HOUR)
  assert.equal(handle.suspendedMs, 28 * MINUTE)

  // And two seats at prompts at once: the second one's answer does not end the first one's wait.
  handle.hold(permissionHold('advisor'))
  handle.hold(permissionHold('implementer'))
  clock.advance(MINUTE)
  handle.releaseHold(permissionHold('implementer'))
  clock.advance(MINUTE)
  assert.equal(handle.suspendedMs, 30 * MINUTE)
  handle.releaseHold(permissionHold('advisor'))
  assert.equal(handle.suspendedMs, 30 * MINUTE)
})

test('a run settled with a prompt still up stops the ledger where the run stopped', () => {
  // The fourth exit, for prompts as for pauses (#112): a `stop()` while a seat is at a prompt
  // must not leave a hold open for the life of the object. And a prompt raised AFTER the ending
  // -- a reader still draining -- opens nothing (#142).
  const clock = clockFrom()
  const handle = new RunHandle(inertControl(), { now: clock.now })
  handle.hold(permissionHold('advisor'))
  clock.advance(20 * MINUTE)
  handle.settle({ reason: 'stopped' })
  clock.advance(HOUR)
  assert.equal(handle.suspendedMs, 20 * MINUTE)
  handle.hold(permissionHold('advisor'))
  clock.advance(HOUR)
  assert.equal(handle.suspendedMs, 20 * MINUTE, 'a hold on an ended run is a no-op')
})

test('the pause hold is the one the pause path uses', async () => {
  // Pins the name, so a test elsewhere that releases `PAUSE_HOLD` is releasing what `pauseAt`
  // opened and not a constant that drifted away from it.
  const clock = clockFrom()
  const handle = new RunHandle(inertControl(), { now: clock.now })
  const deciding = handle.pauseAt(pauseShape())
  clock.advance(MINUTE)
  handle.releaseHold(PAUSE_HOLD)
  clock.advance(MINUTE)
  assert.equal(handle.suspendedMs, MINUTE)
  await handle.continue()
  await deciding
})

// ---------------------------------------------------------------------------------------
// A real relay on an injected clock: the reported run, and the ceiling still firing.
// ---------------------------------------------------------------------------------------

test('a run kept waiting at a permission prompt is not ended by the budget it did not spend', async (t) => {
  // The reported shape. The implementer's first working turn stops at a Bash prompt for 29
  // minutes, under a ten-minute ceiling, and the run must still do all of its work and end on it.
  const dir = repo(t)
  const clock = clockFrom()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Keep going.', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', endlessly('Did step'))
  let worked = 0
  impl.onSend = () => {
    if (impl.received.length - 1 === 0) return
    worked += 1
    clock.advance(MINUTE)
  }
  impl.holdTurn = 1
  const relay = await relayOf(dir, advisor, impl, {
    now: clock.now,
    maxAdvisorTurns: 8,
    ceilings: { maxDurationMs: 10 * MINUTE },
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  await until(() => impl.holding, 'the implementer was sent work and is holding its turn')
  prompt(impl, 'Bash', { command: 'git status' }, 900)
  await until(() => relay.permissionsPending().length === 1, 'the relay has seen the prompt')

  // 29 minutes with the seat at the prompt: nothing dispatched, nothing spent.
  clock.advance(29 * MINUTE)
  assert.equal(relay.pausedMs, 29 * MINUTE, 'an unanswered prompt is already on the paused total')
  assert.equal(relay.activeMs, worked * MINUTE, 'and off the active one')
  assert.equal(run.state, 'running', 'a prompt is not a pause: nothing is in front of the operator as a pause')

  await relay.decidePermission('implementer', 'allow')
  clock.advance(2 * MINUTE)
  impl.releaseTurn()
  const { reason, detail } = await finish(run)
  assert.equal(reason, 'done', `a run kept waiting must end on its work, not on a ceiling it never spent: ${detail}`)

  const report = await runReport(relay, {
    goal: 'Keep the work moving.',
    outcome: { reason: 'done' },
    startedAt: Date.now() - 1,
    build: 'test',
  })
  assert.equal(report.pausedMs, 29 * MINUTE, '29 minutes were spent at the prompt, exactly')
  assert.equal(report.activeMs, worked * MINUTE + 2 * MINUTE, 'and the rest was spent working, exactly')
  assert.ok(report.activeMs < 10 * MINUTE, `the work must fit inside the ceiling: ${report.activeMs}ms`)
  assert.ok(
    report.activeMs + report.pausedMs > 10 * MINUTE,
    'and wall-clock must not: this run would have been ended by the old reading',
  )
})

test('the ceiling still fires on a run that prompts, and quotes active time only', async (t) => {
  // The constraint #112 had to hold, held again: nothing here exempts a run that works too
  // long. The prompt is answered after an hour; the work after it is twelve minutes under a
  // ten-minute ceiling; the ceiling fires at the next boundary and the figure it quotes is the
  // active reading, without the hour.
  const dir = repo(t)
  const clock = clockFrom()
  const advisor = new FakeRotationSession('advisor', 'codex', endlessly('Keep going'))
  const impl = new FakeRotationSession('impl', 'claude', endlessly('Did step'))
  impl.onSend = () => {
    if (impl.received.length - 1 === 0) return
    clock.advance(4 * MINUTE)
  }
  impl.holdTurn = 1
  const relay = await relayOf(dir, advisor, impl, {
    now: clock.now,
    maxAdvisorTurns: 50,
    ceilings: { maxDurationMs: 10 * MINUTE },
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  await until(() => impl.holding, 'the implementer is holding its turn')
  prompt(impl, 'Bash', { command: 'npm test' }, 901)
  await until(() => relay.permissionsPending().length === 1, 'the relay has seen the prompt')
  clock.advance(HOUR)
  await relay.decidePermission('implementer', 'allow')
  impl.releaseTurn()

  const { reason, detail } = await finish(run)
  assert.equal(reason, 'ceiling', `a run that works past the ceiling must still be stopped: ${detail}`)
  assert.match(detail, /time ceiling reached/)
  assert.equal(relay.pausedMs, HOUR, 'the hour at the prompt was deducted')
  // Three four-minute turns: the first two fit, the third crosses. The quoted figure is the
  // active reading and nothing else -- an hour of prompt would read as 72 minutes on wall-clock.
  assert.equal(relay.activeMs, 12 * MINUTE, 'and the ceiling compared twelve minutes of work')
  const quoted = /(\d+)s of active run time/.exec(detail)
  assert.ok(quoted, `the ending must quote its reading: ${detail}`)
  assert.equal(Number(quoted[1]) * 1000, relay.activeMs)
})

test('a prompt answered in the child rather than here is released by the turn ending', async (t) => {
  // `turn_end` is the honest boundary for the request (see `#trackPermission`), so it is the
  // boundary for the hold too. Left open past it, a prompt answered at the child's own terminal
  // would deduct the rest of the run from the ceiling.
  const dir = repo(t)
  const clock = clockFrom()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Keep going.', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', endlessly('Did step'))
  impl.holdTurn = 1
  const relay = await relayOf(dir, advisor, impl, { now: clock.now, maxAdvisorTurns: 8 })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  await until(() => impl.holding, 'the implementer is holding its turn')
  prompt(impl, 'Bash', { command: 'ls' }, 902)
  await until(() => relay.permissionsPending().length === 1, 'the relay has seen the prompt')
  clock.advance(3 * MINUTE)
  impl.releaseTurn()
  await until(() => relay.permissionsPending().length === 0, 'the turn ending cleared the request')
  clock.advance(HOUR)
  assert.equal(relay.pausedMs, 3 * MINUTE, 'the hold ended with the turn, not with the run')
  const { reason } = await finish(run)
  assert.equal(reason, 'done')
})

test('a prompt the retired session was standing at leaves with it when the seat is rotated', async (t) => {
  // The third exit from a prompt, after the answer and the turn ending: the session is rotated
  // out from under it. The retired child never sends a `turn_end` -- it is gone -- and the
  // replacement's first `turn_end` would release a hold that is not its own only by the
  // accident of sharing the seat id. So the rotation path releases it explicitly, and this
  // pins that line by holding the replacement's first turn open: with nothing else able to
  // close the interval, `pausedMs` growing after `/continue` is the retired seat's prompt
  // still charged to a run that is working.
  const dir = repo(t)
  const clock = clockFrom()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do the first thing.', HANDOFF, 'Do the second thing.', 'DONE'])
  const old = new FakeRotationSession('old', 'claude', ['ack', 'Did the first thing.'])
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'Second.', 'NONE'])
  old.compactOnTurn = 1
  // Index 0 is the audition; 1 is the first turn of real work after promotion.
  fresh.holdTurn = 1
  const relay = await rotatableRelayOf(dir, advisor, [old, fresh], { now: clock.now })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const settled = await run.settled()
  assert.ok(settled.kind === 'paused' && settled.pause.reason === 'rotation_candidate', 'the compaction raised a candidate')

  // A late `PermissionRequest` from the child about to be retired, arriving while the run is
  // paused about it. Two reasons now hold the run: the pause, and this seat's prompt.
  prompt(old, 'Bash', { command: 'git stash' }, 905)
  await until(() => relay.permissionsPending().length === 1, 'the relay has seen the prompt')
  clock.advance(5 * MINUTE)
  assert.equal(relay.pausedMs, 5 * MINUTE, 'one interval for both reasons')

  assert.equal((await run.rotateImplementer()).status, 'rotated')
  assert.deepEqual(relay.permissionsPending(), [], 'the prompt went with the session that was standing at it')
  await run.continue()
  await until(() => fresh.holding, 'the replacement was sent work and is holding its turn')

  // Working, with no prompt up and no pause: this must be the run's own time.
  clock.advance(10 * MINUTE)
  assert.equal(relay.pausedMs, 5 * MINUTE, 'the retired seat\'s prompt is not still holding the clock')

  fresh.releaseTurn()
  const { reason, detail } = await finish(run)
  assert.equal(reason, 'done', detail)
  assert.equal(relay.pausedMs, 5 * MINUTE)
})

// ---------------------------------------------------------------------------------------
// The record: the question, before the answer.
// ---------------------------------------------------------------------------------------

test('the request is in the routing log before the decision, with seat, tool, command and time', async (t) => {
  const dir = repo(t)
  const clock = clockFrom()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', endlessly('Did step'))
  impl.holdTurn = 1
  const relay = await relayOf(dir, advisor, impl, { now: clock.now, maxAdvisorTurns: 8 })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  await until(() => impl.holding, 'the implementer is holding its turn')
  const before = Date.now()
  prompt(impl, 'Bash', { command: '  git   log --oneline -5  ' }, 903)
  await until(() => relay.permissionsPending().length === 1, 'the relay has seen the prompt')
  await relay.decidePermission('implementer', 'allow')
  impl.releaseTurn()
  await finish(run)

  const notes = relay.log.filter((m) => m.kind === 'note')
  const asked = notes.findIndex((m) => m.text.includes('requested permission'))
  const answered = notes.findIndex((m) => m.text.includes('you allowed implementer'))
  assert.ok(asked >= 0, `the request is recorded:\n${notes.map((m) => m.text).join('\n')}`)
  assert.ok(answered >= 0, 'and so is the answer')
  assert.ok(asked < answered, 'the question comes before the answer')
  const request = notes[asked]!
  // Seat, tool, and the command with its whitespace collapsed -- `permissionDetail`, the same
  // summary the console prints, so the record and the screen describe one prompt the same way.
  assert.equal(request.text, 'implementer requested permission for Bash: git log --oneline -5')
  assert.equal(request.visibility, 'internal', 'orchestrator state, never presented as speech')
  assert.deepEqual(request.to, [], 'delivered to nobody; it is for the record')
  assert.ok(request.at >= before && request.at <= Date.now(), `stamped when it was raised: ${request.at}`)
  // Answer note unchanged: the one existing reader of it (`relay.test.ts`) keeps matching.
  assert.equal(notes[answered]!.text, 'you allowed implementer: Bash')
})

// ---------------------------------------------------------------------------------------
// A bypassed seat's request is not a prompt (#320).
// ---------------------------------------------------------------------------------------

test('a bypassed seat that emits permission_requested keeps the clock running and is not blocked', async (t) => {
  // A bypassed child can still fire its `PermissionRequest` hook (#177). Nothing is waiting: the
  // harness answered before anyone could be asked. So the relay must not read it as a seat at a
  // dialog -- which is what made `status` say the run was blocked, and what would have deducted
  // the seat's working time from `--max-minutes` once #315 charged prompts to the clock.
  const dir = repo(t)
  const clock = clockFrom()
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', endlessly('Did step'))
  impl.holdTurn = 1
  const relay = await relayOf(dir, advisor, impl, {
    now: clock.now,
    maxAdvisorTurns: 8,
    bypassed: ['implementer'],
  })
  t.after(() => relay.stop())
  // The status document, as `conclave status --json` would read it: `blocked` is DERIVED there
  // from `participants[].awaitingPermission`, so the roll-up is asserted off the same document.
  const recording = recordSession(relay, {
    repoRoot: dir,
    id: 'bypass',
    goal: 'Keep the work moving.',
    front: 'session',
    startedAt: Date.now(),
    build: 'test',
  })
  t.after(() => recording.close())

  const run = relay.start('Keep the work moving.')
  await until(() => impl.holding, 'the implementer is holding its turn')
  prompt(impl, 'Bash', { command: 'npm test' }, 904)
  // The event reached the recorder: it is the seat's latest activity. That is what makes the
  // absences below assertions rather than a status that was never refreshed.
  await until(
    () => readSession(dir, 'bypass')?.status.participants.find((p) => p.id === 'implementer')?.activity?.kind === 'permission_requested',
    'the status document has seen the event',
  )
  const status = readSession(dir, 'bypass')!.status
  const seat = status.participants.find((p) => p.id === 'implementer')!
  assert.equal(seat.awaitingPermission, undefined, 'a bypassed seat is not awaiting anything')
  assert.equal(status.blocked, undefined, 'and the run is not blocked')
  assert.deepEqual(relay.permissionsPending(), [], 'nothing to /allow')

  // The clock keeps counting: the seat is working through this whole interval.
  clock.advance(29 * MINUTE)
  assert.equal(relay.pausedMs, 0, 'nothing was deducted')
  assert.equal(relay.activeMs, 29 * MINUTE, 'the 29 minutes are the run\'s own')

  // Still on the record, as what it was: the permission path was reached and auto-allowed.
  const noted = relay.log.filter((m) => m.kind === 'note' && m.text.includes('permission'))
  assert.deepEqual(
    noted.map((m) => m.text),
    ['implementer permission auto-allowed (bypass) for Bash: npm test'],
    'one note, saying what happened, and no request note asking for a decision',
  )

  impl.releaseTurn()
  const { reason } = await finish(run)
  assert.equal(reason, 'done')
})
