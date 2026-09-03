/**
 * Refusing to start a run that should not start, and stopping one that has run too long.
 *
 *   node --test src/relay/guardrails.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import {
  breached,
  ceilingSummary,
  ceilingsFrom,
  DISK_FLOOR_BYTES,
  DISK_WARN_BYTES,
  effectiveCeilings,
  freeBytes,
  insideGitRepo,
  outOfSpace,
  preflightRefusals,
  preflightWarnings,
  spaceRefusal,
  spaceWarning,
  type CeilingState,
} from './guardrails.ts'

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

test('a directory with no repository is refused, with a remedy', (t) => {
  // A real relay was once started in /tmp/ignoretest purely to check a log line: two agent
  // sessions spawned and billed before it was killed. This check alone would have caught it.
  const bare = tempDir(t, 'conclave-norepo')
  const refusals = preflightRefusals(bare)

  assert.equal(refusals.length, 1)
  assert.match(refusals[0]!.reason, /not inside a git repository/)
  // A diagnostic naming an internal condition with no action attached is half a message --
  // the lesson from #32's `no UserPromptSubmit hook after send`.
  assert.match(refusals[0]!.remedy, /--force/)
})

test('--force overrides it, because a scratch directory is a real if unusual case', (t) => {
  const bare = tempDir(t, 'conclave-norepo')
  assert.deepEqual(preflightRefusals(bare, { force: true }), [])
})

test('a repository passes, including a subdirectory of one', (t) => {
  const dir = tempDir(t, 'conclave-repo')
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  assert.equal(insideGitRepo(dir), true)
  assert.deepEqual(preflightRefusals(dir), [])
})

test('nothing else is refused: Conclave must work in a project it has never seen', (t) => {
  // No check for an empty directory or a missing package.json. `config install` exists
  // precisely so a fresh checkout needs nothing, and refusing on those would break the
  // supported case to guard an unsupported one.
  const dir = tempDir(t, 'conclave-empty')
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  assert.deepEqual(preflightRefusals(dir), [], 'an empty repository is a legitimate start')
})

test('a volume with no room to finish on is refused, with a remedy', () => {
  // #180: a run died on a full volume having never asked whether there was room. The floor is
  // where a run is CERTAIN not to finish, not where the next write would fail -- a run is a
  // worktree per seat plus a transcript that grows for as long as it lasts.
  const r = spaceRefusal('/w', DISK_FLOOR_BYTES - 1)
  assert.ok(r, 'below the floor refuses')
  assert.match(r.reason, /free on the volume holding \/w/)
  // A diagnostic naming an internal condition with no action attached is half a message.
  assert.match(r.remedy, /--force/)
})

test('exactly at the floor is not refused: the boundary is spent, not reached', () => {
  // A consumable ceiling breaches on `>=`; this is the opposite kind of number. The floor is
  // the amount that must REMAIN, so having exactly it is having enough.
  assert.equal(spaceRefusal('/w', DISK_FLOOR_BYTES), undefined)
})

test('an unreadable volume refuses nothing, because a guard that cannot see must not block', () => {
  // `statfs` is not available on every platform Node runs on. Returning 0 for an unavailable
  // reading would make an unsupported platform look exactly like a full one and would block
  // every run on it -- which is why `freeBytes` distinguishes `undefined` from 0.
  assert.equal(spaceRefusal('/w', undefined), undefined)
  assert.equal(spaceWarning('/w', undefined), undefined)
})

test('--force overrides the disk floor, because the reading is evidence and not proof', (t) => {
  const dir = tempDir(t, 'conclave-disk')
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  // Real volume, so this asserts the wiring rather than the threshold: the operator who forces
  // has been told the number and has decided.
  assert.deepEqual(preflightRefusals(dir, { force: true }), [])
})

test('the band above the floor warns and does not refuse', () => {
  // The two are exclusive by construction, so one reading cannot produce both a refusal and a
  // softer restatement of it.
  const free = DISK_FLOOR_BYTES + 1
  assert.equal(spaceRefusal('/w', free), undefined, 'above the floor is not refused')
  const w = spaceWarning('/w', free)
  assert.ok(w, 'but it is said out loud')
  assert.match(w.remedy, /cheaper than losing the run partway/)
})

test('a volume with room produces neither a refusal nor a warning', () => {
  assert.equal(spaceRefusal('/w', DISK_WARN_BYTES), undefined)
  assert.equal(spaceWarning('/w', DISK_WARN_BYTES), undefined, 'the warning band ends at the threshold')
})

test('the real reading is a positive number here, and undefined for a path that is not there', () => {
  const here = freeBytes(process.cwd())
  assert.equal(typeof here, 'number')
  assert.ok((here as number) > 0)
  assert.equal(freeBytes('/nonexistent-conclave-180'), undefined, 'unreadable is undefined, not 0')
  // What the live preflight says is checked for CONSISTENCY with the reading, not against a
  // fixed expectation. `assert.deepEqual(preflightWarnings(cwd), [])` stood here, and it
  // asserts that whichever machine runs this suite happens to have more than DISK_WARN_BYTES
  // free -- an assertion about the environment wearing the clothes of one about the code,
  // which is the #179 shape exactly. A tight CI runner would have failed it for being tight.
  const banded = here !== undefined && here >= DISK_FLOOR_BYTES && here < DISK_WARN_BYTES
  assert.equal(preflightWarnings(process.cwd()).length, banded ? 1 : 0)
})

test('a full volume is recognised through the wrapping that hides it', () => {
  // The whole reason #180 surfaced as a stack dump: by the time a full disk reaches a caller it
  // has been wrapped, and the `code` naming the condition is on the innermost error.
  const inner = Object.assign(new Error('write failed'), { code: 'ENOSPC' })
  assert.equal(outOfSpace(inner), true, 'the bare error')
  assert.equal(outOfSpace(new Error('transcript', { cause: inner })), true, 'wrapped once')
  assert.equal(
    outOfSpace(new Error('run', { cause: new Error('transcript', { cause: inner }) })),
    true,
    'wrapped twice',
  )
  // An exhausted quota is a full volume from the run's point of view, with the same remedy.
  assert.equal(outOfSpace(Object.assign(new Error('q'), { code: 'EDQUOT' })), true)
})

test('an unrelated failure is not mistaken for a full volume, and a cause cycle terminates', () => {
  // The catch rethrows anything that is not this condition: swallowing unrelated bugs there
  // would hide exactly the failures a stack trace is the right answer for.
  assert.equal(outOfSpace(Object.assign(new Error('nope'), { code: 'ENOENT' })), false)
  assert.equal(outOfSpace(new Error('plain')), false)
  assert.equal(outOfSpace(undefined), false)
  // `cause` is an ordinary property and can point back at an error already seen. A cycle here
  // would hang the one path whose whole job is to fail cleanly.
  const a = new Error('a')
  const b = new Error('b', { cause: a })
  ;(a as { cause?: unknown }).cause = b
  assert.equal(outOfSpace(a), false, 'terminates rather than hanging')
})

test('the floor is wired into the preflight, not merely defined beside it', (t) => {
  // Without this, every threshold test above would still pass with the check never called --
  // a guard that looks configured and does nothing, which is the worst failure a guard has.
  const dir = tempDir(t, 'conclave-disk-wired')
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  const refusals = preflightRefusals(dir, { readFree: () => DISK_FLOOR_BYTES - 1 })
  assert.equal(refusals.length, 1)
  assert.match(refusals[0]!.reason, /free on the volume/)
  // And --force still reaches past it, with the same reading underneath.
  assert.deepEqual(preflightRefusals(dir, { force: true, readFree: () => 0 }), [])
})

test('the warning band is wired in too, and stays non-fatal', (t) => {
  const dir = tempDir(t, 'conclave-disk-warn')
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  const free = DISK_FLOOR_BYTES + 1
  assert.equal(preflightWarnings(dir, { readFree: () => free }).length, 1)
  // The same reading that warns must not also refuse: a warning the caller treats as fatal is
  // the failure this separation exists to prevent.
  assert.deepEqual(preflightRefusals(dir, { readFree: () => free }), [])
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
  assert.match(b.detail, /61s of active run time of a maximum 60s/)
  // And the line says which clock that was. Since #112 the reading handed in here is net of
  // every interval the run spent paused, so a detail that said "elapsed" would be inviting the
  // reader to check it against a wall clock that will not agree. What is counted and what is
  // not is decided by `Relay#ceilingState`; saying so is this module's half.
  assert.match(b.detail, /time paused for an operator is not counted/)
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

// ---------------------------------------------------------------------------------------
// Reporting them, which is a different job from configuring them (#119).
// ---------------------------------------------------------------------------------------

test('effectiveCeilings says null for every limit nobody set, and never omits one', () => {
  // The inverse of `ceilingsFrom` above, and the inversion is the point: absent must stay
  // behaviourless in the CONFIGURATION and must be spelled out in the REPORT. A run whose
  // operator cannot tell "no limit" from "this build does not report limits" is #119, and it
  // is #103 one field over -- that reporter read a missing key as `false`.
  assert.deepEqual(effectiveCeilings({ advisorTurns: 8 }), {
    advisorTurns: 8,
    maxTurns: null,
    maxDurationMs: null,
    maxQueueDepth: null,
    maxConcurrentSeats: null,
  })
  // And a `Ceilings` that limits nothing is still a report with every key. `ceilingsFrom`
  // never produces this, but `RelayOptions.ceilings` can be set by hand.
  assert.deepEqual(effectiveCeilings({ advisorTurns: 8, ceilings: {} }), {
    advisorTurns: 8,
    maxTurns: null,
    maxDurationMs: null,
    maxQueueDepth: null,
    maxConcurrentSeats: null,
  })
})

test('effectiveCeilings carries every configured limit through unchanged', () => {
  // Each field named separately rather than in one object, because a report that dropped one
  // -- or read `maxQueueDepth` where `maxConcurrentSeats` was meant -- would still pass a
  // single all-fields case if the values happened to be equal. They are not, here.
  assert.deepEqual(
    effectiveCeilings({
      advisorTurns: 40,
      ceilings: { maxTurns: 9, maxDurationMs: 120_000, maxQueueDepth: 3, maxConcurrentSeats: 4 },
    }),
    { advisorTurns: 40, maxTurns: 9, maxDurationMs: 120_000, maxQueueDepth: 3, maxConcurrentSeats: 4 },
  )
  // Zero is a real setting on both gauges (see `a zero gauge is a real setting` above), so it
  // must survive the report as `0` and not fall through a `||` into `null`.
  assert.deepEqual(effectiveCeilings({ advisorTurns: 1, ceilings: { maxQueueDepth: 0, maxConcurrentSeats: 0 } }), {
    advisorTurns: 1,
    maxTurns: null,
    maxDurationMs: null,
    maxQueueDepth: 0,
    maxConcurrentSeats: 0,
  })
})

test('the summary names every ceiling by the flag that sets it, in minutes where the flag is minutes', () => {
  // The line #119 asks for, and the two halves it has to get right: the flag SPELLINGS, so an
  // operator can see that the number they raised is not the number that bounds the advisor;
  // and the unit, because `--max-minutes` goes in as minutes and is stored as milliseconds.
  assert.equal(
    ceilingSummary(effectiveCeilings({ advisorTurns: 8, ceilings: { maxTurns: 40, maxDurationMs: 120_000 } })),
    '--rounds 8 · --max-turns 40 · --max-minutes 2 · --max-queue-depth none · --max-concurrent-seats none',
  )
  // The unconfigured run, which is the one the issue was reported from: every ceiling still
  // named, four of them `none`, and the advisor budget -- the only thing actually bounding it
  // -- readable in the first three lines of the run.
  assert.equal(
    ceilingSummary(effectiveCeilings({ advisorTurns: 8 })),
    '--rounds 8 · --max-turns none · --max-minutes none · --max-queue-depth none · --max-concurrent-seats none',
  )
  // Not "round". The flag is `--rounds` and naming a flag is not naming the concept, but any
  // OTHER use of the word here would be the vocabulary advisorTurns.test.ts retired.
  assert.doesNotMatch(
    ceilingSummary(effectiveCeilings({ advisorTurns: 8 })).replace('--rounds', ''),
    /\bround/i,
  )
})
