/**
 * #174: bytes written to a seat's pty in one burst went missing, silently. This is the fix,
 * and the measurements it stands on.
 *
 *   node --test src/process/inputTruncation.test.ts
 *
 * Nothing here is mocked: a real pty, a real child, real bytes, and the child records exactly
 * what it was handed. Two children, and which one a test uses is the test's whole argument.
 * The RECORDER appends bytes to a file and interprets nothing -- no line editor, no paste
 * parser, no redraw -- so whatever it fails to receive was lost below the application. The
 * COMPOSER models a TUI: raw mode, a buffer, bracketed paste inserted literally, Enter submits.
 *
 * There were two defects, with different signatures, and the issue conflated them:
 *
 *   A. A newline-free run over 1024 B was truncated to 1024 in transport. The TAIL was lost.
 *   B. A newline in the payload was typed as ENTER, so the child submitted there and the rest
 *      became a separate message. The FRONT was lost, at any size.
 *
 * B is what produced the field reports, and A did not. Every send goes through `envelope()`,
 * which puts a blank line after the header, so byte 249 is always a newline -- and a newline
 * inside the first 1024 B lifts A's ceiling entirely. A could not have truncated a 934 B field
 * message. It is fixed here anyway: it is one newline-free payload away from mattering.
 *
 * Part 1 pins the hazard at the raw pty layer, writing through `pty.write` and asserting the
 * loss. Those tests describe the environment `submit()` has to work in, and they still lose
 * bytes on purpose. Part 2 puts the same shapes through `InputQueue.submit()` and asserts they
 * arrive whole.
 *
 * Harness caveat, so the recordings are not over-read: the recorder is a Node child in
 * `setRawMode(true)`, which leaves ICRNL on, so a CR it receives is recorded as LF. A real
 * agent TUI sets its own termios and need not match. Conclusions here are drawn from byte
 * counts and from `\n` payloads, never from which of CR/LF landed.
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { envelope } from '../relay/message.ts'
import { chunkForPty, InputQueue } from './input.ts'
import { PtyProcess } from './pty.ts'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * A pty child that records the bytes it receives and interprets none of them.
 *
 * argv: outfile, advertisePaste ('1' | '0'), readAfterMs. Whether it advertises bracketed
 * paste is a parameter because that marker is what `submit()` gates the paste framing on, and
 * a gate needs both of its sides exercised.
 */
const RECORDER = `
import { appendFileSync, writeFileSync } from 'node:fs'
const [outfile, advertisePaste = '1', readAfterMs = '0'] = process.argv.slice(2)
writeFileSync(outfile, '')
if (advertisePaste === '1') process.stdout.write('\\x1b[?2004h')
process.stdout.write('READY\\n')
function start() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', (b) => appendFileSync(outfile, b))
  process.stdin.resume()
}
if (Number(readAfterMs) > 0) setTimeout(start, Number(readAfterMs))
else start()
setTimeout(() => process.exit(0), 60000)
`

/**
 * A pty child that models a TUI composer.
 *
 * Raw mode, one buffer, and the two ways text can enter it:
 *
 *   - typed  -- CR or LF is ENTER. Everything buffered so far is submitted and the buffer
 *               starts again. This is the behaviour defect B rides on.
 *   - pasted -- text between ESC[200~ and ESC[201~ is inserted into the buffer LITERALLY.
 *               Newlines inside it are characters, not Enter, so a paste never submits. The
 *               Enter that arrives after the paste is what submits, once.
 *
 * That is what bracketed paste means, and modelling it any other way would let this file
 * agree with a fix that does not work.
 */
const COMPOSER = `
import { appendFileSync, writeFileSync } from 'node:fs'
const [outfile, advertisePaste = '1', readAfterMs = '0'] = process.argv.slice(2)
writeFileSync(outfile, '')
if (advertisePaste === '1') process.stdout.write('\\x1b[?2004h')
process.stdout.write('READY\\n')
let composer = ''   // what the user would see in the input box
let pending = ''    // bytes not yet interpreted
let pasting = false
function submit() {
  appendFileSync(outfile, JSON.stringify({ text: composer }) + '\\n')
  composer = ''
}
function onData(b) {
  pending += b.toString('utf8')
  for (;;) {
    if (pasting) {
      const close = pending.indexOf('\\x1b[201~')
      if (close === -1) {
        // Hold back a possible partial terminator straddling a read boundary.
        const keep = Math.max(0, pending.length - 5)
        composer += pending.slice(0, keep)
        pending = pending.slice(keep)
        break
      }
      composer += pending.slice(0, close)
      pending = pending.slice(close + 6)
      pasting = false
      continue
    }
    const open = pending.indexOf('\\x1b[200~')
    const enter = pending.search(/[\\r\\n]/)
    if (open !== -1 && (enter === -1 || open < enter)) {
      composer += pending.slice(0, open)
      pending = pending.slice(open + 6)
      pasting = true
      continue
    }
    if (enter !== -1) {
      composer += pending.slice(0, enter)
      pending = pending.slice(enter + 1)
      submit()
      continue
    }
    const keep = Math.max(0, pending.length - 5)
    composer += pending.slice(0, keep)
    pending = pending.slice(keep)
    break
  }
}
function start() {
  process.stdin.on('data', onData)
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()
}
if (Number(readAfterMs) > 0) setTimeout(start, Number(readAfterMs))
else start()
setTimeout(() => process.exit(0), 60000)
`

const dir = mkdtempSync(join(tmpdir(), 'conclave-174-'))
const recorderPath = join(dir, 'recorder.mjs')
const composerPath = join(dir, 'composer.mjs')
writeFileSync(recorderPath, RECORDER)
writeFileSync(composerPath, COMPOSER)

let seq = 0

/**
 * A payload that carries its own offsets and contains NO newline.
 *
 * `[000000][000010]...` means a fragment says where in the message it came from, so a failure
 * reports "lost the first N" or "lost the last N" instead of "lengths differ". Newline-free is
 * load-bearing: a newline in the first 1024 bytes changes the transport answer, which is what
 * `a newline inside the first 1024 bytes lifts it` exists to pin.
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

interface ChildOptions {
  /** Advertise the bracketed-paste marker. Off exercises the other side of the gate. */
  advertisePaste?: boolean
  /** Delay the child's first read, to hold the tty input queue full on purpose. */
  readAfterMs?: number
}

async function spawnChild(script: string, opts: ChildOptions = {}): Promise<Child> {
  const { advertisePaste = true, readAfterMs = 0 } = opts
  const out = join(dir, `recording-${seq++}.bin`)
  const pty = await PtyProcess.spawn({
    file: process.execPath,
    args: [script, out, advertisePaste ? '1' : '0', String(readAfterMs)],
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? dir, TERM: 'xterm-256color' },
  })
  assert.ok(await pty.waitForOutput((s) => s.includes('READY'), 10_000), 'child never announced READY')
  // utf8, not latin1: the payloads here carry an em dash and non-BMP characters, and a
  // decoding difference must not be reported as a lost byte.
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

/** What the recorder holds, with the trailing Enter and any paste framing taken back off. */
function payloadOf(received: string): string {
  let s = received.replace(/[\r\n]+$/, '')
  if (s.startsWith(PASTE_START)) s = s.slice(PASTE_START.length)
  if (s.endsWith(PASTE_END)) s = s.slice(0, -PASTE_END.length)
  return s
}

/**
 * Fail if any part of `sent` did not arrive, and say WHICH part.
 *
 * `lost the first N` and `lost the last N` are different defects and the message has to
 * distinguish them, because that is the question this file answers.
 */
function assertWholeMessageArrived(sent: string, got: string, label: string): void {
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

/** One production `submit()` into a fresh recorder. Returns the recording, framing and all. */
async function submitAndRecord(text: string, opts: ChildOptions = {}): Promise<string> {
  const { pty, read } = await spawnChild(recorderPath, opts)
  try {
    await new InputQueue(pty).submit(text)
    await settle(600)
    return read()
  } finally {
    await stop(pty)
  }
}

/** Every message a composer submitted, in order. */
async function submitToComposer(text: string, opts: ChildOptions = {}): Promise<string[]> {
  const { pty, read } = await spawnChild(composerPath, opts)
  try {
    await new InputQueue(pty).submit(text)
    await settle(600)
    return read()
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { text: string }).text)
  } finally {
    await stop(pty)
  }
}

// ---------------------------------------------------------------------------------------
// Part 1. The hazard, at the raw pty layer. These write through `pty.write` and assert the
// loss: they are the measurement the fix is designed against, not a wish for how it behaves.
// ---------------------------------------------------------------------------------------

test('#174 hazard: an unchunked newline-free write is cut to exactly 1024 bytes', async () => {
  for (const n of [1024, 1025, 4096]) {
    const text = payload(n)
    const { pty, read } = await spawnChild(recorderPath)
    try {
      pty.write(text)
      await settle(700)
      // 1024 is the ceiling itself, so it survives; everything above it lands as 1024.
      assert.equal(payloadOf(read()).length, Math.min(n, 1024), `${n} B written in one call`)
    } finally {
      await stop(pty)
    }
  }
})

test('#174 hazard: a newline inside the first 1024 bytes lifts it; one past it does not', async () => {
  // The rule, precisely. It is why defect A never fired on real traffic: envelope() puts a
  // newline at byte 249 of every message conclave sends.
  const cases: Array<[string, string, number]> = [
    ['newline at byte 500', `${payload(500)}\n${payload(4500)}`, 5001],
    ['newline at byte 1030', `${payload(1030)}\n${payload(4000)}`, 1024],
  ]
  for (const [label, text, expected] of cases) {
    const { pty, read } = await spawnChild(recorderPath)
    try {
      pty.write(text)
      await settle(700)
      assert.equal(payloadOf(read()).length, expected, label)
    } finally {
      await stop(pty)
    }
  }
})

test('#174 hazard: pacing under the ceiling is what clears it', async () => {
  // The same bytes, the same child, the same pty -- only the pacing differs, and the loss
  // goes away. That is what rules the tty queue in as the cause of defect A.
  //
  // Only the timer half is asserted. `setImmediate` between chunks was measured losing bytes
  // (8 KB arriving as 7168, 64 KB as 58880) but it does sometimes get away with it, so
  // pinning its failure here would pin a coin toss. The reasoning lives in `yieldToChild`.
  const text = payload(8192)
  const { pty, read } = await spawnChild(recorderPath)
  try {
    for (const chunk of chunkForPty(text)) {
      pty.write(chunk)
      await settle(0)
    }
    await settle(700)
    assertWholeMessageArrived(text, payloadOf(read()), '8192 B in chunks, timer yield between them')
  } finally {
    await stop(pty)
  }
})

test('#174 hazard: chunking cannot rescue a child that has stopped reading', async () => {
  // The residual, stated rather than papered over. There is no drain signal to wait on, so a
  // stalled child still loses the overflow. Noticing that is the mismatch detection #174 asks
  // for, and it is deliberately not in this change.
  //
  // 1024 bytes of the RECORDING, framing included: the queue counts what it was handed, and
  // what it was handed opens with ESC[200~. Even the closing marker and the Enter, written
  // 400 ms later, do not fit.
  const text = payload(8192)
  const { pty, read } = await spawnChild(recorderPath, { readAfterMs: 1500 })
  try {
    await new InputQueue(pty).submit(text)
    await settle(1800)
    assert.equal(read().length, 1024, 'a child that reads nothing for 1.5 s keeps 1024 B and no more')
  } finally {
    await stop(pty)
  }
})

test('#174 when it does truncate, the paste framing turns silence into non-delivery', async () => {
  // Worth having on purpose. #174's argument is that a dropped message is recoverable and a
  // truncated one that still parses is not. Under the framing, a truncation that eats the
  // closing ESC[201~ leaves the child still in paste mode, so the Enter is absorbed as text
  // and NOTHING is submitted. The seat gets no message rather than a plausible fragment.
  const text = payload(8192)
  const messages = await submitToComposer(text, { readAfterMs: 1500 })
  assert.deepEqual(messages, [], `expected no message at all, got ${JSON.stringify(messages.map((m) => m.length))}`)
})

// ---------------------------------------------------------------------------------------
// Part 2. The fix, through `InputQueue.submit()`.
// ---------------------------------------------------------------------------------------

test('chunkForPty splits on code points, under the byte budget', () => {
  const emoji = '😀' // U+1F600: 4 UTF-8 bytes, 2 UTF-16 code units
  for (const text of [payload(4096), `${'x'.repeat(3)}${emoji.repeat(400)}`, '', 'short']) {
    const chunks = chunkForPty(text)
    assert.equal(chunks.join(''), text, 'chunks must rejoin into exactly what went in')
    for (const chunk of chunks) {
      assert.ok(Buffer.byteLength(chunk, 'utf8') <= 256, `chunk of ${Buffer.byteLength(chunk)} B exceeds the budget`)
      // A split surrogate pair survives as U+FFFD, which would corrupt rather than truncate.
      assert.ok(!/[\uD800-\uDFFF]/.test(chunk.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), 'lone surrogate')
    }
  }
  assert.deepEqual(chunkForPty(''), [], 'nothing to write for an empty message')
  assert.deepEqual(chunkForPty('abc', 1), ['a', 'b', 'c'])
  // A single code point wider than the budget still has to go somewhere whole.
  assert.deepEqual(chunkForPty('😀', 1), ['😀'])
})

const SWEEP = [256, 1024, 1025, 2048, 4096, 16_384]

for (const n of SWEEP) {
  test(`#174 a ${n} B newline-free message survives submit() into a real pty`, async () => {
    const text = payload(n)
    assertWholeMessageArrived(text, payloadOf(await submitAndRecord(text)), `${n} B via submit`)
  })
}

test('#174 64 KB survives submit(), which the unchunked write cut to 1024', async () => {
  const text = payload(65_536)
  assertWholeMessageArrived(text, payloadOf(await submitAndRecord(text)), '65536 B via submit')
})

test('#174 non-BMP characters straddling every chunk boundary arrive intact', async () => {
  // 256 bytes is 64 four-byte emoji exactly, so an unpadded payload would only ever split on
  // a clean boundary and prove nothing. The pad walks the boundary into the middle of a
  // surrogate pair, which is where a byte-wise slice would produce U+FFFD.
  for (const pad of [0, 1, 2, 3]) {
    const text = `${'x'.repeat(pad)}${'😀'.repeat(400)}`
    const got = payloadOf(await submitAndRecord(text))
    assert.ok(!got.includes('�'), `pad=${pad}: a replacement character means a code point was split`)
    assertWholeMessageArrived(text, got, `pad=${pad}, ${Buffer.byteLength(text)} B of emoji`)
  }
})

test('#174 the wire shape conclave actually sends arrives whole, at any size', async () => {
  for (const bodyBytes of [245, 934, 64_000]) {
    const wire = envelope({
      from: 'advisor',
      fromRank: 'advisor',
      kind: 'instruction',
      text: payload(bodyBytes),
    })
    const got = payloadOf(await submitAndRecord(wire))
    assertWholeMessageArrived(wire, got, `${bodyBytes} B body = ${Buffer.byteLength(wire)} B on the wire`)
  }
})

test('#174 the paste framing is gated on the bracketedPaste marker, not on isInteractive', async () => {
  const text = payload(300)

  const framed = await submitAndRecord(text)
  assert.ok(framed.startsWith(PASTE_START), 'a child that advertised bracketed paste gets the framing')
  assert.ok(framed.replace(/[\r\n]+$/, '').endsWith(PASTE_END), 'and gets it closed')

  const bare = await submitAndRecord(text, { advertisePaste: false })
  assert.ok(!bare.includes(PASTE_START), 'a child that never advertised it must not be sent ESC[200~')
  // Chunking is unconditional, so the payload still arrives whole either way.
  assertWholeMessageArrived(text, payloadOf(bare), '300 B to a child with no paste support')
})

test('#174 a message with embedded newlines reaches the composer as ONE message', async () => {
  // Defect B, fixed. Previously three messages, the first two of which the seat never saw as
  // part of this message at all.
  const text = [payload(100), payload(100), payload(100)].join('\n')
  const messages = await submitToComposer(text)
  assert.equal(messages.length, 1, `arrived as ${messages.length} messages: ${JSON.stringify(messages.map((m) => m.length))}`)
  assertWholeMessageArrived(text, messages[0]!, 'a 302 B message with embedded newlines')
})

test('#174 the real envelope no longer splits at its own blank line', async () => {
  // The field failure, on production bytes: the header and the blank line after it used to be
  // enough on their own to break a message into three, leaving the seat holding the tail.
  const wire = envelope({ from: 'advisor', fromRank: 'advisor', kind: 'instruction', text: payload(2000) })
  const messages = await submitToComposer(wire)
  assert.equal(
    messages.length,
    1,
    `arrived as ${messages.length} messages: ${JSON.stringify(messages.map((m) => ({ bytes: m.length, head: m.slice(0, 24) })))}`,
  )
  assertWholeMessageArrived(wire, messages[0]!, 'a 2000 B body in the real envelope')
})

test('#174 a composer with no paste support still splits, and that is the gate working', async () => {
  // The honest limit of gating on the marker: a child that never advertised bracketed paste is
  // typed at, so its newlines are still Enters. Pinned so nobody reads the fix as universal.
  const text = [payload(100), payload(100), payload(100)].join('\n')
  const messages = await submitToComposer(text, { advertisePaste: false })
  assert.equal(messages.length, 3, 'without the marker the payload is typed, and newlines submit')
})

test('#174 a bare Enter is still a bare Enter', async () => {
  // claude.ts sends submit('') to nudge a composer that swallowed a prompt. It must not
  // acquire paste framing, and it must not write a body.
  const got = await submitAndRecord('')
  assert.ok(!got.includes(PASTE_START), 'an empty submit must not open a paste')
  assert.match(got, /^[\r\n]$/, `expected one Enter and nothing else, got ${JSON.stringify(got)}`)
})

test('#174 the recorded action reports the bytes that were actually written', async () => {
  const { pty } = await spawnChild(recorderPath)
  try {
    const action = await new InputQueue(pty).submit('hello')
    assert.equal(action.bytes, `${PASTE_START}hello${PASTE_END}\\r`)
    assert.equal(action.detail, 'hello')
  } finally {
    await stop(pty)
  }
})
