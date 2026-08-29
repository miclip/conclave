/**
 * The broker: what reaches a transport, what comes back, and what the record says.
 *
 *   node --test src/notify/broker.test.ts
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { Broker, decisionsPath, forTransport } from './broker.ts'
import { FakeTransport } from './fake.ts'
import type { Outbound } from './types.ts'

const repo = () => realpathSync(mkdtempSync(join(tmpdir(), 'conclave-notify-')))

const APPROVAL: Outbound = {
  kind: 'approval',
  headline: 'Merge fix-183? CI green on three platforms.',
  options: [
    { id: 'yes', label: 'Merge' },
    { id: 'no', label: 'Do not merge' },
  ],
  href: 'https://github.com/miclip/conclave/pull/1',
}

test('#184 nothing but the allowed fields can reach a transport', () => {
  // Keeps the payload predictable, so an adapter formats these fields and nothing else and
  // adding one is a decision made in the module rather than a thing a transport starts doing.
  // A caller that builds a richer object finds the extra keys do not travel.
  const smuggled = {
    ...APPROVAL,
    diff: '--- a/secret.ts\n+++ b/secret.ts\n-const KEY = "hunter2"',
    toolOutput: 'npm test\n  1521 passing',
  } as unknown as Outbound

  const carried = forTransport(smuggled, { maxChars: 200 })
  assert.deepEqual(
    Object.keys(carried).sort(),
    ['headline', 'href', 'kind', 'options'],
    'only the enumerated fields survive',
  )
  const json = JSON.stringify(carried)
  assert.doesNotMatch(json, /hunter2/, 'no file content leaves')
  assert.doesNotMatch(json, /1521 passing/, 'no tool output leaves')
})

test('#184 the allow-list is about shape, not sanitising: prose travels as written', () => {
  // Written down so nobody later mistakes the allow-list for a privacy boundary -- an earlier
  // draft of this module did. `headline` is free text authored by the operating agent, and any
  // surface that shows a notification has read it. Notifications are prose; that is the whole
  // point of them, and a third party carrying them sees what they carry.
  const leaky: Outbound = { kind: 'progress', headline: 'pushed b59eed4 — key is hunter2' }
  assert.match(forTransport(leaky, { maxChars: 200 }).headline, /hunter2/, 'prose travels as written')
  // The cap is a rendering budget, not a redaction: it exists so a HUD gets a line it can show.
  assert.equal(forTransport(leaky, { maxChars: 20 }).headline.length, 20)
})

test('#184 a headline is cut to what the surface can show, and href carries the rest', () => {
  // A HUD line and a chat message are the same message at different budgets. Truncated rather
  // than refused: a surface that cannot show the whole line should still show the line.
  const hud = forTransport(APPROVAL, { maxChars: 20 })
  assert.equal(hud.headline.length, 20)
  assert.match(hud.headline, /…$/)
  assert.equal(hud.href, APPROVAL.href, 'where to read the rest is not truncated away')
})

test('#184 an approval records the answer and WHO gave it', async () => {
  const dir = repo()
  const t = new FakeTransport()
  t.reply = { option: 'yes', from: { id: 'mic', kind: 'human' } }

  const answer = await new Broker(dir).ask(APPROVAL, t)
  assert.deepEqual(answer, { option: 'yes', by: { id: 'mic', kind: 'human' } })

  const [rec] = new Broker(dir).decisions()
  assert.ok(rec)
  assert.equal(rec.kind, 'approval')
  assert.deepEqual(rec.offered, ['yes', 'no'], 'what was on offer is part of the record')
  assert.equal(rec.answer?.by.kind, 'human')
})

test('#184 a human answer and an agent operator answer are distinguishable afterwards', async () => {
  // The whole point of reaching past the operating agent. An agent operator writing the goal,
  // watching the run and confirming the outcome shares blind spots with the participants, so
  // its answer is not independent evidence in the way a human's is -- and six months later the
  // record has to be able to say which this was.
  const dir = repo()
  const b = new Broker(dir)

  const byAgent = new FakeTransport({ name: 'agent-loop' })
  byAgent.reply = { option: 'yes', from: { id: 'operator', kind: 'agent' } }
  await b.ask(APPROVAL, byAgent)

  const byHuman = new FakeTransport({ name: 'glasses' })
  byHuman.reply = { option: 'yes', from: { id: 'mic', kind: 'human' } }
  await b.ask(APPROVAL, byHuman)

  const kinds = b.decisions().map((d) => `${d.transport}:${d.answer?.by.kind}`)
  assert.deepEqual(kinds, ['agent-loop:agent', 'glasses:human'])
})

test('#184 free text comes back as a MESSAGE, never as an instruction', async () => {
  // `/continue force` is the whole word and nothing after it, so a transcription of "continue,
  // force it" is a message. Nothing here parses English into an action: an action is an id from
  // the options that were offered, and prose is prose.
  const dir = repo()
  const t = new FakeTransport()
  t.reply = { text: 'continue, force it', from: { id: 'mic', kind: 'human' } }

  const answer = await new Broker(dir).ask(APPROVAL, t)
  assert.equal(answer?.option, undefined, 'prose must not become an option')
  assert.equal(answer?.text, 'continue, force it')
})

test('#184 an option that was never offered is refused, not passed through', async () => {
  // A transport that invents an id is malfunctioning, and accepting it would let a surface
  // widen the choice the caller enumerated.
  const dir = repo()
  const t = new FakeTransport()
  t.reply = { option: 'merge-and-deploy', from: { id: 'mic', kind: 'human' } }

  const answer = await new Broker(dir).ask(APPROVAL, t)
  assert.equal(answer, undefined)
  const [rec] = new Broker(dir).decisions()
  assert.match(rec?.undelivered ?? '', /not offered: merge-and-deploy/)
  assert.equal(rec?.answer, undefined, 'and nothing is recorded as an answer')
})

test('#184 a dead transport never stops anything', async () => {
  // The rule that outranks the rest. A notification layer that can stop a run is worse than no
  // notification layer, and it fails in the direction nobody tests.
  const dir = repo()
  const b = new Broker(dir)

  const down = new FakeTransport()
  down.failSend = 'ECONNREFUSED'
  await b.tell({ kind: 'progress', headline: 'run started' }, down) // must not throw

  const asking = new FakeTransport()
  asking.failSend = 'ECONNREFUSED'
  const answer = await b.ask(APPROVAL, asking)
  assert.equal(answer, undefined, 'ask reports failure rather than throwing')

  const recs = b.decisions()
  assert.equal(recs.length, 2)
  for (const r of recs) assert.match(r.undelivered ?? '', /ECONNREFUSED/)
  // "Nobody was asked" and "nobody answered" are different, and a later reader must be able to
  // tell them apart.
  assert.equal(recs[1]?.answer, undefined)
})

test('#184 a write-only surface is asked nothing and says so', async () => {
  const dir = repo()
  const hud = new FakeTransport({ name: 'hud', canReceive: false })
  const answer = await new Broker(dir).ask(APPROVAL, hud)
  assert.equal(answer, undefined)
  assert.equal(hud.sent.length, 0, 'a question is not sent to a surface that cannot answer it')
  assert.match(new Broker(dir).decisions()[0]?.undelivered ?? '', /cannot receive/)
})

test('#184 a decision without a run is a first-class decision', async () => {
  // `runId` is optional and that is the design. Reported usage is design conversations, next
  // steps and merge approvals -- and two of those three involve no run at all.
  const dir = repo()
  const t = new FakeTransport()
  t.reply = { option: 'later', from: { id: 'mic', kind: 'human' } }

  await new Broker(dir).ask(
    { kind: 'direction', headline: 'Which next: #66 or #76?', options: [{ id: 'later', label: 'Neither yet' }] },
    t,
  )
  const [rec] = new Broker(dir).decisions()
  assert.equal(rec?.runId, undefined, 'no run is not a missing field')
  assert.equal(rec?.answer?.option, 'later')
})

test('#184 the log survives a torn last line', () => {
  // Appended to by a process that can be killed mid-write. A reader that threw on the torn
  // line would lose every decision before it, which is the opposite of what a record is for.
  const dir = repo()
  mkdirSync(dirname(decisionsPath(dir)), { recursive: true })
  writeFileSync(
    decisionsPath(dir),
    '{"at":1,"transport":"fake","kind":"approval","headline":"first"}\n' +
      '{"at":2,"transport":"fake","kind":"approv',
  )
  const kept = new Broker(dir).decisions()
  assert.equal(kept.length, 1, 'the whole lines survive')
  assert.equal(kept[0]?.headline, 'first')
})

test('#184 a decision already taken is told, not asked — and the veto offered is recorded', async () => {
  // The observed shape: a judgement made, reported with an implicit veto. Nothing waits on it,
  // and the record must still be able to answer "were they given the chance to stop this?" --
  // the only interesting question about a decision nobody vetoed.
  const dir = repo()
  const t = new FakeTransport()
  const decided: Outbound = {
    kind: 'decided',
    headline: "advisor flagged provenance overclaims; letting the fix land rather than cutting short",
    options: [{ id: 'cut', label: 'Cut it short' }],
    href: 'https://github.com/miclip/conclave/commit/b59eed4',
  }

  await new Broker(dir).tell(decided, t)

  assert.equal(t.sent.length, 1, 'it was sent')
  assert.deepEqual(t.sent[0]?.options, decided.options, 'the veto reached the surface')
  const [rec] = new Broker(dir).decisions()
  assert.equal(rec?.kind, 'decided')
  assert.deepEqual(rec?.offered, ['cut'], 'and the record says what they could have done')
  assert.equal(rec?.answer, undefined, 'nothing waited, so nothing was answered')
})
