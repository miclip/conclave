/**
 * Several seats working at once, driven by one advisor reply.
 *
 * `assignmentSyntax.test.ts` proves the reply PARSES into several decisions. This proves the
 * dispatcher acts on them: that two seats are genuinely in flight at the same moment, that the
 * first report to come back reaches the advisor without waiting for its sibling, and that a
 * task whose seat is busy does not hold the queue behind it.
 *
 * The distinction matters because every one of those can be got wrong while the parse stays
 * right, and the wrong version LOOKS correct from the outside: a dispatcher that admitted two
 * tasks and ran them one after the other produces the same reports in the same log, just
 * slower, and nothing in a finished run says which happened. So the assertions here are made
 * from INSIDE the run — sampled at the moment a seat is sent its instruction, and at the moment
 * the advisor is handed a report — where "at the same time" is a question with an answer.
 *
 * Timings are deliberately coarse. `#exchange` polls for `turn_end` every 250ms, so a delay
 * that beats a poll interval by less than one interval proves nothing; the seat that must
 * finish second is given more than a second.
 *
 *   node --test src/relay/concurrentDispatch.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import type { Ceilings } from './guardrails.ts'
import { Relay } from './relay.ts'

/** One agent per fake session, so a seat's id and the child behind it stay distinguishable. */
function registryOf(sessions: Record<string, FakeRotationSession>): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, session] of Object.entries(sessions)) {
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
        return session
      },
    })
  }
  return r
}

/** A repository to run in: two seats mean real worktrees, and those need a real checkout. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-concurrent-'))
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir })
  return dir
}

const LEAD = { id: 'advisor', agent: 'lead', role: 'advisor' } as const
const SEATS = [
  { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
  { id: 'seat-beta', agent: 'beta', role: 'implementer' },
] as const

/** Plenty, so a seat that is asked one more time than expected does not answer with silence. */
const SEAT_REPLIES = ['ack', 'Did it.', 'Did that too.', 'NONE', 'NONE', 'NONE']

async function twoSeatRun(
  repo: string,
  advisorReplies: string[],
  maxAdvisorTurns = 8,
  extra: { ceilings?: Ceilings; seatReplies?: { alpha?: string[]; beta?: string[] } } = {},
): Promise<{ relay: Relay; lead: FakeRotationSession; alpha: FakeRotationSession; beta: FakeRotationSession }> {
  const lead = new FakeRotationSession('lead-1', 'lead', advisorReplies)
  const alpha = new FakeRotationSession('alpha-1', 'alpha', extra.seatReplies?.alpha ?? [...SEAT_REPLIES])
  const beta = new FakeRotationSession('beta-1', 'beta', extra.seatReplies?.beta ?? [...SEAT_REPLIES])
  const relay = await Relay.start({
    registry: registryOf({ lead, alpha, beta }),
    cwd: repo,
    lead: LEAD,
    implementer: SEATS[0],
    implementers: [...SEATS],
    maxAdvisorTurns,
    ...(extra.ceilings ? { ceilings: extra.ceilings } : {}),
  })
  return { relay, lead, alpha, beta }
}

/** The note the drain exists to make unnecessary. Its absence is half of every drain claim. */
function lostTurnNotes(relay: Relay): string[] {
  return relay.log.filter((m) => m.kind === 'note' && /turn\(s\) unfinished/.test(m.text)).map((m) => m.text)
}

/** Task id to the seat it was dispatched to, in admission order. */
function placements(relay: Relay): [string, string | undefined][] {
  return relay.tasks().map((e) => [e.task.id, e.runtime.seat])
}

test('one reply puts two seats to work, and they are in flight at the same moment', async () => {
  const repo = tempRepo()
  const { relay, alpha, beta } = await twoSeatRun(repo, [
    '@seat seat-alpha: Do the slow thing.\n@seat seat-beta: Do the quick thing.',
    'DONE',
    'DONE',
  ])
  try {
    // Alpha's turn outlives beta's whole turn, so "both were sent" cannot be an artifact of
    // one finishing before the other started.
    alpha.delayMs = 1500

    /**
     * The dispatcher's state at the instant beta is handed its instruction.
     *
     * This is the observation the whole test exists for. `session.send` is called from inside
     * the dispatch, so what this sees is the state at the moment the SECOND seat is dispatched
     * — and if alpha's turn had been awaited first, alpha would be `integrating` or `idle` here
     * and its task would be `reported`, not `running`.
     */
    const atBetaSend: { seats: [string, string][]; alphaTask: string | undefined }[] = []
    beta.onSend = (message) => {
      if (!/Do the quick thing/.test(message)) return
      atBetaSend.push({
        seats: relay.seats().map((s) => [s.seat, s.state]),
        alphaTask: relay.tasks().find((e) => e.runtime.seat === 'seat-alpha')?.runtime.state,
      })
    }

    const outcome = await relay.run('Keep the work moving.')
    assert.equal(outcome.reason, 'done')

    assert.deepEqual(
      atBetaSend,
      [
        {
          seats: [
            ['seat-alpha', 'running'],
            ['seat-beta', 'running'],
          ],
          alphaTask: 'running',
        },
      ],
      'when the second seat is dispatched the first must still be running its own turn',
    )

    // Both tasks came from ONE advisor turn: same origin, and the advisor was sent exactly one
    // instruction-bearing prompt before either report came back.
    const tasks = relay.tasks().map((e) => e.task)
    assert.equal(tasks.length, 2, 'one reply, two tasks')
    assert.equal(tasks[0]!.origin, tasks[1]!.origin, 'both were admitted from the same advisor turn')
    assert.deepEqual(placements(relay), [
      ['t-1', 'seat-alpha'],
      ['t-2', 'seat-beta'],
    ])
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('the first report to arrive reaches the advisor while its sibling is still working', async () => {
  const repo = tempRepo()
  const { relay, lead, alpha } = await twoSeatRun(repo, [
    '@seat seat-alpha: Do the slow thing.\n@seat seat-beta: Do the quick thing.',
    'DONE',
    'DONE',
  ])
  try {
    alpha.delayMs = 1500

    /** What every task's state was each time the advisor was handed something. */
    const atAdvisorSend: { text: string; states: Record<string, string> }[] = []
    lead.onSend = (message) => {
      atAdvisorSend.push({
        text: message,
        states: Object.fromEntries(relay.tasks().map((e) => [e.runtime.seat ?? e.task.id, e.runtime.state])),
      })
    }

    assert.equal((await relay.run('Keep the work moving.')).reason, 'done')

    // Identified by the dispatcher's state rather than by the prompt's wording: both briefings
    // talk about reports, so matching the text would find the goal prompt. The claim is about
    // WHEN the advisor was spoken to, and the task states are what say when.
    const whileSiblingRan = atAdvisorSend.filter(
      (s) => s.states['seat-beta'] === 'reported' && s.states['seat-alpha'] === 'running',
    )
    assert.equal(
      whileSiblingRan.length,
      1,
      'the quick seat\'s report must reach the advisor exactly once, while the slow seat is still mid-turn',
    )
    // Not merely "an advisor turn happened": the prompt carried beta's prose.
    assert.match(whileSiblingRan[0]!.text, /Did it\./, 'and what it carried is the report itself')

    // The routing log agrees, because the report is recorded when the turn comes back rather
    // than when the dispatcher gets to it: beta's report is stamped before alpha's, which is
    // the order they actually arrived in and the reverse of the order they were admitted.
    const reportOrder = relay.log.filter((m) => m.kind === 'report').map((m) => m.from)
    assert.deepEqual(
      reportOrder.slice(0, 2),
      ['seat-beta', 'seat-alpha'],
      'reports are logged in the order they arrived, not in admission order',
    )
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * Two reports waiting at once, and the one that arrived first goes first.
 *
 * The test above cannot see this. There, the dispatcher is never holding more than one finished
 * turn — each arrives, is processed, and is routed before the next one lands — so an
 * implementation that sorted the waiting reports by admission order would behave identically
 * and pass. This is the case that separates them: THREE seats, with the advisor's own turn slow
 * enough that two siblings finish inside it, arriving in the reverse of the order they were
 * admitted.
 *
 * Sorting them would be the buffering D4 rejects: a fast seat's report waiting on a slower
 * seat's is a barrier reintroduced under a different name, and the routing log — stamped from
 * one counter at the moment of recording — would then disagree with the order the advisor was
 * told about them in.
 *
 * The timings are the mechanism, so they are deliberate rather than incidental: `#exchange`
 * polls every 250ms, and each gap here is at least three times that.
 */
test('two reports that arrive during one advisor turn are routed in arrival order', async () => {
  const repo = tempRepo()
  const lead = new FakeRotationSession('lead-1', 'lead', [
    '@seat seat-alpha: Alpha work.\n@seat seat-beta: Beta work.\n@seat seat-gamma: Gamma work.',
    'DONE',
    'DONE',
    'DONE',
    'DONE',
  ])
  const alpha = new FakeRotationSession('alpha-1', 'alpha', ['ack', 'ALPHA REPORT', 'NONE'])
  const beta = new FakeRotationSession('beta-1', 'beta', ['ack', 'BETA REPORT', 'NONE'])
  const gamma = new FakeRotationSession('gamma-1', 'gamma', ['ack', 'GAMMA REPORT', 'NONE'])
  const relay = await Relay.start({
    registry: registryOf({ lead, alpha, beta, gamma }),
    cwd: repo,
    lead: LEAD,
    implementer: SEATS[0],
    implementers: [...SEATS, { id: 'seat-gamma', agent: 'gamma', role: 'implementer' }],
    maxAdvisorTurns: 10,
  })
  try {
    // Admission order is alpha, beta, gamma. Arrival order is alpha, GAMMA, beta.
    alpha.delayMs = 0
    beta.delayMs = 2000
    gamma.delayMs = 1000
    // Slow for exactly one turn: the one carrying alpha's report. Both remaining seats finish
    // while the advisor is thinking, so the dispatcher comes back to two waiting reports rather
    // than to one. `onSend` runs before `send` reads `delayMs`, so this takes effect that turn.
    let sends = 0
    lead.onSend = () => {
      sends += 1
      lead.delayMs = sends === 2 ? 3000 : 0
    }

    assert.equal((await relay.run('Keep the work moving.')).reason, 'done')

    const carried = lead.received
      .map((m) => /(ALPHA|BETA|GAMMA) REPORT/.exec(m)?.[1])
      .filter((s): s is string => s !== undefined)
    assert.deepEqual(
      carried,
      ['ALPHA', 'GAMMA', 'BETA'],
      'the advisor hears reports in the order they arrived, not the order it asked for them',
    )
    // The routing log agrees with what the advisor was told, which is the property that makes
    // the log usable as the account of the run.
    assert.deepEqual(
      relay.log.filter((m) => m.kind === 'report').map((m) => m.from).slice(0, 3),
      ['seat-alpha', 'seat-gamma', 'seat-beta'],
    )
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a task whose seat is busy is overtaken rather than holding the queue', async () => {
  const repo = tempRepo()
  const { relay, alpha, beta } = await twoSeatRun(repo, [
    '@seat seat-alpha: First alpha thing.\n@seat seat-alpha: Second alpha thing.\n@seat seat-beta: Beta thing.',
    'DONE',
    'DONE',
    'DONE',
    'DONE',
  ])
  try {
    alpha.delayMs = 1200

    /** Every task's state at the moment the third one is dispatched. */
    const atBetaSend: [string, string][][] = []
    beta.onSend = (message) => {
      if (!/Beta thing/.test(message)) return
      atBetaSend.push(relay.tasks().map((e) => [e.task.id, e.runtime.state]))
    }

    assert.equal((await relay.run('Keep the work moving.')).reason, 'done')

    assert.deepEqual(
      atBetaSend,
      [
        [
          ['t-1', 'running'],
          ['t-2', 'ready'],
          ['t-3', 'running'],
        ],
      ],
      'the third task must overtake the second, whose seat is busy, rather than wait behind it',
    )

    // And the overtaken task is not lost: it runs on its own seat once that seat is free.
    assert.deepEqual(placements(relay), [
      ['t-1', 'seat-alpha'],
      ['t-2', 'seat-alpha'],
      ['t-3', 'seat-beta'],
    ])
    assert.deepEqual(
      relay.tasks().map((e) => e.runtime.state),
      ['complete', 'complete', 'complete'],
      'every admitted task must finish, including the one that waited',
    )
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a seat-targeted task goes to that seat, and a role-targeted one to the longest-idle seat', async () => {
  const repo = tempRepo()
  const { relay } = await twoSeatRun(repo, [
    '@seat seat-beta: Only beta can do this.',
    '@role implementer: Whoever is free.',
    'DONE',
  ])
  try {
    assert.equal((await relay.run('Keep the work moving.')).reason, 'done')

    // The first is the sharp one: `seat-alpha` sorts first and has been idle since the run
    // started, so a role target would have chosen it. Naming the seat is what sends the work
    // to the other one.
    assert.deepEqual(placements(relay), [
      ['t-1', 'seat-beta'],
      ['t-2', 'seat-alpha'],
    ])
    assert.deepEqual(
      relay.tasks().map((e) => e.task.target),
      [
        { kind: 'seat', seat: 'seat-beta' },
        { kind: 'role', role: 'implementer' },
      ],
      'the target recorded on the task is the one the advisor wrote',
    )
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a reply with one bad directive admits nothing at all, not even the good one', async () => {
  const repo = tempRepo()
  // The first directive names a seat that exists and is perfectly well formed. A dispatcher
  // that admitted what parsed would run it — and the advisor, told only that its reply produced
  // no instruction, would have no idea that half of it had already been dispatched.
  const { relay } = await twoSeatRun(repo, [
    '@seat seat-alpha: This one is fine.\n@seat seat-nobody: This one is not.',
    'DONE',
  ])
  try {
    const outcome = await relay.run('Keep the work moving.')
    assert.notEqual(outcome.reason, 'done', 'an unattended run halts on a reply it cannot parse')

    assert.deepEqual(relay.tasks(), [], 'no task may be admitted from a reply that failed to parse')
    assert.deepEqual(
      relay.log.filter((m) => m.kind === 'instruction').map((m) => m.text),
      [],
      'and nothing may be delivered to a seat',
    )
    assert.ok(
      relay.log.some((m) => m.kind === 'note' && /advisor produced no instruction/.test(m.text)),
      'the failure is recorded in the words an empty instruction has always produced',
    )
    assert.deepEqual(
      relay.seats().map((s) => s.state),
      ['idle', 'idle'],
      'both seats must be left untouched',
    )
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('DONE while a seat is still working hands over the outstanding report instead of ending', async () => {
  const repo = tempRepo()
  const { relay, alpha } = await twoSeatRun(repo, [
    '@seat seat-alpha: Do the slow thing.\n@seat seat-beta: Do the quick thing.',
    // Said while alpha is still mid-turn. Ending here would discard a turn already paid for,
    // and would send the closing question to a seat that is running.
    'DONE',
    'DONE',
  ])
  try {
    alpha.delayMs = 1500
    const outcome = await relay.run('Keep the work moving.')
    assert.equal(outcome.reason, 'done', 'the run still ends, once nothing is in flight')

    assert.ok(
      relay.log.some((m) => m.kind === 'note' && /still outstanding — their reports come first/.test(m.text)),
      'the premature DONE must be recorded rather than silently ignored',
    )
    assert.deepEqual(
      relay.tasks().map((e) => e.runtime.state),
      ['complete', 'complete'],
      'the outstanding turn must be graded and integrated rather than abandoned',
    )
    assert.equal(
      relay.log.filter((m) => m.kind === 'report' && m.from === 'seat-alpha').length,
      1,
      'and its report must have been received',
    )
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a default run admits one task per reply and never has two in flight', async () => {
  // D1's identity case, from the concurrency side. The same code path with one seat must
  // produce the serial run it always did: one task per advisor turn, dispatched, awaited,
  // reported, routed. Nothing here counts seats — the shape falls out of the seat table.
  const repo = tempRepo()
  const lead = new FakeRotationSession('lead-1', 'lead', ['Do the thing.', 'And the next thing.', 'DONE'])
  const impl = new FakeRotationSession('impl-1', 'impl', [...SEAT_REPLIES])
  const relay = await Relay.start({
    registry: registryOf({ lead, impl }),
    cwd: repo,
    lead: LEAD,
    implementer: { id: 'implementer', agent: 'impl', role: 'implementer' },
    maxAdvisorTurns: 5,
  })
  try {
    // Sampled on the instruction sends only. The briefing and the closing question are turns
    // the dispatcher does not schedule, and counting them would measure something else.
    const inFlight: number[] = []
    impl.onSend = (message) => {
      if (!/Do the thing\.|And the next thing\./.test(message)) return
      inFlight.push(relay.seats().filter((s) => s.state === 'running').length)
    }

    assert.equal((await relay.run('Keep the work moving.')).reason, 'done')
    assert.deepEqual(inFlight, [1, 1], 'a one-seat run never has more than one turn in flight')
    assert.deepEqual(placements(relay), [
      ['t-1', 'implementer'],
      ['t-2', 'implementer'],
    ])
    assert.deepEqual(
      relay.tasks().map((e) => e.task.target),
      [
        { kind: 'role', role: 'implementer' },
        { kind: 'role', role: 'implementer' },
      ],
      'an unaddressed reply still targets the role, as it always has',
    )
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * The queue ceiling is all-or-none across a reply.
 *
 * Checked per decision, a reply whose fourth task crossed the ceiling ended the run with three
 * already admitted — `Task` records nothing would ever dispatch, runtimes stuck at `admitted`
 * forever, and a seat table that had never heard of them. That is exactly what putting the
 * check BEFORE the mutation was supposed to buy, defeated by doing it once per decision instead
 * of once per batch.
 */
test('a reply that would cross the queue ceiling admits none of itself', async () => {
  const repo = tempRepo()
  const { relay } = await twoSeatRun(
    repo,
    ['@seat seat-alpha: First.\n@seat seat-beta: Second.', 'DONE'],
    8,
    { ceilings: { maxQueueDepth: 1 } },
  )
  try {
    const outcome = await relay.run('Keep the work moving.')
    assert.equal(outcome.reason, 'ceiling', 'the ceiling must end the run')
    assert.deepEqual(relay.tasks(), [], 'a batch that cannot be admitted whole must not be admitted at all')
    assert.deepEqual(
      relay.log.filter((m) => m.kind === 'instruction').map((m) => m.text),
      [],
      'and nothing may have been delivered to a seat',
    )
    assert.deepEqual(relay.seats().map((s) => s.state), ['idle', 'idle'])
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('the same reply under a ceiling that fits admits all of itself', async () => {
  // The control. Without it the test above passes on a dispatcher that admits nothing ever.
  const repo = tempRepo()
  const { relay } = await twoSeatRun(
    repo,
    ['@seat seat-alpha: First.\n@seat seat-beta: Second.', 'DONE', 'DONE'],
    8,
    { ceilings: { maxQueueDepth: 2 } },
  )
  try {
    assert.equal((await relay.run('Keep the work moving.')).reason, 'done')
    assert.deepEqual(
      relay.tasks().map((e) => [e.runtime.seat, e.runtime.state]),
      [
        ['seat-alpha', 'complete'],
        ['seat-beta', 'complete'],
      ],
    )
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * An ending stops ADMISSION. It does not abandon the turns already sent.
 *
 * Three endings, one property, and the property is D2's: a scope that stops the conclave is not
 * what any of these conditions carries. `advisor_escalated` is classified as stopping "admission
 * of new tasks; in-flight seats drain"; a budget and a ceiling bound what a run may START, not
 * what it may finish. Returning the moment the decision was made applied a conclave-wide scope
 * to all of them and left a note saying the abandoned reports were never received — which was
 * true, and was the bug rather than the mitigation.
 *
 * Each case puts the ending in the middle of a slow sibling's turn, which is the only moment at
 * which the difference is observable.
 */
for (const kase of [
  {
    what: 'the advisor-turn budget',
    // One advisor turn: the reply that admits both. The budget is therefore exhausted at the
    // top of the next iteration, while alpha is still working.
    replies: ['@seat seat-alpha: Slow work.\n@seat seat-beta: Quick work.', 'DONE', 'DONE'],
    turns: 1,
    ceilings: undefined,
    reason: 'budget',
  },
  {
    what: 'a turn ceiling',
    replies: ['@seat seat-alpha: Slow work.\n@seat seat-beta: Quick work.', 'DONE', 'DONE'],
    turns: 8,
    // Reached after the briefings, the goal turn, the two work turns and the advisor turn that
    // carries the first report back — so it is checked while alpha is still mid-turn.
    ceilings: { maxTurns: 6 },
    reason: 'ceiling',
  },
  {
    what: 'an advisor escalation',
    replies: ['@seat seat-alpha: Slow work.\n@seat seat-beta: Quick work.', 'ESCALATE: I need a human.', 'DONE'],
    turns: 8,
    ceilings: undefined,
    reason: 'escalated',
  },
] as const) {
  test(`${kase.what} stops admission and drains the seat still working`, async () => {
    const repo = tempRepo()
    const { relay, alpha } = await twoSeatRun(repo, [...kase.replies], kase.turns, {
      ...(kase.ceilings ? { ceilings: { ...kase.ceilings } } : {}),
      seatReplies: { alpha: ['ack', 'ALPHA FINISHED', 'NONE', 'NONE'] },
    })
    try {
      alpha.delayMs = 1500
      const outcome = await relay.run('Keep the work moving.')
      assert.equal(outcome.reason, kase.reason, 'the run must end for the reason under test')

      // The seat that was still working finished, and every fact about it was recorded.
      assert.deepEqual(
        relay.tasks().map((e) => [e.runtime.seat, e.runtime.state]),
        [
          ['seat-alpha', 'complete'],
          ['seat-beta', 'complete'],
        ],
        'a turn already sent must be graded and integrated rather than abandoned',
      )
      // And its report reached the advisor, which is the half that makes the work usable.
      assert.ok(
        relay.log.some((m) => m.kind === 'report' && m.from === 'seat-alpha' && /ALPHA FINISHED/.test(m.text)),
        'the drained report must be in the routing log',
      )
      assert.deepEqual(lostTurnNotes(relay), [], 'nothing may be recorded as an unfinished turn')
    } finally {
      await relay.stop()
      rmSync(repo, { recursive: true, force: true })
    }
  })
}

/**
 * A seat-scoped condition stops that seat. It must not take an unrelated one with it.
 *
 * `implementer_unanswered` is classified `{kind: 'participant', participantId}` — the narrowest
 * scope there is. Unattended it ends the run, which is the front-end's rule and not this one's;
 * what must not happen is the OTHER seat's turn being discarded on the way out. That seat is
 * answering a different instruction and knows nothing about the question that was asked.
 */
test('a seat-scoped halt does not discard an unrelated seat that is still working', async () => {
  const repo = tempRepo()
  const { relay, alpha } = await twoSeatRun(
    repo,
    ['@seat seat-alpha: Slow work.\n@seat seat-beta: Quick work.', 'DONE', 'DONE'],
    8,
    {
      seatReplies: {
        alpha: ['ack', 'ALPHA FINISHED', 'NONE', 'NONE'],
        // The quick seat asks a build-changing question, which halts the run on ITS scope while
        // the slow seat is still mid-turn.
        beta: ['ack', 'Started it.\nUNANSWERED: should this go under /v1 or /v2?', 'NONE', 'NONE'],
      },
    },
  )
  try {
    alpha.delayMs = 1500
    const outcome = await relay.run('Keep the work moving.')
    assert.equal(outcome.reason, 'escalated', 'unattended, the question ends the run')
    assert.match(outcome.detail ?? '', /UNANSWERED/, 'and it ends on the question that was asked')

    // The blocked seat's own task is left exactly where the halt left it — ungraded, because
    // the halt happened before grading, which is what it did before any of this changed.
    const byId = Object.fromEntries(relay.tasks().map((e) => [e.runtime.seat, e.runtime.state]))
    assert.equal(byId['seat-beta'], 'reported', 'the seat that asked the question stops there')
    // The unrelated seat finished, was graded and integrated, and its report was routed.
    assert.equal(byId['seat-alpha'], 'complete', 'the other seat must not be terminated by it')
    assert.ok(
      relay.log.some((m) => m.kind === 'report' && m.from === 'seat-alpha' && /ALPHA FINISHED/.test(m.text)),
      'the unrelated report must have been received',
    )
    assert.deepEqual(lostTurnNotes(relay), [], 'and nothing may be recorded as an unfinished turn')
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})
