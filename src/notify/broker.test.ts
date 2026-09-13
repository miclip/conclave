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
import { Broker, decisionsPath, forTransport, resolveLabel } from './broker.ts'
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

  const carried = forTransport(smuggled, { maxChars: 200, canPresentOptions: true })
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
  assert.match(forTransport(leaky, { maxChars: 200, canPresentOptions: true }).headline, /hunter2/, 'prose travels as written')
  // The cap is a rendering budget, not a redaction: it exists so a HUD gets a line it can show.
  assert.equal(forTransport(leaky, { maxChars: 20, canPresentOptions: true }).headline.length, 20)
})

test('#184 a headline is cut to what the surface can show, and href carries the rest', () => {
  // A HUD line and a chat message are the same message at different budgets. Truncated rather
  // than refused: a surface that cannot show the whole line should still show the line.
  const hud = forTransport(APPROVAL, { maxChars: 20, canPresentOptions: true })
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

test('#292 text that is the whole label, whitespace and case aside, is that option', async (t) => {
  // A surface that cannot render a choice still shows the question, so the operator types or
  // says the label -- and neither reliably keeps case or whitespace. The text is kept beside
  // the id, so the record shows what was actually said.
  const dir = tempDir(t, 'conclave-notify')
  const b = new Broker(dir)

  const said = new FakeTransport()
  said.reply = { text: '  merge  ', from: { id: 'mic', kind: 'human' } }
  assert.deepEqual(await b.ask(APPROVAL, said), { option: 'yes', text: '  merge  ', by: { id: 'mic', kind: 'human' } })

  const shouted = new FakeTransport()
  shouted.reply = { text: 'DO NOT MERGE', from: { id: 'mic', kind: 'human' } }
  assert.deepEqual(await b.ask(APPROVAL, shouted), { option: 'no', text: 'DO NOT MERGE', by: { id: 'mic', kind: 'human' } })

  // The label was offered with stray whitespace of its own; the comparison trims both sides.
  const padded = new FakeTransport()
  padded.reply = { text: 'hold', from: { id: 'mic', kind: 'human' } }
  const answer = await b.ask({ kind: 'approval', headline: 'Merge?', options: [{ id: 'wait', label: ' Hold ' }] }, padded)
  assert.equal(answer?.option, 'wait')
})

test('#292 the whole label and nothing more: an extended phrase is a message', async (t) => {
  // "merge it" is not `Merge`, and "merge, then deploy" is not either. Anything short of the
  // full label is prose for the caller to read; a prefix match here would be the parser the
  // inbound design refuses to have.
  const dir = tempDir(t, 'conclave-notify')
  const b = new Broker(dir)
  for (const text of ['merge it', 'Merge, then deploy', 'do not', 'not merge', 'Merge Merge']) {
    const tx = new FakeTransport()
    tx.reply = { text, from: { id: 'mic', kind: 'human' } }
    const answer = await b.ask(APPROVAL, tx)
    assert.equal(answer?.option, undefined, `${JSON.stringify(text)} must stay a message`)
    assert.equal(answer?.text, text, 'and travel as written')
  }
  assert.ok(b.decisions().every((d) => d.answer?.option === undefined), 'none of them is an option on the record')
})

test('#292 two options shown as one label make the text ambiguous, and it stays a message', async (t) => {
  // Refused rather than guessed between. The caller made the text ambiguous by offering it
  // twice; picking the first would be inventing an answer.
  const dir = tempDir(t, 'conclave-notify')
  const tx = new FakeTransport()
  tx.reply = { text: 'go', from: { id: 'mic', kind: 'human' } }
  const answer = await new Broker(dir).ask(
    { kind: 'direction', headline: 'Which?', options: [{ id: 'a', label: 'Go' }, { id: 'b', label: 'go' }] },
    tx,
  )
  assert.deepEqual(answer, { text: 'go', by: { id: 'mic', kind: 'human' } })
  assert.equal(resolveLabel('go', [{ id: 'a', label: 'Go' }, { id: 'b', label: 'go' }]), undefined)
  assert.equal(resolveLabel('   ', [{ id: 'a', label: ' ' }]), undefined, 'blank text matches nothing, even a blank label')
})

test('#292 a tap, a matched label and a message are three different records', async (t) => {
  // The distinction is evidence. Six months later the record has to be able to say whether the
  // operator pressed a button the surface rendered, or said a word that happened to be the
  // label -- and the second is a step from prose to selection that should stay visible.
  const dir = tempDir(t, 'conclave-notify')
  const b = new Broker(dir)

  const tapped = new FakeTransport()
  tapped.reply = { option: 'yes', from: { id: 'mic', kind: 'human' } }
  await b.ask(APPROVAL, tapped)

  const matched = new FakeTransport()
  matched.reply = { text: 'Merge', from: { id: 'mic', kind: 'human' } }
  await b.ask(APPROVAL, matched)

  const spoken = new FakeTransport()
  spoken.reply = { text: 'not yet', from: { id: 'mic', kind: 'human' } }
  await b.ask(APPROVAL, spoken)

  assert.deepEqual(
    b.decisions().map((d) => [d.answer?.option, d.answer?.text]),
    [
      ['yes', undefined],
      ['yes', 'Merge'],
      [undefined, 'not yet'],
    ],
    'a tap has no text, a match keeps its text, a message has no option',
  )
  // What was shown, by id, is on every record: `collectVetoes` reads it back in a process
  // that never saw the question.
  for (const d of b.decisions()) assert.deepEqual(d.labels, { yes: 'Merge', no: 'Do not merge' })
})

test('#292 a late veto typed as the label attaches as the option, from the record alone', async (t) => {
  // `conclave notify vetoes` is its own process: nothing in memory knows what the `tell`
  // offered. A fresh Broker over the same directory is that process, and the record is its
  // only witness to the labels.
  const dir = tempDir(t, 'conclave-notify')
  const tx = new FakeTransport()
  await new Broker(dir).tell(
    { kind: 'decided', headline: 'letting the advisor fix land', options: [{ id: 'cut', label: 'Cut it short' }] },
    tx,
  )

  tx.unsolicited = [{ text: 'cut it short ', from: { id: 'mic', kind: 'human' } }]
  const taken = await new Broker(dir).collectVetoes(tx)
  assert.deepEqual(taken, [{ headline: 'letting the advisor fix land', option: 'cut', text: 'cut it short ' }])
  const all = new Broker(dir).decisions()
  assert.equal(all.length, 2)
  assert.deepEqual(all[1]?.answer, { option: 'cut', text: 'cut it short ', by: { id: 'mic', kind: 'human' } })
  assert.deepEqual(all[1]?.labels, { cut: 'Cut it short' }, 'the veto line carries the labels forward too')
})

test('#292 a late answer that is not the label is a message, and still attaches', async (t) => {
  const dir = tempDir(t, 'conclave-notify')
  const tx = new FakeTransport()
  const b = new Broker(dir)
  await b.tell({ kind: 'decided', headline: 'letting it land', options: [{ id: 'cut', label: 'Cut it short' }] }, tx)

  tx.unsolicited = [{ text: 'cut it short, and tell me why', from: { id: 'mic', kind: 'human' } }]
  const taken = await b.collectVetoes(tx)
  assert.deepEqual(taken, [{ headline: 'letting it land', text: 'cut it short, and tell me why' }])
  assert.equal(b.decisions()[1]?.answer?.option, undefined)
})

test('#292 a record written before labels were kept resolves nothing: its text stays text', async (t) => {
  // Older logs carry `offered` and no `labels`. Matching the text against an id would be the
  // one thing this never does -- the id was never shown to anyone.
  const dir = tempDir(t, 'conclave-notify')
  mkdirSync(dirname(decisionsPath(dir)), { recursive: true })
  writeFileSync(
    decisionsPath(dir),
    '{"at":1,"transport":"fake","kind":"decided","headline":"old","offered":["cut"]}\n',
  )
  const tx = new FakeTransport()
  tx.unsolicited = [{ text: 'cut', from: { id: 'mic', kind: 'human' } }]
  const taken = await new Broker(dir).collectVetoes(tx)
  assert.deepEqual(taken, [{ headline: 'old', text: 'cut' }])
})

test('#292 a surface that cannot show a choice gets the labels in the headline; one that can does not', async (t) => {
  // Declared by the transport, acted on by the broker: the operator of a HUD that renders only
  // the question must still be able to read what is on offer. The structured options travel
  // either way -- an answer is routed by them.
  const dir = tempDir(t, 'conclave-notify')
  const b = new Broker(dir)
  const q: Outbound = { kind: 'approval', headline: 'Merge?', options: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }] }

  const capable = new FakeTransport({ canPresentOptions: true })
  capable.reply = { option: 'y', from: { id: 'mic', kind: 'human' } }
  await b.ask(q, capable)
  assert.equal(capable.sent[0]?.headline, 'Merge?', 'buttons will show the choice; the line stays the question')
  assert.deepEqual(capable.sent[0]?.options, q.options)

  const hud = new FakeTransport({ canPresentOptions: false })
  hud.reply = { text: 'yes', from: { id: 'mic', kind: 'human' } }
  const answer = await b.ask(q, hud)
  assert.equal(hud.sent[0]?.headline, 'Merge? — Yes / No', 'the choices are in the only line it shows')
  assert.deepEqual(hud.sent[0]?.options, q.options, 'and still travel structured, for routing')
  assert.deepEqual(answer, { option: 'y', text: 'yes', by: { id: 'mic', kind: 'human' } }, 'so the label said back resolves')

  // Both verbs: a `decided` tell carries its veto the same way.
  await b.tell({ kind: 'decided', headline: 'letting it land', options: [{ id: 'cut', label: 'Cut it short' }] }, hud)
  assert.equal(hud.sent[1]?.headline, 'letting it land — Cut it short')
  await b.tell({ kind: 'decided', headline: 'letting it land', options: [{ id: 'cut', label: 'Cut it short' }] }, capable)
  assert.equal(capable.sent[1]?.headline, 'letting it land')

  // A message with nothing to choose is untouched on either.
  await b.tell({ kind: 'progress', headline: 'pushed' }, hud)
  assert.equal(hud.sent[2]?.headline, 'pushed')
})

test('#292 the question is kept whole and only the choices are cut to the room that remains', () => {
  // A question with its choices cut is still a question; choices with their question cut are
  // not. The boundaries: everything fits; the suffix is cut; the question alone is exactly the
  // limit; the question alone is over the limit.
  const opts = [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }]
  const hud = { maxChars: 20, canPresentOptions: false }

  // 'Merge? — Yes / No' is 17 chars: fits in 20 untouched.
  assert.equal(forTransport({ kind: 'approval', headline: 'Merge?', options: opts }, hud).headline, 'Merge? — Yes / No')
  // A 12-char question leaves 8: ' — Yes / No' is cut, the question is not.
  const cut = forTransport({ kind: 'approval', headline: 'Merge it now', options: opts }, hud).headline
  assert.equal(cut.length, 20)
  assert.ok(cut.startsWith('Merge it now — '), `the question survives whole: ${JSON.stringify(cut)}`)
  assert.match(cut, /…$/)
  // A question that is exactly the limit has no room, and loses nothing.
  const exact = 'x'.repeat(20)
  assert.equal(forTransport({ kind: 'approval', headline: exact, options: opts }, hud).headline, exact)
  // A question over the limit is cut as it always was, and the choices do not fit anywhere.
  const over = forTransport({ kind: 'approval', headline: 'x'.repeat(30), options: opts }, hud).headline
  assert.equal(over, `${'x'.repeat(19)}…`)
  // The same overlong question on a capable surface is the same line: the cut is not new.
  assert.equal(forTransport({ kind: 'approval', headline: 'x'.repeat(30), options: opts }, { maxChars: 20, canPresentOptions: true }).headline, over)
})

test('#292 the rendering boundary will not take a limits object that leaves the capability unsaid', () => {
  // Typecheck-backed: `npm test` runs `tsc --noEmit` first, and an `@ts-expect-error` that stops
  // erroring is itself an error. A defaulted capability would render a line with the choices
  // silently left off, which is the failure this whole change exists to end.
  const q: Outbound = { kind: 'approval', headline: 'Merge?', options: [{ id: 'y', label: 'Yes' }] }
  // @ts-expect-error -- `canPresentOptions` is required alongside `maxChars`
  forTransport(q, { maxChars: 200 })
  // @ts-expect-error -- and `maxChars` is required alongside `canPresentOptions`
  forTransport(q, { canPresentOptions: false })
  assert.equal(forTransport(q, { maxChars: 200, canPresentOptions: false }).headline, 'Merge? — Yes', 'with both, it renders')
})
