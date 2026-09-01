/**
 * What the advisor is actually TOLD about the seats it commands, end to end (#192).
 *
 * The unit tests in `src/registry/instructionBriefing.test.ts` prove the renderer. These prove
 * the four things only a run can show: that a seat's claims are resolved through the definition
 * that seat was FILLED from, that the seats consulted are the writing ones and no others, that
 * the block lands in the right place among the conditional blocks, and that a run whose agents
 * declare nothing is byte-identical to one built before the field existed.
 *
 * The last is the one worth the setup cost. A briefing block is invisible to every other guard
 * in this suite -- it changes no id, no flag, no JSON key and no report shape -- so an
 * unconditional block would ship green, which is exactly how `MULTI_SEAT_BRIEFING` was once
 * found to be leaking into one-seat runs.
 *
 *   node --test src/relay/capabilityBriefing.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS, type GradedClaim, type InstructionCapabilities } from '../registry/types.ts'
import { CAPABILITY_DESCRIPTORS } from '../registry/instructionBriefing.ts'
import { Relay } from './relay.ts'

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-capbrief-'))
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir })
  return dir
}

const claim = (): GradedClaim => ({
  supported: true,
  evidence: 'inferred_from_documented_event',
  source: 'a literal in the installed binary',
  sourceVersion: '1.0.0',
})

/** What one descriptor puts in the block, so a test asserts on the rendered words. */
function say(key: keyof InstructionCapabilities): string {
  const d = CAPABILITY_DESCRIPTORS.find((c) => c.key === key)
  assert.ok(d, `${key} must have a descriptor`)
  return d.instruction
}

interface AgentSpec {
  /** Absent means the definition carries no declaration at all, as every agent did before #192. */
  declares?: InstructionCapabilities | undefined
  sessions: FakeRotationSession[]
}

function registryOf(agents: Record<string, AgentSpec>): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, spec] of Object.entries(agents)) {
    const remaining = [...spec.sessions]
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
      ...(spec.declares ? { instructionCapabilities: spec.declares } : {}),
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

/** The advisor's opening prompt for a run built from `agents` and seated by `seating`. */
async function openingPrompt(
  agents: Record<string, AgentSpec>,
  seating: Omit<Parameters<typeof Relay.start>[0], 'registry' | 'cwd'>,
  advisorSession: FakeRotationSession,
): Promise<string> {
  const repo = tempRepo()
  const relay = await Relay.start({ registry: registryOf(agents), cwd: repo, ...seating })
  try {
    await relay.run('a goal')
    return advisorSession.received[0] ?? ''
  } finally {
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
}

/** The default shape: one advisor, one writing seat, nothing else. */
function soloSeating(): Omit<Parameters<typeof Relay.start>[0], 'registry' | 'cwd'> {
  return {
    lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
    maxAdvisorTurns: 1,
  }
}

test('a seat whose agent declares reaches the advisor with its claims', async () => {
  const lead = new FakeRotationSession('lead', 'codex', ['DONE'])
  const opening = await openingPrompt(
    {
      codex: { sessions: [lead] },
      claude: {
        declares: { subagents: claim(), autonomousLoop: claim() },
        sessions: [new FakeRotationSession('impl', 'claude', [])],
      },
    },
    soloSeating(),
    lead,
  )
  assert.match(opening, /CAN BE INSTRUCTED TO DO THE FOLLOWING/, 'the block is present')
  assert.ok(opening.includes(say('subagents')), 'and carries what was declared')
  assert.ok(opening.includes(say('autonomousLoop')))
  assert.ok(!opening.includes(say('boundedIteration')), 'and only what was declared')
})

test('a run whose agents declare nothing supported is byte-identical to one before the field', async () => {
  // Three ways to claim nothing, against a definition carrying no declaration at all. All four
  // openings must be the same STRING -- not merely free of a marker, because a block that
  // rendered a heading over an empty list would pass a marker check and still charge the run
  // for a paragraph it has no content for.
  const baseline = async (declares: InstructionCapabilities | undefined): Promise<string> => {
    const lead = new FakeRotationSession('lead', 'codex', ['DONE'])
    return openingPrompt(
      {
        codex: { sessions: [lead] },
        claude: { declares, sessions: [new FakeRotationSession('impl', 'claude', [])] },
      },
      soloSeating(),
      lead,
    )
  }
  const undeclared = await baseline(undefined)
  assert.doesNotMatch(undeclared, /CAN BE INSTRUCTED TO DO THE FOLLOWING/, 'no block at all')
  // And not even the SEPARATOR of one. Comparing the three silent variants to each other is
  // not enough on its own and this line is here because a mutation proved it: appending the
  // block unconditionally gives all three the same two extra newlines, so they stay equal to
  // each other while every advisor in the project reads a stray blank paragraph. A clean
  // opening never runs three newlines together -- the blocks above are joined by exactly two --
  // so this is the shape an empty block leaves behind.
  assert.doesNotMatch(undeclared, /\n\n\n/, 'an empty block must not cost the run a paragraph break')
  assert.equal(await baseline({}), undeclared, 'an empty declaration adds nothing')
  assert.equal(
    await baseline({ subagents: { ...claim(), supported: false }, autonomousLoop: { ...claim(), supported: false } }),
    undeclared,
    'a declaration of nothing but false adds nothing',
  )
})

test('the capability block sits after the multi-seat and reviewer blocks, and before the goal', async () => {
  const lead = new FakeRotationSession('lead', 'codex', ['DONE'])
  const opening = await openingPrompt(
    {
      codex: { sessions: [lead] },
      claude: {
        declares: { subagents: claim() },
        sessions: [
          new FakeRotationSession('a', 'claude', []),
          new FakeRotationSession('b', 'claude', []),
          new FakeRotationSession('rev', 'claude', []),
        ],
      },
    },
    {
      lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
      implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
      implementers: [
        { id: 'implementer', agent: 'claude', role: 'implementer' },
        { id: 'implementer-2', agent: 'claude', role: 'implementer' },
      ],
      reviewer: { id: 'reviewer', agent: 'claude', role: 'reviewer' },
      maxAdvisorTurns: 1,
    },
    lead,
  )
  const at = (needle: string | RegExp): number => {
    const i = typeof needle === 'string' ? opening.indexOf(needle) : opening.search(needle)
    assert.notEqual(i, -1, `${String(needle)} must appear in the opening prompt`)
    return i
  }
  const multiSeat = at('MORE THAN ONE IMPLEMENTER SEAT')
  const reviewer = at('THIS RUN ALSO HAS A REVIEWER SEAT')
  // Anchored on a descriptor's own rendered words, read live from the table, rather than on any
  // fixed prose: this test is about WHERE the block sits, and it must not fail when the wording
  // inside it changes. Anchoring it on the preamble made a prose edit look like an ordering bug.
  const capabilities = at(say('subagents'))
  const goal = at('The goal for this session:')
  assert.ok(multiSeat < reviewer, 'multi-seat first, as it always was')
  assert.ok(reviewer < capabilities, 'the capability block follows the reviewer block')
  assert.ok(capabilities < goal, 'and everything conditional precedes the goal')
})

test('each seat’s claims are attributed to that seat and merged with no other', async () => {
  const lead = new FakeRotationSession('lead', 'codex', ['DONE'])
  const opening = await openingPrompt(
    {
      codex: { sessions: [lead] },
      claude: {
        declares: { subagents: claim() },
        sessions: [new FakeRotationSession('a', 'claude', [])],
      },
      opencode: {
        declares: { boundedIteration: claim() },
        sessions: [new FakeRotationSession('b', 'opencode', [])],
      },
    },
    {
      lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
      implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
      implementers: [
        { id: 'implementer', agent: 'claude', role: 'implementer' },
        { id: 'implementer-2', agent: 'opencode', role: 'implementer' },
      ],
      maxAdvisorTurns: 1,
    },
    lead,
  )
  const first = opening.indexOf('SEAT implementer CAN BE INSTRUCTED')
  const second = opening.indexOf('SEAT implementer-2 CAN BE INSTRUCTED')
  assert.notEqual(first, -1, 'the first seat is named')
  assert.notEqual(second, -1, 'the second seat is named')
  assert.ok(first < second, 'in seat order')
  const firstBlock = opening.slice(first, second)
  const secondBlock = opening.slice(second, opening.indexOf('The goal for this session:'))
  assert.ok(firstBlock.includes(say('subagents')), 'the claude seat gets the claude claim')
  assert.ok(!firstBlock.includes(say('boundedIteration')), 'and not the opencode one')
  assert.ok(secondBlock.includes(say('boundedIteration')), 'the opencode seat gets the opencode claim')
  assert.ok(!secondBlock.includes(say('subagents')), 'and not the claude one')
})

test('the advisor’s and the reviewer’s own declarations never reach the block', async () => {
  // Neither writes code, so neither is something the advisor can be told to instruct. The
  // reviewer is excluded by ROLE and the advisor by RANK, and both exclusions are `#implementers()`
  // -- reaching for `#dispatchSeats()` or `participants` here would put a seat in the block that
  // takes no instruction at all.
  const lead = new FakeRotationSession('lead', 'codex', ['DONE'])
  const opening = await openingPrompt(
    {
      // Only the advisor's agent declares this one, and only the reviewer's declares the other.
      codex: { declares: { sessionBackgrounding: claim() }, sessions: [lead] },
      kimi: {
        declares: { asyncPromptSubmission: claim() },
        sessions: [new FakeRotationSession('rev', 'kimi', [])],
      },
      claude: {
        declares: { subagents: claim() },
        sessions: [new FakeRotationSession('impl', 'claude', [])],
      },
    },
    {
      lead: { id: 'advisor', agent: 'codex', role: 'advisor' },
      implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
      reviewer: { id: 'reviewer', agent: 'kimi', role: 'reviewer' },
      maxAdvisorTurns: 1,
    },
    lead,
  )
  assert.ok(opening.includes(say('subagents')), 'the writing seat is described')
  assert.ok(!opening.includes(say('sessionBackgrounding')), 'the advisor’s own agent is not')
  assert.ok(!opening.includes(say('asyncPromptSubmission')), 'nor the reviewer’s')
  assert.ok(!opening.includes('SEAT reviewer'), 'and the reviewer is not named as an instructable seat')
})
