/**
 * A child that accepts the WRONG prompt is retried once, then refused, in both adapters (#174).
 *
 *   node --test src/adapters/promptFidelity.test.ts
 *
 * `#120` established that a send resolving does not mean the child accepted the text, and the
 * adapters gained a landed check. This is the next thing along: the child can accept text that
 * is not the text that was sent. When that happens every witness downstream agrees on the wrong
 * message -- the hook carries it, the transcript records it, the turn runs on it -- and nothing
 * anywhere disagrees. In the four field incidents the fragment was a grammatical sentence, and
 * one of them read like an instruction; they were caught only because the seats were suspicious
 * of a mid-word opening, which is not a control.
 *
 * `UserPromptSubmit` echoes back what the child took, so comparing it to what was sent is an
 * exact end-to-end check that does not itself depend on the pty, the tty queue or the composer.
 *
 * The stand-in CLIs are real processes over real ptys, real hook receivers and real adapters;
 * `ORCH_FAKE_LOSE` makes one of them report having taken a mangled prompt. No agent binary is
 * spawned and no quota is used.
 *
 * Two things every case here checks, because either one alone would be a worse bug than the one
 * being fixed:
 *
 *   1. The message either ARRIVES INTACT or the send is REFUSED, naming the shape of the
 *      corruption and the byte counts. Nothing in between.
 *   2. The malformed turn is still OPENED and RECORDED. The child was working on that text
 *      whatever anyone thinks of it, and a session whose transcript disagrees with the child is
 *      not more honest than one that admits the child was fed garbage.
 *
 * A corrupted prompt is not refused on sight any more: the malformed turn is cancelled and the
 * message is typed once more, because the corruption is in the transport and the same bytes
 * usually land the second time. That makes three things worth proving, and all three are here:
 * a first-attempt corruption RECOVERS, the message reaches the child EXACTLY ONCE and never
 * overlapping the malformed turn, and a child that keeps corrupting -- or one that will not
 * stop when it is cancelled -- is still REFUSED. See `PROMPT_SEND_ATTEMPTS` for why the budget
 * is one and what makes a re-send safe to make.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import type {
  AdapterErrorEvent,
  AgentEvent,
  TurnKey,
  TurnRecord,
  TurnStartEvent,
} from '../contract/session.ts'
import type { InputAction } from '../process/input.ts'
import { ClaudePtyHookAdapter } from './claude.ts'
import { CodexPtyHookAdapter } from './codex.ts'
import { installFakeClis } from './fakeCli.ts'
import { describePromptMismatch, RETRY_EXHAUSTED } from './promptFidelity.ts'

const { dir: RUN } = installFakeClis()

/** Collect events until `done`, or give up. Returns what it saw either way. */
async function collect(
  session: { events(): AsyncIterable<AgentEvent> },
  done: (e: AgentEvent[]) => boolean,
  timeoutMs: number,
): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = []
  const deadline = Date.now() + timeoutMs
  const it = session.events()[Symbol.asyncIterator]()
  while (Date.now() < deadline) {
    let timer: NodeJS.Timeout | undefined
    const next = await Promise.race([
      it.next(),
      new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), Math.max(0, deadline - Date.now()))
      }),
    ]).finally(() => clearTimeout(timer))
    if (next === 'timeout' || next.done) break
    seen.push(next.value)
    if (done(seen)) break
  }
  return seen
}

const startOf = (e: AgentEvent[]): TurnStartEvent | undefined =>
  e.find((x) => x.type === 'turn_start') as TurnStartEvent | undefined

type Adapter = typeof ClaudePtyHookAdapter | typeof CodexPtyHookAdapter

const ADAPTERS: Array<[string, Adapter]> = [
  ['claude', ClaudePtyHookAdapter],
  ['codex', CodexPtyHookAdapter],
]

interface Attempt {
  /** The error `send()` rejected with, or undefined if it resolved. */
  error: Error | undefined
  /** The turn `send()` resolved with, if it resolved. */
  key: TurnKey | undefined
  /** The turn the adapter opened anyway, if it opened one. */
  started: TurnStartEvent | undefined
  /**
   * EVERY turn the child opened, in order.
   *
   * One send can now produce two of them: a corrupted prompt is cancelled and the message is
   * typed once more (#174), so the malformed turn and the good one both exist. Counting them
   * is how "exactly once" is checked rather than assumed.
   */
  starts: TurnStartEvent[]
  /**
   * The same turn as the SESSION sees it.
   *
   * Separate from `started` on purpose. An event is a thing that was said once; the snapshot is
   * what the session will keep answering with. "The malformed turn is still recorded" is a
   * claim about the second, and a refusal that emitted `turn_start` and then quietly dropped
   * the turn would satisfy the first while leaving the session denying a turn its child is
   * actually running.
   */
  recorded: TurnRecord | undefined
  /** Every turn in the snapshot, for the same reason `starts` exists. */
  turns: TurnRecord[]
  /** Non-fatal adapter errors. The retry announces itself through one of these. */
  notices: AdapterErrorEvent[]
  /** What `InputQueue` recorded writing. The write-side half of the evidence. */
  written: string | undefined
  /** Every action the input queue recorded, so the ORDER of submits and cancels is checkable. */
  actions: readonly InputAction[]
}

/**
 * Send `message` through a real adapter over a stand-in that loses `lose`, and report what
 * happened on BOTH sides: what the caller was told, and what was actually written to the pty.
 *
 * `loseTurns` bounds the corruption to the first N prompts. Zero means every prompt, which is a
 * transport that is broken rather than one that glitched -- the difference the retry is about.
 *
 * Events are drained AFTER the send settles rather than raced with it. `AsyncQueue` buffers
 * whatever nobody is waiting for, and nothing else consumes this session's stream, so a late
 * reader still sees every event from the beginning -- and one send can now emit a whole
 * cancellation and a second turn, which a collector that stopped at the first `turn_start`
 * would have thrown away.
 */
async function attempt(
  Adapter: Adapter,
  message: string,
  lose: string,
  loseTurns = 0,
  escOpensTurn = false,
): Promise<Attempt> {
  // Read by the child at spawn. `sanitizedCopy` passes ORCH_-prefixed variables through, which
  // is the same channel the other stand-in knobs use.
  if (lose) process.env['ORCH_FAKE_LOSE'] = lose
  else delete process.env['ORCH_FAKE_LOSE']
  if (loseTurns) process.env['ORCH_FAKE_LOSE_TURNS'] = String(loseTurns)
  else delete process.env['ORCH_FAKE_LOSE_TURNS']
  if (escOpensTurn) process.env['ORCH_FAKE_ESC_TURN'] = '1'
  else delete process.env['ORCH_FAKE_ESC_TURN']

  // `cancelEvidenceBudgetMs` is Codex's only: its cancel() polls the transcript for the child's
  // own `turn_aborted` before it is finished, and this stand-in never writes a transcript, so
  // the default 15 s budget would be spent in full on every recovery here. Claude's options do
  // not have the field and ignore it. Passed as a variable rather than a literal so it is not
  // an excess property on the adapter that does not take it.
  const opts = { cwd: RUN, role: 'implementer' as const, readyTimeoutMs: 20_000, cancelEvidenceBudgetMs: 1_000 }
  const session = await Adapter.start(opts)
  try {
    let error: Error | undefined
    let key: TurnKey | undefined
    try {
      key = await session.send(message, { kind: 'orchestrator' })
    } catch (e) {
      error = e as Error
    }
    // Everything the session has said so far, plus a beat for anything still in flight.
    const events = await collect(session, () => false, 500)
    const starts = events.filter((e) => e.type === 'turn_start') as TurnStartEvent[]
    const snap = await session.snapshot()
    return {
      error,
      key,
      started: starts[0],
      starts,
      recorded: snap.turns.find((t) => String(t.key) === String(starts[0]?.turnKey)),
      turns: snap.turns,
      notices: events.filter((e) => e.type === 'error') as AdapterErrorEvent[],
      written: session.inputLog.find((a) => a.kind === 'submit')?.bytes,
      actions: session.inputLog,
    }
  } finally {
    delete process.env['ORCH_FAKE_LOSE']
    delete process.env['ORCH_FAKE_LOSE_TURNS']
    delete process.env['ORCH_FAKE_ESC_TURN']
    await session.close()
  }
}

// ----------------------------------------------------------------------------------------
// The classifier, on its own. Cheap, exhaustive, and it is what the diagnostics are made of.
// ----------------------------------------------------------------------------------------

test('describePromptMismatch names the shape and counts UTF-8 bytes', () => {
  assert.equal(describePromptMismatch('same', 'same'), undefined, 'an exact match is not a mismatch')
  assert.equal(describePromptMismatch('', ''), undefined, 'and neither is an empty one')

  const tail = describePromptMismatch('abcdef', 'abc')!
  assert.equal(tail.shape, 'prefix', 'the received text is a prefix, so the TAIL was lost')
  assert.equal(tail.sentBytes, 6)
  assert.equal(tail.receivedBytes, 3)
  assert.equal(tail.lostBytes, 3)
  assert.match(tail.message, /PREFIX of what was sent: the last 3 bytes are missing/)

  const front = describePromptMismatch('abcdef', 'def')!
  assert.equal(front.shape, 'suffix', 'the received text is a suffix, so the FRONT was lost')
  assert.match(front.message, /SUFFIX of what was sent: the first 3 bytes are missing/)

  const interior = describePromptMismatch('abcXXXdef', 'abcdef')!
  assert.equal(interior.shape, 'interior')
  assert.match(interior.message, /INTERIOR corruption/)
  assert.match(interior.message, /the first 3 bytes and the last 3 bytes match/)

  const nothing = describePromptMismatch('abc', '')!
  assert.equal(nothing.shape, 'prefix')
  assert.match(nothing.message, /it received NOTHING -- all 3 bytes went missing/)

  // Bytes, not characters, and the difference is the entire point of reporting them: an em
  // dash is one character and three bytes, and the tty queue counts bytes.
  const wide = describePromptMismatch('a—b', 'a')!
  assert.equal(wide.sentBytes, 5, 'a + em dash + b is 5 UTF-8 bytes')
  assert.equal(wide.receivedBytes, 1)
  assert.equal(wide.lostBytes, 4)

  // A boundary that falls inside a surrogate pair must not be reported as a partial character.
  const emoji = describePromptMismatch('😀😀', '😀')!
  assert.equal(emoji.shape, 'prefix')
  assert.equal(emoji.sentBytes, 8)
  assert.equal(emoji.receivedBytes, 4)
})

// ----------------------------------------------------------------------------------------
// Through the real adapters.
// ----------------------------------------------------------------------------------------

for (const [name, Adapter] of ADAPTERS) {
  test(`${name}: a TRUNCATED prompt is refused, and the malformed turn is still recorded`, async () => {
    const sent = 'please summarise the release notes and then stop'
    const { error, started, recorded, written } = await attempt(Adapter, sent, 'tail:12')

    assert.ok(error, 'a send whose text the child mangled must not resolve as delivered')
    assert.match(error.message, /corrupted in transport/)
    assert.match(error.message, /PREFIX of what was sent: the last 12 bytes are missing/)
    assert.match(error.message, /Sent 48 UTF-8 bytes, the child took 36/)
    assert.match(error.message, /not a hook failure and not a slow child/)

    // Recorded anyway, against what the child actually took. This is the half that keeps
    // transport state honest: the child WAS working on that text.
    assert.ok(started, 'the malformed turn must still be opened')
    assert.equal(started.prompt, sent.slice(0, -12))
    // And it must still be there afterwards. A turn announced and then withdrawn leaves the
    // session denying work its child is doing, which is a worse lie than the one being fixed.
    assert.ok(recorded, 'snapshot() must still carry the malformed turn')
    assert.equal(recorded.prompt, sent.slice(0, -12))
    // Cancelled, not running: the retry cancelled it before typing the message again, and that
    // cancellation is the thing that made the re-send safe. A malformed turn left `in_progress`
    // here would mean the message had been typed into a child that was still working (#117).
    assert.equal(recorded.state, 'cancelled', 'the retry cancelled it before re-sending')

    // The write side. `submit()` framed and wrote the whole message, so the corruption
    // happened after conclave let go of it -- which is what the diagnostic claims.
    assert.equal(written, `\x1b[200~${sent}\x1b[201~\\r`)
  })

  test(`${name}: a prompt that lost its FRONT is refused, and named as a front loss`, async () => {
    // The field symptom. A tail fragment that still parses is the failure this exists for:
    // it is not recoverable by noticing that nothing arrived, because something did.
    const sent = 'do not delete the fixtures; the measurement was wrong'
    const { error, started, recorded, written } = await attempt(Adapter, sent, 'front:38')

    assert.ok(error, 'a fragment that reads like a sentence is exactly what must not be accepted')
    assert.match(error.message, /SUFFIX of what was sent: the first 38 bytes are missing/)
    assert.match(error.message, /Sent 53 UTF-8 bytes, the child took 15/)
    // What is left starts mid-word and still parses, which is the argument for refusing it
    // rather than trusting a seat to be suspicious of the opening.
    assert.equal(started?.prompt, 'ement was wrong')
    assert.equal(recorded?.prompt, 'ement was wrong', 'and the session keeps saying so')
    assert.equal(written, `\x1b[200~${sent}\x1b[201~\\r`)
  })

  test(`${name}: INTERIOR corruption is refused too, and not mistaken for truncation`, async () => {
    const sent = 'run the suite, then tag the release and push it'
    const { error, started, recorded } = await attempt(Adapter, sent, 'middle:9')

    assert.ok(error)
    assert.match(error.message, /INTERIOR corruption/)
    assert.doesNotMatch(error.message, /PREFIX|SUFFIX/, 'a hole in the middle is neither')
    assert.ok(started, 'still opened')
    assert.notEqual(started.prompt, sent)
    assert.equal(recorded?.prompt, started.prompt, 'and still recorded, against what the child took')
  })

  test(`${name}: an exact MULTILINE prompt is accepted, framing and all`, async () => {
    // The control, and the end-to-end proof of the #174 transport fix through a real adapter:
    // a message with blank lines in it is framed as a paste, arrives as ONE prompt, and matches
    // byte for byte. Before the fix each newline was an Enter and this arrived as four prompts,
    // the last of which is what the seat would have been left holding.
    const sent = [
      '[FROM THE ADVISOR (advisor) — a peer AI model, not your user.]',
      '',
      'First: read the issue. It is long, and the byte counts in it matter.',
      '',
      'Then: reply with what you measured — not what you expect.',
    ].join('\n')

    const { error, started, written } = await attempt(Adapter, sent, '')

    assert.equal(error, undefined, `an exact prompt must be accepted: ${error?.message ?? ''}`)
    assert.ok(started, 'and must open its turn')
    assert.equal(started.prompt, sent, 'the child took exactly what was sent, newlines and em dashes intact')
    assert.equal(written, `\x1b[200~${sent}\x1b[201~\\r`)
  })

  // --------------------------------------------------------------------------------------
  // Recovery: a corrupted prompt is cancelled and sent once more (#174).
  // --------------------------------------------------------------------------------------

  test(`${name}: a corrupted FIRST attempt is cancelled and re-sent, and the message lands`, async () => {
    // A transport that dropped bytes once, which is what the field incidents looked like. The
    // stand-in corrupts the first prompt only, so the same bytes typed again arrive whole --
    // and the run repairs itself instead of handing the operator a mangled seat.
    const sent = 'read the issue first; the byte counts in it are the point'
    const { error, key, starts, turns, notices, actions } = await attempt(Adapter, sent, 'front:9', 1)

    assert.equal(error, undefined, `a corruption that clears on a re-send must recover: ${error?.message ?? ''}`)
    assert.equal(starts.length, 2, 'the malformed turn, then the re-sent one -- and nothing else')
    assert.equal(starts[0]?.prompt, sent.slice(9), 'the first turn is the one the child mangled')
    assert.equal(starts[1]?.prompt, sent, 'and the second is the message, whole')
    assert.equal(
      String(key),
      String(starts[1]?.turnKey),
      'send() must resolve with the turn that got the real message, not the one that got the fragment',
    )

    // EXACTLY once. A retry that delivered the message twice would be a worse failure than the
    // corruption it was repairing: the seat would run the same instruction two times over, and
    // nothing downstream distinguishes a duplicate from a deliberate repeat.
    assert.equal(
      starts.filter((s) => s.prompt === sent).length,
      1,
      'the exact message must reach the child exactly once',
    )

    // And not overlapping. The order the input queue recorded is the proof: the message, then
    // the ESC that ended the malformed turn, then the message again. A re-send BEFORE the
    // cancellation would be spliced into a running turn (#117), which is the failure the
    // observed-closure gate exists to prevent.
    assert.deepEqual(
      actions.filter((a) => a.kind === 'submit' || a.kind === 'cancel').map((a) => a.kind),
      ['submit', 'cancel', 'submit'],
      'typed, cancelled, typed again -- in that order',
    )

    const malformed = turns.find((t) => String(t.key) === String(starts[0]?.turnKey))
    assert.equal(malformed?.state, 'cancelled', 'the malformed turn is closed, not abandoned open')
    assert.equal(malformed?.prompt, sent.slice(9), 'and still recorded against what the child took')

    // Said out loud. A silent retry is a run in which a corrupted prompt happened and nothing
    // anywhere records it, which is how a transport that is quietly failing stays quiet.
    const notice = notices.find((n) => n.message.includes('#174'))
    assert.ok(notice, 'the retry must be announced')
    assert.equal(notice.fatal, false, 'it is a repair in progress, not a failure')
    assert.match(notice.message, /Cancelling turn/)
  })

  test(`${name}: a child that corrupts EVERY prompt is refused, after exactly one re-send`, async () => {
    // The other half of the bound. The first mismatch buys a retry; the second is a broken
    // transport, and a third attempt would produce a third malformed turn and teach nobody
    // anything. `attempt` leaves ORCH_FAKE_LOSE_TURNS unset, so every prompt is mangled.
    const sent = 'run the suite and then tag the release'
    const { error, key, starts, actions } = await attempt(Adapter, sent, 'tail:11')

    assert.equal(key, undefined, 'a send that never got through must not resolve')
    assert.ok(error, 'and must reject')
    assert.match(error.message, new RegExp(RETRY_EXHAUSTED), 'the refusal says the retry is spent')
    assert.match(error.message, /attempt 1 .* cancelled/, 'and accounts for the first attempt')
    assert.match(error.message, /attempt 2 .* refused/, 'and for the second')
    // The underlying diagnosis is still in there: an operator needs the shape and the counts,
    // not just the news that conclave gave up.
    assert.match(error.message, /PREFIX of what was sent: the last 11 bytes are missing/)

    assert.equal(starts.length, 2, 'two attempts, not three: the budget is one retry')
    assert.equal(
      actions.filter((a) => a.kind === 'submit').length,
      2,
      'and the message was typed twice, never a third time',
    )
    assert.equal(
      starts.filter((s) => s.prompt === sent).length,
      0,
      'nothing anywhere received the message intact, which is why it is refused',
    )
  })

  test(`${name}: a child that will not stop is refused rather than re-sent to`, async () => {
    // The gate, exercised. This stand-in opens a turn of its own when it is told to stop, so
    // when the cancellation comes back the transport is open -- and an open turn is precisely
    // the state in which a re-send is spliced into a running turn rather than replacing the
    // malformed one (#117). The retry is available, the corruption would have cleared on a
    // second attempt, and the message is still not typed again. That is the intended trade:
    // an unrepaired send is recoverable, and two corrupted messages are not.
    const sent = 'a message this seat will never be told twice'
    const { error, key, starts, actions } = await attempt(Adapter, sent, 'front:9', 1, true)

    assert.equal(key, undefined, 'the send must not resolve')
    assert.ok(error)
    assert.match(error.message, new RegExp(RETRY_EXHAUSTED), 'and is refused in the same terms as a spent retry')
    assert.match(error.message, /transport is still open/, 'naming the reason the retry was not attempted')
    assert.match(error.message, /SUFFIX of what was sent: the first 9 bytes are missing/, 'with the original diagnosis intact')

    assert.equal(
      actions.filter((a) => a.kind === 'submit').length,
      1,
      'the message was typed once and never again -- this is the whole claim',
    )
    assert.ok(
      actions.some((a) => a.kind === 'cancel'),
      'the malformed turn was still cancelled; what was withheld is the re-send, not the repair',
    )
    assert.equal(
      starts.filter((s) => s.prompt === sent).length,
      0,
      'and nothing anywhere received the message intact',
    )
  })

  test(`${name}: the single-flight claim is HELD across the retry`, async () => {
    // The window this closes: between the corrupted hook and the re-send, the transport is shut
    // and no turn is open, so the guard that refuses a send during a running turn would let a
    // second caller straight through -- to type into the same composer the recovery is about to
    // type into. The send that is recovering never releases its claim, and this is that claim
    // being asked to do its job at the one moment it matters.
    process.env['ORCH_FAKE_LOSE'] = 'front:9'
    process.env['ORCH_FAKE_LOSE_TURNS'] = '1'
    const opts = { cwd: RUN, role: 'implementer' as const, readyTimeoutMs: 20_000, cancelEvidenceBudgetMs: 1_000 }
    const session = await Adapter.start(opts)
    try {
      const sent = 'the first message, which the child will mangle once'
      const recovering = session.send(sent, { kind: 'orchestrator' })

      // Wait until the recovery is actually under way -- the ESC has been typed, so the
      // malformed turn is closed and the re-send has not happened yet. Polling the input log
      // rather than sleeping a guessed interval, so this is a state and not a race.
      const until = Date.now() + 15_000
      while (Date.now() < until && !session.inputLog.some((a) => a.kind === 'cancel')) {
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(session.inputLog.some((a) => a.kind === 'cancel'), 'the recovery must have cancelled by now')

      const refused = await session
        .send('a second message, from a caller that did not wait', { kind: 'orchestrator' })
        .then(() => undefined, (e: Error) => e)
      assert.ok(refused, 'a second send during the recovery must not be accepted')
      assert.match(refused.message, /already in flight/, 'and is refused by the claim the retry is holding')

      // The recovery still completes, which is the other half: holding the claim must not
      // deadlock the send that is holding it.
      const key = await recovering
      assert.ok(key, 'the recovering send still resolves')
      assert.equal(
        session.inputLog.filter((a) => a.kind === 'submit').length,
        2,
        'and the second caller typed nothing at all',
      )
    } finally {
      delete process.env['ORCH_FAKE_LOSE']
      delete process.env['ORCH_FAKE_LOSE_TURNS']
      await session.close()
    }
  })

  test(`${name}: an unsolicited turn with no pending send is still valid`, async () => {
    // The child is allowed to start turns nobody here asked for -- a resumed session, a queued
    // prompt, a human typing into the same terminal -- and always was. The comparison must
    // apply to a PENDING SEND, not to every hook that arrives.
    const sent = 'the one send this test makes'
    const { error, started } = await attempt(Adapter, sent, '')
    assert.equal(error, undefined)
    assert.ok(started)

    // Now a hook with no send behind it at all, delivered straight to the receiver the way the
    // child's own POST would be. Nothing is pending, so nothing can mismatch.
    const session = await Adapter.start({ cwd: RUN, role: 'implementer', readyTimeoutMs: 20_000 })
    try {
      const events = collect(session, (e) => startOf(e) !== undefined, 15_000)
      const res = await fetch(session.receiver.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-orch-agent': name,
          'x-orch-event': 'UserPromptSubmit',
        },
        body: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'fake-session',
          prompt_id: 'unsolicited-1',
          turn_id: 'unsolicited-1',
          prompt: 'something nobody here typed',
        }),
      })
      assert.equal(res.ok, true, 'the receiver must accept a hook that answers no send')
      const start = startOf(await events)
      assert.equal(start?.prompt, 'something nobody here typed', 'and the turn opens normally')
    } finally {
      await session.close()
    }
  })
}
