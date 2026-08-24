/**
 * Attribution when the participants no longer share a directory.
 *
 * Artifact attribution answers "what did this restricted message cause", and it answered it by
 * diffing ONE tree — the integration checkout — whoever was working where. At N>1 that is
 * wrong in both directions at once: uncommitted work in a linked worktree is invisible from the
 * integration checkout, so a seat's real artifacts are missed; and anything that becomes dirty
 * in the integration checkout, including another seat's merge, is offered up as this seat's
 * work. Neither failure announces itself.
 *
 * The model is the ROOT, never the seat count. Participants sharing a root share a snapshot and
 * an evidence group, which is every participant at N=1 — so the default run takes the identical
 * path it always did, and the last test here is the one that says so.
 *
 *   node --test src/relay/seatAttribution.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AsyncQueue } from '../adapters/asyncQueue.ts'
import type { AgentEvent, AgentSession, CloseMode, SessionSnapshot, SessionState, TurnKey } from '../contract/session.ts'
import { guaranteesFor, turnKey } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import type { CreateParticipantContext, ResolvedParticipant } from '../registry/types.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { evidenceForRoot, recordAttribution, type RestrictedOrigin } from './authority.ts'
import { Relay } from './relay.ts'
import { runReport } from './report.ts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-attr-'))
  git(dir, 'init', '--quiet')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'init', '--quiet')
  return dir
}

/** What one turn does: write a file into this session's own cwd, and say it named it. */
interface Work {
  /** Relative to the session's cwd — the same string for two seats is the whole point. */
  file: string
  content: string
  /** Extra paths to put in the tool input without touching them. Evidence without an artifact. */
  alsoNames?: string[]
}

/**
 * A session that writes through its OWN cwd and records the tool input that named the file.
 *
 * Both halves are needed for attribution to run at all: the candidate comes from `git status`
 * in the root, and the corroboration comes from `snapshot().turns[].toolCalls[].args`. A fake
 * that only spoke could never exercise this path, which is why nothing did before.
 */
class ToolingFakeSession implements AgentSession {
  readonly guarantees = guaranteesFor('mediated')
  readonly received: string[] = []
  readonly agent: string
  readonly sessionId: string
  state: SessionState = 'running'
  cwd = ''
  /** Called per turn; returning nothing means a turn that changed nothing. */
  work: ((message: string) => Work | undefined) | undefined
  #replies: string[]
  /**
   * The one delivery mechanism, shared with the adapters rather than reimplemented.
   *
   * Every double in this project used to carry its own copy of a single-consumer queue, and every
   * copy had the same hole: nothing ended the iteration, so a consumer's `for await` parked
   * forever after `close()`. `AgentSession.events()` is required to END once `close()` has
   * returned -- `Relay.stop()` waits for exactly that before it calls a turn abandoned (#143) --
   * and a double that cannot do it is a double that cannot be stopped.
   */
  #events = new AsyncQueue<AgentEvent>()
  #seq = 0
  #turns: { key: TurnKey; prose: string; calls: { tool: string; failed: boolean; args?: string }[] }[] = []

  constructor(sessionId: string, agent: string, replies: string[] = []) {
    this.sessionId = sessionId
    this.agent = agent
    this.#replies = [...replies]
  }

  async send(message: string): Promise<TurnKey> {
    this.received.push(message)
    const key = turnKey(`${this.sessionId}-turn-${this.#turns.length}`)
    const todo = this.work?.(message)
    const calls: { tool: string; failed: boolean; args?: string }[] = []
    if (todo) {
      writeFileSync(join(this.cwd, todo.file), todo.content)
      // An absolute path in a structured tool input: `named_path` support, and the same shape
      // OpenCode and Kimi emit on every edit.
      calls.push({
        tool: 'Write',
        failed: false,
        args: JSON.stringify({ file_path: join(this.cwd, todo.file), ...(todo.alsoNames ? { also: todo.alsoNames } : {}) }),
      })
    }
    this.#turns.push({ key, prose: this.#replies.shift() ?? 'NONE', calls })
    this.#emit({
      type: 'turn_end',
      verdict: { outcome: 'completed', confidence: 'proven', provenance: [{ source: 'hook', detail: 'Stop' }] },
      synthesized: false,
      turnKey: key,
      seq: ++this.#seq,
      at: Date.now(),
      provisional: false,
    })
    return key
  }

  #emit(e: AgentEvent): void {
    this.#events.push(e)
  }

  events(): AsyncIterable<AgentEvent> {
    return this.#events
  }

  async snapshot(): Promise<SessionSnapshot> {
    return {
      sessionId: this.sessionId,
      agent: this.agent,
      cwd: this.cwd,
      turns: this.#turns.map((t) => ({
        key: t.key,
        prompt: '',
        // An empty reply models a transcript that never finished the turn, which is what the
        // relay reads `unsettled` from — a turn whose hook proved it ended and whose body
        // never arrived. Anything with prose settled normally.
        state: t.prose === '' ? ('in_progress' as const) : ('completed' as const),
        assistantText: t.prose,
        report: undefined,
        toolCalls: t.calls,
      })),
      guarantees: this.guarantees,
      compactionGeneration: 0,
      builtAt: Date.now(),
    }
  }

  async quiesce(): Promise<void> {
    this.state = 'quiesced'
  }
  async unquiesce(): Promise<void> {
    this.state = 'running'
  }
  async beginRotation(): Promise<void> {
    this.state = 'rotating'
  }
  async cancel(): Promise<TurnKey | undefined> {
    return undefined
  }
  async decidePermission(): Promise<void> {}
  async fork(): Promise<AgentSession> {
    throw new Error('not implemented')
  }
  async close(_mode: CloseMode = 'graceful'): Promise<void> {
    this.state = 'terminated'
    // The stream ENDS with the session, which is the half of the contract every one of these
    // doubles used to omit. See `#events`.
    this.#events.close()
  }
}

function registryOf(sessions: Record<string, ToolingFakeSession>): AgentRegistry {
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
      async create(_res: ResolvedParticipant, ctx: CreateParticipantContext) {
        // The REAL cwd, so every write below goes where the adapter was actually launched.
        session.cwd = ctx.cwd
        return session
      },
    })
  }
  return r
}

const LEAD = { id: 'advisor', agent: 'lead', role: 'advisor' } as const
const SEATS = [
  { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
  { id: 'seat-beta', agent: 'beta', role: 'implementer' },
] as const

async function twoSeats(repo: string, sessions: { lead: ToolingFakeSession; alpha: ToolingFakeSession; beta: ToolingFakeSession }) {
  return Relay.start({
    registry: registryOf({ lead: sessions.lead, alpha: sessions.alpha, beta: sessions.beta }),
    cwd: repo,
    lead: LEAD,
    implementer: SEATS[0],
    implementers: [...SEATS],
    maxAdvisorTurns: 4,
  })
}

test('a seat artifacts are read from its own tree, and named with the seat that wrote them', async () => {
  const repo = tempRepo()
  const lead = new ToolingFakeSession('lead-1', 'lead', ['Write the notes.', 'DONE'])
  const alpha = new ToolingFakeSession('alpha-1', 'alpha', ['ack', 'Wrote them.', 'NONE'])
  const beta = new ToolingFakeSession('beta-1', 'beta', ['ack', 'NONE'])
  try {
    const relay = await twoSeats(repo, { lead, alpha, beta })
    try {
      // Only the file the aside asked for, and only on the working turn. `alsoNames` puts a
      // path into the tool input that this seat never created in its own tree — the sharp case
      // below.
      alpha.work = (message) =>
        message.includes('Write the notes')
          ? { file: 'notes.md', content: 'from alpha\n', alsoNames: [join(repo, 'operator.txt')] }
          : undefined

      const run = relay.start('Keep the work moving.')
      relay.say('Put the migration notes in notes.md.', { only: 'seat-alpha' }, 'aside')
      await run.settled()

      const origin = relay.restrictedOrigins.at(-1)!
      assert.deepEqual(
        origin.attributions,
        [{ path: 'notes.md', support: 'named_path', seat: 'seat-alpha', confidence: 'observed' }],
        'a path found in a seat own worktree is attributed to that seat, and the tree proves it',
      )
      // The file is in the seat's tree and nowhere else — which is exactly why the integration
      // checkout could not have supplied this candidate.
      const tree = relay.worktrees!.seats.find((s) => s.seatId === 'seat-alpha')!.worktreePath
      assert.ok(existsSync(join(tree, 'notes.md')))
      // It reached the integration checkout only AFTERWARDS, through the boundary merge, and as
      // a commit rather than a dirty path — attribution runs before the boundary. So at the
      // moment the candidates were read, this file could not have been one there, which is the
      // whole property the seat-scoped diff provides.
      assert.equal(git(repo, 'status', '--porcelain').trim(), '', 'nothing arrives here uncommitted')
      assert.match(git(repo, 'log', '--format=%B', '-1'), /Conclave-Seat: seat-alpha/)
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a change in the integration checkout is not swept into a seat attribution', async () => {
  const repo = tempRepo()
  const lead = new ToolingFakeSession('lead-1', 'lead', ['Write the notes.', 'DONE'])
  const alpha = new ToolingFakeSession('alpha-1', 'alpha', ['ack', 'Wrote them.', 'NONE'])
  const beta = new ToolingFakeSession('beta-1', 'beta', ['ack', 'NONE'])
  try {
    const relay = await twoSeats(repo, { lead, alpha, beta })
    try {
      alpha.work = (message) =>
        message.includes('Write the notes')
          ? { file: 'notes.md', content: 'from alpha\n', alsoNames: ['operator.txt'] }
          : undefined

      const run = relay.start('Keep the work moving.')
      relay.say('Put the migration notes in notes.md.', { only: 'seat-alpha' }, 'aside')
      // The operator, editing their own checkout while the run is going. `operator.txt` is even
      // NAMED in the seat's tool input, so evidence alone would attribute it — the only thing
      // that keeps it out is that candidates come from the seat's root and not from here.
      writeFileSync(join(repo, 'operator.txt'), 'the human was working too\n')
      await run.settled()

      const origin = relay.restrictedOrigins.at(-1)!
      assert.deepEqual(origin.artifacts, ['notes.md'])
      assert.ok(
        !origin.attributions.some((a) => a.path === 'operator.txt'),
        'the integration checkout is never scanned for a seat artifacts, however well evidenced',
      )
      assert.equal(git(repo, 'status', '--porcelain').trim(), '?? operator.txt', 'and it really was dirty')
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a seat that was never told is not evidence, and its tree is not read', async () => {
  const repo = tempRepo()
  const lead = new ToolingFakeSession('lead-1', 'lead', ['Write the notes.', 'Now you write them.', 'DONE'])
  const alpha = new ToolingFakeSession('alpha-1', 'alpha', ['ack', 'Wrote them.', 'NONE'])
  const beta = new ToolingFakeSession('beta-1', 'beta', ['ack', 'Wrote them too.', 'NONE'])
  try {
    const relay = await twoSeats(repo, { lead, alpha, beta })
    try {
      // BETA writes the file the aside asked about, and beta was never told about the aside.
      // Same filename, same tool input shape, its own tree.
      beta.work = (message) => (message.includes('write them') ? { file: 'notes.md', content: 'from beta\n' } : undefined)
      alpha.work = () => undefined

      const run = relay.start('Keep the work moving.')
      relay.say('Put the migration notes in notes.md.', { only: 'seat-alpha' }, 'aside')
      await run.settled()

      const origin = relay.restrictedOrigins.at(-1)!
      assert.deepEqual(origin.informed, ['seat-alpha'])
      assert.ok(origin.excluded.includes('seat-beta'))
      assert.deepEqual(
        origin.attributions,
        [],
        'a seat kept from the message cannot have acted on it, so its tree is not a source of its artifacts',
      )
      const betaTree = relay.worktrees!.seats.find((s) => s.seatId === 'seat-beta')!.worktreePath
      assert.ok(existsSync(join(betaTree, 'notes.md')), 'beta really did write the file it is not credited with')
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('the same relative path in two trees is two attributions, not one', () => {
  // At the record, because the relay cannot reach this state today: `Audience` addresses ONE
  // participant, so a single restricted message has one informed seat and therefore one root to
  // attribute in. The structure still has to be right — a map keyed by path collapses these two
  // into whichever was written last, and reports one seat work under the other name — and the
  // relay-level halves of it are the two tests above, each proving its own tree was the source.
  const origin: RestrictedOrigin = {
    seq: 1,
    at: 0,
    text: 'write notes.md',
    informed: ['seat-alpha', 'seat-beta'],
    excluded: [],
    tokens: [],
    artifacts: [],
    attributions: [],
    artifactSupport: {},
    reconciled: [],
  }
  recordAttribution(origin, { path: 'notes.md', support: 'named_path', seat: 'seat-alpha' })
  recordAttribution(origin, { path: 'notes.md', support: 'text_match', seat: 'seat-beta' })
  assert.deepEqual(origin.attributions, [
    { path: 'notes.md', support: 'named_path', seat: 'seat-alpha', confidence: 'observed' },
    { path: 'notes.md', support: 'text_match', seat: 'seat-beta', confidence: 'observed' },
  ])
  // The deduplicated view still has one entry, and that is what makes it a view: it is kept for
  // the readers written against it and `attributions` is the record.
  assert.deepEqual(origin.artifacts, ['notes.md'])

  // A repeat for the same (seat, path) upgrades support and never downgrades it: a substring
  // hit arriving after a tool named the file must not weaken the claim.
  recordAttribution(origin, { path: 'notes.md', support: 'text_match', seat: 'seat-alpha' })
  assert.equal(origin.attributions[0]!.support, 'named_path')
  recordAttribution(origin, { path: 'notes.md', support: 'named_path', seat: 'seat-beta' })
  assert.equal(origin.attributions[1]!.support, 'named_path')
  assert.equal(origin.attributions.length, 2, 'a repeat is an update, not a second row')

  // A shared root gets no seat and no upgrade, at any N.
  recordAttribution(origin, { path: 'notes.md', support: 'named_path', seat: null })
  assert.deepEqual(origin.attributions.at(-1), {
    path: 'notes.md',
    support: 'named_path',
    seat: null,
    confidence: 'reasoned_but_unverified',
  })
})

test('a default run attributes from the operator cwd, unnamed and un-upgraded', async () => {
  const repo = tempRepo()
  const lead = new ToolingFakeSession('lead-1', 'lead', ['Write the notes.', 'DONE'])
  const impl = new ToolingFakeSession('impl-1', 'impl', ['ack', 'Wrote them.', 'NONE'])
  try {
    const relay = await Relay.start({
      registry: registryOf({ lead, impl, unused: new ToolingFakeSession('x', 'unused') }),
      cwd: repo,
      lead: LEAD,
      implementer: { id: 'implementer', agent: 'impl', role: 'implementer' },
      maxAdvisorTurns: 3,
    })
    try {
      assert.equal(relay.worktrees, undefined, 'the default run has no linked root to attribute from')
      impl.work = (message) => (message.includes('Write the notes') ? { file: 'notes.md', content: 'written\n' } : undefined)

      const run = relay.start('Keep the work moving.')
      relay.say('Put the migration notes in notes.md.', { only: 'implementer' }, 'aside')
      const outcome = await run.settled()

      const origin = relay.restrictedOrigins.at(-1)!
      // The operator's own checkout is where it was written and where it was found.
      assert.ok(existsSync(join(repo, 'notes.md')))
      assert.deepEqual(origin.artifacts, ['notes.md'], 'the old view is exactly what it always was')
      assert.deepEqual(origin.artifactSupport, { 'notes.md': 'named_path' })
      assert.deepEqual(
        origin.attributions,
        [{ path: 'notes.md', support: 'named_path', seat: null, confidence: 'reasoned_but_unverified' }],
        'a shared checkout does not learn who wrote a file because the code got more careful',
      )

      const report = await runReport(relay, {
        goal: 'Keep the work moving.',
        outcome: outcome.kind === 'ended' ? outcome.outcome : { reason: 'stopped' },
        startedAt: Date.now(),
        build: 'test',
      })
      assert.deepEqual(report.restricted[0]?.artifacts, [
        { path: 'notes.md', support: 'named_path', seat: null, confidence: 'reasoned_but_unverified' },
      ])
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * The BASELINE is per root too, not just the candidate list.
 *
 * The snapshot taken when the aside is delivered is what "already dirty, so not caused by this"
 * means. Read from the integration checkout while the candidates come from a seat's tree, the
 * two sets are about different directories: anything the operator happened to have dirty would
 * silently cancel out the seat's real artifact of the same name. Every other test here has a
 * clean integration checkout at the moment of the aside, so none of them can see that — this
 * one dirties it first, with the very path the seat then changes.
 */
test('an operator edit of the same path does not cancel out the seat own artifact', async () => {
  const repo = tempRepo()
  const lead = new ToolingFakeSession('lead-1', 'lead', ['Update the readme.', 'DONE'])
  const alpha = new ToolingFakeSession('alpha-1', 'alpha', ['ack', 'Updated it.', 'NONE'])
  const beta = new ToolingFakeSession('beta-1', 'beta', ['ack', 'NONE'])
  try {
    const relay = await twoSeats(repo, { lead, alpha, beta })
    try {
      alpha.work = (message) =>
        message.includes('Update the readme') ? { file: 'README.md', content: '# by alpha\n' } : undefined

      // The operator is mid-edit in their own checkout when the aside goes out. README.md is
      // therefore dirty HERE and clean in the seat tree — the two baselines disagree, which is
      // the whole point.
      writeFileSync(join(repo, 'README.md'), '# the human was editing this\n')
      const run = relay.start('Keep the work moving.')
      relay.say('Rewrite README.md for the migration.', { only: 'seat-alpha' }, 'aside')
      await run.settled()

      const origin = relay.restrictedOrigins.at(-1)!
      assert.deepEqual(
        origin.attributions,
        [{ path: 'README.md', support: 'named_path', seat: 'seat-alpha', confidence: 'observed' }],
        "a dirty path in the operator checkout must not subtract from a seat's own diff",
      )
      // The operator's edit is untouched — nothing here reaches into their checkout.
      assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), '# the human was editing this\n')
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * The evidence rule, exercised where it can be.
 *
 * `evidenceForRoot` is unreachable through the relay today: `Audience` addresses exactly one
 * participant, so a restricted message has one informed id and one root and the filter never
 * removes anything. It is asserted directly for that reason — the rule is what stops evidence
 * collapsing across roots the moment a message can be addressed to two participants, and a
 * rule with no test is one somebody deletes as dead.
 */
test('evidence for a root comes only from informed participants working in that root', () => {
  const roots: Record<string, string> = {
    'seat-alpha': '/repo/.conclave/worktrees/r1/seat-alpha',
    'seat-beta': '/repo/.conclave/worktrees/r1/seat-beta',
    advisor: '/repo',
  }
  const evidence: Record<string, string[]> = {
    'seat-alpha': ['{"file_path":"/repo/.conclave/worktrees/r1/seat-alpha/notes.md"}'],
    'seat-beta': ['{"file_path":"/repo/.conclave/worktrees/r1/seat-beta/notes.md"}'],
    advisor: ['{"file_path":"/repo/notes.md"}'],
  }
  const forRoot = (root: string) =>
    evidenceForRoot(['seat-alpha', 'seat-beta', 'advisor'], (id) => roots[id]!, root, (id) => evidence[id]!)

  assert.deepEqual(forRoot(roots['seat-alpha']!), evidence['seat-alpha'])
  assert.deepEqual(forRoot(roots['seat-beta']!), evidence['seat-beta'])
  assert.deepEqual(forRoot('/repo'), evidence.advisor, 'the shared root gets what the shared root produced')
  // Not the union. A seat that wrote its own notes.md is not corroboration for another tree's.
  assert.equal(forRoot(roots['seat-alpha']!).length, 1)
  // And an uninformed participant is absent whatever root it works in — the older rule, intact.
  assert.deepEqual(
    evidenceForRoot(['seat-alpha'], (id) => roots[id]!, roots['seat-beta']!, (id) => evidence[id]!),
    [],
  )
})

/**
 * The turn diff is per root as well, and it is what a lost report is explained with.
 *
 * When a turn completes and its transcript never produces a body, the operator is told what
 * changed on disk during it — that diff is the only account of the work that survives. Read
 * from the integration checkout it would report nothing for a seat working in its own tree,
 * and "no new paths appeared" is precisely the false negative the message warns against
 * trusting: a reader who believes it restarts work that was already done.
 */
test('a lost report is explained with the diff of the seat own tree', async () => {
  const repo = tempRepo()
  const lead = new ToolingFakeSession('lead-1', 'lead', ['Write the notes.', 'DONE'])
  // An empty reply on the working turn: the turn ended, and its account of itself did not.
  const alpha = new ToolingFakeSession('alpha-1', 'alpha', ['ack', ''])
  const beta = new ToolingFakeSession('beta-1', 'beta', ['ack', 'NONE'])
  try {
    const relay = await Relay.start({
      registry: registryOf({ lead, alpha, beta }),
      cwd: repo,
      lead: LEAD,
      implementer: SEATS[0],
      implementers: [...SEATS],
      maxAdvisorTurns: 4,
      // The salvage window is 90s by default and is spent waiting for prose that never comes.
      transcriptSettleMs: 1,
      transcriptSalvageMs: 1,
    })
    try {
      alpha.work = (message) => (message.includes('Write the notes') ? { file: 'notes.md', content: 'work\n' } : undefined)

      const run = relay.start('Keep the work moving.')
      const pause = await run.untilPause()
      assert.ok(pause, 'a completed turn with no readable report must reach the operator')
      assert.match(pause.detail, /could not be read/)
      assert.match(
        pause.detail,
        /1 path\(s\) changed on disk during it: notes\.md/,
        'the work is on disk in the seat own tree, and that is where the account of it must come from',
      )
      assert.doesNotMatch(pause.detail, /no new paths appeared/, 'the integration checkout would have said this')
      await run.abort()
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * And the fallback half of that message counts the seat's tree too.
 *
 * When nothing NEW appeared, the message falls back to how many paths are dirty, because a
 * file edited again looks identical to one never touched and an empty diff must not be read as
 * "nothing happened". That count is offered as context for this seat, so counting the operator's
 * checkout would answer a question nobody asked — and would answer it with the operator's own
 * unrelated edits, which reads as evidence that the seat did something.
 */
test('a lost report with no new paths counts the seat own tree, not the operator', async () => {
  const repo = tempRepo()
  const lead = new ToolingFakeSession('lead-1', 'lead', ['Think about it.', 'DONE'])
  const alpha = new ToolingFakeSession('alpha-1', 'alpha', ['ack', ''])
  const beta = new ToolingFakeSession('beta-1', 'beta', ['ack', 'NONE'])
  try {
    const relay = await Relay.start({
      registry: registryOf({ lead, alpha, beta }),
      cwd: repo,
      lead: LEAD,
      implementer: SEATS[0],
      implementers: [...SEATS],
      maxAdvisorTurns: 4,
      transcriptSettleMs: 1,
      transcriptSalvageMs: 1,
    })
    try {
      // The seat writes nothing at all; the operator has two dirty paths of their own.
      alpha.work = () => undefined
      writeFileSync(join(repo, 'README.md'), '# operator edit\n')
      writeFileSync(join(repo, 'scratch.txt'), 'operator scratch\n')

      const run = relay.start('Keep the work moving.')
      const pause = await run.untilPause()
      assert.ok(pause)
      assert.match(
        pause.detail,
        /no new paths appeared during it, though 0 are dirty in the tree/,
        "the seat's own tree is what the count is about",
      )
      assert.doesNotMatch(pause.detail, /though 2 are dirty/, "the operator's edits are not this seat's context")
      await run.abort()
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
