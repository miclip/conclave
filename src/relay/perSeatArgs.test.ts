/**
 * Per-seat launch arguments, from the command line to the child's argv (#77).
 *
 * `--implementer-args` is one flag and it says implementer, so it applies to every seat. That
 * makes seats heterogeneous in AGENT and nothing else, and an agent id is not what a run is
 * actually configured by: one id spans dozens of models at roughly a 30x price spread, so "two
 * seats, different models" -- the ordinary reason to want two seats -- was unsayable.
 *
 * The syntax being proved here carries the agent and its arguments in ONE entry:
 *
 *   --implementers "fake-a --model alpha-1, fake-b --model beta-1"
 *
 * rather than a second flag holding a second list, correlated with the first by position. That
 * alternative is the reason this file asserts what it asserts. Two parallel lists agree only as
 * long as both have the same length and the same order; a shell that eats one entry shifts every
 * argument onto the wrong seat, and nothing downstream can tell -- the run starts, seat two is
 * launched with seat three's model, and the record says so in a way nobody reads until the bill.
 *
 * So the claim is not "the arguments arrived". It is that each seat received ITS OWN and no
 * other seat's, checked in both directions: the model it was given is present, and the other
 * seat's model appears nowhere on its argv. A wiring that concatenated everything and handed the
 * lot to every seat would satisfy a one-directional assertion completely.
 *
 * Nothing is stubbed but the registry. Both front-ends are driven through `main(...)` with the
 * real argv and the real parsing, and the observation point is `effectiveLaunchArgs` inside
 * `create` -- the last place the launch is Conclave's own, and what a real adapter would spread
 * into a child process. A front-end can accept a flag and then drop it, which reads as agreement
 * everywhere except at the child.
 *
 *   node --test src/relay/perSeatArgs.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { main } from '../../bin/conclave.ts'
import { effectiveLaunchArgs } from '../registry/launch.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'

/**
 * A registry whose agents hand out a QUEUE of sessions, recording the argv each seat got.
 *
 * The queue is not decoration. The sharpest case below fills two seats with the SAME agent and
 * gives them different models, which is exactly the shape a per-AGENT argument table collapses:
 * a second `create` for an agent with one session left throws, so a run that quietly built one
 * participant and called it two cannot reach the assertions.
 */
function registryOf(
  queues: Record<string, FakeRotationSession[]>,
  handed: Record<string, string[]>,
): AgentRegistry {
  const registry = new AgentRegistry()
  for (const [agent, queue] of Object.entries(queues)) {
    const remaining = [...queue]
    registry.register({
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
      async create(resolved, ctx) {
        handed[resolved.spec.id] = effectiveLaunchArgs(resolved, ctx)
        const next = remaining.shift()
        if (!next) throw new Error(`no session left for ${agent}: a seat asked for a second child`)
        return next
      },
    })
  }
  return registry
}

/** A repository for a front-end to run in. Both refuse to start outside one. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-seatargs-'))
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir })
  return dir
}

/** An advisor that gives out one instruction and then calls it done. */
const advisorReplies = ['Do the thing.', 'DONE']
/** A seat that acknowledges, works, and has nothing left to raise. */
const seatReplies = ['ack', 'Did it.', 'NONE', 'NONE']

const FRONT_ENDS = ['relay', 'session'] as const

/** One front-end invocation in a fresh repository, and the argv each seat was launched with. */
async function launchesFrom(
  front: (typeof FRONT_ENDS)[number],
  flags: string[],
  queues: Record<string, FakeRotationSession[]>,
): Promise<{ code: number; handed: Record<string, string[]> }> {
  const repo = tempRepo()
  const before = process.cwd()
  const handed: Record<string, string[]> = {}
  const [log, error] = [console.log, console.error]
  try {
    process.chdir(repo)
    console.log = () => {}
    console.error = () => {}
    const code = await main([front, 'give each seat its own model', ...flags], {
      registry: registryOf(queues, handed),
      // The console needs an input that stays open, so the session ends on its own terms
      // rather than on EOF. Harmless to relay, which reads neither.
      input: new PassThrough(),
      output: new Writable({
        write(_c, _e, cb) {
          cb()
        },
      }),
    })
    return { code, handed }
  } finally {
    console.log = log
    console.error = error
    process.chdir(before)
    rmSync(repo, { recursive: true, force: true })
  }
}

for (const front of FRONT_ENDS) {
  test(`${front} gives each seat the launch args typed for that seat and no other`, async () => {
    // Two seats, two agents, two models -- and a run-wide `--implementer-args` alongside them,
    // because the interesting question is not whether per-seat arguments arrive but whether the
    // two kinds compose. The shared one is meant to reach BOTH seats; the per-seat ones are
    // meant to reach exactly one each. A wiring that let either kind win outright would be
    // wrong in a different direction, and only having both in the same invocation shows it.
    const { code, handed } = await launchesFrom(
      front,
      [
        '--advisor',
        'fake-lead',
        '--implementers',
        'fake-a --model alpha-1, fake-b --model beta-1',
        '--implementer-args',
        '--shared shared-1',
        '--rounds',
        '3',
      ],
      {
        'fake-lead': [new FakeRotationSession('lead-1', 'fake-lead', advisorReplies)],
        'fake-a': [new FakeRotationSession('a-1', 'fake-a', seatReplies)],
        'fake-b': [new FakeRotationSession('b-1', 'fake-b', seatReplies)],
      },
    )
    assert.equal(code, 0, 'a two-seat run with per-seat launch args must succeed')

    // The whole argv, in order, rather than a `includes` on the model. Order IS the precedence
    // the child CLI applies to a repeated flag: the seat's own spelling comes last, so a seat
    // naming `--model` overrides one supplied for every seat rather than being overridden by it.
    assert.deepEqual(
      handed['implementer'],
      ['--shared', 'shared-1', '--model', 'alpha-1'],
      'the first seat must be launched with the run-wide args and then its own',
    )
    assert.deepEqual(
      handed['implementer-2'],
      ['--shared', 'shared-1', '--model', 'beta-1'],
      'and the second seat with the run-wide args and then ITS own',
    )

    // The other direction, which is the one an assertion about arrival cannot make. A front-end
    // that handed every seat every argument would satisfy everything above by containing more.
    assert.equal(
      handed['implementer']?.includes('beta-1'),
      false,
      "the first seat must not receive the second seat's model",
    )
    assert.equal(
      handed['implementer-2']?.includes('alpha-1'),
      false,
      "nor the second seat the first seat's",
    )
    // And the advisor is not an implementer seat: `--implementer-args` says implementer.
    assert.deepEqual(handed['advisor'], [], 'the advisor must be launched with none of it')
  })

  test(`${front} keeps per-seat args per SEAT when both seats are filled by one agent`, async () => {
    // The case that separates "per seat" from "per agent", and the realistic invocation for it:
    // one CLI, two models, two seats. Launch arguments have always been keyed by agent --
    // `.conclave/config.json` keys them that way and `implArgsFor` still does -- so a per-seat
    // syntax that resolved through that table would hand both seats whichever entry it saw
    // last, and every assertion in the test above would still pass, because that one uses two
    // different agents.
    const { code, handed } = await launchesFrom(
      front,
      [
        '--advisor',
        'fake-lead',
        '--implementers',
        'fake-a --model alpha-1, fake-a --model alpha-2',
        '--rounds',
        '3',
      ],
      {
        'fake-lead': [new FakeRotationSession('lead-1', 'fake-lead', advisorReplies)],
        'fake-a': [
          new FakeRotationSession('a-1', 'fake-a', seatReplies),
          new FakeRotationSession('a-2', 'fake-a', seatReplies),
        ],
      },
    )
    assert.equal(code, 0, 'two seats on one agent with different models must succeed')
    assert.deepEqual(handed['implementer'], ['--model', 'alpha-1'])
    assert.deepEqual(handed['implementer-2'], ['--model', 'alpha-2'])
  })

  test(`${front} without per-seat args launches the seat exactly as it always did`, async () => {
    // The control, and the D1 claim: a run that names no per-seat argument must compose the
    // argv it composed before the syntax existed -- the project config for the agent, then
    // `--implementer-args`, and nothing else. Every test above is about a spelling that must be
    // inert when nobody types it.
    const { code, handed } = await launchesFrom(
      front,
      ['--advisor', 'fake-lead', '--implementer', 'fake-a', '--implementer-args', '--shared shared-1', '--rounds', '3'],
      {
        'fake-lead': [new FakeRotationSession('lead-1', 'fake-lead', advisorReplies)],
        'fake-a': [new FakeRotationSession('a-1', 'fake-a', seatReplies)],
      },
    )
    assert.equal(code, 0, 'the default invocation must succeed')
    assert.deepEqual(handed['implementer'], ['--shared', 'shared-1'])
    assert.deepEqual(Object.keys(handed).sort(), ['advisor', 'implementer'], 'and build one seat')
  })
}

test('both front-ends launch the same seats with the same argv from the same invocation', async () => {
  // Parity, at the only point that settles it. The two blocks build their seat requests
  // separately -- relay hands `implementerSpecsFor` the list itself, the console passes it
  // through `SessionOptions` and lets `runSession` build the specs -- so this is the wire on
  // which the console could still lose a seat's arguments while accepting the same flag.
  const flags = [
    '--advisor',
    'fake-lead',
    '--implementers',
    'fake-a --model alpha-1, fake-b --model beta-1',
    '--rounds',
    '3',
  ]
  const queues = () => ({
    'fake-lead': [new FakeRotationSession('lead-1', 'fake-lead', advisorReplies)],
    'fake-a': [new FakeRotationSession('a-1', 'fake-a', seatReplies)],
    'fake-b': [new FakeRotationSession('b-1', 'fake-b', seatReplies)],
  })
  const relay = await launchesFrom('relay', flags, queues())
  const session = await launchesFrom('session', flags, queues())
  assert.deepEqual(
    relay.handed,
    session.handed,
    'the same invocation must launch the same seats with the same argv from either front-end',
  )
  // Named as well as compared, so two front-ends that both dropped the arguments cannot satisfy
  // this by agreeing about nothing.
  assert.deepEqual(session.handed['implementer-2'], ['--model', 'beta-1'])
})
