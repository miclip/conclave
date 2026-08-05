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
 *
 * That last point is the one spike 2 paid for. Exiting 0 on failure makes the loss
 * invisible: the UI shows only "(running stop hooks... 1/2)" and the turn completes
 * normally. Exiting non-zero surfaces "Stop hook error: Failed with non-blocking status
 * code" plus a persistent indicator, and does not block the turn.
 *
 * stdout stays empty. Both CLIs treat SessionStart stdout as context to inject.
 */

import { readFileSync } from 'node:fs'
import { HookJournal, mintDeliveryId } from './journal.ts'

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
    })
  }

  if (!url) {
    process.stderr.write('[orch-hook] ORCH_HOOK_URL unset\n')
    return 1
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
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[orch-hook] fatal: ${String(err)}\n`)
    process.exit(1)
  },
)
