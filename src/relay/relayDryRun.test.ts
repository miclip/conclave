/**
 * `relay --dry-run`: resolve everything, describe it, touch nothing -- inside the project or
 * outside it.
 *
 * The plan itself -- and that it matches `session --dry-run` line for line -- is asserted in
 * `frontEndParity.test.ts`, where the comparison between the two front-ends belongs. What is
 * here is the other half of the claim, and the half that is easy to believe without checking:
 * that an invocation whose own output says nothing was started really did start nothing.
 *
 * THE ONE THAT REACHED OUTSIDE THE PROJECT. `relay` registered hooks, then probed Codex's
 * trust, then opened a run log, and only then asked whether this was a dry run. The trust
 * probe is not a project-local write: it spawns a real Codex and appends entries for the
 * invoked directory to the operator's GLOBAL `~/.codex/config.toml`. A question about a
 * directory is not consent to record a trust decision about it, and that is a different order
 * of surprise from writing inside the project someone pointed at.
 *
 * "Nothing was written" is asserted POSITIVELY, by comparing the project tree -- and a
 * redirected home -- before and after, rather than by grepping the output for the absence of a
 * phrase. A dry run that registered hooks would print exactly the same plan, so the output
 * cannot be the evidence.
 *
 * NOTHING HERE SPAWNS OR TRUSTS ANYTHING, and that is a constraint on the test rather than a
 * happy accident. `HOME` is redirected for the duration of every run, so the file being
 * compared is a scratch one and the operator's real `~/.codex/config.toml` is not reachable
 * from this file even by a regression. The seats are fakes from an injected registry, so a
 * regression that fell through to `Relay.start` shows up as a recorded `create` rather than as
 * two agent CLIs starting and real quota being spent.
 *
 *   node --test src/relay/relayDryRun.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { main } from '../../bin/conclave.ts'
import { installConfig } from '../config/install.ts'
import { CONFIG_RELATIVE } from '../config/project.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'

const CLI = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-relay-dryrun-'))
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
 * A home directory with a Codex config already in it, standing in for the operator's.
 *
 * Seeded rather than left empty, because "unchanged" is the claim: an empty directory that
 * stays empty and a real file that keeps its bytes are different assertions, and the trust
 * probe APPENDS -- it would leave the existing content in place and add to it.
 */
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'conclave-relay-home-'))
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(
    join(home, '.codex', 'config.toml'),
    '# the operator\'s own config\nmodel = "gpt-5-codex"\n',
  )
  return home
}

/**
 * Every path under a directory, with the contents of every file.
 *
 * `.git` is skipped: nothing conclave writes goes there, and git's own plumbing refreshes stat
 * caches in the index when it is merely READ, which would make this assert something about git
 * rather than about the dry run.
 */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const path = join(at, entry.name)
      if (entry.isDirectory()) {
        out[`${relative(dir, path)}/`] = '<directory>'
        walk(path)
      } else {
        out[relative(dir, path)] = readFileSync(path, 'utf8')
      }
    }
  }
  walk(dir)
  return out
}

/**
 * A registry that knows `codex` and `claude` -- relay's own defaults -- and records every
 * participant it is asked to create.
 *
 * The names are the real ones on purpose. A dry run that fell through would hand
 * `installConfig` and `ensureCodexHooksTrusted` exactly the agent list a real run gives them,
 * so the hook files the tree comparison looks for are the ones a real run would leave. What is
 * fake is only the session behind them, which is what keeps the failure mode a failed
 * assertion instead of two agent CLIs starting.
 *
 * `create` can be made to throw, for the control below: it lets a real run reach the far side
 * of every write this file cares about and stop there, without a pty, a spawn, or a relay loop
 * to wait on.
 */
function fakeRegistry(created: string[], opts?: { failCreate?: boolean }): AgentRegistry {
  const registry = new AgentRegistry()
  for (const agent of ['codex', 'claude']) {
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
        if (opts?.failCreate) throw new Error('control: stopping the run at the first seat')
        return new FakeRotationSession(`${agent}-1`, agent, [])
      },
    })
  }
  return registry
}

interface Ran {
  code: number
  said: string[]
  created: string[]
}

/**
 * Drive the real `relay` command in a scratch project, capturing everything it writes.
 *
 * `HOME` is the operator's, and `homedir()` reads it on every call -- so pointing it at a
 * scratch directory is what makes an assertion about `~/.codex/config.toml` safe to write at
 * all. Restored in `finally`, alongside the working directory.
 */
async function runRelay(
  dir: string,
  home: string,
  argv: readonly string[],
  opts?: { failCreate?: boolean },
): Promise<Ran> {
  const said: string[] = []
  const created: string[] = []
  const beforeCwd = process.cwd()
  const beforeHome = process.env['HOME']
  const beforeProfile = process.env['USERPROFILE']
  const [log, error] = [console.log, console.error]
  console.log = (...a: unknown[]) => void said.push(a.map(String).join(' '))
  console.error = (...a: unknown[]) => void said.push(a.map(String).join(' '))
  try {
    process.chdir(dir)
    process.env['HOME'] = home
    process.env['USERPROFILE'] = home
    const code = await main([...argv], {
      registry: fakeRegistry(created, opts),
      // Ended rather than merely empty: relay reads no input, but a regression that reached a
      // console would finish on a closed stdin instead of hanging the suite.
      input: (() => {
        const s = new PassThrough()
        s.end()
        return s
      })(),
      output: new Writable({
        write(chunk, _e, cb) {
          said.push(...String(chunk).split('\n').filter(Boolean))
          cb()
        },
      }),
    })
    return { code, said, created }
  } finally {
    process.chdir(beforeCwd)
    if (beforeHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = beforeHome
    if (beforeProfile === undefined) delete process.env['USERPROFILE']
    else process.env['USERPROFILE'] = beforeProfile
    console.log = log
    console.error = error
  }
}

test('a relay dry run describes the run and leaves the project byte for byte as it found it', { timeout: 60_000 }, async () => {
  const dir = repo()
  const home = fakeHome()
  try {
    const before = snapshot(dir)
    const homeBefore = snapshot(home)
    const { code, said, created } = await runRelay(dir, home, [
      'relay',
      'a goal that would start a run',
      '--advisor',
      'codex',
      '--implementer',
      'claude',
      '--checks',
      'npm test',
      // Under a directory that does NOT exist yet, deliberately. `new RunLogWriter` creates the
      // parent of its path and writes the file only on the first message, so a `--record` beside
      // files that are already there would leave no trace of having been constructed. The
      // directory it would have to create is the evidence.
      '--record',
      join(dir, 'logs', 'relay.ndjson'),
      '--dry-run',
    ])
    const output = said.join('\n')
    assert.equal(code, 0, `a dry run must succeed; it said:\n${output}`)
    assert.match(output, /^dry run — nothing was started$/m, `no plan was printed:\n${output}`)

    // The whole claim about the project, in one comparison: same paths, same bytes.
    assert.deepEqual(
      snapshot(dir),
      before,
      'a dry run wrote something into the project. Whatever it is, an invocation that reports ' +
        'starting nothing must not leave it behind.',
    )
    // ...and named, one by one, so a failure says WHICH step ran rather than only that the tree
    // differs. Each is a thing a real relay run does, in the order it does them, and every one
    // now lives below the point the dry run returns from.
    for (const [path, what] of [
      ['.claude/settings.json', 'Claude hooks were registered'],
      ['.codex/hooks.json', 'the Codex sidecar was registered'],
      [CONFIG_RELATIVE, 'a permission mode was written'],
      ['.conclave/runs', 'the default run log directory was created'],
      ['logs', 'the --record run log directory was created'],
      ['.conclave/session.lock', 'the session lock was taken'],
    ] as const) {
      assert.ok(!existsSync(join(dir, path)), `${what} (${path}) during a dry run`)
    }

    // The claim that has nothing to do with this project. The Codex trust probe spawns a real
    // Codex and appends the invoked directory to the operator's GLOBAL config; `HOME` points at
    // a scratch directory for the length of the run, so this compares a file that stands in for
    // theirs and can never be theirs.
    assert.deepEqual(
      snapshot(home),
      homeBefore,
      "a dry run changed the operator's home directory. `~/.codex/config.toml` is not this " +
        'project and was never what the operator pointed at.',
    )
    assert.deepEqual(created, [], 'a dry run created a participant')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('the writes a relay dry run skips are ones the project would really have received', { timeout: 60_000 }, async () => {
  // The control, and the reason the test above is not asserting that files nobody writes were
  // not written. The SAME invocation without `--dry-run` is run to the first seat and stopped
  // there by a registry that throws out of `create` -- which is past the permission-mode write,
  // past the hook registration and past the run log, so all three can be checked for real.
  //
  // Claude on both seats on purpose: `ensureCodexHooksTrusted` diagnoses by spawning `codex
  // app-server`, and it reaches for Codex only when Codex is among the agents. A control that
  // proved the trust probe runs would have to run it, which is the one thing this file must not
  // do. The Codex sidecar is covered by the direct `installConfig` call at the end instead, and
  // the probe's POSITION is covered by the source-order test below.
  const dir = repo()
  const home = fakeHome()
  try {
    // `Relay.start` propagates whatever stopped it -- the control's own error out of `create`,
    // or the executable preflight if `claude` is not installed on this machine. Either ending
    // is past every write asserted below, which is all this control is for.
    await assert.rejects(
      runRelay(
        dir,
        home,
        [
          'relay',
          'a goal that would start a run',
          '--advisor',
          'claude',
          '--implementer',
          'claude',
          '--bypass',
          '--record',
          join(dir, 'logs', 'relay.ndjson'),
        ],
        { failCreate: true },
      ),
      'a real run must not have completed here; it was meant to stop at the first seat',
    )

    for (const [path, what] of [
      [CONFIG_RELATIVE, 'the permission mode --bypass writes'],
      ['.claude/settings.json', 'the Claude hook registration'],
      ['logs', 'the --record run log directory'],
    ] as const) {
      assert.ok(
        existsSync(join(dir, path)),
        `${what} (${path}) never happens on a real run either, so the dry-run assertion about ` +
          'it is asserting nothing',
      )
    }
    assert.match(readFileSync(join(dir, CONFIG_RELATIVE), 'utf8'), /"bypass"/)

    // The one write the CLI control cannot reach without spawning Codex, proved where it is
    // made instead: `installConfig` is what the relay block calls, and a run whose seats include
    // Codex is handed `['codex']`.
    const sidecarProject = repo()
    try {
      await installConfig({ projectRoot: sidecarProject, agents: ['codex'], diagnose: false })
      assert.ok(
        existsSync(join(sidecarProject, '.codex', 'hooks.json')),
        'if this file is absent, the dry-run assertion about the Codex sidecar is asserting nothing',
      )
    } finally {
      rmSync(sidecarProject, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('a relay dry run with --bypass plans as the run would and writes no permission mode', { timeout: 60_000 }, async () => {
  // Relay accepts the pair where the console refuses it, and this is why: `withBypass` overlays
  // the requested mode IN MEMORY, so the plan is composed exactly as the run would compose it
  // while nothing is persisted. The console reads its config inside `runSession` and has no
  // such overlay -- the difference is declared in `frontEndParity.test.ts`.
  //
  // Both halves are asserted, because either alone is satisfiable by the wrong fix: a plan
  // without the permissive flags describes a run that is not the one that would happen, and a
  // written config is a consequential setting left behind by an invocation that started nothing.
  const dir = repo()
  const home = fakeHome()
  try {
    const { code, said } = await runRelay(dir, home, [
      'relay',
      'a goal',
      '--advisor',
      'codex',
      '--implementer',
      'claude',
      '--bypass',
      '--dry-run',
    ])
    const output = said.join('\n')
    assert.equal(code, 0, `relay accepts --bypass with --dry-run; it said:\n${output}`)
    assert.match(output, /^ {2}advisor: {5}codex --dangerously-bypass-approvals-and-sandbox$/m, output)
    assert.match(output, /^ {2}implementer: claude --dangerously-skip-permissions$/m, output)
    assert.ok(
      !existsSync(join(dir, CONFIG_RELATIVE)),
      'a dry run wrote a permission mode into the project — for this run AND every future one',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('a relay dry run resolves every seat rather than describing what was typed', { timeout: 60_000 }, async () => {
  // THE ASYMMETRY, settled. `session --dry-run --advisor nope` refused and `relay --dry-run
  // --advisor nope` printed a plan naming `nope`, because the console's resolution moved above
  // its lock in #130 and relay's still sat inside `Relay.start`, below the short-circuit.
  //
  // Refusing is the half worth keeping on both. A plan is worth something only if it is a plan
  // of a run that could happen; a plan naming a seat no registry can fill is the dry run failing
  // at its only job, and the operator finds out when they drop the flag -- which is the moment
  // the flag exists to come before.
  //
  // Every seat, not just the advisor: an `--implementers` list is valid up to its last entry,
  // which is where a check that stopped after the first seat would look like it worked.
  for (const argv of [
    ['relay', 'a goal', '--advisor', 'nope', '--dry-run'],
    ['relay', 'a goal', '--implementer', 'nope', '--dry-run'],
    ['relay', 'a goal', '--implementers', 'claude,nope', '--dry-run'],
    ['relay', 'a goal', '--reviewer', 'nope', '--dry-run'],
  ]) {
    const dir = repo()
    const home = fakeHome()
    try {
      const before = snapshot(dir)
      const homeBefore = snapshot(home)
      await assert.rejects(
        runRelay(dir, home, argv),
        /unknown agent 'nope'/,
        `not refused: ${argv.join(' ')}`,
      )
      // And refused before anything happened on its behalf, which is the same boundary again:
      // the refusal used to arrive from inside `Relay.start`, with the hooks already written
      // and the trust probed.
      assert.deepEqual(snapshot(dir), before, `${argv.join(' ')} wrote something before refusing`)
      assert.deepEqual(snapshot(home), homeBefore, `${argv.join(' ')} touched the operator's home`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  }
})

test('the relay dry run returns above every side effect the command has', () => {
  // The structural half, and the only half that can see the Codex trust probe: it spawns `codex
  // app-server` and writes the operator's global config, so a scratch project cannot witness it,
  // and a test that let it run to find out would be doing the thing it is asserting does not
  // happen.
  //
  // Positions in the source, not the absence of a phrase. Scoped to the relay block, because
  // `installConfig` is also called by `config install` and an index comparison across the whole
  // file would be comparing two different commands. Each call is asserted to be UNIQUE within
  // the block as well as later, because a second occurrence above the return would satisfy the
  // comparison while doing the very thing this rules out.
  const src = readFileSync(CLI, 'utf8')
  const start = src.indexOf("if (command === 'relay')")
  const end = src.indexOf("if (command === 'session')", start)
  assert.ok(start > 0 && end > start, 'the relay command block must be locatable')
  const block = src.slice(start, end)

  // `isDryRun` rather than the `rest.includes('--dry-run')` this used to look for. The flag is
  // read once into a const now, because the launch preamble consults it too -- it suppresses
  // the three bounds lines the plan is about to print -- and a second `includes` beside the
  // first is the kind of duplicate that drifts. Asserted UNIQUE for the same reason the calls
  // below are: a second short-circuit on the same flag would satisfy the comparisons while
  // being the thing they rule out. The `if (!isDryRun)` guards above it do not match this
  // spelling, which is what keeps the pin on the return rather than on the first guard.
  const returns = block.indexOf('if (isDryRun) {')
  assert.ok(returns > 0, 'the dry-run block must be locatable in the relay command')
  assert.equal(
    returns,
    block.lastIndexOf('if (isDryRun) {'),
    'the dry-run short-circuit must appear once, or every comparison below it lies',
  )

  for (const [call, what] of [
    ['applyBypassFlag(', 'a permission mode is written into the project'],
    ['await installConfig(', 'hooks are registered in the project'],
    ['await ensureCodexHooksTrusted(', "Codex's trust is probed and its global config written"],
    ['new RunLogWriter(', 'the run log directory is created'],
    ['readRunLog(', 'the resume log is read'],
    ['await Relay.start(', 'participants are created'],
  ] as const) {
    const at = block.indexOf(call)
    assert.ok(at > 0, `${call} must be present in the relay block`)
    assert.equal(at, block.lastIndexOf(call), `${call} must appear once, or this comparison lies`)
    assert.ok(at > returns, `a dry run must return before ${what} (${call})`)
  }

  // The bypass write is BELOW installation and the trust probe as well as below the return,
  // and that second ordering is not about dry runs at all. `--bypass` writes a permission mode
  // into the project for this run and every future one; the two calls above it are the ones
  // most likely to fail on a machine that has never run this. Applying the mode first would
  // leave that setting behind on a run that then refused to start.
  //
  // Asserted because moving the dry-run return broke it once. The unconditional call was
  // hoisted past both, so a failing `installConfig` would have left a project permanently
  // permissive from an invocation that never reached `Relay.start` -- and the comment sitting
  // directly above the call said, in those words, why that must not happen. An independent
  // review caught it; nothing here did, which is why there is now something here.
  const bypass = block.indexOf('applyBypassFlag(')
  assert.ok(
    bypass > block.indexOf('await installConfig('),
    'the permission mode must be written after hooks are registered, not before',
  )
  assert.ok(
    bypass > block.indexOf('await ensureCodexHooksTrusted('),
    'and after the trust probe, which is the other call that can fail and abandon the run',
  )

  // And the resolution that makes the plan worth printing is on the OTHER side of the same
  // line: refusing an unknown agent is not a side effect, so it belongs above the return.
  const resolves = block.indexOf('registry.resolve(spec)')
  assert.ok(resolves > 0, 'the relay block must resolve its seats')
  assert.ok(resolves < returns, 'seat resolution must happen above the dry-run return, not below')
})
