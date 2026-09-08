/**
 * A listener that throws must not take the run with it. #263.
 *
 * `HookReceiver` announces deliveries from inside the request's `'end'` handler. Node's
 * EventEmitter dispatches listeners synchronously, so before the fix a listener that threw
 * threw out of `emit`, out of `'end'`, and into nothing -- an I/O callback has no caller to
 * catch it. It became an uncaught exception and the process died.
 *
 * The condition that did it on a real multi-hour session is a prompt-fidelity correlation
 * fault: a harness-injected block reached the child while a send was in flight and was matched
 * against it. The diagnosis for that case says, in its own words, `the send is refused so
 * nothing downstream treats the other message as this one` -- the turn is already recorded
 * against what the child took, so the situation is bounded and the run is meant to carry on.
 * It did not carry on. It exited with a stack trace and left `state=running alive=false
 * abandoned=true`.
 *
 * So the fault under test was never the detection or the diagnosis. It was that a recoverable
 * refusal is raised in a place where raising is fatal. These tests pin the containment at the
 * receiver's dispatch boundary, and they pin all three ways the fault can reach an operator
 * from there, because a contained fault that nobody ever reads is the failure mode the
 * containment introduces:
 *
 *   1. a `listener_error` listener is registered  -- it gets the fault, structured, verbatim
 *   2. nobody is listening                        -- stderr, verbatim
 *   3. the listener_error listener throws too     -- stderr, verbatim, plus why reporting failed
 *
 * WHY A SUBPROCESS. What is being asserted is that the PROCESS survives. `node --test`
 * installs its own `uncaughtException` handler and charges the throw to the running test, so
 * in-process a regression looks like an ordinary assertion failure and the thing the issue is
 * about -- the run dying -- is exactly what cannot be observed. A child that reports its own
 * survival on stdout, and whose exit code is the verdict, can observe it.
 *
 * The diagnosis is used verbatim: the child builds it with the production
 * `describePromptMismatch` and refuses to run if that no longer produces the `unrelated`
 * shape, so the fixture cannot quietly stop reproducing the reported condition.
 *
 *   node --test src/hooks/receiverListenerThrow.test.ts
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { describePromptMismatch } from '../adapters/promptFidelity.ts'
import { describeListenerFailure } from './receiver.ts'
import { suiteTempDir } from '../testkit/tempDir.ts'

const SCRATCH = suiteTempDir('orch-receiver-listener-throw')

/** The advisor envelope that was in flight. */
const SENT = `[FROM THE ADVISOR (advisor) — a peer AI model, not the operator]

Add the failing regression test and report what it fails on.`

/** What the child actually took instead: a harness block that arrived mid-send. */
const TOOK =
  `<system-reminder>Codebase and user instructions are shown below. Be sure to adhere ` +
  `to these instructions.</system-reminder>`

/**
 * The real diagnosis, from the real detector. Shared with the child by construction rather
 * than by a copied string, so what the test asserts is preserved is what production writes.
 */
const MISMATCH = describePromptMismatch(SENT, TOOK)

/** What the reporting listener throws when the test is asking what happens if IT fails. */
const REPORTING_FAILURE = 'the listener_error listener is broken too'

/** The child prints one machine-readable line; everything else it writes is diagnosis. */
const RESULT = '__RECEIVER_SURVIVED__'

/** Which emit the fault escapes from. */
type ThrowOn = 'delivery' | 'duplicate'

/** What the child does about `listener_error` -- the three routes the fault can take out. */
type Reporting = 'listening' | 'none' | 'throwing'

interface Reported {
  event: string
  deliveryId: string
  message: string
  described: string
}

interface ChildReport {
  statuses: (number | string)[]
  delivered: string[]
  duplicated: string[]
  reported: Reported[]
  journalHasAfter: boolean
}

/**
 * A standalone receiver, one throwing listener, and a delivery after the throw.
 *
 * Everything but `throwOn` and `reporting` is identical across the tests, so a failure in one
 * and not another says which emit, or which reporting route, is the one that broke.
 */
function childSource(throwOn: ThrowOn, reporting: Reporting, journalPath: string): string {
  const receiver = pathToFileURL(join(import.meta.dirname, 'receiver.ts')).href
  const fidelity = pathToFileURL(
    join(import.meta.dirname, '..', 'adapters', 'promptFidelity.ts'),
  ).href

  return `
import { HookReceiver, describeListenerFailure } from ${JSON.stringify(receiver)}
import { CorruptedPromptError, describePromptMismatch } from ${JSON.stringify(fidelity)}

const SENT = ${JSON.stringify(SENT)}
const TOOK = ${JSON.stringify(TOOK)}
const THROW_ON = ${JSON.stringify(throwOn)}
const REPORTING = ${JSON.stringify(reporting)}

// The fixture must still be the reported condition. A mismatch that has drifted to another
// shape is a different fault and would make a pass here mean nothing.
const mismatch = describePromptMismatch(SENT, TOOK)
if (!mismatch || mismatch.shape !== 'unrelated') {
  console.error('fixture no longer produces a correlation fault: ' + (mismatch ? mismatch.shape : 'no mismatch at all'))
  process.exit(3)
}

const receiver = new HookReceiver(${JSON.stringify(journalPath)})
const url = await receiver.start()

const delivered = []
const duplicated = []
const reported = []

// Exactly what the adapters do -- \`receiver.on('delivery', (d) => this.#onHook(d))\` -- with
// the correlation fault raised where \`#onHook\` raises it, out of the listener body.
receiver.on('delivery', (d) => {
  delivered.push(d.deliveryId)
  if (THROW_ON === 'delivery' && d.deliveryId === 'fault') {
    throw new CorruptedPromptError(mismatch, 'turn-1')
  }
})
receiver.on('duplicate', (d) => {
  duplicated.push(d.deliveryId)
  if (THROW_ON === 'duplicate' && d.deliveryId === 'fault') {
    throw new CorruptedPromptError(mismatch, 'turn-1')
  }
})

// 'none' registers nothing at all, which is the point of that case: the receiver must not
// require a subscriber in order to be safe.
if (REPORTING !== 'none') {
  receiver.on('listener_error', (f) => {
    // Recorded before the throw below, so the 'throwing' case still proves the fault ARRIVED
    // and only the reporting of it failed.
    reported.push({
      event: f.event,
      deliveryId: f.delivery.deliveryId,
      message: f.message,
      described: describeListenerFailure(f),
    })
    if (REPORTING === 'throwing') throw new Error(${JSON.stringify(REPORTING_FAILURE)})
  })
}

async function post(id) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt_id: id, prompt: TOOK }),
      headers: {
        'content-type': 'application/json',
        'x-orch-agent': 'claude',
        'x-orch-delivery-id': id,
        'x-orch-hook-pid': String(process.pid),
      },
    })
    await res.arrayBuffer()
    return res.status
  } catch (e) {
    // A dead receiver refuses the connection rather than answering. That is a result too.
    return 'POST FAILED: ' + String(e)
  }
}

const statuses = []
statuses.push(await post('fault'))
// The replay is what makes the second delivery a duplicate rather than a fresh one.
if (THROW_ON === 'duplicate') statuses.push(await post('fault'))

// The response is written BEFORE the emit, so the POST above resolves 200 even when the throw
// that follows it is fatal. Give an escaping throw its chance to kill this process before the
// next delivery is offered, or "it survived" would only mean "it had not died yet".
await new Promise((r) => setTimeout(r, 150))

statuses.push(await post('after'))
await new Promise((r) => setTimeout(r, 150))
await receiver.stop()

console.log(${JSON.stringify(RESULT)} + JSON.stringify({
  statuses,
  delivered,
  duplicated,
  reported,
  journalHasAfter: receiver.journal.has('after'),
}))
`
}

/** Run the child to completion and hand back everything needed to say what happened. */
function runChild(label: string, throwOn: ThrowOn, reporting: Reporting) {
  const script = join(SCRATCH, `${label}.ts`)
  writeFileSync(script, childSource(throwOn, reporting, join(SCRATCH, label, 'hooks.ndjson')))

  const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 60_000 })
  const stderr = run.stderr ?? ''
  const output = `${run.stdout ?? ''}${stderr}`
  const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith(RESULT))
  const report = line ? (JSON.parse(line.slice(RESULT.length)) as ChildReport) : undefined
  return { run, stderr, output, report }
}

/**
 * The half of every case that is the same: the process lived, and the receiver went on
 * receiving. Survival alone is not the fix -- the refusal is meant to be RECOVERABLE, which
 * means a later hook still lands, is journalled, and is announced.
 */
function assertSurvivedAndKeptReceiving(
  label: string,
  { run, output, report }: ReturnType<typeof runChild>,
): ChildReport {
  assert.equal(
    run.status,
    0,
    `${label}: the receiver's process must survive the throw; exited ${run.status} ` +
      `signal=${run.signal}\n--- child output ---\n${output.slice(0, 4000)}`,
  )
  assert.ok(report, `${label}: the child must report its survival; output was:\n${output.slice(0, 4000)}`)
  assert.ok(
    report.delivered.includes('after'),
    `${label}: a delivery after the throw must still be emitted; saw ${JSON.stringify(report.delivered)}`,
  )
  assert.equal(report.journalHasAfter, true, `${label}: and must still be journalled`)
  assert.equal(report.statuses.at(-1), 200, `${label}: and must still be acknowledged`)
  return report
}

test('#263 a throwing delivery listener is contained and reported, not raised', () => {
  assert.ok(MISMATCH, 'the fixture must still produce a mismatch at all')
  assert.equal(MISMATCH.shape, 'unrelated', 'and it must still be the correlation fault')

  const report = assertSurvivedAndKeptReceiving(
    'delivery',
    runChild('delivery-throw', 'delivery', 'listening'),
  )

  // Structured, so a consumer can act on it rather than parse a log line: which emit, which
  // delivery, and the thrown text unaltered.
  assert.equal(report.reported.length, 1, `exactly one failure should be reported; saw ${JSON.stringify(report.reported)}`)
  const [failure] = report.reported
  assert.equal(failure!.event, 'delivery', 'the report must name the emit the throw escaped from')
  assert.equal(failure!.deliveryId, 'fault', 'and the delivery being announced when it happened')
  assert.equal(
    failure!.message,
    MISMATCH.message,
    'and the thrown message verbatim -- the diagnosis is several sentences of reasoning an ' +
      'operator is meant to read, and a summary of it is worth nothing',
  )
  assert.ok(
    failure!.described.includes(MISMATCH.message),
    'the shared phrasing the adapters emit must carry the diagnosis verbatim too',
  )
})

test('#263 a throwing duplicate listener is contained and reported too', () => {
  assert.ok(MISMATCH, 'the fixture must still produce a mismatch at all')

  // The same boundary, the other emit. A replayed hook is the ordinary recovery path -- the
  // client replays whenever an acknowledgement was lost -- so the `duplicate` listener runs on
  // exactly the deliveries that arrive after something already went wrong, which is the worst
  // moment to take the process out.
  const report = assertSurvivedAndKeptReceiving(
    'duplicate',
    runChild('duplicate-throw', 'duplicate', 'listening'),
  )

  assert.ok(
    report.duplicated.includes('fault'),
    `the replay must have reached the duplicate listener; saw ${JSON.stringify(report.duplicated)}`,
  )
  assert.equal(report.reported.length, 1, `exactly one failure should be reported; saw ${JSON.stringify(report.reported)}`)
  assert.equal(report.reported[0]!.event, 'duplicate', 'the report must name the duplicate emit')
  assert.equal(report.reported[0]!.message, MISMATCH.message, 'with the thrown message verbatim')
})

test('#263 with nobody listening for the failure it goes to stderr rather than nowhere', () => {
  assert.ok(MISMATCH, 'the fixture must still produce a mismatch at all')

  const outcome = runChild('no-reporter', 'delivery', 'none')
  const report = assertSurvivedAndKeptReceiving('unreported', outcome)
  assert.deepEqual(report.reported, [], 'this case registers no listener, by design')

  // The failure mode containment introduces. A crash at least left a stack; a correlation
  // fault that vanishes leaves an operator with a run that behaved strangely and nothing to
  // read. The receiver must not need a subscriber in order to be honest.
  assert.ok(
    outcome.stderr.includes(MISMATCH.message),
    `the diagnosis must reach stderr verbatim; stderr was:\n${outcome.stderr.slice(0, 4000)}`,
  )
})

test('#263 a listener_error listener that throws as well still cannot silence or kill the run', () => {
  assert.ok(MISMATCH, 'the fixture must still produce a mismatch at all')

  const outcome = runChild('throwing-reporter', 'delivery', 'throwing')
  const report = assertSurvivedAndKeptReceiving('reporting-threw', outcome)

  // The fault ARRIVED; only the reporting of it failed. Both facts have to survive.
  assert.equal(report.reported.length, 1, 'the reporting listener did run')
  assert.equal(report.reported[0]!.message, MISMATCH.message, 'and saw the diagnosis verbatim')
  assert.ok(
    outcome.stderr.includes(MISMATCH.message),
    `the diagnosis must still reach stderr verbatim; stderr was:\n${outcome.stderr.slice(0, 4000)}`,
  )
  assert.ok(
    outcome.stderr.includes(REPORTING_FAILURE),
    `and stderr must say why reporting failed, or the operator is left wondering why the ` +
      `session stream is missing it; stderr was:\n${outcome.stderr.slice(0, 4000)}`,
  )
})

test('the shared phrasing keeps the thrown message verbatim', () => {
  assert.ok(MISMATCH, 'the fixture must still produce a mismatch at all')

  // What the three adapters turn into a non-fatal `AgentEvent` and what the stderr fallback
  // prints are the same sentence, from here. Two phrasings of one fault is how a reader ends
  // up believing they are two.
  const described = describeListenerFailure({
    event: 'delivery',
    delivery: {
      deliveryId: 'd1',
      agent: 'claude',
      event: 'UserPromptSubmit',
      payload: {},
      firedAt: 1,
      hookPid: 7,
      receivedAt: 2,
    },
    error: new Error(MISMATCH.message),
    message: MISMATCH.message,
  })

  assert.ok(described.includes(MISMATCH.message), 'the diagnosis must survive unaltered')
  assert.ok(described.includes('d1'), 'and the delivery must be nameable')
  assert.ok(described.includes("'delivery'"), 'and the emit it escaped from')
})
