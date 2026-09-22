/**
 * The install notice at launch (#356), through both real front-ends.
 *
 * `main(['relay', ...])` and `main(['session', ...])` from `bin/conclave.ts`, with the
 * participants replaced by fakes and `noteInstallLaunch` replaced by a stand-in that records
 * what it was asked and answers what the test chose. The stand-in is what keeps this file away
 * from the real per-user record; the module behind it has its own tests in
 * `installLaunch.test.ts`, and what is under test here is the wiring: what is printed for
 * each answer, where, and -- as much of the claim as the rendering -- WHEN the record is
 * consulted, because consulting it rewrites it.
 *
 *   node --test src/workspace/installLaunchNotice.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { main } from '../../bin/conclave.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { tempDir } from '../testkit/tempDir.ts'
import { version } from '../version.ts'
import { listSessions } from './sessionRecord.ts'
import { acquire, release } from './sessionLock.ts'
import type { InstallLaunch, InstallLaunchInputs } from './installLaunch.ts'

const BIN = realpathSync(join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts'))

function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-install-notice')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'work.ts'), 'export const a = 1\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

/** Two fake seats; one DONE from the advisor ends the run at its first turn. */
function fakeRegistry(): AgentRegistry {
  const registry = new AgentRegistry()
  for (const agent of ['fake-lead', 'fake-impl']) {
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
      async create() {
        return new FakeRotationSession(`${agent}-1`, agent, agent === 'fake-lead' ? ['DONE'] : [])
      },
    })
  }
  return registry
}

const PREVIOUS = { build: '0.5.61 (1111111)', root: '/releases/v0.5.61' }
const BUILD = version()

/** What each answer the record can give looks like, for this build. */
const ANSWERS: Record<InstallLaunch['kind'], InstallLaunch> = {
  development: { kind: 'development', build: BUILD },
  first: { kind: 'first', build: BUILD, recorded: true },
  unchanged: { kind: 'unchanged', build: BUILD, previous: { build: BUILD, root: '/releases/now' }, recorded: true },
  changed: { kind: 'changed', build: BUILD, previous: PREVIOUS, recorded: true },
}

interface Ran {
  code: number
  /** Every human-readable line the front-end printed, in order. */
  lines: string[]
  /** Each call the front-end made to the record, with what it passed. */
  asked: InstallLaunchInputs[]
}

/**
 * One run through a front-end, with the record answering `answer`.
 *
 * Relay prints through `console.log`; the console writes to its `output` stream. Both are
 * captured into one list so the assertions read the same for either.
 */
async function run(front: 'relay' | 'session', dir: string, answer: InstallLaunch, argv: readonly string[] = []): Promise<Ran> {
  const asked: InstallLaunchInputs[] = []
  const lines: string[] = []
  const beforeCwd = process.cwd()
  const [log, error] = [console.log, console.error]
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  console.error = () => {}
  try {
    process.chdir(dir)
    const code = await main([front, 'a goal', '--advisor', 'fake-lead', '--implementer', 'fake-impl', '--rounds', '2', ...argv], {
      registry: fakeRegistry(),
      input: new PassThrough(),
      output: new Writable({
        write(chunk, _enc, cb) {
          for (const l of String(chunk).split('\n')) lines.push(l)
          cb()
        },
      }),
      installLaunch: (inputs) => {
        asked.push(inputs)
        return answer
      },
    })
    return { code, lines, asked }
  } finally {
    process.chdir(beforeCwd)
    console.log = log
    console.error = error
  }
}

// ANSI stripped: the console paints these lines, and what is asserted is the words.
const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
const noticeLines = (lines: string[]) => plain(lines).filter((l) => /install(: | moved:)|install is shared/.test(l))

for (const front of ['relay', 'session'] as const) {
  test(`${front}: a changed install is named once, both builds, and said to be shared`, async (t) => {
    const r = await run(front, repo(t), ANSWERS.changed)
    assert.equal(r.code, 0)
    const notice = noticeLines(r.lines)
    assert.equal(notice.length, 2, `exactly one two-line notice:\n${plain(r.lines).join('\n')}`)
    assert.match(notice[0]!, /install moved: 0\.5\.61 \(1111111\) → /, 'the previous build, first')
    assert.ok(notice[0]!.endsWith(BUILD), `and this build: ${notice[0]}`)
    assert.match(notice[1]!, /shared by every project on this machine/, 'the clause no per-project notice could say')
    assert.match(notice[1]!, /can move for reasons outside this project/)
  })

  test(`${front}: no previous record names this build, and does not claim a move`, async (t) => {
    const r = await run(front, repo(t), ANSWERS.first)
    assert.equal(r.code, 0)
    const notice = noticeLines(r.lines)
    assert.equal(notice.length, 1, `exactly one line:\n${plain(r.lines).join('\n')}`)
    assert.match(notice[0]!, /^\s*install: /)
    assert.ok(notice[0]!.includes(BUILD), `names this build: ${notice[0]}`)
    assert.match(notice[0]!, /no earlier launch is recorded on this machine/)
    assert.doesNotMatch(notice[0]!, /moved/)
  })

  test(`${front}: an unchanged install prints nothing new`, async (t) => {
    const r = await run(front, repo(t), ANSWERS.unchanged)
    assert.equal(r.code, 0)
    assert.deepEqual(noticeLines(r.lines), [])
  })

  test(`${front}: a development launch prints nothing`, async (t) => {
    const r = await run(front, repo(t), ANSWERS.development)
    assert.equal(r.code, 0)
    assert.deepEqual(noticeLines(r.lines), [])
  })

  test(`${front}: the record is asked once, for this process's own build, entry file and environment`, async (t) => {
    const r = await run(front, repo(t), ANSWERS.unchanged)
    assert.equal(r.asked.length, 1, 'consulted exactly once: consulting rewrites it')
    const inputs = r.asked[0]!
    assert.equal(inputs.build, BUILD, 'the build the banner names is the build recorded')
    assert.equal(inputs.entry, BIN, 'the resolved file this process is running, not argv[1]')
    assert.equal(inputs.env, process.env, "the process's own PATH and XDG variables")
  })

  test(`${front}: the notice comes before the launch lines, and after nothing else about the run`, async (t) => {
    const r = await run(front, repo(t), ANSWERS.changed)
    const lines = plain(r.lines)
    const notice = lines.findIndex((l) => /install moved:/.test(l))
    const ceilings = lines.findIndex((l) => /ceilings:/.test(l))
    assert.ok(notice >= 0 && ceilings >= 0, `both lines present:\n${lines.join('\n')}`)
    assert.ok(notice < ceilings, `the notice (${notice}) is above the ceilings line (${ceilings}), where the launch is described`)
  })

  test(`${front}: a dry run does not consult the record`, async (t) => {
    const r = await run(front, repo(t), ANSWERS.changed, ['--dry-run'])
    assert.equal(r.code, 0)
    assert.deepEqual(r.asked, [], 'a dry run starts nothing, so it is not a launch to record')
    assert.deepEqual(noticeLines(r.lines), [])
  })

  test(`${front}: a refused launch does not consult the record`, async (t) => {
    // Not a git repository and no --force: refused before anything is set up. A refused
    // launch that had rewritten the record would rob the next real one of its notice.
    const r = await run(front, tempDir(t, 'conclave-not-a-repo'), ANSWERS.changed)
    assert.equal(r.code, 1)
    assert.deepEqual(r.asked, [])
    assert.deepEqual(noticeLines(r.lines), [])
  })
}

test('the console refuses a live session before it consults the record', async (t) => {
  // The console's own refusal, below the CLI block and inside `runSession`: the lock. This is
  // the case the thunk exists for -- a result computed in the CLI block would already have
  // rewritten the record by the time the lock said no. `acquire` stamps this process's pid,
  // which is alive by definition, so the session the console finds is genuinely live.
  const dir = repo(t)
  acquire(dir, [
    { id: 'advisor', agent: 'fake-lead' },
    { id: 'implementer', agent: 'fake-impl' },
  ])
  t.after(() => release(dir))
  const r = await run('session', dir, ANSWERS.changed)
  assert.equal(r.code, 1, `refused:\n${plain(r.lines).join('\n')}`)
  assert.match(plain(r.lines).join('\n'), /refusing to start/)
  assert.deepEqual(r.asked, [], 'the record was not consulted for a launch that did not happen')
})

test('a detached relay: the parent does not consult the record; the child is the run', { timeout: 60_000 }, async (t) => {
  // The parent re-executes this binary as a background child and returns. If the parent
  // consulted the record, the child -- an ordinary `conclave relay` in every respect, and the
  // process that IS the run -- would find it already rewritten and report `unchanged` into
  // its stdio log, which is where the run's account is kept. So the parent must not.
  //
  // The child here is a real process, given agents no registry knows so it refuses at
  // resolution -- ABOVE the point it would consult the record -- and ends itself. Its state
  // directory is pointed at scratch for the same reason: whatever it does, it does not reach
  // the machine's real record from inside a test.
  const dir = repo(t)
  const state = tempDir(t, 'conclave-detach-state')
  const beforeEnv = process.env['XDG_STATE_HOME']
  process.env['XDG_STATE_HOME'] = state
  const asked: InstallLaunchInputs[] = []
  const beforeCwd = process.cwd()
  const [log, error] = [console.log, console.error]
  console.log = () => {}
  console.error = () => {}
  let child: number | undefined
  try {
    process.chdir(dir)
    const code = await main(['relay', 'a goal', '--detach', '--advisor', 'fake-advisor', '--implementer', 'fake-impl'], {
      installLaunch: (inputs) => {
        asked.push(inputs)
        return ANSWERS.changed
      },
    })
    assert.equal(code, 0, 'the parent hands off and returns')
    child = listSessions(dir)[0]?.status.pid
  } finally {
    process.chdir(beforeCwd)
    console.log = log
    console.error = error
    if (beforeEnv === undefined) delete process.env['XDG_STATE_HOME']
    else process.env['XDG_STATE_HOME'] = beforeEnv
    if (child !== undefined) {
      try {
        process.kill(child, 'SIGKILL')
      } catch {
        // Already gone: it refused its agents and ended, which is the expected ending.
      }
    }
  }
  assert.deepEqual(asked, [], 'the parent never consulted the record')
  assert.ok(!existsSync(join(state, 'conclave')) || readdirSync(join(state, 'conclave')).length === 0, 'and nothing wrote one')
})

// ---------------------------------------------------------------------------------------------
// The real record, end to end

/**
 * A run through the REAL `noteInstallLaunch` -- no stand-in -- with this process made to look
 * installed: a scratch bin directory whose `conclave` links to the launcher beside the entry
 * file this process runs, put on PATH, and a scratch `XDG_STATE_HOME`. Every real launch a
 * test makes resolves to `development` and is silent, so without this the wiring from the
 * front-ends to the real record would be tested only by the stand-in agreeing with itself.
 */
async function realRun(t: TestContext, front: 'relay' | 'session', state: string): Promise<{ code: number; lines: string[] }> {
  const bin = tempDir(t, 'conclave-install-notice-bin')
  const { symlinkSync } = await import('node:fs')
  symlinkSync(join(BIN, '..', 'conclave'), join(bin, 'conclave'))
  const env = { PATH: process.env['PATH'], XDG_STATE_HOME: process.env['XDG_STATE_HOME'] }
  // Prepended, not substituted: the first `conclave` on PATH decides, and git stays reachable.
  process.env['PATH'] = `${bin}:${process.env['PATH'] ?? ''}`
  process.env['XDG_STATE_HOME'] = state
  t.after(() => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
  const dir = repo(t)
  const lines: string[] = []
  const beforeCwd = process.cwd()
  const [log, error] = [console.log, console.error]
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  console.error = () => {}
  try {
    process.chdir(dir)
    const code = await main([front, 'a goal', '--advisor', 'fake-lead', '--implementer', 'fake-impl', '--rounds', '2'], {
      registry: fakeRegistry(),
      input: new PassThrough(),
      output: new Writable({
        write(chunk, _enc, cb) {
          for (const l of String(chunk).split('\n')) lines.push(l)
          cb()
        },
      }),
    })
    return { code, lines }
  } finally {
    process.chdir(beforeCwd)
    console.log = log
    console.error = error
  }
}

for (const front of ['relay', 'session'] as const) {
  test(`${front}: a garbage record does not fail a real run, which says this is its first`, async (t) => {
    const state = tempDir(t, 'conclave-install-notice-state')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(state, 'conclave'), { recursive: true })
    writeFileSync(join(state, 'conclave', 'install-launch.json'), '{"build": ')
    const r = await realRun(t, front, state)
    assert.equal(r.code, 0, `the run must succeed:\n${plain(r.lines).join('\n')}`)
    const notice = noticeLines(r.lines)
    assert.equal(notice.length, 1, `one line:\n${plain(r.lines).join('\n')}`)
    assert.ok(notice[0]!.includes(BUILD), `names the real build: ${notice[0]}`)
    assert.match(notice[0]!, /no earlier launch is recorded/)
    // And the garbage was replaced with a record of this launch.
    const record = JSON.parse(readFileSync(join(state, 'conclave', 'install-launch.json'), 'utf8'))
    assert.equal(record.build, BUILD)
    assert.equal(record.root, join(BIN, '..', '..'))
  })

  test(`${front}: a record of another install makes a real run say the install moved`, async (t) => {
    const state = tempDir(t, 'conclave-install-notice-state')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(state, 'conclave'), { recursive: true })
    writeFileSync(join(state, 'conclave', 'install-launch.json'), JSON.stringify(PREVIOUS))
    const r = await realRun(t, front, state)
    assert.equal(r.code, 0)
    const notice = noticeLines(r.lines)
    assert.equal(notice.length, 2, `two lines:\n${plain(r.lines).join('\n')}`)
    assert.match(notice[0]!, /install moved: 0\.5\.61 \(1111111\) → /)
    assert.ok(notice[0]!.endsWith(BUILD))
  })
}
