/**
 * `status --json` answers in JSON even when the answer is "there is nothing" (#233).
 *
 * The window is small -- between launching a detached session and its record being written -- and
 * it is exactly when a driver starts polling, so it is hit on the first attempt rather than
 * rarely. What used to happen there was nothing at all on stdout:
 *
 *     until [ "$(conclave status --json | jq -r .state)" != running ]; do sleep 5; done
 *
 * read an empty string on its first pass and exited immediately, which is indistinguishable from
 * a run that finished. An operator wrote that wait, watched it return instantly, and concluded
 * the session had ended. `json.load` raises `JSONDecodeError` on the same input.
 *
 * `sessions --json` answers `[]` in the same window, so the two commands disagreed about one
 * condition while both taking `--json`.
 *
 * Driven through the real CLI rather than the formatter: what broke was the ORDER of two branches
 * in the command -- the refusal returned before `--json` was ever consulted -- and a test of the
 * formatter would have passed throughout.
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'

const CLI = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')

/** A git repo with no session ever recorded in it: the window this issue is about. */
function emptyProject(t: TestContext): string {
  const dir = tempDir(t, 'status-json')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

function status(cwd: string, ...flags: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, 'status', ...flags], { cwd, encoding: 'utf8' })
  if (r.error) throw r.error
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

test('#233 status --json parses when no session has been recorded', (t) => {
  const dir = emptyProject(t)
  const r = status(dir, '--json')

  // The whole point: this must not throw. `JSON.parse` here is the test.
  const parsed = JSON.parse(r.stdout) as Record<string, unknown>
  assert.equal(parsed['state'], null, 'no session means no state, said in JSON rather than by silence')
  assert.equal(parsed['session'], null)
  assert.match(String(parsed['error']), /no sessions have been recorded/)
})

test('#233 the exit code still says the condition, so a script gating on it still gates', (t) => {
  // Unchanged deliberately. The fix is that the OUTPUT is parseable, not that the command starts
  // claiming success -- a caller that checks the status code must keep working.
  const dir = emptyProject(t)
  assert.equal(status(dir, '--json').status, 1)
  assert.equal(status(dir).status, 1, 'and the human form is unchanged too')
})

test('#233 under --json the message goes to stdout as data, not to stderr as prose', (t) => {
  // Both streams asserted, because the original defect was precisely that the message existed
  // and was on the wrong one. stdout carried nothing a parser could use.
  const dir = emptyProject(t)
  const r = status(dir, '--json')
  assert.equal(r.stderr, '', 'nothing on stderr when JSON was asked for')
  assert.ok(r.stdout.length > 0, 'and the answer is on stdout')
})

test('#233 without --json the human message is unchanged, on stderr', (t) => {
  const dir = emptyProject(t)
  const r = status(dir)
  assert.match(r.stderr, /conclave: no sessions have been recorded in this project/)
  assert.equal(r.stdout, '', 'the human form writes no stdout')
})

test('#233 status --json and sessions --json now agree about an empty project', (t) => {
  // The disagreement is how the reporter found it: one command answered `[]` and the other
  // answered nothing, in the same window, both taking `--json`.
  const dir = emptyProject(t)
  const sessions = spawnSync(process.execPath, [CLI, 'sessions', '--json'], { cwd: dir, encoding: 'utf8' })
  assert.deepEqual(JSON.parse(sessions.stdout), [], 'sessions --json answered [] all along')
  assert.doesNotThrow(() => JSON.parse(status(dir, '--json').stdout), 'and status --json answers too')
})
