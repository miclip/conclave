/**
 * The send-timeout diagnostic reads the attempts journal instead of testing for it (#352).
 *
 *   node --test src/adapters/sendHookTimeout.test.ts
 *
 * The journal in every fixture is written by `HookJournal.appendAttempt` with the fields the
 * hook client writes, so the reader is proven against the writer's shape rather than against a
 * copy of it that could drift on its own.
 */

import { strict as assert } from 'node:assert'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { HookJournal } from '../hooks/journal.ts'
import { suiteTempDir } from '../testkit/tempDir.ts'
import { readAttemptJournal, sendHookTimeoutDiagnostic } from './sendHookTimeout.ts'

const SCRATCH = suiteTempDir('orch-send-hook-timeout')
let n = 0
const fresh = (): string => join(SCRATCH, `run-${++n}`, 'attempts.ndjson')

/** One entry as `runHookClient` journals it. `firedAt` is seconds, like the client's. */
function fired(path: string, event: string, firedAt: number, payload: Record<string, unknown> = {}): void {
  const body = JSON.stringify({ hook_event_name: event, session_id: 's-1', ...payload })
  HookJournal.appendAttempt(path, {
    phase: 'fired',
    deliveryId: `d-${event}-${firedAt}`,
    agent: 'codex',
    event,
    sessionId: 's-1',
    firedAt,
    hookPid: 4242,
    bytes: body.length,
    body,
  })
}

const SENT = 1_000_000

test('#352 the observed journal: one SessionEnd and no prompt is the child leaving, not a delivery problem', () => {
  // The run that raised the issue. The file EXISTED, the old rule said "delivery problem", and
  // the one entry in it said the child was gone.
  const path = fresh()
  fired(path, 'SessionEnd', SENT + 3, { reason: 'other' })
  const reading = readAttemptJournal(path, SENT)
  assert.deepEqual(reading, { kind: 'session_ended', reason: 'other', count: 1, uncertain: 0 })
  const text = sendHookTimeoutDiagnostic('opening.', 'typed', path, SENT)
  assert.match(text, /newest entry is SessionEnd \(reason: other\)/)
  assert.match(text, /session ENDED before the prompt became a turn/)
  assert.match(text, /retry with '--settle 20' and nothing else changed got past it/, 'the recurrence evidence is in the text')
  assert.doesNotMatch(text, /If that file EXISTS/, 'the rule is not offered when the answer is')
})

test('#352 a UserPromptSubmit attempt after the send is the delivery problem the old rule named', () => {
  const path = fresh()
  fired(path, 'UserPromptSubmit', SENT + 1, { prompt: 'hello' })
  assert.deepEqual(readAttemptJournal(path, SENT), { kind: 'expected', count: 1, endedSince: undefined, uncertain: 0 })
  const text = sendHookTimeoutDiagnostic('opening.', 'typed', path, SENT)
  assert.match(text, /handler ran and could not deliver. That is a delivery problem/)
  assert.doesNotMatch(text, /child has since left/, 'no exit is reported when none happened')
})

test('#352 a prompt that was accepted and then saw the child leave is the delivery fault, with the exit as a note', () => {
  // The fourth state is "ended BEFORE the prompt was accepted". Here the prompt attempt fired and
  // the adapter did not get it, which is the delivery fault to chase; the exit that followed
  // qualifies the report -- there is no seat to retry into -- but must not replace it.
  const path = fresh()
  fired(path, 'UserPromptSubmit', SENT + 1)
  fired(path, 'SessionEnd', SENT + 5, { reason: 'exit' })
  assert.deepEqual(readAttemptJournal(path, SENT), { kind: 'expected', count: 2, endedSince: { reason: 'exit' }, uncertain: 0 })
  const text = sendHookTimeoutDiagnostic('opening.', 'typed', path, SENT)
  assert.match(text, /handler ran and could not deliver. That is a delivery problem/)
  assert.match(text, /newest entry is SessionEnd \(reason: exit\): the\nchild has since left/)
  assert.match(text, /missing hook is the fault to chase/)
  assert.doesNotMatch(text, /ENDED before the prompt became a turn/)
})

test('#352 an absent journal is the handler never executing, and says so without the rule', () => {
  const path = fresh()
  assert.deepEqual(readAttemptJournal(path, SENT), { kind: 'absent', older: 0, uncertain: 0 })
  const text = sendHookTimeoutDiagnostic('opening.', 'typed', path, SENT)
  assert.match(text, /it is ABSENT, so the handler never executed/)
  assert.match(text, /presents as flakiness/)
})

test('#352 entries from earlier turns do not count for this send', () => {
  // At turn three the journal always holds two UserPromptSubmit attempts. Counting them would
  // report "delivery problem" for every mid-run timeout -- the per-agent confusion again.
  const path = fresh()
  fired(path, 'UserPromptSubmit', SENT - 100)
  fired(path, 'Stop', SENT - 90)
  fired(path, 'UserPromptSubmit', SENT - 50)
  fired(path, 'Stop', SENT - 40)
  assert.deepEqual(readAttemptJournal(path, SENT), { kind: 'absent', older: 4, uncertain: 0 })
  assert.match(sendHookTimeoutDiagnostic('opening.', 'typed', path, SENT), /nothing fired since this send \(4 older entries from earlier turns\)/)
  // And without a send time, everything counts -- the newest is Stop, not SessionEnd, and a
  // prompt attempt is present.
  assert.deepEqual(readAttemptJournal(path), { kind: 'expected', count: 4, endedSince: undefined, uncertain: 0 })
})

test('#352 attempts for other events, and no prompt, name the events and point at the CLI', () => {
  const path = fresh()
  fired(path, 'Notification', SENT + 1)
  fired(path, 'Stop', SENT + 2)
  fired(path, 'Notification', SENT + 3)
  assert.deepEqual(readAttemptJournal(path, SENT), { kind: 'other', events: ['Notification', 'Stop'], uncertain: 0 })
  const text = sendHookTimeoutDiagnostic('opening.', 'typed', path, SENT)
  assert.match(text, /\(Notification, Stop\) but none for\nUserPromptSubmit/)
  assert.match(text, /CLI did not dispatch UserPromptSubmit/)
})

test('#352 only a genuine attempt is evidence: {} is not one, nor unknown, nor an entry with no time', () => {
  // Each of these is a line the reader could have taken at face value and built a definite
  // claim on. `{}` is valid JSON with nothing in it; `unknown` is what the client writes when the
  // CLI sent no event name, a real firing that says nothing about which; a line with no
  // `firedAt` cannot be placed relative to the send (the client has always written one, so this
  // is damage, not an older format); and the last is torn mid-write. None is this send's
  // prompt attempt -- and any of them could have been, which is the second half of the test.
  const path = fresh()
  fired(path, 'Stop', SENT - 10)
  writeFileSync(path, '{}\n', { flag: 'a' })
  HookJournal.appendAttempt(path, { phase: 'fired', agent: 'codex', event: 'unknown', firedAt: SENT + 1, body: '{}' })
  HookJournal.appendAttempt(path, { phase: 'fired', agent: 'codex', event: 'UserPromptSubmit', body: '{}' })
  writeFileSync(path, '{"phase":"fired","event":"Sess', { flag: 'a' })
  const reading = readAttemptJournal(path, SENT)
  assert.deepEqual(reading, { kind: 'absent', older: 1, uncertain: 4 })
  const text = sendHookTimeoutDiagnostic('opening.', 'typed', path, SENT)
  assert.match(text, /for this send the handler never executed/)
  assert.match(text, /But 4 lines were not usable as evidence/)
  assert.match(text, /"the handler never executed" is the reading of what could be read, not a certainty/)
})

test('#352 a line must be a fired attempt with a named event: other phases and empty events are not evidence', () => {
  // The client writes exactly one phase, `fired`, so a `delivered` record naming the right
  // event was not written by the code whose meaning this reader assumes -- and taking it as a
  // prompt attempt would report "delivery problem" on the strength of a line that says nothing
  // about a delivery. An empty event is JSON's way of saying nothing, not a hook called "".
  const path = fresh()
  const body = JSON.stringify({ hook_event_name: 'UserPromptSubmit' })
  HookJournal.appendAttempt(path, { phase: 'delivered', agent: 'codex', event: 'UserPromptSubmit', firedAt: SENT + 1, hookPid: 1, body })
  HookJournal.appendAttempt(path, { agent: 'codex', event: 'UserPromptSubmit', firedAt: SENT + 2, hookPid: 1, body })
  HookJournal.appendAttempt(path, { phase: 'fired', agent: 'codex', event: '', firedAt: SENT + 3, hookPid: 1, body: '{}' })
  assert.deepEqual(readAttemptJournal(path, SENT), { kind: 'undecodable', lines: 3 })
  // With one genuine attempt beside them they are counted, and the answer is qualified by them.
  fired(path, 'Stop', SENT + 4)
  assert.deepEqual(readAttemptJournal(path, SENT), { kind: 'other', events: ['Stop'], uncertain: 3 })
  const text = sendHookTimeoutDiagnostic('o.', 'typed', path, SENT)
  assert.match(text, /But 3 lines were not usable as evidence/)
  assert.doesNotMatch(text, /That is a delivery problem/, 'the delivered-phase line did not become a prompt attempt')
})

test('#352 an unusable line qualifies every reading that rests on an absence, and not the one that does not', () => {
  // session_ended: the torn line could have been the prompt attempt.
  const ended = fresh()
  fired(ended, 'SessionEnd', SENT + 3, { reason: 'other' })
  writeFileSync(ended, 'garbage\n', { flag: 'a' })
  assert.deepEqual(readAttemptJournal(ended, SENT), { kind: 'session_ended', reason: 'other', count: 1, uncertain: 1 })
  assert.match(sendHookTimeoutDiagnostic('o.', 'typed', ended, SENT), /But 1 line was not usable as evidence[^]*"before the prompt became a turn" is the reading of what could be read/)

  // other: likewise.
  const other = fresh()
  fired(other, 'Stop', SENT + 1)
  writeFileSync(other, '{}\n', { flag: 'a' })
  assert.deepEqual(readAttemptJournal(other, SENT), { kind: 'other', events: ['Stop'], uncertain: 1 })
  assert.match(sendHookTimeoutDiagnostic('o.', 'typed', other, SENT), /"the CLI did not dispatch UserPromptSubmit" is the reading of what could be read/)

  // expected: a prompt attempt IS present, and no unreadable line can take that away.
  const seen = fresh()
  fired(seen, 'UserPromptSubmit', SENT + 1)
  writeFileSync(seen, 'garbage\n', { flag: 'a' })
  assert.deepEqual(readAttemptJournal(seen, SENT), { kind: 'expected', count: 1, endedSince: undefined, uncertain: 1 })
  assert.doesNotMatch(sendHookTimeoutDiagnostic('o.', 'typed', seen, SENT), /not usable as evidence/)

  // absent by ENOENT: there are no lines to be uncertain about.
  assert.doesNotMatch(sendHookTimeoutDiagnostic('o.', 'typed', fresh(), SENT), /not usable as evidence/)
})

test('#352 the child-ended reading is worded from what the adapter itself established', () => {
  // Codex knows only that it typed; Claude has seen a turn in the transcript. The same journal
  // must not be described as "never became a turn" to an adapter that has just said it did.
  const path = fresh()
  fired(path, 'SessionEnd', SENT + 3, { reason: 'other' })
  const typed = sendHookTimeoutDiagnostic('typed.', 'typed', path, SENT)
  const seen = sendHookTimeoutDiagnostic('in transcript.', 'transcript', path, SENT)
  assert.match(typed, /ENDED before the prompt became a turn/)
  assert.doesNotMatch(typed, /in the child's transcript/)
  assert.match(seen, /although the prompt is in the child's transcript, its hook never ran: the child's session ENDED\nwith the prompt's UserPromptSubmit unfired/)
  assert.doesNotMatch(seen, /became a turn/)
  // Both still carry the shared remedy and evidence.
  for (const t of [typed, seen]) {
    assert.match(t, /points at\nthe child rather than at conclave's plumbing/)
    assert.match(t, /retry with '--settle 20'/)
  }
  // And the shared bullet claims only the journal fact, which neither opening contradicts.
  assert.match(typed, /- the child's session ended with no UserPromptSubmit ever fired for the prompt \(#352\)/)
})

test('#352 a journal with nothing decodable says so, and does not fall back to the EXISTS rule', () => {
  // "EXISTS means the handler ran and could not deliver" is the inference #352 is about, and a
  // file that exists but cannot be decoded is exactly where restating it would repeat the error.
  const path = fresh()
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'not json\n\n{"unterminated":\n')
  assert.deepEqual(readAttemptJournal(path, SENT), { kind: 'undecodable', lines: 2 })
  const text = sendHookTimeoutDiagnostic('opening.', 'typed', path, SENT)
  assert.match(text, /EXISTS but none of its 2 lines is a decodable attempt/)
  assert.match(text, /treat this as undiagnosed rather than as\neither/)
  assert.doesNotMatch(text, /EXISTS the handler ran and could not deliver/, 'the old rule is gone')
  assert.doesNotMatch(text, /delivery problem\. If it is ABSENT/, 'in either of its phrasings')
})

test('#352 a journal that cannot be opened is reported, not thrown', (t) => {
  // The reading runs inside the timeout callback that is about to reject the send. A throw
  // there would replace the diagnostic with a stack trace.
  const path = fresh()
  mkdirSync(path, { recursive: true }) // a directory where the file should be: EISDIR
  const reading = readAttemptJournal(path, SENT)
  assert.equal(reading.kind, 'unreadable')
  assert.match((reading as { detail: string }).detail, /EISDIR/)
  const text = sendHookTimeoutDiagnostic('opening.', 'typed', path, SENT)
  assert.match(text, /could not be opened this time \(EISDIR/)
  assert.match(text, /not even whether it exists/)
  assert.doesNotMatch(text, /EXISTS the handler ran/, 'no inference is offered about a file that could not be opened')

  if (process.getuid?.() === 0) {
    t.diagnostic('root reads anything; the permission half is not provable here')
    return
  }
  const denied = fresh()
  fired(denied, 'UserPromptSubmit', SENT + 1)
  chmodSync(denied, 0o000)
  try {
    const r = readAttemptJournal(denied, SENT)
    assert.equal(r.kind, 'unreadable')
    assert.match((r as { detail: string }).detail, /EACCES/)
  } finally {
    chmodSync(denied, 0o600)
  }
})

test('#352 the adapters keep their own opening line and share the rest', () => {
  const path = fresh()
  const a = sendHookTimeoutDiagnostic('A says this.', 'typed', path, SENT)
  const b = sendHookTimeoutDiagnostic('B says that.', 'typed', path, SENT)
  assert.ok(a.startsWith('A says this. Most often the previous turn had not finished'))
  assert.ok(b.startsWith('B says that. Most often the previous turn had not finished'))
  assert.equal(a.slice('A says this.'.length), b.slice('B says that.'.length))
  assert.match(a, /Four states are known to produce this, and two of them are transient; evidence that fits none\nof them is reported as such below/)
  // The lead used to end "If it recurs at the first turn, the hooks are not firing" -- a cause
  // named before the evidence, and one the #352 journal refutes: SessionEnd DID fire.
  assert.match(a, /If it recurs at the first turn, read the attempts journal below before naming a cause/)
  assert.doesNotMatch(a, /the hooks are not firing/)
  assert.match(a, /- the child's session ended with no UserPromptSubmit ever fired for the prompt \(#352\)/, 'the fourth state is listed with the others')
  assert.doesNotMatch(a, /fourth state/, 'and nothing is left calling it an afterthought')
  assert.match(a, /conclave config check/)
  assert.ok(a.includes(`${path} tells them apart`), 'the journal is named by path')
})
