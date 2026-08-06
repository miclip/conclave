/**
 * The REPL, driven by a scripted stdin.
 *
 * It is the user-facing surface, so it is the surface most likely to rot unnoticed: every
 * live run so far has gone through the library, not through this. The point of these tests
 * is not the rendering — it is that the console remains a CLIENT of `RunHandle` and holds
 * no lifecycle state of its own.
 *
 *   node --test src/repl/session.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import type { AgentSession } from '../contract/session.ts'
import { AgentRegistry } from '../registry/registry.ts'
import { FakeRotationSession } from '../rotation/fakeSession.ts'
import { runSession } from './session.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-repl-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.conclave/\n')
  writeFileSync(join(dir, 'work.ts'), 'export const a = 1\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

function registryOf(sessions: Record<string, AgentSession[]>): AgentRegistry {
  const r = new AgentRegistry()
  for (const [agent, queue] of Object.entries(sessions)) {
    const remaining = [...queue]
    r.register({
      id: agent,
      displayName: agent,
      capabilities: {
        agent,
        readinessSignal: 'unknown',
        turnKeySource: 'prompt_id',
        outcomes: {
          completed: 'observed',
          cancelled: 'reasoned_but_unverified',
          permission_refused: 'reasoned_but_unverified',
          process_exited: 'reasoned_but_unverified',
          timed_out: 'reasoned_but_unverified',
          transport_lost: 'reasoned_but_unverified',
          unknown_abnormal_end: 'reasoned_but_unverified',
        },
      },
      launch: { command: agent, baseArgs: [] },
      async create() {
        const next = remaining.shift()
        if (!next) throw new Error(`no session left for ${agent}`)
        return next
      },
    })
  }
  return r
}

/** Feed lines with a small delay, so the run reaches a pause before the next command. */
function script(lines: string[], gapMs = 350): PassThrough {
  const s = new PassThrough()
  void (async () => {
    for (const l of lines) {
      await new Promise((r) => setTimeout(r, gapMs))
      s.write(`${l}\n`)
    }
  })()
  return s
}

/** A participant whose turns take long enough for a console to be typed at. */
function slow(id: string, agent: string, replies: string[], ms = 250): FakeRotationSession {
  const s = new FakeRotationSession(id, agent, replies)
  s.delayMs = ms
  return s
}

function collect(): { stream: Writable; text: () => string } {
  const chunks: string[] = []
  return {
    stream: new Writable({
      write(c, _e, cb) {
        chunks.push(String(c))
        cb()
      },
    }),
    text: () => chunks.join(''),
  }
}

test('a session runs to completion and reports the outcome', async () => {
  const dir = repo()
  const out = collect()
  const code = await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    registry: registryOf({
      codex: [new FakeRotationSession('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [new FakeRotationSession('impl', 'claude', ['ack', 'Did it.'])],
    }),
    input: script([]),
    output: out.stream,
  })
  assert.equal(code, 0)
  assert.match(out.text(), /run ended: done/)
  // Without checks, rotation is refused rather than done unverified — and it says so.
  assert.match(out.text(), /no rotation checks configured/)
})

test('a pause is rendered with its evidence and the operator resumes it', async () => {
  const dir = repo()
  // Compacts deterministically on its second turn rather than on a timer.
  const impl = slow('impl', 'claude', ['ack', 'Did it.', 'And again.'])
  impl.compactOnTurn = 1
  const out = collect()
  const running = runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 4,
    checks: ['true'],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'])],
      claude: [impl, slow('fresh', 'claude', [])],
    }),
    input: script(['/state', '/continue'], 900),
    output: out.stream,
  })
  assert.equal(await running, 0)

  const text = out.text()
  assert.match(text, /paused/)
  assert.match(text, /rotation_candidate/)
  assert.match(text, /compaction generation rose 0 → 1/)
  assert.match(text, /\/continue/, 'the options are offered')
  assert.match(text, /run: paused \(rotation_candidate\)/, '/state reports the handle, not a local copy')
  assert.match(text, /run ended: done/)
})

test('an addressed line is queued, restricted, and reported as such', async () => {
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'Did it.', 'And again.'])
  const out = collect()
  const code = await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 4,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'More.', 'DONE'])],
      claude: [impl],
    }),
    input: script(['@implementer touch nothing under src/adapters', '/audit'], 300),
    output: out.stream,
  })
  assert.equal(code, 0)
  const text = out.text()
  // Queued, not delivered mid-turn — the console says which, rather than implying the
  // participant is reading over the operator's shoulder.
  assert.match(text, /queued for implementer at the next exchange/)
  assert.match(text, /withheld from advisor/)
  assert.match(text, /excluded advisor/, '/audit shows the asymmetry')
  assert.ok(impl.received.some((m) => m.includes('src/adapters')), 'and it reaches the participant')
})

test('narration streams to the human, and only the report is shown going to the advisor', async () => {
  // The routing has to be legible: what was written for you, and what the other
  // participant actually received. The closing message is held back rather than streamed,
  // because the routed copy prints it a moment later and twice is harder to read.
  const dir = repo()
  const impl = slow('impl', 'claude', ['ack', 'IGNORED'])
  impl.narrate(["I'll start by finding the relevant code.", 'Now the guard report shape.'], 'Done. guard --json is in.')
  const out = collect()

  const code = await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 3,
    checks: [],
    registry: registryOf({
      codex: [slow('advisor', 'codex', ['Do it.', 'DONE'])],
      claude: [impl],
    }),
    input: script([]),
    output: out.stream,
  })
  assert.equal(code, 0)
  const text = out.text()

  assert.match(text, /implementer → you/, 'narration is addressed to the human')
  assert.match(text, /finding the relevant code/)
  assert.match(text, /Now the guard report shape/)
  assert.match(text, /implementer → advisor/, 'and the report is shown going to the advisor')
  assert.match(text, /Done\. guard --json is in\./)
  assert.equal(
    text.split('Done. guard --json is in.').length - 1,
    1,
    'the closing message is shown once, as the routed report — not streamed and repeated',
  )
})

test('the console refuses to start while another session holds the lock', async () => {
  const dir = repo()
  const { acquire } = await import('../workspace/sessionLock.ts')
  acquire(dir, [{ id: 'implementer', agent: 'claude' }])
  const out = collect()
  const code = await runSession({
    cwd: dir,
    goal: 'Keep the work moving.',
    lead: 'codex',
    implementer: 'claude',
    rounds: 2,
    checks: [],
    registry: registryOf({ codex: [], claude: [] }),
    input: script([]),
    output: out.stream,
  })
  // Overwriting the lock would destroy the other run's record of what was dirty before it
  // began, which is the thing that lets `conclave guard` tell their work from the operator's.
  assert.equal(code, 1)
  assert.match(out.text(), /refusing to start/)
})
