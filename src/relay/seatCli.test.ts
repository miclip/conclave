/**
 * `--implementers` on both real front-ends, observed at the registry.
 *
 * `implementerSeats.test.ts` proves the RelayOptions field works; this proves an operator can
 * reach it. The two are different claims, and the gap between them is where this codebase has
 * repeatedly lost a capability: `--turn-timeout` was parsed, dropped into a conditional spread
 * that TypeScript does not excess-property check, and never once worked, while every test that
 * read the CLI as text agreed it was wired.
 *
 * So nothing here reads source. Both commands are driven through `main(...)` from
 * `bin/conclave.ts` with only the registry replaced, and what is asserted is what the registry
 * was ASKED TO CREATE: the seat id, the agent behind it, and the directory it was created in.
 * `resolved.spec.id` at that point is the string the front-end put in its option object --
 * `Relay.start` resolved it, and no test supplied it.
 *
 * The cwd is the second half and is not decoration. Two seats sharing one checkout is the exact
 * state D6 exists to prevent, and the only place it is observable at construction time is here:
 * a seat is launched with its tree fixed, so a run whose seats were created in the same
 * directory is a run in which neither seat's diff is its own, whatever it reports later.
 *
 *   node --test src/relay/seatCli.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { main } from '../../bin/conclave.ts'
import { AgentRegistry } from '../registry/registry.ts'
import type { CreateParticipantContext, ResolvedParticipant } from '../registry/types.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { tempDir } from '../testkit/tempDir.ts'

/** What the front-end asked the registry to build, and where. */
interface CreateRecord {
  id: string
  agent: string
  cwd: string
}

/**
 * A registry whose agents hand out a QUEUE of sessions rather than one.
 *
 * Two seats filled by the same agent must be two children. A registry returning one session
 * twice would make `--implementers claude,claude` pass every id assertion in this file while
 * the run was one session pretending to be two, which is the failure the queue rules out: the
 * second `create` for an agent with one session left throws.
 */
function registryOf(
  queues: Record<string, FakeRotationSession[]>,
  creates: CreateRecord[],
): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, queue] of Object.entries(queues)) {
    const remaining = [...queue]
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
        creates.push({ id: resolved.spec.id, agent: resolved.spec.agent, cwd: ctx.cwd })
        const next = remaining.shift()
        if (!next) throw new Error(`no session left for ${agent}: a seat asked for a second child`)
        return next
      },
    })
  }
  return r
}

/** A repository for a front-end to run in. Both refuse to start outside one. */
function tempRepo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-seatcli')
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir })
  return dir
}

function sink(): NodeJS.WritableStream {
  return new Writable({
    write(_c, _e, cb) {
      cb()
    },
  })
}

/**
 * One front-end invocation, in a fresh repository, with its prose swallowed.
 *
 * The cwd comes back resolved rather than assumed: `tempRepo` already hands back a canonical
 * path, but `process.cwd()` after the chdir is still the sharper comparison, being the
 * directory an operator's shell would actually have handed the command.
 */
async function runCli(
  t: TestContext,
  argv: string[],
  queues: Record<string, FakeRotationSession[]>,
): Promise<{ code: number; creates: CreateRecord[]; cwd: string }> {
  const repo = tempRepo(t)
  const before = process.cwd()
  const creates: CreateRecord[] = []
  const registry = registryOf(queues, creates)
  const [log, error] = [console.log, console.error]
  let cwd = repo
  try {
    process.chdir(repo)
    cwd = process.cwd()
    console.log = () => {}
    console.error = () => {}
    const code = await main(argv, {
      registry,
      // Harmless to the relay command, which reads neither. The console needs an input that
      // stays open, so the session ends on its own terms rather than on EOF.
      input: new PassThrough(),
      output: sink(),
    })
    return { code, creates, cwd }
  } finally {
    console.log = log
    console.error = error
    process.chdir(before)
  }
}

/** An advisor that gives out one instruction and then calls it done. */
const advisorReplies = ['Do the thing.', 'DONE']
/** A seat that acknowledges, works, and has nothing left to raise. */
const seatReplies = ['ack', 'Did it.', 'NONE', 'NONE']

const FRONT_ENDS = [
  { name: 'relay', argv: (flags: string[]) => ['relay', 'do some work', ...flags] },
  { name: 'session', argv: (flags: string[]) => ['session', 'do some work', ...flags] },
] as const

for (const front of FRONT_ENDS) {
  test(`${front.name} --implementers builds one seat per named agent, each in its own tree`, async (t) => {
    const { code, creates, cwd } = await runCli(
      t,
      front.argv(['--advisor', 'fake-lead', '--implementers', 'fake-a,fake-b', '--rounds', '3']),
      {
        'fake-lead': [new FakeRotationSession('lead-1', 'fake-lead', advisorReplies)],
        'fake-a': [new FakeRotationSession('a-1', 'fake-a', seatReplies)],
        'fake-b': [new FakeRotationSession('b-1', 'fake-b', seatReplies)],
      },
    )
    assert.equal(code, 0, 'a two-seat run must succeed')

    assert.deepEqual(
      creates.map((c) => ({ id: c.id, agent: c.agent })),
      [
        { id: 'advisor', agent: 'fake-lead' },
        { id: 'implementer', agent: 'fake-a' },
        { id: 'implementer-2', agent: 'fake-b' },
      ],
      'the seat list must reach the registry as two distinct implementer seats, in the order typed',
    )

    // The first seat keeps the id every message header, routing log line and status document
    // already uses, which is what makes the second seat additive rather than a rename.
    const seats = creates.filter((c) => c.id !== 'advisor')
    assert.equal(seats[0]!.cwd === seats[1]!.cwd, false, 'two seats must not share a working directory')
    for (const s of seats) {
      assert.notEqual(s.cwd, cwd, `${s.id} must work in its own tree rather than the integration checkout`)
    }
    assert.equal(
      creates.find((c) => c.id === 'advisor')!.cwd,
      cwd,
      'the advisor stays in the integration checkout: it reads committed state, it is not a writer',
    )
  })

  test(`${front.name} --implementers with one entry is the default run, and takes no worktree`, async (t) => {
    // D1's identity case reached through the NEW flag. The plural option is passed to
    // `Relay.start` here -- the operator asked for it plurally -- so this is the claim that a
    // one-element list is genuinely the same run and not an approximation of it.
    const { code, creates, cwd } = await runCli(
      t,
      front.argv(['--advisor', 'fake-lead', '--implementers', 'fake-a', '--rounds', '3']),
      {
        'fake-lead': [new FakeRotationSession('lead-1', 'fake-lead', advisorReplies)],
        'fake-a': [new FakeRotationSession('a-1', 'fake-a', seatReplies)],
      },
    )
    assert.equal(code, 0, 'a one-seat run named plurally must succeed')
    assert.deepEqual(
      creates.map((c) => ({ id: c.id, agent: c.agent, cwd: c.cwd })),
      [
        { id: 'advisor', agent: 'fake-lead', cwd },
        { id: 'implementer', agent: 'fake-a', cwd },
      ],
      'one seat is one seat however it was named: same ids, and the operator cwd rather than a worktree',
    )
  })

  test(`${front.name} --implementers with the same agent twice builds two children`, async (t) => {
    // The realistic invocation -- `--implementers claude,claude` -- and the one where a seat
    // table keyed by AGENT rather than by seat would collapse to a single participant. The
    // queue in `registryOf` is what proves two children were asked for: a second `create` for
    // an agent with one session left throws, so this run could not have finished otherwise.
    const first = new FakeRotationSession('same-1', 'fake-a', seatReplies)
    const second = new FakeRotationSession('same-2', 'fake-a', seatReplies)
    const { code, creates } = await runCli(
      t,
      front.argv(['--advisor', 'fake-lead', '--implementers', 'fake-a,fake-a', '--rounds', '3']),
      {
        'fake-lead': [new FakeRotationSession('lead-1', 'fake-lead', advisorReplies)],
        'fake-a': [first, second],
      },
    )
    assert.equal(code, 0, 'two seats on one agent must succeed')
    assert.deepEqual(
      creates.map((c) => c.id),
      ['advisor', 'implementer', 'implementer-2'],
      'the same agent twice is still two seats',
    )
    // Both were briefed. A seat that received nothing was constructed and then ignored, which
    // an id assertion alone cannot tell from a seat that is working.
    assert.ok(first.received.length > 0, 'the first seat must have been sent its briefing')
    assert.ok(second.received.length > 0, 'the second seat must have been sent its briefing')
  })

  test(`${front.name} refuses --implementer and --implementers naming different lead agents`, async (t) => {
    // There is no third seat to put the loser in: the first entry of the list IS the seat
    // `--implementer` names. Picking one silently would ignore a flag the operator typed.
    const { code, creates } = await runCli(
      t,
      front.argv([
        '--advisor',
        'fake-lead',
        '--implementer',
        'fake-a',
        '--implementers',
        'fake-b,fake-a',
        '--rounds',
        '3',
      ]),
      {
        'fake-lead': [new FakeRotationSession('lead-1', 'fake-lead', advisorReplies)],
        'fake-a': [new FakeRotationSession('a-1', 'fake-a', seatReplies)],
        'fake-b': [new FakeRotationSession('b-1', 'fake-b', seatReplies)],
      },
    )
    assert.equal(code, 1, 'the contradiction must be refused')
    assert.deepEqual(creates, [], 'and refused before anything was launched')
  })

  test(`${front.name} refuses a seat list with an empty entry`, async (t) => {
    // `--implementers "fake-a,"` is a shell that ate an argument. Dropping the empty entry
    // silently starts a run with fewer seats than the operator typed.
    const { code, creates } = await runCli(
      t,
      front.argv(['--advisor', 'fake-lead', '--implementers', 'fake-a,', '--rounds', '3']),
      {
        'fake-lead': [new FakeRotationSession('lead-1', 'fake-lead', advisorReplies)],
        'fake-a': [new FakeRotationSession('a-1', 'fake-a', seatReplies)],
      },
    )
    assert.equal(code, 1, 'a malformed seat list must be refused')
    assert.deepEqual(creates, [], 'and refused before anything was launched')
  })

  test(`${front.name} without --implementers names one seat and passes no list`, async (t) => {
    // The control. `--implementer` alone is what it has always been, and this file would be
    // worth little without it: every assertion above is about a flag that must be inert when
    // nobody types it.
    const { code, creates, cwd } = await runCli(
      t,
      front.argv(['--advisor', 'fake-lead', '--implementer', 'fake-a', '--rounds', '3']),
      {
        'fake-lead': [new FakeRotationSession('lead-1', 'fake-lead', advisorReplies)],
        'fake-a': [new FakeRotationSession('a-1', 'fake-a', seatReplies)],
      },
    )
    assert.equal(code, 0, 'the default invocation must succeed')
    assert.deepEqual(
      creates.map((c) => ({ id: c.id, agent: c.agent, cwd: c.cwd })),
      [
        { id: 'advisor', agent: 'fake-lead', cwd },
        { id: 'implementer', agent: 'fake-a', cwd },
      ],
      'a default run is two participants in the operator cwd, exactly as before',
    )
  })
}
