#!/usr/bin/env node
/**
 * The hook command the child CLI executes. Registered in the project-local settings the
 * adapter writes.
 *
 * Contract:
 *   - the POST body is stdin byte-for-byte; envelope metadata rides in X-Orch-* headers
 *   - a delivery identity is minted here, at fire time, and reused on any replay
 *   - the attempt is journalled locally BEFORE the POST, so a receiver outage still
 *     leaves evidence that the CLI fired
 *   - a failed delivery exits NON-ZERO
 *   - having no receiver at all exits ZERO, because nothing was lost -- see NO RECEIVER
 *
 * The non-zero rule is the one spike 2 paid for. Exiting 0 on failure makes the loss
 * invisible: the UI shows only "(running stop hooks... 1/2)" and the turn completes
 * normally. Exiting non-zero surfaces "Stop hook error: Failed with non-blocking status
 * code" plus a persistent indicator, and does not block the turn.
 *
 * stdout stays empty. Both CLIs treat SessionStart stdout as context to inject.
 */

import { readFileSync } from 'node:fs'
import { exitAfterFlush } from '../process/exit.ts'
import { HookJournal, mintDeliveryId } from './journal.ts'

/**
 * The variables conclave sets on every child it spawns, alongside ORCH_HOOK_URL -- see
 * `#boot` in `src/adapters/codex.ts` and `src/adapters/claude.ts`, and `#runTurn` in
 * `src/adapters/kimi.ts`. Nothing else writes them, so they are the evidence that tells
 * the two ways the URL can be missing apart.
 */
const RUN_MARKERS = ['ORCH_HOOK_ATTEMPT_JOURNAL', 'ORCH_HOOK_TIMEOUT_MS'] as const

async function main(): Promise<number> {
  const agent = process.argv[2] ?? 'unknown'
  const firedAt = Date.now() / 1000

  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    /* no stdin */
  }

  let payload: Record<string, any> = {}
  try {
    payload = JSON.parse(raw || '{}')
  } catch {
    /* keep raw; a malformed payload is still evidence a hook fired */
  }

  const url = process.env.ORCH_HOOK_URL
  const attemptJournal = process.env.ORCH_HOOK_ATTEMPT_JOURNAL
  const timeoutMs = Number(process.env.ORCH_HOOK_TIMEOUT_MS ?? 5000)
  const deliveryId = mintDeliveryId(raw, process.pid, firedAt)

  if (attemptJournal) {
    HookJournal.appendAttempt(attemptJournal, {
      phase: 'fired',
      deliveryId,
      agent,
      event: payload.hook_event_name ?? 'unknown',
      sessionId: payload.session_id,
      turnKey: payload.prompt_id ?? payload.turn_id,
      firedAt,
      hookPid: process.pid,
      bytes: raw.length,
      // The payload itself, so the local journal is sufficient for replay and for
      // fixture collection without a receiver running.
      body: raw,
    })
  }

  if (!url) {
    /**
     * NO RECEIVER (#137).
     *
     * `conclave config install` registers this client in the PROJECT's hook settings, so
     * it also runs on every ordinary `codex` or `claude` invocation by someone who never
     * started a conclave run. No receiver is expected there and no delivery was owed, so
     * nothing was lost.
     *
     * Non-zero is reserved for a delivery that was expected and lost. Spending it here
     * made the two indistinguishable -- and a hook that reports failure on every
     * invocation teaches a reader to discount the report when it is finally true.
     *
     * The stderr line stays, because a hook silently doing nothing is its own puzzle. It
     * says why, so seeing it once is enough.
     */
    if (RUN_MARKERS.some((name) => process.env[name])) {
      // The other way the URL can be missing: conclave spawned this child -- its markers
      // are in the environment -- but the URL did not survive. A delivery IS being lost.
      process.stderr.write(
        `[orch-hook] ${agent}/${payload.hook_event_name}: ORCH_HOOK_URL unset inside a conclave run; delivery lost\n`,
      )
      return 1
    }
    process.stderr.write('[orch-hook] no ORCH_HOOK_URL -- not inside a conclave run, nothing to report\n')
    return 0
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      body: raw,
      headers: {
        'content-type': 'application/json',
        'x-orch-agent': agent,
        'x-orch-event': String(payload.hook_event_name ?? 'unknown'),
        'x-orch-delivery-id': deliveryId,
        'x-orch-hook-pid': String(process.pid),
        'x-orch-fired-at': firedAt.toFixed(6),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      process.stderr.write(`[orch-hook] ${agent}/${payload.hook_event_name}: HTTP ${res.status}\n`)
      return 1
    }
    await res.arrayBuffer()
    return 0
  } catch (err) {
    process.stderr.write(`[orch-hook] ${agent}/${payload.hook_event_name}: ${String(err)}\n`)
    return 1
  }
}

main().then(
  (code) => exitAfterFlush(code),
  (err) => {
    process.stderr.write(`[orch-hook] fatal: ${String(err)}\n`)
    return exitAfterFlush(1)
  },
)
