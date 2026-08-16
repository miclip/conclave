/**
 * What the record says about how a seat was LAUNCHED (#71).
 *
 * `agent: opencode` identifies nothing. One agent id spans dozens of models across roughly a
 * 30x price spread, so a finished run could be neither costed by hand nor repeated: the
 * `-m provider/model` an operator passed reached the child process and was dropped before
 * anything wrote the run down. This file is the guard on the other half of that -- the argv
 * and the model reaching `conclave status --json` and the `relay --json` report, per seat.
 *
 * Three levels, because each can be right while the next is wrong:
 *
 *   1. `modelFromArgs` reads a model out of an argv, and answers `null` rather than `''` when
 *      the argv names none.
 *   2. What is RECORDED equals what the adapter was HANDED -- observed at the registry seam,
 *      where a fake agent composes its own argv with the same function the real ones use.
 *   3. Both documents carry it, from both front-ends, driven through `main`.
 *
 * And one negative, which is the rest of the issue: no token count and no cost appears
 * anywhere in either document. That is deferred deliberately -- conclave drives the operator's
 * own CLI on the operator's own subscription -- so its absence is an assertion, not a gap.
 *
 *   node --test src/relay/launchRecord.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { main } from '../../bin/conclave.ts'
import { effectiveLaunchArgs, modelFromArgs } from '../registry/launch.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { newSessionId, recordSession } from '../workspace/sessionRecord.ts'
import { Relay } from './relay.ts'
import { runReport } from './report.ts'

const BUILTIN = readFileSync(join(import.meta.dirname, '..', 'registry', 'builtin.ts'), 'utf8')

test('a model flag is read out of an argv in every spelling the child CLIs take', () => {
  assert.equal(modelFromArgs(['-m', 'opencode/kimi-k2.7-code']), 'opencode/kimi-k2.7-code')
  assert.equal(modelFromArgs(['--model', 'opus-5']), 'opus-5')
  assert.equal(modelFromArgs(['-m=opus-5']), 'opus-5')
  assert.equal(modelFromArgs(['--model=opus-5']), 'opus-5')
  // Codex takes it as a config key rather than a flag of its own, quoted as its docs write it.
  assert.equal(modelFromArgs(['-c', 'model="gpt-5"']), 'gpt-5')
  assert.equal(modelFromArgs(['--config', 'model=gpt-5']), 'gpt-5')
  // Ordinary company: the model is found among the arguments a real run carries.
  assert.equal(
    modelFromArgs(['-c', 'check_for_update_on_startup=false', '-m', 'gpt-5', '--dangerously-skip-permissions']),
    'gpt-5',
  )
})

test('the LAST model flag wins, because that is the one that took effect', () => {
  // Conclave composes adapter base args, then project config, then the operator's own
  // `--implementer-args`. The child CLIs take the last spelling too, so a flag typed at the
  // command line beats one a config file supplied -- and the record must name the one that ran.
  assert.equal(modelFromArgs(['-m', 'from-config', '-m', 'from-the-command-line']), 'from-the-command-line')
  assert.equal(modelFromArgs(['--model=first', '-c', 'model=second']), 'second')
})

test('an argv that names no model records null, and never an empty string', () => {
  // The distinction the issue asks for by name: a run started with no explicit model must
  // record THAT. `''` is indistinguishable from a name that failed to survive being written.
  for (const argv of [
    [],
    ['--dangerously-skip-permissions'],
    // A flag with nothing after it, and a flag followed by another flag. Taking the next token
    // regardless would report `--verbose` as the model that ran.
    ['-m'],
    ['-m', '--verbose'],
    // Not a model key, and one character away from being read as one.
    ['-c', 'model_reasoning_effort=high'],
    // Present and empty is still nothing selected.
    ['--model='],
    ['-c', 'model=""'],
  ]) {
    const found = modelFromArgs(argv)
    assert.equal(found, null, `${JSON.stringify(argv)} names no model`)
    assert.notEqual(found, '', 'absence is null, never an empty string')
  }
})

test('the launch argv is composed in one place, and every built-in adapter uses it', () => {
  // A text pin, and a narrow one: the claim being guarded is that the recorded argv is the
  // SAME LIST the adapter was handed. That holds because both come from `effectiveLaunchArgs`,
  // and it stops holding the moment an adapter goes back to spreading the three layers itself.
  assert.equal(
    [...BUILTIN.matchAll(/args: effectiveLaunchArgs\(resolved, ctx\),/g)].length,
    4,
    'all four built-in adapters must compose their child argv through effectiveLaunchArgs',
  )
  assert.doesNotMatch(
    BUILTIN,
    /\.\.\.\(resolved\.spec\.args \?\? \[\]\)/,
    'no adapter may hand-roll the composition beside the shared one',
  )

  // The order is the precedence, and the record depends on it: base args first, spec args
  // (project config, then --implementer-args, already composed by the front-end), then the
  // creating context.
  const resolved = {
    spec: { id: 'implementer', agent: 'opencode', role: 'implementer' as const, args: ['-m', 'from-the-spec'] },
    agent: { launch: { baseArgs: ['--base'] } },
  }
  assert.deepEqual(
    effectiveLaunchArgs(
      resolved as unknown as Parameters<typeof effectiveLaunchArgs>[0],
      { cwd: '/tmp', args: ['--from-the-context'] },
    ),
    ['--base', '-m', 'from-the-spec', '--from-the-context'],
  )
})

/** One agent per fake session, so a seat's id and the child behind it stay distinguishable. */
function registryOf(
  sessions: Record<string, FakeRotationSession>,
  opts: { baseArgs?: string[]; handed?: Record<string, string[]> } = {},
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
      launch: { command: agent, baseArgs: opts.baseArgs ?? [] },
      async create(resolved, ctx) {
        // The seam itself. A real adapter spreads this list into its child process; this one
        // records it, so a test can compare what the child WOULD have been given against what
        // the run report says it was given.
        if (opts.handed) opts.handed[resolved.spec.id] = effectiveLaunchArgs(resolved, ctx)
        return session
      },
    })
  }
  return r
}

function tempRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir })
  return dir
}

async function stdoutOf(work: () => Promise<number>): Promise<string> {
  const [log, error] = [console.log, console.error]
  const lines: string[] = []
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  console.error = () => {}
  try {
    assert.equal(await work(), 0, 'the command must succeed')
  } finally {
    console.log = log
    console.error = error
  }
  return lines.join('\n')
}

async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const [log, error] = [console.log, console.error]
  console.log = () => {}
  console.error = () => {}
  try {
    return await work()
  } finally {
    console.log = log
    console.error = error
  }
}

interface Recorded {
  id: string
  agent: string
  launch: { args: string[]; model: string | null }
}

function seat(doc: unknown, id: string): Recorded {
  const found = (doc as { participants: Recorded[] }).participants.find((p) => p.id === id)
  assert.ok(found, `the document must carry a participant '${id}'`)
  return found
}

/**
 * What "no model" looks like in the BYTES a consumer parses.
 *
 * Asserted on the serialised text rather than only on the parsed object, because the three
 * ways this can go wrong are invisible from one side or the other: `''` parses to a string a
 * reader cannot tell from a nameless model, `undefined` is dropped by `JSON.stringify` so the
 * key disappears entirely, and both look fine to code that only ever reads `if (!model)`.
 */
function assertAbsenceIsNull(text: string, label: string): void {
  assert.match(text, /"model":\s*null/, `${label} must spell an unnamed model as null`)
  assert.doesNotMatch(text, /"model":\s*""/, `${label} must never spell it as an empty string`)
  assert.match(text, /"model":/, `${label} must carry the key even when there is no model to name`)
}

/** Every key at every depth, so a claim about what is ABSENT can be made over the whole document. */
function keysIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysIn(item, into)
    return into
  }
  if (value === null || typeof value !== 'object') return into
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    into.add(k)
    keysIn(v, into)
  }
  return into
}

test('the relay report and status name the model each seat was launched with', async () => {
  const repo = tempRepo('conclave-launch-relay-')
  const before = process.cwd()
  const handed: Record<string, string[]> = {}
  const registry = registryOf(
    {
      // Base args on the advisor's agent, so the recorded argv is provably the WHOLE launch
      // and not just the operator's addition to it -- Codex carries two of these in production.
      'fake-lead': new FakeRotationSession('lead-1', 'fake-lead', ['DONE']),
      'fake-impl': new FakeRotationSession('impl-1', 'fake-impl', []),
    },
    { baseArgs: ['-c', 'check_for_update_on_startup=false'], handed },
  )
  try {
    process.chdir(repo)
    const reportText =
      await stdoutOf(() =>
        main(
          [
            'relay',
            'a goal that names a model',
            '--advisor',
            'fake-lead',
            '--implementer',
            'fake-impl',
            '--implementer-args',
            '-m opencode/kimi-k2.7-code',
            '--rounds',
            '2',
            '--json',
          ],
          { registry },
        ),
      )
    const report = JSON.parse(reportText)
    const statusText = await stdoutOf(() => main(['status', '--json']))
    const status = JSON.parse(statusText)

    // The advisor of this run was given no model, so both documents must SPELL that.
    assertAbsenceIsNull(reportText, 'the relay report')
    assertAbsenceIsNull(statusText, 'the status document')

    for (const doc of [report, status]) {
      const impl = seat(doc, 'implementer')
      assert.equal(impl.launch.model, 'opencode/kimi-k2.7-code', 'the model the operator passed is the model recorded')
      assert.deepEqual(impl.launch.args, ['-c', 'check_for_update_on_startup=false', '-m', 'opencode/kimi-k2.7-code'])

      // The advisor was given no model, and says so with a null rather than a blank. Its base
      // args are still recorded: they are part of what would have to be typed to repeat the run.
      const advisor = seat(doc, 'advisor')
      assert.equal(advisor.launch.model, null)
      assert.deepEqual(advisor.launch.args, ['-c', 'check_for_update_on_startup=false'])
    }

    // What was RECORDED is what the adapter was HANDED, compared at the registry seam rather
    // than assumed from the flag. A record composed separately could be plausible and wrong.
    for (const id of ['advisor', 'implementer']) {
      assert.deepEqual(seat(report, id).launch.args, handed[id], `${id}'s recorded argv is its launched argv`)
    }
  } finally {
    process.chdir(before)
    rmSync(repo, { recursive: true, force: true })
  }
})

test('the console front-end records the same launch, and a run given no args records no model', async () => {
  const repo = tempRepo('conclave-launch-session-')
  const before = process.cwd()
  const registry = registryOf({
    'fake-lead': new FakeRotationSession('lead-1', 'fake-lead', ['DONE']),
    'fake-impl': new FakeRotationSession('impl-1', 'fake-impl', []),
  })
  try {
    process.chdir(repo)
    await quietly(() =>
      main(
        [
          'session',
          'a goal',
          '--advisor',
          'fake-lead',
          '--implementer',
          'fake-impl',
          // The LONG spelling, deliberately. This test used to pass `-m gpt-5` and say why:
          // the session block's own flag helper read a value beginning with `--` as a value
          // that had gone missing, so `--model gpt-5` could not be passed through
          // `--implementer-args` on this front-end at all. That was #81, the workaround was
          // written down here for as long as the bug existed, and both front-ends now read
          // their argv with the shared `flagReader` -- see `PASS_THROUGH_FLAGS` in
          // src/config/cliFlags.ts, and the acceptance table in
          // src/relay/frontEndParity.test.ts that compares the two commands value by value.
          '--implementer-args',
          '--model gpt-5',
          '--rounds',
          '2',
        ],
        { registry, input: new PassThrough(), output: new Writable({ write(_c, _e, cb) { cb() } }) },
      ),
    )
    const statusText = await stdoutOf(() => main(['status', '--json']))
    const status = JSON.parse(statusText)
    assertAbsenceIsNull(statusText, "the console's status document")
    assert.equal(seat(status, 'implementer').launch.model, 'gpt-5', 'both front-ends record the model')
    assert.deepEqual(seat(status, 'implementer').launch.args, ['--model', 'gpt-5'])

    // The default half of the same document: a seat nobody passed anything to reports an empty
    // argv and a null model, present rather than omitted. A consumer reading `launch.model`
    // must be able to tell "no model was named" from "this build does not report models".
    const advisor = seat(status, 'advisor')
    assert.deepEqual(advisor.launch.args, [])
    assert.equal(advisor.launch.model, null)
    assert.ok('model' in advisor.launch, 'the key is present on a seat that has no model to name')
  } finally {
    process.chdir(before)
    rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * Two implementer seats, launched with two different models.
 *
 * The single-seat tests above cannot fail on the defect this one is for: with one implementer,
 * a record that smeared one seat's args across every seat, or read the args off the lead spec
 * instead of the seat's own, is indistinguishable from a correct one. Per-seat means per seat.
 *
 * Driven through `Relay.start` rather than a front-end, which was once a limitation of the CLI
 * and is now a choice about what this file is for. `--implementer-args` is still ONE flag that
 * applies to every implementer seat (bin/conclave.ts:1111-1114) and project config still carries
 * no per-agent launch args at all (`launchArgsFor` only returns bypass flags,
 * src/config/project.ts:160-163) -- but distinct args per seat ARE now expressible on the
 * command line, inside each `--implementers` entry (#77). That path is proved where it belongs,
 * at the CLI, in src/relay/perSeatArgs.test.ts; what this test is about is the RECORD, so it
 * keeps handing `Relay.start` the specs directly rather than reaching the same place through an
 * argv that could fail for its own reasons. Both documents are
 * still the production ones: `runReport` is what `bin/conclave.ts:1351` prints, and the status
 * is read back through `main(['status', '--json'])` after the real recorder wrote it.
 */
test('two seats launched with two different models are recorded apart, in both documents', async () => {
  const repo = tempRepo('conclave-launch-seats-')
  const before = process.cwd()
  const handed: Record<string, string[]> = {}
  const registry = registryOf(
    {
      'fake-lead': new FakeRotationSession('lead-1', 'fake-lead', ['DONE']),
      'fake-alpha': new FakeRotationSession('alpha-1', 'fake-alpha', []),
      'fake-beta': new FakeRotationSession('beta-1', 'fake-beta', []),
    },
    { handed },
  )
  const startedAt = Date.now()
  const relay = await Relay.start({
    registry,
    cwd: repo,
    lead: { id: 'advisor', agent: 'fake-lead', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'fake-alpha', role: 'implementer', args: ['-m', 'cheap/model-alpha'] },
    implementers: [
      { id: 'implementer', agent: 'fake-alpha', role: 'implementer', args: ['-m', 'cheap/model-alpha'] },
      { id: 'implementer-2', agent: 'fake-beta', role: 'implementer', args: ['--model', 'expensive/model-beta'] },
    ],
    maxAdvisorTurns: 1,
  })
  const recording = recordSession(relay, {
    repoRoot: repo,
    id: newSessionId(Date.now(), process.pid),
    goal: 'a two-seat goal',
    front: 'relay',
    startedAt,
    build: 'test',
  })
  try {
    const outcome = await relay.run('a two-seat goal')
    const report = await runReport(relay, { goal: 'a two-seat goal', outcome, startedAt, build: 'test' })
    await recording.refresh()
    process.chdir(repo)
    const statusText = await stdoutOf(() => main(['status', '--json']))
    const status = JSON.parse(statusText)

    const expected: Record<string, { args: string[]; model: string }> = {
      implementer: { args: ['-m', 'cheap/model-alpha'], model: 'cheap/model-alpha' },
      'implementer-2': { args: ['--model', 'expensive/model-beta'], model: 'expensive/model-beta' },
    }
    for (const doc of [report, status]) {
      for (const [id, want] of Object.entries(expected)) {
        assert.deepEqual(seat(doc, id).launch.args, want.args, `${id} keeps its own argv`)
        assert.equal(seat(doc, id).launch.model, want.model, `${id} keeps its own model`)
      }
      // The two seats disagree, which is the whole point: a record that reported one model for
      // the run would pass every assertion in this file that looks at a single seat.
      assert.notEqual(seat(doc, 'implementer').launch.model, seat(doc, 'implementer-2').launch.model)
      // And the advisor, in the same run, named none.
      assert.equal(seat(doc, 'advisor').launch.model, null)
      assert.deepEqual(seat(doc, 'advisor').launch.args, [])
    }
    assertAbsenceIsNull(statusText, 'a two-seat status document')

    // Each seat's record against what its own adapter was handed, at the registry seam.
    for (const id of ['advisor', 'implementer', 'implementer-2']) {
      assert.deepEqual(seat(report, id).launch.args, handed[id], `${id}'s recorded argv is its launched argv`)
    }

    // The no-cost claim on the document that has the most to be tempted by: two seats, two
    // models, two price points, and still nothing anywhere that reports a spend.
    for (const [label, doc] of [['report', report], ['status', status]] as const) {
      assert.deepEqual(
        [...keysIn(doc)].filter((k) => /cost|price|usage|spend|billing|token/i.test(k)),
        [],
        `the two-seat ${label} must not report what a run cost or consumed`,
      )
    }
  } finally {
    process.chdir(before)
    await recording.close()
    await relay.stop()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('neither document reports a token count or a cost, anywhere', async () => {
  // The other half of #71, deferred with its reason: real usage would mean the enterprise
  // analytics API or OTEL on the operator's own machine, and scraping whatever one adapter's
  // transcript happens to expose would produce a confident partial number for a multi-seat run.
  // Asserted rather than left to nobody having built it, because the tempting version is easy
  // to add by accident alongside the model.
  const repo = tempRepo('conclave-launch-nocost-')
  const before = process.cwd()
  const registry = registryOf({
    'fake-lead': new FakeRotationSession('lead-1', 'fake-lead', ['DONE']),
    'fake-impl': new FakeRotationSession('impl-1', 'fake-impl', []),
  })
  try {
    process.chdir(repo)
    const report = JSON.parse(
      await stdoutOf(() =>
        main(
          ['relay', 'a goal', '--advisor', 'fake-lead', '--implementer', 'fake-impl', '--rounds', '2', '--json'],
          { registry },
        ),
      ),
    )
    const status = JSON.parse(await stdoutOf(() => main(['status', '--json'])))
    for (const [label, doc] of [['report', report], ['status', status]] as const) {
      const offending = [...keysIn(doc)].filter((k) => /cost|price|usage|spend|billing|token/i.test(k))
      assert.deepEqual(offending, [], `the ${label} must not report what a run cost or consumed`)
    }
  } finally {
    process.chdir(before)
    rmSync(repo, { recursive: true, force: true })
  }
})
