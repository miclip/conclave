/**
 * The console under a real terminal.
 *
 * `session.test.ts` drives it with a piped stream, which proves the command dispatch and
 * nothing about the interactive experience — with `terminal: false` readline does no line
 * editing and no redrawing, so the hardest part is not exercised at all.
 *
 * The question this answers is whether it is genuinely usable at a keyboard or just a
 * command dispatcher that happens to read stdin:
 *
 *   1. does typed-but-unsubmitted text survive asynchronous output landing on top of it?
 *   2. does Ctrl-C tear the participants down instead of orphaning them?
 *
 * Both only exist under a TTY, so this allocates one with node-pty — the same transport the
 * adapters use on the children.
 *
 *   node --test src/repl/session.tty.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Progress } from './render.ts'

const REPO = join(import.meta.dirname, '..', '..')

/** A driver that runs the console over fakes slow enough to type at. */
function driver(dir: string, goal: string | null = 'Keep the work moving.', quiet: boolean = false): string {
  const path = join(dir, 'driver.mjs')
  const goalArg = goal === null ? 'undefined' : JSON.stringify(goal)
  writeFileSync(
    path,
    `
import { runSession } from ${JSON.stringify(join(REPO, 'src/repl/session.ts'))}
import { AgentRegistry } from ${JSON.stringify(join(REPO, 'src/registry/registry.ts'))}
import { FakeRotationSession } from ${JSON.stringify(join(REPO, 'src/rotation/fakeSession.ts'))}
import { NO_DEADLINE_CLOCKS } from ${JSON.stringify(join(REPO, 'src/registry/types.ts'))}

const caps = {
  readinessSignal: 'unknown', turnKeySource: 'prompt_id',
  outcomes: { completed: 'observed', cancelled: 'reasoned_but_unverified',
    permission_refused: 'reasoned_but_unverified', process_exited: 'reasoned_but_unverified',
    timed_out: 'reasoned_but_unverified', transport_lost: 'reasoned_but_unverified',
    unknown_abnormal_end: 'reasoned_but_unverified' },
}
const slow = (id, agent, replies) => {
  const s = new FakeRotationSession(id, agent, replies)
  s.delayMs = 1500
  return s
}
const impl = slow('impl', 'claude', ['ack', 'Did it.', 'And again.'])
const registry = new AgentRegistry()
for (const [agent, session] of [['codex', slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'])], ['claude', impl]]) {
  registry.register({
    id: agent, displayName: agent, capabilities: { ...caps, agent },
    deadlines: NO_DEADLINE_CLOCKS,
    launch: { command: agent, baseArgs: [] }, async create() { return session },
  })
}
// Emit activity on a timer, so something lands while a line is half-typed.
${quiet ? '' : `setInterval(() => impl.emit({ type: 'tool_use', tool: 'Read', input: {}, seq: 99, at: Date.now(), provisional: true }), 700).unref()`}

const code = await runSession({
  cwd: ${JSON.stringify(dir)}, goal: ${goalArg},
  lead: 'codex', implementer: 'claude', rounds: 6, checks: [], registry,
})
process.exit(code)
`,
  )
  return path
}

/**
 * The same console with TWO implementer seats, both slow enough to be caught working.
 *
 * A separate driver rather than a parameter on the one above: this run needs an advisor that
 * addresses seats BY NAME — the only way to put two of them to work from one reply — and a
 * seat list, and threading both through the single-seat driver would leave every existing test
 * carrying arguments about a case it is not about.
 */
function twoSeatDriver(dir: string): string {
  // OUTSIDE the repository, unlike the single-seat driver. Two seats take linked worktrees, and
  // that refuses to start over an unclean base -- so a driver written into the checkout is a
  // stray untracked file that stops the very run it starts.
  const path = join(mkdtempSync(join(tmpdir(), 'conclave-tty-driver-')), 'two-seat-driver.mjs')
  writeFileSync(
    path,
    `
import { runSession } from ${JSON.stringify(join(REPO, 'src/repl/session.ts'))}
import { AgentRegistry } from ${JSON.stringify(join(REPO, 'src/registry/registry.ts'))}
import { FakeRotationSession } from ${JSON.stringify(join(REPO, 'src/rotation/fakeSession.ts'))}
import { NO_DEADLINE_CLOCKS } from ${JSON.stringify(join(REPO, 'src/registry/types.ts'))}

const caps = {
  readinessSignal: 'unknown', turnKeySource: 'prompt_id',
  outcomes: { completed: 'observed', cancelled: 'reasoned_but_unverified',
    permission_refused: 'reasoned_but_unverified', process_exited: 'reasoned_but_unverified',
    timed_out: 'reasoned_but_unverified', transport_lost: 'reasoned_but_unverified',
    unknown_abnormal_end: 'reasoned_but_unverified' },
}
const slow = (id, agent, replies, ms) => {
  const s = new FakeRotationSession(id, agent, replies)
  s.delayMs = ms
  return s
}
// One reply, two seats, addressed by the ids the console constructs: seatIdFor(0) and (1).
const assignment = '@seat implementer: rebuild the parser\\n@seat implementer-2: rewrite the docs'
const sessions = {
  codex: slow('advisor', 'codex', [assignment, 'DONE', 'DONE', 'DONE'], 300),
  alpha: slow('alpha', 'alpha', ['ack', 'Did it.', 'NONE', 'NONE'], 6000),
  beta: slow('beta', 'beta', ['ack', 'Did that too.', 'NONE', 'NONE'], 6000),
}
const registry = new AgentRegistry()
for (const [agent, session] of Object.entries(sessions)) {
  registry.register({
    id: agent, displayName: agent, capabilities: { ...caps, agent },
    deadlines: NO_DEADLINE_CLOCKS,
    launch: { command: agent, baseArgs: [] }, async create() { return session },
  })
}

const code = await runSession({
  cwd: ${JSON.stringify(dir)}, goal: 'Keep the work moving.',
  lead: 'codex', implementer: 'alpha', implementers: ['alpha', 'beta'],
  rounds: 6, checks: [], registry,
})
process.exit(code)
`,
  )
  return path
}

function repo(gitignore = '.conclave/\n'): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-tty-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), gitignore)
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], { cwd: dir })
  return dir
}

/**
 * Spawn the console under a pty, and kill it on teardown WHATEVER happens.
 *
 * Killing at the end of the happy path meant a failed assertion threw first, the child
 * survived, and node could not exit — so one broken expectation hung the whole suite past
 * every per-test timeout. A test that cannot fail cleanly is worse than no test.
 */
async function spawnConsole(
  dir: string,
  t?: { after: (fn: () => void) => void },
  goal: string | null = 'Keep the work moving.',
  quiet: boolean = false,
  /** Which driver to run. The one-seat console, unless a test needs a differently-shaped run. */
  script: (dir: string) => string = (d) => driver(d, goal, quiet),
) {
  const { default: pty } = await import('node-pty')
  const p = pty.spawn(process.execPath, [script(dir)], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: dir,
    env: { ...process.env } as Record<string, string>,
  })
  let buf = ''
  const rows = 30
  const cols = 100
  let answeredQueryIndex = 0
  p.onData((d: string) => {
    buf += d
    // If the console queries the cursor position, answer it from the replayed cursor
    // position so the test harness behaves like a real terminal emulator. Track answered
    // offsets separately so the captured byte stream remains byte-for-byte intact.
    for (;;) {
      const queryIndex = buf.indexOf('\x1b[6n', answeredQueryIndex)
      if (queryIndex < 0) break
      const before = buf.slice(0, queryIndex)
      const pos = parseTerminal(before, rows, cols).cursor
      p.write(`\x1b[${pos.r + 1};${pos.c + 1}R`)
      answeredQueryIndex = queryIndex + 4
    }
  })
  t?.after(() => {
    try {
      p.kill()
    } catch {
      /* already gone */
    }
  })
  return {
    proc: p,
    text: () => buf,
    type: (s: string) => p.write(s),
    /**
     * Wait for a predicate over the accumulated screen bytes.
     *
     * Raising this budget was the WRONG fix and is recorded as such: it turned a 20s red
     * into a 60s red rather than a green, because under contention the console genuinely does
     * not reach its prompt in time -- the wait is not the problem, the contention is.
     *
     * What addresses it is capping test concurrency (see the `test` script): these spawn real
     * ptys and real node processes, and letting the runner start as many workers as it likes
     * is what starves them. The budget stays generous because a starved-but-progressing
     * console should still be allowed to finish rather than be called broken.
     */
    async until(pred: (s: string) => boolean, ms = 60_000): Promise<boolean> {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (pred(buf)) return true
        await new Promise((r) => setTimeout(r, 50))
      }
      return false
    },
  }
}

/**
 * Replay a terminal byte stream into a character grid and the final cursor position.
 *
 * The screen is a DEC-style scroll region plus absolute cursor addressing. To assert where
 * something *is* rather than merely whether it appears somewhere in the byte stream, the
 * same primitives (scroll region, cursor movement, line clears, scroll down) are replayed
 * here.
 */
function parseTerminal(buf: string, rows: number, cols: number): { grid: string[][]; cursor: { r: number; c: number } } {
  const grid: string[][] = Array.from({ length: rows }, () => ' '.repeat(cols).split(''))
  let r = 0
  let c = 0
  let top = 1
  let bot = rows
  // OSC title sequences, CSI sequences, newlines, carriage returns, and plain text.
  const re = /\x1b\]0;[^\x07]*\x07|\x1b\[([0-9;]*)([A-Za-z])|\n|\r|[^\x1b\n\r]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(buf))) {
    const tok = m[0]
    if (tok === '\n') {
      if (r >= bot - 1) {
        grid.splice(top - 1, 1)
        grid.splice(bot - 1, 0, ' '.repeat(cols).split(''))
      } else {
        r = Math.min(rows - 1, r + 1)
      }
    } else if (tok === '\r') {
      c = 0
    } else if (tok.startsWith('\x1b[')) {
      const a = (m[1] ?? '').split(';')
      const k = m[2]
      if (k === 'H') {
        r = (parseInt(a[0] ?? '1') || 1) - 1
        c = (parseInt(a[1] ?? '1') || 1) - 1
      } else if (k === 'r') {
        top = parseInt(a[0] ?? '1') || 1
        bot = parseInt(a[1] ?? String(rows)) || rows
      } else if (k === 'K') {
        const mode = parseInt(a[0] ?? '0') || 0
        if (mode === 0 || mode === 2) {
          for (let i = mode === 0 ? c : 0; i < cols; i++) grid[r]![i] = ' '
        } else if (mode === 1) {
          for (let i = 0; i <= c; i++) grid[r]![i] = ' '
        }
      } else if (k === 'J') {
        const mode = parseInt(a[0] ?? '0') || 0
        if (mode === 0) {
          for (let i = c; i < cols; i++) grid[r]![i] = ' '
        } else if (mode === 2) {
          for (let row = 0; row < rows; row++) {
            for (let i = 0; i < cols; i++) grid[row]![i] = ' '
          }
        }
      } else if (k === 'T') {
        // Scroll Down: insert n blank lines at the top of the scroll region.
        const n = parseInt(a[0] ?? '1') || 1
        for (let i = 0; i < n; i++) {
          grid.splice(top - 1, 0, ' '.repeat(cols).split(''))
          grid.splice(bot, 1)
        }
      } else if (k === 'L') {
        // Insert Line: insert n blank lines at the cursor row.
        const n = parseInt(a[0] ?? '1') || 1
        for (let i = 0; i < n; i++) {
          grid.splice(r, 0, ' '.repeat(cols).split(''))
          grid.splice(bot, 1)
        }
      }
      // SGR (m), save/restore cursor (s/u), DSR (6n), and other ignored sequences are no-ops
      // for grid placement.
    } else if (tok.startsWith('\x1b]')) {
      // OSC sequences (window title, etc.) are non-printing.
    } else {
      for (const ch of tok) {
        if (c < cols) grid[r]![c++] = ch
      }
    }
  }
  return { grid, cursor: { r, c } }
}

function renderGrid(buf: string, rows: number, cols: number): string[][] {
  return parseTerminal(buf, rows, cols).grid
}

test('typed-but-unsubmitted text survives asynchronous output', async (t) => {
  const dir = repo()
  const c = await spawnConsole(dir, t)
  assert.ok(await c.until((s) => s.includes('›')), 'the prompt should appear')

  // Type a partial line and leave it uncommitted.
  // `>` addresses; `@` is a path. The old sigil made this line a broadcast containing a
  // nonexistent path, which still queued — but to everyone, so the assertion below missed.
  c.type('>implementer keep the diff small')
  assert.ok(await c.until((s) => s.includes('keep the diff small')), 'the typed text should echo')

  const before = c.text().length
  // A routed message lands on top of it — the case a bare out.write() destroys. Tool
  // activity no longer qualifies: it is a status line that deliberately stands down while
  // the operator is typing, so it cannot be the thing that tests interleaving.
  assert.ok(await c.until((s) => s.slice(before).includes('●')), 'a message should arrive')

  // After the interleaved write, the prompt AND the buffer must have been redrawn, or the
  // operator is left staring at a line they cannot see.
  const tail = c.text().slice(before)
  assert.ok(
    tail.includes('keep the diff small'),
    `the typed line was not redrawn after async output. tail was:\n${JSON.stringify(tail.slice(-400))}`,
  )

  // And it still submits as typed. The confirmation is the message ITSELF, pinned above the
  // box until a participant takes it — so this asserts the text made it through the
  // redraw and into the queue, not merely that a sentence about it was printed.
  c.type('\r')
  assert.ok(
    await c.until((s) => /→ implementer\s+keep the diff small/.test(s)),
    'the redrawn line must still be the line that gets sent',
  )
  // No `withheld from advisor` line is expected: `→ implementer` already carries where it
  // went, and the exclusion is answered by `/audit` rather than narrated on every line.
  assert.ok(!c.text().includes('withheld from'), 'the exclusion must not be narrated')
  c.proc.kill()
})

test('the pinned status keeps moving, so a silent turn cannot read as a hung one', async (t) => {
  // This test used to assert progress was APPEND-ONLY and never repeated a line. That was
  // right while readline owned the last line of the terminal: an in-place status and
  // readline both redrew there, whichever wrote last won, and the loser was stranded. The
  // reasoning is preserved in `Progress`.
  //
  // The console owns the screen now, so the status is pinned and redrawing it is no longer
  // a contest. The property that matters moved with it: redraws driven by EVENTS leave the
  // line frozen through a single long tool call — same glyph, same elapsed time, for
  // minutes — and a motionless status is indistinguishable from a dead session. So what is
  // asserted is motion, and specifically motion during a window with no events at all.
  const dir = repo()
  const c = await spawnConsole(dir, t)
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  const frames = new RegExp(`[${Progress.SPINNER.join('')}]`, 'g')
  assert.ok(await c.until((s) => s.includes('›')))
  assert.ok(await c.until((s) => frames.test(plain(s)), 15_000), 'a status line should appear')

  const seen = new Set<string>()
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    for (const f of plain(c.text()).match(frames) ?? []) seen.add(f)
    if (seen.size > 1) break
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.ok(
    seen.size > 1,
    `the spinner must advance on its own clock; only ever saw ${[...seen].join('') || 'nothing'}`,
  )
  c.proc.kill()
})

test('a typed message appears once, not as a block and a queued row at the same time', async (t) => {
  // A typed line is recorded and queued in one call. The record was rendered immediately as
  // a `● you → advisor` block, AND the queue put the same sentence in the pinned rows — so
  // the transcript showed it delivered while the box below still showed it waiting. Two
  // copies, disagreeing about whether it had been read.
  const dir = repo()
  const c = await spawnConsole(dir, t)
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  assert.ok(await c.until((s) => s.includes('›')))

  const line = 'check the error path too'
  c.type(`>implementer ${line}\r`)
  assert.ok(await c.until((s) => plain(s).includes(line)), 'the message should appear somewhere')

  // The box redraws continuously, so the pinned row legitimately recurs in the byte
  // stream. What must never happen is the SPEAKER BLOCK and a pinned row coexisting: take
  // the final frame and require at most one of the two forms.
  await new Promise((r) => setTimeout(r, 1_500))
  const frame = plain(c.text()).slice(-4_000)
  // Discriminated by ADDRESSEE, not by the `● you` glyph: the goal is also a `you` block,
  // but it is addressed `→ advisor, implementer`. Only this message is implementer-only.
  const asBlock = /● you → implementer(?!,)/.test(frame)
  const asRow = new RegExp(`→ implementer\\s{2,}${line}`).test(frame)
  assert.ok(
    !(asBlock && asRow),
    `the same message was shown as a delivered block AND a queued row:\n${frame.slice(-1_200)}`,
  )
  c.proc.kill()
})

test('Ctrl-C tears the session down instead of orphaning it', async (t) => {
  // The failure this guards against is the one that held a test process open for 26
  // minutes: children with nothing to reap them. A fake has no PTY, so what is asserted
  // here is that the interrupt reaches the run and the process exits — the adapter-side
  // termination is covered by the rollback suite.
  const dir = repo()
  const c = await spawnConsole(dir, t)
  assert.ok(await c.until((s) => s.includes('›')))

  const exited = new Promise<number>((resolve) => c.proc.onExit(({ exitCode }) => resolve(exitCode)))
  c.type('\x03')

  assert.ok(await c.until((s) => s.includes('interrupt — aborting the run')), 'the interrupt must be reported')
  const code = await Promise.race([
    exited,
    new Promise<number>((r) => setTimeout(() => r(-1), 15_000)),
  ])
  assert.notEqual(code, -1, 'the console must exit rather than hang after an interrupt')
})

test('the box is pinned below the transcript, and progress lives only in it', async (t) => {
  // Reconstructed from the byte stream rather than searched in it. A scrolling transcript
  // plus an absolutely-addressed box cannot be judged by substring: the same text appears
  // in the stream whether it landed in the box, above it, or was overwritten a frame later.
  // Replaying the escapes into a grid answers where it actually IS.
  const dir = repo()
  const c = await spawnConsole(dir, t, undefined, true)
  assert.ok(await c.until((s) => /─{20,}/.test(s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')), 20_000))
  c.type('typing here')
  await new Promise((r) => setTimeout(r, 1500))

  const rows = 30
  const cols = 100
  const grid = Array.from({ length: rows }, () => ' '.repeat(cols).split(''))
  let r = 0
  let col = 0
  let top = 1
  let bot = rows
  const re = /\x1b\[([0-9;]*)([A-Za-z])|\n|\r|[^\x1b\n\r]+/g
  let m: RegExpExecArray | null
  const buf = c.text()
  while ((m = re.exec(buf))) {
    const tok = m[0]
    if (tok === '\n') {
      if (r === bot - 1) {
        grid.splice(top - 1, 1)
        grid.splice(bot - 1, 0, ' '.repeat(cols).split(''))
      } else r = Math.min(rows - 1, r + 1)
    } else if (tok === '\r') col = 0
    else if (tok.startsWith('\x1b')) {
      const a = (m[1] ?? '').split(';')
      const k = m[2]
      if (k === 'H') {
        r = (parseInt(a[0] ?? '1') || 1) - 1
        col = (parseInt(a[1] ?? '1') || 1) - 1
      } else if (k === 'r') {
        top = parseInt(a[0] ?? '1') || 1
        bot = parseInt(a[1] ?? String(rows)) || rows
      } else if (k === 'K') for (let i = col; i < cols; i++) grid[r]![i] = ' '
      else if (k === 'J') {
        // Erase in display. Without this the model kept every row the console had erased,
        // and the box appeared to exist at every position it had ever occupied — so a test
        // looking for the input row found the oldest one and read the transcript line above
        // it as a missing rule. The console has erased to end-of-screen since it started
        // clearing under a descending box; the emulator simply could not see it.
        const mode = parseInt(a[0] ?? '0') || 0
        const from = mode === 1 ? 0 : mode === 2 ? 0 : r
        const to = mode === 1 ? r : rows - 1
        for (let y = from; y <= to; y++) {
          const startCol = mode === 0 && y === r ? col : 0
          for (let i = startCol; i < cols; i++) grid[y]![i] = ' '
        }
      }
    } else for (const ch of tok) if (col < cols) grid[r]![col++] = ch
  }
  const line = (n: number) => grid[n - 1]!.join('').replace(/\s+$/, '')

  // Find the box rather than assuming it is at the bottom of the terminal. It is only there
  // once output has filled the screen; before that it sits directly under the last transcript
  // line and descends as more is printed. This test is about the box's internal layout and
  // about where the status may appear, neither of which depends on which row it starts on.
  const inputRow = Array.from({ length: rows }, (_, i) => i + 1).find((n) =>
    /›\s*typing here/.test(line(n)),
  )
  assert.ok(inputRow, `the input row should be on screen, holding what was typed`)

  // The status is inlaid into the top rule rather than given a row of its own: a permanent
  // row for one short phrase is a row spent on nothing.
  assert.match(line(inputRow - 1), /─{10,}/, 'rule above the input')
  assert.match(line(inputRow), /›\s*typing here/, 'the input row holds what was typed')
  assert.match(line(inputRow + 1), /─{20,}/, 'rule below the input')
  // The row below answers what is being typed. With an ordinary line typed and no
  // completion pending it is empty, which is the point — it is not a status line.
  assert.ok(!/⋯/.test(line(inputRow + 2)), 'the row below is not a second status line')

  // Wherever the status appears, it is on the top rule and nowhere else. Asserting that it
  // IS present would be timing-dependent — it exists only while a turn runs — but asserting
  // where it may appear holds whether or not one is running.
  const statusRows = Array.from({ length: rows }, (_, i) => i + 1).filter((n) => /⋯/.test(line(n)))
  assert.deepEqual(
    statusRows.filter((n) => n !== inputRow - 1),
    [],
    `the status appeared off the top rule — in the transcript it reads as duplicates:\n${statusRows
      .map((n) => `${n}| ${line(n)}`)
      .join('\n')}`,
  )
})

test('the banner stays visible and the first post-open transcript line is close to the startup text', async (t) => {
  // Reconstructed from the byte stream rather than searched in it. The first line written
  // after Screen.open() is the no-goal prompt; the rule printed before it is the last startup
  // line. The gap between them must be small, not the entire empty scroll region.
  const dir = repo()
  const c = await spawnConsole(dir, t, null, true)
  const rows = 30
  const cols = 100
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  assert.ok(
    await c.until((s) => plain(s).includes('no goal given — type one to start, or /help'), 20_000),
    'the no-goal prompt should appear',
  )

  const grid = renderGrid(c.text(), rows, cols)
  const lineText = (n: number) => grid[n - 1]!.join('').replace(/\s+$/, '')

  const bannerRow = grid.findIndex((row) => /conclave\s+\d/.test(row.join('').replace(/\s+$/, '')))
  assert.notEqual(bannerRow, -1, 'the banner should remain visible')

  // The rule printed before Screen.open() is the last startup line.
  const startupRuleRow = grid.findIndex((row) => /^─{20,}$/.test(row.join('').replace(/\s+$/, '')))
  assert.notEqual(startupRuleRow, -1, 'the startup rule should be present')
  const lastStartupRow = startupRuleRow + 1

  // The no-goal prompt is the first line written after Screen.open(), so it is the first
  // transcript line.
  const firstTranscriptRow = grid.findIndex((row) => /no goal given — type one to start/.test(row.join('').replace(/\s+$/, '')))
  assert.notEqual(firstTranscriptRow, -1, 'the no-goal prompt should be present in the grid')
  const firstTranscriptRowNum = firstTranscriptRow + 1

  const blankRows = Array.from(
    { length: firstTranscriptRow - startupRuleRow - 1 },
    (_, i) => startupRuleRow + i + 1,
  ).filter((n) => lineText(n + 1).length === 0).length
  assert.ok(
    blankRows <= 2,
    `expected at most 2 blank rows between the startup rule and the first post-open transcript line, got ${blankRows} (startup rule row ${lastStartupRow}, first transcript row ${firstTranscriptRowNum})`,
  )
  c.proc.kill()
})

test('the box is drawn under the newest line, and nothing is scrolled to make room', async (t) => {
  // The property is that ALREADY-PRINTED TEXT DOES NOT MOVE. Output goes under the last line
  // and the box follows it down; nothing above is disturbed.
  //
  // The version this replaces asserted the opposite — that every write lands on the region's
  // last row — which is true only once the box has reached the floor. Starting there is what
  // two operators reported as a bug: first as a band of blank rows between the startup rule
  // and the first line, then, after that was "fixed" by scrolling the screen down to close
  // it, as the whole terminal lurching downward and taking their shell prompt with it. The
  // old assertion held throughout both, because a console that puts every line at the floor
  // satisfies it whether or not it moved the screen to get there.
  const dir = repo()
  const c = await spawnConsole(dir, t)
  const rows = 30
  const cols = 100
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  assert.ok(
    await c.until((s) => /─{20,}/.test(plain(s)), 20_000),
    'the banner rule should appear',
  )

  c.type('>advisor first message\r')
  assert.ok(
    await c.until((s) => plain(s).includes('first message'), 20_000),
    'first message should be in the transcript',
  )

  c.type('>advisor second message\r')
  assert.ok(
    await c.until((s) => plain(s).includes('second message'), 20_000),
    'second message should be in the transcript',
  )
  // WHERE the box is drawn is asserted in `screen.test.ts`, not here, and that is a
  // deliberate division rather than a gap.
  //
  // Four versions of this test tried to assert position from a pty, and all four failed on
  // machines slower than the one they were written on. The reason is in the driver: it emits
  // activity every 700ms for as long as the console runs, so the transcript never stops
  // scrolling and no particular line stays put. The last attempt — "the box is directly
  // under the second message" — is not merely racy but false, because by the time the
  // console has drawn that message the next event has usually already followed it. There is
  // no instant to catch.
  //
  // The unit tests drive a fake stream where nothing scrolls underneath the assertion, and
  // check the exact row against a reported cursor position. What only a pty can answer is
  // the question below, which does not depend on timing at all.

  // And the direct guard, on the byte stream rather than the rendered grid: the console
  // never scrolls the screen to make room for itself.
  //
  // This is the assertion that actually pins the reported bug, and it is here because the
  // screen check above does not. Text can only be pushed DOWN by a scroll-down or a
  // line-insert, and once the only `ESC[{n}T` in the console is gone there is no plausible
  // mistake left that the row comparison would catch — it would keep passing through a
  // rewrite that reintroduced the fault by some other means. What is unfalsifiable is not
  // load-bearing, so the falsifiable version sits next to it.
  assert.doesNotMatch(
    c.text(),
    /\x1b\[\d*[TL]/,
    'the console scrolled or inserted lines, which moves text the operator was reading',
  )
  c.proc.kill()
})

test('two working seats get a row each above the box, and come off the status rule', async (t) => {
  // The console half of #65. With one seat the status rule holds the worker — `⠋ implementer
  // 5s · Bash` inlaid into the rule — and that arrangement does not survive a second seat: the
  // rule is ONE row, so two names, two clocks and two tool names either overflow the terminal
  // or wrap onto a row the box never reserved, which is the transcript's row.
  //
  // So the seats move onto rows of their own, one each, and this asserts both halves: they are
  // THERE, distinguishable, each naming its own task, and they are no longer on the rule.
  //
  // Reconstructed from the grid rather than searched in the byte stream. A seat name appears in
  // the stream from the moment the run brief is printed; what is being claimed here is that at
  // this instant it is on a pinned row, which only a replayed screen can answer.
  // `.codex/` as well: the console registers its sidecar hooks in the checkout at startup, and
  // seat worktrees refuse to be created over anything uncommitted -- including that.
  const dir = repo('.conclave/\n.codex/\n')
  const c = await spawnConsole(dir, t, undefined, true, twoSeatDriver)
  const rows = 30
  const cols = 100

  // Both seats dispatched from the one advisor reply, and both still working: the fakes take
  // six seconds a turn, so this instant is several seconds wide rather than a race.
  const bothWorking = (s: string): boolean => {
    const grid = renderGrid(s, rows, cols).map((r) => r.join('').trimEnd())
    return (
      grid.some((line) => /implementer\b.*rebuild the parser/.test(line)) &&
      grid.some((line) => /implementer-2\b.*rewrite the docs/.test(line))
    )
  }
  assert.ok(
    await c.until(bothWorking, 40_000),
    `both seats should have a pinned row naming their own task. screen was:\n${renderGrid(c.text(), rows, cols)
      .map((r) => r.join('').trimEnd())
      .filter(Boolean)
      .join('\n')}`,
  )

  const grid = renderGrid(c.text(), rows, cols).map((r) => r.join('').trimEnd())
  const alphaRow = grid.findIndex((line) => /implementer\b.*rebuild the parser/.test(line))
  const betaRow = grid.findIndex((line) => /implementer-2\b.*rewrite the docs/.test(line))
  assert.notEqual(alphaRow, betaRow, 'two seats are two rows: one row holding both is the thing being replaced')

  // The rule that carries the status is the one directly below the seat rows, and it must not
  // be naming them as well. Two copies of the same fact is what the pinned box exists to end,
  // and the copy on the rule is the one that wraps.
  const ruleRow = grid.findIndex((line, i) => i > Math.max(alphaRow, betaRow) && /─{20,}/.test(line))
  assert.ok(ruleRow > 0, 'the box rule should sit below the seat rows')
  assert.doesNotMatch(
    grid[ruleRow]!,
    /implementer/,
    'a seat with a row of its own must not also be inlaid into the status rule',
  )
  // Adjacent, in that order: seats, then the rule, then the input. A gap would mean the box
  // reserved rows it did not draw into, which is a row of transcript painted blank.
  assert.equal(Math.max(alphaRow, betaRow) + 1, ruleRow, 'the seat rows sit directly on top of the box')
  c.proc.kill()
})

test('a one-seat console reserves the four rows it always did, even while the seat is working', async (t) => {
  // D1's identity case for the pinned box, asserted in the one unit that cannot be argued
  // with: the size of the scrolling region. A default console reserves four rows — rule,
  // input, rule, hint — and `ESC[1;26r` on a 30-row terminal is that fact in bytes.
  //
  // This exists because the seat rows are the kind of feature that "obviously" costs nothing
  // at N=1 and silently does: with one seat there IS a seat, it IS busy for most of the run,
  // and a row rendered for it would push the transcript up by one and name the implementer
  // twice — once on its own row and once on the status rule beside it. Removing the N=1 guard
  // in `seatRows` passed the entire console suite before this test existed.
  const dir = repo()
  const c = await spawnConsole(dir, t, undefined, true)
  assert.ok(
    await c.until((s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').includes('Did it.'), 40_000),
    'the implementer must have taken a whole turn, so the box was drawn while it was working',
  )
  const regions = [...c.text().matchAll(/\x1b\[1;(\d+)r/g)].map((m) => Number(m[1]))
  assert.ok(regions.length > 0, 'the console must set a scrolling region')
  assert.deepEqual(
    [...new Set(regions)],
    [26],
    'a default console box is four rows from first draw to last: anything else moved the transcript',
  )
  c.proc.kill()
})
