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
  * (`src/repl/session.ts:1200`), where `tool_use` only relabels a turn that is already

 * running. It is exact rather than inferred, because the adapters emit it from the hooks
 * themselves.
 *
 * Revisions count. A `turn_end` that is later withdrawn with no replacement is the
 * `resetTranscript` case -- the verdict is gone and the turn is open again; see `RevisionEvent`
 * in src/contract/session.ts -- and it is exactly the shape a watchdog produces when it calls a
 * long turn `timed_out` and a late signal takes it back. Reading that as a finished turn is the
 * unsafe direction all over again.
 *
 * ## Which `turn_end`s close a turn
 *
 * Not all of them: one carrying `transportOpen` does not, because the emitter is saying it
 * cannot rule out that the child is still executing. That is a fact about the child, and it is
 * the adapter's to report rather than this predicate's to infer -- the adapter is the only
 * thing that knows whether a `Stop` arrived, whether ESC was typed, whether the process is
 * alive, and (since #36) whether the child's transcript shows the turn ending.
 *
 * The OUTCOME is deliberately not the discriminator, though `timed_out` is very nearly a
 * synonym for it. Two reasons, and the second is the load-bearing one:
 *
 *   - it would be a proxy for a fact the emitter already holds, and proxies for that fact are
 *     what this file exists to keep out (see "Why not CPU");
 *   - `timed_out` no longer means one thing. Since #36 the adapters ask the transcript when a
 *     deadline fires, so a turn the transcript shows as terminal is superseded to `completed`,
 *     and what survives as `timed_out` is a turn with no evidence of ending. It is that second
 *     state, not the outcome label, that must refuse a send -- and the reason the distinction
 *     is load-bearing rather than pedantic is that #36 is a PARTIAL fix. A turn still working
 *     when the unconditional absolute cap lands is reported `timed_out` with its transcript
 *     reading `in_progress`, so the child may genuinely still be executing, and the outcome
 *     label is the one thing that cannot tell you so.
 *
 * `synthesized` is not the discriminator either, though it looks more like one. It marks a
 * verdict nothing announced to us, which includes the ones drawn from a dead process and from
 * the transcript -- both observations of a child that has stopped.
 */

import type { AgentEvent, RevisionEvent, TurnKey } from '../contract/session.ts'

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
  /**
   * Set when the ONLY reason this turn reads as open is that the `turn_end` closing it was
   * withdrawn -- and nothing has happened since.
   *
   * An annotation, never part of the answer: the turn is open either way, and a caller that
   * treated a reopened turn as finished would be making the unsafe read this file exists to
   * prevent. What it lets a caller ask is a different question -- "is this openness an
   * observation, or a deleted record?" -- which the console's `/continue` needs and the relay's
   * peer send does not (#66).
   *
   * A later `turn_start` clears it, because that is an observation: the child began a turn, and
   * the withdrawal has nothing to say about that one. Only `turn_start`. A `tool_use` does NOT
   * clear it, and the difference is not a subtlety -- the adapters drop the transcript view's
   * `turn_start`/`turn_end` and forward everything else (`Claude#pollTranscript`), so a
   * `turn_start` in this stream came from a hook and is real, while a `tool_use` may be the
   * view re-emitting surviving history after the very rewrite that caused the withdrawal.
   * Clearing on one of those would answer "is the child working" with "was the file rewritten".
   */
  withdrawn?: { at: number; reason: RevisionEvent['reason'] } | undefined
  /**
   * Set when this turn reads as open despite a `timed_out` verdict having been reported for it.
   *
   * Which is now a narrow state rather than every deadline: the adapter has fired its clock,
   * asked the child's transcript, and found no proof the turn ended. See `TurnEndEvent`.
   *
   * An annotation, never part of the answer, for the same reason `withdrawn` is one: the turn is
   * open either way. What it lets a caller do is SAY so. A refusal that reads "its turn has been
   * running 47m" when the operator has just been shown `timed_out (uncertain)` for that turn
   * looks like the console contradicting itself; the two are consistent, and the sentence that
   * makes them consistent is that a deadline expiring is not an observation of the child.
   *
   * Cleared if the verdict is later withdrawn, because then there is no `timed_out` to explain
   * and the turn is open for the other reason -- see `withdrawn`.
   */
  timedOut?: { at: number } | undefined
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
  /**
   * The seq of a `timed_out` end that did NOT close the turn.
   *
   * Kept so that withdrawing it is still recognised. Without this, a compaction that deletes a
   * deadline verdict would leave the turn open with nothing to say why -- and the console's #66
   * bypass, which exists so a deleted record cannot refuse an operator forever, would stop
   * firing on the one outcome most likely to be deleted.
   */
  let timedOutBy: number | undefined
  for (const e of events) {
    if (e.type === 'turn_start') {
      open = { since: e.at, turnKey: e.turnKey }
      closedBy = undefined
      timedOutBy = undefined
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
        if (e.transportOpen) {
          // The emitter says the child may still be executing. A verdict was reported -- and
          // the turn is still open, which is not a contradiction: see `TurnEndEvent`.
          timedOutBy = e.seq
          open = e.verdict.outcome === 'timed_out' ? { ...open, timedOut: { at: e.at } } : open
        } else {
          closedBy = { seq: e.seq, turn: open }
          open = undefined
        }
      }
    } else if (e.type === 'tool_use') {
      if (open) open.tool = e.tool
    } else if (e.type === 'revision') {
      // A withdrawal of the verdict that closed the turn puts the turn back. Only that one:
      // a revision replacing anything else -- a compaction, a superseded message -- says
      // nothing about whether the child is working.
      if (closedBy && e.replaces.includes(closedBy.seq)) {
        // Marked, not merely reopened. See `ActiveTurn.withdrawn`.
        open = { ...closedBy.turn, withdrawn: { at: e.at, reason: e.reason } }
        closedBy = undefined
      } else if (open && timedOutBy !== undefined && e.replaces.includes(timedOutBy)) {
        // The deadline verdict has been taken back. The turn did not reopen -- it was never
        // closed -- but the REASON it reads as open has changed, from a deadline nobody can act
        // on to a record that no longer exists, and a caller distinguishing those needs to see
        // the change. A `late_signal` replacement lands immediately after this and closes the
        // turn properly; a `resetTranscript` withdrawal does not, and that is the #66 case.
        const { timedOut: _gone, ...rest } = open
        open = { ...rest, withdrawn: { at: e.at, reason: e.reason } }
        timedOutBy = undefined
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
  const what = turn.tool
    ? `its turn has been running ${elapsed} and its last tool call was ${turn.tool}`
    : `its turn has been running ${elapsed}`
  // Said here rather than left to each caller, because every caller of this is about to explain
  // a refusal to a human who has just been shown the `timed_out` verdict for this turn.
  return turn.timedOut
    ? `${what}; its deadline expired and was reported as timed_out, which is this run giving up ` +
        `waiting rather than anything having observed the child stop`
    : what
}
