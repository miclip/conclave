/**
 * A completed turn that leaves a working descendant behind is recorded, and only recorded
 * (#322).
 *
 *   node --test src/relay/turnBoundaryLiveness.test.ts
 *
 * The defect was a gap in the record, not a wrong grade. A seat started a twenty-minute suite
 * as a background task and ended its turn to wait for it; `Stop` graded the turn completed,
 * which it was, and the log read as two clean turns while a `node --test` sat at 90% under
 * the seat's pid. So the claims here are about the routing log: that the reading is put on it
 * when a descendant is working, that it is NOT put on it for the ordinary shape of a seat's
 * tree (idle helpers, or nothing at all), and that a reading which never arrives cannot hold
 * the turn it is about. Everything that was true of the turn before -- its grade, its report,
 * the advisor round it cost -- is asserted unchanged, because "record and do nothing else" is
 * the design and a test that only checked the note would not have pinned the second half.
 *
 * The seam is `RelayOptions.turnBoundaryLiveness` -- its own, and not the pause's `liveness`,
 * because that one is scripted as a sequence by every pause test and a second reader would
 * shift the script (see the option's docblock). The fake has no child, so the injected reader
 * is the only way a tree can be made to look busy on demand.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { AgentSession } from '../contract/session.ts'
import { SAMPLE_WORST_CASE_MS, type ChildLiveness } from '../outcomes/liveness.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { tempDir } from '../testkit/tempDir.ts'
import type { RelayMessage } from './message.ts'
import { Relay, TURN_BOUNDARY_LIVENESS_MS, type RelayOptions } from './relay.ts'

/** The pid the fake claims. Never sampled: the injected reader answers for it. */
const CHILD_PID = 41007

/** The shape from the issue: a quiet CLI with a test runner saturating a core underneath it. */
const DEFERRED_SUITE: ChildLiveness = {
  pid: CHILD_PID,
  presence: 'present',
  selfSamples: [0.4, 0.2, 0.3],
  samples: [91.2, 88.7, 93.0],
  busiestDescendant: [90.8, 88.5, 92.7],
  descendants: 3,
  workingDescendants: 1,
  idle: false,
  measuredAt: Date.UTC(2026, 8, 17, 10, 30, 0),
}

/** The falsifier from `liveness.ts`: a shelf of idle MCP helpers is descendants and no work. */
const IDLE_HELPERS: ChildLiveness = {
  pid: CHILD_PID,
  presence: 'present',
  selfSamples: [0.3, 0.2, 0.2],
  samples: [1.9, 2.1, 1.8],
  busiestDescendant: [0.4, 0.5, 0.4],
  descendants: 10,
  workingDescendants: 0,
  idle: true,
  measuredAt: 0,
}

function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-turn-boundary-liveness')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init'], {
    cwd: dir,
  })
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

/**
 * One advisor instruction, one implementer report, done. The implementer carries a pid so the
 * boundary reading is taken on each of its three turns -- the briefing acknowledgement, the
 * report, and the closing statement at DONE, which is the boundary where deferred work would
 * otherwise go unreported for good; the advisor carries none, and is the control for "no pid,
 * no reading".
 */
async function runOnce(
  t: TestContext,
  over: Partial<RelayOptions>,
): Promise<{ log: RelayMessage[]; reason: string; impl: FakeRotationSession; advisor: FakeRotationSession }> {
  const dir = repo(t)
  const advisor = new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])
  const impl = new FakeRotationSession('impl', 'claude', ['ack', 'Started the suite; still running.', 'No flags.'])
  impl.childPid = CHILD_PID
  const log: RelayMessage[] = []
  const relay = await Relay.start({
    registry: registryOf({ codex: [advisor], claude: [impl] }),
    cwd: dir,
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 4,
    onLog: (m) => log.push(m),
    ...over,
  })
  try {
    const outcome = await relay.run('Run the suite and report.')
    return { log, reason: outcome.reason, impl, advisor }
  } finally {
    await relay.stop()
  }
}

const boundaryNotes = (log: RelayMessage[]): RelayMessage[] =>
  log.filter((m) => m.from === 'orchestrator' && m.kind === 'note' && /turn ended with .* still working/.test(m.text))

test('a working descendant at turn end is recorded as a note with the measured facts, and nothing else changes', async (t) => {
  const sampled: number[] = []
  const { log, reason, advisor } = await runOnce(t, {
    turnBoundaryLiveness: async (pid) => {
      sampled.push(pid)
      return DEFERRED_SUITE
    },
  })

  // Read at every turn boundary of the seat that has a pid -- all three of its turns -- and never
  // for the advisor, which has none. The count is the proof that the reading is per-turn and
  // taken from the seam rather than from a real `ps` the fake could not answer.
  assert.deepEqual(sampled, [CHILD_PID, CHILD_PID, CHILD_PID], 'sampled once per implementer turn, by its pid')

  const notes = boundaryNotes(log)
  assert.equal(notes.length, 3, `one note per working reading; got ${JSON.stringify(log.map((m) => m.text))}`)
  const note = notes[0]!.text
  // The facts, as measured: the count that crossed the line, the parent's own share, the
  // tree, the busiest descendant, and when. An operator deciding whether to wait needs every
  // one of these, and the #322 report had to go to `ps` for all of them.
  assert.match(note, /^implementer's turn ended with 1 of 3 process\(es\) under its child \(pid 41007\) still working/)
  assert.match(note, /the child itself read 0\.4%, 0\.2%, 0\.3%/)
  assert.match(note, /the whole tree 91\.2%, 88\.7%, 93\.0%/)
  assert.match(note, /the busiest descendant 90\.8%, 88\.5%, 92\.7%/)
  assert.match(note, /measured 2026-09-17T10:30:00\.000Z/)
  // And what the note is NOT: the reading names both things it could be and says it decided
  // nothing, in its own words, so a reader in the log does not take it for a verdict.
  assert.match(note, /may be work the seat started and deferred past its turn/)
  assert.match(note, /or something legitimately still running/)
  // "Hold the turn open", not "delay": the reading does cost the routing its sampling time,
  // and a note that said otherwise would be the kind of claim this project keeps catching.
  assert.match(note, /did not hold the turn open, and did not alter, re-prompt, or reclassify it/)
  assert.doesNotMatch(note, /did not delay/)
  // Nobody's inbox: an orchestrator note to the record, not a message to a seat.
  assert.deepEqual(notes[0]!.to, [])

  // The second half of the design. The seat's report was routed as written, the turn is on the
  // record as completed, the advisor got its instruction answered and the run ended on its own
  // DONE -- no re-prompt, no held turn, no round withheld.
  const report = log.find((m) => m.from === 'implementer' && m.kind === 'report')
  assert.ok(report, 'the report was routed')
  assert.match(report.text, /Started the suite; still running\./)
  assert.equal(reason, 'done')
  assert.equal(advisor.received.length, 2, 'the briefing (carrying the goal), the report, and nothing extra: no re-prompt reached the advisor')
  const verdict = log.find((m) => m.from === 'orchestrator' && /implementer turn: completed/.test(m.text))
  assert.ok(verdict, `the turn's grade is unchanged; log was ${JSON.stringify(log.map((m) => m.text))}`)
})

test('idle descendants, or none, produce no note', async (t) => {
  // Ten idle helpers: the reading `liveness.ts` names as the one a descendant-count check
  // gets wrong. Then the same seat with nothing under it at all. Neither is work.
  let reads = 0
  const bare: ChildLiveness = { ...IDLE_HELPERS, samples: [0.3, 0.2, 0.2], busiestDescendant: [], descendants: 0 }
  const { log, reason } = await runOnce(t, {
    turnBoundaryLiveness: async () => (++reads === 1 ? IDLE_HELPERS : bare),
  })
  assert.equal(reads, 3, 'the reading was taken; silence is the reading, not a skipped read')
  assert.deepEqual(boundaryNotes(log), [], 'no working descendant, no note')
  assert.equal(reason, 'done')
})

test('a child that is gone, or could not be measured, produces no note either', async (t) => {
  // Neither of the two no-sample readings has a descendant to report, and the check is on the
  // count alone -- there is no presence branch, and this is the assertion that keeps it that way.
  // `unmeasured` (#323) in particular must not be read as anything: a `ps` that timed out at the
  // boundary says nothing about the seat's tree, and a note here would be a claim about it.
  const none: ChildLiveness = {
    pid: CHILD_PID,
    presence: 'gone',
    selfSamples: [],
    samples: [],
    busiestDescendant: [],
    descendants: 0,
    workingDescendants: 0,
    idle: false,
    measuredAt: 0,
  }
  let reads = 0
  const { log, reason } = await runOnce(t, {
    turnBoundaryLiveness: async () => ({ ...none, presence: ++reads === 1 ? 'gone' : 'unmeasured', measuredAt: Date.now() }),
  })
  assert.equal(reads, 3, 'the reading was taken at every boundary')
  assert.deepEqual(boundaryNotes(log), [], 'nothing measured under the seat, nothing recorded')
  assert.ok(
    !log.some((m) => /could not be measured|process table could not be read/.test(m.text)),
    'and no other note was invented for the unmeasured reading: silence is the reading',
  )
  assert.equal(reason, 'done')
})

test('a reading that never arrives is dropped at the ceiling and the turn proceeds without a note', { timeout: 10_000 }, async (t) => {
  // An injected sampler that never settles -- or an asynchronous one a future adapter might
  // supply, which is the only kind this race can actually cut off; the real sampler's `ps`
  // reads are synchronous and carry their own bound, proved in `src/outcomes/liveness.test.ts`.
  // With the default five-second ceiling this run would take fifteen seconds and still finish;
  // with no ceiling it would never finish, and that is the claim: the turn has ended and a
  // diagnostic about it cannot be what holds it.
  let started = 0
  const began = Date.now()
  const { log, reason } = await runOnce(t, {
    turnBoundaryLiveness: () => {
      started += 1
      return new Promise<ChildLiveness>(() => {})
    },
    turnBoundaryLivenessMs: 40,
  })
  const elapsed = Date.now() - began
  assert.equal(started, 3, 'the reading was asked for at every boundary')
  assert.deepEqual(boundaryNotes(log), [], 'nothing measured, nothing recorded')
  assert.equal(reason, 'done')
  // WHAT THIS SEPARATES, and what it must not try to. Three boundaries at the 5s DEFAULT would
  // take fifteen seconds; unbounded they would never return. Either is far outside the test's
  // own 10s timeout, so the bound here only has to sit between "the injected ceiling was used"
  // and "the default was", and everything below fifteen seconds does that.
  //
  // It used to assert `< 3_000`, which is a claim about the HARNESS rather than the ceiling: on
  // Node 24.0.2 under `--test-concurrency=4` the same run took 3495ms and failed, while passing
  // three times out of three alone on that same Node. The overhead was the machine's; the
  // ceiling had worked. A bound sized on an idle laptop is the defect #294 swept out of this
  // suite, and this is the same one written fresh.
  assert.ok(elapsed < 12_000, `the run took ${elapsed}ms, which is the 5s default rather than the 40ms ceiling`)
})

test('the ceiling sits above the longest reading the real sampler can take', () => {
  // The race in `#observeTurnBoundary` is a timer, and a timer cannot interrupt the sampler's
  // synchronous `ps` reads -- so what bounds a hung `ps` is the timeout inside each read, and
  // the ceiling is only meaningful if it exceeds the sum of every read a reading can make. Two
  // constants in two files; this is the line that keeps them in the right order.
  assert.ok(
    SAMPLE_WORST_CASE_MS < TURN_BOUNDARY_LIVENESS_MS,
    `a reading can take ${SAMPLE_WORST_CASE_MS}ms, which the ${TURN_BOUNDARY_LIVENESS_MS}ms ceiling must exceed`,
  )
})
