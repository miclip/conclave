/**
 * The `Transport` wrapper, driven through the broker the way the operating agent drives it.
 *
 *   node --test src/notify/evenRealities/transport.test.ts
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Broker } from '../broker.ts'
import { transportNames, resolveTransport } from '../registry.ts'
import { EvenRealitiesTransport } from './transport.ts'

const repo = () => realpathSync(mkdtempSync(join(tmpdir(), 'conclave-er-')))

async function up(): Promise<EvenRealitiesTransport> {
  const t = new EvenRealitiesTransport({ port: 0, token: 'tok', sessionId: 's' })
  await t.listen()
  return t
}

/** Answer whatever question is outstanding, as the app would. */
async function answer(t: EvenRealitiesTransport, text: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 80))
  await fetch(`${t.bridge.url}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's', answer: text }),
  })
}

test('#184 it is registered, so --transport even-realities resolves', () => {
  assert.ok(transportNames().includes('even-realities'))
  const t = resolveTransport('even-realities')
  assert.equal(t?.name, 'even-realities')
  assert.equal(t?.limits.canReceive, true)
})

test('#184 a tap on an offered option comes back as that option', async (t2) => {
  // The label is what the glasses show and what the answer carries; the id is what the broker
  // refuses if it was never offered. Mapping one to the other here is what keeps a tap an
  // action rather than prose.
  const t = await up()
  t2.after(() => t.close())
  const dir = repo()

  const asking = new Broker(dir).ask(
    {
      kind: 'approval',
      headline: 'Merge fix-er-adapter?',
      options: [
        { id: 'yes', label: 'Merge' },
        { id: 'no', label: 'Hold' },
      ],
      href: 'https://example.test/pr/1',
    },
    t,
  )
  await answer(t, 'Merge')

  assert.deepEqual(await asking, { option: 'yes', by: { id: 'even-realities', kind: 'human' } })
  const [rec] = new Broker(dir).decisions()
  assert.equal(rec?.answer?.by.kind, 'human', 'a human answered, and the record says so')
  assert.equal(rec?.transport, 'even-realities')
})

test('#184 speech that is not an offered label comes back as text for the caller', async (t2) => {
  // The rule the whole inbound design rests on: nothing here parses English into an action. An
  // utterance is text, and the operating agent -- which has the context -- decides what it meant.
  const t = await up()
  t2.after(() => t.close())

  const asking = new Broker(repo()).ask(
    { kind: 'approval', headline: 'Merge?', options: [{ id: 'yes', label: 'Merge' }] },
    t,
  )
  await answer(t, 'hold off until the advisor finishes')

  const got = await asking
  assert.equal(got?.option, undefined, 'speech must not become an option')
  assert.equal(got?.text, 'hold off until the advisor finishes')
})

test('#184 a tell is a notification and never opens a question', async (t2) => {
  // `tell` must not put a dialog in front of someone that nothing is waiting on. Asserted by
  // the bridge staying answerable: a question outstanding would refuse the next one.
  const t = await up()
  t2.after(() => t.close())

  await new Broker(repo()).tell({ kind: 'decided', headline: 'letting the advisor fix land' }, t)

  const msgs = (await (await fetch(`${t.bridge.url}/api/messages?token=tok`)).json()) as {
    type: string
    title?: string
  }[]
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0]?.type, 'notification', 'a tell announces')
  assert.equal(msgs[0]?.title, 'Decided', 'and the kind names it')
})

test('#184 a veto tapped after the decision reaches the broker through poll', async (t2) => {
  // End to end on the real surface: a `decided` notification carrying an override, a tap that
  // arrives with nothing waiting for it, and the broker attaching it to the decision it vetoes.
  const t = await up()
  t2.after(() => t.close())
  const dir = repo()
  const b = new Broker(dir)

  await b.tell(
    {
      kind: 'decided',
      headline: 'letting the advisor fix land rather than cutting short',
      options: [{ id: 'cut', label: 'Cut it short' }],
    },
    t,
  )

  // The notification carries the override, so a glance shows what can be done about it.
  const msgs = (await (await fetch(`${t.bridge.url}/api/messages?token=tok`)).json()) as { message: string }[]
  assert.match(msgs[0]?.message ?? '', /Cut it short/, 'the veto is on screen')

  // Tapped later, through the endpoint the app uses, with nothing awaiting a reply.
  await fetch(`${t.bridge.url}/api/question-response?token=tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's', answer: 'Cut it short' }),
  })

  const taken = await b.collectVetoes(t)
  assert.deepEqual(taken, [{ headline: 'letting the advisor fix land rather than cutting short', option: 'cut' }])
  const all = b.decisions()
  assert.equal(all.length, 2, 'the decision, then the veto')
  assert.equal(all[1]?.answer?.by.kind, 'human')
})
