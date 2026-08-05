/**
 * Serialized, attributed input.
 *
 * Two jobs, and the second is the one that matters for the lifecycle model:
 *
 * 1. Serialization. send(), cancel() and decidePermission() all write keystrokes to the
 *    same PTY. Interleaving them corrupts both -- half a prompt with an ESC in the
 *    middle is not a cancellation, it is garbage. Every action goes through one queue.
 *
 * 2. Attribution. The queue records SEMANTIC ACTIONS -- submit, cancel,
 *    permission_decision -- not just the bytes they turned into. Bytes are transport
 *    evidence; actions are what lets the classifier say `cancelled` at all, since
 *    nothing in Claude Code records a cancellation anywhere. This log IS the evidence
 *    behind an `assumed` confidence grade, so it has to mean something.
 *
 * When input ownership is `external`, actions can enter the child without passing
 * through here. That is exactly why that mode drops cancellation attribution.
 */

import type { PtyProcess } from './pty.ts'

export type ActionKind = 'submit' | 'cancel' | 'permission_decision' | 'raw'

export interface InputAction {
  kind: ActionKind
  at: number
  /** Who asked for it. `external` means it did not come through the orchestrator. */
  origin: 'orchestrator' | 'external'
  detail?: string
  /** Bytes actually written. Transport evidence, kept for debugging only. */
  bytes?: string
}

/**
 * Established in spike 1: writing text and CR as one burst is unreliable, because both
 * CLIs coalesce fast input as a paste and the submit gets swallowed. Type the body,
 * pause, then send Enter alone. Codex additionally needs
 * `-c disable_paste_burst=true`.
 */
const SUBMIT_SETTLE_MS = 400

export class InputQueue {
  readonly #pty: PtyProcess
  readonly #log: InputAction[] = []
  /** Tail of the serialization chain. Every action appends to it. */
  #chain: Promise<unknown> = Promise.resolve()

  constructor(pty: PtyProcess) {
    this.#pty = pty
  }

  get actions(): readonly InputAction[] {
    return this.#log
  }

  /** Most recent action of a kind, for the classifier's orchestrator evidence. */
  last(kind: ActionKind): InputAction | undefined {
    for (let i = this.#log.length - 1; i >= 0; i--) {
      if (this.#log[i]!.kind === kind) return this.#log[i]
    }
    return undefined
  }

  hasSent(kind: ActionKind, since = 0): boolean {
    return this.#log.some((a) => a.kind === kind && a.at >= since)
  }

  /** Serialize `fn` behind everything already queued. Failures do not break the chain. */
  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn)
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  #record(action: InputAction): void {
    this.#log.push(action)
  }

  async submit(text: string, detail?: string): Promise<InputAction> {
    return this.#enqueue(async () => {
      this.#pty.write(text)
      await new Promise((r) => setTimeout(r, SUBMIT_SETTLE_MS))
      this.#pty.write('\r')
      const action: InputAction = {
        kind: 'submit',
        at: Date.now(),
        origin: 'orchestrator',
        detail: detail ?? text.slice(0, 120),
        bytes: `${text}\\r`,
      }
      this.#record(action)
      return action
    })
  }

  async cancel(detail?: string): Promise<InputAction> {
    return this.#enqueue(async () => {
      this.#pty.write('\x1b')
      const action: InputAction = {
        kind: 'cancel',
        at: Date.now(),
        origin: 'orchestrator',
        detail,
        bytes: '\\x1b',
      }
      this.#record(action)
      return action
    })
  }

  /**
   * ESC on Claude Code's permission dialog is "No, and tell Claude what to do
   * differently" -- observed in spike 3.
   *
   * `allow` is NOT verified: option 1 is the highlighted default and Enter should take
   * it, but no spike has exercised it. Until a fixture exists, an allow is recorded with
   * that caveat rather than presented as equivalent evidence to a deny.
   */
  async decidePermission(decision: 'allow' | 'deny'): Promise<InputAction> {
    return this.#enqueue(async () => {
      const bytes = decision === 'deny' ? '\x1b' : '\r'
      this.#pty.write(bytes)
      const action: InputAction = {
        kind: 'permission_decision',
        at: Date.now(),
        origin: 'orchestrator',
        detail: decision === 'allow' ? 'allow (unverified encoding)' : 'deny',
        bytes: decision === 'deny' ? '\\x1b' : '\\r',
      }
      this.#record(action)
      return action
    })
  }

  /** Escape hatch for the keystroke proxy. Origin is recorded honestly. */
  async raw(bytes: string, origin: 'orchestrator' | 'external', detail?: string): Promise<InputAction> {
    return this.#enqueue(async () => {
      this.#pty.write(bytes)
      const action: InputAction = { kind: 'raw', at: Date.now(), origin, detail, bytes }
      this.#record(action)
      return action
    })
  }

  /** Resolves when everything queued so far has been written. */
  async drain(): Promise<void> {
    await this.#chain
  }
}
