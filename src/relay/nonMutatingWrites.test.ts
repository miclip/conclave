/**
 * A seat whose ROLE says it does not write, and the tree changing during its turn.
 *
 * `mutatesWorkspace` has been a declaration and nothing else since roles became data: the
 * registry records that an advisor, a reviewer and an arbiter are not expected to modify the
 * workspace, and no part of the run ever looked. Nothing CAN enforce it -- the repository
 * cannot tell one writer's edit from another's (#8) -- but the per-turn diff the relay already
 * takes for a lost report (#39) is the same diff that would notice, and it was being thrown
 * away.
 *
 * So this is an observation, and these tests are about it being exactly that:
 *
 *   - it reaches the routing log and the observation stream, naming the seat, its role and the
 *     paths, and saying in the same sentence that a shared root does not establish who wrote
 *     them;
 *   - it changes NOTHING. The run ends on the same outcome, at the same turn, with no pause;
 *   - and when no such write happens, the report key is absent altogether and the stream
 *     carries no such text. An empty array would read as "we looked and found nothing", which
 *     the per-turn diff is not able to say -- it sees only paths that BECAME dirty, and only
 *     inside a turn.
 *
 * The advisor is the seat used throughout because it is the one every run has, and because at
 * N=1 its root IS the operator's checkout -- the sharp case, where the observation is at its
 * least conclusive and must say so.
 *
 *   node --test src/relay/nonMutatingWrites.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import type { RoleDefinition } from '../registry/roles.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import type { RelayEvent } from './observe.ts'
import { Relay } from './relay.ts'
import { runReport } from './report.ts'

/** The stable half of the note's wording, so a test matches the claim and not the prose. */
const MARKER = 'declared not to write to the workspace'

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-nonmutating-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'work.ts'), 'export const answer = 42\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

function registryOf(sessions: Record<string, AgentSession>): AgentRegistry {
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

async function drain(stream: AsyncIterable<RelayEvent>): Promise<RelayEvent[]> {
  const out: RelayEvent[] = []
  for await (const e of stream) out.push(e)
  return out
}

const GOAL = 'Keep the work moving.'

/**
 * One default run, with the advisor optionally writing into the shared checkout mid-turn.
 *
 * `onSend` fires inside the fake's `send`, which is after the relay has snapshotted the tree
 * for that turn and before the turn ends -- the window a real child writes in, and the only
 * window this diff can see at all.
 */
async function defaultRun(repo: string, advisorWrites?: (dir: string) => void) {
  // The advisor's first reply carries a FLAG on the same turn it writes, which is what makes
  // the note's POSITION in the log observable: `#raiseFlag` numbers each flag by the log length
  // at the moment it is raised, so an observation recorded before the flag loop would take the
  // position the flag is meant to point at.
  const advisor = new FakeRotationSession('advisor-1', 'fake-advisor', [
    'Do the work.\n\nFLAG: the tree was not inspected before starting.',
    'DONE',
  ])
  const impl = new FakeRotationSession('impl-1', 'fake-impl', ['ack', 'Did it.', 'NONE'])
  if (advisorWrites) {
    let done = false
    advisor.onSend = () => {
      if (done) return
      done = true
      advisorWrites(repo)
    }
  }
  const relay = await Relay.start({
    registry: registryOf({ 'fake-advisor': advisor, 'fake-impl': impl }),
    cwd: repo,
    lead: { id: 'advisor', agent: 'fake-advisor', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'fake-impl', role: 'implementer' },
    maxAdvisorTurns: 4,
  })
  const collected = drain(relay.observe())
  const outcome = await relay.run(GOAL)
  const events = await collected
  const report = await runReport(relay, { goal: GOAL, outcome, startedAt: Date.now(), build: 'test' })
  await relay.stop()
  return { relay, outcome, events, report }
}

/** The observation as it appears on the stream, which is where a live viewer would see it. */
function streamedNotes(events: RelayEvent[]): string[] {
  return events
    .filter((e) => e.type === 'message' && e.message.kind === 'note' && e.message.text.includes(MARKER))
    .map((e) => (e as Extract<RelayEvent, { type: 'message' }>).message.text)
}

/**
 * Two tests, and that is deliberate rather than tidy.
 *
 * Every assertion here is pinned by a production mutation that fails THIS test and no other in
 * the repository, and the structure is what makes that possible. All positive observation lives
 * in one test because the scenarios were re-proving one production path from three angles: a
 * mutation to the note's wording failed three tests at once, which measures duplication rather
 * than coverage. The cost is honest and worth stating -- when this test fails it does not say
 * which scenario broke, and the assertion messages have to carry that instead.
 *
 * Two things this file deliberately does NOT assert, because `defaultUnchanged.test.ts` already
 * owns them and a second copy here is what stopped either being isolatable:
 *
 *   - that a quiet default run's report has no `unexpectedWrites` key. That file pins the report's
 *     exact key set at every depth, so the key appearing is a failure there.
 *   - that a quiet default run says nothing. Same pin reaches it: a note fired on a turn that
 *     changed nothing would put the key on a default run's report.
 */

/** A role the registry is GIVEN, which no built-in map has heard of. Seated at rank implementer. */
const AUDITOR: RoleDefinition = {
  id: 'auditor',
  displayName: 'Auditor',
  description: 'Reads the tree and reports on it. Writes nothing.',
  contextPolicy: 'thin',
  mutatesWorkspace: false,
  defaultInputOwnership: 'mediated',
  isModel: true,
}

test('a seat whose role does not write, writing: both surfaces, every path, and nothing else changed', async () => {
  // ---- run one: a BUILT-IN non-writing role, nine paths, and a flag on the same turn ----
  //
  // Nine because it is the smallest number that puts a path past a cap of eight, which is what
  // the note used to truncate at while the report carried the whole list -- two surfaces
  // disagreeing about the same fact. `git status` orders by path, so `dirty-09.txt` is the tail
  // and the first thing any cap drops.
  const repo = tempRepo()
  try {
    const paths = Array.from({ length: 9 }, (_, i) => `dirty-${String(i + 1).padStart(2, '0')}.txt`)
    const { relay, outcome, events, report } = await defaultRun(repo, (dir) => {
      for (const f of paths) writeFileSync(join(dir, f), `${f}\n`)
    })

    // The stream: what a console or a recorder attached to the run receives.
    const streamed = streamedNotes(events)
    assert.equal(streamed.length, 1, 'one turn changed the tree, so exactly one observation')
    const note = streamed[0]!
    assert.match(note, /^advisor is seated in role 'advisor'/, 'the note names the participant and the role')
    assert.match(note, /9 path\(s\) became dirty/, 'and how many paths it saw')
    for (const f of paths) assert.ok(note.includes(f), `${f} must be named on the stream; note was: ${note}`)
    assert.match(
      note,
      /that root is shared with the other participants, so it narrows who wrote them not at all/,
      'the uncertainty is in the same sentence as the claim, not left to a reader to supply',
    )
    assert.match(
      note,
      /Evidence, not a verdict: nothing here identifies the writer/,
      'and the caveat is unconditional, not a property of this run happening to share a root',
    )

    // The envelope, as one claim: an orchestrator note that was delivered to nobody.
    const entry = relay.log.find((m) => m.text.includes(MARKER))!
    assert.deepEqual(
      { kind: entry.kind, from: entry.from, to: entry.to },
      { kind: 'note', from: 'orchestrator', to: [] },
      'for the record and the human; no participant is told',
    )

    // The report, whole -- including the `seq` pairing it to the note and the same nine paths,
    // which is the two surfaces agreeing rather than each being checked alone.
    assert.deepEqual(report.unexpectedWrites, [
      { participant: 'advisor', role: 'advisor', seq: entry.seq, paths, sharedRoot: true },
    ])

    // The note is recorded AFTER the turn's flags, so a flag still points at the message that
    // preceded it rather than at an observation about the same turn.
    // Non-null like `entry` above rather than an `assert.ok` narrowing it: a guard that only
    // exists to satisfy the type is an assertion no mutation pins, and an absent flag fails this
    // line just as loudly.
    const flag = [...report.flags, ...report.supersededFlags].find((f) => f.participant === 'advisor')!
    assert.equal(flag.seq, entry.seq - 1, 'the observation takes the position after the flag, never the flag own')

    // And the run is untouched by all of it.
    assert.equal(outcome.reason, 'done', 'an observation does not change how the run ended')
    assert.equal(relay.log.filter((m) => m.text.startsWith('paused (')).length, 0, 'and it pauses nothing')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }

  // ---- run two: a role the REGISTRY WAS HANDED, which no built-in map has heard of ----
  //
  // The case a built-ins-only lookup gets wrong while looking like it works. `AgentRegistry`
  // takes an arbitrary `RoleDefinition` through `registerRole`, validates every seat against
  // exactly that map, and answers `roleOf` from it -- so `mutatesWorkspace: false` is reachable
  // on any role id at all, and a check that fell back to a default for ids it did not recognise
  // would miss every custom non-writing role there is while still passing on `advisor`.
  //
  // Seated at rank `implementer`, so the run's only writing-RANK seat is one whose role says it
  // does not write. That is also what makes this the run that fails if the check is ever asked
  // about the rank instead of the role.
  const repo2 = tempRepo()
  try {
    const advisor = new FakeRotationSession('advisor-1', 'fake-advisor', ['Do the work.', 'DONE'])
    const auditor = new FakeRotationSession('auditor-1', 'fake-auditor', ['ack', 'Did it.', 'NONE'])
    auditor.onSend = () => writeFileSync(join(repo2, 'auditor-edit.ts'), 'export const x = 1\n')
    const registry = registryOf({ 'fake-advisor': advisor, 'fake-auditor': auditor })
    registry.registerRole(AUDITOR)

    const relay = await Relay.start({
      registry,
      cwd: repo2,
      lead: { id: 'advisor', agent: 'fake-advisor', role: 'advisor' },
      implementer: { id: 'auditor', agent: 'fake-auditor', role: 'auditor' },
      maxAdvisorTurns: 4,
    })
    try {
      const outcome = await relay.run(GOAL)
      const report = await runReport(relay, { goal: GOAL, outcome, startedAt: Date.now(), build: 'test' })
      assert.deepEqual(
        report.unexpectedWrites?.map((w) => ({ participant: w.participant, role: w.role, paths: w.paths })),
        [{ participant: 'auditor', role: 'auditor', paths: ['auditor-edit.ts'] }],
        'a role the registry was handed is checked exactly like one it was born with',
      )
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo2, { recursive: true, force: true })
  }

  // ---- run three: the seat has a worktree of its OWN, and that still does not name the writer ----
  //
  // The note used to say an assigned root was "${seat}'s own worktree, which nobody else is
  // working in". Not observable, and contradicted by this project's own briefing: a subagent
  // that modifies anything is sent to work in a worktree, checks run there, and nothing stops
  // the operator opening it. So `sharedRoot: false` narrows the writer to whoever works in that
  // tree and stops there, and the note has to say the narrowing rather than a name.
  //
  // Two implementer seats, because that is what makes the relay create linked worktrees at all;
  // the auditor's is read back off the manifest after `start` so the write lands where the
  // adapter was actually launched.
  const repo3 = tempRepo()
  try {
    const advisor = new FakeRotationSession('advisor-1', 'fake-advisor', ['Do the work.', 'DONE'])
    const auditor = new FakeRotationSession('auditor-1', 'fake-auditor', ['ack', 'Did it.', 'NONE'])
    const other = new FakeRotationSession('other-1', 'fake-impl', ['ack', 'NONE', 'NONE'])
    const registry = registryOf({ 'fake-advisor': advisor, 'fake-auditor': auditor, 'fake-impl': other })
    registry.registerRole(AUDITOR)

    const seats = [
      { id: 'auditor', agent: 'fake-auditor', role: 'auditor' },
      { id: 'other', agent: 'fake-impl', role: 'implementer' },
    ]
    const relay = await Relay.start({
      registry,
      cwd: repo3,
      lead: { id: 'advisor', agent: 'fake-advisor', role: 'advisor' },
      implementer: seats[0]!,
      implementers: seats,
      maxAdvisorTurns: 4,
    })
    try {
      // No assertion that this differs from `repo3`: it is not a claim about the observation,
      // and it cannot pass wrongly. A run with no worktrees throws on the `!` above, and a root
      // equal to the checkout makes `sharedRoot` true, which the assertion below already fails on.
      const tree = relay.worktrees!.seats.find((s) => s.seatId === 'auditor')!.worktreePath
      auditor.onSend = () => writeFileSync(join(tree, 'in-my-own-tree.ts'), 'export const x = 1\n')

      await relay.run(GOAL)

      const observed = relay.unexpectedWrites().find((w) => w.participant === 'auditor')!
      assert.equal(observed.sharedRoot, false, 'a root assigned to one seat is not the shared checkout')
      const note = relay.log.find((m) => m.text.includes(MARKER) && m.text.includes('auditor'))!.text
      assert.match(
        note,
        /that root is the worktree assigned to auditor, which narrows who could have written them to whoever works in that tree — the seat, but also its subagents, a check, or the operator/,
        'an assigned worktree narrows the writer and never establishes one',
      )
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo3, { recursive: true, force: true })
  }
})

/**
 * A seat doing the job it was seated for, built-in and custom in one test.
 *
 * Both runs in one test for the same reason the positive scenarios share one: `implementer` and
 * a registered `frontend` are decided by the same expression, so no production mutation can
 * separate them, and as two tests they would be a pair that always fails together.
 */
test('a writing role is not observed, built-in or custom', async () => {
  const writingRoles: { seat: string; agent: string; role: string; register?: RoleDefinition }[] = [
    { seat: 'implementer', agent: 'fake-impl', role: 'implementer' },
    { seat: 'frontend', agent: 'fake-frontend', role: 'frontend', register: { ...AUDITOR, id: 'frontend', displayName: 'Frontend', mutatesWorkspace: true } },
  ]
  for (const { seat, agent, role, register } of writingRoles) {
    const repo = tempRepo()
    try {
      const advisor = new FakeRotationSession('advisor-1', 'fake-advisor', ['Do the work.', 'DONE'])
      const worker = new FakeRotationSession(`${seat}-1`, agent, ['ack', 'Did it.', 'NONE'])
      worker.onSend = () => writeFileSync(join(repo, `${seat}-work.ts`), 'export const x = 1\n')
      const registry = registryOf({ 'fake-advisor': advisor, [agent]: worker })
      if (register) registry.registerRole(register)
      const relay = await Relay.start({
        registry,
        cwd: repo,
        lead: { id: 'advisor', agent: 'fake-advisor', role: 'advisor' },
        implementer: { id: seat, agent, role },
        maxAdvisorTurns: 4,
      })
      try {
        await relay.run(GOAL)
        assert.deepEqual(
          { observed: relay.unexpectedWrites().length, noted: relay.log.some((m) => m.text.includes(MARKER)) },
          { observed: 0, noted: false },
          `a seat in role '${role}' is doing what it was seated for, and that is not a finding`,
        )
      } finally {
        await relay.stop()
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }
})
