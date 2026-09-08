/**
 * What the hook client REPORTS, proven by running it (#137).
 *
 *   node --test src/hooks/client.test.ts
 *
 * Every test here spawns `node src/hooks/client.ts <agent>` as a real child with a real
 * stdin and reads its real exit code, because the exit code is the entire interface
 * between this file and the CLI that runs it. A test that imported `main()` would prove
 * something about a function; what Codex renders as `hook: SessionStart Failed` is the
 * process's status, and nothing short of a process produces one.
 *
 * The distinction being pinned is three-way, and the middle case is the one #137 is about:
 *
 *   no receiver, no run    -> exit 0   nothing to deliver, so nothing failed
 *   no receiver, in a run  -> exit 1   a delivery IS being lost
 *   receiver refuses/dead  -> exit 1   a delivery WAS lost
 *
 * The child's environment is built from scratch rather than spread from `process.env`,
 * and that is load-bearing rather than tidy: this suite is routinely run BY an agent
 * inside a conclave run, whose own ORCH_HOOK_URL is in the environment. Inheriting it
 * would point the "no receiver" tests at a live receiver and post junk into a real
 * session's evidence.
 */

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { suiteTempDir } from '../testkit/tempDir.ts'
import type { HookDelivery } from './journal.ts'
import { HookReceiver } from './receiver.ts'

const CLIENT = join(import.meta.dirname, 'client.ts')
const CLI = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')
const SCRATCH = suiteTempDir('orch-hook-client')

interface Run {
  code: number
  stdout: string
  stderr: string
}

/**
 * Run the client exactly as a hook registration does: `node client.ts <agent>`, payload
 * on stdin, nothing else. `env` is the WHOLE environment the child gets, minus what Node
 * itself needs to start.
 */
function runClient(agent: string, payload: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLIENT, agent], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.end(payload)
  })
}

/**
 * The same client through the CLI: `conclave hook <agent>`, which is what a PROJECT's
 * registration invokes since #258. Spawned rather than imported for the reason at the top
 * of this file -- the exit code is the interface, and only a process has one.
 */
function runCli(args: string[], payload: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.end(payload)
  })
}

const SESSION_START = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's-137' })
const STOP = JSON.stringify({ hook_event_name: 'Stop', session_id: 's-137', turn_id: 't1' })

test('a hook with no receiver and no run succeeds, because it had nothing to deliver', async () => {
  // The reproduction from #137, verbatim: plain `codex` in a project where `conclave
  // config install` registered the sidecar. Before the fix this exited 1 and Codex
  // printed `hook: SessionStart Failed` on every ordinary invocation.
  const run = await runClient('codex', SESSION_START)

  assert.equal(run.code, 0, `no receiver must not be a failure; stderr was: ${run.stderr}`)
  assert.equal(run.stdout, '', 'stdout is context injection for SessionStart and must stay empty')
})

test('the no-receiver diagnostic says why nothing happened, not that something broke', async () => {
  const run = await runClient('codex', SESSION_START)

  // A reader who went looking for a delivery has to be able to stop looking. The words
  // that carry that are the reason, not the condition -- "ORCH_HOOK_URL unset" was
  // already precise and still taught nobody anything.
  assert.match(run.stderr, /not inside a conclave run/)
  assert.match(run.stderr, /nothing to report/)
  assert.doesNotMatch(run.stderr, /fail|error/i)
})

test('a missing URL INSIDE a conclave run is still a failure, and says so differently', async () => {
  // The environment conclave gives its children, with the URL removed: the adapter
  // spawned this child, so a delivery is expected and is being lost.
  const journal = join(SCRATCH, 'in-run', 'attempts.ndjson')
  const run = await runClient('codex', STOP, {
    ORCH_HOOK_ATTEMPT_JOURNAL: journal,
    ORCH_HOOK_TIMEOUT_MS: '5000',
  })

  assert.equal(run.code, 1, 'a lost delivery must stay non-zero')
  assert.match(run.stderr, /inside a conclave run/)
  assert.match(run.stderr, /delivery lost/)
  assert.doesNotMatch(run.stderr, /nothing to report/, 'must not read as the benign case')

  // And the attempt is on disk regardless, which is what makes the loss recoverable.
  const attempt = JSON.parse(readFileSync(journal, 'utf8').trim())
  assert.equal(attempt.event, 'Stop')
  assert.equal(attempt.agent, 'codex')
})

test('either marker alone is enough to know a run is underway', async () => {
  // Whichever variable survives, the child was conclave's. Requiring both would make the
  // benign case swallow a partially-stripped environment, which is the failure this
  // whole distinction exists to keep visible.
  for (const marker of ['ORCH_HOOK_ATTEMPT_JOURNAL', 'ORCH_HOOK_TIMEOUT_MS']) {
    const value = marker === 'ORCH_HOOK_ATTEMPT_JOURNAL' ? join(SCRATCH, `${marker}.ndjson`) : '5000'
    const run = await runClient('claude', STOP, { [marker]: value })
    assert.equal(run.code, 1, `${marker} alone must still read as "in a run"`)
  }
})

test('a delivered hook exits zero and the receiver holds the delivery', async (t) => {
  // The control case. Without it, "exit 0" proves nothing -- a client that always exited
  // 0 would pass every test above.
  const receiver = new HookReceiver(join(SCRATCH, 'live', 'hooks.ndjson'))
  const url = await receiver.start()
  t.after(() => receiver.stop())

  const delivered: string[] = []
  receiver.on('delivery', (d) => delivered.push(d.event))

  const run = await runClient('codex', STOP, { ORCH_HOOK_URL: url, ORCH_HOOK_TIMEOUT_MS: '5000' })

  assert.equal(run.code, 0, `delivery failed: ${run.stderr}`)
  assert.equal(run.stdout, '')
  assert.deepEqual(delivered, ['Stop'])
})

test('a receiver that refuses the delivery is a failure, and is not confusable with the no-op', async (t) => {
  const receiver = new HookReceiver(join(SCRATCH, 'refused', 'hooks.ndjson'))
  const url = await receiver.start()
  t.after(() => receiver.stop())

  // The token is the credential; a URL without it is what a port scanner can build, and
  // the receiver answers it with a non-2xx rather than journalling anything.
  const unauthed = new URL(url)
  unauthed.pathname = '/hook'

  const run = await runClient('codex', STOP, { ORCH_HOOK_URL: unauthed.href })

  assert.equal(run.code, 1)
  assert.match(run.stderr, /HTTP \d{3}/)
  assert.equal(receiver.journal.size, 0, 'nothing was accepted')
})

test('an unreachable receiver is a failure', async () => {
  // Started and stopped, so the port is one that was genuinely conclave's and is now
  // dead -- the shape of a receiver outage rather than an invented address.
  const receiver = new HookReceiver(join(SCRATCH, 'dead', 'hooks.ndjson'))
  const url = await receiver.start()
  await receiver.stop()

  const run = await runClient('codex', STOP, { ORCH_HOOK_URL: url, ORCH_HOOK_TIMEOUT_MS: '2000' })

  assert.equal(run.code, 1)
  assert.match(run.stderr, /codex\/Stop/)
  assert.doesNotMatch(run.stderr, /nothing to report/)
})


/**
 * `conclave hook <agent>` — the entry a PROJECT's registration invokes (#258).
 *
 * These do not re-prove the client's logic; they prove the CLI reaches it. The failure
 * they exist to catch is the one #258 found: `config install` had registered a SECOND
 * implementation, in `spikes/hooks/hook_post.py`, which read an environment variable
 * conclave never set and sent X-Spike-* headers at a receiver that reads only X-Orch-*.
 * Nothing tested that the registered command and the running client agreed, so they did
 * not, for as long as it took someone to read both files.
 *
 * So each of the three exit states is exercised through the CLI, plus the two things a
 * wrapper can break that a direct spawn cannot: stdin arriving intact, and stdout staying
 * empty when a command that normally prints is in the call path.
 */
test('#258 a hook fired through the CLI delivers the same bytes to the same receiver', async (t) => {
  const receiver = new HookReceiver(join(SCRATCH, 'cli-live', 'hooks.ndjson'))
  const url = await receiver.start()
  t.after(() => receiver.stop())

  const held: HookDelivery[] = []
  receiver.on('delivery', (d) => held.push(d))

  const run = await runCli(['hook', 'claude'], STOP, { ORCH_HOOK_URL: url, ORCH_HOOK_TIMEOUT_MS: '5000' })

  assert.equal(run.code, 0, `delivery failed: ${run.stderr}`)
  // Both CLIs inject a SessionStart hook's stdout into the child as context, so anything
  // the CLI prints on this path is text the agent reads as if a human had typed it.
  assert.equal(run.stdout, '', 'the CLI must print nothing on the hook path')

  assert.equal(held.length, 1)
  // The agent comes from argv, and the payload from stdin. Both are what a wrapper is
  // capable of dropping: `conclave hook claude` puts the agent one index further along
  // than `node client.ts claude` does, and a client reading a fixed index would have
  // reported `unknown` here while still exiting zero.
  assert.equal(held[0]!.agent, 'claude')
  assert.equal(held[0]!.event, 'Stop')
  assert.deepEqual(held[0]!.payload, JSON.parse(STOP), 'the payload is stdin, unaltered')
})

test('#258 a lost delivery through the CLI is still non-zero', async (t) => {
  // The rule spike 2 paid for, carried through the wrapper: exiting 0 on failure makes the
  // loss invisible, because the CLI shows only "(running stop hooks... 1/2)" and completes
  // the turn. A wrapper that returned its own status would silently undo that.
  const receiver = new HookReceiver(join(SCRATCH, 'cli-dead', 'hooks.ndjson'))
  const url = await receiver.start()
  await receiver.stop()

  const run = await runCli(['hook', 'codex'], STOP, { ORCH_HOOK_URL: url, ORCH_HOOK_TIMEOUT_MS: '2000' })

  assert.equal(run.code, 1)
  assert.match(run.stderr, /codex\/Stop/)
})

test('#258 a hook fired through the CLI outside a run is not a failure', async () => {
  // The registration this writes runs on every ordinary `claude` invocation by someone who
  // never started a conclave run. Non-zero there would print a hook failure on every one of
  // them -- #137, reproduced through the new entry point.
  const run = await runCli(['hook', 'claude'], SESSION_START)

  assert.equal(run.code, 0, `stderr was: ${run.stderr}`)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /not inside a conclave run/)
})

test('#258 the CLI refuses a hook with no agent, and says so on stderr', async () => {
  const run = await runCli(['hook'], SESSION_START)

  assert.equal(run.code, 1)
  assert.match(run.stderr, /needs the agent/)
  // Not stdout, even though every other command here prints there: a usage line on the
  // hook path is text a SessionStart injects into the child.
  assert.equal(run.stdout, '')
})

test('#258 an ordinary CLI command fires no hook, though it now imports the client', async (t) => {
  // The cost of putting the client behind the CLI: `bin/conclave.ts` imports it, and the
  // client used to POST at module load. Without the direct-invocation guard, every
  // `conclave` command -- and every test file that reached the module -- would post a
  // delivery into whatever receiver was listening.
  const receiver = new HookReceiver(join(SCRATCH, 'cli-quiet', 'hooks.ndjson'))
  const url = await receiver.start()
  t.after(() => receiver.stop())

  const run = await runCli(['--version'], STOP, { ORCH_HOOK_URL: url, ORCH_HOOK_TIMEOUT_MS: '5000' })

  assert.equal(run.code, 0)
  assert.equal(receiver.journal.size, 0, 'no command but `hook` may deliver anything')
})
