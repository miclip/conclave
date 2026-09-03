/**
 * A `turn_incomplete` the operator has already answered is not put again (#107).
 *
 *   node --test src/relay/turnIncompleteLatch.test.ts
 *
 * The reported run raised fifteen pauses and none of them needed judgment. Nine were this
 * condition: a watchdog firing on one long piece of work, the same seat, the same
 * `timed_out (uncertain)`, the same liveness line saying the child was busy, and the same
 * answer every time. Nothing in the relay remembered that it had asked. `#verdictPause` looks
 * like the place that would live and is not — it matches a later revision to a live pause and is
 * cleared the moment the pause resolves.
 *
 * ## What these drive, and what they refuse to
 *
 * A real `Relay`, through `Relay.start()` and the run handle an operator holds. The suppression
 * lives inside `#halt`, between the liveness measurement and `pauseAt`, and it is reachable no
 * other way: a unit test of the latch would assert that a `Set` remembers what was put in it,
 * which is true of every `Set` and says nothing about whether the run stops asking.
 *
 * The seam that makes this writable is `RelayOptions.liveness`. An in-memory session has no child
 * process, so an injected sampler is the only way to make the reading CHANGE between one pause
 * and the next — which is the whole of the tension this fix has to hold. Silence is for the case
 * where the answer would genuinely be the same; a child that has gone quiet or died is new
 * information, and a run that swallows THAT is worse than the one that asked nine times.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { Verdict } from '../contract/outcome.ts'
import type { AgentSession } from '../contract/session.ts'
import type { ChildLiveness } from '../outcomes/liveness.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { tempDir } from '../testkit/tempDir.ts'
import { Relay, type RelayOptions } from './relay.ts'
import type { RunPause } from './run.ts'

/** The verdict the reported run saw nine times. */
const TIMED_OUT: Verdict = {
  outcome: 'timed_out',
  confidence: 'uncertain',
  provenance: [{ source: 'orchestrator', detail: 'past the watchdog at 2700s with no Stop' }],
}

/** A different question with the same shape: the turn did not end, for another reason entirely. */
const TRANSPORT_LOST: Verdict = {
  outcome: 'transport_lost',
  confidence: 'uncertain',
  provenance: [{ source: 'orchestrator', detail: 'the pty stopped answering' }],
}

/** The same outcome as TIMED_OUT, for a different reason. The outcome alone cannot tell them apart. */
const TIMED_OUT_ELSEWHERE: Verdict = {
  outcome: 'timed_out',
  confidence: 'uncertain',
  provenance: [{ source: 'process', detail: 'the CLI’s own 45-minute ceiling ended the turn' }],
}

const CHILD_PID = 66247

/** A child doing real work: every sample above the line, which reads `working`. */
const WORKING: ChildLiveness = {
  pid: CHILD_PID,
  alive: true,
  samples: [12.3, 15.1, 13.5],
  selfSamples: [12.3, 15.1, 13.5],
  busiestDescendant: [],
  descendants: 0,
  workingDescendants: 0,
  idle: false,
  measuredAt: 0,
}

/** The same child, later: every sample below the line, which reads `not_computing`. */
const QUIET: ChildLiveness = {
  pid: CHILD_PID,
  alive: true,
  samples: [0.2, 0.7, 0.2],
  selfSamples: [0.2, 0.7, 0.2],
  busiestDescendant: [],
  descendants: 0,
  workingDescendants: 0,
  idle: true,
  measuredAt: 0,
}

/** The #83 shape: two samples below the line and one above, which reads `mixed`. */
const BARELY: ChildLiveness = {
  pid: CHILD_PID,
  alive: true,
  samples: [0.3, 0.2, 7.2],
  selfSamples: [0.3, 0.2, 7.2],
  busiestDescendant: [],
  descendants: 0,
  workingDescendants: 0,
  idle: false,
  measuredAt: 0,
}

/** No process at all. `gone` — the reading the operator most needs to be told about. */
const GONE: ChildLiveness = {
  pid: CHILD_PID,
  alive: false,
  samples: [],
  selfSamples: [],
  busiestDescendant: [],
  descendants: 0,
  workingDescendants: 0,
  idle: false,
  measuredAt: 0,
}

/** What the advisor writes when a rotation asks it to brief the incoming session. */
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

/** What the replacement writes back, having run the one configured check. */
const ACCEPTED = 'CHECK 1: exit 0\n\nRead work.ts and ran the check. It matches.'

function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-incomplete-latch')
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
      // An in-memory double: no child process, so no clock of either kind.
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
  implementers: FakeRotationSession[],
  over: Partial<RelayOptions> = {},
): Promise<Relay> {
  return Relay.start({
    registry: registryOf({ codex: [advisor], claude: implementers }),
    cwd,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 8,
    // No refresher. Every one of these tests is about the reading a pause was RAISED on and the
    // reading the next one is raised on; a refresh loop rewriting the first while the test
    // resolves it would make which sample armed the latch a matter of timing.
    livenessRefreshLimit: 0,
    ...over,
  })
}

/**
 * Script a verdict per turn index, for a seat that ends more than one turn badly.
 *
 * `endTurn` names ONE turn, and the shape #107 reports is a seat that trips the same deadline
 * over and over — so the script has to be set again as each turn starts. `onSend` is the fake's
 * own hook for exactly that and runs synchronously at the top of `send()`, before the turn key is
 * minted, so this is a fixture rather than a race: `received` has just been pushed, which makes
 * its length minus one the index of the turn about to begin.
 */
function verdictsPerTurn(seat: FakeRotationSession, byTurn: Record<number, Verdict>): void {
  seat.onSend = () => {
    const index = seat.received.length - 1
    const verdict = byTurn[index]
    seat.endTurn = verdict ? { index, verdict } : undefined
  }
}

/** A sampler that answers with each reading in turn, and repeats the last one forever. */
function readings(...script: ChildLiveness[]): (pid: number) => Promise<ChildLiveness> {
  let n = 0
  return async () => {
    const next = script[Math.min(n++, script.length - 1)]!
    return { ...next, measuredAt: Date.now() }
  }
}

/** Drive the run to its end, continuing from every pause, and collect them. */
async function pausesThrough(run: ReturnType<Relay['start']>): Promise<RunPause[]> {
  const seen: RunPause[] = []
  for (;;) {
    const s = await run.settled()
    if (s.kind === 'ended') return seen
    seen.push(s.pause)
    await run.continue()
  }
}

/** The routing log's notes, which is where "not asked" is kept from becoming "not watched". */
function notesOf(relay: Relay): string[] {
  return relay.log.filter((m) => m.kind === 'note').map((m) => m.text)
}

/** Suppression notes, found by the prefix a reader would grep for. */
function suppressions(relay: Relay): string[] {
  return notesOf(relay).filter((t) => t.startsWith('turn_incomplete recorded, run continues'))
}

test('a seat that trips the deadline three times with the child still working is asked once', async (t) => {
  // The reported defect, at the smallest size that shows it. Before the latch this raised three
  // pauses whose `detail` strings were character-for-character identical.
  const dir = repo(t)
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'still going', 'still going', 'still going'])
  impl.childPid = CHILD_PID
  verdictsPerTurn(impl, { 1: TIMED_OUT, 2: TIMED_OUT, 3: TIMED_OUT })
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Keep going.', 'Keep going.', 'DONE'])
  const relay = await relayOf(dir, advisor, [impl], { liveness: readings(WORKING) })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const seen = await pausesThrough(run)

  assert.equal(seen.length, 1, `asked once, not once per watchdog:\n${seen.map((p) => p.detail).join('\n')}`)
  assert.equal(seen[0]!.reason, 'turn_incomplete')
  assert.equal(seen[0]!.liveness?.reading, 'working')
  // `wait` was on the menu, which is what makes the answer repeatable: the operator looked at a
  // live child and declined to do anything destructive to it.
  assert.ok(seen[0]!.options.includes('wait'))

  // NOT ASKED IS NOT NOT WATCHED. Both re-raises are on the record, and the note counts itself so
  // a reader does not have to.
  const quiet = suppressions(relay)
  assert.equal(quiet.length, 2, notesOf(relay).join('\n'))
  assert.match(quiet[0]!, /1 suppressed so far for this seat/)
  assert.match(quiet[1]!, /2 suppressed so far for this seat/)
  for (const note of quiet) {
    assert.match(note, /already answered a timed_out pause for this session of implementer/)
    assert.match(note, /while the child read working/)
    // The evidence, not just the conclusion: the reading the run declined to interrupt anybody
    // about is in the note, so the decision can be second-guessed afterwards.
    assert.match(note, /is still working \(cpu 12\.3%, 15\.1%, 13\.5%\)/)
    // And it does NOT promise a refresh. That sentence belongs to a pause with a refresher behind
    // it; here there is no pause, so a line saying it is "re-measured while the pause lasts"
    // would be #101's stale-promise defect written into #107's remedy.
    assert.doesNotMatch(note, /re-measured while the pause lasts/)
  }
  // One `paused (turn_incomplete)` note for one pause, and the run finished rather than being
  // parked — which is the thing the issue says an unattended run could never do.
  assert.equal(notesOf(relay).filter((t) => t.startsWith('paused (turn_incomplete)')).length, 1)
  assert.equal((await run.result()).reason, 'done')
})

test('the same seat is asked again the moment the child stops looking alive', async (t) => {
  // THE TENSION, and the half that must not be lost. The operator answered about a seat that was
  // working. A seat that has gone quiet is a different question with the same words on it, and a
  // run that answers it out of memory tells them nothing at the one moment it matters.
  const dir = repo(t)
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'still going', 'still going', 'still going'])
  impl.childPid = CHILD_PID
  verdictsPerTurn(impl, { 1: TIMED_OUT, 2: TIMED_OUT, 3: TIMED_OUT })
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Keep going.', 'Keep going.', 'DONE'])
  const relay = await relayOf(dir, advisor, [impl], { liveness: readings(WORKING, QUIET, GONE) })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const seen = await pausesThrough(run)

  assert.equal(seen.length, 3, `every change of character is a new question:\n${seen.map((p) => p.detail).join('\n')}`)
  assert.deepEqual(
    seen.map((p) => p.liveness?.reading),
    ['working', 'not_computing', 'gone'],
  )
  // Nothing was suppressed, and this is the assertion the fix is most at risk of failing
  // silently: a latch keyed on the seat and the verdict alone would have swallowed both.
  assert.deepEqual(suppressions(relay), [])
  assert.ok(!seen[1]!.options.includes('wait'), 'there is nothing left to wait for')
})

test('a child that goes quiet and comes back is asked all three times, not twice', async (t) => {
  // A -> B -> A, and the reason the answer is held as ONE current character rather than as a set
  // of answered ones. A set only ever grows: once `working` and `not_computing` have each been
  // seen, every later deadline matches something and the seat falls silent for the rest of the
  // run — "asked once" turning into "never asks again" by the route hardest to notice.
  //
  // And it is right on its own terms, not merely structurally safer. A child alternating between
  // working and idle is a child behaving oddly, which is worth MORE of an operator's attention
  // than one steadily working, not less.
  const dir = repo(t)
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'still going', 'still going', 'still going'])
  impl.childPid = CHILD_PID
  verdictsPerTurn(impl, { 1: TIMED_OUT, 2: TIMED_OUT, 3: TIMED_OUT })
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Keep going.', 'Keep going.', 'DONE'])
  const relay = await relayOf(dir, advisor, [impl], { liveness: readings(WORKING, QUIET, WORKING) })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const seen = await pausesThrough(run)

  assert.equal(seen.length, 3, `the return to working is a new question:\n${seen.map((p) => p.detail).join('\n')}`)
  assert.deepEqual(
    seen.map((p) => p.liveness?.reading),
    ['working', 'not_computing', 'working'],
  )
  // The quiet reading in the middle did not merely fail to match — it VOIDED the working answer
  // given before it, which is why the third is asked. A latch that only added would suppress it.
  assert.deepEqual(suppressions(relay), [])
})

test('an outcome that changes and changes back is asked all three times too', async (t) => {
  // The same rule on the other half of the signature, so neither half can quietly become
  // cumulative on its own. `transport_lost` between two `timed_out`s is not a third question the
  // operator has now consented to — it is evidence that the seat's situation moved, and the
  // `timed_out` after it is being put for the first time since it did.
  const dir = repo(t)
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'still going', 'still going', 'still going'])
  impl.childPid = CHILD_PID
  verdictsPerTurn(impl, { 1: TIMED_OUT, 2: TRANSPORT_LOST, 3: TIMED_OUT })
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Keep going.', 'Keep going.', 'DONE'])
  const relay = await relayOf(dir, advisor, [impl], { liveness: readings(WORKING) })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const seen = await pausesThrough(run)

  assert.equal(seen.length, 3, seen.map((p) => p.detail).join('\n'))
  assert.deepEqual(
    seen.map((p) => (/timed_out/.test(p.detail) ? 'timed_out' : 'transport_lost')),
    ['timed_out', 'transport_lost', 'timed_out'],
  )
  // Every reading was `working` throughout, so nothing about the child explains this: the outcome
  // moving is on its own enough to void the answer.
  assert.deepEqual(
    seen.map((p) => p.liveness?.reading),
    ['working', 'working', 'working'],
  )
  assert.deepEqual(suppressions(relay), [])
})

test('a reading that could not be taken forgets the answer rather than assuming it held', async (t) => {
  // The forgetting lives at the OBSERVATION, and this is the case that says why it is not simply
  // folded into the arming. A `ps` that fails mid-run leaves the pause with no liveness block at
  // all, so there is nothing to arm from — and an answer left standing through that would be
  // matched again by the next readable deadline, on the strength of a claim ("the character has
  // not changed") the run had no measurement to support.
  const dir = repo(t)
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'still going', 'still going', 'still going'])
  impl.childPid = CHILD_PID
  verdictsPerTurn(impl, { 1: TIMED_OUT, 2: TIMED_OUT, 3: TIMED_OUT })
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Keep going.', 'Keep going.', 'DONE'])
  let reads = 0
  const relay = await relayOf(dir, advisor, [impl], {
    liveness: async () => {
      if (++reads === 2) throw new Error('ps: no such process table')
      return { ...WORKING, measuredAt: Date.now() }
    },
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const seen = await pausesThrough(run)

  assert.equal(seen.length, 3, `an unreadable child is not a child that has stayed the same:\n${seen.map((p) => p.detail).join('\n')}`)
  assert.equal(seen[1]!.liveness, undefined, 'the middle pause could take no reading at all')
  assert.equal(seen[2]!.liveness?.reading, 'working', 'and the third reads exactly as the first did')
  assert.deepEqual(suppressions(relay), [])
})

test('the suppression count is cumulative for the session, across a latch that re-arms', async (t) => {
  // The count answers "how many times did this run decline to interrupt me", which is a question
  // about the whole run — so it is NOT reset when the character changes and the latch re-arms.
  // A counter that restarted on every re-arm would read lowest on exactly the oscillating runs
  // where the total matters most.
  const dir = repo(t)
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'one', 'two', 'three', 'four', 'five'])
  impl.childPid = CHILD_PID
  verdictsPerTurn(impl, { 1: TIMED_OUT, 2: TIMED_OUT, 3: TIMED_OUT, 4: TIMED_OUT, 5: TIMED_OUT })
  const advisor = new FakeRotationSession('advisor', 'codex', [
    'Do it.',
    'Keep going.',
    'Keep going.',
    'Keep going.',
    'Keep going.',
    'DONE',
  ])
  const relay = await relayOf(dir, advisor, [impl], {
    // Working, working, quiet, working, working: two suppressions with a re-ask between them.
    liveness: readings(WORKING, WORKING, QUIET, WORKING, WORKING),
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const seen = await pausesThrough(run)

  assert.deepEqual(
    seen.map((p) => p.liveness?.reading),
    ['working', 'not_computing', 'working'],
    `the quiet reading is asked about, and the return to working is asked about again:\n${seen.map((p) => p.detail).join('\n')}`,
  )
  const quiet = suppressions(relay)
  assert.equal(quiet.length, 2)
  assert.match(quiet[0]!, /1 suppressed so far for this seat/)
  assert.match(quiet[1]!, /2 suppressed so far for this seat/, 'the count carried across the re-arm')
})

test('a child that is not computing is asked about every time, however often it repeats', async (t) => {
  // The rule stated positively: only a reading that reports a LIVE child arms this. The test
  // above cannot say that on its own — its three readings all differ, so the signature alone
  // explains the three pauses, and a latch that happily remembered `not_computing` would pass it.
  //
  // Here nothing changes at all. Three deadlines, three identical quiet readings, and the run
  // asks all three times, because "the child is idle" is not a finding an operator agreed to
  // stop hearing. It is the finding a pause exists for.
  const dir = repo(t)
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'still going', 'still going', 'still going'])
  impl.childPid = CHILD_PID
  verdictsPerTurn(impl, { 1: TIMED_OUT, 2: TIMED_OUT, 3: TIMED_OUT })
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Keep going.', 'Keep going.', 'DONE'])
  const relay = await relayOf(dir, advisor, [impl], { liveness: readings(QUIET) })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const seen = await pausesThrough(run)

  assert.equal(seen.length, 3, `an idle child is never answered once and for all:\n${seen.map((p) => p.detail).join('\n')}`)
  assert.deepEqual(
    seen.map((p) => p.liveness?.reading),
    ['not_computing', 'not_computing', 'not_computing'],
  )
  assert.deepEqual(suppressions(relay), [])
})

test('“working” and “barely running” are two readings, and answering one does not answer the other', async (t) => {
  // The signature takes the reading WHOLE, on #118's argument for taking the evidence class
  // whole: a decision made about one is not a decision about another the operator was never
  // shown. #83 went to some trouble to stop a mixed sample being announced as a working one, and
  // folding the two back together HERE would undo that where nobody would think to look — the
  // operator would simply stop being told that the evidence had weakened.
  const dir = repo(t)
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'still going', 'still going', 'still going'])
  impl.childPid = CHILD_PID
  verdictsPerTurn(impl, { 1: TIMED_OUT, 2: TIMED_OUT, 3: TIMED_OUT })
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Keep going.', 'Keep going.', 'DONE'])
  const relay = await relayOf(dir, advisor, [impl], {
    // Solidly working, then the shape #83 was raised about: mostly below the line with one
    // sample above it. Both offer `wait`; they are not the same report.
    liveness: readings(WORKING, BARELY),
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const seen = await pausesThrough(run)

  assert.equal(seen.length, 2, seen.map((p) => p.detail).join('\n'))
  assert.deepEqual(
    seen.map((p) => p.liveness?.reading),
    ['working', 'mixed'],
  )
  // The third deadline repeats the mixed reading, which the operator has now answered — so that
  // one, and only that one, is suppressed.
  assert.equal(suppressions(relay).length, 1)
  assert.match(suppressions(relay)[0]!, /while the child read mixed/)
})

test('a different verdict outcome is a different question, however alive the child is', async (t) => {
  // The class half of the signature, and #118's argument one condition over: `transport_lost` is
  // not the thing the operator ruled on when they ruled on `timed_out`, and folding the two into
  // "the run already asked about this seat" would answer a question nobody put.
  const dir = repo(t)
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'still going', 'still going', 'still going'])
  impl.childPid = CHILD_PID
  verdictsPerTurn(impl, { 1: TIMED_OUT, 2: TIMED_OUT, 3: TRANSPORT_LOST })
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Keep going.', 'Keep going.', 'DONE'])
  const relay = await relayOf(dir, advisor, [impl], { liveness: readings(WORKING) })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const seen = await pausesThrough(run)

  assert.equal(seen.length, 2, seen.map((p) => p.detail).join('\n'))
  assert.match(seen[0]!.detail, /timed_out/)
  assert.match(seen[1]!.detail, /transport_lost/)
  // The middle one — same outcome, same reading — is the only one that went quiet.
  assert.equal(suppressions(relay).length, 1)
  assert.match(suppressions(relay)[0]!, /already answered a timed_out pause/)
})

test('two timeouts with different evidence are two questions, not one (#107)', async (t) => {
  // `timed_out` says a deadline expired and, by its own contract, never says why. The why is in
  // the provenance -- which is also what the pause hands the operator as its evidence. Keying the
  // latch on the outcome alone collapsed the orchestrator's watchdog and the CLI's own ceiling
  // into one question and answered the second with the first one's answer, while the child still
  // read `working`. That is this latch silencing a pause the operator needed, reached from the
  // inside, and an independent review found it rather than a test.
  const dir = repo(t)
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'still going', 'still going'])
  impl.childPid = CHILD_PID
  verdictsPerTurn(impl, { 1: TIMED_OUT, 2: TIMED_OUT_ELSEWHERE })
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Keep going.', 'DONE'])
  const relay = await relayOf(dir, advisor, [impl], { liveness: readings(WORKING) })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const seen = await pausesThrough(run)

  assert.equal(seen.length, 2, `both were asked:\n${seen.map((x) => x.detail).join('\n')}`)
  assert.ok(
    seen[0]!.evidence.some((e) => /watchdog at 2700s/.test(e)),
    'the first carries the orchestrator watchdog as its evidence',
  )
  assert.ok(
    seen[1]!.evidence.some((e) => /45-minute ceiling/.test(e)),
    'and the second a different mechanism, which is why it is a different question',
  )
  assert.deepEqual(suppressions(relay), [], 'neither was answered by the other')
})

test('a replacement is asked on its own merits, and the count starts again with it', async (t) => {
  // Scoped by SESSION, like #118's declines. "The child is working, let it run" was a judgement
  // about a session that has since been retired; a replacement that trips the same deadline is a
  // question nobody has been asked, and the run that answers it from its predecessor's record
  // would silence the very first thing a new seat did.
  const dir = repo(t)
  const old = new FakeRotationSession('old', 'claude', ['ack', 'still going', 'still going'])
  old.childPid = CHILD_PID
  verdictsPerTurn(old, { 1: TIMED_OUT, 2: TIMED_OUT })
  // The replacement's acceptance report: it read the file and ran the configured check.
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'still going'])
  fresh.childPid = CHILD_PID
  // The advisor's second reply is the HANDOFF the rotation asks it for, not an instruction.
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', HANDOFF, 'Keep going.', 'DONE'])
  const relay = await relayOf(dir, advisor, [old, fresh], {
    liveness: readings(WORKING),
    // Armed, so `rotate` is on the menu at the pause and a promotion can actually be judged.
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000, onDegradation: 'automatic' },
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const first = await run.untilPause()
  assert.ok(first)
  assert.equal(first.reason, 'turn_incomplete')
  assert.ok(first.options.includes('rotate'), 'the premise: this pause can be answered by replacing the seat')

  // Answered by replacing the seat rather than by ruling on the evidence. The latch must not
  // record that as an answer — see #128, which is the same distinction on the other condition.
  const rotated = await run.rotateImplementer('a fresh reader for the same work')
  assert.equal(rotated.status, 'rotated', JSON.stringify(rotated))
  const impl = relay.participants.find((p) => p.rank === 'implementer')!
  assert.equal(impl.session, fresh)

  // The replacement's first turn trips the same deadline with the same reading, and IS put.
  fresh.endTurn = { index: fresh.received.length, verdict: TIMED_OUT }
  await run.continue()
  const second = await run.untilPause()
  assert.ok(second, `the new session's first deadline must be asked:\n${notesOf(relay).join('\n')}`)
  assert.equal(second.reason, 'turn_incomplete')
  assert.notEqual(second, first)
  assert.deepEqual(suppressions(relay), [], 'nothing has been answered about this session yet')

  await run.abort()
})

test('a rotation clears an answer that HAD been given, so the new session starts from nothing', async (t) => {
  // The other direction of the same scope, and the one the test above cannot reach: there, the
  // operator rotated INSTEAD of answering, so there was never anything to carry across. Here they
  // answer first, the answer is remembered, and only then is the seat replaced.
  //
  // The rotation has to be taken at a pause of a DIFFERENT kind, and that is a consequence of the
  // current-character rule rather than a convenience: any `turn_incomplete` that does not match
  // the remembered answer voids it on sight, so a second deadline could never leave one standing
  // to be carried across a rotation. A `rotation_candidate` touches none of this, which makes it
  // the point where an answer really is still held when the seat changes underneath it.
  const dir = repo(t)
  const old = new FakeRotationSession('old', 'claude', ['ack', 'still going', 'did the next bit'])
  old.childPid = CHILD_PID
  verdictsPerTurn(old, { 1: TIMED_OUT })
  // The second turn ends cleanly and compacts, which is what raises the candidate.
  old.compactOnTurn = 2
  const fresh = new FakeRotationSession('fresh', 'claude', [ACCEPTED, 'still going'])
  fresh.childPid = CHILD_PID
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Keep going.', HANDOFF, 'Keep going.', 'DONE'])
  const relay = await relayOf(dir, advisor, [old, fresh], {
    liveness: readings(WORKING),
    rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000, onDegradation: 'candidate' },
    maxAdvisorTurns: 6,
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const first = await run.untilPause()
  assert.equal(first?.reason, 'turn_incomplete')
  assert.equal(first?.liveness?.reading, 'working')
  await run.continue()

  // A compaction on the next turn, which is a different condition entirely and leaves the
  // `timed_out`/`working` answer standing. The seat is replaced from here.
  const second = await run.untilPause()
  assert.equal(second?.reason, 'rotation_candidate')
  const rotated = await run.rotateImplementer('a fresh reader for the same work')
  assert.equal(rotated.status, 'rotated', JSON.stringify(rotated))
  assert.equal(relay.participants.find((p) => p.rank === 'implementer')!.session, fresh)

  // `timed_out` beside a `working` child is exactly what the operator answered at the first
  // pause. It is asked anyway, because the session they answered about is gone.
  fresh.endTurn = { index: fresh.received.length, verdict: TIMED_OUT }
  await run.continue()
  const third = await run.untilPause()
  assert.ok(third, `the replacement's first deadline must be asked:\n${notesOf(relay).join('\n')}`)
  assert.equal(third.reason, 'turn_incomplete')
  assert.equal(third.liveness?.reading, 'working')
  assert.deepEqual(suppressions(relay), [], 'nothing was ever suppressed, on either session')

  await run.abort()
})

test('a seat with no measurable child is asked every time, because nothing says the character held', async (t) => {
  // Fails open, deliberately. The latch's claim is "the situation has not changed", and a run
  // that cannot measure the child cannot make that claim — so it asks, exactly as it did before
  // any of this existed. An adapter that names no child pid is the common case, not a corner:
  // the pause simply carries no liveness line, as `pauseLiveness.test.ts` pins.
  const dir = repo(t)
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'still going', 'still going', 'still going'])
  verdictsPerTurn(impl, { 1: TIMED_OUT, 2: TIMED_OUT, 3: TIMED_OUT })
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'Keep going.', 'Keep going.', 'DONE'])
  let sampled = 0
  const relay = await relayOf(dir, advisor, [impl], {
    liveness: async () => {
      sampled++
      return { ...WORKING, measuredAt: Date.now() }
    },
  })
  t.after(() => relay.stop())

  const run = relay.start('Keep the work moving.')
  const seen = await pausesThrough(run)

  assert.equal(sampled, 0, 'no pid is no reading, and nothing was invented to latch on')
  assert.equal(seen.length, 3, 'unchanged from before the latch existed')
  assert.deepEqual(suppressions(relay), [])
  for (const p of seen) assert.equal(p.liveness, undefined)
})
