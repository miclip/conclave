/**
 * The two front-ends must not quietly diverge.
 *
 * "A capability wired into one front-end and not the other" is the mistake this codebase has
 * now made eight times, and every one of them was found by somebody hitting it:
 *
 *   --advisor-args      an opencode participant with no model pinned does not fail, it HANGS
 *   --bypass            written into the project by one command and ignored by the other
 *   permission mode     read from .conclave/config.json only by the console
 *   the project config  same, in the other direction
 *   rotation summary    printed at the end of a run by one of them
 *   flag summary        same
 *   --operator agent    relay-only, so an agent could only reach the front-end that ENDS
 *                       the run at every pause -- while the flag claimed someone was
 *                       attending (found by an agent that hand-resumed four times)
 *   --record            documented on SessionOptions as the way to inspect a rendering
 *                       fault in the bytes, and reachable from no invocation at all
 *   --implementer-args  present on BOTH, and the console refused values the relay accepted:
 *                       `--model x` was read as a value that had gone missing (#81)
 *
 * A count that keeps going up is a process failure, not a run of bad luck. So the invariant
 * is inverted here: divergence is allowed, and it must be DECLARED. A flag that exists on one
 * command and not the other fails this test until someone writes down why, which is the step
 * that was missing every time.
 *
 * The eleventh instance is the one that says what this file was missing. `--implementer-args`
 * EXISTS on both commands, so the flag-set test below was satisfied by it while the two
 * front-ends disagreed about which values it takes -- a guard comparing surface rather than
 * capability will keep finding that class satisfactory. So there are now two kinds of test
 * here: the ones that read the source and compare what each block MENTIONS, and the ones that
 * drive both front-ends through `main` and compare what each block ACCEPTS.
 *
 *   node --test src/relay/frontEndParity.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { VALUED_FLAGS, main } from '../../bin/conclave.ts'
import { PASS_THROUGH_FLAGS } from '../config/cliFlags.ts'
import { effectiveLaunchArgs } from '../registry/launch.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { COMMANDS } from '../repl/session.ts'

const CLI = readFileSync(join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts'), 'utf8')

function commandBlock(name: string, endsBefore: string): string {
  const start = CLI.indexOf(`if (command === '${name}')`)
  const end = CLI.indexOf(endsBefore, start)
  assert.ok(start > 0 && end > start, `the ${name} command block must be locatable`)
  return CLI.slice(start, end)
}

/** Every `--flag` the block actually reads. Both spellings the CLI uses. */
function flagsIn(block: string): Set<string> {
  return new Set([
    ...[...block.matchAll(/flag\('([a-z-]+)'/g)].map((m) => m[1]!),
    ...[...block.matchAll(/includes\('--([a-z-]+)'\)/g)].map((m) => m[1]!),
  ])
}

/**
 * Divergence that is a decision rather than an oversight.
 *
 * Each entry is a claim someone made deliberately. Deleting a flag from here is how you
 * propose that the two front-ends should agree again; adding one is how you say they should
 * not, and the reason is the price of admission.
 */
const DECLARED: Record<string, string> = {
  // --- relay only -----------------------------------------------------------------------
  detach:
    'a console detached from its terminal has nothing left to be. The session record makes ' +
    'the WATCHING half unnecessary; driving a detached console is #4 and needs a decision ' +
    'about how input reaches it, not a flag.',
  'detached-id': 'internal: how a detached child adopts the id its parent already printed.',
  // `dry-run` was declared here, on the grounds that relay resolves everything and starts
  // nothing, which needs a point of no return to stop short of, and the console had none -- it
  // starts, then waits for a goal -- so the same flag would describe a plan it was already too
  // late not to have made.
  //
  // RESOLVED rather than deleted quietly, because that reasoning was true when it was written
  // and #130 is what made it false. Everything that answers the argv alone is now resolution
  // done ABOVE the lock check in `runSession`: `readProjectConfig`, the launch-argument
  // composition, every seat spec and `registry.resolve` over each of them. The hook
  // registration, the Codex trust probe, the permission-mode write, the run log and
  // `Relay.start` are all below it, and `guard` only reads -- so the lock IS the console's
  // point of no return, the same boundary relay stops short of, reached by the same argument.
  //
  // The flag is now on both commands and prints the same plan through the same renderer
  // (`dryRunPlan.ts`), so there is no divergence left to declare. Two differences remain and
  // are properties of the front-ends rather than of the flag: the console prints
  // `goal: would be asked for` where it was given none, which relay cannot be, and the console
  // REFUSES `--dry-run` with `--bypass` where relay overlays the requested mode in memory --
  // it has no such overlay, so both applying and skipping the write would be wrong.
  json:
    'the console IS the human surface; a --json console would be two renderings competing ' +
    'for one stdout. `conclave status --json` is the machine-readable view of a live ' +
    'console, and it carries more than a final report can.',
  'strict-goal':
    'deliberate and documented in `begin()`: a goal typed at the console was written by the ' +
    'person reading the warning, who can retype it in a second. Refusing costs more than it ' +
    'saves. Unattended there is nobody to retype it, so relay refuses.',
  // `max-turns` and `max-minutes` were declared here, UNRESOLVED, on the grounds that a
  // ceiling which ENDS a console might be the wrong behaviour. Resolved rather than deleted
  // quietly: `session --operator agent` already makes a console run unattended, so the
  // premise that a human would notice a long run was already false, and the gap was live
  // rather than hypothetical. Both flags now reach both front-ends, along with
  // `max-queue-depth` and `max-concurrent-seats`, so there is no divergence left to declare.
}

test('every flag one front-end takes and the other does not is declared', () => {
  const relay = flagsIn(commandBlock('relay', "if (command === 'session')"))
  const session = flagsIn(commandBlock('session', "if (command === 'demo')"))

  const only = [
    ...[...relay].filter((f) => !session.has(f)).map((f) => [f, 'relay'] as const),
    ...[...session].filter((f) => !relay.has(f)).map((f) => [f, 'session'] as const),
  ]

  const undeclared = only.filter(([f]) => !(f in DECLARED))
  assert.deepEqual(
    undeclared.map(([f, where]) => `--${f} (${where} only)`),
    [],
    'a capability on one front-end and not the other must be a decision someone wrote down. ' +
      'Either wire it into both, or add it to DECLARED with the reason.',
  )

  // The list must not outlive its subject either. A stale exemption is a claim nobody is
  // checking, and it would silently re-permit the divergence it was written to explain.
  const live = new Set(only.map(([f]) => f))
  const stale = Object.keys(DECLARED).filter((f) => !live.has(f))
  assert.deepEqual(stale, [], 'these flags no longer diverge; remove them from DECLARED')
})

/**
 * The same flag, the same value, both commands -- and the same answer.
 *
 * #81 is the reason this exists. `--implementer-args` is on both front-ends, so every test
 * above it passes, and `session --implementer-args "--model x"` was refused while
 * `relay --implementer-args "--model x"` launched. The divergence lived in the PARSING, which
 * has no flag name to be missing from a table.
 *
 * So this compares acceptance rather than existence, over every valued flag both commands take
 * and a table of values chosen for the ways a value can be ambiguous. Nothing is stubbed: both
 * front-ends are driven through `main`, the real argv, the real parsing.
 *
 * Neither command STARTS, and that is arranged rather than hoped for. Every probe carries a
 * seat-plan contradiction (`--implementers "zzz,zzz"` against `--implementer yyy`) that both
 * blocks refuse on before they touch the filesystem, spawn anything or read a registry. So a
 * value the reader ACCEPTED shows up as the seat refusal -- proof that the value got past the
 * parsing and was handed on -- and a value it REFUSED shows up as the missing-value message.
 * The probe goes first in the argv so that a probe naming `--implementer` or `--implementers`
 * is the occurrence that wins, rather than shadowed by the contradiction behind it.
 */
async function verdictOf(front: 'relay' | 'session', probe: readonly string[]): Promise<string> {
  const argv = [
    front,
    'a goal, stopping short of starting anything',
    ...probe,
    '--implementers',
    'zzz,zzz',
    '--implementer',
    'yyy',
  ]
  const [log, error] = [console.log, console.error]
  const said: string[] = []
  console.log = () => {}
  console.error = (...args: unknown[]) => void said.push(args.map(String).join(' '))
  let code: number
  try {
    code = await main(argv)
  } finally {
    console.log = log
    console.error = error
  }
  const text = said.join('\n')
  assert.equal(code, 1, `${front} ${probe.join(' ')} must stop at the seat contradiction, not start a run`)
  // Refused by the flag reader: the value never reached anything downstream.
  if (text.includes('was given without a value')) return 'refused: no value'
  // Accepted: the seat builder is the next thing that refuses, and it can only have been
  // reached by an invocation whose flags all parsed.
  if (text.includes('--implementers')) return 'accepted'
  return `unexpected: ${text.split('\n')[0]}`
}

/**
 * Values, and what each one is.
 *
 * `passThroughOnly` is the whole of the disagreement #81 was about: a value that is argv for a
 * CHILD cli is a value, and a value that is this cli's next flag is a value that went missing.
 * Both readings are defensible; having one command hold each is not.
 *
 * The last row is the price of the first, and it is here to be looked at rather than discovered.
 * After a pass-through flag, one token is consumed whatever it looks like -- so
 * `--implementer-args --json` hands `--json` to the child, and there is no reading of that argv
 * which recovers the operator's intent. What matters is that both commands do the same thing
 * with it; PASS_THROUGH_FLAGS is short for exactly this reason.
 */
const PROBE_VALUES: readonly { value: string; label: string; accepted: 'always' | 'passThroughOnly' }[] = [
  { value: 'plain', label: 'an ordinary word', accepted: 'always' },
  { value: '-m gpt-5', label: 'a short-flag argv fragment', accepted: 'always' },
  { value: '--model gpt-5', label: 'a long-flag argv fragment', accepted: 'passThroughOnly' },
  { value: '--json', label: "this cli's own next flag", accepted: 'passThroughOnly' },
]

test('both front-ends accept the same VALUES for the same flag, not merely the same flags', async () => {
  const shared = VALUED_FLAGS.session.filter((f) => VALUED_FLAGS.relay.includes(f))
  assert.ok(shared.length >= 20, 'the shared valued-flag surface must be the whole of it, not a sample')

  const disagreements: string[] = []
  const wrong: string[] = []
  for (const flag of shared) {
    for (const probe of PROBE_VALUES) {
      const expected =
        probe.accepted === 'always' || PASS_THROUGH_FLAGS.includes(flag)
          ? 'accepted'
          : 'refused: no value'
      const relay = await verdictOf('relay', [`--${flag}`, probe.value])
      const session = await verdictOf('session', [`--${flag}`, probe.value])
      if (relay !== session) {
        disagreements.push(`--${flag} "${probe.value}" (${probe.label}): relay ${relay}, session ${session}`)
      } else if (relay !== expected) {
        wrong.push(`--${flag} "${probe.value}" (${probe.label}): both ${relay}, expected ${expected}`)
      }
    }
  }

  // The parity claim, which is the one this file exists for.
  assert.deepEqual(
    disagreements,
    [],
    'one front-end accepts a value the other refuses. Both commands read their argv with the ' +
      'shared `flagReader`, so a divergence here means one of them stopped using it, or the ' +
      'two were given different flag surfaces to read.',
  )
  // ...and the rule itself, so parity cannot be satisfied by both commands refusing everything.
  assert.deepEqual(
    wrong,
    [],
    'the two front-ends agree, and on the wrong answer. A pass-through flag takes an argv ' +
      'fragment for a child CLI; every other flag treats a leading `--` as a value that went ' +
      'missing. See PASS_THROUGH_FLAGS.',
  )
})

/**
 * A registry whose adapters record the argv they were handed instead of spawning anything.
 *
 * The seam is `create`, which is the last place the launch is Conclave's own: whatever
 * `effectiveLaunchArgs` returns here is what a real adapter would spread into a child process.
 * Comparing the two front-ends THERE is the difference between "both commands accepted the
 * flag" and "both commands did the same thing with it".
 */
function recordingRegistry(handed: Record<string, string[]>): AgentRegistry {
  const registry = new AgentRegistry()
  for (const [agent, replies] of [['fake-lead', ['DONE']], ['fake-impl', []]] as const) {
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
        return new FakeRotationSession(`${agent}-1`, agent, [...replies])
      },
    })
  }
  return registry
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-parity-'))
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir })
  return dir
}

/**
 * A registry that knows the named agents and creates nothing without recording it.
 *
 * `opencode` rather than `claude`/`codex` in the dry-run test below, for a reason that has
 * since been fixed elsewhere and is kept because it is still the tidier choice: `AGENT_KINDS`
 * is the set that needs hook FILES rendered into a project, and opencode is not in it — so the
 * registration and the Codex trust probe are handed an empty agent list whatever order they
 * are called in. That USED to be what kept this test's subject the plan rather than relay's
 * habit of registering hooks above its own dry run; #136 moved both below relay's short-circuit
 * (`src/relay/relayDryRun.test.ts`), so neither front-end reaches them on a dry run now.
 */
function knownAgents(agents: readonly string[], created: string[]): AgentRegistry {
  const registry = new AgentRegistry()
  for (const agent of agents) {
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
      async create(resolved) {
        created.push(resolved.spec.id)
        return new FakeRotationSession(`${agent}-1`, agent, [])
      },
    })
  }
  return registry
}

test('both front-ends describe the same plan, line for line, from one invocation', async () => {
  // `--dry-run` is on both commands as of this test, which is what retires the DECLARED entry
  // above. Existing on both is the weak claim, and this file has been fooled by it before
  // (#81): what matters is that the two commands describe the SAME resolution.
  //
  // They cannot share the composition, and should not. `relay` composes launch arguments in
  // its CLI block; the console composes them inside `runSession`, from the project config it
  // reads there, and a plan built in `bin/conclave.ts` for the console would be a SECOND
  // composition able to disagree with the run it claims to describe. So what is shared is the
  // description -- `dryRunPlan.ts` -- and this asserts the two arrive at the same one.
  //
  // ONE repository, run twice, because `cwd` is a line of the plan. The order used to matter
  // -- session wrote nothing where relay registered hooks and created `.conclave/runs/` above
  // its own dry run -- and since #136 neither front-end writes anything here, so it no longer
  // does.
  //
  // Every kind of launch argument at once, since composition is where the two could differ:
  // config-derived (`--auto`, from the bypass mode written into .conclave/config.json),
  // per-invocation (`--implementer-args`), and per-seat (inside `--implementers`).
  const repo = tempRepo()
  mkdirSync(join(repo, '.conclave'), { recursive: true })
  writeFileSync(
    join(repo, '.conclave', 'config.json'),
    JSON.stringify({ agents: { opencode: { permissions: 'bypass' } } }, null, 2),
  )
  const argsFor = (front: 'relay' | 'session'): string[] => [
    front,
    'a goal both front-ends resolve identically',
    '--advisor',
    'opencode',
    '--implementer',
    'opencode',
    '--implementers',
    'opencode --model a, opencode --model b',
    '--implementer-args',
    '--print',
    '--reviewer',
    'opencode',
    // Short-form, because `--reviewer-args` is not in PASS_THROUGH_FLAGS: both front-ends read
    // a leading `--` there as a value that went missing, which the acceptance table above
    // pins. That agreement is the subject of that test, not of this one.
    '--reviewer-args',
    '-q',
    '--checks',
    'npm test',
    '--checks-informational',
    'npm run lint',
    // NAMED rather than defaulted, and this is the one argument in the list that has to be.
    // The plan reports what stops the run, and the two commands DEFAULT that differently --
    // `relay` to 4 advisor turns and `session` to 8 -- so a plan built from an invocation
    // that did not say would differ here for a reason that is nothing to do with the
    // rendering this test is about. What is compared is one invocation resolved twice; the
    // defaults diverging is a separate fact about the two front-ends and needs its own
    // decision, not a line-for-line comparison quietly arranged to hide it.
    '--rounds',
    '6',
    // A ceiling too, and one whose value travels a different route on each side: `relay`
    // builds `runCeilings` from `ceilingsFrom` in its own block, the console builds
    // `SessionOptions.ceilings` there and resolves it inside `runSession`. Two routes to one
    // line is exactly what this file exists to compare, and without a ceiling set the line
    // would read `none` on both sides whether or not either route works.
    '--max-turns',
    '40',
    // Both clocks, configured, against seats declared with none of them (`NO_DEADLINE_CLOCKS`
    // in `knownAgents` above). So the plan's two deadline lines carry a request that reached
    // nothing -- the case the lines exist for -- and both front-ends must say so identically.
    '--turn-timeout',
    '900',
    '--silence-timeout',
    '300',
    '--dry-run',
  ]

  const before = process.cwd()
  const plans: Record<string, string[]> = {}
  const created: string[] = []
  // What `process.cwd()` reports from inside the repo, which on macOS is the realpath of the
  // temp directory and not the path `mkdtemp` returned. The plan prints the former.
  let cwdSeen = repo
  try {
    process.chdir(repo)
    cwdSeen = process.cwd()
    for (const front of ['session', 'relay'] as const) {
      const said: string[] = []
      const [log, error] = [console.log, console.error]
      console.log = (...a: unknown[]) => void said.push(a.map(String).join(' '))
      console.error = () => {}
      let code: number
      try {
        code = await main(argsFor(front), {
          registry: knownAgents(['opencode'], created),
          input: new PassThrough(),
          // The console writes its plan through its own `write`, which goes here.
          output: new Writable({
            write(chunk, _e, cb) {
              said.push(...String(chunk).split('\n').filter(Boolean))
              cb()
            },
          }),
        })
      } finally {
        console.log = log
        console.error = error
      }
      assert.equal(code, 0, `${front} --dry-run must succeed; it said:\n${said.join('\n')}`)
      // From the marker, because relay prints its own preamble first -- goal lint, hook
      // registration, ceilings, the rotation line -- and the claim here is about the PLAN.
      const at = said.indexOf('dry run — nothing was started')
      assert.ok(at >= 0, `${front} must print a plan; it said:\n${said.join('\n')}`)
      plans[front] = said.slice(at)
    }
  } finally {
    process.chdir(before)
    rmSync(repo, { recursive: true, force: true })
  }

  assert.deepEqual(
    plans['session'],
    plans['relay'],
    'the two front-ends describe one invocation differently, which is the failure a dry run ' +
      'cannot survive: its whole value is that the plan is the run.',
  )
  // Named as well as compared, so parity cannot be satisfied by both commands printing a plan
  // with every argument missing from it. Config-derived, per-invocation and per-seat arguments
  // in that order, on the seat that carries all three.
  assert.deepEqual(plans['session'], [
    'dry run — nothing was started',
    `  cwd:         ${cwdSeen}`,
    '  advisor:     opencode --auto',
    '  implementer: opencode --auto --print --model a',
    '  implementer-2: opencode --auto --print --model b',
    '  reviewer   : opencode --auto -q',
    // What stops the run and what each seat is measured against, resolved by each front-end
    // from its own block and rendered here identically. The deadline lines say `unsupported`
    // four times against a request of 900s and 300s, which is a resolution neither command
    // could have arrived at from the argv alone -- it comes from the registry, through
    // `resolveDeadlines`, on both sides.
    '  ceilings:    --rounds 6 · --max-turns 40 · --max-minutes none · --max-queue-depth none · --max-concurrent-seats none',
    '  turn:        --turn-timeout 900s — advisor unsupported · implementer unsupported · implementer-2 unsupported · reviewer unsupported',
    '  silence:     --silence-timeout 300s — advisor unsupported · implementer unsupported · implementer-2 unsupported · reviewer unsupported',
    '  checks:      npm test [required], npm run lint [informational]',
    '  goal:        a goal both front-ends resolve identically',
  ])
  // And neither front-end created a participant on the way to describing one.
  assert.deepEqual(created, [], 'a dry run must start nothing, on either command')
})

test('the same --implementer-args value reaches the same launch from both front-ends', async () => {
  // #81 end to end, and the half the acceptance table above cannot reach: a front-end could
  // accept a value and then drop it, which reads as agreement everywhere except at the child.
  //
  // `--model x` rather than `-m x` on purpose. The short spelling was what the console tests
  // had to use, and the comment saying why (`the session block's flag helper refuses a value
  // beginning with --`) was the bug, written down and worked around for as long as it existed.
  const argsFor = (front: 'relay' | 'session'): string[] => [
    front,
    'a goal that names a model per seat',
    '--advisor',
    'fake-lead',
    '--implementer',
    'fake-impl',
    '--implementer-args',
    '--model gpt-5',
    '--advisor-args',
    '--model opus-5',
    '--rounds',
    '2',
  ]

  const launches: Record<string, Record<string, string[]>> = {}
  const before = process.cwd()
  for (const front of ['relay', 'session'] as const) {
    const repo = tempRepo()
    const handed: Record<string, string[]> = {}
    try {
      process.chdir(repo)
      const [log, error] = [console.log, console.error]
      console.log = () => {}
      console.error = () => {}
      try {
        await main(argsFor(front), {
          registry: recordingRegistry(handed),
          input: new PassThrough(),
          output: new Writable({ write(_c, _e, cb) { cb() } }),
        })
      } finally {
        console.log = log
        console.error = error
      }
      launches[front] = handed
    } finally {
      process.chdir(before)
      rmSync(repo, { recursive: true, force: true })
    }
  }

  assert.deepEqual(
    launches['relay'],
    launches['session'],
    'the same invocation must launch the same seats with the same argv from either front-end',
  )
  // Named rather than only compared, so two front-ends that both dropped the value cannot
  // satisfy this by agreeing about nothing.
  assert.deepEqual(launches['session']?.['implementer'], ['--model', 'gpt-5'])
  assert.deepEqual(launches['session']?.['advisor'], ['--model', 'opus-5'])
})

test('both front-ends read their argv with the one shared reader, over a declared surface', () => {
  // The structural half of the test above, and the reason it can be cheap: parity of VALUES is
  // a property of one function, so what is left to check is that neither block has quietly gone
  // back to parsing for itself. Both helpers were three lines long, which is exactly how two of
  // them came to exist and then to disagree.
  const relay = commandBlock('relay', "if (command === 'session')")
  const session = commandBlock('session', "if (command === 'demo')")

  for (const [name, block, list] of [
    ['relay', relay, 'RELAY_VALUED_FLAGS'],
    ['session', session, 'SESSION_VALUED_FLAGS'],
  ] as const) {
    assert.ok(
      block.includes(`const flag = flagReader(`) && block.includes(`, ${list})`),
      `${name} must build its flag reader with the shared flagReader over ${list}`,
    )
    assert.doesNotMatch(
      block,
      /const flag = \(name: string/,
      `${name} must not carry a flag helper of its own beside the shared one`,
    )
    // Parsed AND acted on. A reader whose answer is dropped is the `--record` shape again:
    // every text assertion passes and the invocation still does not mean what was typed.
    assert.match(
      block,
      new RegExp(
        `if \\(flag\\.missing !== undefined\\) \\{\\n\\s*console\\.error\\(missingValueMessage\\(flag\\.missing, '${name}'\\)\\)`,
      ),
      `${name} must refuse an invocation whose flag lost its value`,
    )
  }

  // The two declared surfaces, compared as data. Every difference is a flag one command reads a
  // value for and the other does not, which is the same claim the flag-set test makes about the
  // source text -- made here against the list the parser actually uses.
  const only = [
    ...VALUED_FLAGS.relay.filter((f) => !VALUED_FLAGS.session.includes(f)),
    ...VALUED_FLAGS.session.filter((f) => !VALUED_FLAGS.relay.includes(f)),
  ]
  assert.deepEqual(
    only.filter((f) => !(f in DECLARED)),
    [],
    'a flag whose VALUE one command reads and the other does not must be declared, for the ' +
      'same reason a flag one command has and the other lacks must be.',
  )

  // And the declared surface must be the surface: a flag read but not declared is one the
  // missing-value scan cannot see, and a flag declared but never read is a claim about nothing.
  for (const [name, block, declaredFlags] of [
    ['relay', relay, VALUED_FLAGS.relay],
    ['session', session, VALUED_FLAGS.session],
  ] as const) {
    const read = new Set([...block.matchAll(/flag\('([a-z-]+)'/g)].map((m) => m[1]!))
    assert.deepEqual(
      [...read].filter((f) => !declaredFlags.includes(f)).sort(),
      [],
      `${name} reads a flag that is not in its declared valued-flag list`,
    )
    assert.deepEqual(
      declaredFlags.filter((f) => !read.has(f)),
      [],
      `${name} declares a valued flag it never reads`,
    )
  }
})

test('both front-ends can shorten the deadline a hung turn is measured against', () => {
  // Tenth instance, and the one #36 is about: `turnWatchdogMs` sat on RelayOptions and only
  // the console filled it in, so the run with nobody watching was the run that could not
  // shorten forty-five minutes of silence.
  //
  // The test above would pass on a flag that is merely READ, which is the failure worth
  // guarding against here -- a value parsed and then dropped looks the same at every other
  // point in the file. So this asserts where it LANDS, and in what units: seconds at the
  // CLI, milliseconds on the option, and a missing factor of a thousand is a watchdog that
  // effectively never fires.
  const relay = commandBlock('relay', "if (command === 'session')")
  const session = commandBlock('session', "if (command === 'demo')")

  const relayAt = relay.indexOf('Relay.start({')
  const sessionAt = session.indexOf('return runSession({')
  assert.ok(relayAt > 0 && sessionAt > 0, 'both blocks must build their options object here')

  // The session front-end reads the flag into a local first; relay reads it in place. Both
  // spellings are named rather than pattern-matched, so a rename has to come through here.
  assert.match(session, /const turnTimeout = flag\('turn-timeout', ''\)/)
  for (const [name, opts, seconds] of [
    ['relay', relay.slice(relayAt), "flag('turn-timeout', '')"],
    ['session', session.slice(sessionAt), 'turnTimeout'],
  ] as const) {
    assert.ok(
      opts.includes(`turnWatchdogMs: Number(${seconds}) * 1000`),
      `${name} must pass --turn-timeout into turnWatchdogMs, converted from seconds`,
    )
  }
})

test('every ceiling flag is parsed AND lands on the options both front-ends build', () => {
  // The #69 shape, applied to ceilings before it can happen again. The flag-set test above
  // compares which flags EXIST; it passes on a flag that is read into a local and then never
  // used, which is exactly how `--record` reached neither front-end and `--turn-timeout`
  // reached only one while both looked wired. A ceiling that is parsed and dropped is the
  // worst version of that bug, because the operator believes the run is bounded.
  //
  // So this asserts arrival, not presence: each block must read each flag, and each block
  // must hand the parsed values to the SHARED builder. Naming `ceilingsFrom` is the point --
  // a block that rebuilt the object inline could differ from the other in units or in which
  // fields it set, and nothing here or above would see it.
  const relay = commandBlock('relay', "if (command === 'session')")
  const session = commandBlock('session', "if (command === 'demo')")

  for (const [name, block] of [['relay', relay], ['session', session]] as const) {
    for (const [flagName, field] of [
      ['max-turns', 'maxTurns'],
      ['max-minutes', 'maxMinutes'],
      ['max-queue-depth', 'maxQueueDepth'],
      ['max-concurrent-seats', 'maxConcurrentSeats'],
    ] as const) {
      assert.ok(block.includes(`flag('${flagName}', '')`), `${name} must read --${flagName}`)
      assert.ok(
        new RegExp(`${field}:\\s*flag\\('${flagName}', ''\\)`).test(block),
        `${name} must pass --${flagName} into ceilingsFrom as ${field}, not parse it and drop it`,
      )
    }
    assert.match(block, /ceilingsFrom\(\{/, `${name} must build its ceilings with the shared builder`)
    assert.match(block, /ceilings \? \{ ceilings \} : \{\}/, `${name} must pass the built ceilings into its options`)
  }

  // And the console's option must reach the relay unchanged, which is the half the CLI block
  // cannot show: `runSession` is where a value could still be dropped between the two.
  const consoleSrc = readFileSync(join(import.meta.dirname, '..', 'repl', 'session.ts'), 'utf8')
  assert.match(consoleSrc, /ceilings\?: Ceilings \| undefined/, 'SessionOptions must have a field to receive them')
  assert.match(
    consoleSrc,
    /\.\.\.\(opts\.ceilings \? \{ ceilings: opts\.ceilings \} : \{\}\)/,
    'runSession must pass ceilings into Relay.start unchanged',
  )
})

test('both front-ends read the seat list through the shared builder and pass it on', () => {
  // The ceilings shape, applied to seats. `--implementers` could be read into a local and
  // dropped on either command and every other test in this file would pass: the flag-set test
  // compares which flags EXIST, and a run with a silently ignored seat list looks exactly like
  // a default run, which is the failure mode hardest to notice from the outside.
  //
  // Naming `implementerSeatPlan` is the point. A block that split the comma list itself could
  // disagree with the other about a trailing comma or about which flag wins, and the operator
  // would find out by getting a different number of seats from `relay` than from `session`.
  const relay = commandBlock('relay', "if (command === 'session')")
  const session = commandBlock('session', "if (command === 'demo')")

  for (const [name, block] of [['relay', relay], ['session', session]] as const) {
    assert.ok(block.includes(`flag('implementers', '')`), `${name} must read --implementers`)
    assert.match(
      block,
      /implementers:\s*flag\('implementers', ''\)/,
      `${name} must hand --implementers to implementerSeatPlan, not parse it and drop it`,
    )
    assert.match(block, /implementerSeatPlan\(\{/, `${name} must build its seat plan with the shared builder`)
    // And refuse rather than start on a contradiction, which is the builder's other half.
    assert.match(
      block,
      /seatPlan\.kind === 'refused'/,
      `${name} must refuse the invocation the builder rejected`,
    )
    assert.match(
      block,
      /seatPlan\.kind === 'listed' \? \{ implementers/,
      `${name} must pass the named seat list on, and pass nothing when none was named`,
    )
  }

  // The console's half the CLI block cannot show: `runSession` is where the list could still
  // be dropped between the two.
  const consoleSrc = readFileSync(join(import.meta.dirname, '..', 'repl', 'session.ts'), 'utf8')
  // `SeatRequest[]`, not `string[]`, since per-seat launch arguments (#77). The field carries
  // each seat's own arguments beside its agent; a bare agent list here would have needed a
  // second list correlated with this one by index, which is the pairing the syntax exists to
  // avoid. Widened deliberately rather than loosened -- the type is still named, so a wire that
  // went back to agents alone, and with them dropped every seat's arguments, still fails here.
  assert.match(
    consoleSrc,
    /implementers\?: SeatRequest\[\] \| undefined/,
    'SessionOptions must have a field to receive it, carrying each seat with its own args',
  )
  assert.match(
    consoleSrc,
    /\.\.\.\(opts\.implementers \? \{ implementers: implSpecs \} : \{\}\)/,
    'runSession must pass the seat list into Relay.start, and nothing when there is none',
  )
})

test('both front-ends read the project config, and both can write the bypass', () => {
  // Two of the eight, and the pair that shows the shape best: `.conclave/config.json` is a
  // property of the PROJECT rather than of which command opened it, so reading it in one
  // place meant an unattended run ignored the permission mode its operator had configured --
  // and an unattended run is the one with nobody to answer the prompt it then stopped at.
  const relay = commandBlock('relay', "if (command === 'session')")
  const session = commandBlock('session', "if (command === 'demo')")
  for (const [name, block] of [['relay', relay], ['session', session]] as const) {
    assert.match(block, /applyBypassFlag/, `${name} must be able to apply --bypass`)
  }
  // The console reads it inside runSession rather than in the CLI block, which is why this
  // asserts on the module instead of the block.
  const consoleSrc = readFileSync(
    join(import.meta.dirname, '..', 'repl', 'session.ts'),
    'utf8',
  )
  assert.match(consoleSrc, /readProjectConfig/, 'the console must read the project config')
  assert.match(relay, /readProjectConfig/, 'and so must relay')
})

test('both front-ends record a readable session', () => {
  // #26. A run an operator cannot inspect from outside is the same defect whichever command
  // started it, and the console is the one most likely to be left running in another window.
  const relay = commandBlock('relay', "if (command === 'session')")
  const consoleSrc = readFileSync(join(import.meta.dirname, '..', 'repl', 'session.ts'), 'utf8')
  assert.match(relay, /recordSession\(/, 'relay must record its session')
  assert.match(consoleSrc, /recordSession\(/, 'and so must the console')
})

/**
 * The agent-facing section of `--help`, checked against the code it describes.
 *
 * An agent arriving cold reads `--help` and gets a command reference written for someone
 * who already knows the shape of the thing. It then GUESSES: it picks `relay` because the
 * name sounds unattended, discovers that every pause ends the run, and hand-reconstructs
 * state on each retry. That happened, four times, to a real caller.
 *
 * So the instructions exist — and a set of instructions that drifts from the code is worse
 * than none, because it is believed. Every command the section names is asserted to exist:
 * the slash commands against the console's own list, the subcommands against the dispatch.
 */
test('the agent instructions name only things that exist', () => {
  const cli = readFileSync(join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts'), 'utf8')
  const start = cli.indexOf('Driving conclave from an agent')
  const end = cli.indexOf('\nCommands:', start)
  assert.ok(start > 0 && end > start, 'the agent section must be present in USAGE')
  const section = cli.slice(start, end)

  // The one thing it exists to say. An agent that picks `relay` for an attended run loses
  // its state at the first pause.
  assert.match(section, /Use "session", not "relay"/)

  // Every slash command it lists must be one the console actually accepts.
  const documented = [...section.matchAll(/\/[a-z]+/g)].map((m) => m[0])
  assert.ok(documented.length >= 7, 'the section must list the slash commands')
  for (const cmd of new Set(documented)) {
    assert.ok(COMMANDS.includes(cmd), `--help documents ${cmd}, which the console does not accept`)
  }

  // ...and every subcommand it points at must be dispatched.
  for (const sub of ['status', 'events', 'sessions']) {
    assert.match(section, new RegExp(`conclave ${sub}`), `the section must point at ${sub}`)
    assert.match(cli, new RegExp(`command === '${sub}'`), `${sub} must actually be a command`)
  }

  // The distinction a poller gets wrong, and the reason `abandoned` exists at all.
  assert.match(section, /alive false is a crashed run/)
})

test('both front-ends get Codex to trust the hooks they register', () => {
  // Registration is not enough -- Codex silently executes nothing in a directory it does not
  // trust -- and `relay` registered the sidecar, never trusted it, and never even checked.
  // The front-end designed to run WITHOUT a human was the one missing the step that removes
  // the need for one, so an unattended first run in a fresh project ended `transport_failed`
  // at turn one. Ninth instance.
  const relay = commandBlock('relay', "if (command === 'session')")
  const consoleSrc = readFileSync(join(import.meta.dirname, '..', 'repl', 'session.ts'), 'utf8')
  assert.match(relay, /ensureCodexHooksTrusted\(/, 'relay must ensure Codex trust')
  assert.match(consoleSrc, /ensureCodexHooksTrusted\(/, 'and so must the console')
})

test('version reports the commit when run from a checkout', () => {
  // `package.json` is bumped once per release, so a checkout thirteen commits past a tag
  // reported the tag. Two projects filed bugs against builds described as `0.2.7`; one
  // supplied the commit by hand because the tool would not. A symlink on PATH pointing into
  // a working tree is the normal way to run this while developing it, so that state is not
  // exotic — it is how its own authors use it.
  const out = execFileSync(
    process.execPath,
    [join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts'), 'version'],
    { encoding: 'utf8' },
  ).trim()
  assert.match(out, /^\d+\.\d+\.\d+ \([0-9a-f]{7,}(-dirty)?\)$/, `saw: ${out}`)
})

test('the README lists every console command, and no others', () => {
  // The `--help` list is checked against `COMMANDS`; the README's was not, and drifted --
  // `/wait` shipped and the README kept describing the set without it. A reader following
  // documentation that omits the one command for the situation they are in has been told
  // there is nothing they can do.
  //
  // Both directions, because inventing a command is the worse failure: a missing one is
  // discoverable from `/help`, an imaginary one sends someone looking for a bug.
  const readme = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8')
  const section = readme.split('### At the console')[1]?.split('\n###')[0] ?? ''
  assert.ok(section.length > 0, 'the console section must be findable')
  const documented = new Set([...section.matchAll(/\/[a-z]+/g)].map((m) => m[0]))
  // Paths in the examples are not commands.
  for (const notACommand of ['/relay', '/src', '/repl']) documented.delete(notACommand)

  assert.deepEqual(
    [...documented].filter((c) => !COMMANDS.includes(c)),
    [],
    'the README documents a command the console does not accept',
  )
  assert.deepEqual(
    COMMANDS.filter((c) => !documented.has(c)),
    [],
    'the console accepts a command the README never mentions',
  )
})
