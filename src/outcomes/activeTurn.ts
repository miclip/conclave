/**
 * Is this participant in the middle of a turn?
 *
 * One question, one answer, two callers: the relay's peer send and the console's `/continue`.
 * Both are about to put bytes into a child, neither CLI accepts input mid-turn, and a send that
 * lands mid-turn is not queued -- it produces no `UserPromptSubmit` hook, the relay concludes it
 * has lost the transport, and the run ends (#117). The two used to answer it differently and
 * both were wrong, in opposite directions.
 *
 * ## Why not CPU
 *
 * The console's guard sampled the child's CPU and refused when it was not clearly idle. CPU is a
 * PROXY for "is this child mid-turn", and it is bad in both tails, which is not something a
 * better sampling schedule can repair:
 *
 *   - a child blocked in `sleep` inside a Bash tool call is mid-turn and samples at 3.2% -- the
 *     guard says go, and the send is fatal;
 *   - a finished child that twitched once samples 0.0 0.0 0.0 0.1 0.0 over fifteen seconds and
 *     is refused on the strength of the blip, then sits stuck for an hour until `/continue force`.
 *
 * Both readings were accurate. The quantity was the wrong one.
 *
 * ## Why not the transcript's `in_progress`
 *
 * The other near-miss, and the one this file exists to keep apart from the real question. The
 * settle loop in `Relay#exchangeTurn` reads `snapshot().turns.at(-1)?.state === 'in_progress'`
 * for a turn the Stop hook has ALREADY ended: that is a flush race, and waiting longer is the
 * right repair for it. Reusing it as a send precondition answers "has the record caught up"
 * with the state meant for "is the child still going", so an ordinary lagging transcript would
 * block a send that was perfectly safe -- and, worse, do it in a way that looks like the guard
 * working.
 *
 * ## What this reads instead
 *
 * The signal Conclave already holds and already renders. `turn_start` opens a turn and
 * `turn_end` closes it; that pair is what draws `implementer 43s Edit` in the console footer
 * (`src/repl/session.ts:869-882`), where `tool_use` only relabels a turn that is already
 * running. It is exact rather than inferred, because the adapters emit it from the hooks
 * themselves.
 *
 * Revisions count. A `turn_end` that is later withdrawn with no replacement is the
 * `resetTranscript` case -- the verdict is gone and the turn is open again; see `RevisionEvent`
 * in src/contract/session.ts -- and it is exactly the shape a watchdog produces when it calls a
 * long turn `timed_out` and a late signal takes it back. Reading that as a finished turn is the
 * unsafe direction all over again.
 */

import type { AgentEvent, TurnKey } from '../contract/session.ts'

export interface ActiveTurn {
  /** When the turn's `turn_start` was seen. */
  since: number
  /** The turn this participant is on, when the event carried one. */
  turnKey?: TurnKey | undefined
  /**
   * The most recent tool this turn started, for prose only.
   *
   * NEVER part of the decision. A turn with no tool call in flight is still a turn, and a
   * predicate that required one would say "idle" for a child composing a long reply -- which is
   * the same false negative as the CPU reading, arriving through a tidier door.
   */
  tool?: string | undefined
}

/**
 * The turn this participant is in the middle of, or `undefined` when it is between turns.
 *
 * Reads the whole event list rather than a suffix. The list is per-participant and appended to
 * by the relay's pump, so this is a fold over it, and a caller that tried to start from an
 * offset would have to know which offset -- the exact bookkeeping that makes a check drift from
 * the thing it checks.
 */
export function activeTurn(events: readonly AgentEvent[]): ActiveTurn | undefined {
  let open: ActiveTurn | undefined
  /** The `turn_end` that closed the last turn, so a revision can be matched to it. */
  let closedBy: { seq: number; turn: ActiveTurn } | undefined
  for (const e of events) {
    if (e.type === 'turn_start') {
      open = { since: e.at, turnKey: e.turnKey }
      closedBy = undefined
    } else if (e.type === 'turn_end') {
      // THIS turn's end, not any turn's end. A `turn_end` carrying a different key belongs to an
      // earlier prompt -- a late signal, a watchdog standing down after the next turn already
      // began -- and reading it as the end of the turn in flight is how a relay comes to send
      // into a child that is still working. `Relay#exchangeTurn` takes the first `turn_end` it
      // sees with no key check at all, so this is the check that stands between that and a send.
      //
      // An absent key closes anything, in both directions: `TurnEndEvent.turnKey` is optional,
      // and a predicate that required one would leave a turn open forever on any transport that
      // does not mint them -- a hang, which is worse than what it prevents. All four adapters do
      // set it: `claude.ts`, `codex.ts`, `opencode.ts` and `kimi.ts` each pass `turnKey` on the
      // `turn_end` they emit.
      const mine = e.turnKey === undefined || open?.turnKey === undefined || e.turnKey === open.turnKey
      if (open && mine) {
        closedBy = { seq: e.seq, turn: open }
        open = undefined
      }
    } else if (e.type === 'tool_use') {
      if (open) open.tool = e.tool
    } else if (e.type === 'revision') {
      // A withdrawal of the verdict that closed the turn puts the turn back. Only that one:
      // a revision replacing anything else -- a compaction, a superseded message -- says
      // nothing about whether the child is working.
      if (closedBy && e.replaces.includes(closedBy.seq)) {
        open = closedBy.turn
        closedBy = undefined
      }
    }
  }
  return open
}

/**
 * The turn as a line a human can act on: how long it has been running and what it is doing.
 *
 * Deliberately says nothing about CPU. A caller that wants to add a CPU reading as colour is
 * free to (`describeLiveness` still writes that sentence), but it is appended to this rather
 * than mixed into it, so nobody reading a refusal has to work out which of the two decided it.
 */
export function describeActiveTurn(turn: ActiveTurn, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - turn.since) / 1000))
  const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : `${secs}s`
  return turn.tool
    ? `its turn has been running ${elapsed} and its last tool call was ${turn.tool}`
    : `its turn has been running ${elapsed}`
}
