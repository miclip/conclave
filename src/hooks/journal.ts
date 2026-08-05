/**
 * Durable hook journal with stable delivery identities.
 *
 * Spike 2 established that hook delivery is at-most-once and never retried upstream: a
 * receiver outage loses the delivery permanently, and the CLI does not notice unless the
 * hook exits non-zero. Recovery is therefore replay from a local journal, which makes
 * duplicates a matter of time rather than a hypothetical -- so the receiver deduplicates
 * even though no duplicate has ever been observed.
 *
 * The identity is minted by the hook client at fire time and replayed verbatim, so a
 * redelivery carries the identity of the original attempt. Deriving it from payload
 * alone would be wrong: two genuinely distinct Stop deliveries in one session can carry
 * byte-identical payloads. Local receipt metadata -- the hook's pid and its fire
 * timestamp -- is what separates them.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

export interface HookDelivery {
  deliveryId: string
  agent: string
  event: string
  sessionId?: string
  /** prompt_id (claude) / turn_id (codex), when the payload carries one. */
  turnKey?: string
  /** The payload exactly as the CLI produced it. Never normalised here. */
  payload: Record<string, any>
  firedAt: number
  hookPid: number
  receivedAt?: number
  /** True when this arrived again after already being journalled. */
  replay?: boolean
}

/**
 * Stable across replays because every input is captured at fire time.
 * payload digest -> what happened; pid + firedAt -> which attempt.
 */
export function mintDeliveryId(payload: string, hookPid: number, firedAt: number): string {
  return createHash('sha256')
    .update(payload)
    .update('\0')
    .update(String(hookPid))
    .update('\0')
    .update(firedAt.toFixed(6))
    .digest('hex')
    .slice(0, 32)
}

export class HookJournal {
  readonly path: string
  readonly #seen = new Set<string>()

  constructor(path: string) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path)) this.#loadSeen()
  }

  #loadSeen(): void {
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const d = JSON.parse(line)
        if (d.deliveryId) this.#seen.add(d.deliveryId)
      } catch {
        /* a torn final line is expected after a crash */
      }
    }
  }

  has(deliveryId: string): boolean {
    return this.#seen.has(deliveryId)
  }

  get size(): number {
    return this.#seen.size
  }

  /**
   * Append and fsync BEFORE the caller acknowledges. An ack that outruns the write
   * turns a crash into silent loss -- the sender believes it delivered and will not
   * replay. Returns false when this delivery was already journalled.
   */
  appendDurable(delivery: HookDelivery): boolean {
    if (this.#seen.has(delivery.deliveryId)) return false
    const line = JSON.stringify({ ...delivery, receivedAt: delivery.receivedAt ?? Date.now() }) + '\n'
    const fd = openSync(this.path, 'a')
    try {
      writeSync(fd, line)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.#seen.add(delivery.deliveryId)
    return true
  }

  read(): HookDelivery[] {
    if (!existsSync(this.path)) return []
    const out: HookDelivery[] = []
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        /* torn line */
      }
    }
    return out
  }

  /** Fire-side record, written by the hook client before it attempts delivery. */
  static appendAttempt(path: string, record: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, JSON.stringify(record) + '\n')
    } catch {
      /* journalling must never take the CLI down */
    }
  }
}
