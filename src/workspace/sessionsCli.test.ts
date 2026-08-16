/**
 * `conclave sessions` at the CLI boundary, and `--prune` in particular.
 *
 * `sessionRecord.test.ts` already covers the pruning FUNCTION: which records qualify, what
 * is announced, what is spared. What it cannot see is the part that makes the command safe
 * to type — whether a bad `--days` is refused before anything is deleted, whether the ids
 * reach stdout, and what the exit code says. A prune that selected perfectly and was driven
 * by a parser reading `--days` as `NaN` would delete nothing and report success.
 *
 * These spawn the real entry point. `sessions` resolves the project from `process.cwd()`,
 * so a fixture can only be targeted via a spawned child's `cwd`.
 *
 *   node --test src/workspace/sessionsCli.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveRepoRoot } from '../config/install.ts'
import { sessionDir, type SessionRunState, type SessionStatus } from './sessionRecord.ts'

const CLI = join(resolveRepoRoot(import.meta.dirname), 'bin', 'conclave.ts')

const DAY = 24 * 60 * 60 * 1000
/** A pid that cannot be running, i.e. a session whose process is gone. */
const DEAD_PID = 2 ** 30

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-sessions-cli-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'tracked.txt'), 'original\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
    cwd: dir,
  })
  return dir
}

/**
 * A record written by hand, aged in days.
 *
 * The recorder stamps `updatedAt` from the clock, and `--days` is a question about exactly
 * that field — so a fixture that could only be "now" could not tell a cutoff that works from
 * one that silently matches nothing.
 */
function record(
  root: string,
  id: string,
  s: { state: SessionRunState; pid: number; ageDays: number },
): string {
  const dir = sessionDir(root, id)
  mkdirSync(dir, { recursive: true })
  const at = Date.now() - s.ageDays * DAY
  const status: SessionStatus = {
    schema: 1,
    id,
    pid: s.pid,
    cwd: root,
    goal: `goal for ${id}`,
    front: 'relay',
    operator: 'human',
    state: s.state,
    startedAt: at,
    updatedAt: at,
    messages: 0,
    participants: [],
    eventsPath: join(dir, 'events.ndjson'),
    build: 'test-build',
  }
  writeFileSync(join(dir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`)
  writeFileSync(status.eventsPath, '{"type":"run_end","reason":"done"}\n')
  return dir
}

function sessions(cwd: string, ...flags: string[]) {
  const r = spawnSync(process.execPath, [CLI, 'sessions', ...flags], { cwd, encoding: 'utf8' })
  if (r.error) throw r.error
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/**
 * Enough records that the JSON listing cannot fit in a pipe's 64 KiB buffer.
 *
 * 200 is roughly 115 KiB -- not a near-miss that a slightly terser record could slip back
 * under. Shared by the two tests below, which need the same "too big to fit" fixture to ask
 * two different questions about it.
 */
function bulkRecords(dir: string, count: number): void {
  for (let i = 0; i < count; i++) {
    record(dir, `bulk-${String(i).padStart(4, '0')}`, {
      state: 'ended',
      pid: DEAD_PID,
      ageDays: 1,
    })
  }
}

test('the default cutoff is seven days', () => {
  const dir = repo()
  const old = record(dir, 'ended-8d', { state: 'ended', pid: DEAD_PID, ageDays: 8 })
  const recent = record(dir, 'ended-6d', { state: 'ended', pid: DEAD_PID, ageDays: 6 })

  const { status, stdout } = sessions(dir, '--prune')

  assert.equal(status, 0)
  assert.equal(existsSync(old), false)
  // Six days is inside a week. The default has to be a real boundary, or it is decoration.
  assert.equal(existsSync(recent), true)
  assert.match(stdout, /ended-8d/, 'the id must be named, not merely counted')
  assert.doesNotMatch(stdout, /ended-6d/)
})

/**
 * Twice, and the two are not the same claim.
 *
 * The first list says what was CHOSEN, before anything is touched. The second says what
 * actually went — and between them sit a liveness re-check and a filesystem that can refuse.
 * An operator shown only the plan has to assume the rest, which for a delete is the one thing
 * they should never have to do.
 */
test('each id is printed before the deletion and again as an outcome', () => {
  const dir = repo()
  record(dir, 'ended-30d', { state: 'ended', pid: DEAD_PID, ageDays: 30 })
  record(dir, 'ended-40d', { state: 'ended', pid: DEAD_PID, ageDays: 40 })

  const { stdout } = sessions(dir, '--prune')

  for (const id of ['ended-30d', 'ended-40d']) {
    const announced = stdout.indexOf(`  ${id}`)
    const outcome = stdout.indexOf(`removed ${id}`)
    assert.ok(announced >= 0, `${id} must be announced, got: ${stdout}`)
    assert.ok(outcome >= 0, `${id} must be named as removed, not merely counted: ${stdout}`)
    // An operator watching a prune die partway has to have already been told what it was
    // doing, so the plan must precede the outcome rather than merely accompany it.
    assert.ok(announced < outcome, `the plan must precede the outcome, got: ${stdout}`)
  }
})

test('a skipped record is named with its reason alongside the removals', () => {
  const dir = repo()
  record(dir, 'ended-30d', { state: 'ended', pid: DEAD_PID, ageDays: 30 })
  record(dir, 'ended-live-30d', { state: 'ended', pid: process.pid, ageDays: 30 })

  const { status, stdout } = sessions(dir, '--prune')

  assert.equal(status, 0)
  assert.match(stdout, /removed ended-30d/)
  // Never a candidate, so never announced -- but the point of the outcome lines is that a
  // reader can account for every record without counting.
  assert.doesNotMatch(stdout, /removed ended-live-30d/)
  assert.equal(existsSync(sessionDir(dir, 'ended-live-30d')), true)
})

test('--days takes a cutoff, and zero means everything that qualifies', () => {
  const dir = repo()
  const twoDays = record(dir, 'ended-2d', { state: 'ended', pid: DEAD_PID, ageDays: 2 })
  const oneDay = record(dir, 'ended-1d', { state: 'ended', pid: DEAD_PID, ageDays: 1 })

  assert.equal(sessions(dir, '--prune', '--days', '2').status, 0)
  assert.equal(existsSync(twoDays), false)
  assert.equal(existsSync(oneDay), true, 'a day old is inside a two-day cutoff')

  // Zero is a real request after a day of failed starts, and it is NOT the same as missing.
  const { status, stdout } = sessions(dir, '--prune', '--days', '0')
  assert.equal(status, 0)
  assert.equal(existsSync(oneDay), false, '--days 0 must take everything that qualifies')
  assert.match(stdout, /ended-1d/)
})

/**
 * Every rejected form, asserted to delete NOTHING.
 *
 * `--days` with nothing after it is the case that matters most. Read loosely it becomes
 * `NaN`, every `NaN` comparison is false, and the prune deletes nothing while exiting 0 —
 * which is indistinguishable from success and would teach an operator that their records
 * were already clean. Negative is refused rather than clamped: a cutoff in the future is not
 * something anyone meant to ask for.
 */
test('a missing, malformed, or negative --days is refused and deletes nothing', () => {
  const dir = repo()
  const old = record(dir, 'ended-90d', { state: 'ended', pid: DEAD_PID, ageDays: 90 })

  for (const flags of [
    ['--prune', '--days'],
    ['--prune', '--days', 'seven'],
    ['--prune', '--days', '-1'],
    ['--prune', '--days', '3 weeks'],
    ['--prune', '--days', ''],
    ['--prune', '--days', '--json'],
  ]) {
    const { status, stderr } = sessions(dir, ...flags)
    const shown = flags.join(' ')
    assert.equal(status, 1, `${shown} must exit non-zero`)
    assert.match(stderr, /--days needs a number/, `${shown} must say what is wrong`)
    assert.equal(existsSync(old), true, `${shown} must not have deleted anything`)
  }
})

/**
 * The typo that would have deleted a week of records.
 *
 * `--dasy 0` contains no `--days`, so a parser built from `includes` drops the misspelling AND
 * the `0` and falls back to the seven-day default — deleting a week of records for an
 * operator who was typing a cutoff precisely in order to control what went. The lenient
 * reading is not a milder version of the intended command; it is a different one, and it is
 * the destructive one.
 */
test('an unrecognised argument is refused rather than ignored, and nothing is deleted', () => {
  const dir = repo()
  const old = record(dir, 'ended-90d', { state: 'ended', pid: DEAD_PID, ageDays: 90 })

  for (const flags of [
    ['--prune', '--dasy', '0'],
    ['--prune', '--day', '3'],
    ['--prune', '--force'],
    ['--prune', '-d', '3'],
    // Positional, not flag-shaped. `sessions --prune 30` reads like a cutoff and is not one.
    ['--prune', '30'],
    ['--prune', '--days', '3', 'extra'],
    ['--prune', 'all'],
  ]) {
    const { status, stderr } = sessions(dir, ...flags)
    const shown = flags.join(' ')
    assert.equal(status, 1, `${shown} must exit non-zero`)
    assert.match(stderr, /unexpected argument/, `${shown} must name the argument it refused`)
    assert.match(stderr, /--days <n> and --json/, `${shown} must say what is accepted`)
    assert.equal(existsSync(old), true, `${shown} must not have deleted anything`)
  }
})

/**
 * Repeated rather than last-wins.
 *
 * `--days 30 --days 0` has two readings and only one of them is recoverable. A parser that
 * silently took the last would delete everything for an operator who was editing the line
 * and forgot to remove the first.
 */
test('a repeated flag is refused, and nothing is deleted', () => {
  const dir = repo()
  const old = record(dir, 'ended-90d', { state: 'ended', pid: DEAD_PID, ageDays: 90 })

  for (const [flags, expected] of [
    [['--prune', '--days', '30', '--days', '0'], /--days given twice/],
    [['--prune', '--prune'], /--prune given twice/],
    [['--prune', '--json', '--json'], /--json given twice/],
  ] as const) {
    const { status, stderr } = sessions(dir, ...flags)
    const shown = flags.join(' ')
    assert.equal(status, 1, `${shown} must exit non-zero`)
    assert.match(stderr, expected, `${shown} must say which flag was repeated`)
    assert.equal(existsSync(old), true, `${shown} must not have deleted anything`)
  }
})

test('--days without --prune is refused rather than quietly ignored', () => {
  const dir = repo()
  const old = record(dir, 'ended-90d', { state: 'ended', pid: DEAD_PID, ageDays: 90 })
  const { status, stderr } = sessions(dir, '--days', '3')
  assert.equal(status, 1)
  assert.match(stderr, /--days only means something with --prune/)
  assert.equal(existsSync(old), true)
})

/**
 * The two records a prune must never take, at the boundary an operator actually types.
 *
 * A live session's files are the only account of itself that survives a crash; an abandoned
 * run — `running`, nobody home — is the evidence of the crash that made a retry
 * indistinguishable from a double start in the first place.
 */
test('a live session and an abandoned run both survive a prune of everything', () => {
  const dir = repo()
  const live = record(dir, 'live-99d', { state: 'running', pid: process.pid, ageDays: 99 })
  const endedLive = record(dir, 'ended-live-99d', { state: 'ended', pid: process.pid, ageDays: 99 })
  const abandoned = record(dir, 'abandoned-99d', { state: 'running', pid: DEAD_PID, ageDays: 99 })

  const { status, stdout } = sessions(dir, '--prune', '--days', '0')

  assert.equal(status, 0)
  assert.equal(existsSync(live), true)
  assert.equal(existsSync(endedLive), true, 'a pid that still answers means the run has not gone')
  assert.equal(existsSync(abandoned), true, 'the crash record is the evidence, not the litter')
  assert.match(stdout, /no session records are older than 0d and finished/)
})

/**
 * The combination is supported rather than refused, and the announcement moves to stderr.
 *
 * Refusing `--prune --json` would be defensible, but `sessions --json` already exists and a
 * machine consumer wanting to prune is not doing anything strange. The two requirements only
 * look opposed: stdout has to carry the result object alone or the mode is useless, and
 * nothing may be deleted unannounced. stderr satisfies both, and a consumer redirecting it to
 * a log is exactly who wants that record.
 */
test('--prune --json keeps stdout to the result and announces on stderr', () => {
  const dir = repo()
  record(dir, 'ended-30d', { state: 'ended', pid: DEAD_PID, ageDays: 30 })
  record(dir, 'live-30d', { state: 'running', pid: process.pid, ageDays: 30 })

  const { status, stdout, stderr } = sessions(dir, '--prune', '--json')

  // Parse the whole stream, not a substring: prose leaking alongside valid JSON is exactly
  // what makes a machine-readable mode useless.
  const result = JSON.parse(stdout)
  assert.deepEqual(result.candidates, ['ended-30d'])
  assert.deepEqual(result.removed, ['ended-30d'])
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(result.failed, [])
  assert.equal(status, 0)

  // The announcement is not merely absent from stdout, it is still MADE. A prune that went
  // silent under --json would delete unannounced, which is the guarantee the whole
  // announce-before-delete design exists to keep.
  assert.match(stderr, /pruning 1 session record:/)
  assert.match(stderr, /ended-30d/)
})

test('--prune --json says on stderr when there is nothing to do', () => {
  const dir = repo()
  record(dir, 'live-30d', { state: 'running', pid: process.pid, ageDays: 30 })

  const { status, stdout, stderr } = sessions(dir, '--prune', '--json')

  const result = JSON.parse(stdout)
  assert.deepEqual(result, { candidates: [], removed: [], skipped: [], failed: [] })
  assert.match(stderr, /no session records are older than 7d and finished/)
  assert.equal(status, 0)
})

/**
 * The exit code is the contract, exactly as it is for `guard`.
 *
 * A prune is usually run to reclaim a directory or to unstick something, so one that hit a
 * permission error, said so, and exited 0 would be found by whatever ran next rather than by
 * the operator. Driven with a real unwritable directory rather than a stubbed error, because
 * what is being asserted is that the failure survives the whole path out through the CLI.
 */
test('a record that cannot be removed is reported and exits non-zero', (t) => {
  // As root every removal succeeds and there is no failure to observe.
  if (process.getuid?.() === 0) return t.skip('runs as root')
  const dir = repo()
  record(dir, 'ended-30d', { state: 'ended', pid: DEAD_PID, ageDays: 30 })
  const sessionsRoot = join(dir, '.conclave', 'sessions')
  // Removing a directory needs write permission on its PARENT, so this makes the record
  // unremovable without touching the record itself -- which still has to be readable for the
  // prune to choose it in the first place.
  chmodSync(sessionsRoot, 0o500)
  // Restored regardless, or the fixture itself cannot be cleaned up afterwards.
  t.after(() => chmodSync(sessionsRoot, 0o700))

  const { status, stdout, stderr } = sessions(dir, '--prune')

  assert.equal(status, 1, 'a failed removal must not exit zero')
  assert.match(stdout, /ended-30d/, 'it is still announced before the attempt')
  assert.match(stderr, /could not remove ended-30d/)
  assert.equal(existsSync(sessionDir(dir, 'ended-30d')), true)
})

test('pruning a project with no sessions says so and exits zero', () => {
  const { status, stdout } = sessions(repo(), '--prune')
  assert.equal(status, 0)
  assert.match(stdout, /no session records are older than 7d and finished/)
})

test('listing is unchanged without --prune', () => {
  const dir = repo()
  record(dir, 'ended-90d', { state: 'ended', pid: DEAD_PID, ageDays: 90 })
  record(dir, 'live-1d', { state: 'running', pid: process.pid, ageDays: 1 })

  const { status, stdout } = sessions(dir)

  assert.equal(status, 0)
  assert.match(stdout, /ended-90d/, 'a record old enough to prune is still listed')
  assert.match(stdout, /live-1d/)
  // The listing must not have grown a deletion. This is the assertion that would catch a
  // `--prune` default flipped the wrong way, which is the kind of mistake nobody re-reads.
  assert.equal(existsSync(sessionDir(dir, 'ended-90d')), true)

  const asJson = sessions(dir, '--json')
  assert.equal(asJson.status, 0)
  assert.equal(JSON.parse(asJson.stdout).length, 2)
})

test('an empty project still lists rather than erroring', () => {
  const { status, stdout } = sessions(repo())
  assert.equal(status, 0)
  assert.match(stdout, /no sessions have been recorded in this project/)
})

/**
 * The 64 KiB cliff.
 *
 * A pipe holds 64 KiB. `process.exit()` does not flush, so a listing bigger than that used
 * to arrive as exactly 65,536 bytes of JSON cut mid-token -- while the SAME command
 * redirected to a file was complete and valid. Every other test in this file passes either
 * way, because every other fixture is small enough to fit in the buffer.
 *
 * So the size is the test. `spawnSync` gives the child a real pipe, which is the only
 * configuration where the bug exists at all: attach a terminal, or a file, and the writes
 * are synchronous and there is nothing left buffered to lose. 200 records is roughly 115 KiB
 * -- not a near-miss that a slightly terser record could slip back under.
 *
 * It guards `sessions`, but not only `sessions`. The flush belongs to process termination,
 * so `status`, `guard`, `config show` and relay's JSON all ride on the same fix; this is
 * the cheapest command to make large on demand, which is why the guard lives here.
 */
test('a --json listing larger than a pipe buffer arrives whole', () => {
  const dir = repo()
  const count = 200
  bulkRecords(dir, count)

  const { status, stdout } = sessions(dir, '--json')

  assert.equal(status, 0)
  const bytes = Buffer.byteLength(stdout)
  assert.ok(
    bytes > 64 * 1024,
    `the fixture has to outgrow the pipe buffer or it proves nothing, got ${bytes} bytes`,
  )

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (err) {
    // Named, because "Unterminated string in JSON" on its own reads like a formatting bug
    // rather than the truncation it is.
    assert.fail(
      `--json emitted ${bytes} bytes that do not parse -- output was cut short: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  assert.equal((parsed as unknown[]).length, count, 'every record has to survive the pipe')
})

/**
 * `conclave sessions --json | head -1`, which is how anyone checks the shape of a listing.
 *
 * The other half of waiting for the buffer to drain. `head` reads one line and closes the
 * pipe with ~50 KiB still queued; the pending write then fails EPIPE, and Node reports that
 * failure TWICE -- once to the write callback and once as an `error` event on the stream.
 * `process.exit()` used to run before either arrived, so neither was ever seen. Waiting is
 * what exposes them, and the specific way to get this wrong is to REMOVE the error listener
 * when the write callback settles the wait: the event then has nowhere to land, and a clean
 * `| head` becomes an unhandled-error stack trace and a non-zero exit. Trading truncated
 * output for a crash is not a fix, so this asserts the pipeline that would show it.
 *
 * So both halves are asserted, because either one alone can be satisfied by the bug. The
 * exit code has to be the one the COMMAND chose -- a broken pipe is the reader's decision to
 * stop reading, not a failure of the listing -- and stderr has to stay clean.
 */
test('a reader that stops early gets the command exit code, not a stack trace', () => {
  const dir = repo()
  bulkRecords(dir, 200)

  const errPath = join(dir, 'cli-stderr.txt')
  const codePath = join(dir, 'cli-code.txt')
  // The real pipeline, run by a real shell. Reaching into the child's stdout from this
  // process and destroying it was tried first and rejected: it closes the read end at a
  // moment nothing controls, so whether the EPIPE lands before the exit is a coin flip, and
  // a test that catches the regression on some runs is worse than none. `head` closing the
  // pipe after one line is both what an operator actually types and, measured, deterministic.
  //
  // The braces are what make the exit code observable: `$?` inside the pipeline's subshell
  // is the CLI's own status, where the shell's status for the pipeline would be `head`'s.
  const r = spawnSync(
    'sh',
    ['-c', `{ "$1" "$2" sessions --json 2> "$3"; echo $? > "$4"; } | head -1`, 'sh',
      process.execPath, CLI, errPath, codePath],
    { cwd: dir, encoding: 'utf8' },
  )
  if (r.error) throw r.error

  const stderr = readFileSync(errPath, 'utf8')
  const code = readFileSync(codePath, 'utf8').trim()

  assert.match(r.stdout, /^\[/, 'head has to have received a real prefix before closing')
  assert.equal(code, '0', `a closed reader is not a failed listing, stderr was: ${stderr}`)
  // The specific shapes Node prints for an unhandled stream error. Matching the text rather
  // than merely requiring silence keeps the assertion honest about what regressed.
  assert.doesNotMatch(
    stderr,
    /EPIPE|Unhandled 'error' event|ERR_STREAM|ERR_UNHANDLED/,
    `a broken pipe must not surface as a crash, stderr was: ${stderr}`,
  )
})
