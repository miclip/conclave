/**
 * The broker: what reaches a transport, what comes back, and what the record says.
 *
 *   node --test src/notify/broker.test.ts
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import { Broker, decisionsPath, forTransport } from './broker.ts'
import { FakeTransport } from './fake.ts'
import type { Outbound } from './types.ts'


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

test('#184 an approval records the answer and WHO gave it', async (t) => {
  const dir = tempDir(t, 'conclave-notify')
  const tx = new FakeTransport()
  tx.reply = { option: 'yes', from: { id: 'mic', kind: 'human' } }

  const answer = await new Broker(dir).ask(APPROVAL, tx)
  assert.deepEqual(answer, { option: 'yes', by: { id: 'mic', kind: 'human' } })

  const [rec] = new Broker(dir).decisions()
  assert.ok(rec)
  assert.equal(rec.kind, 'approval')
  assert.deepEqual(rec.offered, ['yes', 'no'], 'what was on offer is part of the record')
  assert.equal(rec.answer?.by.kind, 'human')
})

test('#184 a human answer and an agent operator answer are distinguishable afterwards', async (t) => {
  // The whole point of reaching past the operating agent. An agent operator writing the goal,
  // watching the run and confirming the outcome shares blind spots with the participants, so
  // its answer is not independent evidence in the way a human's is -- and six months later the
  // record has to be able to say which this was.
  const dir = tempDir(t, 'conclave-notify')
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

test('#184 free text comes back as a MESSAGE, never as an instruction', async (t) => {
  // `/continue force` is the whole word and nothing after it, so a transcription of "continue,
  // force it" is a message. Nothing here parses English into an action: an action is an id from
  // the options that were offered, and prose is prose.
  const dir = tempDir(t, 'conclave-notify')
  const tx = new FakeTransport()
  tx.reply = { text: 'continue, force it', from: { id: 'mic', kind: 'human' } }

  const answer = await new Broker(dir).ask(APPROVAL, tx)
  assert.equal(answer?.option, undefined, 'prose must not become an option')
  assert.equal(answer?.text, 'continue, force it')
})

test('#184 an option that was never offered is refused, not passed through', async (t) => {
  // A transport that invents an id is malfunctioning, and accepting it would let a surface
  // widen the choice the caller enumerated.
  const dir = tempDir(t, 'conclave-notify')
  const tx = new FakeTransport()
  tx.reply = { option: 'merge-and-deploy', from: { id: 'mic', kind: 'human' } }

  const answer = await new Broker(dir).ask(APPROVAL, tx)
  assert.equal(answer, undefined)
  const [rec] = new Broker(dir).decisions()
  assert.match(rec?.undelivered ?? '', /not offered: merge-and-deploy/)
  assert.equal(rec?.answer, undefined, 'and nothing is recorded as an answer')
})

test('#184 a dead transport never stops anything', async (t) => {
  // The rule that outranks the rest. A notification layer that can stop a run is worse than no
  // notification layer, and it fails in the direction nobody tests.
  const dir = tempDir(t, 'conclave-notify')
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

test('#184 a write-only surface is asked nothing and says so', async (t) => {
  const dir = tempDir(t, 'conclave-notify')
  const hud = new FakeTransport({ name: 'hud', canReceive: false })
  const answer = await new Broker(dir).ask(APPROVAL, hud)
  assert.equal(answer, undefined)
  assert.equal(hud.sent.length, 0, 'a question is not sent to a surface that cannot answer it')
  assert.match(new Broker(dir).decisions()[0]?.undelivered ?? '', /cannot receive/)
})

test('#184 a decision without a run is a first-class decision', async (t) => {
  // `runId` is optional and that is the design. Reported usage is design conversations, next
  // steps and merge approvals -- and two of those three involve no run at all.
  const dir = tempDir(t, 'conclave-notify')
  const tx = new FakeTransport()
  tx.reply = { option: 'later', from: { id: 'mic', kind: 'human' } }

  await new Broker(dir).ask(
    { kind: 'direction', headline: 'Which next: #66 or #76?', options: [{ id: 'later', label: 'Neither yet' }] },
    tx,
  )
  const [rec] = new Broker(dir).decisions()
  assert.equal(rec?.runId, undefined, 'no run is not a missing field')
  assert.equal(rec?.answer?.option, 'later')
})

test('#184 the log survives a torn last line', (t) => {
  // Appended to by a process that can be killed mid-write. A reader that threw on the torn
  // line would lose every decision before it, which is the opposite of what a record is for.
  const dir = tempDir(t, 'conclave-notify')
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

test('#184 a decision already taken is told, not asked — and the veto offered is recorded', async (t) => {
  // The observed shape: a judgement made, reported with an implicit veto. Nothing waits on it,
  // and the record must still be able to answer "were they given the chance to stop this?" --
  // the only interesting question about a decision nobody vetoed.
  const dir = tempDir(t, 'conclave-notify')
  const tx = new FakeTransport()
  const decided: Outbound = {
    kind: 'decided',
    headline: "advisor flagged provenance overclaims; letting the fix land rather than cutting short",
    options: [{ id: 'cut', label: 'Cut it short' }],
    href: 'https://github.com/miclip/conclave/commit/b59eed4',
  }

  await new Broker(dir).tell(decided, tx)

  assert.equal(tx.sent.length, 1, 'it was sent')
  assert.deepEqual(tx.sent[0]?.options, decided.options, 'the veto reached the surface')
  const [rec] = new Broker(dir).decisions()
  assert.equal(rec?.kind, 'decided')
  assert.deepEqual(rec?.offered, ['cut'], 'and the record says what they could have done')
  assert.equal(rec?.answer, undefined, 'nothing waited, so nothing was answered')
})

test('#184 a late veto attaches to the decision that offered it', async (t) => {
  // A `decided` message announces a judgement already taken and offers an override. Nothing
  // waits on it, so the tap lands after `tell` has returned -- and without somewhere for it to
  // go, the override on screen is a lie.
  const dir = tempDir(t, 'conclave-notify')
  const tx = new FakeTransport()
  const b = new Broker(dir)

  await b.tell(
    { kind: 'decided', headline: 'letting the advisor fix land', options: [{ id: 'cut', label: 'Cut it short' }] },
    tx,
  )
  assert.deepEqual(await b.collectVetoes(tx), [], 'nothing has arrived yet')

  // The human taps, minutes later.
  tx.unsolicited = [{ option: 'cut', from: { id: 'mic', kind: 'human' } }]
  const taken = await b.collectVetoes(tx)
  assert.deepEqual(taken, [{ headline: 'letting the advisor fix land', option: 'cut' }])

  // APPENDED, not rewritten. An append-only log that edited its own history could not be
  // trusted about anything else in it, and "decided, then vetoed" is the sequence worth keeping.
  const all = b.decisions()
  assert.equal(all.length, 2)
  assert.equal(all[0]?.answer, undefined, 'the decision as it was taken')
  assert.equal(all[1]?.answer?.option, 'cut', 'and the veto that followed it')
  assert.equal(all[1]?.answer?.by.kind, 'human')
})

test('#184 a late option that was never offered is refused', async (t) => {
  const dir = tempDir(t, 'conclave-notify')
  const tx = new FakeTransport()
  const b = new Broker(dir)
  await b.tell({ kind: 'decided', headline: 'letting it land', options: [{ id: 'cut', label: 'Cut' }] }, tx)

  tx.unsolicited = [{ option: 'deploy', from: { id: 'mic', kind: 'human' } }]
  assert.deepEqual(await b.collectVetoes(tx), [], 'a surface may not widen the choice offered')
  assert.equal(b.decisions().length, 1, 'and nothing is recorded as an answer')
})

test('#184 a transport that cannot poll is not an error, it just has nothing to say', async (t) => {
  const dir = tempDir(t, 'conclave-notify')
  const writeOnly = new FakeTransport({ canReceive: false })
  ;(writeOnly as { poll?: unknown }).poll = undefined
  assert.deepEqual(await new Broker(dir).collectVetoes(writeOnly), [])
})

test('#184 an agent operator has no tell budget, because it IS the budget', async (t) => {
  // The operating agent already decides what is worth a human's attention and has the context to
  // decide well. A budget behind that is a filter behind a filter, and makes the outer one
  // unpredictable: a message it judged worth sending would vanish for reasons it cannot see.
  const dir = tempDir(t, 'conclave-notify')
  const tx = new FakeTransport()
  const b = new Broker(dir, { operator: 'agent' })

  for (let i = 0; i < 5; i += 1) await b.tell({ kind: 'progress', headline: `line ${i}` }, tx)
  assert.equal(tx.sent.length, 5, 'every one reaches the surface')
  assert.equal(b.decisions().filter((d) => d.undelivered === 'budgeted').length, 0)
})

test('#184 a human operator gets a channel budget, and what it swallows is recorded', async (t) => {
  // No filter in this mode, and this is where a HUD floods. A budget for the CHANNEL rather than
  // the episode, so a run producing a hundred of something produces one line rather than a
  // hundred -- and the ones it held are on the record, because a channel that quietly ate a
  // message is indistinguishable from one that was not working.
  const dir = tempDir(t, 'conclave-notify')
  const tx = new FakeTransport()
  const b = new Broker(dir, { operator: 'human' })

  for (let i = 0; i < 5; i += 1) await b.tell({ kind: 'progress', headline: `line ${i}` }, tx)
  assert.equal(tx.sent.length, 1, 'one got through')
  const budgeted = b.decisions().filter((d) => d.undelivered === 'budgeted')
  assert.equal(budgeted.length, 4, 'and the rest are recorded as held, not lost')
})

test('#184 the budget never applies to a question', async (t) => {
  // `ask` is someone waiting on an answer. Dropping it would hang the caller rather than quieten
  // the channel, which is the opposite of what a budget is for.
  const dir = tempDir(t, 'conclave-notify')
  const tx = new FakeTransport()
  tx.reply = { option: 'yes', from: { id: 'mic', kind: 'human' } }
  const b = new Broker(dir, { operator: 'human' })

  await b.tell({ kind: 'progress', headline: 'first' }, tx)
  const answer = await b.ask({ kind: 'approval', headline: 'Merge?', options: [{ id: 'yes', label: 'Yes' }] }, tx)
  assert.equal(answer?.option, 'yes', 'the question went through the budget that had just fired')
})
