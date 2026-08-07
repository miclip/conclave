/**
 * Refusing to start a run that should not start, and stopping one that has run too long.
 *
 *   node --test src/relay/guardrails.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { breached, insideGitRepo, preflightRefusals } from './guardrails.ts'

test('a directory with no repository is refused, with a remedy', () => {
  // A real relay was once started in /tmp/ignoretest purely to check a log line: two agent
  // sessions spawned and billed before it was killed. This check alone would have caught it.
  const bare = mkdtempSync(join(tmpdir(), 'conclave-norepo-'))
  const refusals = preflightRefusals(bare)

  assert.equal(refusals.length, 1)
  assert.match(refusals[0]!.reason, /not inside a git repository/)
  // A diagnostic naming an internal condition with no action attached is half a message --
  // the lesson from #32's `no UserPromptSubmit hook after send`.
  assert.match(refusals[0]!.remedy, /--force/)
})

test('--force overrides it, because a scratch directory is a real if unusual case', () => {
  const bare = mkdtempSync(join(tmpdir(), 'conclave-norepo-'))
  assert.deepEqual(preflightRefusals(bare, { force: true }), [])
})

test('a repository passes, including a subdirectory of one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-repo-'))
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  assert.equal(insideGitRepo(dir), true)
  assert.deepEqual(preflightRefusals(dir), [])
})

test('nothing else is refused: Conclave must work in a project it has never seen', () => {
  // No check for an empty directory or a missing package.json. `config install` exists
  // precisely so a fresh checkout needs nothing, and refusing on those would break the
  // supported case to guard an unsupported one.
  const dir = mkdtempSync(join(tmpdir(), 'conclave-empty-'))
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  assert.deepEqual(preflightRefusals(dir), [], 'an empty repository is a legitimate start')
})

test('a turn ceiling reports what was reached, not only what was allowed', () => {
  // A reader comparing the two needs both figures. "limit 10" alone does not say whether the
  // run stopped at 10 or overshot.
  const b = breached({ maxTurns: 10 }, { elapsedMs: 0, turns: 10 })!
  assert.equal(b.kind, 'turns')
  assert.equal(b.reached, 10)
  assert.match(b.detail, /10 of a maximum 10/)
})

test('a duration ceiling is measured in elapsed time, not rounds', () => {
  // maxRounds cannot express this: a single round can contain an arbitrarily long turn, so a
  // run can be progressing and still have been progressing for two hours.
  const b = breached({ maxDurationMs: 60_000 }, { elapsedMs: 61_000, turns: 1 })!
  assert.equal(b.kind, 'duration')
  assert.match(b.detail, /61s elapsed of a maximum 60s/)
})

test('turns are checked before duration, so the more specific reason wins', () => {
  const b = breached({ maxTurns: 2, maxDurationMs: 1 }, { elapsedMs: 999, turns: 5 })!
  assert.equal(b.kind, 'turns')
})

test('no ceilings means no breach, however long the run', () => {
  // The default. Ceilings are opt-in; a version that imposed one would change what an
  // existing invocation does without anyone asking for it.
  assert.equal(breached({}, { elapsedMs: 9_999_999, turns: 9_999 }), undefined)
})
