/**
 * A live Claude seat receives each hook event ONCE. #302.
 *
 *   ORCH_LIVE=1 node --test src/adapters/hookRegistration.live.test.ts
 *
 * Both hook registrations conclave makes for a Claude seat fired at once -- the project's
 * `.claude/settings.json`, which `config install` and every session start render, and the
 * `--settings` file the adapter writes per run -- because Claude Code runs the hooks of every
 * settings layer it loads. Every implementer turn on both #300 runs arrived twice. The stand-in
 * CLI cannot see this: it posts to `ORCH_HOOK_URL` directly and reads no settings at all, which
 * is why the duplication was invisible to the suite for as long as it was. So this spawns the
 * real binary, with the real project registration rendered by the real installer, and counts
 * what the receiver delivers.
 *
 * EXACTLY ONCE, per event, and that is the whole test. "At least one" passes with both
 * registrations firing; "at most one" passes with neither. Removing the seat's own
 * registration must fail here for zero events; letting the project's post again must fail for
 * two. The events counted span both registrations (`UserPromptSubmit`, `Stop`) and the seat's
 * alone (`PreModelSwitch`, #202), so a fix that kept the wrong one -- the project's registers
 * six events, the seat's thirteen -- fails on the third. `PostModelSwitch` is not counted:
 * typed into the interactive composer, `/model <name>` fired Pre and no Post within 20s on
 * 2.1.270, where `claude -p "/model sonnet"` fires both; the composer's switch evidently does
 * not complete the way the non-interactive one does, and that is the CLI's business.
 *
 * `conclave` on PATH is a shim to THIS checkout's `bin/conclave.ts` for the child, because the
 * project registration resolves `conclave hook claude` through PATH at every firing (#258) and a
 * release installed there predates the fix.
 */

import { strict as assert } from 'node:assert'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import test from 'node:test'

import { installConfig } from '../config/install.ts'
import type { AgentEvent } from '../contract/session.ts'
import { ClaudePtyHookAdapter } from './claude.ts'
import { containAdapterRunDirs, tempDir } from '../testkit/tempDir.ts'

containAdapterRunDirs()

const LIVE = process.env.ORCH_LIVE === '1'
const skip = LIVE ? false : 'set ORCH_LIVE=1 to run (spawns a real Claude session, uses quota)'
const REPO = resolve(import.meta.dirname, '..', '..')

/** The hook events the seat depends on that this test can provoke without a tool permission. */
const COUNTED = ['UserPromptSubmit', 'Stop', 'PreModelSwitch'] as const

test('#302 a live seat delivers each hook event exactly once, from its own registration', { skip }, async (t) => {
  // A project of its own, registered the way a session registers one, so the project layer
  // Claude Code loads is the real rendered file and not this repository's.
  const project = tempDir(t, 'hook-registration')
  const installed = await installConfig({ projectRoot: project, agents: ['claude'], diagnose: false })
  assert.ok(existsSync(join(project, '.claude', 'settings.json')), `the project registration must exist: ${JSON.stringify(installed.written)}`)

  // `conclave` for the child is this checkout, not whatever release is installed.
  const shim = join(project, 'shim')
  mkdirSync(shim)
  writeFileSync(join(shim, 'conclave'), `#!/bin/sh\nexec node "${join(REPO, 'bin', 'conclave.ts')}" "$@"\n`)
  chmodSync(join(shim, 'conclave'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${shim}${delimiter}${path ?? ''}`
  t.after(() => {
    process.env.PATH = path
  })

  // With the seat's registration removed this throws at the readiness window, which is the
  // "no events arrive" failure -- and the runner then hangs on the child a failed boot leaves
  // behind (#303). The failure is reported first; the hang is that issue's, not this test's.
  const session = await ClaudePtyHookAdapter.start({
    cwd: project,
    role: 'implementer',
    watchdogMs: 120_000,
    readyTimeoutMs: 60_000,
    args: ['--model', 'haiku'],
  })
  t.after(() => session.close('graceful'))

  // Counted at the receiver: one `delivery` per hook invocation that posted. Two registrations
  // are two hook processes, two delivery ids, two deliveries -- the receiver's own replay
  // dedup does not fold them, and must not, since a replay and a second registration are not
  // the same thing.
  const counts = new Map<string, number>()
  session.receiver.on('delivery', (d) => counts.set(d.event, (counts.get(d.event) ?? 0) + 1))
  const seen: AgentEvent[] = []
  const reading = (async () => {
    for await (const e of session.events()) seen.push(e)
  })()
  const until = async (done: () => boolean, ms: number) => {
    const by = Date.now() + ms
    while (!done() && Date.now() < by) await new Promise((r) => setTimeout(r, 100))
  }

  try {
    await session.send('Reply with exactly the word ONCE and nothing else.', { kind: 'peer_relay' })
    await until(() => seen.some((e) => e.type === 'turn_end'), 90_000)
    // A model switch from the seat's own pane (#202): an event only the seat's registration
    // carries. Typed rather than sent, because it is a command and opens no turn.
    await session.submitRaw('/model sonnet', 'live registration probe')
    await until(() => (counts.get('PreModelSwitch') ?? 0) > 0, 20_000)
    // Then a quiet moment, so a second delivery that was merely slower still lands in time to
    // be counted. The doubles measured on #300 were 65-94ms apart; this is generous.
    await new Promise((r) => setTimeout(r, 2_000))

    assert.deepEqual(
      Object.fromEntries(COUNTED.map((e) => [e, counts.get(e) ?? 0])),
      Object.fromEntries(COUNTED.map((e) => [e, 1])),
      `each event exactly once; all deliveries: ${JSON.stringify(Object.fromEntries(counts))}`,
    )
  } finally {
    await session.close('graceful')
    await reading
  }
})
