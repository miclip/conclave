/**
 * What a dry run says about the bounds — the ceilings that end the run, and the two clocks
 * each seat's turns are measured against.
 *
 *   node --test src/relay/dryRunBounds.test.ts
 *
 * The plan already described WHO would be launched and with what arguments, which is the half
 * an operator could have worked out from their own argv. It said nothing about the half they
 * could not: the advisor budget that actually ends the run (#119 is a run that ended at one
 * while its operator watched `--max-turns` in the argv and believed otherwise), and whether
 * the seats they chose run the clocks they configured at all. `--silence-timeout 300` against
 * an adapter that declares no silence clock is a setting that reached nothing, and no amount
 * of reading the command back would show it.
 *
 * So the plan carries both, resolved by the SAME functions the run itself is given --
 * `effectiveCeilings` and `resolveDeadlines` -- and this file is the behavioural half of that
 * claim. Three things are asserted and each is a way the feature could be present and useless:
 *
 *   - CONFIGURED values arrive, rather than the plan reporting a default it computed itself.
 *   - UNSET reports `null` with the key PRESENT, rather than the key vanishing. A key that
 *     disappears when a limit is unset cannot be told from a key the reader forgot to look
 *     for, which is the argument `RunCeilings` and `RunDeadlines` are both written around.
 *   - PER SEAT, the three resolutions stay distinct: `enforced`, `disabled` (a clock the
 *     adapter has and this run left off) and `unsupported` (a clock it does not have). A
 *     reader that collapsed the last two is waiting for a `timed_out` that cannot arrive.
 *
 * Everything is read off the PARSED payload rather than by matching text against stdout. A
 * regression that printed the right numbers into the wrong keys, or that emitted a plan whose
 * JSON no longer parses, passes a substring match and fails here.
 *
 * The registry is injected and its agents are declared with clocks chosen for this file, not
 * borrowed from the built-ins: the built-in table is a fact about four adapters that can
 * change, and a test whose `unsupported` case depends on kimi still lacking a silence clock is
 * a test that goes quiet the day kimi grows one.
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
import type { DeadlineSupport } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { tempDir } from '../testkit/tempDir.ts'

/** A git repository, because `relay` refuses to start outside one. */
function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-dryrun-bounds')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'work.ts'), 'export const a = 1\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
    cwd: dir,
  })
  return dir
}

/**
 * Three agents, one per resolution the report must keep distinct.
 *
 * `both` declares both clocks with defaults, so it is `enforced` whether or not the invocation
 * asks. `nodefault` declares both clocks and no default, so it is `disabled` when nobody asks
 * and `enforced` when somebody does -- the case that proves a request beats an absent default.
 * `neither` declares no clock at all and stays `unsupported` however hard it is configured.
 */
const CLOCKS: Record<string, DeadlineSupport> = {
  both: {
    absolute: { supported: true, defaultMs: 2_700_000 },
    silence: { supported: true, defaultMs: 720_000 },
  },
  nodefault: { absolute: { supported: true }, silence: { supported: true } },
  neither: { absolute: { supported: false }, silence: { supported: false } },
}

function fakeRegistry(created: string[], opts?: { failCreate?: boolean }): AgentRegistry {
  const registry = new AgentRegistry()
  for (const [agent, deadlines] of Object.entries(CLOCKS)) {
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
      deadlines,
      launch: { command: agent, baseArgs: [] },
      async create(resolved) {
        // Recorded rather than refused, so a regression that fell through to a real start is
        // an assertion about `created` instead of a hung suite.
        created.push(resolved.spec.id)
        // The control below asks for a REAL launch and needs it to stop somewhere. Throwing
        // out of the first seat stops it past every line the preamble prints and before any
        // relay loop exists to wait on -- which is the whole of what that test needs.
        if (opts?.failCreate) throw new Error('control: stopping the run at the first seat')
        return new FakeRotationSession(`${agent}-1`, agent, [])
      },
    })
  }
  return registry
}

interface Ran {
  /** `-1` when the run threw, which is how the real-launch control stops. */
  code: number
  /** `console.log`: the JSON document alone, under `--json`. */
  out: string[]
  /** `console.error`: where `say` writes under `--json`, and where the goal lint always goes. */
  err: string[]
  /**
   * EVERY human-facing line, from all three sinks, in the order it was written.
   *
   * The counting test reads this rather than `out`, and the difference is the assertion: a
   * "fix" that moved a duplicated line to the other stream would leave `out` with one
   * occurrence and the operator with two.
   */
  said: string[]
  created: string[]
}

async function runCli(
  dir: string,
  argv: readonly string[],
  opts?: { failCreate?: boolean },
): Promise<Ran> {
  const out: string[] = []
  const err: string[] = []
  const said: string[] = []
  const created: string[] = []
  const beforeCwd = process.cwd()
  const [log, error] = [console.log, console.error]
  console.log = (...a: unknown[]) => {
    const line = a.map(String).join(' ')
    out.push(line)
    said.push(line)
  }
  console.error = (...a: unknown[]) => {
    const line = a.map(String).join(' ')
    err.push(line)
    said.push(line)
  }
  try {
    process.chdir(dir)
    const code = await main([...argv], {
      registry: fakeRegistry(created, opts),
      input: (() => {
        const s = new PassThrough()
        s.end()
        return s
      })(),
      // The console writes its plan through its own `write`, which goes here.
      output: new Writable({
        write(chunk, _e, cb) {
          const lines = String(chunk).split('\n').filter(Boolean)
          err.push(...lines)
          said.push(...lines)
          cb()
        },
      }),
    })
    return { code, out, err, said, created }
  } catch {
    // The real-launch control stops by throwing out of `create`. What it wrote on the way is
    // the subject of that test, so the throw is absorbed rather than propagated.
    return { code: -1, out, err, said, created }
  } finally {
    process.chdir(beforeCwd)
    console.log = log
    console.error = error
  }
}

const PLAN_MARKER = 'dry run — nothing was started'

/** The plan and nothing above it: relay prints a preamble first, the console does not. */
function planFrom(said: readonly string[]): string[] {
  const at = said.indexOf(PLAN_MARKER)
  assert.ok(at >= 0, `a plan must be printed; it said:\n${said.join('\n')}`)
  return said.slice(at)
}

/** The plan as a document, parsed. Never matched as text: see the header. */
async function planJson(dir: string, argv: readonly string[]): Promise<Record<string, any>> {
  const { code, out, err, created } = await runCli(dir, [...argv, '--dry-run', '--json'])
  assert.equal(code, 0, `the dry run must succeed; it said:\n${err.join('\n')}`)
  assert.deepEqual(created, [], 'a dry run must start nothing')
  const parsed = JSON.parse(out.join('\n'))
  assert.equal(parsed.dryRun, true, 'stdout under --json must be the plan and nothing else')
  return parsed
}

const SEATS = [
  '--advisor',
  'both',
  '--implementer',
  'nodefault',
  '--implementers',
  'nodefault, neither',
]

test('a dry run reports the ceilings and the deadlines the invocation configured', async (t) => {
  const dir = repo(t)
  {
    const plan = await planJson(dir, [
      'relay',
      'a goal that would be measured against something',
      ...SEATS,
      '--rounds',
      '6',
      '--max-turns',
      '40',
      '--max-minutes',
      '5',
      '--max-queue-depth',
      '3',
      '--max-concurrent-seats',
      '2',
      '--turn-timeout',
      '900',
      '--silence-timeout',
      '300',
    ])

    // Every ceiling as typed, converted where the flag's unit differs from the field's, and
    // `advisorTurns` from `--rounds` rather than from the default this run overrode. Compared
    // whole rather than field by field: an extra key here is a change to the document.
    assert.deepEqual(plan.ceilings, {
      advisorTurns: 6,
      maxTurns: 40,
      maxDurationMs: 300_000,
      maxQueueDepth: 3,
      maxConcurrentSeats: 2,
    })

    // What was ASKED for, kept apart from what the seats did with it. The gap between the two
    // is the reading this exists for.
    assert.equal(plan.deadlines.configuredAbsoluteMs, 900_000)
    assert.equal(plan.deadlines.configuredSilenceMs, 300_000)

    // Every seat, in seat order, ids as the run will key its turns by.
    assert.deepEqual(
      plan.deadlines.participants.map((p: any) => [p.id, p.agent]),
      [
        ['advisor', 'both'],
        ['implementer', 'nodefault'],
        ['implementer-2', 'neither'],
      ],
    )
    const at = (id: string) => plan.deadlines.participants.find((p: any) => p.id === id)
    // A request beats the adapter's default...
    assert.deepEqual(at('advisor').absolute, { status: 'enforced', ms: 900_000 })
    assert.deepEqual(at('advisor').silence, { status: 'enforced', ms: 300_000 })
    // ...and reaches a clock that has no default of its own.
    assert.deepEqual(at('implementer').absolute, { status: 'enforced', ms: 900_000 })
    assert.deepEqual(at('implementer').silence, { status: 'enforced', ms: 300_000 })
    // And an unsupported clock stays unsupported however hard it is configured. This seat is
    // in the same run as two that took the setting, which is the whole reason the resolution
    // is per seat: refusing the flag outright would have discarded it for the other two.
    assert.deepEqual(at('implementer-2').absolute, { status: 'unsupported' })
    assert.deepEqual(at('implementer-2').silence, { status: 'unsupported' })
  }
})

test('a dry run that configured nothing says so with the keys present and null', async (t) => {
  const dir = repo(t)
  {
    const plan = await planJson(dir, ['relay', 'a goal with no bounds named at all', ...SEATS])

    // PRESENT, and that is the assertion. `null` and absent are the same to a reader who does
    // not already know the key exists, and the operator reading a plan to find out what is
    // unbounded is exactly the reader who does not.
    for (const key of ['maxTurns', 'maxDurationMs', 'maxQueueDepth', 'maxConcurrentSeats']) {
      assert.ok(key in plan.ceilings, `${key} must be present even when nothing set it`)
      assert.equal(plan.ceilings[key], null, `${key} must read null rather than 0 or absent`)
    }
    // Never null: every run has an advisor budget, set or defaulted, and this is the one #119
    // is actually about. `4` is relay's default and is asserted as a value the plan REPORTS
    // rather than as one it invents -- nothing in this argv named it.
    assert.equal(plan.ceilings.advisorTurns, 4)

    for (const key of ['configuredAbsoluteMs', 'configuredSilenceMs']) {
      assert.ok(key in plan.deadlines, `${key} must be present even when nobody asked`)
      assert.equal(plan.deadlines[key], null, `${key} must read null rather than 0 or absent`)
    }

    const at = (id: string) => plan.deadlines.participants.find((p: any) => p.id === id)
    // The adapter's own defaults, unasked. This is the number a turn is really measured
    // against on a run that configured nothing, and it is not in the argv anywhere.
    assert.deepEqual(at('advisor').absolute, { status: 'enforced', ms: 2_700_000 })
    assert.deepEqual(at('advisor').silence, { status: 'enforced', ms: 720_000 })
    // DISABLED, not unsupported: this adapter HAS both clocks and this run left them off. The
    // two read the same to an operator watching a turn run forever and mean opposite things --
    // one is fixed by a flag and the other cannot be.
    assert.deepEqual(at('implementer').absolute, { status: 'disabled' })
    assert.deepEqual(at('implementer').silence, { status: 'disabled' })
    assert.deepEqual(at('implementer-2').absolute, { status: 'unsupported' })
    assert.deepEqual(at('implementer-2').silence, { status: 'unsupported' })
  }
})

test('the prose plan names the flag that sets each clock, and agrees with the JSON', async (t) => {
  // The prose is the form BOTH front-ends print -- `session` has no `--json` at all, so for a
  // console operator these lines are the only place any of this appears. Naming the flag is
  // the point rather than a nicety: the reader is deciding whether what they typed took
  // effect, and `absolute: 900s` cannot answer that where `--turn-timeout 900s` can. It is the
  // argument `ceilingSummary` was written around, and #119 is what it costs when the line
  // names the concept instead of the flag.
  const dir = repo(t)
  {
    const argv = [
      'relay',
      'a goal whose plan is read by a human',
      ...SEATS,
      '--turn-timeout',
      '900',
      '--silence-timeout',
      '300',
    ]
    const { code, out, err } = await runCli(dir, [...argv, '--dry-run'])
    assert.equal(code, 0, `the dry run must succeed; it said:\n${out.join('\n')}`)
    const plan = out.slice(out.indexOf('dry run — nothing was started'))
    assert.ok(plan.length > 0, `the plan must be printed; stdout was:\n${out.join('\n')}`)
    // Without `--json` the plan is on stdout, where the goal lint's warning is not. Asserted
    // as an absence on stderr rather than by counting stderr's lines: the lint fires on this
    // goal and is nothing to do with the claim here.
    assert.ok(
      !err.some((l) => l.includes('--turn-timeout')),
      `without --json the plan belongs on stdout; stderr said:\n${err.join('\n')}`,
    )

    const line = (label: string) => plan.find((l) => l.startsWith(`  ${label}:`))
    const turn = line('turn')
    const silence = line('silence')
    const ceilings = line('ceilings')
    assert.ok(turn, `the plan must carry a turn line; it said:\n${plan.join('\n')}`)
    assert.ok(silence, `the plan must carry a silence line; it said:\n${plan.join('\n')}`)
    assert.ok(ceilings, `the plan must carry a ceilings line; it said:\n${plan.join('\n')}`)

    // The flag, then what was asked of it, then what each seat did with it.
    assert.match(turn, /--turn-timeout 900s/)
    assert.match(silence, /--silence-timeout 300s/)
    assert.match(ceilings, /--rounds 4\b/)
    // Named per seat, `unsupported` printed rather than omitted -- the seat an operator most
    // needs to see is the one their setting did not reach.
    assert.match(turn, /advisor 900s/)
    assert.match(turn, /implementer-2 unsupported/)
    assert.match(silence, /implementer 300s/)
    assert.match(silence, /implementer-2 unsupported/)

    // And the two renderings of one resolution agree. The prose could name every flag
    // correctly and still be built from a second resolution; this is what says it is not.
    const json = await planJson(dir, argv)
    assert.equal(json.deadlines.configuredAbsoluteMs, 900_000)
    assert.equal(json.deadlines.configuredSilenceMs, 300_000)
    assert.equal(
      json.deadlines.participants.find((p: any) => p.id === 'implementer-2').silence.status,
      'unsupported',
      'the word the prose printed must be the status the document carries',
    )
  }
})

test('a relay dry run states each bound exactly once, and it is the plan that states it', async (t) => {
  // THE REGRESSION. `relay` prints a launch preamble -- `ceilings:`, then the two clock lines,
  // then the rotation line -- and the shared plan grew the same three. So a relay dry run said
  // each of them twice, three lines apart, in two column alignments, from one resolution.
  //
  // Worse than noise. The two blocks CANNOT disagree -- they are rendered from the same two
  // objects -- and that is exactly what an operator reading them cannot tell by looking, so
  // the second copy buys nothing and costs a comparison. The console never had it (`runSession`
  // returns above its banner), so the duplicate was also the two front-ends' dry runs reading
  // differently in the one place they are meant to read identically.
  const dir = repo(t)
  {
    const argv = [
      'relay',
      'a goal whose bounds are stated once',
      ...SEATS,
      '--max-turns',
      '40',
      '--turn-timeout',
      '900',
      '--silence-timeout',
      '300',
      '--dry-run',
    ]
    const { code, said } = await runCli(dir, argv)
    assert.equal(code, 0, `the dry run must succeed; it said:\n${said.join('\n')}`)

    // Counted over EVERY sink in write order, not over stdout. A fix that moved one copy to
    // stderr would leave stdout clean and the operator still reading it twice.
    for (const label of ['ceilings:', 'turn:', 'silence:'] as const) {
      const hits = said.filter((l) => l.trimStart().startsWith(label))
      assert.equal(
        hits.length,
        1,
        `a dry run must state ${label} exactly once; it said:\n${hits.join('\n')}`,
      )
    }

    // And the one occurrence is the PLAN's, not the preamble's. Deleting the plan lines would
    // satisfy the count above and lose the console its only report of any of this -- `session`
    // has no `--json` and no preamble, so the plan is all it has.
    const plan = planFrom(said)
    for (const label of ['ceilings:', 'turn:', 'silence:'] as const) {
      assert.ok(
        plan.some((l) => l.trimStart().startsWith(label)),
        `${label} must survive inside the plan; the plan was:\n${plan.join('\n')}`,
      )
    }
  }
})

test('a real relay launch still says what bounds it, in the preamble it is the only reader of', async (t) => {
  // The control, and the reason the test above is not asserting that three lines were deleted.
  // A run that prints no plan has nowhere else to say any of this, and these lines are the
  // reading #119 is about: what stops the run, told before there is work to lose.
  //
  // Stopped by a registry that throws out of `create`, which is well past every line asserted
  // here and before any relay loop exists to wait on.
  const dir = repo(t)
  {
    const { code, said, created } = await runCli(
      dir,
      [
        'relay',
        'a goal that would really start a run',
        ...SEATS,
        '--max-turns',
        '40',
        '--turn-timeout',
        '900',
        '--silence-timeout',
        '300',
      ],
      { failCreate: true },
    )
    assert.equal(code, -1, 'the control must stop at the first seat rather than complete')
    assert.ok(created.length > 0, 'and it must have got as far as creating one')
    assert.ok(
      !said.includes(PLAN_MARKER),
      'a run without --dry-run prints no plan, which is why the preamble is load-bearing',
    )

    const line = (label: string) => said.find((l) => l.trimStart().startsWith(label))
    assert.match(line('ceilings:') ?? '', /--rounds 4 · --max-turns 40\b/)
    assert.match(line('turn:') ?? '', /--turn-timeout 900s/)
    assert.match(line('silence:') ?? '', /--silence-timeout 300s/)
    // Resolved per seat here too, including the seat the setting could not reach.
    assert.match(line('turn:') ?? '', /implementer-2 unsupported/)
  }
})

test('suppressing relay’s preamble left the plan itself identical on both front-ends', async (t) => {
  // The parity claim, narrowed to this fix. `frontEndParity.test.ts` compares the two plans
  // line for line over every kind of launch argument and is the general guard; what is asserted
  // HERE is that the change made to relay's preamble did not reach the plan -- the cheapest
  // wrong fix for the duplication is to render fewer lines when the caller is relay, which
  // would pass a count of one and silently give the two commands different plans.
  const dir = repo(t)
  {
    const argv = (front: 'relay' | 'session') => [
      front,
      'a goal both front-ends resolve identically',
      ...SEATS,
      '--rounds',
      '6',
      '--max-turns',
      '40',
      '--turn-timeout',
      '900',
      '--silence-timeout',
      '300',
      '--dry-run',
    ]
    const plans: Record<string, string[]> = {}
    for (const front of ['relay', 'session'] as const) {
      const { code, said, created } = await runCli(dir, argv(front))
      assert.equal(code, 0, `${front} --dry-run must succeed; it said:\n${said.join('\n')}`)
      assert.deepEqual(created, [], 'a dry run must start nothing, on either command')
      plans[front] = planFrom(said)
    }
    assert.deepEqual(
      plans['relay'],
      plans['session'],
      'the two front-ends describe one invocation differently, which is the failure a dry run ' +
        'cannot survive: its whole value is that the plan is the run.',
    )
    // Named as well as compared, so parity cannot be satisfied by both plans losing the lines.
    assert.deepEqual(
      plans['relay']!.filter((l) => /^ {2}(ceilings|turn|silence):/.test(l)),
      [
        '  ceilings:    --rounds 6 · --max-turns 40 · --max-minutes none · --max-queue-depth none · --max-concurrent-seats none',
        '  turn:        --turn-timeout 900s — advisor 900s · implementer 900s · implementer-2 unsupported',
        '  silence:     --silence-timeout 300s — advisor 300s · implementer 300s · implementer-2 unsupported',
      ],
    )
  }
})
