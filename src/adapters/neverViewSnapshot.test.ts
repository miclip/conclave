/**
 * A snapshot taken before any transcript read must not read as a verified empty one.
 *
 * Both pty adapters answer `snapshot()` from a synthesized object when `#view` is absent, and it
 * carried `compactionGeneration: 0` with no `containedFallback` -- so the two guards that exist
 * precisely to refuse an unverified generation let it through as though a transcript had been
 * read and found nothing. `rotate.ts` recorded `0` rather than `UNKNOWN_GENERATION`, and
 * `relay.ts` set `unverified = false`.
 *
 * This is the case #156 reports, and the work that introduced `containedFallback` did not cover
 * it: that flag marked a STALE projection -- a read that happened earlier -- while this is a
 * NEVER read, where none ever happened. Both reach the same consumers, so both must be flagged.
 *
 * `containedSnapshot.test.ts` cannot catch it. That file establishes a successful first read
 * before wedging, so a view always exists by the time it asserts.
 *
 * Reachable in production: `#view` is built only `if (this.#transcriptPath)`, and a `SessionStart`
 * can arrive without one -- which is what leaving `ORCH_FAKE_TRANSCRIPT` unset reproduces here,
 * through the same fake CLI the other adapter tests use.
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { AgentSession } from '../contract/session.ts'
import { ClaudePtyHookAdapter } from './claude.ts'
import { CodexPtyHookAdapter } from './codex.ts'
import { installFakeClis } from './fakeCli.ts'
import { containAdapterRunDirs } from '../testkit/tempDir.ts'

/**
 * The run directories the adapters this file boots make for themselves, contained.
 *
 * `Claude.#boot` and `Codex.#boot` each `mkdtemp` a run directory under `os.tmpdir()` and
 * never remove it. That is PRODUCTION behaviour and issue #203's business, not this file's --
 * so rather than change it, the floor it lands on moves: `tmpdir()` re-reads `TMPDIR` on every
 * call, so pointing it at a directory the testkit issued puts every run directory booted here
 * inside something whose lifetime the helper already owns.
 *
 * Per FILE, and that is what makes it safe rather than a shared global: every test file runs
 * in its own process under `node --test`, so this reaches no other suite, and the tests in
 * this one stay isolated from each other exactly as before -- by `tempDir` handing each its
 * own uniquely named child of this root.
 */
const ADAPTER_TMP_ROOT = containAdapterRunDirs()

const { dir: RUN } = installFakeClis()
const IDLE_MS = 120_000
const ABSOLUTE_MS = 300_000

async function withoutTranscript<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env['ORCH_FAKE_TRANSCRIPT']
  delete process.env['ORCH_FAKE_TRANSCRIPT']
  try {
    return await fn()
  } finally {
    if (previous !== undefined) process.env['ORCH_FAKE_TRANSCRIPT'] = previous
  }
}

type Opts = Parameters<typeof ClaudePtyHookAdapter.start>[0]
const ADAPTERS: ReadonlyArray<readonly [string, (o: Opts) => Promise<AgentSession>]> = [
  ['claude', (o) => ClaudePtyHookAdapter.start(o)],
  ['codex', (o) => CodexPtyHookAdapter.start(o)],
]

for (const [name, start] of ADAPTERS) {
  test(`${name}: a snapshot taken before any read is flagged unverified, not reported as empty`, async () => {
    const session: AgentSession = await withoutTranscript(() =>
      start({
        cwd: RUN,
        role: 'implementer',
        inputOwnership: 'mediated',
        watchdogMs: ABSOLUTE_MS,
        idleMs: IDLE_MS,
        readyTimeoutMs: 20_000,
      }),
    )
    try {
      const snap = await session.snapshot()
      assert.equal(snap.turns.length, 0, 'no view means no turns to report')
      assert.equal(snap.compactionGeneration, 0, 'the synthesized number itself is unchanged')
      assert.equal(
        snap.containedFallback,
        true,
        'synthesized, not read: a consumer must be able to tell this from a verified zero',
      )
    } finally {
      await session.close('graceful').catch(() => {})
    }
  })
}
