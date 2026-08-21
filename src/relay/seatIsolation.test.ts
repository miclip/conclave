/**
 * Where the relay meets the worktrees: who is launched in which directory, and what a run
 * leaves behind.
 *
 * The adapter cwd is the assertion this file is built around. It is fixed at launch, so a seat
 * started in the shared checkout is a seat that shares the checkout for the rest of the run —
 * there is no later step that can correct it, and nothing in the run would report it. So the
 * cwd each participant was created in is recorded at the registry, which is the last place the
 * value is Conclave's own before an adapter owns it.
 *
 * The N=1 assertions are the other half and are not a formality: the default run must reach
 * NONE of this code. Not a one-seat worktree, not an empty manifest, not a no-op merge — no
 * directory, no branch, no file.
 *
 *   node --test src/relay/seatIsolation.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { AsyncQueue } from '../adapters/asyncQueue.ts'
import type { Verdict } from '../contract/outcome.ts'
import type { AgentEvent, AgentSession, CloseMode, SessionSnapshot, SessionState, TurnKey } from '../contract/session.ts'
import { guaranteesFor, turnKey } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import type { CreateParticipantContext, ResolvedParticipant } from '../registry/types.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { readManifest, worktreesRoot } from '../workspace/worktrees.ts'
import { Relay } from './relay.ts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-seat-'))
  git(dir, 'init', '--quiet')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'init', '--quiet')
  return dir
}

/**
 * A scriptable session that can also WRITE, which is what makes a boundary have anything to do.
 *
 * `FakeRotationSession` cannot: it has no hook that runs while a turn is in flight, so a run
 * driven by it produces clean trees and a merge with nothing in it. `onSend` here is called
 * with the prompt, so a test can make exactly one turn dirty its own worktree.
 */
class SeatFakeSession implements AgentSession {
  readonly guarantees = guaranteesFor('mediated')
  readonly received: string[] = []
  readonly agent: string
  readonly sessionId: string
  state: SessionState = 'running'
  onSend: ((message: string) => void) | undefined
  /**
   * How a given turn ends, 1-based, when a test needs something other than a clean completion.
   *
   * A double that can only end turns `completed (proven)` cannot reach the code that runs when
   * one does not, and "the boundary commits anyway after an uncertain end" is a claim about
   * exactly that code.
   */
  verdictFor: ((turn: number) => Verdict | undefined) | undefined
  /**
   * The directory the registry was told to create this participant in.
   *
   * Set from `CreateParticipantContext.cwd` and nowhere else, so a test that writes through
   * `this.cwd` is exercising the value a real adapter would launch in rather than a path the
   * test already knew. Without it, isolation could only be asserted by comparing two strings
   * the test itself supplied — which passes whether or not the cwd reaches anything.
   */
  cwd = ''
  closedAs: CloseMode | undefined
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
  #turns: { key: TurnKey; prose: string }[] = []

  constructor(sessionId: string, agent: string, replies: string[] = []) {
    this.sessionId = sessionId
    this.agent = agent
    this.#replies = [...replies]
  }

  async send(message: string): Promise<TurnKey> {
    this.received.push(message)
    this.onSend?.(message)
    const key = turnKey(`${this.sessionId}-turn-${this.#turns.length}`)
    this.#turns.push({ key, prose: this.#replies.shift() ?? 'NONE' })
    const override = this.verdictFor?.(this.#turns.length)
    const verdict: Verdict = override ?? {
      outcome: 'completed',
      confidence: 'proven',
      provenance: [{ source: 'hook', detail: 'Stop' }],
    }
    this.#emit({
      type: 'turn_end',
      verdict,
      // An overridden verdict stands in for one the orchestrator CONCLUDED -- a watchdog, a
      // process check -- so it is synthesized. The default came from a Stop hook and is not.
      synthesized: override !== undefined,
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
      cwd: '/tmp',
      turns: this.#turns.map((t) => ({
        key: t.key,
        prompt: '',
        state: 'completed',
        assistantText: t.prose,
        report: undefined,
        toolCalls: [],
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
  async close(mode: CloseMode = 'graceful'): Promise<void> {
    this.closedAs = mode
    this.state = 'terminated'
    // The stream ENDS with the session, which is the half of the contract every one of these
    // doubles used to omit. See `#events`.
    this.#events.close()
  }
}

interface Created {
  id: string
  cwd: string
}

/**
 * Records the cwd each participant was created in, and hands it to the session.
 *
 * `failing` names an agent that cannot start. With `dirtyOnFail` it writes into the cwd it was
 * given BEFORE throwing — what an adapter that got as far as its own preflight would leave
 * behind, and what makes the unwind have something it must retain rather than remove.
 */
function registryOf(
  sessions: Record<string, SeatFakeSession>,
  created: Created[],
  failing?: string,
  dirtyOnFail = false,
): AgentRegistry {
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
      async create(res: ResolvedParticipant, ctx: CreateParticipantContext) {
        if (res.agent.id === failing) {
          if (dirtyOnFail) writeFileSync(join(ctx.cwd, 'half-started.txt'), 'written before the launch failed\n')
          throw new Error(`${failing} could not be launched`)
        }
        created.push({ id: res.spec.id, cwd: ctx.cwd })
        session.cwd = ctx.cwd
        return session
      },
    })
  }
  return r
}

const LEAD = { id: 'advisor', agent: 'lead', role: 'advisor' } as const
const TWO_SEATS = [
  { id: 'seat-alpha', agent: 'alpha', role: 'implementer' },
  { id: 'seat-beta', agent: 'beta', role: 'implementer' },
] as const

function conclaveBranches(repo: string): string[] {
  return git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')
    .split('\n')
    .filter((b) => b.startsWith('conclave/'))
}

test('each seat is launched in its own worktree, and the advisor stays in the integration checkout', async () => {
  const repo = tempRepo()
  const created: Created[] = []
  try {
    const relay = await Relay.start({
      registry: registryOf(
        {
          lead: new SeatFakeSession('lead-1', 'lead', ['DONE']),
          alpha: new SeatFakeSession('alpha-1', 'alpha'),
          beta: new SeatFakeSession('beta-1', 'beta'),
        },
        created,
      ),
      cwd: repo,
      lead: LEAD,
      implementer: TWO_SEATS[0],
      implementers: [...TWO_SEATS],
    })
    try {
      const manifest = relay.worktrees
      assert.ok(manifest, 'a run with two implementers must have a manifest')
      const byId = Object.fromEntries(created.map((c) => [c.id, c.cwd]))

      assert.equal(byId.advisor, repo, 'the advisor reads committed state; it is not one of the writers')
      for (const seat of manifest.seats) {
        assert.equal(
          byId[seat.seatId],
          seat.worktreePath,
          `${seat.seatId} must be launched in its own tree — a cwd is fixed at launch and cannot be corrected later`,
        )
      }
      assert.notEqual(byId['seat-alpha'], byId['seat-beta'], 'two seats must not share a checkout')

      // And the same thing is on disk, because a crash leaves only the file.
      const onDisk = readManifest(repo, manifest.runId)
      assert.deepEqual(onDisk, manifest)
      assert.equal(onDisk?.integrationRoot, resolve(repo))
      assert.deepEqual(conclaveBranches(repo).sort(), [
        `conclave/${manifest.runId}/seat-alpha`,
        `conclave/${manifest.runId}/seat-beta`,
      ])
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a default run creates no worktree, no branch and no manifest', async () => {
  const repo = tempRepo()
  const created: Created[] = []
  try {
    const relay = await Relay.start({
      registry: registryOf(
        { lead: new SeatFakeSession('lead-1', 'lead', ['DONE']), impl: new SeatFakeSession('impl-1', 'impl') },
        created,
      ),
      cwd: repo,
      lead: LEAD,
      implementer: { id: 'implementer', agent: 'impl', role: 'implementer' },
      maxAdvisorTurns: 2,
    })
    try {
      assert.equal(relay.worktrees, undefined, 'N=1 must not take a one-element path through isolation')
      await relay.run('a default goal')
      assert.deepEqual(created.map((c) => c.cwd), [repo, repo], 'both seats work in the operator cwd')
      assert.ok(!existsSync(join(repo, '.conclave', 'worktrees')), 'no layout at all, not an empty one')
      assert.deepEqual(conclaveBranches(repo), [], 'the operator stays on their own branch')
      assert.equal(
        git(repo, 'worktree', 'list').split('\n').filter(Boolean).length,
        1,
        'git must know of exactly the main worktree',
      )
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a default run still starts on a dirty checkout; the clean-base rule is for concurrency only', async () => {
  const repo = tempRepo()
  const created: Created[] = []
  try {
    writeFileSync(join(repo, 'README.md'), '# the operator was mid-edit\n')
    writeFileSync(join(repo, 'scratch.txt'), 'untracked\n')
    const relay = await Relay.start({
      registry: registryOf(
        { lead: new SeatFakeSession('lead-1', 'lead', ['DONE']), impl: new SeatFakeSession('impl-1', 'impl') },
        created,
      ),
      cwd: repo,
      lead: LEAD,
      implementer: { id: 'implementer', agent: 'impl', role: 'implementer' },
    })
    await relay.stop()
    assert.equal(created.length, 2, 'the default run has always started here and must keep doing so')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('two implementers refuse to start on a dirty checkout, and launch nothing', async () => {
  const repo = tempRepo()
  const created: Created[] = []
  try {
    writeFileSync(join(repo, 'scratch.txt'), 'untracked\n')
    await assert.rejects(
      () =>
        Relay.start({
          registry: registryOf(
            {
              lead: new SeatFakeSession('lead-1', 'lead'),
              alpha: new SeatFakeSession('alpha-1', 'alpha'),
              beta: new SeatFakeSession('beta-1', 'beta'),
            },
            created,
          ),
          cwd: repo,
          lead: LEAD,
          implementer: TWO_SEATS[0],
          implementers: [...TWO_SEATS],
        }),
      /refusing to start.*scratch\.txt/s,
      'starting anyway would give every seat a base that is not what the operator sees',
    )
    assert.deepEqual(created, [], 'the refusal must come before any adapter is launched')
    assert.ok(!existsSync(join(repo, '.conclave', 'worktrees')))
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a seat that cannot be launched unwinds the trees the start had already created', async () => {
  const repo = tempRepo()
  const created: Created[] = []
  try {
    await assert.rejects(
      () =>
        Relay.start({
          registry: registryOf(
            {
              lead: new SeatFakeSession('lead-1', 'lead'),
              alpha: new SeatFakeSession('alpha-1', 'alpha'),
              beta: new SeatFakeSession('beta-1', 'beta'),
            },
            created,
            'beta',
          ),
          cwd: repo,
          lead: LEAD,
          implementer: TWO_SEATS[0],
          implementers: [...TWO_SEATS],
        }),
      /beta could not be launched/,
    )
    // Trees are created before any adapter starts, so a launch failure always finds some.
    assert.deepEqual(
      git(repo, 'worktree', 'list').split('\n').filter(Boolean).length,
      1,
      'a half-started run must not leave trees nothing will ever work in',
    )
    assert.deepEqual(conclaveBranches(repo), [], 'nor branches for seats that never existed')
    assert.equal(git(repo, 'status', '--porcelain').trim(), '', 'and the operator checkout is untouched')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a seat work reaches the integration checkout at its task boundary, and the trees go at stop', async () => {
  const repo = tempRepo()
  const created: Created[] = []
  const lead = new SeatFakeSession('lead-1', 'lead', ['Do the thing.', 'DONE'])
  const alpha = new SeatFakeSession('alpha-1', 'alpha', ['ack', 'Wrote it.', 'NONE'])
  const beta = new SeatFakeSession('beta-1', 'beta', ['ack', 'NONE'])
  try {
    const relay = await Relay.start({
      registry: registryOf({ lead, alpha, beta }, created),
      cwd: repo,
      lead: LEAD,
      implementer: TWO_SEATS[0],
      implementers: [...TWO_SEATS],
      maxAdvisorTurns: 3,
    })
    const manifest = relay.worktrees!
    const alphaTree = manifest.seats.find((s) => s.seatId === 'seat-alpha')!.worktreePath
    // One turn writes, so exactly one boundary has anything to commit.
    alpha.onSend = (message) => {
      if (message.includes('Do the thing')) writeFileSync(join(alphaTree, 'built.txt'), 'by seat alpha\n')
    }

    const outcome = await relay.run('Keep the work moving.')
    assert.equal(outcome.reason, 'done')

    assert.equal(
      readFileSync(join(repo, 'built.txt'), 'utf8'),
      'by seat alpha\n',
      "work done in a seat tree must reach the operator's checkout, or it is invisible to everyone",
    )
    assert.equal(git(repo, 'status', '--porcelain').trim(), '', 'and it must arrive committed, not dirty')
    assert.match(git(repo, 'log', '--format=%B', '-1', 'HEAD'), /Conclave-Seat: seat-alpha/)
    assert.ok(
      relay.log.some((m) => m.kind === 'note' && /merged into/.test(m.text) && m.text.includes('seat-alpha')),
      'a merge changes the operator own checkout, so the run must say it happened',
    )

    await relay.stop()
    assert.equal(
      git(repo, 'worktree', 'list').split('\n').filter(Boolean).length,
      1,
      'merged and clean trees are removed at the end of the run',
    )
    assert.deepEqual(conclaveBranches(repo), [], 'and their merged branches are deleted')
    assert.ok(!existsSync(worktreesRoot(repo, manifest.runId)), 'nothing retained means nothing left behind')
    assert.equal(readFileSync(join(repo, 'built.txt'), 'utf8'), 'by seat alpha\n', 'the work survives cleanup')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a seat holding work git cannot remove is retained at stop, with the commands to deal with it', async () => {
  const repo = tempRepo()
  const created: Created[] = []
  const lead = new SeatFakeSession('lead-1', 'lead', ['DONE'])
  try {
    const relay = await Relay.start({
      registry: registryOf(
        { lead, alpha: new SeatFakeSession('alpha-1', 'alpha'), beta: new SeatFakeSession('beta-1', 'beta') },
        created,
      ),
      cwd: repo,
      lead: LEAD,
      implementer: TWO_SEATS[0],
      implementers: [...TWO_SEATS],
    })
    const manifest = relay.worktrees!
    const beta = manifest.seats.find((s) => s.seatId === 'seat-beta')!
    // Uncommitted work in a seat tree at shutdown: the case `--force` would silently destroy.
    writeFileSync(join(beta.worktreePath, 'unsaved.txt'), 'the only copy\n')

    await relay.stop()

    assert.equal(
      readFileSync(join(beta.worktreePath, 'unsaved.txt'), 'utf8'),
      'the only copy\n',
      'a run must not end by deleting work that exists nowhere else',
    )
    assert.deepEqual(conclaveBranches(repo), [`conclave/${manifest.runId}/seat-beta`], 'the clean seat still goes')
    const notes = relay.log.filter((m) => m.kind === 'note').map((m) => m.text).join('\n')
    assert.match(notes, /kept rather than removed/)
    assert.match(notes, /uncommitted work/)
    assert.ok(notes.includes(beta.worktreePath) && notes.includes(beta.branch))
    for (const verb of ['inspect:', 'merge:', 'discard:']) assert.ok(notes.includes(verb))
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('seat worktrees are not reported as subagent worktrees', async () => {
  const repo = tempRepo()
  const created: Created[] = []
  try {
    const relay = await Relay.start({
      registry: registryOf(
        {
          lead: new SeatFakeSession('lead-1', 'lead', ['DONE']),
          alpha: new SeatFakeSession('alpha-1', 'alpha', ['ack', 'NONE']),
          beta: new SeatFakeSession('beta-1', 'beta', ['ack', 'NONE']),
        },
        created,
      ),
      cwd: repo,
      lead: LEAD,
      implementer: TWO_SEATS[0],
      implementers: [...TWO_SEATS],
      maxAdvisorTurns: 2,
    })
    try {
      await relay.run('Keep the work moving.')
      // The subagent report counts worktrees that appeared DURING the run against the briefing
      // rule. Seat trees exist before the run starts, so they are baseline rather than
      // evidence — a run that reported two subagent worktrees and no delegation would be
      // accusing the seats of the thing the rule is about.
      assert.deepEqual(relay.subagentUse().worktreesCreated, [])
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * Isolation proved by writing, not by comparing two strings the test already knew.
 *
 * Each session writes through `this.cwd` — the value the registry took from
 * `CreateParticipantContext.cwd` — to the SAME relative filename. If the cwd did not reach the
 * adapter, or reached both adapters as the same directory, one write would land on top of the
 * other and the last one would win. That is precisely the shared-checkout failure this whole
 * piece exists to prevent, and it is the one thing a path comparison cannot detect.
 *
 * Driven through `ask` rather than a run, so nothing has crossed a task boundary yet: what is
 * asserted is the state of the trees while the seats are still working in them.
 */
test('two seats writing the same filename write into two different checkouts', async () => {
  const repo = tempRepo()
  const created: Created[] = []
  const alpha = new SeatFakeSession('alpha-1', 'alpha', ['done alpha'])
  const beta = new SeatFakeSession('beta-1', 'beta', ['done beta'])
  try {
    const relay = await Relay.start({
      registry: registryOf({ lead: new SeatFakeSession('lead-1', 'lead'), alpha, beta }, created),
      cwd: repo,
      lead: LEAD,
      implementer: TWO_SEATS[0],
      implementers: [...TWO_SEATS],
    })
    try {
      alpha.onSend = () => writeFileSync(join(alpha.cwd, 'notes.txt'), 'written by alpha\n')
      beta.onSend = () => writeFileSync(join(beta.cwd, 'notes.txt'), 'written by beta\n')
      await relay.ask('seat-alpha', 'write your notes')
      await relay.ask('seat-beta', 'write your notes')

      const trees = Object.fromEntries(relay.worktrees!.seats.map((s) => [s.seatId, s.worktreePath]))
      assert.equal(readFileSync(join(trees['seat-alpha']!, 'notes.txt'), 'utf8'), 'written by alpha\n')
      assert.equal(readFileSync(join(trees['seat-beta']!, 'notes.txt'), 'utf8'), 'written by beta\n')
      // Neither write is visible to the other seat, and neither has touched the operator's
      // checkout — uncommitted work in a seat tree is invisible everywhere else by design.
      assert.ok(!existsSync(join(repo, 'notes.txt')), 'the integration checkout stays untouched')
      assert.equal(git(repo, 'status', '--porcelain').trim(), '')
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * The Codex hook trigger, scoped to the version it was measured on.
 *
 * On Codex **0.146.0**, a linked worktree with no `.codex/` directory loads ZERO hooks — no
 * turn-completion signal, and preflight refuses the session with a diagnostic that names
 * neither cause. An empty one loads five, sourced from the main worktree, so the directory is
 * a trigger whose contents are ignored (`src/config/install.ts` records the measurements).
 *
 * This asserts the trigger is in place BEFORE the adapter is launched, because that is the
 * only moment at which it helps: a directory created afterwards is a directory Codex has
 * already looked for and not found.
 */
test('every seat worktree has its Codex hook trigger before its adapter is launched', async () => {
  const repo = tempRepo()
  const created: Created[] = []
  const seenAtLaunch: Record<string, boolean> = {}
  try {
    const registry = registryOf(
      {
        lead: new SeatFakeSession('lead-1', 'lead', ['DONE']),
        alpha: new SeatFakeSession('alpha-1', 'alpha'),
        beta: new SeatFakeSession('beta-1', 'beta'),
      },
      created,
    )
    // Observed AT the launch call rather than after the fact: a trigger created later is a
    // directory Codex has already looked for and not found.
    const created0 = registry.createParticipant.bind(registry)
    registry.createParticipant = async (spec, ctx) => {
      seenAtLaunch[spec.id] = existsSync(join(ctx.cwd, '.codex'))
      return created0(spec, ctx)
    }
    const relay = await Relay.start({
      registry,
      cwd: repo,
      lead: LEAD,
      implementer: TWO_SEATS[0],
      implementers: [...TWO_SEATS],
    })
    try {
      assert.equal(seenAtLaunch['seat-alpha'], true, 'a Codex seat launched without it loads no hooks at all')
      assert.equal(seenAtLaunch['seat-beta'], true)
      // The advisor runs in the main worktree, which is not a linked one and needs no trigger
      // from us — `installConfig` owns that decision for real checkouts.
      assert.equal(seenAtLaunch.advisor, false)
      for (const seat of relay.worktrees!.seats) {
        assert.ok(existsSync(join(seat.worktreePath, '.codex')))
      }
      // And it costs the integration checkout nothing: seat trees live under `.conclave/`.
      assert.equal(git(repo, 'status', '--porcelain').trim(), '')
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * Teardown runs on the failing path, including the branch that reports a retained tree.
 *
 * The failing adapter writes into its worktree before throwing, so the unwind cannot remove
 * that tree and reports it instead. An earlier version returned through that report's own
 * `throw` before closing anything — so the one case that leaves a tree behind was also the one
 * case that leaked every child already launched. Both halves are asserted here: the sessions
 * are closed AND the tree with work in it survives.
 */
test('a failed start closes every launched session even when a tree has to be retained', async () => {
  const repo = tempRepo()
  const created: Created[] = []
  const lead = new SeatFakeSession('lead-1', 'lead')
  const alpha = new SeatFakeSession('alpha-1', 'alpha')
  try {
    await assert.rejects(
      () =>
        Relay.start({
          registry: registryOf({ lead, alpha, beta: new SeatFakeSession('beta-1', 'beta') }, created, 'beta', true),
          cwd: repo,
          lead: LEAD,
          implementer: TWO_SEATS[0],
          implementers: [...TWO_SEATS],
        }),
      (e: Error) => {
        assert.match(e.message, /beta could not be launched/, 'the original failure is what is reported')
        assert.match(e.message, /kept rather than removed/, 'and the tree it left behind is named')
        assert.match(e.message, /discard:/, 'with something the operator can actually run')
        return true
      },
    )
    assert.equal(lead.state, 'terminated', 'the advisor session must not be left running')
    assert.equal(lead.closedAs, 'graceful')
    assert.equal(alpha.state, 'terminated', 'nor a seat that started before the failure')

    // The retained tree keeps what the half-started adapter wrote; the clean one is gone.
    const trees = git(repo, 'worktree', 'list').split('\n').filter(Boolean)
    assert.equal(trees.length, 2, 'exactly the main worktree and the one that could not be unwound')
    assert.deepEqual(conclaveBranches(repo).length, 1)
    assert.equal(git(repo, 'status', '--porcelain').trim(), '', 'the operator checkout is untouched either way')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/** Two seats that will conflict over one line, and an advisor to drive them. */
async function conflictingRun(repo: string, seatReplies: { alpha: string[]; beta: string[] }, advisorReplies: string[]) {
  const created: Created[] = []
  const lead = new SeatFakeSession('lead-1', 'lead', advisorReplies)
  const alpha = new SeatFakeSession('alpha-1', 'alpha', seatReplies.alpha)
  const beta = new SeatFakeSession('beta-1', 'beta', seatReplies.beta)
  writeFileSync(join(repo, 'shared.txt'), 'base\n')
  git(repo, 'add', 'shared.txt')
  git(repo, 'commit', '-qm', 'shared')
  const relay = await Relay.start({
    registry: registryOf({ lead, alpha, beta }, created),
    cwd: repo,
    lead: LEAD,
    implementer: TWO_SEATS[0],
    implementers: [...TWO_SEATS],
    maxAdvisorTurns: 5,
  })
  return { relay, lead, alpha, beta }
}

test('a seat whose merge conflicts is blocked, told to the advisor, and repaired by name', async () => {
  const repo = tempRepo()
  try {
    const { relay, alpha, beta, lead } = await conflictingRun(
      repo,
      { alpha: ['ack', 'Set it to one.', 'NONE'], beta: ['ack', 'Set it to two.', 'Reconciled.', 'NONE'] },
      ['Set it to one.', 'Set it to two.', '@seat seat-beta: Resolve the conflict.', 'DONE'],
    )
    try {
      alpha.onSend = () => writeFileSync(join(alpha.cwd, 'shared.txt'), 'one\n')
      // The repair turn writes what the integration checkout already has, which is what a real
      // resolution produces: the merge then goes through and the block clears.
      let turn = 0
      beta.onSend = () => {
        turn += 1
        writeFileSync(join(beta.cwd, 'shared.txt'), turn <= 2 ? 'two\n' : 'one\n')
      }

      const outcome = await relay.run('Keep the work moving.')
      assert.equal(outcome.reason, 'done', 'one seat conflicting must not end the run')

      const notes = relay.log.filter((m) => m.kind === 'note').map((m) => m.text)
      assert.ok(
        notes.some((t) => t.includes('seat-beta') && /could not be merged/.test(t)),
        'the conflict must be recorded',
      )
      assert.ok(
        notes.some((t) => t.includes('seat-beta') && /conflict is resolved/.test(t)),
        'and so must the repair that cleared it',
      )

      // The advisor was TOLD, in the terms it has to act in, before it wrote the repair.
      const toldAt = lead.received.findIndex((m) => /blocked and takes no other work/.test(m))
      assert.ok(toldAt >= 0, 'resolution is work, and work is dispatched — so the advisor must hear about it')
      assert.match(lead.received[toldAt]!, /ORCHESTRATOR — mechanical/, 'and must not read it as a participant')
      assert.match(lead.received[toldAt]!, /IN ITS OWN WORKTREE/)

      // The repair went to the blocked seat BY NAME while it was blocked, and nothing else did.
      const targets = relay.tasks().map((t) => t.task.target)
      assert.deepEqual(targets[0], { kind: 'role', role: 'implementer' })
      assert.deepEqual(targets[1], { kind: 'role', role: 'implementer' })
      assert.deepEqual(targets[2], { kind: 'seat', seat: 'seat-beta' }, 'the repair is addressed')

      // Cleared: the seat takes ordinary work again, and both seats end dispatchable.
      assert.deepEqual(
        relay.seats().map((s) => [s.seat, s.state]),
        [
          ['seat-alpha', 'idle'],
          ['seat-beta', 'idle'],
        ],
        'a block that never clears is a seat retired by accident',
      )
      assert.equal(readFileSync(join(repo, 'shared.txt'), 'utf8'), 'one\n')
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a second failure against the same parent escalates, and blocks only that seat', async () => {
  const repo = tempRepo()
  try {
    const { relay, alpha, beta } = await conflictingRun(
      repo,
      { alpha: ['ack', 'Set it to one.', 'NONE'], beta: ['ack', 'Set it to two.', 'Still stuck.', 'NONE'] },
      ['Set it to one.', 'Set it to two.', '@seat seat-beta: Resolve the conflict.', 'DONE'],
    )
    try {
      alpha.onSend = () => writeFileSync(join(alpha.cwd, 'shared.txt'), 'one\n')
      // The repair turn changes nothing, so the merge is attempted against the same parent and
      // fails the same way. That, and only that, is what escalates.
      beta.onSend = () => writeFileSync(join(beta.cwd, 'shared.txt'), 'two\n')

      const run = relay.start('Keep the work moving.')
      const pause = await run.untilPause()
      assert.ok(pause, 'a repair that did not repair must reach the operator')
      assert.equal(pause.reason, 'merge_blocked')
      assert.deepEqual(pause.resolution.scope, { kind: 'participant', participantId: 'seat-beta' })
      assert.equal(pause.resolution.authority, 'operator')
      assert.match(pause.detail, /still will not merge/)
      assert.ok(pause.evidence.some((e) => /against the same integration parent/.test(e)))
      assert.ok(pause.evidence.some((e) => /no other seat is blocked/.test(e)))
      // No `rotate`: this run has two implementer seats and `rotateImplementer` names neither.
      assert.deepEqual(pause.options, ['continue', 'constrain', 'abort'])

      const states = Object.fromEntries(relay.seats().map((s) => [s.seat, s.state]))
      assert.equal(states['seat-beta'], 'merge_blocked')
      assert.equal(states['seat-alpha'], 'idle', 'one seat conflicting must not stop the others')

      // Nothing was discarded to reach this point: the work is committed on the seat branch and
      // the integration checkout holds the other seat's version, cleanly.
      assert.equal(readFileSync(join(repo, 'shared.txt'), 'utf8'), 'one\n')
      assert.equal(git(repo, 'status', '--porcelain').trim(), '')
      const blocked = relay.worktrees!.seats.find((s) => s.seatId === 'seat-beta')!
      assert.equal(blocked.mergeState, 'merge_blocked')
      assert.equal(git(blocked.worktreePath, 'show', 'HEAD:shared.txt'), 'two\n')

      await run.abort()
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * A boundary that did not merge must not earn integration completion.
 *
 * Every boundary used to run through `#integrate`, so a task whose merge CONFLICTED still
 * recorded `integratedAt` and could derive `complete`. That is not a cosmetic mislabel: the
 * dependency rules are written against "this work is in the integration checkout", so a
 * dependent of a conflicted task would be released to run against a base that never absorbed
 * it. The absence of `integratedAt` is the assertion; `failed` is the record of why.
 */
test('a task whose merge conflicted is failed, not integrated, and never complete', async () => {
  const repo = tempRepo()
  try {
    const { relay, alpha, beta } = await conflictingRun(
      repo,
      { alpha: ['ack', 'Set it to one.', 'NONE'], beta: ['ack', 'Set it to two.', 'Still stuck.', 'NONE'] },
      ['Set it to one.', 'Set it to two.', '@seat seat-beta: Resolve the conflict.', 'DONE'],
    )
    try {
      alpha.onSend = () => writeFileSync(join(alpha.cwd, 'shared.txt'), 'one\n')
      beta.onSend = () => writeFileSync(join(beta.cwd, 'shared.txt'), 'two\n')
      const run = relay.start('Keep the work moving.')
      assert.ok(await run.untilPause())

      const byId = Object.fromEntries(relay.tasks().map((e) => [e.task.id, e]))
      const merged = byId['t-1']!
      const conflicted = byId['t-2']!

      // The seat that merged is unaffected — this is a per-task fact, not a run-wide one.
      assert.equal(merged.runtime.state, 'complete')
      assert.ok(merged.runtime.integratedAt !== undefined)

      assert.equal(conflicted.runtime.integratedAt, undefined, 'nothing of this task reached the checkout')
      assert.equal(conflicted.runtime.state, 'failed')
      assert.notEqual(conflicted.runtime.state, 'complete')
      // Auditable: the transition is stamped rather than inferred from the missing timestamp,
      // and `integrated` is not among the marks at all.
      const events = conflicted.runtime.marks.map((m) => m.event)
      assert.ok(events.includes('failed'), 'the failure must be in the record')
      assert.ok(events.includes('released'), 'the seat is still released — the turn really did end')
      assert.ok(!events.includes('integrated'))
      // The report still reached the advisor, and saying so must not resurrect the task.
      assert.ok(conflicted.runtime.routedAt !== undefined)
      assert.equal(conflicted.runtime.state, 'failed')

      // The repair task was designated, and the ordinary ones were not.
      assert.deepEqual(
        relay.tasks().map((e) => e.task.purpose),
        ['work', 'work', 'merge_resolution'],
      )
      await run.abort()
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * A boundary that THREW is treated as a failed one, not as a clear one.
 *
 * This used to `catch` and return `clear`: the seat went back to `idle` and took ordinary work
 * on the strength of a boundary that raised an error — the single case in which nothing is
 * known about whether the work merged or what state the tree is in. The safe reading of "I
 * could not tell" is not "it was fine".
 *
 * Provoked by making the seat's own worktree unusable mid-run, which is what a removed mount,
 * a permissions change, or an operator tidying up looks like from in here.
 */
test('a boundary that throws blocks the seat and retains its work rather than releasing it', async () => {
  const repo = tempRepo()
  try {
    const { relay, alpha } = await conflictingRun(
      repo,
      { alpha: ['ack', 'Did it.', 'NONE'], beta: ['ack', 'NONE'] },
      ['Do the thing.', 'DONE'],
    )
    try {
      const tree = relay.worktrees!.seats.find((s) => s.seatId === 'seat-alpha')!
      alpha.onSend = (message) => {
        if (!message.includes('Do the thing')) return
        // Gone by the time the boundary runs: `git status` in it cannot answer, so the commit
        // step throws rather than reporting a conflict.
        rmSync(tree.worktreePath, { recursive: true, force: true })
      }

      const outcome = await relay.run('Keep the work moving.')
      assert.equal(outcome.reason, 'done', 'a broken boundary must not take the run down with it')

      const failed = relay.tasks().find((e) => e.task.id === 't-1')!
      assert.equal(failed.runtime.integratedAt, undefined, 'an unknown boundary claims nothing')
      assert.equal(failed.runtime.state, 'failed')

      const states = Object.fromEntries(relay.seats().map((s) => [s.seat, s.state]))
      assert.equal(states['seat-alpha'], 'merge_blocked', 'a seat whose boundary threw must not take more work')
      assert.equal(states['seat-beta'], 'idle', 'and no other seat is affected')

      assert.equal(tree.mergeState, 'merge_blocked')
      assert.equal(readManifest(repo, relay.worktrees!.runId)?.seats.find((s) => s.seatId === 'seat-alpha')?.mergeState,
        'merge_blocked', 'the state must survive a crash, so it goes to the manifest')
      const notes = relay.log.filter((m) => m.kind === 'note').map((m) => m.text).join('\n')
      assert.match(notes, /did not complete/)

      await relay.stop()
      // Retained, not cleaned: the branch is still there and the run said what to do about it.
      assert.deepEqual(conclaveBranches(repo), [`conclave/${relay.worktrees!.runId}/seat-alpha`])
      assert.match(relay.log.map((m) => m.text).join('\n'), /kept rather than removed/)
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * The loophole, closed at the relay rather than only in the dispatcher.
 *
 * A seat-targeted task that is not the designated repair must not enter a blocked seat. The
 * dispatcher's rule is unit-tested; this asserts the relay actually builds tasks that carry
 * the designation, which is the half a pure-function test cannot see.
 */
test('only the designated repair enters a blocked seat, and it is designated by routing', async () => {
  const repo = tempRepo()
  try {
    const { relay, alpha, beta } = await conflictingRun(
      repo,
      // One instruction MORE than the repair, so there is a later task to look at: the point is
      // that the designation ends with the block rather than sticking to the seat.
      { alpha: ['ack', 'Set it to one.', 'Did the extra thing.', 'NONE'], beta: ['ack', 'Set it to two.', 'Reconciled.', 'NONE'] },
      ['Set it to one.', 'Set it to two.', '@seat seat-beta: Resolve the conflict.', 'Now do one more thing.', 'DONE'],
    )
    try {
      alpha.onSend = () => writeFileSync(join(alpha.cwd, 'shared.txt'), 'one\n')
      let turn = 0
      beta.onSend = () => {
        turn += 1
        writeFileSync(join(beta.cwd, 'shared.txt'), turn <= 2 ? 'two\n' : 'one\n')
      }
      await relay.run('Keep the work moving.')

      const tasks = relay.tasks().map((e) => e.task)
      assert.equal(tasks.length, 4, 'three instructions before the repair cleared, and one after')
      const repair = tasks.find((t) => t.purpose === 'merge_resolution')
      assert.ok(repair, 'the relay must designate the repair, since nothing else can')
      assert.deepEqual(repair.target, { kind: 'seat', seat: 'seat-beta' })
      assert.equal(
        tasks.filter((t) => t.purpose === 'merge_resolution').length,
        1,
        'the designation belongs to the redirected instruction and to nothing else',
      )
      // Once the block cleared, the relay went back to designating ordinary work.
      assert.equal(tasks.at(-1)!.purpose, 'work')
      assert.deepEqual(tasks.at(-1)!.target, { kind: 'role', role: 'implementer' })
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * A blocked seat does not swallow the work the other seats could be doing.
 *
 * The redirect that puts an untargeted instruction onto a blocked seat is what makes a
 * single-seat repair possible at all: with one seat there is nowhere else for the work to go,
 * and a seat nothing can be sent to is a seat nothing can repair. Fired unconditionally it is
 * starvation. One seat failing to merge captured EVERY subsequent untargeted instruction, so
 * the free seats idled while the blocked one collected work it is not allowed to do — and
 * `canTake` refuses all of it, so the queue fills with tasks nothing will ever dispatch.
 *
 * So the condition is "every compatible seat is blocked" rather than "any seat is blocked",
 * which at N=1 is the same question and at N>1 is this test. The advisor reaches a blocked seat
 * the way it is told to: by name.
 */
test('an untargeted instruction goes to a free seat rather than to the blocked one', async () => {
  const repo = tempRepo()
  try {
    const { relay, alpha, beta, lead } = await conflictingRun(
      repo,
      {
        alpha: ['ack', 'Set it to one.', 'Did the untargeted work.', 'NONE'],
        beta: ['ack', 'Set it to two.', 'Reconciled.', 'NONE'],
      },
      // The third reply names nobody. Before the fix it was redirected onto seat-beta, which
      // was blocked; now it must reach seat-alpha, which is free.
      ['Set it to one.', 'Set it to two.', 'Do something unrelated.', '@seat seat-beta: Resolve the conflict.', 'DONE'],
    )
    try {
      alpha.onSend = () => writeFileSync(join(alpha.cwd, 'shared.txt'), 'one\n')
      let turn = 0
      beta.onSend = () => {
        turn += 1
        writeFileSync(join(beta.cwd, 'shared.txt'), turn <= 2 ? 'two\n' : 'one\n')
      }

      assert.equal((await relay.run('Keep the work moving.')).reason, 'done')

      const entries = relay.tasks()
      // Task 3 is the untargeted one issued while seat-beta was blocked.
      const untargeted = entries[2]!
      assert.deepEqual(
        untargeted.task.target,
        { kind: 'role', role: 'implementer' },
        'an untargeted instruction must stay untargeted while another seat can take it',
      )
      assert.equal(untargeted.task.purpose, 'work', 'and must not be designated as somebody else\'s repair')
      assert.equal(untargeted.runtime.seat, 'seat-alpha', 'it must land on the seat that is free')

      // The repair still happened, and only because the advisor addressed it.
      const repair = entries[3]!
      assert.deepEqual(repair.task.target, { kind: 'seat', seat: 'seat-beta' })
      assert.equal(repair.task.purpose, 'merge_resolution', 'naming a blocked seat IS the designation')
      assert.equal(repair.runtime.seat, 'seat-beta')

      // The advisor was told how to reach it, which is the half that makes the rule usable.
      const toldAt = lead.received.findIndex((m) => /blocked and takes no other work/.test(m))
      assert.ok(toldAt >= 0)
      assert.match(
        lead.received[toldAt]!,
        /@seat seat-beta:/,
        'a rule the advisor is not told about is a seat that stays blocked',
      )

      assert.deepEqual(
        relay.seats().map((s) => [s.seat, s.state]),
        [
          ['seat-alpha', 'idle'],
          ['seat-beta', 'idle'],
        ],
        'both seats end dispatchable, so nothing was stranded',
      )
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * A write that lands AFTER a seat's boundary commit, from git's own post-commit hook.
 *
 * This is the hazard the boundary notices used to describe wrongly, reproduced exactly rather
 * than simulated. `commitSeatWork` runs `git commit --no-verify`, which bypasses `pre-commit`
 * and `commit-msg` and NOT `post-commit`; the hook therefore fires at the one instant that
 * matters -- after the snapshot the notice calls "its work", before the merge that judges it.
 * A real seat does the same thing without a hook, because its child is still running.
 *
 * Installed in the shared `.git/hooks` (a linked worktree has no hooks of its own) and guarded
 * on the branch, so the integration checkout's own merge commits do not trip it.
 */
function writeAfterEveryCommitOn(repo: string, branch: string, script: string): void {
  writeFileSync(
    join(repo, '.git', 'hooks', 'post-commit'),
    `#!/bin/sh\n[ "$(git rev-parse --abbrev-ref HEAD)" = "${branch}" ] || exit 0\n${script}\n`,
    { mode: 0o755 },
  )
}

/**
 * What the conflict notices say about a tree has to come FROM the tree.
 *
 * All three of them -- the orchestrator's note, the advisor's instruction, and the halt
 * evidence -- used to end in some form of "its work is committed on its branch and nothing has
 * been discarded". Nothing had read the tree. A seat commits at its boundary and keeps
 * working; the merge that conflicts is attempted and aborted afterwards. So the reassurance
 * was issued about a moment that had already passed, to the one reader in a position to act on
 * it, and an operator who believed it and ran `git worktree remove --force` would lose
 * whatever had arrived since -- with the notice as the reason they stopped looking.
 *
 * The assertion is on a filename the notice could not have produced without reading the tree.
 */
test('a conflict notice names what the seat wrote after its boundary commit', async () => {
  const repo = tempRepo()
  try {
    const { relay, alpha, beta, lead } = await conflictingRun(
      repo,
      { alpha: ['ack', 'Set it to one.', 'NONE'], beta: ['ack', 'Set it to two.', 'Reconciled.', 'NONE'] },
      ['Set it to one.', 'Set it to two.', '@seat seat-beta: Resolve the conflict.', 'DONE'],
    )
    try {
      const tree = relay.worktrees!.seats.find((s) => s.seatId === 'seat-beta')!
      writeAfterEveryCommitOn(repo, tree.branch, 'echo late > late-write.txt')
      alpha.onSend = () => writeFileSync(join(alpha.cwd, 'shared.txt'), 'one\n')
      let turn = 0
      beta.onSend = () => {
        turn += 1
        writeFileSync(join(beta.cwd, 'shared.txt'), turn <= 2 ? 'two\n' : 'one\n')
      }

      const outcome = await relay.run('Keep the work moving.')
      assert.equal(outcome.reason, 'done')

      const conflict = relay.log
        .filter((m) => m.kind === 'note')
        .map((m) => m.text)
        .find((t) => /could not be merged/.test(t))
      assert.ok(conflict, 'the conflict is still recorded')
      assert.ok(
        conflict.includes('late-write.txt'),
        'the note must name the file the seat wrote after its commit — no template can guess it',
      )
      assert.match(conflict, /ALSO holds uncommitted work that no commit and no merge carries: 1 untracked/)
      assert.ok(conflict.includes(tree.worktreePath), 'and say which tree it read')
      assert.ok(!/nothing has been discarded/.test(conflict), 'the claim nothing checked is gone')

      // The advisor is the one who dispatches the repair, so it gets the same account.
      const told = lead.received.find((m) => /blocked and takes no other work/.test(m))
      assert.ok(told)
      assert.ok(told.includes('late-write.txt'), 'the advisor must not be told a tidier story than the note')
      assert.ok(!/Nothing has been lost/.test(told))

      // The file is still there. The notice reports; it does not tidy.
      assert.equal(readFileSync(join(tree.worktreePath, 'late-write.txt'), 'utf8'), 'late\n')
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * The same read reaches the halt, which is the notice an operator actually decides on.
 *
 * `evidence` is what a paused run puts in front of a human. It said "the work is committed on
 * <branch> and its worktree is retained" whatever the worktree held, so the one reader with
 * the authority to discard the tree was the one reader given a reason not to look at it.
 */
test('the merge_blocked halt evidence is read from the tree too', async () => {
  const repo = tempRepo()
  try {
    const { relay, alpha, beta } = await conflictingRun(
      repo,
      { alpha: ['ack', 'Set it to one.', 'NONE'], beta: ['ack', 'Set it to two.', 'Still stuck.', 'NONE'] },
      ['Set it to one.', 'Set it to two.', '@seat seat-beta: Resolve the conflict.', 'DONE'],
    )
    try {
      const tree = relay.worktrees!.seats.find((s) => s.seatId === 'seat-beta')!
      // A distinct file per commit: the second boundary commits the first one's, so a fixed
      // name would be tracked and unmodified by the time the escalation notice is written --
      // and the test would pass on a notice that had read nothing.
      writeAfterEveryCommitOn(repo, tree.branch, 'echo late > "late-$(git rev-parse --short HEAD).txt"')
      alpha.onSend = () => writeFileSync(join(alpha.cwd, 'shared.txt'), 'one\n')
      beta.onSend = () => writeFileSync(join(beta.cwd, 'shared.txt'), 'two\n')

      const run = relay.start('Keep the work moving.')
      const pause = await run.untilPause()
      assert.ok(pause)
      assert.equal(pause.reason, 'merge_blocked')

      const held = pause.evidence.find((e) => /that worktree is retained/.test(e))
      assert.ok(held, 'the evidence must still say the tree was kept')
      assert.match(held, /1 untracked \(late-[0-9a-f]+\.txt\)/, 'and say what was in it when it said so')
      assert.ok(held.includes(tree.branch))
      assert.ok(!/the work is committed on/.test(held))

      await run.abort()
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * The boundary that THREW is where the old wording was furthest from true.
 *
 * "Its work is on <branch> and nothing has been discarded" was said on the one path that
 * reaches the catch without knowing whether the commit happened at all. Here it did not: the
 * seat's index is locked, so `git add -A` fails and the boundary raises before committing
 * anything. The seat's whole turn is sitting uncommitted in its tree, and the notice that told
 * the advisor otherwise was not merely unverified but wrong.
 *
 * A lock file rather than a deleted tree (the existing throw test deletes one): a tree that is
 * gone can only be reported as unreadable, which proves the notice handles absence and not
 * that it reads content.
 */
test('a boundary that throws reports the work still sitting in the tree', async () => {
  const repo = tempRepo()
  try {
    const { relay, alpha, lead } = await conflictingRun(
      repo,
      { alpha: ['ack', 'Did it.', 'NONE'], beta: ['ack', 'NONE'] },
      ['Do the thing.', 'DONE'],
    )
    try {
      const tree = relay.worktrees!.seats.find((s) => s.seatId === 'seat-alpha')!
      alpha.onSend = (message) => {
        if (!message.includes('Do the thing')) return
        writeFileSync(join(tree.worktreePath, 'shared.txt'), 'the turn that never got committed\n')
        writeFileSync(join(tree.worktreePath, 'new-file.txt'), 'nor this\n')
        // `git status` still answers under a stale lock; `git add` does not. So the boundary
        // throws at the commit, and the tree it leaves behind is fully readable.
        writeFileSync(join(git(tree.worktreePath, 'rev-parse', '--absolute-git-dir').trim(), 'index.lock'), '')
      }

      const outcome = await relay.run('Keep the work moving.')
      assert.equal(outcome.reason, 'done', 'a broken boundary must not take the run down with it')

      const notes = relay.log.filter((m) => m.kind === 'note').map((m) => m.text)
      const threw = notes.find((t) => /did not complete/.test(t))
      assert.ok(threw)
      assert.match(threw, /1 modified, 1 untracked/, 'nothing was committed, and the note says so')
      assert.ok(threw.includes('shared.txt') && threw.includes('new-file.txt'))

      const told = lead.received.find((m) => /the boundary itself failed/.test(m))
      assert.ok(told, 'the advisor is told, because the repair is work it has to dispatch')
      assert.ok(!/nothing has been discarded/.test(told), 'least of all on the path that knows least')
      assert.ok(told.includes('shared.txt'), 'it is told what is actually in the tree')
      assert.match(told, /Whatever it committed is on/, 'and not told that anything definitely was')

      // Still there, uncommitted, exactly as reported.
      assert.equal(readFileSync(join(tree.worktreePath, 'new-file.txt'), 'utf8'), 'nor this\n')
      assert.equal(git(tree.worktreePath, 'log', '--oneline', `${tree.baseSha}..HEAD`).trim(), '')
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * And the halt the error path escalates to, which is the last of the four notices.
 *
 * A second throw against the same integration parent is what reaches the operator, and its
 * evidence used to end "its branch is untouched" -- true, and beside the point, because the
 * branch is not where the work is when the boundary never got as far as committing.
 */
test('a repeated boundary failure escalates with the tree state in its evidence', async () => {
  const repo = tempRepo()
  try {
    const { relay, alpha } = await conflictingRun(
      repo,
      { alpha: ['ack', 'Did it.', 'Tried again.', 'NONE'], beta: ['ack', 'NONE'] },
      ['Do the thing.', '@seat seat-alpha: Get your branch mergeable.', 'DONE'],
    )
    try {
      const tree = relay.worktrees!.seats.find((s) => s.seatId === 'seat-alpha')!
      const lock = join(git(tree.worktreePath, 'rev-parse', '--absolute-git-dir').trim(), 'index.lock')
      alpha.onSend = () => {
        writeFileSync(join(tree.worktreePath, 'stranded.txt'), 'never committed, twice over\n')
        // Left in place, so the repair turn's boundary fails the same way against the same
        // parent — which is the only thing that escalates.
        writeFileSync(lock, '')
      }

      const run = relay.start('Keep the work moving.')
      const pause = await run.untilPause()
      assert.ok(pause, 'two failed boundaries against one parent must reach the operator')
      assert.equal(pause.reason, 'merge_blocked')

      const held = pause.evidence.find((e) => /is untouched/.test(e))
      assert.ok(held, 'the evidence must still say the branch was not disturbed')
      assert.ok(held.includes('stranded.txt'), 'and name the work that never reached it')
      assert.match(held, /1 untracked/)
      assert.ok(pause.evidence.some((e) => /what merged is unknown/.test(e)))

      await run.abort()
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * An uncertain turn end is recorded on the commit it produced, and the run keeps going.
 *
 * No bounded signal can prove a child has stopped writing. A watchdog verdict is the absence
 * of evidence, not evidence of absence, so the boundary commit taken after one is a SNAPSHOT --
 * possibly mid-edit, possibly not all of the work. That is unavoidable, and the two ways of
 * responding to it are both worse than saying so: waiting for certainty waits forever, and
 * refusing to merge strands every uncertain task on a condition nothing can ever discharge,
 * leaving the work neither integrated nor recoverable without reading a manifest by hand.
 *
 * So the boundary records the doubt instead of acting on it. `Conclave-Turn-End` is immutable,
 * travels with the work rather than beside it, and outlives the run -- and it gates nothing.
 *
 * The rest of this test is the incident that makes the trailer worth having: the child goes on
 * writing AFTER the commit, and the notice about the tree has to stay true while the notice
 * about the turn is added beside it. Both facts appear in one operator notice, because an
 * operator who has to assemble them from two places will assemble them wrong.
 */
test('an uncertain turn end is trailered on the commit and named in the notice', async () => {
  const repo = tempRepo()
  try {
    const { relay, alpha, beta, lead } = await conflictingRun(
      repo,
      { alpha: ['ack', 'Set it to one.', 'NONE'], beta: ['ack', 'Set it to two.', 'NONE'] },
      ['Set it to one.', 'Set it to two.', 'DONE'],
    )
    try {
      const tree = relay.worktrees!.seats.find((s) => s.seatId === 'seat-beta')!
      // The work turn, ended by a clock rather than by the child. `uncertain` is the whole
      // point: it is the confidence that means "nothing said so", and the only one trailered.
      beta.verdictFor = (turn) =>
        turn === 2
          ? {
              outcome: 'timed_out',
              confidence: 'uncertain',
              provenance: [{ source: 'watchdog', detail: 'no signal within the deadline' }],
            }
          : undefined
      writeAfterEveryCommitOn(repo, tree.branch, 'echo mid-edit > still-writing.txt')
      alpha.onSend = () => writeFileSync(join(alpha.cwd, 'shared.txt'), 'one\n')
      beta.onSend = () => writeFileSync(join(beta.cwd, 'shared.txt'), 'two\n')

      const run = relay.start('Keep the work moving.')
      // The turn that did not complete is the human's call, and it is raised BEFORE the
      // boundary. Continuing is what lets the boundary commit the snapshot at all.
      const pause = await run.untilPause()
      assert.ok(pause, 'an uncertain turn end must reach the operator before anything is merged')
      assert.equal(pause.reason, 'turn_incomplete')
      assert.deepEqual(pause.resolution.scope, { kind: 'participant', participantId: 'seat-beta' })
      assert.equal(
        git(tree.worktreePath, 'log', '--oneline', `${tree.baseSha}..HEAD`).trim(),
        '',
        'nothing may be committed while the operator is still deciding',
      )

      await run.continue()
      const settled = await run.settled()
      assert.equal(settled.kind, 'ended', 'the trailer records the doubt; it does not act on it')
      assert.equal(settled.kind === 'ended' ? settled.outcome.reason : '', 'done')

      // The commit exists, and it says how the turn that produced it ended.
      const body = git(repo, 'log', '--format=%B', `${tree.baseSha}..${tree.branch}`)
      assert.match(body, /Conclave-Seat: seat-beta/, 'the existing attribution is untouched')
      assert.match(
        body,
        /^Conclave-Turn-End: timed_out \(uncertain\)$/m,
        'an uncertain end must be on the commit, where it outlives the run',
      )

      // ... and the conflict notice carries both halves: what is in the tree now, and that
      // what was committed was never known to be finished.
      const conflict = relay.log
        .filter((m) => m.kind === 'note')
        .map((m) => m.text)
        .find((t) => /could not be merged/.test(t))
      assert.ok(conflict)
      assert.ok(conflict.includes('still-writing.txt'), 'the post-commit write is still reported')
      assert.match(conflict, /turn ended timed_out \(uncertain\)/)
      assert.match(conflict, /may be mid-edit or incomplete/)

      // And the advisor gets it too. It is the party that dispatches the repair, so a caveat
      // it never sees is a caveat that cannot change what happens next.
      const told = lead.received.find((m) => /blocked and takes no other work/.test(m))
      assert.ok(told)
      assert.match(told, /turn ended timed_out \(uncertain\)/)
      assert.ok(told.includes('still-writing.txt'), 'both halves reach the advisor, not one each')

      // Nothing was gated and nothing was lost: the file the child wrote after the commit is
      // exactly where it was left.
      assert.equal(readFileSync(join(tree.worktreePath, 'still-writing.txt'), 'utf8'), 'mid-edit\n')
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * The control, and it is not a formality: a trailer on every commit is a trailer nobody reads.
 *
 * A turn that ended `completed (proven)` has a positive signal behind it. Recording doubt there
 * would train an operator to skip the line, which is how the one that mattered gets skipped.
 */
test('an ordinary completed turn earns no turn-end trailer and no snapshot caveat', async () => {
  const repo = tempRepo()
  try {
    const { relay, alpha } = await conflictingRun(
      repo,
      { alpha: ['ack', 'Did it.', 'NONE'], beta: ['ack', 'NONE'] },
      ['Do the thing.', 'DONE'],
    )
    try {
      const tree = relay.worktrees!.seats.find((s) => s.seatId === 'seat-alpha')!
      alpha.onSend = () => writeFileSync(join(alpha.cwd, 'shared.txt'), 'one\n')

      const outcome = await relay.run('Keep the work moving.')
      assert.equal(outcome.reason, 'done')

      const merged = relay.log
        .filter((m) => m.kind === 'note')
        .map((m) => m.text)
        .find((t) => /merged into/.test(t) && t.includes('seat-alpha'))
      assert.ok(merged, 'the merge is still recorded')
      assert.ok(!/uncertain/.test(merged), 'a proven completion is not a snapshot to warn about')

      const body = git(repo, 'log', '--format=%B', `${tree.baseSha}..HEAD`)
      assert.match(body, /Conclave-Seat: seat-alpha/)
      assert.ok(!/Conclave-Turn-End/.test(body), 'the trailer is for the uncertain case alone')
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * The caveat reaches the halt, which is the notice a human actually decides on.
 *
 * A pause is where someone chooses whether to keep the work, and "the commit may be mid-edit"
 * changes that choice. Carried as its own evidence entry rather than appended to a sentence
 * about branches, because an operator scanning a list does not read into the middle of one.
 */
test('a merge_blocked halt raised on an uncertain turn says the commit is a snapshot', async () => {
  const repo = tempRepo()
  try {
    const { relay, alpha, beta } = await conflictingRun(
      repo,
      { alpha: ['ack', 'Set it to one.', 'NONE'], beta: ['ack', 'Set it to two.', 'Still stuck.', 'NONE'] },
      ['Set it to one.', 'Set it to two.', '@seat seat-beta: Resolve the conflict.', 'DONE'],
    )
    try {
      // Every turn of beta's after the kickoff ends the same way. The ESCALATING boundary is
      // the repair's, not the original's, so an uncertain first turn alone would prove nothing
      // about the halt -- the evidence is built from the task that failed the second time.
      beta.verdictFor = (turn) =>
        turn >= 2
          ? {
              outcome: 'timed_out',
              confidence: 'uncertain',
              provenance: [{ source: 'watchdog', detail: 'no signal within the deadline' }],
            }
          : undefined
      alpha.onSend = () => writeFileSync(join(alpha.cwd, 'shared.txt'), 'one\n')
      beta.onSend = () => writeFileSync(join(beta.cwd, 'shared.txt'), 'two\n')

      const run = relay.start('Keep the work moving.')
      // Each uncertain turn raises its own pause before its boundary. Continue through them
      // until the one this test is about, rather than pinning an exact sequence.
      let pause = await run.untilPause()
      for (let i = 0; i < 6 && pause && pause.reason !== 'merge_blocked'; i++) {
        await run.continue()
        pause = await run.untilPause()
      }
      assert.ok(pause, 'a repair that did not repair must still reach the operator')
      assert.equal(pause.reason, 'merge_blocked')

      assert.ok(
        pause.evidence.some((e) => /^Its turn ended timed_out \(uncertain\)/.test(e)),
        'the caveat must be its own line, not buried inside another',
      )
      assert.ok(pause.evidence.some((e) => /may be mid-edit or incomplete/.test(e)))
      // The evidence it was added to is untouched.
      assert.ok(pause.evidence.some((e) => /against the same integration parent/.test(e)))

      await run.abort()
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * A boundary that found nothing does not get to say the seat did nothing.
 *
 * `nothing_to_merge` used to be recorded as `changed nothing`, which is a claim about the whole
 * turn. What was actually checked is one `git status` at one instant, and after an uncertain
 * end that instant carries no weight at all: a child that had not finished writing is
 * indistinguishable from one with nothing to say. An operator who read "changed nothing" and
 * removed the tree would have removed work that arrived a second later, and the run would have
 * been the reason they were confident.
 *
 * So the note is a timestamped observation plus the uncertainty, and cleanup is left to be the
 * thing that decides -- which it does here, on the file that arrived after the check.
 */
test('a boundary that found nothing reports when it looked, and does not certify a no-op', async () => {
  const repo = tempRepo()
  try {
    const { relay, alpha } = await conflictingRun(
      repo,
      { alpha: ['ack', 'Nothing to do.', 'NONE'], beta: ['ack', 'NONE'] },
      ['Do the thing.', 'DONE'],
    )
    try {
      const tree = relay.worktrees!.seats.find((s) => s.seatId === 'seat-alpha')!
      // No `onSend`: the tree is clean when the boundary reads it, which is the whole setup.
      alpha.verdictFor = (turn) =>
        turn === 2
          ? {
              outcome: 'timed_out',
              confidence: 'uncertain',
              provenance: [{ source: 'watchdog', detail: 'no signal within the deadline' }],
            }
          : undefined

      const run = relay.start('Keep the work moving.')
      const pause = await run.untilPause()
      assert.ok(pause)
      assert.equal(pause.reason, 'turn_incomplete')
      await run.continue()
      const settled = await run.settled()
      assert.equal(settled.kind, 'ended')

      const found = relay.log
        .filter((m) => m.kind === 'note')
        .map((m) => m.text)
        .find((t) => /nothing was integrated/.test(t))
      assert.ok(found, 'a boundary with nothing to merge is still recorded')
      assert.ok(
        !/changed nothing/.test(found),
        'a durable claim about the turn is exactly what one `git status` cannot support',
      )
      assert.match(found, /had no uncommitted changes when the boundary read its tree at/)
      assert.match(found, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/, 'an observation is worth nothing undated')
      assert.match(found, /turn ended timed_out \(uncertain\)/)
      assert.match(found, /may be mid-edit or incomplete/)
      // The caveat has to be true HERE, where no commit exists at all. Describing one would be
      // a false sentence attached to a true warning, which is how a warning stops being read.
      assert.ok(
        !/what was committed/.test(found),
        'nothing was committed on this path, so the caveat must not describe a commit',
      )
      assert.equal(
        git(tree.worktreePath, 'log', '--oneline', `${tree.baseSha}..HEAD`).trim(),
        '',
        'nothing was committed, which is the premise the note must not overstate',
      )

      // The child, still going, writing after the boundary had already read the tree. Written
      // here rather than by the seat double for the reason the note now admits: there is no
      // moment after an uncertain end at which anything can say the child has stopped.
      writeFileSync(join(tree.worktreePath, 'late-arrival.txt'), 'written after the boundary looked\n')

      await relay.stop()
      // Cleanup is what decides, and it decides on the tree rather than on the note.
      const log = relay.log.map((m) => m.text).join('\n')
      assert.match(log, /kept rather than removed/, 'a tree holding late work must not be removed')
      assert.ok(log.includes('late-arrival.txt'), 'and the operator must be told what is in it')
      assert.equal(
        readFileSync(join(tree.worktreePath, 'late-arrival.txt'), 'utf8'),
        'written after the boundary looked\n',
      )
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * The merged path has the same hole, and it is the easier one to miss.
 *
 * On a conflict everything the operator reads already says something went wrong. On a merge
 * that SUCCEEDED, every other line says the work went through -- so a note reading only "still
 * dirty after its boundary commit" is the one line saying otherwise, and it does not say what
 * was left. An operator who merged, saw green, and removed the tree would have removed it.
 *
 * Here the child writes after the commit and the merge still goes through, which is the exact
 * combination: the work is integrated, the trailer records that the turn was never confirmed,
 * and a named file is sitting in a tree everything else describes as finished with.
 */
test('a merged boundary names what the child wrote after its commit', async () => {
  const repo = tempRepo()
  try {
    const { relay, alpha } = await conflictingRun(
      repo,
      { alpha: ['ack', 'Did it.', 'NONE'], beta: ['ack', 'NONE'] },
      ['Do the thing.', 'DONE'],
    )
    try {
      const tree = relay.worktrees!.seats.find((s) => s.seatId === 'seat-alpha')!
      alpha.verdictFor = (turn) =>
        turn === 2
          ? {
              outcome: 'timed_out',
              confidence: 'uncertain',
              provenance: [{ source: 'watchdog', detail: 'no signal within the deadline' }],
            }
          : undefined
      // Nobody else touches shared.txt, so this merge succeeds. The dirt arrives after the
      // commit that produced the merge, which is what the post-merge check is looking for.
      alpha.onSend = () => writeFileSync(join(tree.worktreePath, 'shared.txt'), 'one\n')
      writeAfterEveryCommitOn(repo, tree.branch, 'echo late > late-on-merge.txt')

      const run = relay.start('Keep the work moving.')
      const pause = await run.untilPause()
      assert.ok(pause)
      assert.equal(pause.reason, 'turn_incomplete')
      await run.continue()
      const settled = await run.settled()
      assert.equal(settled.kind, 'ended')

      const notes = relay.log.filter((m) => m.kind === 'note').map((m) => m.text)
      const merged = notes.find((t) => /merged into/.test(t) && t.includes('seat-alpha'))
      assert.ok(merged, 'the merge happened and is recorded')
      assert.match(merged, /turn ended timed_out \(uncertain\)/, 'a merge on an uncertain turn is still one')

      // The line that used to say nothing.
      const leftBehind = notes.find((t) => /still dirty after its boundary commit/.test(t))
      assert.ok(leftBehind, 'a tree left dirty by the boundary must still be reported')
      assert.ok(
        leftBehind.includes('late-on-merge.txt'),
        'and must name the file, which is the whole difference between a report and a formality',
      )
      assert.match(leftBehind, /1 untracked/)
      assert.ok(leftBehind.includes(tree.worktreePath), 'and say which tree it read')

      // The commit that merged carries the doubt, and the late file is still there.
      assert.match(git(repo, 'log', '--format=%B', '-n', '20'), /^Conclave-Turn-End: timed_out \(uncertain\)$/m)
      assert.equal(readFileSync(join(tree.worktreePath, 'late-on-merge.txt'), 'utf8'), 'late\n')
    } finally {
      await relay.stop()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
