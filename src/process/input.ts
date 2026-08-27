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
  detail?: string | undefined
  /** Bytes actually written. Transport evidence, kept for debugging only. */
  bytes?: string | undefined
}

/**
 * Established in spike 1: writing text and CR as one burst is unreliable, because both
 * CLIs coalesce fast input as a paste and the submit gets swallowed. Type the body,
 * pause, then send Enter alone. Codex additionally needs
 * `-c disable_paste_burst=true`.
 */
const SUBMIT_SETTLE_MS = 400

/**
 * Permission-dialog key encodings, per agent.
 *
 * These differ, and one half is verified while the other is not, so a single blanket
 * caveat would be wrong in both directions.
 */
export interface PermissionEncoding {
  allow: string
  deny: string
  /** Whether the allow encoding has been exercised against a real dialog. */
  allowVerified: boolean
  describeAllow: string
}

/**
 * Claude Code. ESC on the dialog is "No, and tell Claude what to do differently",
 * observed in spike 3. Allow is presumed to be Enter taking the highlighted first
 * option, but no fixture has exercised it.
 */
export const CLAUDE_PERMISSION_ENCODING: PermissionEncoding = {
  allow: '\r',
  deny: '\x1b',
  allowVerified: false,
  describeAllow: 'allow (unverified encoding)',
}

/**
 * Codex 0.146.0. Both halves observed live, dialog captured verbatim:
 *
 *   1. Yes, proceed (y)
 *   2. Yes, and don't ask again for these files (a)
 *   3. No, and tell Codex what to do differently (esc)
 *
 * `y` was confirmed by the file being created and Stop firing; ESC by the file not
 * being created and turn_aborted being recorded.
 */
export const CODEX_PERMISSION_ENCODING: PermissionEncoding = {
  allow: 'y',
  deny: '\x1b',
  allowVerified: true,
  describeAllow: 'allow',
}

export class InputQueue {
  readonly #pty: PtyProcess
  readonly #log: InputAction[] = []
  readonly #keys: PermissionEncoding
  /** Tail of the serialization chain. Every action appends to it. */
  #chain: Promise<unknown> = Promise.resolve()

  constructor(pty: PtyProcess, keys: PermissionEncoding = CLAUDE_PERMISSION_ENCODING) {
    this.#pty = pty
    this.#keys = keys
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
   * Answer a pending permission dialog using this adapter's encoding.
   *
   * The recorded detail distinguishes a verified encoding from an assumed one, so later
   * code cannot treat a presumed allow as equivalent evidence to an observed deny.
   */
  async decidePermission(decision: 'allow' | 'deny'): Promise<InputAction> {
    return this.#enqueue(async () => {
      const bytes = decision === 'deny' ? this.#keys.deny : this.#keys.allow
      this.#pty.write(bytes)
      const action: InputAction = {
        kind: 'permission_decision',
        at: Date.now(),
        origin: 'orchestrator',
        detail: decision === 'deny' ? 'deny' : this.#keys.describeAllow,
        bytes: JSON.stringify(bytes),
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
