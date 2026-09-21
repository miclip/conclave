/**
 * `events --follow` survives the startup window instead of losing the race to it (#350).
 *
 * The help and the operator skill teach a two-line start:
 *
 *     conclave session "<goal>" --operator agent < ctl &
 *     conclave events --follow > events.ndjson &
 *
 * and a first run in a project spends ten seconds or more registering hooks and clearing
 * trust prompts before it records anything. The follower used to answer "no sessions have
 * been recorded" and exit in that window, and the operator was left tailing a file that
 * would never grow -- silence from a dead follower being indistinguishable from silence from
 * a busy run. There are two gaps, not one: the record lands when the run registers and the
 * events file when the first event is appended, and a follower can attach between them too.
 *
 * And the other half (#360): in a project that already HAS sessions, "the newest" during
 * the startup window is the previous run, which has ended. The follower drained its stream,
 * saw `ended`, and exited 0 -- the same dead follower, with a plausible-looking file full of
 * the last run's events as the only clue. So no id under --follow is the newest session that
 * is still going, and the wait covers an all-ended project as well as an empty one.
 *
 * Driven as a child process, because the point is what the process DOES while nothing is
 * there yet: the test writes the record underneath a follower that is already waiting.
 * The record is written by the real writer, so what the follower finds is what a run leaves.
 *
 *   node --test src/workspace/eventsFollow.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import { SessionRecorder } from './sessionRecord.ts'

const CLI = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')

/** A git repo with no session ever recorded in it: the window the issue is about. */
function emptyProject(t: TestContext): string {
  const dir = tempDir(t, 'events-follow')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

/**
 * A live run's record, written by the real writer. The pid is this test's, so the run reads
 * as alive for as long as the test does -- an abandoned record ends a follow on its own,
 * which is the right behaviour and not the one under test.
 */
function record(
  dir: string,
  id: string,
  startedAt = 1_700_000_000_000,
  { pid = process.pid }: { pid?: number } = {},
): SessionRecorder {
  return new SessionRecorder(dir, {
    id,
    pid,
    cwd: dir,
    goal: 'follow me',
    front: 'session',
    operator: 'agent',
    state: 'running',
    startedAt,
    messages: 0,
    participants: [],
    build: 'test-build',
  })
}

/** One line on the stream, shaped as the recorder writes it: the file is the interface. */
function event(rec: SessionRecorder, seq: number): string {
  const line = JSON.stringify({
    seq,
    at: 1_700_000_000_000 + seq,
    type: 'message',
    from: 'advisor',
    text: `${rec.id} line ${seq}`,
  })
  appendFileSync(rec.eventsPath, `${line}\n`)
  return line
}

interface Follower {
  child: ChildProcess
  out: () => string
  err: () => string
  exit: Promise<number | null>
}

function events(cwd: string, ...args: string[]): Follower {
  const child = spawn(process.execPath, [CLI, 'events', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout!.setEncoding('utf8').on('data', (d: string) => void (out += d))
  child.stderr!.setEncoding('utf8').on('data', (d: string) => void (err += d))
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  return { child, out: () => out, err: () => err, exit }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll until `cond` holds, or fail naming what never happened. Generous: CI is slow. */
async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

/** A follower still going after a real pause -- a definite claim, not the absence of an exit. */
/**
 * Wait until the follower has SAID something, rather than looking once and hoping.
 *
 * `stillRunning` proves the process did not exit; it says nothing about whether the process has
 * got round to writing yet. Asserting on `err()` straight after it read an empty string on a
 * loaded runner and passed everywhere faster -- a test of the machine, not of the message. The
 * timeout is generous because it bounds a FAILURE: when the line is coming this returns as soon
 * as it arrives, and when it is not coming the test should fail slowly rather than flakily.
 */
async function said(f: Follower, re: RegExp, ms = 10_000): Promise<void> {
  const until = Date.now() + ms
  for (;;) {
    if (re.test(f.err())) return
    if (Date.now() > until) {
      assert.match(f.err(), re)
      return
    }
    await sleep(50)
  }
}

async function stillRunning(f: Follower, ms = 1_000): Promise<void> {
  const raced = await Promise.race([f.exit.then(() => 'exited' as const), sleep(ms).then(() => 'running' as const)])
  assert.equal(raced, 'running', `the follower exited early: ${f.err()}`)
}

test('#350 events --follow with no id waits for the first session instead of exiting', async (t) => {
  const dir = emptyProject(t)
  const f = events(dir, '--follow')
  t.after(() => f.child.kill())

  // The old behaviour was exit 1 inside a few hundred milliseconds. A full second with the
  // process still there is the wait.
  await stillRunning(f)
  await said(f, /no session is under way in this project — waiting for one to start\. Ctrl-C to stop/)
  assert.equal(f.out(), '', 'nothing on stdout while there is nothing to stream')

  // The run registers underneath the waiting follower, then writes its first event.
  const rec = record(dir, 'first-run')
  const line = event(rec, 1)
  await until(() => f.out().includes(line), 'the first event to reach the follower')

  // And the follow is the ordinary follow from here: it ends when the session does.
  rec.update({ state: 'ended' })
  assert.equal(await f.exit, 0)
  assert.deepEqual(f.out().trim().split('\n'), [line])
})

test('#350 the waiting state is said once, not every poll', async (t) => {
  const dir = emptyProject(t)
  const f = events(dir, '--follow')
  t.after(() => f.child.kill())
  await stillRunning(f, 1_200)
  // Four polls' worth of quiet at least. A line per look would have made the stderr a
  // second stream to drown in.
  assert.equal(f.err().match(/waiting for one to start/g)?.length, 1, f.err())
})

test('#350 events --follow waits for the events file once the record exists', async (t) => {
  // The second gap: a record with no events yet. Without --follow this is "no events
  // recorded", exit 1, and a follower used to get the same answer for a run seconds away
  // from its first line.
  const dir = emptyProject(t)
  const rec = record(dir, 'registered')
  const f = events(dir, '--follow')
  t.after(() => f.child.kill())

  await stillRunning(f)
  await said(f, /registered has recorded no events yet — waiting for its first\. Ctrl-C to stop/)
  assert.doesNotMatch(f.err(), /no session is under way/, 'the record was found; only the file is awaited')

  const line = event(rec, 1)
  await until(() => f.out().includes(line), 'the first event to reach the follower')
  rec.update({ state: 'ended' })
  assert.equal(await f.exit, 0)
})

test('#350 a run that ends before its first event gets the non-follow answer, exit 1', async (t) => {
  // The events-file wait is bounded by the run ending, and a run that ended with an empty
  // stream recorded no events: saying so and exiting 1 is what the non-follow form does, and
  // exiting 0 here would claim the stream was empty by design.
  const dir = emptyProject(t)
  const rec = record(dir, 'stillborn')
  const f = events(dir, '--follow')
  t.after(() => f.child.kill())
  await until(() => /waiting for its first/.test(f.err()), 'the follower to start waiting')
  rec.update({ state: 'ended' })
  assert.equal(await f.exit, 1)
  await said(f, /conclave: no events recorded for stillborn/)
  assert.equal(f.out(), '')
})

test('#350 an explicit id that names no session fails at once, on either side of --follow', async (t) => {
  // The wait is for a session that has yet to start. A NAMED session that does not exist is
  // a typo, and waiting on a typo is a process that never ends. Both spellings, because the
  // parser used to see an id only before the flag -- `events --follow <typo>` silently
  // followed the newest session, and with the wait in place it would have waited forever.
  const dir = emptyProject(t)
  record(dir, 'the-real-one').update({ state: 'ended' })
  for (const args of [
    ['--follow', 'nope'],
    ['nope', '--follow'],
    ['-f', 'nope'],
  ]) {
    const f = events(dir, ...args)
    t.after(() => f.child.kill())
    assert.equal(await f.exit, 1, `events ${args.join(' ')} must refuse`)
    await said(f, /conclave: no session "nope" in this project/)
    assert.doesNotMatch(f.err(), /waiting/, `events ${args.join(' ')} must not wait`)
  }
})

test('#350 events --follow <id> for a resolved session waits for its events file too', async (t) => {
  // The rule is resolved against unresolvable, not named against unnamed. An id that
  // resolved is a real session, and the wait for its first event is bounded by that session
  // ending; the typo hazard lives at the resolve step and was answered there. This is the
  // command `--detach` prints as its next step, and it is printed in exactly this window.
  const dir = emptyProject(t)
  // One session per spelling: the first event written creates the file, and a second
  // follower on the same session would have nothing left to wait for.
  for (const [id, args] of [
    ['named-a', ['--follow', 'named-a']],
    ['named-b', ['named-b', '--follow']],
  ] as const) {
    const rec = record(dir, id)
    const f = events(dir, ...args)
    t.after(() => f.child.kill())
    await stillRunning(f)
    await said(f, new RegExp(`${id} has recorded no events yet — waiting for its first\\. Ctrl-C to stop`))
    assert.equal(f.out(), '', `events ${args.join(' ')}: nothing on stdout while there is nothing to stream`)
    const line = event(rec, 1)
    await until(() => f.out().includes(line), 'the first event to reach the follower')
    assert.deepEqual(f.out().trim().split('\n'), [line], `events ${args.join(' ')} streams NDJSON only`)
    f.child.kill()
  }
})

test('#350 an explicit id in an empty project fails at once too', async (t) => {
  // Same rule, emptier project: the id was typed, so the answer is about the id.
  const dir = emptyProject(t)
  const f = events(dir, '--follow', 'nope')
  t.after(() => f.child.kill())
  assert.equal(await f.exit, 1)
  await said(f, /conclave: no sessions have been recorded in this project/)
  assert.doesNotMatch(f.err(), /waiting/)
})

test('#350 events --follow <id> follows the named session, not the newest', async (t) => {
  // The parser half of the fix, on the positive side: the id after `--follow` is honoured.
  const dir = emptyProject(t)
  const older = record(dir, 'older-run', 1_700_000_000_000)
  const newer = record(dir, 'newer-run', 1_700_000_100_000)
  const wanted = event(older, 1)
  const notWanted = event(newer, 1)
  older.update({ state: 'ended' })
  newer.update({ state: 'ended' })
  for (const args of [
    ['--follow', 'older-run'],
    ['older-run', '--follow'],
    ['--follow', 'older'],
  ]) {
    const f = events(dir, ...args)
    t.after(() => f.child.kill())
    assert.equal(await f.exit, 0, `events ${args.join(' ')}: ${f.err()}`)
    assert.equal(f.out().trim(), wanted, `events ${args.join(' ')} must stream the named session`)
    assert.ok(!f.out().includes(notWanted))
  }
})

test('#350 without --follow nothing waits: the refusals are unchanged', async (t) => {
  // Preserved deliberately. A one-shot `events` is a poll, and an empty answer from a poll is
  // obviously an empty answer; the wait belongs to following alone.
  const dir = emptyProject(t)
  const empty = events(dir)
  t.after(() => empty.child.kill())
  assert.equal(await empty.exit, 1)
  await said(empty, /conclave: no sessions have been recorded in this project/)
  assert.doesNotMatch(empty.err(), /waiting/)

  record(dir, 'quiet')
  const noEvents = events(dir)
  t.after(() => noEvents.child.kill())
  assert.equal(await noEvents.exit, 1)
  await said(noEvents, /conclave: no events recorded for quiet/)
  assert.doesNotMatch(noEvents.err(), /waiting/)
})

/** A pid that cannot be running: a record still saying `running` whose process is gone. */
const DEAD_PID = 2 ** 30

test('#360 events --follow with no id skips an ended previous run and waits for the next', async (t) => {
  // The documented two-line start, in a project that has run before. The newest record is
  // the previous run, ended; the follower used to drain it and exit 0 inside a few hundred
  // milliseconds, with the old run's events on stdout as if they were the new run's.
  const dir = emptyProject(t)
  const previous = record(dir, 'previous-run', 1_700_000_000_000)
  const stale = event(previous, 1)
  previous.update({ state: 'ended' })

  const f = events(dir, '--follow')
  t.after(() => f.child.kill())
  await stillRunning(f)
  assert.equal(f.out(), '', 'the ended run is not what was asked for: nothing of it is streamed')
  // The same notice an empty project gets: what is awaited is the same thing in both.
  await said(f, /no session is under way in this project — waiting for one to start\. Ctrl-C to stop/)
  assert.doesNotMatch(f.err(), /no sessions have been recorded/, 'a project with an ended run is not empty, and is not told it is')

  // The new run registers underneath the waiting follower. Its startedAt is later, as a real
  // run's would be, so it is the newest as well as the only one still going.
  const next = record(dir, 'next-run', 1_700_000_100_000)
  const line = event(next, 1)
  await until(() => f.out().includes(line), 'the new run\'s first event to reach the follower')
  next.update({ state: 'ended' })
  assert.equal(await f.exit, 0)
  assert.deepEqual(f.out().trim().split('\n'), [line])
  assert.ok(!f.out().includes(stale), 'the previous run\'s stream never appears')
})

test('#360 an abandoned previous run is skipped too: a follow of it would end at its first look', async (t) => {
  // `running` with nobody home is what `streamEvents` stops on, so attaching to it is the
  // same exit 0 by another door. Not ended and not abandoned is the condition, and it is
  // the one the tail itself uses.
  const dir = emptyProject(t)
  const crashed = record(dir, 'crashed-run', 1_700_000_000_000, { pid: DEAD_PID })
  const stale = event(crashed, 1)

  const f = events(dir, '--follow')
  t.after(() => f.child.kill())
  await stillRunning(f)
  assert.equal(f.out(), '')
  await said(f, /no session is under way in this project — waiting for one to start/)

  const next = record(dir, 'next-run', 1_700_000_100_000)
  const line = event(next, 1)
  await until(() => f.out().includes(line), 'the new run\'s first event to reach the follower')
  f.child.kill()
  assert.ok(!f.out().includes(stale))
})

test('#360 with no id the newest session still going is chosen, even when an ended one is newer', async (t) => {
  // Two records: a going run, and a NEWER one that has ended. "Newest" alone picks the ended
  // one; "newest still going" picks the run. The shape is a quick second run that finished
  // while a longer first one is still up.
  const dir = emptyProject(t)
  const going = record(dir, 'long-run', 1_700_000_000_000)
  const wanted = event(going, 1)
  const quick = record(dir, 'quick-run', 1_700_000_100_000)
  const notWanted = event(quick, 1)
  quick.update({ state: 'ended' })

  const f = events(dir, '--follow')
  t.after(() => f.child.kill())
  await until(() => f.out().includes(wanted), 'the going run\'s event to reach the follower')
  await stillRunning(f)
  assert.doesNotMatch(f.err(), /waiting for one to start/, 'a session is under way; nothing was waited for')
  assert.ok(!f.out().includes(notWanted), 'the ended run, though newer, is not the one followed')
  going.update({ state: 'ended' })
  assert.equal(await f.exit, 0)
})

test('#360 an explicit id still follows an ended session: the operator named it', async (t) => {
  // Preserved. The still-going rule is for what NO id means; a named session is what was
  // asked for whatever its state, and following an ended one is the one-shot read it
  // always was, exit 0.
  const dir = emptyProject(t)
  const done = record(dir, 'done-run')
  const line = event(done, 1)
  done.update({ state: 'ended' })
  for (const args of [
    ['--follow', 'done-run'],
    ['done-run', '--follow'],
  ]) {
    const f = events(dir, ...args)
    t.after(() => f.child.kill())
    assert.equal(await f.exit, 0, `events ${args.join(' ')}: ${f.err()}`)
    assert.equal(f.out().trim(), line, `events ${args.join(' ')} streams the named session`)
    assert.doesNotMatch(f.err(), /waiting for one to start/, `events ${args.join(' ')} must not wait`)
  }
})

test('#360 one-shot events with no id still reads the newest session, ended or not', async (t) => {
  // Preserved. Without --follow a poll of an ended run is a poll of an ended run: the
  // still-going rule belongs to following alone, where an ended run is a dead follower.
  const dir = emptyProject(t)
  const older = record(dir, 'older-run', 1_700_000_000_000)
  event(older, 1)
  const newest = record(dir, 'newest-run', 1_700_000_100_000)
  const line = event(newest, 1)
  newest.update({ state: 'ended' })
  const f = events(dir)
  t.after(() => f.child.kill())
  assert.equal(await f.exit, 0, f.err())
  assert.equal(f.out().trim(), line, 'the newest, though ended, is what a one-shot read describes')
  assert.doesNotMatch(f.err(), /waiting/)
})
