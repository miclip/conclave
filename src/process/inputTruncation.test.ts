/**
 * #174: bytes written to a seat's pty in one burst go missing, silently.
 *
 *   node --test src/process/inputTruncation.test.ts
 *
 * This file is a REPRODUCTION, not a fix. Some of it fails on purpose against
 * `InputQueue.submit()` as it stands; those failures are the evidence, and a fix is what turns
 * them green. Nothing is mocked -- a real pty, a real child, real bytes, and the child records
 * exactly what it was handed.
 *
 * There are TWO defects here, they have different signatures, and the issue conflates them.
 *
 *   A. A newline-free run longer than 1024 bytes is truncated to 1024 in transport. The TAIL
 *      is lost. Measured on darwin 25.5.0, deterministic (10 of 11 observations; one 5000-byte
 *      run passed and did not repeat).
 *   B. A newline in the payload is typed as ENTER. The child submits at that point and the rest
 *      of the message becomes a separate message. The FRONT is lost, at any size.
 *
 * The issue reports the FRONT going missing, so B is the one that produced the field incidents
 * and A is not -- and the tests below say so rather than asserting it. Every message conclave
 * sends a seat goes through `envelope()`, which puts a header and a blank line in front of the
 * body, so the wire always carries a newline at byte 249. That newline lifts A's ceiling
 * entirely: `the wire shape conclave actually sends` below carries 64 KB through the same pty
 * without losing a byte. A cannot be what truncated a 934-byte field message.
 *
 * Four candidate causes, one controlled case each:
 *
 *   1. tty input queue                 RULED IN for A. The same bytes to the same child, paced
 *                                      instead of burst, arrive whole. Only pacing differs.
 *   2. child line-editor behaviour     RULED OUT for A. The recorder child has no line editor,
 *                                      no paste heuristic and no redraw, and loses bytes anyway.
 *                                      It is the whole of B.
 *   3. settle-delay race               RULED OUT. Identical loss at 0 ms, at the production
 *                                      400 ms, and at 2000 ms.
 *   4. embedded-newline early submit   RULED IN, and it is defect B. 302 bytes -- three times
 *                                      under any transport ceiling -- arrive as three messages.
 *
 * Harness caveat, so the recordings are not over-read: the recorder is a Node child in
 * `setRawMode(true)`, which leaves ICRNL on, so a CR it receives is recorded as LF. A real
 * agent TUI sets its own termios and need not match. That is why the conclusions above are
 * drawn from `\n` payloads and byte counts, never from which of CR/LF landed.
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { envelope } from '../relay/message.ts'
import { InputQueue } from './input.ts'
import { PtyProcess } from './pty.ts'

/**
 * A pty child that records the bytes it receives and interprets none of them.
 *
 * It advertises bracketed paste so `PtyProcess.isInteractive` is true, which is what a real
 * seat looks like -- the detection the issue points at is present, and unused, either way.
 */
const RECORDER = `
import { appendFileSync, writeFileSync } from 'node:fs'
const [outfile, delayMs = '0'] = process.argv.slice(2)
writeFileSync(outfile, '')
process.stdout.write('\\x1b[?2004h')
process.stdout.write('READY\\n')
function start() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', (b) => appendFileSync(outfile, b))
  process.stdin.resume()
}
if (Number(delayMs) > 0) setTimeout(start, Number(delayMs))
else start()
setTimeout(() => process.exit(0), 60000)
`

/**
 * A pty child that models a TUI composer: raw mode, a buffer, and CR or LF submits.
 *
 * It honours bracketed paste, because the children conclave drives do -- that is what the
 * `[?2004h` marker means. One JSON record per submission, so an early submission shows up as
 * an extra record rather than as a difference in length.
 */
const COMPOSER = `
import { appendFileSync, writeFileSync } from 'node:fs'
const [outfile] = process.argv.slice(2)
writeFileSync(outfile, '')
process.stdout.write('\\x1b[?2004h')
process.stdout.write('READY\\n')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
let buf = ''
let pasting = false
process.stdin.on('data', (b) => {
  buf += b.toString('binary')
  for (;;) {
    if (!pasting && buf.startsWith('\\x1b[200~')) { pasting = true; buf = buf.slice(6); continue }
    if (pasting) {
      const close = buf.indexOf('\\x1b[201~')
      if (close === -1) break
      appendFileSync(outfile, JSON.stringify({ kind: 'paste', text: buf.slice(0, close) }) + '\\n')
      buf = buf.slice(close + 6)
      pasting = false
      continue
    }
    const m = buf.search(/[\\r\\n]/)
    if (m === -1) break
    appendFileSync(outfile, JSON.stringify({ kind: 'submit', text: buf.slice(0, m) }) + '\\n')
    buf = buf.slice(m + 1)
  }
})
process.stdin.resume()
setTimeout(() => process.exit(0), 60000)
`

const dir = mkdtempSync(join(tmpdir(), 'conclave-174-'))
const recorderPath = join(dir, 'recorder.mjs')
const composerPath = join(dir, 'composer.mjs')
writeFileSync(recorderPath, RECORDER)
writeFileSync(composerPath, COMPOSER)

let seq = 0

/**
 * A payload that carries its own offsets and contains no newline.
 *
 * `[000000][000010]...` means a fragment says where in the message it came from, so a failure
 * reports "lost the first N bytes" or "lost from N on" instead of "lengths differ". Newline-free
 * is load-bearing: a newline anywhere in the first 1024 bytes changes the answer, which is what
 * `a newline inside the first 1024 bytes lifts the ceiling` exists to pin.
 */
function payload(n: number): string {
  let s = ''
  let i = 0
  while (s.length < n) {
    s += `[${String(i).padStart(6, '0')}]`
    i += 10
  }
  return s.slice(0, n)
}

interface Child {
  pty: PtyProcess
  read: () => string
}

/** `readAfterMs` delays the child's first read, to hold the tty input queue full on purpose. */
async function spawnChild(script: string, readAfterMs = 0): Promise<Child> {
  const out = join(dir, `recording-${seq++}.bin`)
  const pty = await PtyProcess.spawn({
    file: process.execPath,
    args: [script, out, String(readAfterMs)],
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? dir, TERM: 'xterm-256color' },
  })
  assert.ok(await pty.waitForOutput((s) => s.includes('READY'), 10_000), 'child never announced READY')
  // utf8, not latin1: the real envelope carries an em dash, and a decoding difference must not
  // be reported as a lost byte.
  return { pty, read: () => readFileSync(out, 'utf8') }
}

async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** Bytes are evidence; a child left running is not. */
async function stop(pty: PtyProcess): Promise<void> {
  try {
    await pty.terminate({ graceMs: 500, killAfterMs: 500 })
  } catch {
    /* already gone */
  }
}

/**
 * Fail if any part of `sent` did not arrive, and say WHICH part.
 *
 * A trailing CR/LF is transport, not payload, so it is stripped before comparing; nothing else
 * is forgiven. `lost the first N` and `lost the last N` are different defects and the message
 * has to distinguish them, because that is the whole question this file answers.
 */
function assertWholeMessageArrived(sent: string, received: string, label: string): void {
  const got = received.replace(/[\r\n]+$/, '')
  if (got === sent) return

  let detail: string
  if (sent.startsWith(got)) {
    detail = `lost the last ${sent.length - got.length}: got ${got.length}/${sent.length}, the TAIL is missing`
  } else if (sent.endsWith(got)) {
    detail = `lost the first ${sent.length - got.length}: got ${got.length}/${sent.length}, the FRONT is missing`
  } else {
    detail = `got ${got.length}/${sent.length}, and they are neither a prefix nor a suffix of what was sent`
  }
  assert.fail(
    `${label}: ${detail}\n` +
      `  sent  head=${JSON.stringify(sent.slice(0, 32))} tail=${JSON.stringify(sent.slice(-16))}\n` +
      `  got   head=${JSON.stringify(got.slice(0, 32))} tail=${JSON.stringify(got.slice(-16))}`,
  )
}

/** One production `submit()` into a fresh recorder. Returns what arrived. */
async function submitAndRecord(text: string): Promise<string> {
  const { pty, read } = await spawnChild(recorderPath)
  try {
    await new InputQueue(pty).submit(text)
    await settle(600)
    return read()
  } finally {
    await stop(pty)
  }
}

/**
 * The sweep, straddling the ceiling measured on this machine.
 *
 * The sizes are not the issue's, which are message-body sizes and do not include the 249-byte
 * envelope; `the two field byte counts` below carries those.
 */
const SWEEP = [256, 768, 1000, 1024, 1025, 1200, 2048, 4096]

for (const n of SWEEP) {
  test(`#174 a ${n} B newline-free message survives submit() into a real pty`, async () => {
    const text = payload(n)
    assertWholeMessageArrived(text, await submitAndRecord(text), `${n} B via InputQueue.submit`)
  })
}

test('#174 a newline inside the first 1024 bytes lifts the ceiling; one past it does not', async () => {
  // The precise rule, and the reason defect A does not explain the field reports. Only \n does
  // this: TAB and ESC at the same offset were measured NOT to lift it.
  const early = `${payload(500)}\n${payload(4500)}`
  assertWholeMessageArrived(early, await submitAndRecord(early), 'newline at byte 500, 5001 B total')

  const late = `${payload(1030)}\n${payload(4000)}`
  const got = await submitAndRecord(late)
  assert.equal(
    got.replace(/[\r\n]+$/, '').length,
    1024,
    'a newline at byte 1030 is one byte past the ceiling and must not rescue the write',
  )
})

test('#174 the wire shape conclave actually sends is NOT truncated, at any size', async () => {
  // envelope() puts a header and a blank line in front of every message, so byte 249 is a
  // newline on every send. This is the measurement that moves the diagnosis off the tty queue:
  // 64 KB through the same pty, same child, not a byte lost.
  for (const bodyBytes of [245, 934, 64_000]) {
    const wire = envelope({
      from: 'advisor',
      fromRank: 'advisor',
      kind: 'instruction',
      text: payload(bodyBytes),
    })
    const got = await submitAndRecord(wire)
    assertWholeMessageArrived(wire, got, `${bodyBytes} B body = ${Buffer.byteLength(wire)} B on the wire`)
  }
})

test('#174 the two field byte counts, carried in the real envelope', async () => {
  // The issue's bracket -- 245 B arrived intact, 934 B was truncated -- read as byte counts.
  // Both arrive whole here. What separates them in the field is not size: a 245 B message is
  // one paragraph and a 934 B message is several, and every paragraph break is an Enter. That
  // is defect B, and `an embedded newline submits the front early` is where it fails.
  for (const bodyBytes of [245, 934]) {
    const body = payload(bodyBytes)
    const wire = envelope({ from: 'advisor', fromRank: 'advisor', kind: 'instruction', text: body })
    assertWholeMessageArrived(wire, await submitAndRecord(wire), `${bodyBytes} B field body`)
  }
})

test('#174 control: tty input queue -- the same bytes, paced, arrive whole', async () => {
  // Expected to PASS. It is the control that rules the queue in for defect A: same child, same
  // bytes, same pty, only the write pacing differs, and the loss disappears.
  const text = payload(4096)
  const { pty, read } = await spawnChild(recorderPath)
  try {
    for (let i = 0; i < text.length; i += 256) {
      pty.write(text.slice(i, i + 256))
      await settle(5)
    }
    await settle(600)
    assertWholeMessageArrived(text, read(), '4096 B written in 256 B chunks')
  } finally {
    await stop(pty)
  }
})

test('#174 control: child line editor -- a recorder with none loses bytes anyway', async () => {
  // The recorder appends to a file and interprets nothing: no editor, no paste heuristic, no
  // redraw. Bytes go missing here, so the child's input handling cannot be the cause of A.
  const text = payload(2048)
  const { pty, read } = await spawnChild(recorderPath)
  try {
    pty.write(text)
    await settle(600)
    assertWholeMessageArrived(text, read(), '2048 B to a child with no line editor')
  } finally {
    await stop(pty)
  }
})

test('#174 control: settle delay -- the loss does not move with it', async () => {
  const text = payload(2048)
  const measured: Array<{ settleMs: number; received: number }> = []
  for (const settleMs of [0, 400, 2000]) {
    const { pty, read } = await spawnChild(recorderPath)
    try {
      pty.write(text)
      await settle(settleMs)
      pty.write('\r')
      await settle(600)
      measured.push({ settleMs, received: read().replace(/[\r\n]+$/, '').length })
    } finally {
      await stop(pty)
    }
  }
  // This assertion is the ruling-out, and it PASSES: the same amount arrives at every delay,
  // including the production 400 ms, so SUBMIT_SETTLE_MS is not what drops the bytes.
  assert.equal(
    new Set(measured.map((m) => m.received)).size,
    1,
    `the settle delay changed how much arrived, so it is part of the cause: ${JSON.stringify(measured)}`,
  )
  // And the amount that arrives is still short, which is the defect.
  assert.equal(
    measured[0]!.received,
    text.length,
    `2048 B was truncated to ${measured[0]!.received} at every settle delay: ${JSON.stringify(measured)}`,
  )
})

test('#174 control: a child that is slow to read loses the same 1024, not more', async () => {
  // Holding the queue full for 2 s changes nothing, which is what makes this a fixed ceiling
  // rather than a race against the child's read loop.
  const text = payload(4096)
  const { pty, read } = await spawnChild(recorderPath, 2000)
  try {
    pty.write(text)
    await settle(2600)
    assertWholeMessageArrived(text, read(), '4096 B to a child that waits 2 s before reading')
  } finally {
    await stop(pty)
  }
})

test('#174 an embedded newline submits the front early, far below any ceiling', async () => {
  // Defect B, isolated. 302 bytes: no transport ceiling is anywhere near this, so anything that
  // goes wrong is the application layer and nothing else. This is the FRONT-loss the issue
  // actually reports, and it does not need a large message to happen.
  const text = [payload(100), payload(100), payload(100)].join('\n')
  const { pty, read } = await spawnChild(composerPath)
  try {
    await new InputQueue(pty).submit(text)
    await settle(600)
    const records = read()
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string; text: string })
    assert.equal(
      records.length,
      1,
      `a ${text.length} B message with 2 embedded newlines arrived as ${records.length} messages, not 1: ` +
        `${JSON.stringify(records.map((r) => ({ kind: r.kind, bytes: r.text.length })))}. ` +
        `The front went out as earlier messages and what the seat is left holding is the TAIL ` +
        `(${JSON.stringify(records.at(-1)?.text.slice(0, 24))}...).`,
    )
    assertWholeMessageArrived(text, records[0]!.text, 'a 302 B message with embedded newlines')
  } finally {
    await stop(pty)
  }
})

test('#174 the real envelope splits at its own blank line, before the body is even reached', async () => {
  // Defect B on production bytes. The header and the blank line after it are enough on their
  // own: a body with no newline in it at all still arrives as two messages, the first of which
  // is the header. This is the mechanism by which a seat receives a message whose front is gone.
  const wire = envelope({ from: 'advisor', fromRank: 'advisor', kind: 'instruction', text: payload(300) })
  const { pty, read } = await spawnChild(composerPath)
  try {
    await new InputQueue(pty).submit(wire)
    await settle(600)
    const records = read()
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string; text: string })
    assert.equal(
      records.length,
      1,
      `an envelope-wrapped message arrived as ${records.length} messages: ` +
        `${JSON.stringify(records.map((r) => ({ kind: r.kind, bytes: r.text.length, head: r.text.slice(0, 24) })))}`,
    )
  } finally {
    await stop(pty)
  }
})

test('#174 control: bracketed paste keeps embedded newlines literal', async () => {
  // The counterfactual, and the reason the issue calls the fix cheap: the same bytes wrapped in
  // ESC[200~ / ESC[201~ arrive as ONE paste. conclave already knows the child negotiated
  // bracketed paste -- `isInteractive` is defined by that marker -- and submit() does not use
  // it. This PASSES today, and pins the behaviour a fix would rely on.
  const text = [payload(100), payload(100), payload(100)].join('\n')
  const { pty, read } = await spawnChild(composerPath)
  try {
    assert.ok(pty.isInteractive, 'the composer child advertises bracketed paste')
    pty.write(`\x1b[200~${text}\x1b[201~`)
    await settle(400)
    pty.write('\r')
    await settle(600)
    const records = read()
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string; text: string })
    const pastes = records.filter((r) => r.kind === 'paste')
    assert.equal(pastes.length, 1, `expected one paste, got ${JSON.stringify(records.map((r) => r.kind))}`)
    assertWholeMessageArrived(text, pastes[0]!.text, 'the same 302 B wrapped as a paste')
  } finally {
    await stop(pty)
  }
})
