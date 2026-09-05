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
 *      That ceiling belongs to a moment, not to a platform: CI measured it on darwin-arm64 and
 *      not on ubuntu-latest, and then measured darwin-arm64 delivering an unchunked 1025 B
 *      write whole. Nothing here asserts a byte count any more.
 *   B. A newline in the payload was typed as ENTER, so the child submitted there and the rest
 *      became a separate message. The FRONT was lost, at any size.
 *
 * B is what produced the field reports, and A did not. Every send goes through `envelope()`,
 * which puts a blank line after the header, so byte 249 is always a newline -- and a newline
 * inside the first 1024 B lifts A's ceiling entirely. A could not have truncated a 934 B field
 * message. It is fixed here anyway: it is one newline-free payload away from mattering.
 *
 * Part 1 MEASURES the hazard at the raw pty layer, writing through `pty.write` and printing
 * what the child was handed. Those tests describe the environment `submit()` has to work in,
 * and they still lose bytes on purpose. They assert no byte count at all -- see the block above
 * `assertNothingInvented` for the four CI attempts that took the byte counts away. Part 2 puts
 * the same shapes through `InputQueue.submit()`.
 *
 * WHAT PART 2 DOES NOT CLAIM, since it used to and was wrong. It does not assert that a large
 * message arrives whole. There is nothing at this layer that could make that true: `pty.write`
 * hands the bytes to node-pty's own write queue and returns, that queue is drained by `fs.write`
 * callbacks that recurse without yielding, and the timer `submit()` waits on between chunks
 * therefore acknowledges neither the write nor the child's read (`yieldToChild`). Chunking at
 * 256 B lowers the probability of loss by a lot and guarantees nothing, and CI found the
 * counterexample -- a 4096 B `submit()` arriving short on a `macos-latest` runner -- which is
 * exactly what a probabilistic mechanism does to a test that asserts certainty.
 *
 * So Part 2 asserts what is DETERMINISTIC about the write side -- the framing, the code-point
 * boundaries, the shape of what is handed to the driver, and the behaviour of small payloads
 * under every tty ceiling in evidence -- and MEASURES the rest, printing what each size actually
 * delivered on this platform and this run. The guarantee a caller gets is made one layer up,
 * where it can be kept: the child echoes back the prompt it took, a mismatch is cancelled and
 * re-sent once, and a message that still did not arrive intact is refused rather than delivered
 * short. `adapters/promptFidelity.test.ts` holds that contract at 4096 B through real adapters.
 *
 * Harness caveat, so the recordings are not over-read: the recorder is a Node child in
 * `setRawMode(true)`, which leaves ICRNL on, so a CR it receives is recorded as LF. A real
 * agent TUI sets its own termios and need not match. Conclusions here are drawn from byte
 * counts and from `\n` payloads, never from which of CR/LF landed.
 */

import { strict as assert } from 'node:assert'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { suiteTempDir } from '../testkit/tempDir.ts'
import { waitFor } from '../testkit/waitFor.ts'
import { envelope } from '../relay/message.ts'
import { chunkForPty, InputQueue } from './input.ts'
import { PtyProcess } from './pty.ts'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * A pty child that records the bytes it receives and interprets none of them.
 *
 * argv: outfile, advertise ('paste' | 'focus' | 'none'), readAfterMs. WHICH markers it
 * announces is a parameter because that is what `submit()` gates the paste framing on, and a
 * gate needs every side of it exercised -- including a child that is fully interactive by way
 * of the other two decisive markers and has still said nothing about ESC[200~.
 */
const RECORDER = `
import { appendFileSync, writeFileSync } from 'node:fs'
const [outfile, advertise = 'paste', readAfterMs = '0'] = process.argv.slice(2)
writeFileSync(outfile, '')
if (advertise === 'paste') process.stdout.write('\\x1b[?2004h')
// focus events AND the kitty keyboard protocol: the other two DECISIVE markers. A child like
// this is interactive and has said nothing whatsoever about ESC[200~.
if (advertise === 'focus') process.stdout.write('\\x1b[?1004h\\x1b[>7u')
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
const [outfile, advertise = 'paste', readAfterMs = '0'] = process.argv.slice(2)
writeFileSync(outfile, '')
if (advertise === 'paste') process.stdout.write('\\x1b[?2004h')
process.stdout.write('READY\\n')
let composer = ''   // what the user would see in the input box
let pending = ''    // bytes not yet interpreted
let pasting = false
let readBytes = 0   // reported, so the harness can watch for input to STOP arriving
let submits = 0
function submit() {
  appendFileSync(outfile, JSON.stringify({ text: composer }) + '\\n')
  composer = ''
  submits += 1
}
function onData(b) {
  pending += b.toString('utf8')
  readBytes += b.length
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
    // A real composer CLEARS on Escape, and so does this one. Any ESC that is not the paste
    // opener discards what has been typed so far and keeps only what follows -- which is a
    // DROPPED PREFIX cutting mid-word at whatever offset the ESC sits, the shape #174's
    // unexplained incidents have. Modelling it any other way would let this file agree with a
    // fix that does not work, which is what this composer exists to prevent.
    const esc = pending.indexOf('\\x1b')
    if (esc !== -1 && esc !== open && (enter === -1 || esc < enter)) {
      // Not enough yet to know whether this ESC begins a paste opener. Wait rather than guess:
      // deciding early would clear on the first byte of every framed send.
      if (pending.length - esc < 6) break
      composer = ''
      pending = pending.slice(esc + 1)
      continue
    }
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
  process.stdout.write('PROGRESS ' + readBytes + ' ' + submits + '\\n')
}
function start() {
  process.stdin.on('data', onData)
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()
  // Announced, so the harness can WAIT for reading to have begun instead of betting on a
  // duration longer than readAfterMs. See submitToComposer (#178).
  process.stdout.write('READING\\n')
}
if (Number(readAfterMs) > 0) setTimeout(start, Number(readAfterMs))
else start()
setTimeout(() => process.exit(0), 60000)
`

/**
 * The stall the hazard test builds: long enough that the write completes into a tty nobody is
 * draining, which is the condition being measured.
 */
const STALL_MS = 1500
/**
 * The bound on "the child got there", NOT a margin over `STALL_MS` (#197). It is the point past
 * which a runner is not slow but broken, and it is deliberately far from the stall so that load
 * cannot reach it -- the same 10s already allowed for a child to announce READY.
 */
const FIRST_BYTE_MS = 10_000
/** Drain allowance once reading has been OBSERVED to start. See the note at its use. */
const DRAIN_MS = 300

const dir = suiteTempDir('conclave-174')
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
  /**
   * Which TUI markers the child announces.
   *
   * `focus` is the side of the gate that needs stating: focus events and the kitty keyboard
   * protocol are the other two DECISIVE markers, so such a child IS `isInteractive` and has
   * still said nothing about bracketed paste. Framing it would be a guess.
   */
  advertise?: 'paste' | 'focus' | 'none'
  /** Delay the child's first read, to hold the tty input queue full on purpose. */
  readAfterMs?: number
}

async function spawnChild(script: string, opts: ChildOptions = {}): Promise<Child> {
  const { advertise = 'paste', readAfterMs = 0 } = opts
  const out = join(dir, `recording-${seq++}.bin`)
  const pty = await PtyProcess.spawn({
    file: process.execPath,
    args: [script, out, advertise, String(readAfterMs)],
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

/**
 * The whole-or-nothing disjunction, as a function so it can be TESTED rather than only run.
 *
 * #174's claim is that a dropped message is recoverable and a truncated one that still parses
 * is not. Under paste framing a truncation that eats the closing ESC[201~ leaves the child in
 * paste mode, the following Enter is absorbed, and nothing is submitted -- so zero messages is
 * a legitimate outcome and asserting a failure on it would be wrong. So is one whole message,
 * if a runner's tty carried the lot.
 *
 * The third case is the defect, and it is the only one. Keeping the check here, rather than
 * inline in the test that usually observes zero, is what lets a manufactured fragment prove the
 * check fires -- see the #178 test below.
 */
function assertWholeOrNothing(messages: string[], text: string): void {
  if (messages.length === 0) return
  assert.equal(messages.length, 1, 'a truncated paste must not split into several messages')
  assert.equal(
    messages[0],
    text,
    `the composer submitted a ${messages[0]?.length} B FRAGMENT of an ${text.length} B message, ` +
      `which is the exact failure the framing exists to prevent`,
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

/**
 * Wait until the composer has begun reading and input has STOPPED arriving at it.
 *
 * Two different kinds of wait, and the difference is the whole of #178.
 *
 * The first is an ordering guarantee. `READING` is written by the child's `start()`, so
 * observing it proves the child is now consuming the tty -- however long `readAfterMs` held it
 * off, and however loaded the machine is. What stood here was `settle(600)` against a child
 * told to wait 1500ms, so the harness always looked before the child had read a byte: the
 * message count was zero by construction, the caller's early return fired every time, and the
 * assertions past it never once executed on any platform.
 *
 * The second is an observation, and is deliberately not dressed up as a guarantee. There is no
 * drain signal for a tty -- this file says so where it measures what a stalled child keeps --
 * so "the child has everything it is going to get" cannot be proven, only watched for. The
 * child reports cumulative bytes after every batch it processes, and this waits for that number
 * to stop moving. A duration is still involved, but it now bounds a gap BETWEEN OBSERVED READS
 * rather than standing in for the entire transfer, and a slower machine simply takes more
 * rounds instead of being read too early.
 *
 * When that observation is wrong it is wrong safely. Looking early can only mean fewer bytes
 * have been processed, which yields fewer submitted messages -- never a fragment that was not
 * there. The disjunction at the call site already treats a low count as a legitimate outcome,
 * so a premature read degrades into the benign branch and cannot manufacture a failure.
 */
async function composerQuiescent(pty: PtyProcess, waitMs = 10_000): Promise<void> {
  assert.ok(
    await pty.waitForOutput((s) => s.includes('READING'), waitMs),
    'the composer never began reading, so nothing below could be observed',
  )
  const readSoFar = (all: string): number => {
    const seen = [...all.matchAll(/PROGRESS (\d+) \d+/g)]
    return seen.length === 0 ? -1 : Number(seen[seen.length - 1]![1])
  }
  // Bounded, because a child that never reads anything at all must fail the assertions rather
  // than hang the suite.
  const deadline = Date.now() + waitMs
  let last = -2
  while (Date.now() < deadline) {
    const now = readSoFar(pty.output)
    if (now === last && now >= 0) return
    last = now
    await settle(150)
  }
  // Loud, not a quiet return. A harness that gives up and lets the caller read an empty file
  // reports "nothing was submitted" for what is really "nothing was observed" -- which is #178
  // itself, arriving more slowly. The two must never be the same answer again.
  assert.fail('the composer never stopped receiving input, so what it holds was never measured')
}

/** Every message a composer submitted, in order. */
async function submitToComposer(text: string, opts: ChildOptions = {}): Promise<string[]> {
  const { pty, read } = await spawnChild(composerPath, opts)
  try {
    await new InputQueue(pty).submit(text)
    await composerQuiescent(pty)
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

/**
 * Part 1 MEASURES. It no longer asserts a byte count anywhere, and the reason is four CI
 * attempts of one commit.
 *
 * These tests used to assert darwin-arm64's 1024 B cliff and skip elsewhere, on the strength of
 * that platform having produced it every time it was asked. Run 33100038199 asked four more
 * times on the same sha:
 *
 *   attempt 4, darwin-arm64  an unchunked 1025 B write delivered ALL 1025 -- no cliff at all,
 *                            on the machine the cliff was named after. Red build, no defect.
 *   attempt 3, darwin-arm64  a PACED 2048 B `submit()` delivered 1018 B. Chunked, timer-yielded,
 *                            and it still lost half the message on a platform that delivered
 *                            the same 2048 whole in the three attempts either side of it.
 *   attempt 3, linux-x64     an unchunked 8192 B write delivered all 8192, where the same
 *                            runner delivered 4095 in attempts 1, 2 and 4.
 *
 * So the cliff is not a platform constant. It is a race between how fast this process hands
 * bytes to node-pty's write queue and when the child next reads, and every number in it moves
 * with load -- on every platform, in both directions. `yieldToChild` has the mechanism.
 *
 * What is left here is the DATA, printed on every platform on every run, which is the thing
 * nobody had while #174 was being diagnosed from one machine's numbers. The assertions are the
 * two relationships that cannot be a scheduling artifact: nothing arrives that was not written,
 * and something always arrives. Anything stronger has now been observed to move.
 *
 * The guarantee a caller gets is unchanged and lives where it can be kept:
 * `adapters/promptFidelity.test.ts` asserts, through both real adapters, that a message arrives
 * exactly or the send is refused -- never a fragment. That contract passed on all three
 * platforms in all four attempts, including the two in which this layer lost bytes.
 */
const THIS_PLATFORM = `${process.platform}-${process.arch}`

/** Nothing arrives that was not written, and something always arrives. The rest is measured. */
function assertNothingInvented(sent: number, got: number, what: string): void {
  assert.ok(got <= sent, `${what}: ${got} B arrived from a ${sent} B write, which is more than was written`)
  assert.ok(got > 0, `${what}: nothing arrived at all from a ${sent} B write`)
}

test('#174 hazard: what an unchunked newline-free write delivers', async (t) => {
  // The defect A measurement. One `pty.write` of the whole payload, no chunking, no pacing --
  // the shape conclave USED to send and the one every ceiling shows up in.
  const rows: string[] = []
  for (const n of [1024, 1025, 4096]) {
    const text = payload(n)
    const { pty, read } = await spawnChild(recorderPath)
    try {
      pty.write(text)
      await settle(700)
      const got = payloadOf(read())
      rows.push(`${n}->${got.length}${got.length === n ? '' : ' SHORT'}${text.startsWith(got) ? '' : ' NOT-A-PREFIX'}`)
      assertNothingInvented(n, got.length, `${n} B written in one call`)
    } finally {
      await stop(pty)
    }
  }
  // `NOT-A-PREFIX` would be the finding worth having: it would mean the loss is not a lost
  // TAIL, which is the shape every observation so far has had and the shape the adapters'
  // mismatch classifier is built around. It has never appeared. It is reported rather than
  // asserted because the assertion would be one more guess about a transport nobody controls.
  t.diagnostic(`unchunked write on ${THIS_PLATFORM}: ${rows.join(', ')}`)
})

test('#174 hazard: what a newline before and after the ceiling delivers', async (t) => {
  // Why defect A never fired on real traffic, if the ceiling is where it was measured:
  // envelope() puts a newline at byte 249 of every message conclave sends, and a newline early
  // in an unchunked write has been observed to lift whatever ceiling that platform has. Both
  // halves are reported, because "the rule" is a rule about one platform on one day: linux
  // delivers the byte-1030 case whole and darwin-x64 cuts it to 1024, in the same run.
  const cases: Array<[string, string]> = [
    ['newline at byte 500', `${payload(500)}\n${payload(4500)}`],
    ['newline at byte 1030', `${payload(1030)}\n${payload(4000)}`],
  ]
  const rows: string[] = []
  for (const [label, text] of cases) {
    const { pty, read } = await spawnChild(recorderPath)
    try {
      pty.write(text)
      await settle(700)
      const got = payloadOf(read())
      rows.push(`${label}: ${text.length}->${got.length}${got.length === text.length ? '' : ' SHORT'}`)
      assertNothingInvented(text.length, got.length, label)
    } finally {
      await stop(pty)
    }
  }
  t.diagnostic(`newline placement on ${THIS_PLATFORM}: ${rows.join(', ')}`)
})

/**
 * WHAT THE PACING EVIDENCE SUPPORTS, AND WHAT IT DOES NOT
 *
 * Written down because nobody reading this later will re-derive it, and because the honest
 * sentence is stronger than the guarantee the old tests asserted.
 *
 * Twenty-one paced-vs-unpaced observations exist: CI runs 33100038199 (sha 21aa7be, four
 * attempts) and 33104083028 (sha 4da49a3, three attempts), three platforms each, 8192 B both
 * ways into the same recorder on the same runner seconds apart.
 *
 *   PACED (256 B chunks, timer yield)   UNPACED (one write)
 *   darwin-arm64   8192 x 7             1024 x 7
 *   darwin-x64     8192 x 6, 7424 x 1   1024 x 7
 *   linux-x64      8192 x 7             4095 x 5, 8192 x 2
 *
 * WHAT IT SUPPORTS. Paced was never worse than unpaced: 21 of 21, strictly better in 19 and
 * equal in 2 -- both of those on linux-x64, where an unpaced 8192 B write also happened to
 * arrive whole. On darwin the gap is not marginal, it is 8x, and it held on every attempt on
 * both architectures. Even the worst paced result beat its own unpaced control in the same
 * job: darwin-x64 in attempt 1 of run 33104083028 paced 7424 B through while one write
 * delivered 1024. That is a real, repeatedly measured effect, and it is the whole reason
 * `SUBMIT_CHUNK_BYTES` stays at 256.
 *
 * WHAT IT DOES NOT SUPPORT, and each of these was specifically checked for:
 *
 *   - No RATE BOUND. In the same run that produced the table above, the paced size sweep lost
 *     bytes in 7 of its 90 measurements, all on darwin-x64: 1024->1018, 1025->1019, 2048->1530,
 *     16384->16378 and 65536->47610 in one attempt, 1025->1018 and 2048->1018 in another. The
 *     worst delivered 72% of the message. Run 33100038199 lost a paced 2048 B submit down to
 *     1018 B on darwin-arm64. Pacing lowers the frequency of loss by an amount nobody here has
 *     bounded, and 60 clean attempts on one machine did not bound it either.
 *   - No BACKPRESSURE. There is no drain signal anywhere in this path. `pty.write` queues into
 *     node-pty's `_writeQueue` and returns; the queue drains through `fs.write` callbacks that
 *     recurse without yielding. The timer between chunks acknowledges neither the write nor the
 *     child's read. See `yieldToChild`.
 *   - No GUARANTEED DELIVERY, at any size. 256 B is the only size never observed short, across
 *     both runs and all three platforms -- which is an absence of counterexamples in 21 tries,
 *     not a guarantee, and is exactly the reasoning that produced the assertions CI deleted.
 *   - No CORRUPTION SHAPE. Every loss observed so far has been a shortfall, and the unchunked
 *     measurement reports whether what arrived is a prefix -- but `1024->1018` is six bytes
 *     missing from a payload at the ceiling, and nothing here establishes whether they came off
 *     the tail or out of the middle. The sweep does not report prefix-ness at all. So "the loss
 *     is always a lost tail" is a hypothesis with no test behind it.
 *
 * The guarantee a caller actually gets is none of these. It is in the adapters: the child
 * echoes back what it took, a mismatch is cancelled and re-sent once if the child confirms the
 * turn ended, and anything short of an exact match is REFUSED. That contract passed on all
 * three platforms in all seven attempts across both runs, including every attempt in which this
 * layer lost bytes. `adapters/promptFidelity.test.ts` is where it is asserted.
 */

test('#174 hazard: pacing under the ceiling CHANGES it, measured both ways', async (t) => {
  // The same bytes, the same child, the same pty -- only the pacing differs. That comparison is
  // what rules the tty queue in as the cause of defect A, and it is all this reports.
  //
  // It used to assert that the paced write arrived whole, and that was the same overreach the
  // sweep made: `yieldToChild` parks this loop on a timer, and a timer acknowledges neither
  // node-pty's queued write nor the child's read. Pacing improves the odds and the improvement
  // is large -- unchunked is a hard cliff at 1024 B here, paced is usually everything -- but
  // "usually" is not something to assert 8192 bytes of. Both numbers go into the run log
  // instead, where a shift in either is visible.
  //
  // `setImmediate` between chunks was measured losing bytes too (8 KB arriving as 7168, 64 KB
  // as 58880) and it does sometimes get away with it, which is why the yield is a timer. The
  // reasoning lives in `yieldToChild`.
  const text = payload(8192)
  const deliver = async (paced: boolean): Promise<number> => {
    const { pty, read } = await spawnChild(recorderPath)
    try {
      if (paced) {
        for (const chunk of chunkForPty(text)) {
          pty.write(chunk)
          await settle(0)
        }
      } else {
        pty.write(text)
      }
      await settle(700)
      return payloadOf(read()).length
    } finally {
      await stop(pty)
    }
  }
  const paced = await deliver(true)
  const unpaced = await deliver(false)
  t.diagnostic(
    `8192 B on ${THIS_PLATFORM}: paced in 256 B chunks -> ${paced} B, one write -> ${unpaced} B` +
      `${paced >= unpaced ? '' : ' -- PACING DELIVERED LESS'}`,
  )
  // Not asserted. See WHAT THE PACING EVIDENCE SUPPORTS below for the 21 observations behind
  // that decision.
  assertNothingInvented(8192, paced, 'paced in 256 B chunks')
  assertNothingInvented(8192, unpaced, 'one unchunked write')
})

test('#174 hazard: what a stalled child keeps of a chunked submit', async (t) => {
  // The residual, stated rather than papered over. There is no drain signal to wait on, so a
  // child that is not reading loses the overflow however carefully the write is paced. Noticing
  // that is the mismatch detection #174 asks for, and it is why the adapters refuse rather than
  // trust the write.
  //
  // The SIZE of what survives is the queue's and it moves: darwin has kept 1024 B of this and
  // linux 4096 B, in the same run. Reported, not asserted.
  const text = payload(8192)
  const framed = PASTE_START.length + text.length + PASTE_END.length + 1
  const { pty, read } = await spawnChild(recorderPath, { readAfterMs: STALL_MS })
  try {
    await new InputQueue(pty).submit(text)
    // WAIT FOR THE CHILD TO HAVE READ, RATHER THAN ASSUME IT HAS BY NOW (#197).
    //
    // A fixed `settle(1800)` stood here against a child that starts reading at 1500ms: a 300ms
    // margin for another process's timer to fire, for it to be scheduled, and for its bytes to
    // reach the file. `ubuntu-latest` failed it once and passed the rerun of the same commit,
    // and the message it failed with -- `nothing arrived at all from a 8205 B write` -- reads as
    // a finding about the transport when it is this test failing to reach its own preconditions.
    // #178 was the same defect and was fixed by widening the same margin; widening it a third
    // time would pick the number by guess again.
    //
    // The two outcomes this must not conflate:
    //   the child read, and what survived is now measurable -- the actual subject
    //   the child never read, which is a starved runner and says nothing about chunked writes
    await waitFor(() => read().length > 0, {
      within: FIRST_BYTE_MS,
      describe: `the stalled child (reading from ${STALL_MS}ms) to receive any byte of the submit`,
    })
    // A clock again, but not the same bet. What is being waited on here is a drain of bytes the
    // tty is ALREADY holding for a child that is ALREADY reading -- work measured in ms on any
    // machine -- not the arrival of a timer in another process. Its failure mode is a smaller
    // number in the diagnostic below, which is reported rather than asserted, and never the
    // assertion failure that made this test flake.
    await settle(DRAIN_MS)
    const kept = read().length
    t.diagnostic(
      `a child that read nothing for ${STALL_MS / 1000} s on ${THIS_PLATFORM} kept ${kept} B of a ${framed} B framed submit`,
    )
    assertNothingInvented(framed, kept, 'a stalled child')
  } finally {
    await stop(pty)
  }
})

test('#174 a truncated framed paste submits NOTHING, never a fragment', async (t) => {
  // Worth having on purpose, and it is the one claim at this layer that does not depend on how
  // much a given runner's tty carries. #174's argument is that a dropped message is recoverable
  // and a truncated one that still parses is not. Under the paste framing a truncation that
  // eats the closing ESC[201~ leaves the child in paste mode, so the Enter that follows is
  // absorbed as text and nothing is submitted at all.
  //
  // Stated as the disjunction, because the premise is a race: this child reads nothing for
  // 1.5 s, which has produced a truncation on every platform so far -- but "so far" is what
  // attempt 4 punished. If a runner ever carries the whole 8205 B framed payload, the honest
  // answer is one whole message, not a failure. What must NEVER happen is the third case.
  const text = payload(8192)
  const messages = await submitToComposer(text, { readAfterMs: 1500 })
  t.diagnostic(
    `an 8192 B submit to a child stalled 1.5 s on ${THIS_PLATFORM} produced ` +
      `${messages.length} message(s): ${JSON.stringify(messages.map((m) => m.length))}`,
  )
  assertWholeOrNothing(messages, text)
})

test('#174 an ESC inside an UNFRAMED message drops everything before it, mid-word', async () => {
  // The third mechanism, reproduced. #174 closed A (the tty queue truncating a newline-free
  // write, losing the TAIL) and B (a newline typed as ENTER, losing the front at a LINE
  // boundary). Two of the four field incidents fit neither: 942 B, no newline anywhere, under
  // A's ceiling, cut mid-word at byte 928 leaving a 14 B tail.
  //
  // A composer clears on Escape. So an ESC anywhere in an unframed payload discards everything
  // typed before it and keeps what follows -- a dropped prefix, cutting at whatever offset the
  // ESC sits, which is neither a line boundary nor a byte ceiling. That is the shape.
  //
  // Why prose would carry one: these seats quote ANSI-coloured terminal output at each other,
  // and that output carries `\x1b[` literally. `input.ts` says of the same hazard that "prose
  // does not carry raw escape bytes" -- which is the assumption this test exists to question.
  const head = payload(900)
  const tail = 'and that proves this measurement wrong.'
  const text = `${head}\x1b[0m ${tail}`

  // `advertise: 'none'` is what makes it unframed: `submit()` frames only when the child has
  // ADVERTISED bracketed paste, so this is the pre-#174 path, still reachable by any child that
  // never sends ESC[?2004h.
  const messages = await submitToComposer(text, { advertise: 'none' })

  assert.equal(messages.length, 1, 'one message, not a split: there is no newline to split on')
  assert.notEqual(messages[0], text, 'and it is NOT what was sent')
  assert.ok(
    text.endsWith(messages[0]!),
    'what survives is a TAIL of the message -- a dropped prefix, which is #174 seq 7 exactly',
  )
  assert.ok(
    messages[0]!.length < text.length / 2,
    `the front is gone: ${messages[0]?.length} B survived of ${text.length} B`,
  )
  // The cut is mid-word, not at any boundary either earlier fix would produce.
  assert.ok(messages[0]!.includes(tail), 'the text after the escape is what is left')
})

test('#174 the paste framing neutralises it: the same ESC arrives as literal text', async () => {
  // And this is why the merged fix very likely already closed those two incidents. Inside a
  // bracketed paste the child inserts bytes LITERALLY -- an interior ESC is content, not a
  // keypress -- so the identical payload survives whole.
  const head = payload(900)
  const tail = 'and that proves this measurement wrong.'
  const text = `${head}\x1b[0m ${tail}`

  const messages = await submitToComposer(text)

  assert.equal(messages.length, 1, 'one message')
  assert.equal(messages[0], text, 'whole, escape byte and all')
})

test('#174 a payload carrying ESC[201~ still ends the paste early — the documented hole', async () => {
  // `input.ts` records this as a known gap and does not address it: a literal ESC[201~ inside
  // the payload closes the paste, and everything after it is keystrokes again. Written down as
  // a test rather than only as a comment, because a hazard nobody can see is one nobody
  // maintains -- and because the justification beside it ("prose does not carry raw escape
  // bytes") is the assumption the test above questions.
  //
  // NOT a regression and not a new defect: real terminals have the same hole, and the fidelity
  // guard in `adapters/promptFidelity.ts` catches the result rather than letting a fragment
  // through. This pins the SHAPE so that a future fix has something to make fail.
  const text = `before \x1b[201~ after`
  const messages = await submitToComposer(text)

  // The paste ends at the marker, so what follows is typed -- and carries no Enter of its own,
  // so it lands in the same submit rather than splitting.
  // Measured, and WORSE than the note in `input.ts` says. That note reads "would end the paste
  // early", which sounds like a truncation. What actually happens against a composer that
  // clears on Escape -- which is what a real one does:
  //
  //   1. ESC[200~ opens the paste
  //   2. the payload's own ESC[201~ closes it early, leaving `before ` in the composer
  //   3. ` after` is now KEYSTROKES, so the composer holds `before  after`
  //   4. the REAL closing ESC[201~ arrives outside any paste -- so its ESC CLEARS
  //   5. `[201~` is typed as literal text, and Enter submits that
  //
  // So the whole message is destroyed and replaced by the tail of a control sequence, rather
  // than being cut short. Nothing arrives that resembles what was sent.
  assert.deepEqual(messages, ['[201~'], 'the entire message is lost, not merely truncated')
})

test('#178 a stalled child is still observed, because the wait outlives the stall', async () => {
  // What the 600ms sleep could not do, and the reason the assertions above were unreachable.
  //
  // This child reads nothing for 1.5 s, and is sent a message small enough to sit in the tty
  // buffer intact while it waits -- so the ONLY question is whether the harness is still
  // looking when the child finally reads. `settle(600)` was not: it returned before the child
  // had taken a byte, saw an empty file, and reported zero. Waiting for the child's own
  // `READING` cannot be outrun by any amount of stalling.
  //
  // Deliberately small. The 8 KB case above is about what a tty drops under pressure and is
  // reported rather than asserted; this one holds the transport constant so the observation
  // itself is what is being tested.
  const text = payload(128)
  const messages = await submitToComposer(text, { readAfterMs: 1500 })
  assert.equal(messages.length, 1, 'the stalled child did submit, and the harness saw it')
  assert.equal(messages[0], text, 'whole, as the framing promises')
})

test('#178 the whole-or-nothing check FIRES on a fragment, which is what makes it a test', async () => {
  // The reproduction #178 asks to keep. The test above can only report what a real tty happened
  // to carry, and for the whole of its life on `main` it reported zero -- so the assertion it is
  // named for had never once executed, on any platform, in any run.
  //
  // Waiting for the child rather than for 600ms fixes the observation but cannot prove the
  // assertion works: a run that carries nothing and a run whose check is broken look identical
  // from outside. So the fragment is manufactured here and fed through the SAME function the
  // test above calls. A truncation that kept its closing ESC[201~ leaves a well-formed paste of
  // half a message, which is exactly the failure #174 exists to prevent.
  // Small on purpose. A first draft manufactured the fragment out of 2 KB and got ZERO
  // messages: written raw, without the chunking `InputQueue` exists to do, the tail of the
  // write -- closing marker and Enter included -- was eaten by the same tty limit this whole
  // file is about, and the composer sat in paste mode forever. The shape is what matters here,
  // not the size, so this stays comfortably inside one write.
  const text = payload(256)
  const half = text.slice(0, 128)
  const { pty, read } = await spawnChild(composerPath)
  try {
    // Written raw, not through InputQueue: the point is to hand the composer the bytes a broken
    // transport WOULD produce, which a working one by construction never will.
    pty.write(`${PASTE_START}${half}${PASTE_END}\r`)
    await composerQuiescent(pty)
    const messages = read()
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { text: string }).text)

    assert.equal(messages.length, 1, 'the manufactured fragment did arrive as one message')
    assert.equal(messages[0], half, 'and it is the half that was sent')
    // The check the real test relies on, run against that: it must refuse this.
    assert.throws(
      () => assertWholeOrNothing(messages, text),
      /FRAGMENT/,
      'a fragment must be refused, and named as one',
    )
    // And it must accept both legitimate outcomes, or the disjunction would be a trap of its
    // own: zero messages is the truncated case, one whole message is the intact case.
    assert.doesNotThrow(() => assertWholeOrNothing([], text))
    assert.doesNotThrow(() => assertWholeOrNothing([text], text))
    // Several messages is the other way a truncated paste can go wrong -- the framing failed
    // open and the payload's own newlines became Enters. Manufactured the same way, because
    // the branch is otherwise never taken by anything.
    assert.throws(
      () => assertWholeOrNothing([half, half], text),
      /several messages/,
      'a split submit must be refused too',
    )
  } finally {
    await stop(pty)
  }
})

test('#178 a harness that observes nothing SAYS so, rather than reporting an empty result', async () => {
  // The failure mode #178 was, reduced to its essence: the harness looked, saw nothing, and the
  // caller could not tell that from a child that genuinely submitted nothing. Now it fails, and
  // names which of the two happened.
  const { pty } = await spawnChild(composerPath, { readAfterMs: 5000 })
  try {
    await assert.rejects(
      () => composerQuiescent(pty, 800),
      /never began reading/,
      'a child that has not read must be reported, not read as a legitimate zero',
    )
  } finally {
    await stop(pty)
  }
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

const SWEEP = [256, 1024, 1025, 2048, 4096, 16_384, 65_536]

/**
 * What `submit()` DELIVERS at each size -- measured and reported, never asserted.
 *
 * This used to be seven tests, one per size, each asserting that the whole message arrived.
 * They passed on this machine and they were the wrong claim, which CI proved by failing the
 * 4096 B one on a `macos-latest` runner. The mechanism is in `yieldToChild`: `pty.write` does
 * not write, it queues, and node-pty drains that queue by recursing through `fs.write`
 * callbacks without yielding. So the timer between chunks acknowledges neither the write nor a
 * read, several 256 B chunks can reach the driver back to back, and a chunked send is a lower
 * probability of loss rather than a delivered message. A test cannot assert its way out of
 * that: at best it observes the good case and goes red on the machine where the odds land the
 * other way, which is precisely what happened.
 *
 * So the sweep stays as EVIDENCE and stops being a promise. It prints what each size actually
 * delivered on this platform and this run, which is the thing that would have made the CI
 * failure a data point instead of a mystery -- and it has since earned that: run 33104083028
 * caught darwin-x64 losing bytes at five sizes in one attempt, down to 47610 of 65536. See
 * WHAT THE PACING EVIDENCE SUPPORTS above for the full tally and for what it does and does not
 * license anyone to claim. The promise a caller gets is made where it can be
 * kept -- in the adapters, where the child says what it took and a short message is re-sent
 * once and then refused. `adapters/promptFidelity.test.ts` holds that contract at 4096 B,
 * through real adapters, and it is the test that fails if the guarantee stops being true.
 */
test('#174 what submit() delivers at each size, measured and reported', async (t) => {
  const rows: string[] = []
  for (const n of SWEEP) {
    const text = payload(n)
    const got = payloadOf(await submitAndRecord(text))
    rows.push(`${n}->${got.length}${got.length === text.length ? '' : ' SHORT'}`)
  }
  // The real wire shapes as well, header and blank line and all, at the body sizes the field
  // incidents came in at plus one far past anything a run has produced.
  for (const bodyBytes of [245, 934, 64_000]) {
    const wire = envelope({ from: 'advisor', fromRank: 'advisor', kind: 'instruction', text: payload(bodyBytes) })
    const got = payloadOf(await submitAndRecord(wire))
    rows.push(`envelope(${bodyBytes})=${wire.length}->${got.length}${got.length === wire.length ? '' : ' SHORT'}`)
  }
  t.diagnostic(`submit() through a real pty on ${THIS_PLATFORM}: ${rows.join(', ')}`)
})

test('#174 no chunk boundary ever falls inside a code point, at any offset', async () => {
  // 256 bytes is 64 four-byte emoji exactly, so an unpadded payload would only ever split on a
  // clean boundary and prove nothing. The pad walks the boundary into the middle of a surrogate
  // pair, which is where a byte-wise slice would produce U+FFFD -- corruption that still parses,
  // which is worse than the truncation this fix is about.
  //
  // Asserted at the WRITE level, not at the child. What arrives is the tty's business and it may
  // cut anywhere, including mid-character; what conclave hands to the driver is conclave's
  // business, and it must never be a lone surrogate. A test that read this off the child's
  // recording would fail on a platform whose queue truncated mid-emoji and would blame the wrong
  // layer for it.
  for (const pad of [0, 1, 2, 3]) {
    const text = `${'x'.repeat(pad)}${'\u{1F600}'.repeat(400)}`
    const { pty } = await spawnChild(recorderPath)
    const writes: string[] = []
    const real = pty.write.bind(pty)
    ;(pty as unknown as { write: (d: string) => void }).write = (d: string) => {
      writes.push(d)
      real(d)
    }
    try {
      await new InputQueue(pty).submit(text)
      const body = writes.filter((w) => w !== PASTE_START && w !== PASTE_END && w !== '\r')
      assert.equal(body.join(''), text, `pad=${pad}: the writes must rejoin into exactly the message`)
      for (const w of body) {
        // A lone surrogate is what a byte-wise split leaves behind, and node-pty encodes it as
        // U+FFFD on the way to the fd.
        assert.ok(
          !/[\uD800-\uDFFF]/.test(w.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')),
          `pad=${pad}: a write ended inside a surrogate pair`,
        )
      }
    } finally {
      await stop(pty)
    }
  }
})

test('#174 the paste framing is gated on the bracketedPaste marker, not on isInteractive', async () => {
  const text = payload(300)

  const framed = await submitAndRecord(text)
  assert.ok(framed.startsWith(PASTE_START), 'a child that advertised bracketed paste gets the framing')
  assert.ok(framed.replace(/[\r\n]+$/, '').endsWith(PASTE_END), 'and gets it closed')

  const bare = await submitAndRecord(text, { advertise: 'none' })
  assert.ok(!bare.includes(PASTE_START), 'a child that never advertised it must not be sent ESC[200~')
  // 300 B, under every tty ceiling in evidence, so what arrives is about the FRAMING and not
  // about the transport -- see the header for why size is not something to assert here.
  assertWholeMessageArrived(text, payloadOf(bare), '300 B to a child with no paste support')
})

test('#174 an interactive child that never advertised PASTE is not framed anyway', async () => {
  // The gate is `bracketedPaste`, not `isInteractive`, and this is the case that tells them
  // apart. Focus events and the kitty keyboard protocol are the other two DECISIVE markers, so
  // this child is fully interactive -- and it has said nothing whatsoever about ESC[200~.
  // Framing it would be conclave guessing that a receiver parses a framing it never claimed.
  const text = payload(300)
  const { pty, read } = await spawnChild(recorderPath, { advertise: 'focus' })
  try {
    assert.equal(pty.isInteractive, true, 'focus events and kitty are decisive markers')
    assert.equal(pty.bracketedPaste, false, 'but neither of them is bracketed paste')

    await new InputQueue(pty).submit(text)
    await settle(600)
    const got = read()
    assert.ok(!got.includes(PASTE_START), 'an interactive child that never claimed paste must not be sent ESC[200~')
    // 300 B, under every tty ceiling in evidence: this is a claim about the framing gate, not
    // about how much a pty will carry.
    assertWholeMessageArrived(text, payloadOf(got), '300 B to an interactive child with no paste support')
  } finally {
    await stop(pty)
  }
})

test('#174 the paste markers are written whole, never split across a chunk boundary', async () => {
  // Observed at the WRITE level, because at the byte level a split marker is indistinguishable
  // from a whole one -- the tty concatenates either way, and a child that buffers its escape
  // parser would not notice. That is exactly why it needs pinning here: nothing downstream can
  // tell, so nothing downstream can catch it if the framing starts being chunked with the body.
  //
  // The payload length is chosen so that a naive `chunkForPty(START + text + END)` would put a
  // boundary INSIDE the closing marker: 6 + 1018 = 1024 is a multiple of the 256 B budget, so
  // the last chunk would begin three bytes into ESC[201~.
  const text = payload(1018)
  const { pty } = await spawnChild(recorderPath)
  const writes: string[] = []
  const real = pty.write.bind(pty)
  ;(pty as unknown as { write: (d: string) => void }).write = (d: string) => {
    writes.push(d)
    real(d)
  }
  try {
    await new InputQueue(pty).submit(text)
    assert.ok(
      writes.includes(PASTE_START),
      `ESC[200~ must be one write of its own; writes were ${JSON.stringify(writes.map((w) => w.length))}`,
    )
    assert.ok(
      writes.includes(PASTE_END),
      `ESC[201~ must be one write of its own; writes were ${JSON.stringify(writes.map((w) => w.length))}`,
    )
    // And no other write may carry a marker, whole or in part: a chunk that ends mid-escape is
    // the failure this is about, and it shows up as a fragment rather than as a full marker.
    for (const w of writes) {
      if (w === PASTE_START || w === PASTE_END || w === '\r') continue
      assert.ok(!w.includes('\x1b'), `a body chunk must carry no escape bytes: ${JSON.stringify(w.slice(0, 24))}`)
    }
  } finally {
    await stop(pty)
  }
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
  // 900 B, deliberately under the smallest tty ceiling in evidence. Defect B is a claim about
  // NEWLINES, not about size -- the header's blank line broke a message of any length -- so
  // proving it needs no payload big enough for the transport to be a variable. A 2000 B version
  // of this test would be asserting delivery as well, which is not something to assert.
  const wire = envelope({ from: 'advisor', fromRank: 'advisor', kind: 'instruction', text: payload(900) })
  const messages = await submitToComposer(wire)
  assert.equal(
    messages.length,
    1,
    `arrived as ${messages.length} messages: ${JSON.stringify(messages.map((m) => ({ bytes: m.length, head: m.slice(0, 24) })))}`,
  )
  assertWholeMessageArrived(wire, messages[0]!, 'a 900 B body in the real envelope')
})

test('#174 a composer with no paste support still splits, and that is the gate working', async () => {
  // The honest limit of gating on the marker: a child that never advertised bracketed paste is
  // typed at, so its newlines are still Enters. Pinned so nobody reads the fix as universal.
  const text = [payload(100), payload(100), payload(100)].join('\n')
  const messages = await submitToComposer(text, { advertise: 'none' })
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
