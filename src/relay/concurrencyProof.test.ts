/**
 * Two implementer seats running as two real processes, at the same time, proved by rendezvous.
 *
 * Everything else that claims concurrency in this repository claims it about `FakeRotationSession`
 * objects, which share one thread with the dispatcher and with each other. That is enough to
 * pin scheduling decisions -- which task was assigned when, which report was routed first --
 * and it is NOT evidence that two agents ever run at once, because nothing in an in-process
 * fake could tell the difference between real parallelism and two promises interleaving.
 *
 * So this file spawns children. Both proofs use seams that already exist for exactly this:
 *
 *   - `OpenCodeAdapterOptions.command`, documented as overridable "so a test can point at a
 *     stub without a real OpenCode on PATH". The registry entry below is the production
 *     `OpenCodeRunAdapter` with that one option set.
 *   - PATH. The second proof spawns `bin/conclave.ts relay` as a real process with a fixture
 *     named `opencode` ahead of everything else on PATH, so the CLI builds the built-in
 *     registry, resolves the command the way it always does, and nothing in this file is
 *     injected into it at all.
 *
 * No production code was given a testing seam for this, and none was needed.
 *
 * ## Why a rendezvous rather than a stopwatch
 *
 * The children refuse to finish until each has seen the other's entry file. Overlap is
 * therefore a fact recorded by the participants, not an inference from how long anything took:
 * launched serially, the first child waits for a sibling that has not started, times out, and
 * records `timeout`. A duration-based proof would be at the mercy of a loaded machine in both
 * directions -- it can invent overlap and it can destroy it.
 *
 *   node --test src/relay/concurrencyProof.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { OpenCodeRunAdapter } from '../adapters/opencode.ts'
import { OPENCODE_CAPABILITIES } from '../conformance/capabilities.ts'
import { AgentRegistry } from '../registry/registry.ts'
import type { CreateParticipantContext, ResolvedParticipant } from '../registry/types.ts'
import { tempDir } from '../testkit/tempDir.ts'
import { concurrentSeats } from './dispatch.ts'
import { Relay } from './relay.ts'

const FIXTURE = join(import.meta.dirname, 'fixtures', 'opencodeFixture.mjs')
const CLI = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')

/** A repository for the run. Two seats mean real worktrees, and those need a real checkout. */
function tempRepo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-proof')
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
 * What a child recorded about its rendezvous, or why there is nothing to read.
 *
 * Defensive on purpose. A seat that was never constructed writes no marker at all, and
 * `readFileSync` throwing ENOENT reports that as a missing file rather than as a missing SEAT
 * — which is the fact, and the one a reader needs. Found by mutation: collapsing the CLI's
 * seat list failed this file with a path in the message and nothing else.
 */
function overlapOf(dir: string, seat: string): string {
  const path = join(dir, `overlap-${seat}`)
  return existsSync(path) ? readFileSync(path, 'utf8') : 'no marker: that seat never ran'
}

/** Poll a predicate. Only ever used to wait for a file the CHILDREN write. */
async function until(check: () => boolean, budgetMs: number): Promise<boolean> {
  const stop = Date.now() + budgetMs
  while (Date.now() < stop) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

/**
 * The production OpenCode adapter, pointed at the fixture and at nothing else.
 *
 * `capabilities` and the rest come from the same places the built-in entry takes them, so what
 * the relay is driving is the real adapter with a different executable behind it.
 */
function fixtureRegistry(): AgentRegistry {
  const r = new AgentRegistry()
  r.register({
    id: 'opencode',
    displayName: 'OpenCode (fixture)',
    capabilities: OPENCODE_CAPABILITIES,
    deadlines: { absolute: { supported: true }, silence: { supported: false } },
    launch: { command: FIXTURE, baseArgs: [] },
    async create(resolved: ResolvedParticipant, ctx: CreateParticipantContext) {
      return OpenCodeRunAdapter.start({
        cwd: ctx.cwd,
        role: resolved.role.id,
        inputOwnership: resolved.inputOwnership,
        command: FIXTURE,
        args: [...(resolved.spec.args ?? [])],
      })
    },
  })
  return r
}

const LEAD = { id: 'advisor', agent: 'opencode', role: 'advisor' } as const
const SEATS = [
  { id: 'implementer', agent: 'opencode', role: 'implementer' },
  { id: 'implementer-2', agent: 'opencode', role: 'implementer' },
] as const

test('two seats are real, simultaneous child processes, and the seat table says so', async (t) => {
  const repo = tempRepo(t)
  // Where the children leave their evidence, and OUTSIDE the repository deliberately:
  // inside it these files would be untracked work, and the clean-base rule would refuse
  // to start the run that is supposed to produce them.
  const dir = tempDir(t, 'conclave-rendezvous')
  const previous = process.env.CONCLAVE_FIXTURE_DIR
  process.env.CONCLAVE_FIXTURE_DIR = dir

  const relay = await Relay.start({
    registry: fixtureRegistry(),
    cwd: repo,
    lead: LEAD,
    implementer: SEATS[0],
    implementers: [...SEATS],
    maxAdvisorTurns: 5,
  })

  /**
   * Read the seat table while both children are held at the rendezvous.
   *
   * This is the only reason the `release` file exists. Waiting for both entry files proves the
   * overlap happened; holding the children there is what makes the overlapped state something
   * a test can LOOK at rather than reason about after the fact.
   */
  let observed: { concurrent: number; states: [string, string][] } | undefined
  const watcher = (async () => {
    const bothIn = await until(
      () => readdirSync(dir).filter((f) => f.startsWith('entered-')).length >= 2,
      15_000,
    )
    if (bothIn) {
      observed = {
        concurrent: concurrentSeats(relay.seats()),
        states: relay.seats().map((s) => [s.seat, s.state]),
      }
    }
    writeFileSync(join(dir, 'release'), 'go')
  })()

  try {
    const outcome = await relay.run('Prove that two seats run at once.')
    await watcher

    // The children's own account, written by each before it was allowed to finish.
    assert.equal(
      overlapOf(dir, 'implementer'),
      'observed',
      'the first seat must have seen the second enter before it was allowed to finish',
    )
    assert.equal(
      overlapOf(dir, 'implementer-2'),
      'observed',
      'and the second must have seen the first',
    )

    // The dispatcher's account of the same moment.
    assert.ok(observed, 'both seats must have entered, so the seat table could be read')
    assert.equal(observed.concurrent, 2, 'the seat table must report two seats running at once')
    assert.deepEqual(observed.states, [
      ['implementer', 'running'],
      ['implementer-2', 'running'],
    ])

    // And the run is a real run, not a rendezvous that deadlocked into something.
    assert.equal(outcome.reason, 'done', 'the run must complete')
    assert.deepEqual(
      relay.tasks().map((e) => [e.runtime.seat, e.runtime.state]),
      [
        ['implementer', 'complete'],
        ['implementer-2', 'complete'],
      ],
      'both tasks must finish, on the two different seats they were addressed to',
    )
    // Both children really were separate processes: different pids in their entry files.
    const pids = ['implementer', 'implementer-2'].map(
      (s) => readFileSync(join(dir, `entered-${s}`), 'utf8').split(' ')[0],
    )
    assert.equal(new Set(pids).size, 2, 'two seats must be two processes, not one answering twice')
    // Every turn was graded from the child's announced stop signal rather than from its exit
    // code, which is what makes `completed` observed here.
    for (const p of relay.participants) {
      const ends = p.events.filter((e) => e.type === 'turn_end')
      assert.ok(ends.length > 0, `${p.id} must have taken at least one turn`)
      for (const e of ends) {
        assert.equal(e.verdict.outcome, 'completed', `${p.id} turns must complete`)
        assert.equal(e.verdict.confidence, 'proven')
      }
    }
  } finally {
    await relay.stop()
    if (previous === undefined) delete process.env.CONCLAVE_FIXTURE_DIR
    else process.env.CONCLAVE_FIXTURE_DIR = previous
  }
})

test('the real relay CLI constructs both seats and runs them as concurrent children', async (t) => {
  // Nothing here is injected. `conclave relay` is spawned as its own process, builds the
  // built-in registry, and resolves `opencode` off a PATH whose first entry is a directory
  // holding the fixture under that name. The only thing this test controls is the environment
  // the CLI inherits, which is what an operator controls too.
  const repo = tempRepo(t)
  // Where the children leave their evidence, and OUTSIDE the repository deliberately:
  // inside it these files would be untracked work, and the clean-base rule would refuse
  // to start the run that is supposed to produce them.
  const dir = tempDir(t, 'conclave-rendezvous')
  const binDir = tempDir(t, 'conclave-bin')
  mkdirSync(binDir, { recursive: true })
  // A launcher rather than a symlink, so `#!/usr/bin/env node` resolution and the fixture's
  // own path are both unambiguous whatever the platform does with links.
  const shim = join(binDir, 'opencode')
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`, { mode: 0o755 })
  // Nobody is watching the seat table in this proof, so the children are released immediately.
  // The rendezvous still has to succeed: they cannot finish without seeing each other.
  writeFileSync(join(dir, 'release'), 'go')

  const cli = spawn(
    process.execPath,
    [CLI, 'relay', 'Prove that two seats run at once.', '--advisor', 'opencode', '--implementers', 'opencode,opencode', '--rounds', '5', '--json'],
    {
      cwd: repo,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, CONCLAVE_FIXTURE_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  cli.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')))
  cli.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')))
  const code = await new Promise<number | null>((r) => cli.once('close', r))
  assert.equal(code, 0, `the CLI run must succeed:\n${stderr.slice(-2000)}`)

  // The CLI's own report first, which is the operator-visible half: two implementer seats
  // with the ids the front-end assigned, both having taken turns.
  //
  // Asserted BEFORE the rendezvous markers, and the order is the whole difference between a
  // useful failure and a puzzle. A CLI that built one seat produces no marker for the second,
  // so checking the markers first reports a missing file; checking the report first says
  // which seat is missing, in a diff.
  const report = JSON.parse(stdout) as {
    outcome: { reason: string }
    participants: { id: string; agent: string; rank: string; turns: unknown[] }[]
  }
  assert.equal(report.outcome.reason, 'done')
  assert.deepEqual(
    report.participants.map((p) => [p.id, p.agent, p.rank]),
    [
      ['advisor', 'opencode', 'advisor'],
      ['implementer', 'opencode', 'implementer'],
      ['implementer-2', 'opencode', 'implementer'],
    ],
    'the CLI must construct both implementer seats end to end',
  )
  for (const p of report.participants) {
    assert.ok(p.turns.length > 0, `${p.id} must have taken a turn in the CLI run`)
  }

  // Then the children's account: two seats entered, and each waited for the other.
  assert.equal(
    overlapOf(dir, 'implementer'),
    'observed',
    'the CLI run\'s first seat must have seen the second enter before it was allowed to finish',
  )
  assert.equal(
    overlapOf(dir, 'implementer-2'),
    'observed',
    'and the CLI run\'s second seat must have seen the first',
  )
})

test('the fixture refuses to run without its rendezvous directory', () => {
  // The one way these proofs could pass vacuously is a fixture that silently did nothing when
  // the environment was not set up. It exits non-zero instead, which the adapter would grade
  // `unknown_abnormal_end` and the run would fail rather than quietly prove less.
  const env = { ...process.env }
  delete env.CONCLAVE_FIXTURE_DIR
  const r = spawn(process.execPath, [FIXTURE, 'run', '--format', 'json', '--', 'hello'], { env, stdio: 'pipe' })
  return new Promise<void>((resolve, reject) => {
    let stderr = ''
    r.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')))
    r.once('close', (code) => {
      try {
        assert.notEqual(code, 0, 'a fixture with nowhere to write must fail loudly')
        assert.match(stderr, /CONCLAVE_FIXTURE_DIR is not set/)
        resolve()
      } catch (e) {
        reject(e as Error)
      }
    })
  })
})

/** Kept honest: the fixture must exist and be executable, or every proof above is vacuous. */
test('the fixture is present and executable', () => {
  assert.ok(existsSync(FIXTURE), 'the fixture must be committed alongside the test that runs it')
  const out = execFileSync('test', ['-x', FIXTURE], { encoding: 'utf8' })
  assert.equal(out, '', 'the fixture must carry its executable bit through git')
})
