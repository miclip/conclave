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
    /** Wait for a predicate over the accumulated screen bytes. */
    async until(pred: (s: string) => boolean, ms = 20_000): Promise<boolean> {
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
  c.type('@implementer keep the diff small')
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

  // And it still submits as typed.
  c.type('\r')
  assert.ok(
    await c.until((s) => s.includes('queued for implementer at the next exchange')),
    'the redrawn line must still be the line that gets sent',
  )
  c.proc.kill()
})

test('progress is append-only, so nothing is ever stranded or duplicated', async (t) => {
  // An in-place status line and readline both owned the last line of the terminal, and
  // readline redraws on its own schedule. Whichever wrote last won and the loser stayed in
  // the transcript — three rounds of fixes to the erase logic each passed offline and each
  // still duplicated live, because two subsystems cannot both own the cursor.
  //
  // Append-only output cannot strand a line, because it never goes back.
  const dir = repo()
  const c = await spawnConsole(dir, t)
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  assert.ok(await c.until((s) => s.includes('›')))
  assert.ok(await c.until((s) => /⋯/.test(plain(s)), 15_000), 'a progress line should appear')

  // Let several turns run, then assert every progress line is distinct: a duplicate is the
  // exact symptom the in-place version produced.
  await new Promise((r) => setTimeout(r, 4_000))
  const lines = plain(c.text())
    .split('\n')
    .map((l) => l.trim())
    // `includes`, not `startsWith`: readline's prompt shares the line, so a progress line
    // reads as "›   ⋯ implementer 1s · Read".
    .filter((l) => l.includes('⋯'))
    .map((l) => l.slice(l.indexOf('⋯')))
  assert.ok(lines.length > 0)
  assert.equal(new Set(lines).size, lines.length, `duplicate progress lines:\n${lines.join('\n')}`)
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
