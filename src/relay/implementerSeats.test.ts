/**
 * More than one implementer seat, and the default run that must not notice.
 *
 * Two claims, and they are different in kind. The first is that `implementers` WORKS: a relay
 * given two specs joins two children, briefs both, locks both and reports both. The second is
 * that the option is behaviourless when absent -- `implementers ?? [implementer]` is an
 * identity at N=1, not an approximation of one -- which is D1's rule stated as a test rather
 * than as a comment.
 *
 * Both are written against observable state: the sessions' `received` arrays, the participant
 * list, the routing log and the session lock file on disk. Nothing here reads a private field
 * or asserts over source text, so a change that keeps the wiring and loses the effect fails.
 *
 * The identity claim is checked by CONSTRUCTING BOTH: one relay from the singular option alone
 * and one from `implementers: [the same spec]`, then comparing what each produced. A test that
 * only asserted the default still works could not tell an identity from a coincidence.
 *
 *   node --test src/relay/implementerSeats.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import type { CreateParticipantContext, ResolvedParticipant } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { lockPath } from '../workspace/sessionLock.ts'
import { implementerSeats, Relay } from './relay.ts'
import { runReport } from './report.ts'
import type { RelayMessage } from './message.ts'

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

/**
 * The same, for a run that replaces a session: one QUEUE per agent, and where it was created.
 *
 * `registryOf` above hands the same object back to every `create`, which is right for the seat
 * tests it was written for and useless for a rotation -- the "replacement" would be the session
 * being replaced. The creation record is here for the same reason: a replacement started in the
 * wrong tree is invisible in every other observable, since the sessions are in-memory doubles
 * with no cwd of their own.
 */
function registryOfQueues(
  queues: Record<string, FakeRotationSession[]>,
  records: { id: string; cwd: string; nth: number }[],
): AgentRegistry {
  const r = new AgentRegistry()
  const counts = new Map<string, number>()
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
      async create(resolved: ResolvedParticipant, ctx: CreateParticipantContext) {
        const next = remaining.shift()
        if (!next) throw new Error(`no session left for ${agent}`)
        // Counted by SEAT ID rather than by agent: the replacement carries `<seat>~replacement`
        // as its participant id while it auditions, and this has to be able to say "the second
        // session created for seat-alpha" whatever that session was called at the time.
        const nth = (counts.get(resolved.spec.id.replace('~replacement', '')) ?? 0) + 1
        counts.set(resolved.spec.id.replace('~replacement', ''), nth)
        records.push({ id: resolved.spec.id.replace('~replacement', ''), cwd: ctx.cwd, nth })
        return next
      },
    })
  }
  return r
}

/** The advisor's handoff, as `parseHandoff` requires it. */
const HANDOFF = `## BRIEF
Keep the work moving.

## STATE
Half done.

## DECISIONS
- none

## EVIDENCE
The implementer says the check passes.

## FILES
- README.md

## DISAGREEMENT
- none

## NEXT
Carry on.`

/** A replacement that ran the check and reports what the arbiter will independently observe. */
const ACCEPTED = 'CHECK 1: exit 0\n\nRead the files and ran the check. It matches.'

/** A repository to run in: the lock samples `git status`, and the relay lists worktrees. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-seats-'))
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir })
  return dir
}

/** The joined-as notes, which are the log's own account of who this run has. */
function joinNotes(log: readonly RelayMessage[]): string[] {
  return log.filter((m) => m.kind === 'note' && / joined as /.test(m.text)).map((m) => m.text)
}

/** Who the session lock says is working in this checkout. */
function lockedParticipants(repo: string): { id: string; agent: string }[] {
  return JSON.parse(readFileSync(lockPath(repo), 'utf8')).participants
}

const BRIEFED = /Another AI model — the advisor — is steering/

test('implementerSeats is the singular option when the plural one is absent, and the plural one otherwise', () => {
  const one = { id: 'implementer', agent: 'claude', role: 'implementer' } as const
  const two = { id: 'implementer-2', agent: 'codex', role: 'implementer' } as const

  assert.deepEqual(
    implementerSeats({ implementer: one }),
    [one],
    'a caller that never heard of `implementers` must get exactly the seat it named',
  )
  assert.deepEqual(
    implementerSeats({ implementer: one, implementers: [one, two] }),
    [one, two],
    'the plural option, when given, is the whole seat list',
  )
  // `undefined` is not `[]`: an explicitly-undefined field is the absent case, because that is
  // how every optional in `RelayOptions` is spread in at both front-ends.
  assert.deepEqual(
    implementerSeats({ implementer: one, implementers: undefined }),
    [one],
    'an explicitly undefined `implementers` is the absent case, not an empty run',
  )
})

test('naming the one implementer plurally builds the identical relay', async () => {
  const singularRepo = tempRepo()
  const pluralRepo = tempRepo()
  const spec = { id: 'implementer', agent: 'impl', role: 'implementer' } as const
  const lead = { id: 'advisor', agent: 'lead', role: 'advisor' } as const
  try {
    const build = async (repo: string, plural: boolean): Promise<Relay> =>
      Relay.start({
        registry: registryOf({
          lead: new FakeRotationSession('lead-1', 'lead', ['DONE']),
          impl: new FakeRotationSession('impl-1', 'impl', []),
        }),
        cwd: repo,
        lead,
        implementer: spec,
        ...(plural ? { implementers: [spec] } : {}),
      })

    const singular = await build(singularRepo, false)
    const plural = await build(pluralRepo, true)
    try {
      const shape = (r: Relay) => r.participants.map((p) => ({ id: p.id, agent: p.agent, rank: p.rank, role: p.role }))
      assert.deepEqual(
        shape(plural),
        shape(singular),
        'the same seat named plurally must produce the same participants, in the same order',
      )
      assert.deepEqual(
        joinNotes(plural.log),
        joinNotes(singular.log),
        'the join notes an operator reads at startup must be unchanged',
      )
      assert.deepEqual(
        lockedParticipants(pluralRepo),
        lockedParticipants(singularRepo),
        'the session lock must name the same participants either way',
      )
      assert.deepEqual(
        shape(singular).map((p) => p.id),
        ['advisor', 'implementer'],
        'a default run still has exactly the two seats it has always had',
      )
    } finally {
      await singular.stop()
      await plural.stop()
    }
  } finally {
    rmSync(singularRepo, { recursive: true, force: true })
    rmSync(pluralRepo, { recursive: true, force: true })
  }
})

test('two implementer seats are both joined, both briefed, both locked and both reported', async () => {
  const repo = tempRepo()
  const lead = new FakeRotationSession('lead-1', 'lead', ['Do the thing.', 'DONE'])
  // `alpha` sorts first, so `seatFor` breaks the idle-time tie in its favour and the work
  // lands there. Which seat gets the task is not what this test is about -- that both exist,
  // were told what they are, and are in the record is.
  const alpha = new FakeRotationSession('alpha-1', 'alpha', ['ack', 'Did it.', 'NONE'])
  const beta = new FakeRotationSession('beta-1', 'beta', ['ack', 'NONE'])
  try {
    const relay = await Relay.start({
      registry: registryOf({ lead, alpha, beta }),
      cwd: repo,
      lead: { id: 'advisor', agent: 'lead', role: 'advisor' },
      implementer: { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
      implementers: [
        { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
        { id: 'seat-beta', agent: 'beta', role: 'implementer' },
      ],
      maxAdvisorTurns: 3,
    })
    try {
      assert.deepEqual(
        relay.participants.map((p) => p.id),
        ['advisor', 'seat-alpha', 'seat-beta'],
        'both implementer seats must be joined, after the lead and in configured order',
      )
      assert.deepEqual(
        relay.participants.map((p) => p.rank),
        ['advisor', 'implementer', 'implementer'],
        'both seats must be joined at implementer rank',
      )
      assert.deepEqual(
        joinNotes(relay.log),
        [
          'advisor joined as advisor (lead)',
          'seat-alpha joined as implementer (alpha)',
          'seat-beta joined as implementer (beta)',
        ],
        'the routing log must account for every seat that was started',
      )
      assert.deepEqual(
        lockedParticipants(repo),
        [
          { id: 'advisor', agent: 'lead' },
          { id: 'seat-alpha', agent: 'alpha' },
          { id: 'seat-beta', agent: 'beta' },
        ],
        'a seat missing from the lock is a writer the workspace guard cannot attribute a change to',
      )

      const outcome = await relay.run('Keep the work moving.')
      assert.equal(outcome.reason, 'done', 'the two-seat run must reach its end')

      // The briefing, per seat. A seat that was never briefed does not know it is in a relay,
      // and nothing about the run would say so.
      assert.match(alpha.received[0] ?? '', BRIEFED, 'the first seat must be briefed')
      assert.match(beta.received[0] ?? '', BRIEFED, 'the second seat must be briefed too')

      // The record an operator actually reads, built by the production assembler rather than
      // from the participant list directly.
      const report = await runReport(relay, {
        goal: 'Keep the work moving.',
        outcome,
        startedAt: Date.now(),
        build: 'test',
      })
      assert.deepEqual(
        report.participants.map((p) => p.id).sort(),
        ['advisor', 'seat-alpha', 'seat-beta'],
        'the run report must carry every seat',
      )
      assert.deepEqual(
        report.deadlines.participants.map((p) => p.id).sort(),
        ['advisor', 'seat-alpha', 'seat-beta'],
        'every seat must be measured against declared deadlines',
      )
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('both seats get the closing question, so neither loses its last word', async () => {
  const repo = tempRepo()
  const lead = new FakeRotationSession('lead-1', 'lead', ['Do the thing.', 'DONE'])
  const alpha = new FakeRotationSession('alpha-1', 'alpha', ['ack', 'Did it.', 'NONE'])
  const beta = new FakeRotationSession('beta-1', 'beta', ['ack', 'FLAG: I was never given anything to do.'])
  try {
    const relay = await Relay.start({
      registry: registryOf({ lead, alpha, beta }),
      cwd: repo,
      lead: { id: 'advisor', agent: 'lead', role: 'advisor' },
      implementer: { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
      implementers: [
        { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
        { id: 'seat-beta', agent: 'beta', role: 'implementer' },
      ],
      maxAdvisorTurns: 3,
    })
    try {
      await relay.run('Keep the work moving.')
      // The idle seat's flag is the sharp end of this: it is reachable only by asking a seat
      // that was never dispatched to, which a single-seat closing question cannot do.
      assert.deepEqual(
        relay.flags.map((f) => f.participant),
        ['seat-beta'],
        'a seat that raised a flag at the close must be in the run summary',
      )
      const closing = relay.log.filter((m) => m.kind === 'note' && m.text.startsWith('closing statement:'))
      assert.deepEqual(
        closing.map((m) => m.from).sort(),
        ['seat-alpha', 'seat-beta'],
        'every seat that worked must be asked for its last word',
      )
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a seat list that cannot be resolved to seats is refused at start rather than half-built', async () => {
  const repo = tempRepo()
  const registry = registryOf({
    lead: new FakeRotationSession('lead-1', 'lead', []),
    impl: new FakeRotationSession('impl-1', 'impl', []),
  })
  const base = {
    registry,
    cwd: repo,
    lead: { id: 'advisor', agent: 'lead', role: 'implementer' as const },
    implementer: { id: 'implementer', agent: 'impl', role: 'implementer' as const },
  }
  try {
    await assert.rejects(
      () => Relay.start({ ...base, lead: { ...base.lead, role: 'advisor' }, implementers: [] }),
      /at least one implementer seat/,
      'a run with no implementer has nobody to do the work, and must say so',
    )
    await assert.rejects(
      () =>
        Relay.start({
          ...base,
          lead: { ...base.lead, role: 'advisor' },
          implementers: [
            { id: 'implementer', agent: 'impl', role: 'implementer' },
            { id: 'implementer', agent: 'impl', role: 'implementer' },
          ],
        }),
      /duplicate participant id 'implementer'/,
      'a duplicate id would overwrite a live seat in the participant map, silently',
    )
    await assert.rejects(
      () =>
        Relay.start({
          ...base,
          lead: { ...base.lead, role: 'advisor' },
          implementers: [{ id: 'someone-else', agent: 'impl', role: 'implementer' }],
        }),
      /must include the lead implementer 'implementer'/,
      'the singular option is read by name, so a seat list omitting it leaves that read dangling',
    )
    // The advisor is a participant too, and colliding with it is the same failure.
    await assert.rejects(
      () =>
        Relay.start({
          ...base,
          lead: { id: 'implementer', agent: 'lead', role: 'advisor' },
          implementers: [{ id: 'implementer', agent: 'impl', role: 'implementer' }],
        }),
      /duplicate participant id 'implementer'/,
      'a seat id colliding with the lead must be refused as well',
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('rotateImplementer refuses to pick a seat when the run has more than one', async () => {
  const repo = tempRepo()
  const lead = new FakeRotationSession('lead-1', 'lead', [])
  const alpha = new FakeRotationSession('alpha-1', 'alpha', [])
  const beta = new FakeRotationSession('beta-1', 'beta', [])
  try {
    const relay = await Relay.start({
      registry: registryOf({ lead, alpha, beta }),
      cwd: repo,
      lead: { id: 'advisor', agent: 'lead', role: 'advisor' },
      implementer: { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
      implementers: [
        { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
        { id: 'seat-beta', agent: 'beta', role: 'implementer' },
      ],
      // Armed, so the refusal below is about the seat count and not about a missing config.
      rotation: { checks: ['exit 0'] },
    })
    try {
      await assert.rejects(
        () => relay.rotateImplementer('it went quiet'),
        /names no seat, and this run has 2 \(seat-alpha, seat-beta\)/,
        'rotating "the implementer" when there are two would retire a session nobody asked about',
      )
      // Nothing was started or retired by the refusal.
      assert.equal(alpha.state, 'running', 'the refusal must not have touched the first seat')
      assert.equal(beta.state, 'running', 'the refusal must not have touched the second seat')
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a degraded seat in a multi-seat run is REPLACED, and its sibling is not disturbed (#78)', async () => {
  // Three behaviours in one run, because they are one behaviour seen from three sides.
  //
  // This test has been rewritten twice, and both earlier versions are worth knowing about. The
  // first asserted a THROW: `#considerRotation` called `rotateImplementer`, which refuses at
  // N>1, and `#loop`'s catch reported the run as `transport_failed: rotateImplementer names no
  // seat...` -- a transport fault for a missing feature, which sends the operator to look at
  // child processes that are fine (#74). The second asserted the DECLINE that replaced it: the
  // seat stayed in service and the human was told why, which was correct and was still a run
  // that could not protect itself.
  //
  // #78 is the feature. Rotation names the degraded seat, replaces that seat's session, and
  // leaves the other seats alone -- so what is asserted here is the rotation happening AND the
  // sibling being untouched by it. The other seat is the whole point: a rotation is not a
  // run-wide event.
  const repo = tempRepo()
  const lead = new FakeRotationSession('lead-1', 'lead', [
    '@seat seat-alpha: Do the thing.',
    // The handoff turn. The advisor writes the narrative when the transaction asks for it, and
    // it is scripted here rather than in the run's ordinary replies because that is what it is:
    // an exchange the rotation initiates, in the middle of an advisor turn.
    HANDOFF,
    'DONE',
    'DONE',
  ])
  const alpha = new FakeRotationSession('alpha-1', 'alpha', ['ack', 'Did it.', 'NONE', 'NONE'])
  const alphaNext = new FakeRotationSession('alpha-2', 'alpha', [ACCEPTED, 'NONE', 'NONE'])
  const beta = new FakeRotationSession('beta-1', 'beta', ['ack', 'NONE', 'NONE'])
  const creates: { id: string; cwd: string; nth: number }[] = []
  try {
    const relay = await Relay.start({
      registry: registryOfQueues({ lead: [lead], alpha: [alpha, alphaNext], beta: [beta] }, creates),
      cwd: repo,
      lead: { id: 'advisor', agent: 'lead', role: 'advisor' },
      implementer: { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
      implementers: [
        { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
        { id: 'seat-beta', agent: 'beta', role: 'implementer' },
      ],
      maxAdvisorTurns: 4,
      // Set to ACT, which is the only configuration that reaches the rotation call at all: the
      // default records a candidate and returns before it.
      rotation: { checks: ['exit 0'], checkTimeoutMs: 30_000, onDegradation: 'automatic' },
    })
    try {
      // Turn 0 is the briefing, so turn 1 is the first turn that does work. Compaction alone
      // is degradation -- a session may compact without saying so.
      alpha.compactOnTurn = 1
      const outcome = await relay.run('Keep the work moving.')

      assert.notEqual(
        outcome.reason,
        'transport_failed',
        'a policy gap reported as a transport fault sends the operator to the wrong place entirely',
      )
      assert.notEqual(outcome.reason, 'escalated', 'a seat that CAN be replaced does not need a human')

      // The transfer happened, to the seat that degraded and to no other.
      assert.equal(relay.rotationWatch.rotations, 1, 'the degraded seat was replaced')
      assert.equal(alpha.state, 'terminated', 'the degraded session is retired once the replacement proved itself')
      assert.equal(
        relay.participants.find((p) => p.id === 'seat-alpha')!.session,
        alphaNext,
        'and the seat is now running the replacement, under the same id',
      )
      assert.ok(relay.log.some((m) => /^rotating seat-alpha/.test(m.text)))

      // THE SIBLING. Not quiesced, not retired, not replaced, and never spoken to about any of
      // it: a rotation that touched the other seats would be a run-wide event wearing a seat's
      // name, and the seat it disturbed would have lost a session for somebody else's problem.
      assert.equal(beta.state, 'running', 'the other seat keeps its session')
      assert.equal(relay.participants.find((p) => p.id === 'seat-beta')!.session, beta)
      assert.deepEqual(beta.transitions, [], 'and was not put through any of the transaction’s states')
      assert.ok(
        !beta.received.some((m) => /handoff|CHECK 1/i.test(m)),
        'nor was it asked to take part in another seat’s transfer',
      )

      // The replacement was verified in seat-alpha's OWN tree, which is the other half of
      // "seat-local": a transfer measured in the integration checkout would be measuring work
      // this seat never did.
      const tree = relay.worktrees!.seats.find((s) => s.seatId === 'seat-alpha')!.worktreePath
      assert.ok(
        relay.log.some((m) => m.text.includes('handoff recorded')),
        'the record was captured',
      )
      assert.equal(
        creates.find((c) => c.id === 'seat-alpha' && c.nth === 2)?.cwd,
        tree,
        'the replacement must be started in the tree of the seat it replaces',
      )
      // The detector still ran and still saw it. Acting is not a substitute for looking.
      assert.ok(relay.rotationWatch.degradationsSeen >= 1, 'the degradation was seen and counted')
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
