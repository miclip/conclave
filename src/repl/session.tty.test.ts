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
function driver(dir: string): string {
  const path = join(dir, 'driver.mjs')
  writeFileSync(
    path,
    `
import { runSession } from ${JSON.stringify(join(REPO, 'src/repl/session.ts'))}
import { AgentRegistry } from ${JSON.stringify(join(REPO, 'src/registry/registry.ts'))}
import { FakeRotationSession } from ${JSON.stringify(join(REPO, 'src/rotation/fakeSession.ts'))}

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
    launch: { command: agent, baseArgs: [] }, async create() { return session },
  })
}
// Emit activity on a timer, so something lands while a line is half-typed.
setInterval(() => impl.emit({ type: 'tool_use', tool: 'Read', input: {}, seq: 99, at: Date.now(), provisional: true }), 700).unref()

const code = await runSession({
  cwd: ${JSON.stringify(dir)}, goal: 'Keep the work moving.',
  lead: 'codex', implementer: 'claude', rounds: 6, checks: [], registry,
})
process.exit(code)
`,
  )
  return path
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-tty-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
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
async function spawnConsole(dir: string, t?: { after: (fn: () => void) => void }) {
  const { default: pty } = await import('node-pty')
  const p = pty.spawn(process.execPath, [driver(dir)], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: dir,
    env: { ...process.env } as Record<string, string>,
  })
  let buf = ''
  p.onData((d: string) => (buf += d))
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
     * The budget is generous on purpose. These spawn a real console in a real pty, and under
     * a full `npm test` the machine is running every other suite at the same time -- this
     * test timed out at 20s twice while passing in 3s on its own. A wait that returns the
     * instant its predicate holds costs nothing when the suite is healthy, and a budget tight
     * enough to flake turns a green suite into a coin toss.
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
  const c = await spawnConsole(dir, t)
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
    } else for (const ch of tok) if (col < cols) grid[r]![col++] = ch
  }
  const line = (n: number) => grid[n - 1]!.join('').replace(/\s+$/, '')

  // The status is inlaid into the top rule rather than given a row of its own: a permanent
  // row for one short phrase is a row spent on nothing.
  assert.match(line(rows - 3), /─{10,}/, 'rule above the input')
  assert.match(line(rows - 2), /›\s*typing here/, 'the input row holds what was typed')
  assert.match(line(rows - 1), /─{20,}/, 'rule below the input')
  // The row below answers what is being typed. With an ordinary line typed and no
  // completion pending it is empty, which is the point — it is not a status line.
  assert.ok(!/⋯/.test(line(rows)), 'the row below is not a second status line')

  // Wherever the status appears, it is on the top rule and nowhere else. Asserting that it
  // IS present would be timing-dependent — it exists only while a turn runs — but asserting
  // where it may appear holds whether or not one is running.
  const statusRows = Array.from({ length: rows }, (_, i) => i + 1).filter((n) => /⋯/.test(line(n)))
  assert.deepEqual(
    statusRows.filter((n) => n !== rows - 3),
    [],
    `the status appeared off the top rule — in the transcript it reads as duplicates:\n${statusRows
      .map((n) => `${n}| ${line(n)}`)
      .join('\n')}`,
  )
})
