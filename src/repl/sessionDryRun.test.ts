/**
 * `session --dry-run`: resolve everything, describe it, touch nothing.
 *
 * The plan itself -- and that it matches `relay --dry-run` line for line -- is asserted in
 * `frontEndParity.test.ts`, where the comparison between the two front-ends belongs. What is
 * here is the other half of the claim, and the half that is easy to believe without checking:
 * that an invocation whose last line says nothing was started really did start nothing.
 *
 * "Nothing was written" is asserted POSITIVELY, by comparing the project tree before and after
 * rather than by grepping the output for the absence of a phrase. A dry run that registered
 * hooks would print exactly the same plan, so the output cannot be the evidence. The seats are
 * fakes from an injected registry, so a regression that fell through to `Relay.start` shows up
 * as a recorded `create` rather than as a real agent CLI and real quota.
 *
 *   node --test src/repl/sessionDryRun.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import { main } from '../../bin/conclave.ts'
import { CONFIG_RELATIVE } from '../config/project.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { acquire as acquireLock, lockPath } from '../workspace/sessionLock.ts'

function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-dryrun')
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
 * Every path under a project, with the contents of every file.
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
 * A registry that knows `codex` and `claude` -- the console's own defaults -- and records every
 * participant it is asked to create.
 *
 * The names are the real ones on purpose. A dry run that fell through would hand `installConfig`
 * and `ensureCodexHooksTrusted` exactly the agent list a real run gives them, so the hook files
 * and the trust probe are the ones the tree comparison is looking for. What is fake is only the
 * session behind them, which is what keeps the failure mode a failed assertion instead of two
 * agent CLIs starting.
 */
function fakeRegistry(created: string[]): AgentRegistry {
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

/** Drive the real `session` command in a scratch project, capturing everything it writes. */
async function runIn(dir: string, argv: readonly string[]): Promise<Ran> {
  const said: string[] = []
  const created: string[] = []
  const before = process.cwd()
  const [log, error] = [console.log, console.error]
  console.log = (...a: unknown[]) => void said.push(a.map(String).join(' '))
  console.error = (...a: unknown[]) => void said.push(a.map(String).join(' '))
  try {
    process.chdir(dir)
    const code = await main([...argv], {
      registry: fakeRegistry(created),
      // Ended rather than merely empty: if a regression let the console open, it reads a
      // closed stdin and finishes instead of hanging the suite.
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
    process.chdir(before)
    console.log = log
    console.error = error
  }
}

test('a dry run describes the run and leaves the project byte for byte as it found it', { timeout: 60_000 }, async (t) => {
  const dir = repo(t)
  const before = snapshot(dir)
  const { code, said, created } = await runIn(dir, [
    'session',
    'a goal that would start two seats',
    '--checks',
    'npm test',
    // Inside the project deliberately. The tee is opened at the very top of `runSession`,
    // above everything else it does, so it is the one side effect that could happen before
    // the plan is even composed.
    '--record',
    join(dir, 'render.log'),
    '--dry-run',
  ])
  const output = said.join('\n')
  assert.equal(code, 0, `a dry run must succeed; it said:\n${output}`)
  assert.match(output, /^dry run — nothing was started$/m, `no plan was printed:\n${output}`)

  // The whole claim, in one comparison: same paths, same bytes.
  assert.deepEqual(
    snapshot(dir),
    before,
    'a dry run wrote something into the project. Whatever it is, an invocation that reports ' +
      'starting nothing must not leave it behind.',
  )
  // ...and named, one by one, so a failure says WHICH step ran rather than only that the
  // tree differs. Each of these is a thing a real console run does, in the order it does
  // them, and every one lives below the point the dry run returns from.
  for (const [path, what] of [
    ['.claude/settings.json', 'Claude hooks were registered'],
    ['.codex/hooks.json', 'the Codex sidecar was registered'],
    [CONFIG_RELATIVE, 'a permission mode was written'],
    ['.conclave/session.lock', 'the session lock was taken'],
    ['.conclave/runs', 'a run log was opened'],
    ['render.log', 'the --record tee was opened'],
  ] as const) {
    assert.ok(!existsSync(join(dir, path)), `${what} (${path}) during a dry run`)
  }
  // The Codex trust probe writes nothing here -- it spawns `codex app-server` and edits the
  // operator's GLOBAL config -- so the tree cannot see it. It is reached from the same place
  // as the hook registration above, and the source-order test at the end of this file is
  // what pins it.
  assert.deepEqual(created, [], 'a dry run created a participant')
})

test('a dry run neither consults nor takes the session lock', { timeout: 60_000 }, async (t) => {
  // #130's reasoning, applied one step further. A live lock means someone else's participants
  // are working in this tree, and refusing to start is the right answer to an invocation that
  // would start something. A dry run is not one: it is going to start nothing whatever the lock
  // says, so a refusal naming somebody else's session answers a question nobody asked.
  //
  // The lock is real and belongs to this process -- `read()` decides liveness with
  // `kill(pid, 0)` -- so no agent CLI is spawned to manufacture a live session.
  const dir = repo(t)
  acquireLock(dir, [
    { id: 'advisor', agent: 'codex' },
    { id: 'implementer', agent: 'claude' },
  ])
  const held = readFileSync(lockPath(dir), 'utf8')

  const dry = await runIn(dir, ['session', 'a goal', '--dry-run'])
  assert.equal(dry.code, 0, `a dry run must answer, not refuse; it said:\n${dry.said.join('\n')}`)
  assert.match(dry.said.join('\n'), /^dry run — nothing was started$/m)
  assert.equal(readFileSync(lockPath(dir), 'utf8'), held, 'the dry run rewrote the live lock')

  // The control, and the reason this test is not vacuous: the SAME invocation without
  // `--dry-run` is still refused by the lock. A fix that let a dry run past by weakening the
  // guard would pass every assertion above and fail here.
  const real = await runIn(dir, ['session', 'a goal'])
  assert.equal(real.code, 1, 'a run that would start participants must still be refused')
  assert.match(real.said.join('\n'), /participants are live/)
  assert.deepEqual(real.created, [], 'and it must not have created one on the way to refusing')
})

test('--dry-run and --bypass are refused together, and nothing is written', { timeout: 60_000 }, async (t) => {
  // Refused rather than resolved either way, because both resolutions are wrong. Applying the
  // bypass leaves a permission mode written into the project -- for this run AND future ones --
  // by an invocation whose own last line says nothing was started. Skipping it prints a plan
  // whose launch arguments are not the ones the run would use, since the permissive flags are
  // composed from the config the bypass would have changed.
  //
  // `relay` has a third option: `withBypass` overlays the requested mode in memory, so its plan
  // is composed as the run would be while nothing is written. The console reads the config
  // inside `runSession` and has no such overlay.
  const dir = repo(t)
  const { code, said } = await runIn(dir, ['session', 'a goal', '--bypass', '--dry-run'])
  assert.equal(code, 1, `the pair must be refused; it said:\n${said.join('\n')}`)
  const output = said.join('\n')
  assert.match(output, /--dry-run and --bypass/, `the refusal must name both flags:\n${output}`)
  assert.ok(
    !existsSync(join(dir, CONFIG_RELATIVE)),
    'the refused invocation wrote a permission mode anyway',
  )
  assert.ok(
    !/dry run — nothing was started/.test(output),
    'and it must not print a plan it has just said it will not resolve',
  )
})

test('the bypass write this refusal prevents is one the project would really have received', async (t) => {
  // The control for the test above, which otherwise proves only that a file this run never
  // creates was not created. `--bypass` with an unresolvable advisor gets PAST
  // `applyBypassFlag` -- the write happens in the CLI block -- and then ends at seat
  // resolution inside `runSession`, above the lock and above everything that starts a run.
  // So the config file appears, which is exactly what the refusal above is preventing.
  const dir = repo(t)
  await assert.rejects(
    runIn(dir, ['session', 'a goal', '--bypass', '--advisor', 'nope']),
    /unknown agent 'nope'/,
  )
  assert.ok(
    existsSync(join(dir, CONFIG_RELATIVE)),
    'if this file is absent, the test above is asserting nothing',
  )
  assert.match(readFileSync(join(dir, CONFIG_RELATIVE), 'utf8'), /"bypass"/)
})

test('a dry run resolves every seat rather than merely describing what was typed', async (t) => {
  // A plan is worth something only if it is a plan of a run that could happen. Resolution is
  // above the return (#130 put it above the lock, and the dry run returns between the two), so
  // an agent name no registry knows is refused HERE, with the registry's own sentence, rather
  // than printed as a seat and discovered when the operator drops `--dry-run`.
  //
  // Every seat, not just the advisor: an `--implementers` list is valid up to its last entry,
  // which is where a check that stopped after the first seat would look like it worked.
  for (const argv of [
    ['session', 'a goal', '--advisor', 'nope', '--dry-run'],
    ['session', 'a goal', '--implementer', 'nope', '--dry-run'],
    ['session', 'a goal', '--implementers', 'claude,nope', '--dry-run'],
    ['session', 'a goal', '--reviewer', 'nope', '--dry-run'],
  ]) {
    const dir = repo(t)
    await assert.rejects(runIn(dir, argv), /unknown agent 'nope'/, `not refused: ${argv.join(' ')}`)
  }
})

test('the dry run returns above every side effect a session has', () => {
  // The structural half, and the only half that can see the Codex trust probe: it spawns
  // `codex app-server` and writes the operator's GLOBAL config, so a scratch project cannot
  // witness it, and a test that let it run to find out would be doing the thing it is
  // asserting does not happen.
  //
  // Positions in the source, not the absence of a phrase. Each call below is asserted to be
  // UNIQUE as well as later, because a second occurrence above the return would satisfy an
  // index comparison while doing the very thing this rules out.
  const src = readFileSync(join(import.meta.dirname, 'session.ts'), 'utf8')
  const returns = src.indexOf('if (opts.dryRun === true) {')
  assert.ok(returns > 0, 'the dry-run block must be locatable in runSession')

  for (const [call, what] of [
    ['const existing = guard(opts.cwd)', 'the lock is consulted'],
    ['await installConfig(', 'hooks are registered in the project'],
    ['await ensureCodexHooksTrusted(', "Codex's trust is probed"],
    ['new RunLogWriter(', 'the run log is opened'],
    ['await Relay.start(', 'participants are created'],
    ['recordSession(', 'the session record is written'],
  ] as const) {
    const at = src.indexOf(call)
    assert.ok(at > 0, `${call} must be present in runSession`)
    assert.equal(at, src.lastIndexOf(call), `${call} must appear once, or this comparison lies`)
    assert.ok(at > returns, `a dry run must return before ${what} (${call})`)
  }
})
