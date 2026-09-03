/**
 * The graded model check, and the refusal it produces (#82).
 *
 *   node --test src/registry/models.test.ts
 *
 * Three claims, and the third is the one the issue is actually about:
 *
 *   1. What each grade DOES. An enumerated agent refuses an absent name; an alias-only agent
 *      refuses an absent alias and passes a full model name through; an unsupported agent is not
 *      even asked.
 *   2. What it does when it cannot find out. Every failure to enumerate -- a CLI that is not
 *      installed, one that answers in a shape this cannot read, one that hangs -- leaves the
 *      selection UNCHECKED and the run starting. A validator that refuses valid input is worse
 *      than no validator, so the failure path is asserted as carefully as the success path.
 *   3. That both front-ends refuse before a single child is constructed, through `main` with the
 *      real argv and the real parsing. `--implementers "agent --model x"` is the surface the bug
 *      arrived through, so it is the surface driven here.
 *
 * The enumerating subprocess is real in every test below -- `node -e`, which is on PATH wherever
 * this suite runs. Stubbing the spawn would leave the one line that actually runs a child CLI
 * untested, and that line is the whole mechanism.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import { main } from '../../bin/conclave.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { CLAUDE_AGENT, CODEX_AGENT, KIMI_AGENT, OPENCODE_AGENT } from './builtin.ts'
import { effectiveLaunchArgs } from './launch.ts'
import {
  checkModelSelection,
  claudeAliasOf,
  claudeAliases,
  forgetModelEnumerations,
  isClaudeAliasShaped,
  nearestNames,
  opencodeModels,
  refuseUnknownModels,
  type ModelSupport,
} from './models.ts'
import { Relay } from '../relay/relay.ts'
import { AgentRegistry } from './registry.ts'
import { NO_DEADLINE_CLOCKS, type AgentDefinition } from './types.ts'

/**
 * `claude --help` as it prints on 2.1.227, wrapped exactly as the terminal wrapped it.
 *
 * A fixture rather than a live `claude --help`, because the parse has to survive the WRAPPING --
 * the alias list straddles three lines and the sentence that ends it straddles two -- and a live
 * capture would silently stop proving that the day the column width changes.
 */
const CLAUDE_HELP = `Options:
  --mcp-config <configs...>             Load MCP servers from JSON files
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Set a display name for this session
  --no-chrome                           Disable Claude in Chrome integration
`

/** `opencode models` as it prints on 1.18.15: one `provider/model` per line, nothing else. */
const OPENCODE_LIST = [
  'opencode/claude-opus-5',
  'opencode/claude-sonnet-5',
  'opencode/kimi-k2.5-code',
  'opencode/gpt-5.2',
  'anthropic/claude-opus-5',
].join('\n')

/** An agent definition that exists only to carry a `ModelSupport`. */
function agentWith(id: string, models: ModelSupport | undefined): AgentDefinition {
  return {
    id,
    displayName: id,
    capabilities: {
      agent: id,
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
    ...(models ? { models } : {}),
    launch: { command: id, baseArgs: [] },
  }
}

/**
 * A real subprocess that prints `lines` and exits.
 *
 * `marker` goes into the argv so each test gets its own cache key: the enumeration cache is
 * keyed by command line and lives for the process, which is the behaviour under test in
 * `one subprocess per command`, and would otherwise make every test after the first vacuous.
 */
function printer(lines: string, marker: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(lines)})`, marker] }
}

const enumerated = (lines: string, marker: string): ModelSupport => ({
  grade: 'enumerated',
  ask: { ...printer(lines, marker), parse: opencodeModels },
  noun: 'model',
  nounPlural: 'models',
})

test('an enumerated agent refuses a name its CLI does not list, and accepts one it does', async () => {
  forgetModelEnumerations()
  const agent = agentWith('opencode-like', enumerated(OPENCODE_LIST, 'accept'))

  const bad = await checkModelSelection({ participant: 'implementer', agent, model: 'opencode/kimi-k3' })
  assert.equal(bad?.grade, 'enumerated')
  assert.ok(bad?.refusal, 'an absent name must be refused, not merely noted')
  assert.match(bad!.refusal!, /implementer \(opencode-like\)/)
  assert.match(bad!.refusal!, /'opencode\/kimi-k3'/)
  // The valid options, which is what the issue asks a refusal to carry. Five names is few
  // enough to print, so all five are printed rather than a pointer at a command.
  assert.match(bad!.refusal!, /opencode\/kimi-k2\.5-code/)
  assert.equal(bad!.unchecked, undefined)

  const good = await checkModelSelection({ participant: 'implementer', agent, model: 'opencode/gpt-5.2' })
  assert.equal(good?.refusal, undefined)
  assert.equal(good?.unchecked, undefined, 'a listed name is CHECKED, not passed through')
})

test('an alias-only agent judges aliases and passes a full model name through', async () => {
  forgetModelEnumerations()
  const agent = agentWith('claude-like', {
    grade: 'aliases_only',
    ask: { ...printer(CLAUDE_HELP, 'alias'), parse: claudeAliases },
    judges: isClaudeAliasShaped,
    normalize: claudeAliasOf,
    noun: 'alias',
    nounPlural: 'aliases',
  })

  // The spelling from the issue. This is the whole bug: an alias that does not exist.
  const bad = await checkModelSelection({ participant: 'implementer-2', agent, model: 'opus-5' })
  assert.ok(bad?.refusal, '`--model opus-5` must be refused')
  assert.match(bad!.refusal!, /fable, opus, sonnet/, 'the refusal names the aliases that DO exist')

  // A real alias, and the same alias carrying a context window.
  assert.equal((await checkModelSelection({ participant: 'i', agent, model: 'opus' }))?.refusal, undefined)
  const windowed = await checkModelSelection({ participant: 'i', agent, model: 'sonnet[1m]' })
  assert.equal(windowed?.refusal, undefined, '`sonnet[1m]` selects the sonnet alias and must not be refused')

  // The half the help says it accepts and does not enumerate. Passed through, and SAID to be
  // passed through -- an operator reading the run record must not think it was verified.
  for (const full of ['claude-opus-5', 'claude-fable-5[1m]', 'us.anthropic.claude-sonnet-4-5-v1:0', 'bedrock/claude']) {
    const check = await checkModelSelection({ participant: 'i', agent, model: full })
    assert.equal(check?.refusal, undefined, `${full} must not be refused`)
    assert.match(check!.unchecked!, /passed through/)
  }
})

test('an agent whose models cannot be enumerated says so, and its CLI is never asked', async () => {
  forgetModelEnumerations()
  let asked = 0
  const agent = agentWith('codex-like', {
    grade: 'unsupported',
    noun: 'model',
    nounPlural: 'models',
    reason: '`codex models` requires a terminal',
  })
  const check = await checkModelSelection(
    { participant: 'advisor', agent, model: 'gpt-5-codex' },
    {
      ask: async () => {
        asked++
        return ''
      },
    },
  )
  assert.equal(check?.grade, 'unsupported')
  assert.equal(check?.refusal, undefined, 'an ungradeable agent must not refuse anything')
  assert.match(check!.unchecked!, /requires a terminal/)
  assert.equal(asked, 0, 'an unsupported grade is a statement, not a failed attempt')
})

test('every way the ask can fail leaves the selection unchecked rather than refused', async () => {
  // The property this whole design rests on: a validator that refuses valid input gets switched
  // off, and then nothing validates anything. Three failures, one per shape.
  const cases: [string, ModelSupport][] = [
    [
      'a CLI that is not installed',
      {
        grade: 'enumerated',
        ask: { command: 'conclave-no-such-binary-82', args: [], parse: opencodeModels },
        noun: 'model',
        nounPlural: 'models',
      },
    ],
    [
      'a CLI that exits non-zero',
      {
        grade: 'enumerated',
        ask: { command: process.execPath, args: ['-e', 'process.exit(3)'], parse: opencodeModels },
        noun: 'model',
        nounPlural: 'models',
      },
    ],
    [
      'a help text that has been reworded past recognition',
      {
        grade: 'aliases_only',
        ask: { ...printer('Options:\n  --model <model>  pick one\n', 'reworded'), parse: claudeAliases },
        judges: isClaudeAliasShaped,
        noun: 'alias',
        nounPlural: 'aliases',
      },
    ],
  ]
  for (const [why, models] of cases) {
    forgetModelEnumerations()
    const check = await checkModelSelection({ participant: 'i', agent: agentWith('x', models), model: 'anything' })
    assert.equal(check?.refusal, undefined, `${why}: must not refuse`)
    assert.ok(check?.unchecked, `${why}: must say why nothing was checked`)
  }
})

test('a declaration-free agent is undeclared rather than unsupported, and an argv naming no model is not checked at all', async () => {
  forgetModelEnumerations()
  const silent = agentWith('unwired', undefined)
  const check = await checkModelSelection({ participant: 'i', agent: silent, model: 'whatever' })
  assert.equal(check?.grade, 'undeclared')
  assert.equal(check?.refusal, undefined)

  // `null` is what `modelFromArgs` reports for an argv that selected nothing -- the default run.
  let asked = 0
  const agent = agentWith('opencode-like', enumerated(OPENCODE_LIST, 'unused'))
  const none = await checkModelSelection(
    { participant: 'i', agent, model: null },
    { ask: async () => { asked++; return OPENCODE_LIST } },
  )
  assert.equal(none, undefined, 'no selection is no finding')
  assert.equal(asked, 0, 'the default run must not pay a subprocess for a question it did not ask')
})

test('one subprocess per command, however many seats name that agent', async (t) => {
  forgetModelEnumerations()
  // The subprocess writes a file each time it runs, so the count is observed rather than
  // inferred from a stub that was never the thing running.
  const dir = tempDir(t, 'conclave-models')
  const tally = join(dir, 'runs')
  const agent = agentWith('counted', {
    grade: 'enumerated',
    ask: {
      command: process.execPath,
      args: [
        '-e',
        `require('fs').appendFileSync(${JSON.stringify(tally)}, 'x'); process.stdout.write(${JSON.stringify(OPENCODE_LIST)})`,
      ],
      parse: opencodeModels,
    },
    noun: 'model',
    nounPlural: 'models',
  })
  const seats = ['implementer', 'implementer-2', 'implementer-3'].map((participant) => ({
    participant,
    agent,
    model: 'opencode/gpt-5.2',
  }))
  // Concurrently, which is the case a result cache would get wrong and a promise cache gets
  // right: three seats asking before the first answer arrives.
  await Promise.all(seats.map((s) => checkModelSelection(s)))
  assert.equal(readCount(tally), 1, 'the enumeration is asked once and shared')
  await refuseUnknownModels(seats)
  assert.equal(readCount(tally), 1, 'and it stays asked once for the life of the process')
})

/** How many times the enumerating subprocess actually ran. One byte appended per run. */
function readCount(path: string): number {
  try {
    return readFileSync(path, 'utf8').length
  } catch {
    return 0
  }
}

test('every bad seat is reported, not just the first', async () => {
  forgetModelEnumerations()
  const agent = agentWith('opencode-like', enumerated(OPENCODE_LIST, 'all-seats'))
  await assert.rejects(
    refuseUnknownModels([
      { participant: 'implementer', agent, model: 'opencode/kimi-k3' },
      { participant: 'implementer-2', agent, model: 'opencode/gpt-5.2' },
      { participant: 'implementer-3', agent, model: 'opencode/gpt-9' },
    ]),
    (e: Error) => {
      assert.match(e.message, /implementer \(/)
      assert.match(e.message, /implementer-3 \(/)
      assert.ok(!e.message.includes('implementer-2 ('), 'a valid seat is not reported as a problem')
      // The refusal says what it is protecting against, because "invalid model" alone does not
      // explain why a run is being stopped rather than started and left to fail.
      assert.match(e.message, /#82/)
      return true
    },
  )
})

test('the parsers read the shapes the real CLIs actually print', () => {
  assert.deepEqual(claudeAliases(CLAUDE_HELP), ['fable', 'opus', 'sonnet'])
  // The full-name EXAMPLE must not become an alias: it is an example of the other thing the
  // flag takes, and treating it as an alias would make the set describe neither half.
  assert.ok(!claudeAliases(CLAUDE_HELP).includes('claude-fable-5'))
  // No `--model` option at all, and an option block that names nothing: both are "unknown",
  // which is what leaves selections unchecked upstream.
  assert.deepEqual(claudeAliases('Options:\n  --verbose  say more\n'), [])
  assert.deepEqual(claudeAliases('Options:\n  --model <model>  the model\n'), [])

  assert.deepEqual(opencodeModels(OPENCODE_LIST), [
    'opencode/claude-opus-5',
    'opencode/claude-sonnet-5',
    'opencode/kimi-k2.5-code',
    'opencode/gpt-5.2',
    'anthropic/claude-opus-5',
  ])
  // Anything that is not one bare `provider/model` token is not a model name.
  assert.deepEqual(opencodeModels('Loading models...\n\nopencode/gpt-5.2\nsome prose about / things\n'), [
    'opencode/gpt-5.2',
  ])

  assert.equal(isClaudeAliasShaped('opus-5'), true)
  assert.equal(isClaudeAliasShaped('sonnet[1m]'), true)
  assert.equal(isClaudeAliasShaped('claude-opus-5'), false)
  assert.equal(isClaudeAliasShaped('us.anthropic.claude-opus-5'), false)
  assert.equal(isClaudeAliasShaped('vendor/model'), false)
  assert.equal(claudeAliasOf('sonnet[1m]'), 'sonnet')
  assert.equal(claudeAliasOf('sonnet'), 'sonnet')

  // Sixty names do not belong in a refusal, so the near ones are picked out. This is a
  // convenience, and it is asserted so it cannot quietly start returning nothing.
  assert.deepEqual(nearestNames('opencode/kimi-k3', opencodeModels(OPENCODE_LIST), 2), ['opencode/kimi-k2.5-code'])
  // Ranked on the MODEL half rather than the whole string: every name in this list starts
  // `opencode/`, so a whole-string comparison would offer whatever came next alphabetically.
  assert.deepEqual(nearestNames('opencode/claude-opus-6', opencodeModels(OPENCODE_LIST), 2), [
    'anthropic/claude-opus-5',
    'opencode/claude-opus-5',
  ])
})

test('the built-in agents declare the grade their CLI can actually support', () => {
  // Measured against the installed CLIs while writing #82, and each grade is a claim about a
  // command that was run: `opencode models` listed 60, `claude --help` named three aliases and
  // said full names are also accepted, `codex models` answered `Error: stdin is not a terminal`,
  // and `kimi models` answered `No such command 'models'`.
  assert.equal(OPENCODE_AGENT.models?.grade, 'enumerated')
  assert.deepEqual(OPENCODE_AGENT.models?.ask?.args, ['models'])
  assert.equal(CLAUDE_AGENT.models?.grade, 'aliases_only')
  assert.deepEqual(CLAUDE_AGENT.models?.ask?.args, ['--help'])
  assert.equal(typeof CLAUDE_AGENT.models?.judges, 'function')

  for (const agent of [CODEX_AGENT, KIMI_AGENT]) {
    assert.equal(agent.models?.grade, 'unsupported', `${agent.id} cannot be asked`)
    assert.equal(agent.models?.ask, undefined, `${agent.id} declares no command, because there is none`)
    // An `unsupported` grade with no reason is the state this whole file exists to prevent:
    // a capability gap that looks like an oversight.
    assert.ok((agent.models?.reason ?? '').length > 20, `${agent.id} must say why it cannot be asked`)
  }
})

/* ------------------------------------------------------------------ front-ends ---------- */

/** A repository for a front-end to run in. Both refuse to start outside one. */
function tempRepo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-modelcli')
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
 * A registry whose agents enumerate models for real and record every child constructed.
 *
 * `created` is the assertion that matters as much as the message: the issue asks for the refusal
 * to happen BEFORE the run starts, and a check that merely reported first and launched anyway
 * would satisfy every string assertion below.
 */
function registryOf(created: string[]): AgentRegistry {
  const registry = new AgentRegistry()
  for (const id of ['fake-lead', 'fake-a', 'fake-b']) {
    const def = agentWith(id, enumerated(OPENCODE_LIST, `front-${id}`))
    registry.register({
      ...def,
      async create(resolved, ctx) {
        created.push(`${resolved.spec.id}:${effectiveLaunchArgs(resolved, ctx).join(' ')}`)
        // The advisor hands out one instruction and calls it done; the seats acknowledge, work,
        // and have nothing to raise. Without an advisor that ends the run, the control case
        // below never returns.
        return new FakeRotationSession(
          id,
          `${resolved.spec.id}-session`,
          id === 'fake-lead' ? ['Do the thing.', 'DONE'] : ['ack', 'Did it.', 'NONE', 'NONE'],
        )
      },
    })
  }
  return registry
}

async function runFrontEnd(
  t: TestContext,
  front: 'relay' | 'session',
  flags: string[],
): Promise<{ created: string[]; error: Error | undefined }> {
  const repo = tempRepo(t)
  const before = process.cwd()
  const created: string[] = []
  const [log, error] = [console.log, console.error]
  try {
    process.chdir(repo)
    console.log = () => {}
    console.error = () => {}
    let thrown: Error | undefined
    try {
      await main([front, 'pick a model that exists', ...flags], {
        registry: registryOf(created),
        input: new PassThrough(),
        output: new Writable({
          write(_c, _e, cb) {
            cb()
          },
        }),
      })
    } catch (e) {
      thrown = e as Error
    }
    return { created, error: thrown }
  } finally {
    console.log = log
    console.error = error
    process.chdir(before)
  }
}

test('createParticipant refuses too, so a caller that never goes through Relay.start is still checked', async () => {
  forgetModelEnumerations()
  // The floor under the front-ends. `Relay.start` checks the whole seat list before launching
  // anything, which is the fail-fast; this is the funnel every caller passes through -- a
  // rotation replacement, a programmatic embedder -- and a check only the front-ends run is a
  // check the programmatic surface does not have.
  let created = 0
  const registry = new AgentRegistry()
  registry.register({
    ...agentWith('fake-a', enumerated(OPENCODE_LIST, 'floor')),
    async create() {
      created++
      return new FakeRotationSession('fake-a', 'seat-session', [])
    },
  })
  await assert.rejects(
    registry.createParticipant(
      { id: 'implementer', agent: 'fake-a', role: 'implementer', args: ['-m', 'opencode/gpt-9'] },
      { cwd: process.cwd() },
    ),
    /opencode\/gpt-9/,
  )
  assert.equal(created, 0, 'the adapter is never reached')
  // And the same call with a listed model constructs the child, so the refusal above is the
  // check firing rather than the seam being broken.
  await registry.createParticipant(
    { id: 'implementer', agent: 'fake-a', role: 'implementer', args: ['-m', 'opencode/gpt-5.2'] },
    { cwd: process.cwd() },
  )
  assert.equal(created, 1)
})

test('a seat whose model could not be verified says so in the run log, and a verified one does not', async (t) => {
  forgetModelEnumerations()
  // The issue asks for this by name: "an agent whose models cannot be enumerated says so rather
  // than guessing". A negative result nobody can see is a check an operator will believe covered
  // them, so it is recorded where the run is recorded rather than only returned to the caller.
  const repo = tempRepo(t)
  const registry = new AgentRegistry()
  registry.register({
    ...agentWith('fake-lead', enumerated(OPENCODE_LIST, 'note-lead')),
    async create() {
      return new FakeRotationSession('fake-lead', 'advisor-session', ['DONE'])
    },
  })
  registry.register({
    ...agentWith('fake-ungradeable', {
      grade: 'unsupported',
      noun: 'model',
      nounPlural: 'models',
      reason: 'its picker needs a terminal',
    }),
    async create() {
      return new FakeRotationSession('fake-ungradeable', 'seat-session', [])
    },
  })
  const relay = await Relay.start({
    registry,
    cwd: repo,
    lead: { id: 'advisor', agent: 'fake-lead', role: 'advisor', args: ['-m', 'opencode/gpt-5.2'] },
    implementer: { id: 'implementer', agent: 'fake-ungradeable', role: 'implementer', args: ['-m', 'whatever-1'] },
    maxAdvisorTurns: 1,
  })
  try {
    const notes = relay.log.filter((m) => m.kind === 'note').map((m) => m.text)
    const said = notes.find((n) => n.includes('NOT verified'))
    assert.ok(said, `an ungradeable seat must say so: ${JSON.stringify(notes)}`)
    assert.match(said!, /^implementer model 'whatever-1'/)
    assert.match(said!, /needs a terminal/, 'and say why, rather than just that it did not happen')
    assert.equal(
      notes.filter((n) => n.includes('NOT verified')).length,
      1,
      'the advisor named a model its CLI does list, so it is silent -- a note per seat is a note nobody reads',
    )
  } finally {
    await relay.stop()
  }
})

for (const front of ['relay', 'session'] as const) {
  test(`${front} refuses a per-seat model the child does not have, before any child is constructed`, async (t) => {
    forgetModelEnumerations()
    // The invocation from the issue, in this suite's agent ids: two seats, each with its own
    // model, one of them wrong. The wrong one is the SECOND seat, so a check that ran inside
    // participant construction would already have built the first child by the time it fired.
    const { created, error } = await runFrontEnd(t, front, [
      '--advisor',
      'fake-lead',
      '--implementers',
      'fake-a --model opencode/gpt-5.2, fake-b --model opencode/gpt-9',
    ])
    assert.ok(error, 'the run must not start')
    assert.match(error!.message, /implementer-2 \(fake-b\)/)
    assert.match(error!.message, /'opencode\/gpt-9'/)
    assert.match(error!.message, /opencode\/gpt-5\.2/, 'the valid options are named')
    assert.deepEqual(created, [], 'no child is constructed for any seat, including the valid one')
  })

  test(`${front} starts a run whose seats all name models their children have`, async (t) => {
    forgetModelEnumerations()
    // The control case, and the reason the test above proves anything: the same wiring with two
    // real model names launches both seats. Without this, "refuses everything" would pass.
    const { created, error } = await runFrontEnd(t, front, [
      '--advisor',
      'fake-lead',
      '--implementers',
      'fake-a --model opencode/gpt-5.2, fake-b --model opencode/claude-opus-5',
    ])
    assert.equal(error, undefined)
    assert.ok(
      created.some((c) => c.startsWith('implementer:') && c.includes('opencode/gpt-5.2')),
      `implementer was launched with its own model: ${JSON.stringify(created)}`,
    )
    assert.ok(
      created.some((c) => c.startsWith('implementer-2:') && c.includes('opencode/claude-opus-5')),
      `implementer-2 was launched with its own model: ${JSON.stringify(created)}`,
    )
  })
}
