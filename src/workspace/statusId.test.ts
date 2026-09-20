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

const CLI = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')

function project(t: TestContext): string {
  const dir = tempDir(t, 'status-id')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

/** A record written by the real writer. The pid is this test's, so the run reads as alive. */
function record(dir: string, id: string, startedAt: number): SessionRecorder {
  return new SessionRecorder(dir, {
    id,
    pid: process.pid,
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

test('#359 status with no id still means the most recent, whatever its state', (t) => {
  // Preserved. `events --follow` with no id now skips ended runs (#360); `status` does not,
  // because the run an operator asks after is the latest one, finished or not.
  const dir = project(t)
  record(dir, 'older-run', 1_700_000_000_000)
  record(dir, 'newest-run', 1_700_000_100_000).update({ state: 'ended' })
  const r = status(dir, '--json')
  assert.equal(r.status, 0, r.stderr)
  const parsed = JSON.parse(r.stdout) as { id: string; state: string }
  assert.equal(parsed.id, 'newest-run')
  assert.equal(parsed.state, 'ended')
})
