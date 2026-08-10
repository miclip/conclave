#!/usr/bin/env node
/**
 * A deterministic stand-in for `opencode run --format json`, used to prove concurrency.
 *
 * NOT production code and not imported by any of it. It exists because the claim "two seats
 * work at the same time" cannot be proved with an in-process fake: a `FakeRotationSession`
 * shares this process's single thread, so two of them "overlapping" is a statement about
 * promise scheduling rather than about two agents running. This is a real executable, spawned
 * as a real child by the real adapter, reached through the two seams that already exist for
 * it -- `OpenCodeAdapterOptions.command`, documented as overridable so a test can point at a
 * stub, and PATH, which is how the built-in registry resolves `opencode`.
 *
 * ## The rendezvous, and why it is not a timing measurement
 *
 * Two children each write an entry file and then REFUSE TO FINISH until they can see the
 * other's. Overlap is therefore not inferred from durations, sleeps or clocks: if the seats
 * were launched one after the other, the first would wait for a sibling that has not started
 * and record `timeout`, and the proof fails. Nothing here says "A took longer than B", which
 * is the kind of evidence a loaded machine can invent or destroy.
 *
 * A third file, `release`, is what lets the test observe the overlapped state rather than
 * merely conclude it happened: while both children are blocked on it, the dispatcher's seat
 * table is standing still and can be read.
 *
 * ## What it emits
 *
 * The minimum `OpenCodeRunAdapter` needs for an observed completion: a `text` part carrying
 * the report, and `step_finish reason=stop`, which is the announced terminal signal the
 * adapter grades `completed (proven)` from. Exit 0 alone would grade `unknown_abnormal_end`,
 * so the fixture cannot accidentally pass by being silent.
 *
 * ## How it knows who it is
 *
 * From its own cwd, because that is the one thing the orchestrator gives a seat that differs
 * per seat: at N>1 every implementer is launched in `.conclave/worktrees/<run>/<seat-id>`.
 * Participant `args` would not do -- `--implementer-args` reaches every seat with the same
 * value -- and an environment variable would have to be set per child by something, which is
 * the production seam this fixture exists to avoid needing.
 *
 * Env: CONCLAVE_FIXTURE_DIR must name a writable directory OUTSIDE the repository under test.
 * Inside it, the entry files would be untracked work and the clean-base rule would refuse the
 * run.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, sep } from 'node:path'

/** Synchronous sleep. This process does one thing and blocking is the honest way to say so. */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const dir = process.env.CONCLAVE_FIXTURE_DIR
if (!dir) {
  process.stderr.write('opencodeFixture: CONCLAVE_FIXTURE_DIR is not set\n')
  process.exit(3)
}
mkdirSync(dir, { recursive: true })

/** Everything after the `--` separator the adapter puts before the prompt. */
const argv = process.argv.slice(2)
const at = argv.indexOf('--')
const prompt = at >= 0 ? argv.slice(at + 1).join(' ') : ''

/**
 * The seat this child is filling, or the advisor.
 *
 * The advisor works in the integration checkout, every implementer in its own linked
 * worktree, so the path segment is the discriminator and no configuration is needed.
 */
const cwd = process.cwd()
const marker = `${sep}.conclave${sep}worktrees${sep}`
const seat = cwd.includes(marker) ? basename(cwd) : 'advisor'

/** Which turn this is for this seat. One child per turn, so a read-modify-write cannot race. */
function nextTurn() {
  const path = join(dir, `turns-${seat}`)
  const n = (existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0) + 1
  writeFileSync(path, String(n))
  return n
}

/** Wait until a condition holds, and say whether it did. Bounded, so a failure is a failure. */
function waitFor(check, budgetMs) {
  const until = Date.now() + budgetMs
  while (Date.now() < until) {
    if (check()) return true
    sleep(25)
  }
  return false
}

function advisorReply(turn) {
  // Turn 1 is the briefing and the goal. Everything after it is a report coming back.
  //
  // The seat ids are the ones the orchestrator assigns at N=2 (`seatIdFor`), and they are
  // written out rather than discovered so this reply is a fixed string: an advisor that
  // enumerated the worktree directory would be reading the answer it is supposed to supply.
  if (turn === 1) {
    return (
      '@seat implementer: RENDEZVOUS, then report what you did.\n' +
      '@seat implementer-2: RENDEZVOUS, then report what you did.'
    )
  }
  return 'DONE'
}

function implementerReply(turn) {
  // The closing question, which is asked of every seat that worked and is not a task.
  if (/is anything unresolved/.test(prompt)) return 'NONE'
  if (!prompt.includes('RENDEZVOUS')) return `${seat} acknowledges the briefing.`

  // The proof. Entry is announced first, so a sibling that starts later can still see it,
  // and this child does not finish until it has seen the sibling's.
  writeFileSync(join(dir, `entered-${seat}`), `${process.pid} turn ${turn}\n`)
  const sawSibling = waitFor(
    () => readdirSync(dir).filter((f) => f.startsWith('entered-')).length >= 2,
    8000,
  )
  writeFileSync(join(dir, `overlap-${seat}`), sawSibling ? 'observed' : 'timeout')
  // Held here so the seat table can be READ while both seats are running. The test writes
  // `release` once it has looked; a caller that does not care creates it up front.
  const released = waitFor(() => existsSync(join(dir, 'release')), 8000)
  writeFileSync(join(dir, `released-${seat}`), released ? 'released' : 'timeout')
  return `${seat} ran concurrently: sibling ${sawSibling ? 'observed' : 'NOT observed'}.`
}

const turn = nextTurn()
const text = seat === 'advisor' ? advisorReply(turn) : implementerReply(turn)

// One session id per seat, stable across turns, so `--session` resumption is exercised
// exactly as it is against the real CLI.
const sessionID = `fixture-${seat}`
const say = (record) => process.stdout.write(`${JSON.stringify(record)}\n`)
say({ type: 'step_start', sessionID, timestamp: Date.now(), part: {} })
say({ type: 'text', sessionID, timestamp: Date.now(), part: { text } })
// The announced terminal signal. Without it the adapter grades the turn
// `unknown_abnormal_end (assumed)` however cleanly the process exits.
say({ type: 'step_finish', sessionID, timestamp: Date.now(), part: { reason: 'stop' } })
process.exit(0)
