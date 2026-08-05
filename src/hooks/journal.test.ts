/**
 * Delivery durability and identity.
 *
 *   node --test src/hooks/journal.test.ts
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { HookJournal, mintDeliveryId } from './journal.ts'
import { HookReceiver } from './receiver.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'orch-journal-'))

function delivery(id: string, event = 'Stop') {
  return {
    deliveryId: id,
    agent: 'claude',
    event,
    payload: { hook_event_name: event },
    firedAt: 1,
    hookPid: 2,
  }
}

test('a delivery identity is stable across replays of the same attempt', () => {
  const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 'abc' })
  const a = mintDeliveryId(payload, 4242, 1785948148.123456)
  const b = mintDeliveryId(payload, 4242, 1785948148.123456)
  assert.equal(a, b, 'replaying the same attempt must reproduce its identity')
})

test('identical payloads from different attempts are different deliveries', () => {
  // Two genuine Stop deliveries in one session can carry byte-identical payloads.
  // Hashing the payload alone would silently collapse them into one.
  const payload = JSON.stringify({ hook_event_name: 'Stop' })
  assert.notEqual(
    mintDeliveryId(payload, 100, 1785948148.0),
    mintDeliveryId(payload, 101, 1785948148.0),
    'different hook processes are different deliveries',
  )
  assert.notEqual(
    mintDeliveryId(payload, 100, 1785948148.0),
    mintDeliveryId(payload, 100, 1785948149.0),
    'different fire times are different deliveries',
  )
})

test('the journal deduplicates replays', () => {
  const j = new HookJournal(join(SCRATCH, 'dedup.ndjson'))
  assert.equal(j.appendDurable(delivery('aaa')), true)
  assert.equal(j.appendDurable(delivery('aaa')), false, 'a replay must not be appended twice')
  assert.equal(j.appendDurable(delivery('bbb')), true)
  assert.equal(j.read().length, 2)
})

test('dedup survives a restart, because that is when replay happens', () => {
  const path = join(SCRATCH, 'restart.ndjson')
  const first = new HookJournal(path)
  first.appendDurable(delivery('ccc'))

  // A fresh receiver process, e.g. after the adapter crashed and recovery replays.
  const second = new HookJournal(path)
  assert.equal(second.has('ccc'), true, 'identities must be recovered from disk')
  assert.equal(second.appendDurable(delivery('ccc')), false)
})

test('a torn final line does not poison recovery', () => {
  const path = join(SCRATCH, 'torn.ndjson')
  writeFileSync(path, JSON.stringify({ deliveryId: 'ddd' }) + '\n{"deliveryId":"partial')
  const j = new HookJournal(path)
  assert.equal(j.has('ddd'), true)
  assert.equal(j.appendDurable(delivery('eee')), true, 'a torn tail must not block new writes')
})

test('the receiver journals durably before acknowledging', async (t) => {
  const path = join(SCRATCH, 'ack-order.ndjson')
  const receiver = new HookReceiver(path)
  const url = await receiver.start()
  t.after(() => receiver.stop())

  const body = JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-1', prompt_id: 'p1' })
  const res = await fetch(url, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-orch-agent': 'claude',
      'x-orch-delivery-id': 'fixed-id',
      'x-orch-hook-pid': '7',
      'x-orch-fired-at': '1.5',
    },
  })
  assert.equal(res.status, 200)

  // By the time the client sees 200, the record must already be on disk. An ack that
  // outruns the write turns a crash into silent loss: the sender will never replay.
  const onDisk = readFileSync(path, 'utf8')
  assert.ok(onDisk.includes('fixed-id'), 'the delivery must be durable before the ack')

  const parsed = await res.json()
  assert.equal(parsed.duplicate, false)
  assert.equal(receiver.journal.has('fixed-id'), true)
})

test('a replayed delivery is acknowledged, reported, and not double-counted', async (t) => {
  const path = join(SCRATCH, 'replay.ndjson')
  const receiver = new HookReceiver(path)
  const url = await receiver.start()
  t.after(() => receiver.stop())

  const fresh: string[] = []
  const dupes: string[] = []
  receiver.on('delivery', (d) => fresh.push(d.deliveryId))
  receiver.on('duplicate', (d) => dupes.push(d.deliveryId))

  const post = () =>
    fetch(url, {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'Stop' }),
      headers: { 'content-type': 'application/json', 'x-orch-delivery-id': 'replayed' },
    }).then((r) => r.json())

  assert.equal((await post()).duplicate, false)
  assert.equal((await post()).duplicate, true)

  assert.deepEqual(fresh, ['replayed'])
  assert.deepEqual(dupes, ['replayed'], 'replays are surfaced, not silently swallowed')
  assert.equal(receiver.journal.read().length, 1)
})

test('the turn key is lifted from whichever field the agent uses', async (t) => {
  const path = join(SCRATCH, 'turnkey.ndjson')
  const receiver = new HookReceiver(path)
  const url = await receiver.start()
  t.after(() => receiver.stop())

  const seen: (string | undefined)[] = []
  receiver.on('delivery', (d) => seen.push(d.turnKey))

  for (const [i, payload] of [{ prompt_id: 'claude-key' }, { turn_id: 'codex-key' }].entries()) {
    await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'Stop', ...payload }),
      headers: { 'content-type': 'application/json', 'x-orch-delivery-id': `k${i}` },
    })
  }
  assert.deepEqual(seen, ['claude-key', 'codex-key'])
})
