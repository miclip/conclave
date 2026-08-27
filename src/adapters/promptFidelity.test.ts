/**
 * A child that accepts the WRONG prompt is refused, in both PTY adapters (#174).
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
 *   1. The send is REFUSED, naming the shape of the corruption and the byte counts.
 *   2. The malformed turn is still OPENED and RECORDED. The child is working on that text
 *      whatever anyone thinks of it, and a session whose transcript disagrees with the child is
 *      not more honest than one that admits the child was fed garbage.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { AgentEvent, TurnRecord, TurnStartEvent } from '../contract/session.ts'
import { ClaudePtyHookAdapter } from './claude.ts'
import { CodexPtyHookAdapter } from './codex.ts'
import { installFakeClis } from './fakeCli.ts'
import { describePromptMismatch } from './promptFidelity.ts'

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
  /** The turn the adapter opened anyway, if it opened one. */
  started: TurnStartEvent | undefined
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
  /** What `InputQueue` recorded writing. The write-side half of the evidence. */
  written: string | undefined
}

/**
 * Send `message` through a real adapter over a stand-in that loses `lose`, and report what
 * happened on BOTH sides: what the caller was told, and what was actually written to the pty.
 */
async function attempt(Adapter: Adapter, message: string, lose: string): Promise<Attempt> {
  // Read by the child at spawn. `sanitizedCopy` passes ORCH_-prefixed variables through, which
  // is the same channel the other stand-in knobs use.
  if (lose) process.env['ORCH_FAKE_LOSE'] = lose
  else delete process.env['ORCH_FAKE_LOSE']

  const session = await Adapter.start({ cwd: RUN, role: 'implementer', readyTimeoutMs: 20_000 })
  try {
    let error: Error | undefined
    // The turn_start is emitted before the send settles either way, so collecting has to be
    // running before the send is awaited.
    const events = collect(session, (e) => startOf(e) !== undefined, 15_000)
    try {
      await session.send(message, { kind: 'orchestrator' })
    } catch (e) {
      error = e as Error
    }
    const started = startOf(await events)
    const snap = await session.snapshot()
    return {
      error,
      started,
      recorded: snap.turns.find((t) => String(t.key) === String(started?.turnKey)),
      written: session.inputLog.find((a) => a.kind === 'submit')?.bytes,
    }
  } finally {
    delete process.env['ORCH_FAKE_LOSE']
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
    // transport state honest: the child IS working on that text.
    assert.ok(started, 'the malformed turn must still be opened')
    assert.equal(started.prompt, sent.slice(0, -12))
    // And it must still be there afterwards. A turn announced and then withdrawn leaves the
    // session denying work its child is doing, which is a worse lie than the one being fixed.
    assert.ok(recorded, 'snapshot() must still carry the malformed turn')
    assert.equal(recorded.prompt, sent.slice(0, -12))
    assert.equal(recorded.state, 'in_progress', 'the child is still working on it')

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
