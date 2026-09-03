/**
 * The executable-availability preflight, and the refusal it produces (#51).
 *
 *   node --test src/registry/executables.test.ts
 *
 * Four claims, and the third is the one the issue is actually about:
 *
 *   1. What the LOOKUP does. PATH order, absolute and relative paths, wrappers, the entries that
 *      must not match (a directory, a file with no executable bit), and the Windows `PATHEXT`
 *      rules -- which are not decorative, because a globally installed npm CLI is `opencode.cmd`
 *      on disk and reporting it missing would be worse than not checking at all.
 *   2. What the refusal SAYS. The seat, the agent, the exact command, where it was looked for,
 *      and the one line an operator would run to fix it.
 *   3. WHEN it happens. Before `new Relay`, before worktrees, before any adapter preflight, before
 *      any child. The issue's complaint is not that the first turn dies -- it is that the
 *      registration, the hook files, the trust check and the routed goal all happened first. So
 *      the assertions that matter most here are the counters that must still read zero.
 *   4. That it stays SCOPED and stays QUIET. Only seated agents are checked, an agent that
 *      declares no requirement is not checked at all, and a command that IS present produces a run
 *      indistinguishable from the one before this existed.
 *
 * Nothing here is spawned and nothing is stubbed: the files searched for are real files in a real
 * temporary directory, and the one command asserted PRESENT is `process.execPath`, which exists
 * wherever this suite runs.
 */

import { strict as assert } from 'node:assert'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync as run } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import { main } from '../../bin/conclave.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { Relay } from '../relay/relay.ts'
import { worktreePaths } from '../relay/subagents.ts'
import { CLAUDE_AGENT, CODEX_AGENT, KIMI_AGENT, OPENCODE_AGENT } from './builtin.ts'
import {
  checkCommandAvailable,
  findExecutable,
  refuseMissingCommands,
  type ExecutableRequirement,
} from './executables.ts'
import { AgentRegistry } from './registry.ts'
import { NO_DEADLINE_CLOCKS, type AgentDefinition } from './types.ts'

/**
 * A command name no machine can have, used wherever "not installed" is the input.
 *
 * Spelled out rather than randomised: a name this long and this specific is not going to collide,
 * and a fixed one makes a failure reproducible.
 */
const ABSENT = 'conclave-agent-that-is-definitely-not-installed'

/**
 * The verbatim stdout of a real `opencode run --format json` on 1.18.15.
 *
 * Borrowed from src/adapters/opencode.test.ts, which established it: the wrapper below has to be
 * a real executable taking a real turn, or "it was spawned" is a claim about a mock.
 */
const FIXTURE = join(fileURLToPath(new URL('../..', import.meta.url)), 'spikes/opencode/fixtures/edit-turn.ndjson')

/** An agent definition carrying a launch command and, optionally, the requirement to have it. */
function agentWith(id: string, command: string, executable?: ExecutableRequirement): AgentDefinition {
  return {
    id,
    displayName: `${id} CLI`,
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
    launch: { command, baseArgs: [], ...(executable ? { executable } : {}) },
  }
}

/** A real executable file: a shell wrapper, which is what a version manager's shim actually is. */
function wrapper(dir: string, name: string): string {
  const path = join(dir, name)
  writeFileSync(path, '#!/bin/sh\nexec true\n')
  chmodSync(path, 0o755)
  return path
}

/* ------------------------------------------------------------------- the lookup ---------- */

test('a bare command is found along PATH, in PATH order, and only where a real executable is', (t) => {
  const first = tempDir(t, 'conclave-exec')
  const second = tempDir(t, 'conclave-exec')
  // A DIRECTORY with the command's name in the first entry, and the real thing in the second.
  // PATH entries routinely contain a directory of the same name as a command, and matching it
  // would resolve to something the OS would never execute.
  mkdirSync(join(first, 'agent'))
  const real = wrapper(second, 'agent')
  const env = { PATH: [first, second].join(delimiter) }
  assert.equal(findExecutable('agent', { cwd: first, env, platform: 'linux' }), real)

  // ...and now the same name earlier in PATH, as a real executable: first match wins.
  const earlier = wrapper(first, 'other')
  assert.equal(
    findExecutable('other', { cwd: first, env: { PATH: [first, second].join(delimiter) }, platform: 'linux' }),
    earlier,
  )

  // A file with the right name and NO executable bit is not what the OS would run.
  writeFileSync(join(second, 'unarmed'), 'not executable\n')
  chmodSync(join(second, 'unarmed'), 0o644)
  assert.equal(findExecutable('unarmed', { cwd: first, env, platform: 'linux' }), undefined)

  // Absent everywhere.
  assert.equal(findExecutable(ABSENT, { cwd: first, env, platform: 'linux' }), undefined)
  // An UNSET PATH has no entries and searches nowhere. It does not fall back to this process's
  // own environment, which would make the answer depend on who happened to run the check.
  assert.equal(findExecutable('agent', { cwd: second, env: {}, platform: 'linux' }), undefined)
})

test('an empty PATH entry is the seat cwd, because that is the setup POSIX actually launches', (t) => {
  const cwd = tempDir(t, 'conclave-exec')
  const other = tempDir(t, 'conclave-exec')
  // `PATH=":/usr/bin"` with a wrapper in the working directory is a setup that RUNS: `execvp`
  // treats a zero-length element as the current directory, and the adapter spawns with the
  // seat's cwd set, so that is the directory the empty entry names at exec time. Refusing it --
  // which this did first -- rejects a configuration the OS would have launched, and a check that
  // refuses valid input is worse than no check: it gets switched off, and then nothing is
  // validated. Whether such a setup is reproducible is a fair objection and not this function's
  // to make.
  const real = wrapper(cwd, 'agent')
  assert.equal(findExecutable('agent', { cwd, env: { PATH: `:${other}` }, platform: 'linux' }), real)
  // In every position an empty entry can take, and in PATH ORDER: an earlier real entry wins.
  assert.equal(findExecutable('agent', { cwd, env: { PATH: `${other}:` }, platform: 'linux' }), real)
  const earlier = wrapper(other, 'agent')
  assert.equal(findExecutable('agent', { cwd, env: { PATH: `${other}:` }, platform: 'linux' }), earlier)
  // PATH set to the empty string is ONE empty entry, so it names the cwd -- distinct from PATH
  // being unset, which has no entries at all.
  assert.equal(findExecutable('agent', { cwd, env: { PATH: '' }, platform: 'linux' }), real)
  assert.equal(findExecutable('agent', { cwd, env: {}, platform: 'linux' }), undefined)
  // The rule is the same on Windows, where an empty entry is rare and erring towards finding the
  // command is the direction this check must err in.
  writeFileSync(join(cwd, 'winagent.cmd'), '@echo off\n')
  assert.equal(
    findExecutable('winagent', { cwd, env: { PATH: ';C:\\nowhere', PATHEXT: '.cmd' }, platform: 'win32' }),
    join(cwd, 'winagent.cmd'),
  )
})

test('a seat whose wrapper is found through an empty PATH entry is not refused', (t) => {
  const cwd = tempDir(t, 'conclave-exec')
  // The whole point, one level up from the lookup: this is the seat a false refusal would have
  // stopped, and it starts.
  wrapper(cwd, 'wrapped-agent')
  const agent = agentWith('wrapped', 'wrapped-agent', { install: 'never needed' })
  const check = checkCommandAvailable({ participant: 'implementer', agent, cwd }, { env: { PATH: ':/nowhere' } })
  assert.equal(check?.refusal, undefined, 'the command is present, so there is nothing to refuse')
  assert.equal(check?.resolved, join(cwd, 'wrapped-agent'))
  assert.deepEqual(
    refuseMissingCommands([{ participant: 'implementer', agent, cwd }], { env: { PATH: ':/nowhere' } }).map(
      (c) => c.resolved,
    ),
    [join(cwd, 'wrapped-agent')],
  )
})

test('a command with a separator is a path, resolved against the seat cwd and never searched for', (t) => {
  const dir = tempDir(t, 'conclave-exec')
  const elsewhere = tempDir(t, 'conclave-exec')
  mkdirSync(join(dir, 'bin'))
  const real = wrapper(join(dir, 'bin'), 'agent-wrapper')
  // Relative, against the SEAT's cwd rather than this process's -- that directory is where the
  // adapter will spawn, so `./bin/agent-wrapper` has to mean the same thing in both places.
  assert.equal(findExecutable('./bin/agent-wrapper', { cwd: dir, env: { PATH: '' }, platform: 'linux' }), real)
  assert.equal(findExecutable('bin/agent-wrapper', { cwd: dir, env: { PATH: '' }, platform: 'linux' }), real)
  // Absolute, and the cwd is irrelevant to it.
  assert.equal(findExecutable(real, { cwd: elsewhere, env: { PATH: '' }, platform: 'linux' }), real)
  // A separated command is NOT searched for on PATH, even when a match is sitting there.
  wrapper(elsewhere, 'agent-wrapper')
  assert.equal(
    findExecutable('./agent-wrapper', { cwd: dir, env: { PATH: elsewhere }, platform: 'linux' }),
    undefined,
    'a path that does not exist is not rescued by a PATH entry that happens to contain the name',
  )
  // The empty command names nothing and is not resolved to the cwd itself.
  assert.equal(findExecutable('', { cwd: dir, env: { PATH: dir }, platform: 'linux' }), undefined)
})

test('on Windows the search tries PATHEXT, which is how an npm-installed CLI is found at all', (t) => {
  const dir = tempDir(t, 'conclave-exec')
  // `npm i -g opencode-ai` puts `opencode.cmd` on PATH, not `opencode`. A lookup that only
  // tried the bare name would report every npm-installed agent as missing -- a false refusal,
  // which is the one failure mode this whole check must not have.
  writeFileSync(join(dir, 'opencode.cmd'), '@echo off\n')
  const env = { PATH: dir, PATHEXT: '.cmd' }
  assert.equal(findExecutable('opencode', { cwd: dir, env, platform: 'win32' }), join(dir, 'opencode.cmd'))
  // The extension may already be written out, and must not be doubled into `opencode.cmd.cmd`.
  assert.equal(findExecutable('opencode.cmd', { cwd: dir, env, platform: 'win32' }), join(dir, 'opencode.cmd'))
  // Windows separates PATH with `;`, not `:`.
  assert.equal(
    findExecutable('opencode', { cwd: dir, env: { PATH: `C:\\nowhere;${dir}`, PATHEXT: '.cmd' }, platform: 'win32' }),
    join(dir, 'opencode.cmd'),
  )
  // With PATHEXT unset the documented default applies.
  writeFileSync(join(dir, 'codex.EXE'), '')
  assert.equal(findExecutable('codex', { cwd: dir, env: { PATH: dir }, platform: 'win32' }), join(dir, 'codex.EXE'))
  // The executable BIT is not consulted on Windows -- nothing above was chmod'ed -- and it still
  // is on posix, where the same directory yields nothing.
  assert.equal(findExecutable('opencode', { cwd: dir, env: { PATH: dir }, platform: 'linux' }), undefined)
  // A backslash makes it a path on Windows and an ordinary character elsewhere.
  assert.equal(findExecutable('a\\b', { cwd: dir, env: { PATH: dir }, platform: 'win32' }), undefined)
})

/* ------------------------------------------------------------------ the refusal ---------- */

test('the refusal names the seat, the agent, the exact command, and how to install it', () => {
  const agent = agentWith('opencode', ABSENT, { install: 'npm install -g opencode-ai', installFrom: 'the docs' })
  const check = checkCommandAvailable({ participant: 'implementer-2', agent, cwd: process.cwd() })
  assert.ok(check?.refusal, 'an absent command is a refusal')
  assert.match(check!.refusal!, /implementer-2/, 'which seat')
  assert.match(check!.refusal!, /opencode CLI \(opencode\)/, 'which agent, by display name and id')
  assert.match(check!.refusal!, new RegExp(ABSENT), 'the exact launch command, unmodified')
  assert.match(check!.refusal!, /not on PATH/, 'where it was looked for')
  assert.match(check!.refusal!, /npm install -g opencode-ai/, 'and the one line that fixes it')
  assert.match(check!.refusal!, /the docs/, 'with the hint attributed rather than asserted')
  assert.equal(check!.resolved, undefined)

  // A path-shaped command says where it looked instead, because "not on PATH" would be a wrong
  // explanation for a command that was never going to be searched for.
  const pathed = checkCommandAvailable({
    participant: 'implementer',
    agent: agentWith('local', './bin/nope', {}),
    cwd: '/somewhere',
  })
  assert.match(pathed!.refusal!, /no executable file at \/somewhere\/bin\/nope/)
  assert.ok(!pathed!.refusal!.includes('Install it with'), 'no hint is offered when the definition has none')
})

test('every uninstalled seat is reported, not just the first, and the throw says what it prevents', () => {
  const absent = agentWith('absent', ABSENT, { install: 'go get it' })
  const present = agentWith('present', process.execPath, {})
  assert.throws(
    () =>
      refuseMissingCommands([
        { participant: 'advisor', agent: absent, cwd: process.cwd() },
        { participant: 'implementer', agent: present, cwd: process.cwd() },
        { participant: 'implementer-2', agent: absent, cwd: process.cwd() },
      ]),
    (e: Error) => {
      assert.match(e.message, /advisor is seated/)
      assert.match(e.message, /implementer-2 is seated/)
      assert.ok(!e.message.includes('implementer is seated'), 'an installed seat is not reported as a problem')
      // The refusal says what it is protecting against, because "not installed" alone does not
      // explain why a run is being stopped rather than started and left to fail.
      assert.match(e.message, /#51/)
      assert.match(e.message, /unknown_abnormal_end/)
      return true
    },
  )
  // The control: the same call with only installed seats returns the checks and throws nothing.
  const checks = refuseMissingCommands([{ participant: 'implementer', agent: present, cwd: process.cwd() }])
  assert.deepEqual(checks.map((c) => c.resolved), [process.execPath])
})

test('a definition that declares no requirement is not checked, which is what a test double relies on', () => {
  // Every in-memory `AgentSession` in this repository satisfies `LaunchSpec` with a command that
  // is a label -- `fake-lead` is not a program. Silence here removing the check is the safe
  // direction and the only workable one; the alternative refuses every double in the suite.
  const undeclared = agentWith('fake-lead', 'fake-lead')
  assert.equal(checkCommandAvailable({ participant: 'advisor', agent: undeclared, cwd: process.cwd() }), undefined)
  assert.deepEqual(refuseMissingCommands([{ participant: 'advisor', agent: undeclared, cwd: process.cwd() }]), [])
})

test('every built-in declares its executable and a way to obtain it', () => {
  for (const agent of [CLAUDE_AGENT, CODEX_AGENT, OPENCODE_AGENT, KIMI_AGENT]) {
    assert.ok(agent.launch.executable, `${agent.id} must declare that its command is a real program`)
    const install = agent.launch.executable?.install ?? ''
    assert.ok(install.length > 5, `${agent.id} must offer an install line`)
    assert.ok(install.includes(agent.id) || agent.id === 'claude', `${agent.id}'s hint must name what it installs`)
    // A hint with no stated source is a claim about someone else's machine.
    assert.ok((agent.launch.executable?.installFrom ?? '').length > 5, `${agent.id} must say where the hint is from`)
  }
})

/* ------------------------------------------------------------ where it happens ---------- */

/** A repository for a run to happen in. Every front-end refuses to start outside one. */
function tempRepo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-execrun')
  run('git', ['init', '--quiet'], { cwd: dir })
  run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  run('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'README.md'), '# hello')
  run('git', ['add', '.'], { cwd: dir })
  run('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir })
  return dir
}

interface Side {
  preflights: string[]
  creates: string[]
}

/**
 * A registry whose agents record every step taken on their behalf.
 *
 * `preflights` and `creates` are the assertions that matter as much as the message: the issue is
 * about work done BEFORE the failure, so a check that reported first and proceeded anyway would
 * satisfy every string assertion in this file.
 */
function registryOf(side: Side, agents: Record<string, string>): AgentRegistry {
  const registry = new AgentRegistry()
  for (const [id, command] of Object.entries(agents)) {
    registry.register({
      ...agentWith(id, command, {}),
      async preflight(resolved) {
        side.preflights.push(resolved.spec.id)
      },
      async create(resolved) {
        side.creates.push(resolved.spec.id)
        return new FakeRotationSession(
          id,
          `${resolved.spec.id}-session`,
          id === 'lead' ? ['Do the thing.', 'DONE'] : ['ack', 'Did it.', 'NONE', 'NONE'],
        )
      },
    })
  }
  return registry
}

test('Relay.start refuses before the relay, the worktrees, any preflight and any child', async (t) => {
  const repo = tempRepo(t)
  const side: Side = { preflights: [], creates: [] }
  // Two implementer seats, so the run WOULD create worktrees -- and the absent command is on the
  // second seat, so a check that ran inside participant construction would already have written
  // hooks and launched a child for the first.
  const registry = registryOf(side, { lead: process.execPath, good: process.execPath, missing: ABSENT })
  await assert.rejects(
    Relay.start({
      registry,
      cwd: repo,
      lead: { id: 'advisor', agent: 'lead', role: 'advisor' },
      implementer: { id: 'implementer', agent: 'good', role: 'implementer' },
      implementers: [
        { id: 'implementer', agent: 'good', role: 'implementer' },
        { id: 'implementer-2', agent: 'missing', role: 'implementer' },
      ],
      maxAdvisorTurns: 1,
    }),
    (e: Error) => {
      assert.match(e.message, /implementer-2 is seated/)
      assert.match(e.message, new RegExp(ABSENT))
      return true
    },
  )
  assert.deepEqual(side.creates, [], 'no child is constructed for any seat, including the valid ones')
  assert.deepEqual(side.preflights, [], 'no adapter preflight runs, so nothing is written or trusted')
  // Counted rather than compared by path: on macOS the temporary directory is reached through
  // a symlink, so git reports the resolved `/private/var/...` and the string `mkdtemp` returned
  // is not the string git prints. The claim is that the repository still has ONE working tree.
  assert.deepEqual(
    worktreePaths(repo).length,
    1,
    'no seat worktree is created: the refusal is above createSeatWorktrees, not beside it',
  )
})

test('a run whose seats are all installed starts exactly as before', async (t) => {
  const repo = tempRepo(t)
  const side: Side = { preflights: [], creates: [] }
  // The control case, and the reason the test above proves anything: the same wiring with present
  // commands runs. Without this, "refuses everything" would pass.
  const registry = registryOf(side, { lead: process.execPath, good: process.execPath })
  const relay = await Relay.start({
    registry,
    cwd: repo,
    lead: { id: 'advisor', agent: 'lead', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'good', role: 'implementer' },
    maxAdvisorTurns: 1,
  })
  try {
    assert.deepEqual(side.creates, ['advisor', 'implementer'])
    assert.deepEqual(side.preflights, ['advisor', 'implementer'])
    // And the preflight is SILENT on success: a note per checked seat is a note nobody reads,
    // and the default run must not gain a line for a check that found nothing wrong.
    assert.deepEqual(
      relay.log.filter((m) => m.kind === 'note' && /install|PATH|not found/i.test(m.text)).map((m) => m.text),
      [],
    )
  } finally {
    await relay.stop()
  }
})

test('only SEATED agents are checked, so a registry may describe an agent nobody installed', async (t) => {
  const repo = tempRepo(t)
  const side: Side = { preflights: [], creates: [] }
  // The registry knows about an uninstalled agent and the run does not use it. `list()` exists to
  // describe agents an operator has not seated, and refusing a run because one of them is absent
  // would make the registry's breadth a liability.
  const registry = registryOf(side, { lead: process.execPath, good: process.execPath, unused: ABSENT })
  const relay = await Relay.start({
    registry,
    cwd: repo,
    lead: { id: 'advisor', agent: 'lead', role: 'advisor' },
    implementer: { id: 'implementer', agent: 'good', role: 'implementer' },
    maxAdvisorTurns: 1,
  })
  await relay.stop()
  assert.deepEqual(side.creates, ['advisor', 'implementer'])
  assert.ok(registry.has('unused'), 'and the uninstalled agent is still registered and listable')
})

test('a reviewer seat is checked too, because it is a seat the run fills', async (t) => {
  const repo = tempRepo(t)
  const side: Side = { preflights: [], creates: [] }
  const registry = registryOf(side, { lead: process.execPath, good: process.execPath, missing: ABSENT })
  await assert.rejects(
    Relay.start({
      registry,
      cwd: repo,
      lead: { id: 'advisor', agent: 'lead', role: 'advisor' },
      implementer: { id: 'implementer', agent: 'good', role: 'implementer' },
      reviewer: { id: 'reviewer', agent: 'missing', role: 'reviewer' },
      maxAdvisorTurns: 1,
    }),
    /reviewer is seated/,
  )
  assert.deepEqual(side.creates, [])
})

test('createParticipant refuses too, so a caller that never goes through Relay.start is still checked', async () => {
  // The floor under the front-ends. `Relay.start` checks the whole seat list before launching
  // anything, which is the fail-fast; this is the funnel every caller passes through -- a rotation
  // replacement, a programmatic embedder -- and a check only the front-ends run is a check the
  // programmatic surface does not have.
  const side: Side = { preflights: [], creates: [] }
  const registry = registryOf(side, { missing: ABSENT, good: process.execPath })
  await assert.rejects(
    registry.createParticipant({ id: 'implementer', agent: 'missing', role: 'implementer' }, { cwd: process.cwd() }),
    new RegExp(ABSENT),
  )
  assert.deepEqual(side.creates, [], 'the adapter is never reached')
  assert.deepEqual(side.preflights, [], 'and neither is its preflight')
  // And the same call on an installed command constructs the child, so the refusal above is the
  // check firing rather than the seam being broken.
  await registry.createParticipant({ id: 'implementer', agent: 'good', role: 'implementer' }, { cwd: process.cwd() })
  assert.deepEqual(side.creates, ['implementer'])
})

/* --------------------------------------------- the validated field is the spawned one ---- */

test('the command the preflight validates is the command the adapter actually spawns', async (t) => {
  // THE INTEGRITY THIS CHECK RESTS ON, and it was briefly false. Every built-in used to hardcode
  // its own filename -- `PtyProcess.spawn({file: 'claude'})` on the pty adapters, and the two
  // run-per-turn adapters had a `command` option their `create` never passed -- so pointing
  // `launch.command` at a wrapper validated the WRAPPER and then launched whatever was on PATH.
  // A validated field that nothing spawns is worse than no check: it reports on a configuration
  // the run does not have. All four now thread `launch.command` through to the spawn.
  //
  // Proved end to end on OpenCode, whose adapter spawns an ordinary child rather than a pty, and
  // against the recorded stdout of a real `opencode run --format json` -- so the wrapper is a real
  // executable running a real turn, not a probe of the spawn call.
  const dir = tempDir(t, 'conclave-wrapper')
  const ran = join(dir, 'ran.log')
  const wrapped = join(dir, 'opencode-wrapper')
  writeFileSync(
    wrapped,
    `#!/bin/sh\nprintf 'ran\\n' >> ${JSON.stringify(ran)}\ncat ${JSON.stringify(FIXTURE)}\n`,
  )
  chmodSync(wrapped, 0o755)

  // The real built-in with one field changed, so this is the production `create` and the
  // production adapter -- not a definition written to make the point.
  const registry = new AgentRegistry().register({
    ...OPENCODE_AGENT,
    launch: { ...OPENCODE_AGENT.launch, command: wrapped },
  })

  // ACCEPTED: the preflight resolves the absolute wrapper path rather than refusing it.
  const check = checkCommandAvailable({ participant: 'implementer', agent: registry.get('opencode'), cwd: dir })
  assert.equal(check?.refusal, undefined)
  assert.equal(check?.resolved, wrapped)

  // EXECUTED: the seat is constructed through the registry funnel and takes a turn.
  const session = await registry.createParticipant(
    { id: 'implementer', agent: 'opencode', role: 'implementer' },
    { cwd: dir },
  )
  try {
    await session.send('do the thing', { kind: 'orchestrator' })
    for await (const e of session.events()) if (e.type === 'turn_end') break
  } finally {
    await session.close()
  }
  assert.equal(readFileSync(ran, 'utf8'), 'ran\n', 'the configured wrapper is what ran, exactly once')
})

test('all four built-in adapters are handed the command their definition declares', () => {
  // The other three cannot be driven as cheaply as OpenCode above -- two need a pty and Kimi needs
  // its generated provider config -- so the wiring itself is asserted, against the source of the
  // one expression that could silently go back to a hardcoded filename. A `create` that stops
  // forwarding the field is the whole defect, and it is invisible from outside until a wrapper
  // is configured.
  const builtins = readFileSync(join(import.meta.dirname, 'builtin.ts'), 'utf8')
  assert.equal(
    builtins.match(/command: resolved\.agent\.launch\.command,/g)?.length,
    4,
    'every built-in create must forward its declared command',
  )
  for (const [adapter, fallback] of [
    ['claude', "'claude'"],
    ['codex', "'codex'"],
  ] as const) {
    const source = readFileSync(join(import.meta.dirname, '..', 'adapters', `${adapter}.ts`), 'utf8')
    assert.match(
      source,
      new RegExp(`file: this\\.#opts\\.command \\?\\? ${fallback}`),
      `${adapter} must spawn the configured command, falling back to the bare name`,
    )
  }
})

/* ------------------------------------------------------------------- front-ends ---------- */

async function runFrontEnd(
  t: TestContext,
  front: 'relay' | 'session',
  agents: Record<string, string>,
  flags: string[],
): Promise<{ side: Side; error: Error | undefined; repo: string }> {
  const repo = tempRepo(t)
  const before = process.cwd()
  const side: Side = { preflights: [], creates: [] }
  const [log, error] = [console.log, console.error]
  try {
    process.chdir(repo)
    console.log = () => {}
    console.error = () => {}
    let thrown: Error | undefined
    try {
      await main([front, 'seat an agent that exists', ...flags], {
        registry: registryOf(side, agents),
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
    return { side, error: thrown, repo }
  } finally {
    console.log = log
    console.error = error
    process.chdir(before)
  }
}

for (const front of ['relay', 'session'] as const) {
  test(`${front} refuses a seat whose CLI is not installed, before any child is constructed`, async (t) => {
    // The invocation from the issue, in this suite's agent ids: an implementer seated on an agent
    // whose binary was never installed.
    const { side, error } = await runFrontEnd(
      t,
      front,
      { lead: process.execPath, good: process.execPath, missing: ABSENT },
      ['--advisor', 'lead', '--implementers', 'good, missing'],
    )
    assert.ok(error, 'the run must not start')
    assert.match(error!.message, /implementer-2 is seated/)
    assert.match(error!.message, new RegExp(ABSENT))
    assert.deepEqual(side.creates, [], 'no child is constructed for any seat, including the valid one')
    assert.deepEqual(side.preflights, [], 'and nothing is written or trusted on the operator’s behalf')
  })

  test(`${front} refuses an unknown agent for BEING unknown, not for its neighbour's missing CLI`, async (t) => {
    // CI caught this and the developer machine could not have: `conclave session --lead nope`
    // resolves no lead and a default implementer, and where neither CLI is installed the
    // executable check refused the IMPLEMENTER's missing binary -- so the operator was told to
    // install something while the actual mistake, an agent named `nope`, went unmentioned. Here
    // the seat that DOES resolve is the one with the absent command, which is the arrangement
    // that produced the wrong message.
    const { side, error } = await runFrontEnd(t, front, { present: ABSENT }, [
      '--advisor',
      'nope',
      '--implementer',
      'present',
    ])
    assert.ok(error, 'the run must not start')
    assert.match(error!.message, /nope/, 'the unknown agent is what the operator is told about')
    assert.ok(
      !new RegExp(ABSENT).test(error!.message),
      'and not about installing a CLI for a seating that could never have been filled',
    )
    assert.deepEqual(side.creates, [])
  })

  test(`${front} starts a run whose seats all name an installed CLI`, async (t) => {
    const { side, error } = await runFrontEnd(
      t,
      front,
      { lead: process.execPath, good: process.execPath },
      ['--advisor', 'lead', '--implementers', 'good, good'],
    )
    assert.equal(error, undefined)
    assert.deepEqual(side.creates, ['advisor', 'implementer', 'implementer-2'])
  })
}
