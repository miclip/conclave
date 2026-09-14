/**
 * A boot that fails leaves nothing behind (#303).
 *
 *   node --test src/adapters/bootCleanup.test.ts
 *
 * `start()` was `new` + `await #boot()`. When `#boot` threw after the readiness window, the pty
 * child it had spawned and the `HookReceiver` it had started were still there, and the caller
 * got an error with no handle to close either. Measured while mutation-testing #302: with the
 * seat's registration removed, `start()` threw at 60s as designed -- and the `node --test`
 * process then sat for 466s with `claude --model haiku` alive under it and the receiver's TCP
 * server open, until killed by hand. In a session that is a stray child until the run ends;
 * under a test runner or any long-lived host it is a hang, and a boot that fails transiently
 * and is retried stacks children.
 *
 * The stand-in here never becomes ready: it posts no `SessionStart` (Claude's readiness) and
 * writes no raw-mode marker (Codex's), so each adapter's own readiness window is what fails
 * the boot. What the stand-in does do is write its pid and `ORCH_HOOK_URL` to a file, which is
 * how the test can ask, after `start()` has rejected, whether the child and the receiver are
 * gone -- neither can be asked through the adapter, because the caller never gets one.
 *
 * BOUNDED, and the bound is the whole point: the defect this covers is a hang, so the test that
 * covers it must not become one. Each test has a timeout, and beneath that a tripwire that
 * fires only if the file's own end-of-run never arrives -- it kills the stand-in, names the
 * handles still open, and exits, so a broken cleanup path reads as a failure with a diagnosis
 * rather than a runner that never returns.
 */

import { strict as assert } from 'node:assert'
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'

import { ClaudePtyHookAdapter } from './claude.ts'
import { HookReceiver } from '../hooks/receiver.ts'
import { CodexPtyHookAdapter } from './codex.ts'
import { containAdapterRunDirs, suiteTempDir } from '../testkit/tempDir.ts'
import { waitFor } from '../testkit/waitFor.ts'

const RUN_ROOT = containAdapterRunDirs()
const DIR = suiteTempDir('orch-boot-cleanup')

/** Readiness window handed to each adapter. Short: the boot is meant to fail. */
const READY_MS = 1_500
/** Per-test bound, past which cleanup has become the hang it exists to prevent. */
const TEST_MS = 30_000
/**
 * The file's own bound. `close('abandoned')` is itself bounded -- `terminate()` escalates to
 * SIGKILL inside 10s -- so a run that is still going this long after the tests should have
 * ended has a cleanup that never returned, and the runner would sit exactly as #303 did.
 */
const TRIPWIRE_MS = 90_000

/**
 * A child that starts, reports where it is, and never becomes ready.
 *
 * Not the shared stand-in in `fakeCli.ts`: that one posts `SessionStart` unconditionally and
 * advertises bracketed paste, which is to say it becomes ready by construction -- the thing
 * this file needs it not to do. `ORCH_FAKE_REPORT` is the only knob: pid and hook URL, written
 * before the wait so the test can find them however the boot ends.
 */
const NEVER_READY = `#!/usr/bin/env node
require('node:fs').writeFileSync(
  process.env.ORCH_FAKE_REPORT,
  JSON.stringify({ pid: process.pid, url: process.env.ORCH_HOOK_URL }),
)
setInterval(function () {}, 1 << 30)
`

const COMMAND = join(DIR, 'never-ready')
writeFileSync(COMMAND, NEVER_READY)
chmodSync(COMMAND, 0o755)

interface Report {
  pid: number
  url: string
}

function readReport(path: string): Report {
  assert.ok(existsSync(path), `the stand-in never wrote ${path}: it did not start at all`)
  return JSON.parse(readFileSync(path, 'utf8')) as Report
}

/** `kill(pid, 0)` asks without sending: ESRCH is the only answer that means "gone". */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** A connect attempt, bounded: refused is the expected answer, and "still listening" the defect. */
function portRefuses(url: string): Promise<'refused' | 'accepted' | 'timeout'> {
  const { hostname, port } = new URL(url)
  return new Promise((resolve) => {
    const sock = connect({ host: hostname, port: Number(port) })
    const done = (r: 'refused' | 'accepted' | 'timeout') => {
      sock.destroy()
      resolve(r)
    }
    sock.once('connect', () => done('accepted'))
    sock.once('error', (e) => done((e as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'refused' : 'accepted'))
    sock.setTimeout(2_000, () => done('timeout'))
  })
}

/**
 * The tripwire. Unref'd, so it holds nothing open and a run whose loop drains never sees it;
 * a run held open by a leaked pty or server does, and gets a diagnosis instead of a wait.
 *
 * `childPids` holds a pid only while the child is last known ALIVE: added when the stand-in
 * reports in, removed the moment the test has confirmed it gone. A pid that was confirmed dead
 * 90 seconds ago is free for the kernel to hand to anything, and a kill sent to it then would
 * reach something this file never started.
 *
 * NOT gated on the suite having ended, and the first version was: node's `after` hooks run
 * once the tests have failed, BEFORE the leaked handles keep the process from exiting, so a
 * gate on them let the tripwire watch the exact hang it exists to catch and stand down. The
 * only condition that matters is being alive this late, and that is the timer firing at all.
 *
 * The pids it kills are the ones the stand-ins reported, so it cannot reach anything this file
 * did not start.
 */
const childPids: number[] = []
setTimeout(() => {
  // In memory rather than re-read from the report files: the suite's own `after` cleanup has
  // removed those by the time this fires.
  for (const pid of childPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  process.stderr.write(
    `#303 tripwire: ${TRIPWIRE_MS}ms passed and the suite has not ended. ` +
      `Handles still open: ${process.getActiveResourcesInfo().join(', ')}. ` +
      `Stand-ins killed: ${childPids.join(', ') || 'none'}. This is the hang the fix exists to prevent.\n`,
  )
  process.exit(1)
}, TRIPWIRE_MS).unref()

const CASES = [
  {
    agent: 'claude',
    start: () =>
      ClaudePtyHookAdapter.start({ cwd: DIR, role: 'implementer', command: COMMAND, readyTimeoutMs: READY_MS }),
    expectedFailure: /never reported SessionStart/,
  },
  {
    agent: 'codex',
    start: () =>
      CodexPtyHookAdapter.start({ cwd: DIR, role: 'implementer', command: COMMAND, readyTimeoutMs: READY_MS }),
    expectedFailure: /did not negotiate an interactive terminal/,
  },
] as const

for (const { agent, start, expectedFailure } of CASES) {
  test(`#303 ${agent}: a boot that fails terminates its child and stops its receiver before rethrowing`, { timeout: TEST_MS }, async () => {
    const report = join(DIR, `${agent}-report.json`)
    process.env['ORCH_FAKE_REPORT'] = report
    const before = readdirSync(RUN_ROOT).filter((n) => n.startsWith('orch-'))

    const failure = await start().then(
      () => undefined,
      (e: unknown) => e,
    )

    // The boot failed for the reason the readiness window gives, and THAT is what the caller
    // sees: cleanup does not get to replace the diagnosis with its own.
    assert.ok(failure instanceof Error, `${agent} start() resolved; the stand-in was never meant to become ready`)
    assert.match(failure.message, expectedFailure)

    const { pid, url } = readReport(report)
    childPids.push(pid)
    assert.ok(url.startsWith('http://'), `stand-in saw ORCH_HOOK_URL=${url}`)

    // The child. `terminate()` returns only once the exit has been observed, so by the time
    // `start()` rejects there is nothing to wait for: it is gone now or the cleanup did not run.
    assert.equal(alive(pid), false, `${agent} child ${pid} is still running after start() rejected`)
    childPids.splice(childPids.indexOf(pid), 1)

    // The receiver. Its server was listening at `url` when the stand-in read it; a rejected
    // start() must have closed it, or the host process can never exit.
    assert.equal(await portRefuses(url), 'refused', `${agent} hook receiver at ${url} is still listening after start() rejected`)

    // And the run directory is given back (#203), the same as any other abandoned close.
    const remaining = readdirSync(RUN_ROOT).filter((n) => n.startsWith('orch-'))
    assert.deepEqual(remaining, before, `${agent} left its run directory behind: ${remaining.join(', ')}`)
  })
}

/** Listening TCP servers in this process: the receiver is the only one these tests start. */
const listeningServers = () => process.getActiveResourcesInfo().filter((r) => r === 'TCPServerWrap').length

for (const [agent, start] of [
  ['claude', (command: string) => ClaudePtyHookAdapter.start({ cwd: DIR, role: 'implementer', command, readyTimeoutMs: READY_MS })],
  ['codex', (command: string) => CodexPtyHookAdapter.start({ cwd: DIR, role: 'implementer', command, readyTimeoutMs: READY_MS })],
] as const) {
  test(`#303 ${agent}: a boot whose child dies at once still stops its receiver`, { timeout: TEST_MS }, async () => {
    // The receiver starts before the child is spawned. A command that does not exist does not
    // make `spawn` throw -- node-pty forks, and the child dies at exec -- so this is a boot
    // whose pty is dead before the readiness window opens, and the shortest failing path
    // there is. It has no stand-in to report a URL, so the receiver is counted as a handle of
    // this process instead: the one listening server these tests start.
    const before = listeningServers()
    const dirsBefore = readdirSync(RUN_ROOT).filter((n) => n.startsWith('orch-'))

    const failure = await start(join(DIR, 'no-such-command')).then(
      () => undefined,
      (e: unknown) => e,
    )

    assert.ok(failure instanceof Error, `${agent} start() resolved with a command that does not exist`)
    assert.doesNotMatch(failure.message, /Cannot read properties of undefined/, 'the spawn failure, not the cleanup\'s own')
    // Waited for rather than read at once: `net.Server` emits `close` on a `nextTick`, one loop
    // iteration before libuv has released the handle, so the count read synchronously after the
    // rejection can still include a server that IS closing. Bounded, and short -- a receiver that
    // is still there after this long was not stopped.
    await waitFor(() => listeningServers() === before, {
      within: 2_000,
      describe: `${agent}'s hook receiver to stop listening after start() rejected`,
    })
    const dirsAfter = readdirSync(RUN_ROOT).filter((n) => n.startsWith('orch-'))
    assert.deepEqual(dirsAfter, dirsBefore, `${agent} left its run directory behind: ${dirsAfter.join(', ')}`)
  })
}

for (const [agent, start] of [
  ['claude', () => ClaudePtyHookAdapter.start({ cwd: DIR, role: 'implementer', command: COMMAND, readyTimeoutMs: READY_MS })],
  ['codex', () => CodexPtyHookAdapter.start({ cwd: DIR, role: 'implementer', command: COMMAND, readyTimeoutMs: READY_MS })],
] as const) {
  test(`#303 ${agent}: a cleanup that itself throws does not replace the boot failure`, { timeout: TEST_MS }, async () => {
    // The receiver's stop does its real work and THEN throws. What the caller must see is the
    // readiness failure -- the diagnosis they can act on -- and not the teardown's own noise;
    // and the teardown must still have happened, or swallowing its error would be hiding a leak.
    //
    // The prototype is patched because nothing else reaches the receiver of a session whose
    // `start()` never returns. This file runs in its own process under `node --test`, and the
    // patch is undone in `finally`, so it cannot outlive the test.
    const report = join(DIR, `${agent}-throwing-report.json`)
    process.env['ORCH_FAKE_REPORT'] = report
    const realStop = HookReceiver.prototype.stop
    let stopped = 0
    HookReceiver.prototype.stop = async function (this: HookReceiver) {
      await realStop.call(this)
      stopped += 1
      throw new Error('receiver stop failed AFTER stopping')
    }
    try {
      const failure = await start().then(
        () => undefined,
        (e: unknown) => e,
      )
      assert.ok(failure instanceof Error, `${agent} start() resolved; the stand-in was never meant to become ready`)
      assert.doesNotMatch(failure.message, /receiver stop failed/, "the cleanup's error must not replace the boot's")
      assert.match(failure.message, agent === 'claude' ? /never reported SessionStart/ : /did not negotiate an interactive terminal/)
      assert.equal(stopped, 1, 'the receiver WAS stopped: swallowing the error is not skipping the work')

      const { pid, url } = readReport(report)
      childPids.push(pid)
      assert.equal(alive(pid), false, `${agent} child ${pid} is still running after start() rejected`)
      childPids.splice(childPids.indexOf(pid), 1)
      assert.equal(await portRefuses(url), 'refused', `${agent} hook receiver at ${url} is still listening`)
    } finally {
      HookReceiver.prototype.stop = realStop
    }
  })
}

for (const [agent, start] of [
  ['claude', () => ClaudePtyHookAdapter.start({ cwd: DIR, role: 'implementer', command: COMMAND, readyTimeoutMs: READY_MS })],
  ['codex', () => CodexPtyHookAdapter.start({ cwd: DIR, role: 'implementer', command: COMMAND, readyTimeoutMs: READY_MS })],
] as const) {
  test(`#303 ${agent}: a boot that fails before the child exists closes what it had opened`, { timeout: TEST_MS }, async () => {
    // `#boot` starts the receiver, then spawns. A throw between the two is a boot with a
    // listening server, a run directory, and NO pty -- the one partial state `close()` does not
    // tolerate, because it reads `this.#pty.alive` unconditionally. Nothing found so far makes
    // `spawn` itself throw (a missing command or cwd forks and dies at exec), so the throw is
    // injected at the receiver: its start does its real work, hands the test the URL, and then
    // fails with a sentinel the test can identify by identity rather than by message.
    const sentinel = new Error('injected: the boot failed after the receiver started')
    const realStart = HookReceiver.prototype.start
    let receiver: HookReceiver | undefined
    let url: string | undefined
    HookReceiver.prototype.start = async function (this: HookReceiver, host?: string) {
      url = await realStart.call(this, host)
      receiver = this
      throw sentinel
    }
    const dirsBefore = readdirSync(RUN_ROOT).filter((n) => n.startsWith('orch-'))
    try {
      const failure = await start().then(
        () => undefined,
        (e: unknown) => e,
      )
      assert.equal(failure, sentinel, `${agent} start() did not rethrow the very error the boot failed with`)
      assert.ok(url, 'the receiver started before the boot failed, or this test injected nothing')
      assert.equal(await portRefuses(url), 'refused', `${agent} hook receiver at ${url} is still listening after start() rejected`)
      const dirsAfter = readdirSync(RUN_ROOT).filter((n) => n.startsWith('orch-'))
      assert.deepEqual(dirsAfter, dirsBefore, `${agent} left its run directory behind: ${dirsAfter.join(', ')}`)
    } finally {
      HookReceiver.prototype.start = realStart
      // A mutant that leaks the receiver fails the assertion above; this is what keeps it from
      // also holding the process open, so the failure is read rather than waited out.
      await receiver?.stop().catch(() => {})
    }
  })
}
