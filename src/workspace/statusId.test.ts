/**
 * `status` honours a session id wherever it sits among the flags (#359).
 *
 * In a project with one recorded session `real-run`:
 *
 *     $ conclave status nope --json     -> "no session \"nope\" in this project", exit 1
 *     $ conclave status --json nope     -> { "id": "real-run", ... },            exit 0
 *
 * The second spelling dropped the id silently and answered for the most recent session.
 * `events` had the identical line and it was fixed under #350, because with a wait behind
 * it a dropped id meant waiting on a typo. `status` has no wait, so the failure is quieter:
 * a script asking `status --json <id>` in a loop gets the wrong session's state and nothing
 * says so. The two commands now share one reader of the positional id.
 *
 * Driven through the real CLI: what broke was argv parsing in the command, which no test
 * of `resolveSession` reaches.
 *
 *   node --test src/workspace/statusId.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import { SessionRecorder } from './sessionRecord.ts'
import type { SessionStatus } from './sessionRecord.ts'

const CLI = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')

function project(t: TestContext): string {
  const dir = tempDir(t, 'status-id')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

/** A record written by the real writer. The pid is this test's, so the run reads as alive. */
function record(dir: string, id: string, startedAt: number, pid: number = process.pid): SessionRecorder {
  return new SessionRecorder(dir, {
    id,
    pid,
    cwd: dir,
    goal: `goal of ${id}`,
    front: 'session',
    operator: 'agent',
    state: 'running',
    startedAt,
    messages: 0,
    participants: [],
    build: 'test-build',
  })
}

function status(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, 'status', ...args], { cwd, encoding: 'utf8' })
  if (r.error) throw r.error
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

test('#359 status --json <id> describes the named session, not the newest', (t) => {
  const dir = project(t)
  record(dir, 'older-run', 1_700_000_000_000)
  record(dir, 'newest-run', 1_700_000_100_000)
  for (const args of [
    ['--json', 'older-run'],
    ['older-run', '--json'],
    ['--json', 'older'],
  ]) {
    const r = status(dir, ...args)
    assert.equal(r.status, 0, `status ${args.join(' ')}: ${r.stderr}`)
    const parsed = JSON.parse(r.stdout) as { id: string }
    assert.equal(parsed.id, 'older-run', `status ${args.join(' ')} must describe the named session`)
  }
})

test('#359 status --json <typo> is refused, on either side of the flag', (t) => {
  // The failure the issue shows: the id after `--json` was never seen, so a typo was answered
  // with the newest session's state and exit 0.
  const dir = project(t)
  record(dir, 'real-run', 1_700_000_000_000)
  for (const args of [
    ['--json', 'nope'],
    ['nope', '--json'],
  ]) {
    const r = status(dir, ...args)
    assert.equal(r.status, 1, `status ${args.join(' ')} must refuse`)
    const parsed = JSON.parse(r.stdout) as { state: unknown; session: unknown; error: string }
    assert.equal(parsed.state, null, `status ${args.join(' ')}: no state for a session that does not exist`)
    assert.match(parsed.error, /no session "nope" in this project/, `status ${args.join(' ')}`)
  }
})

test('#359 the human form sees the id after the flag too', (t) => {
  const dir = project(t)
  record(dir, 'older-run', 1_700_000_000_000)
  record(dir, 'newest-run', 1_700_000_100_000)
  const named = status(dir, 'older-run')
  assert.equal(named.status, 0, named.stderr)
  assert.match(named.stdout, /older-run/)
  assert.doesNotMatch(named.stdout, /newest-run/)
  const typo = status(dir, 'nope')
  assert.equal(typo.status, 1)
  assert.match(typo.stderr, /conclave: no session "nope" in this project/)
})

/** Far above any pid the OS hands out, so `alive()` reads it as gone. */
const DEAD_PID = 2 ** 30

/** A seat stopped on a permission prompt, which is what puts `blocked.participant` on the record. */
function blockedSeat(id: string): SessionStatus['participants'][number] {
  return {
    id,
    agent: 'claude',
    rank: 'advisor',
    role: 'advisor',
    launch: { args: [], model: null },
    turns: [],
    awaitingPermission: { tool: 'Bash', since: 1_700_000_050_000 },
  }
}

type StatusJson = { id: string; state: string; skippedEndedSession?: string; blocked?: { participant?: string } }

test('status with no id describes the newest run not yet ended, not a newer ended one', (t) => {
  // The defect: a run blocked on a prompt, and a newer run that has ended. No-id `status`
  // answered with the ended one, while `sessions` listed both correctly.
  const dir = project(t)
  record(dir, 'older-live', 1_700_000_000_000)
  record(dir, 'newer-ended', 1_700_000_100_000).update({ state: 'ended' })
  const r = status(dir, '--json')
  assert.equal(r.status, 0, r.stderr)
  const parsed = JSON.parse(r.stdout) as StatusJson
  assert.equal(parsed.id, 'older-live')
  assert.equal(parsed.state, 'running')
  assert.equal(parsed.skippedEndedSession, 'newer-ended', 'the passed-over newest record must be named')
})

test('status with no id picks the NEWEST of several runs not yet ended', (t) => {
  const dir = project(t)
  record(dir, 'oldest-live', 1_700_000_000_000)
  record(dir, 'middle-live', 1_700_000_050_000)
  record(dir, 'newest-ended', 1_700_000_100_000).update({ state: 'ended' })
  const parsed = JSON.parse(status(dir, '--json').stdout) as StatusJson
  assert.equal(parsed.id, 'middle-live')
  assert.equal(parsed.skippedEndedSession, 'newest-ended')
})

test('nothing skipped: no skippedEndedSession key and no note', (t) => {
  // The newest run is the one not yet ended, so the answer is the one it always was, and saying
  // anything about it would be noise an operator learns to ignore.
  const dir = project(t)
  record(dir, 'older-ended', 1_700_000_000_000).update({ state: 'ended' })
  record(dir, 'newest-live', 1_700_000_100_000)
  const json = status(dir, '--json')
  const parsed = JSON.parse(json.stdout) as StatusJson
  assert.equal(parsed.id, 'newest-live')
  assert.equal('skippedEndedSession' in parsed, false)
  const human = status(dir)
  assert.equal(human.status, 0, human.stderr)
  assert.doesNotMatch(human.stdout, /note:/)
  assert.doesNotMatch(human.stdout, /older-ended/)
})

test('the human form says which newer session it passed over', (t) => {
  const dir = project(t)
  record(dir, 'older-live', 1_700_000_000_000)
  record(dir, 'newer-ended', 1_700_000_100_000).update({ state: 'ended' })
  const r = status(dir)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /note: the newest session, newer-ended, has ended; showing older-live\./)
  assert.match(r.stdout, /session older-live/)
})

test('every run ended: no id still means the newest, and nothing is skipped', (t) => {
  const dir = project(t)
  record(dir, 'older-ended', 1_700_000_000_000).update({ state: 'ended' })
  record(dir, 'newest-ended', 1_700_000_100_000).update({ state: 'ended' })
  const parsed = JSON.parse(status(dir, '--json').stdout) as StatusJson
  assert.equal(parsed.id, 'newest-ended')
  assert.equal(parsed.state, 'ended')
  assert.equal('skippedEndedSession' in parsed, false)
})

test('an abandoned older run is chosen over a newer ended one, and still exits 1', (t) => {
  // Eligibility is the record's word alone: an abandoned run says `running`, so it is not
  // ended. It is the run an operator most needs to see, and the exit code says it did not finish.
  const dir = project(t)
  record(dir, 'crashed-run', 1_700_000_000_000, DEAD_PID)
  record(dir, 'newer-ended', 1_700_000_100_000).update({ state: 'ended' })
  const r = status(dir, '--json')
  assert.equal(r.status, 1, 'an abandoned run keeps its exit code')
  const parsed = JSON.parse(r.stdout) as StatusJson & { abandoned: boolean }
  assert.equal(parsed.id, 'crashed-run')
  assert.equal(parsed.abandoned, true)
  assert.equal(parsed.skippedEndedSession, 'newer-ended')
})

test('an explicit id naming an ended session still describes it, with no skip note', (t) => {
  const dir = project(t)
  record(dir, 'older-live', 1_700_000_000_000)
  record(dir, 'newer-ended', 1_700_000_100_000).update({ state: 'ended' })
  const parsed = JSON.parse(status(dir, '--json', 'newer-ended').stdout) as StatusJson
  assert.equal(parsed.id, 'newer-ended')
  assert.equal(parsed.state, 'ended')
  assert.equal('skippedEndedSession' in parsed, false)
  const human = status(dir, 'newer-ended')
  assert.doesNotMatch(human.stdout, /note:/)
})

test('the README /allow recipe reads the blocked seat of the run not yet ended', (t) => {
  // README: WHO=$(conclave status --json | jq -r .blocked.participant). With a newer ended run
  // beside it, this read `null` and the prompt went unanswered.
  const dir = project(t)
  record(dir, 'older-live', 1_700_000_000_000).update({ participants: [blockedSeat('advisor')] })
  record(dir, 'newer-ended', 1_700_000_100_000).update({ state: 'ended' })
  const parsed = JSON.parse(status(dir, '--json').stdout) as StatusJson
  assert.equal(parsed.blocked?.participant, 'advisor')
})
