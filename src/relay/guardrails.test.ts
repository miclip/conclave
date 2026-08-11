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
import { breached, ceilingsFrom, insideGitRepo, preflightRefusals, type CeilingState } from './guardrails.ts'

/**
 * A reading with everything at rest, so each test names only the axis it is about.
 *
 * `CeilingState`'s fields are deliberately REQUIRED rather than optional-defaulting-to-zero.
 * A caller that forgets one would otherwise get a ceiling that silently never fires, which is
 * the worst failure available to a safety limit: it looks configured and does nothing.
 */
function at(over: Partial<CeilingState> = {}): CeilingState {
  return { elapsedMs: 0, turns: 0, queueDepth: 0, concurrentSeats: 0, ...over }
}

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
  const b = breached({ maxTurns: 10 }, at({ turns: 10 }))!
  assert.equal(b.kind, 'turns')
  assert.equal(b.reached, 10)
  assert.match(b.detail, /10 of a maximum 10/)
})

test('a duration ceiling is measured in elapsed time, not advisor turns', () => {
  // maxAdvisorTurns cannot express this: a single advisor turn can dispatch an arbitrarily long
  // turn, so a run can be progressing and still have been progressing for two hours.
  const b = breached({ maxDurationMs: 60_000 }, at({ elapsedMs: 61_000, turns: 1 }))!
  assert.equal(b.kind, 'duration')
  assert.match(b.detail, /61s elapsed of a maximum 60s/)
})

test('turns are checked before duration, so the more specific reason wins', () => {
  const b = breached({ maxTurns: 2, maxDurationMs: 1 }, at({ elapsedMs: 999, turns: 5 }))!
  assert.equal(b.kind, 'turns')
})

test('no ceilings means no breach, however long the run', () => {
  // The default. Ceilings are opt-in; a version that imposed one would change what an
  // existing invocation does without anyone asking for it.
  assert.equal(breached({}, at({ elapsedMs: 9_999_999, turns: 9_999, queueDepth: 99, concurrentSeats: 99 })), undefined)
})

// ---------------------------------------------------------------------------------------
// The two gauges. Unlike turns and duration these read what is outstanding RIGHT NOW, so
// they compare on `>` rather than `>=`: a run told to allow N must be allowed to reach N.
// ---------------------------------------------------------------------------------------

test('a queue ceiling fires above its number, and permits the number itself', () => {
  assert.equal(breached({ maxQueueDepth: 2 }, at({ queueDepth: 2 })), undefined, 'two waiting is what "maximum 2" permits')
  const b = breached({ maxQueueDepth: 2 }, at({ queueDepth: 3 }))!
  assert.equal(b.kind, 'queue_depth')
  assert.equal(b.limit, 2)
  assert.equal(b.reached, 3)
  assert.match(b.detail, /3 task\(s\) waiting for a seat, above a maximum of 2/)
})

test('a concurrency ceiling fires above its number, and permits the number itself', () => {
  assert.equal(breached({ maxConcurrentSeats: 2 }, at({ concurrentSeats: 2 })), undefined, 'two seats is what "maximum 2" permits')
  const b = breached({ maxConcurrentSeats: 2 }, at({ concurrentSeats: 5 }))!
  assert.equal(b.kind, 'concurrent_seats')
  assert.equal(b.limit, 2)
  assert.equal(b.reached, 5)
  assert.match(b.detail, /5 seat\(s\) working, above a maximum of 2/)
})

test('a zero gauge is a real setting, not an absent one', () => {
  // The distinction `?? 0` would destroy, and the reason `Ceilings` uses `!== undefined`
  // rather than a truthiness test: `maxQueueDepth: 0` means "never let work wait", which is
  // a coherent thing to ask for and must not read as "no ceiling configured".
  assert.equal(breached({ maxQueueDepth: 0 }, at({ queueDepth: 1 }))?.kind, 'queue_depth')
  assert.equal(breached({ maxConcurrentSeats: 0 }, at({ concurrentSeats: 1 }))?.kind, 'concurrent_seats')
  assert.equal(breached({ maxQueueDepth: 0 }, at({ queueDepth: 0 })), undefined)
})

test('each gauge ignores the other axis entirely', () => {
  // A deep queue with nothing running, and a busy fleet with an empty queue. Written because
  // the two readings are the pair most easily crossed by a copy-paste in `breached`.
  assert.equal(breached({ maxQueueDepth: 1 }, at({ concurrentSeats: 99 })), undefined)
  assert.equal(breached({ maxConcurrentSeats: 1 }, at({ queueDepth: 99 })), undefined)
})

test('ceilingsFrom returns undefined when no ceiling flag was given', () => {
  // Absent must stay behaviourless all the way down. `{}` would be an options object that
  // limits nothing but reads, in a status document, as though somebody configured one.
  assert.equal(ceilingsFrom({}), undefined)
  assert.equal(ceilingsFrom({ maxTurns: '', maxMinutes: '', maxQueueDepth: '', maxConcurrentSeats: '' }), undefined)
})

test('ceilingsFrom converts minutes to milliseconds and passes the rest through', () => {
  // The unit conversion is the part worth pinning: a missing factor of 60_000 is a ceiling
  // that fires immediately, and #36's watchdog shipped with exactly that class of bug.
  assert.deepEqual(ceilingsFrom({ maxMinutes: '2' }), { maxDurationMs: 120_000 })
  assert.deepEqual(ceilingsFrom({ maxTurns: '9' }), { maxTurns: 9 })
  assert.deepEqual(ceilingsFrom({ maxQueueDepth: '3' }), { maxQueueDepth: 3 })
  assert.deepEqual(ceilingsFrom({ maxConcurrentSeats: '4' }), { maxConcurrentSeats: 4 })
  assert.deepEqual(ceilingsFrom({ maxTurns: '9', maxMinutes: '2', maxQueueDepth: '3', maxConcurrentSeats: '4' }), {
    maxTurns: 9,
    maxDurationMs: 120_000,
    maxQueueDepth: 3,
    maxConcurrentSeats: 4,
  })
})
