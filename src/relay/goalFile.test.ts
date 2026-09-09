/**
 * `--goal-file`: the goal read out of a file, on both front-ends.
 *
 * An argv is not private. `ps` shows it to every account on the machine and the shell writes it
 * to a history file that outlives the run, and the goal is the whole brief -- issue text, file
 * paths, whatever context the operator pasted in. The flag is how that text stays out of both.
 *
 * Which is why the DETACHED case is not an extra: `relay --detach` re-executes the CLI as a
 * background child and builds the child's argv itself. Appending `-- <goal>` there would put
 * the text back into an argv -- the child's, for the whole life of the run -- after the
 * operator had chosen the form that keeps it out of the parent's, and no invocation could
 * prevent it. So the flag and its path are what is handed on, and the child reads the file.
 * That claim is proved against the argv of the REAL child process below, not against the array
 * the parent built: a recorder loaded through NODE_OPTIONS runs in every node this test starts,
 * writes that process's own `process.argv`, and the assertion is made over what it wrote.
 *
 *   node --test src/relay/goalFile.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import { main } from '../../bin/conclave.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { NO_DEADLINE_CLOCKS } from '../registry/types.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { tempDir } from '../testkit/tempDir.ts'
import { waitFor } from '../testkit/waitFor.ts'
import { listSessions } from '../workspace/sessionRecord.ts'

const BIN = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')

/** A scratch project. `relay` refuses to run outside a git repository. */
function repo(t: TestContext): string {
  const dir = tempDir(t, 'conclave-goal-file')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'work.ts'), 'export const a = 1\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

/**
 * Seats that exist and never start. Every case here stops at `--dry-run` or at a refusal, so a
 * regression that fell through to a real launch shows up as a `create` rather than as two agent
 * CLIs starting and real quota being spent.
 */
function fakeRegistry(created: string[]): AgentRegistry {
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
  text: string
  created: string[]
}

/** One invocation of the real CLI in a scratch project, with both streams captured. */
async function run(dir: string, argv: readonly string[]): Promise<Ran> {
  const said: string[] = []
  const created: string[] = []
  // The console writes through `output` in chunks rather than in lines, and it is accumulated
  // BYTE FOR BYTE rather than split and filtered. A capture that dropped empty lines would
  // erase exactly what this file is about: the blank line inside a multi-line goal, which the
  // parser is supposed to preserve and a line-filtering harness would hide either way.
  let written = ''
  const beforeCwd = process.cwd()
  const [log, error] = [console.log, console.error]
  console.log = (...a: unknown[]) => void said.push(a.map(String).join(' '))
  console.error = (...a: unknown[]) => void said.push(a.map(String).join(' '))
  try {
    process.chdir(dir)
    const code = await main([...argv], {
      registry: fakeRegistry(created),
      // Ended rather than merely empty: a regression that reached a live console would finish
      // on a closed stdin instead of hanging the suite.
      input: (() => {
        const s = new PassThrough()
        s.end()
        return s
      })(),
      output: new Writable({
        write(chunk, _e, cb) {
          written += String(chunk)
          cb()
        },
      }),
    })
    return { code, text: `${said.join('\n')}\n${written}`, created }
  } finally {
    process.chdir(beforeCwd)
    console.log = log
    console.error = error
  }
}

/**
 * A goal with the two properties an argv cannot carry comfortably: more than one line, and a
 * blank line between paragraphs. The trailing newline is the one an editor leaves behind.
 */
const MULTILINE =
  'Make the failing rotation test pass.\n' +
  '\n' +
  'Done means: `npm test` is green and the mutation audit shows the new assertion\n' +
  'failing when the guard it covers is broken.'

test('the goal is read out of the file whole, and both front-ends read the same goal', async (t) => {
  const dir = repo(t)
  const path = join(dir, 'goal.txt')
  writeFileSync(path, `${MULTILINE}\n`)

  const relay = await run(dir, ['relay', '--goal-file', path, '--advisor', 'fake-lead', '--implementer', 'fake-impl', '--dry-run'])
  const session = await run(dir, ['session', '--goal-file', path, '--advisor', 'fake-lead', '--implementer', 'fake-impl', '--dry-run'])

  for (const [front, ran] of [['relay', relay], ['session', session]] as const) {
    assert.equal(ran.code, 0, `${front} must plan the run rather than refuse it`)
    assert.deepEqual(ran.created, [], `${front} must start nothing`)
    // EVERY line of it, in order, and the interior blank line with them. A read that trimmed
    // per line, or stopped at the first newline, drops the acceptance criteria and leaves a
    // plausible-looking one-line goal behind -- which is the failure `lintGoal` exists for,
    // arrived at from the parser instead.
    assert.ok(
      ran.text.includes(MULTILINE),
      `${front} must carry the goal whole, blank line and all -- got:\n${ran.text}`,
    )
  }
  // The trailing newline the editor left is not part of anybody's ask. Asserted on the plan
  // line rather than on the goal, because `goal:` is the last field and a swallowed newline
  // would otherwise be invisible.
  assert.ok(
    !/failing when the guard it covers is broken\.\n\s*\n\s*$/.test(relay.text),
    'a trailing newline in the file must not survive into the goal',
  )
})

test('a goal given twice is refused on both front-ends, rather than one form winning', async (t) => {
  const dir = repo(t)
  const path = join(dir, 'goal.txt')
  writeFileSync(path, 'the goal in the file\n')

  for (const front of ['relay', 'session'] as const) {
    const ran = await run(dir, [front, 'the goal in the argument', '--goal-file', path, '--dry-run'])
    assert.equal(ran.code, 1, `${front} must refuse rather than pick one`)
    assert.match(ran.text, /the goal was given twice/, `${front} says what is wrong`)
    assert.match(ran.text, new RegExp(`--goal-file ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `${front} names the file`)
    // Neither form may reach the plan. A refusal that still described a run would be the
    // reading it refused to make, printed.
    assert.ok(!ran.text.includes('the goal in the file'), `${front} must not use the file's goal`)
    assert.ok(!/dry run — nothing was started/.test(ran.text), `${front} must not print a plan`)
    assert.deepEqual(ran.created, [], `${front} must start nothing`)
  }
})

test('a file that is not there, or cannot be read, is named along with why', async (t) => {
  const dir = repo(t)
  const missing = join(dir, 'no-such-goal.txt')
  const directory = join(dir, 'goals')
  mkdirSync(directory)

  for (const front of ['relay', 'session'] as const) {
    const gone = await run(dir, [front, '--goal-file', missing, '--dry-run'])
    assert.equal(gone.code, 1, `${front} must refuse a goal file that is not there`)
    assert.ok(gone.text.includes(missing), `${front} names the path it could not read`)
    // The system's own sentence, kept. ENOENT, EACCES and EISDIR are three different things to
    // fix, and "could not be read" flattens them into one.
    assert.match(gone.text, /ENOENT/, `${front} carries the reason rather than flattening it`)
    assert.ok(!/dry run — nothing was started/.test(gone.text), `${front} must not print a plan`)

    // A directory is the unreadable case that is not a typo: it opens, and the read fails.
    const dirRead = await run(dir, [front, '--goal-file', directory, '--dry-run'])
    assert.equal(dirRead.code, 1, `${front} must refuse a --goal-file that is a directory`)
    assert.ok(dirRead.text.includes(directory), `${front} names the path`)
    assert.match(dirRead.text, /EISDIR|illegal operation on a directory/, `${front} carries the reason`)
  }
})

test('a file with nothing in it is refused rather than run as an empty goal', async (t) => {
  const dir = repo(t)
  const empty = join(dir, 'empty.txt')
  // Whitespace, not zero bytes: a goal that never got written looks like this far more often
  // than it looks like an empty file, and both are the same mistake.
  writeFileSync(empty, '\n   \n\t\n')

  for (const front of ['relay', 'session'] as const) {
    const ran = await run(dir, [front, '--goal-file', empty, '--dry-run'])
    assert.equal(ran.code, 1, `${front} must refuse an empty goal file`)
    assert.match(ran.text, /is empty/, `${front} says the file is empty`)
    assert.ok(!/dry run — nothing was started/.test(ran.text), `${front} must not plan a run with no goal`)
    assert.deepEqual(ran.created, [], `${front} must start nothing`)
  }
})

test('--goal-file is parsed like every other valued flag, on both front-ends', async (t) => {
  const dir = repo(t)

  for (const front of ['relay', 'session'] as const) {
    // A value that went missing, refused by the shared reader before anything is read off disk.
    const bare = await run(dir, [front, '--goal-file', '--dry-run'])
    assert.equal(bare.code, 1, `${front} must refuse --goal-file without a value`)
    assert.match(bare.text, /--goal-file was given without a value/, `${front} names the flag`)

    // And the flag is on the surface: the refusal above is about the VALUE, not about the flag
    // being one nobody declared, which is what it used to be (#172).
    assert.ok(
      !/--goal-file is not a flag this command takes/.test(bare.text),
      `${front} must take --goal-file`,
    )
  }
})

test('relay still refuses a run with no goal in either form, and names both', async (t) => {
  const dir = repo(t)
  const ran = await run(dir, ['relay', '--dry-run'])
  assert.equal(ran.code, 1, 'relay cannot start without a goal')
  assert.match(ran.text, /relay needs a goal/)
  assert.match(ran.text, /--goal-file <path>/, 'and says both ways of giving one')
})

test('the console with no goal in either form still asks for one', async (t) => {
  // Unchanged behaviour, pinned here because `--goal-file` is a third way in and the refusal
  // above is a second: the console must still be startable with neither.
  const dir = repo(t)
  const ran = await run(dir, ['session', '--advisor', 'fake-lead', '--implementer', 'fake-impl', '--dry-run'])
  assert.equal(ran.code, 0)
  assert.match(ran.text, /goal:\s+would be asked for/)
})

/**
 * The argv of every node process this test starts, recorded by the processes themselves.
 *
 * `--import` through NODE_OPTIONS is inherited by children, and `relay --detach` spawns its
 * child with the environment it is running under -- so the detached child loads this too and
 * writes the argv it was actually given. That is the only way to read the child's argv without
 * racing its lifetime: it is a real `conclave relay` that refuses an unknown agent and exits,
 * and by the time anything outside could run `ps` it is gone.
 */
function recorder(box: string): { log: string; nodeOptions: string } {
  const log = join(box, 'argv.log')
  const file = join(box, 'record-argv.mjs')
  writeFileSync(
    file,
    `import { appendFileSync } from 'node:fs'\n` +
      // One line per process, tab-separated so a goal's own newlines cannot forge a line.
      `appendFileSync(${JSON.stringify(log)}, process.argv.join('\\t') + '\\n')\n`,
  )
  writeFileSync(log, '')
  return { log, nodeOptions: `--import ${pathToFileURL(file).href}` }
}

/** Start a detached relay out of `dir`, and return every argv that was recorded. */
async function detachedArgvs(
  dir: string,
  box: string,
  argv: readonly string[],
): Promise<string[]> {
  const { log, nodeOptions } = recorder(box)
  const driver = join(box, 'driver.mjs')
  writeFileSync(
    driver,
    `process.chdir(${JSON.stringify(dir)})\n` +
      `const { main } = await import(${JSON.stringify(pathToFileURL(BIN).href)})\n` +
      // Agents no registry knows, so the child refuses at resolution and ends itself rather
      // than starting a real session -- the containment the other detach tests use.
      `process.exit(await main(${JSON.stringify([...argv, '--advisor', 'fake-advisor', '--implementer', 'fake-impl'])}))\n`,
  )
  let child: number | undefined
  try {
    execFileSync(process.execPath, [driver], {
      cwd: dir,
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
    const sessions = listSessions(dir)
    assert.equal(sessions.length, 1, 'the parent must record the session it handed off')
    child = sessions[0]!.status.pid
    // Two processes: the driver, and the relay it detached. Waited for rather than slept on --
    // the child writes its line before it has finished starting, but not before it has started.
    await waitFor(() => readFileSync(log, 'utf8').split('\n').filter(Boolean).length >= 2, {
      within: 30_000,
      describe: 'the parent and the detached child to record their own argv',
    })
    return readFileSync(log, 'utf8').split('\n').filter(Boolean)
  } finally {
    if (child !== undefined) {
      try {
        process.kill(child, 'SIGKILL')
      } catch {
        // Already gone, which is the other legitimate ending.
      }
    }
  }
}

test('a detached run started with --goal-file keeps the goal out of both argvs', { timeout: 120_000 }, async (t) => {
  const dir = repo(t)
  const box = tempDir(t, 'conclave-goal-file-detach')
  const path = join(box, 'goal.txt')
  const SECRET = 'the brief that must not appear in any process argv'
  writeFileSync(path, `${SECRET}\n`)

  const argvs = await detachedArgvs(dir, box, ['relay', '--goal-file', path, '--detach'])

  // THE CLAIM. Neither the process the operator started nor the one it handed the run to
  // carries the goal, so `ps` on this machine never shows it.
  for (const line of argvs) {
    assert.ok(!line.includes(SECRET), `the goal must not appear in an argv, and did in:\n${line}`)
  }
  // THE OTHER HALF, without which the above is satisfied by losing the goal entirely: the
  // child was given the FORM, and it is the child -- the argv carrying `--detached-id`.
  const detached = argvs.filter((line) => line.includes('--detached-id'))
  assert.equal(detached.length, 1, `exactly one recorded process is the detached child:\n${argvs.join('\n')}`)
  const fields = detached[0]!.split('\t')
  assert.ok(fields.includes('--goal-file'), 'the child is given the flag')
  assert.ok(fields.includes(path), 'and the path, which it reads for itself')
  // And nothing was smuggled in behind the end-of-options marker either.
  assert.ok(!fields.includes('--'), 'a file-form run hands the child no positional goal at all')
})

test('a detached run started with a goal ARGUMENT still hands the child that goal', { timeout: 120_000 }, async (t) => {
  // The control, and the reason the test above cannot pass by accident: the child is given the
  // goal in the form the operator used. Deleting the append would satisfy the secrecy claim and
  // break every detached run started the ordinary way.
  const dir = repo(t)
  const box = tempDir(t, 'conclave-goal-arg-detach')
  const GOAL = 'keep the work moving'

  const argvs = await detachedArgvs(dir, box, ['relay', GOAL, '--detach'])

  const detached = argvs.filter((line) => line.includes('--detached-id'))
  assert.equal(detached.length, 1, `exactly one recorded process is the detached child:\n${argvs.join('\n')}`)
  const fields = detached[0]!.split('\t')
  assert.ok(fields.includes(GOAL), 'the child is given the goal it was started with')
  // After the marker, always: a goal beginning with a dash must reach the child as a goal.
  assert.equal(fields[fields.length - 2], '--', 'the goal comes after the end-of-options marker')
  assert.equal(fields[fields.length - 1], GOAL)
  assert.ok(!fields.includes('--goal-file'), 'and no file form it was never given')
})
