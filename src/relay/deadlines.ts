/**
 * What a turn is measured against, resolved once and reported everywhere.
 *
 * This is the deadline half of what `guardrails.ts` is for ceilings, and it exists for the
 * same reason that file gives: the launch banner, the relay's launch line, the run report and
 * `status --json` all answer "what is this run measured against", and four places computing it
 * would eventually disagree. #119 is the ceiling version of that failure -- a run that ended at
 * a bound its operator believed they had raised, with no surface able to say what the bound
 * was. A deadline is the same kind of fact and deserves the same treatment.
 *
 * It moved out of `relay.ts` when `--silence-timeout` landed, and the move is what makes the
 * banner honest rather than merely convenient. The banner prints BEFORE `Relay.start`, so it
 * cannot ask a relay what its seats resolved to; the only alternatives were to say nothing
 * about deadlines at launch, or to re-derive the precedence beside the printer. The second is
 * the copy this module exists to prevent -- `resolveClock` is the single place the precedence
 * lives, and a second copy of it in a renderer is a rule that gets relaxed in one place and
 * kept in the other.
 *
 * Nothing here is per-turn. It is the policy each seat is under for the whole run, which is
 * what a reader interpreting a `timed_out` after the fact needs; a turn's own elapsed time is
 * in its provenance.
 */

import type { ClockSupport, DeadlineSupport } from '../registry/types.ts'

/**
 * One clock's resolved state for one seat.
 *
 * Three states rather than a nullable number, because the third is the one worth the shape.
 * `disabled` is a clock the adapter HAS and this run left off; `unsupported` is a clock the
 * adapter does not have and no configuration can turn on. A reader who collapses them is
 * waiting for a `timed_out` that cannot arrive.
 */
export type DeadlineClock =
  | { status: 'enforced'; ms: number }
  | { status: 'disabled' }
  | { status: 'unsupported' }

/** What one seat is measured against. Both clocks, always both present. */
export interface ParticipantDeadlines {
  /** The seat, not the agent: ids are what the turns in the report are keyed by. */
  id: string
  agent: string
  /**
   * The whole turn, however busy. Refreshed by NOTHING.
   *
   * Child output pushes out `silence` and never this, so a turn that keeps producing still
   * reaches this number -- and what happens when it does is that the run stops awaiting that
   * exchange and reports `timed_out`. Not that the turn ends: nothing here reaches the child,
   * and the seat stays unsendable until a cancellation, terminal transcript or hook evidence,
   * or the process exiting. The released wait is what the run needs, because `--max-turns` and
   * `--max-minutes` are checked at turn boundaries and nowhere else, so a turn output could
   * extend without limit would be a run no ceiling could end.
   *
   * A `timed_out` from THIS clock is the case #36 did not fix. The adapters re-read the
   * transcript when a deadline fires, but a working turn's transcript says `in_progress`,
   * which is not evidence it ended, so the verdict stands on a turn that was fine. A reader
   * seeing `timed_out` on a seat whose turns are legitimately long should suspect this number
   * before suspecting the child.
   *
   * Suspect, not confirm. This is the CONFIGURED budget and nothing else: neither this field
   * nor any other in the report says which of the two clocks actually produced a given
   * verdict. That provenance exists on the watchdog's update at the moment it fires and is not
   * retained here, so the artifact answers "what was this seat measured against" and cannot
   * answer "which clock produced this verdict" -- and neither question is "what ended this
   * turn", which is not something either clock does.
   */
  absolute: DeadlineClock
  /**
   * How long the turn may say NOTHING. A different question, not a tighter version.
   *
   * The only one of the two that substantive child output pushes out, and the one that reaches
   * an ordinary hang: a child that stopped working stopped writing, so this fires at its own
   * budget rather than leaving the turn to the absolute cap. That is the part of #36 that was
   * fixed, against the incident actually reported -- the wait went from ~44 information-free
   * minutes to this number.
   *
   * Configurable since `--silence-timeout`, and `unsupported` here is what that flag does NOT
   * override: two of the four built-in adapters run no silence clock, and a run that mixes
   * them applies the setting to the seats that have one and reports this for the rest. A
   * configured budget, like the field above it, and equally silent about which clock fired.
   */
  silence: DeadlineClock
}

/**
 * The deadlines a run was measured against — per seat, because the verdict is.
 *
 * There is no run-wide answer, and reporting one was wrong: a `timed_out` belongs to a
 * participant, and two seats in the same run can be on different clocks or on none. The
 * adapters differ in what they can KNOW rather than only in how they were wired, so a
 * single pair of numbers here would be an average that neither seat honours.
 */
export interface RunDeadlines {
  /**
   * What the invocation ASKED for, and nothing more. Kept because the gap between this and
   * `participants` is itself worth seeing -- `--turn-timeout 60` against a seat whose
   * adapter has no silence clock is a request half of which went nowhere.
   */
  configuredAbsoluteMs: number | null
  /**
   * What the invocation asked of the SILENCE clock, and nothing more.
   *
   * Beside `configuredAbsoluteMs` and reported the same way, because the gap between a
   * request and what the seats did with it is the same gap on both clocks -- and on this one
   * it is wider. Two of the four built-in adapters run no silence clock at all, so
   * `--silence-timeout 300` on a run seating one of them is a request that reached some seats
   * and not others, and `participants` below is where that is resolved seat by seat.
   *
   * `null` for "nobody asked", never `0` and never absent. A key that vanished when unset
   * could not be told from a key the reader forgot to look for, and `0` is a request for an
   * instant deadline rather than for none.
   */
  configuredSilenceMs: number | null
  participants: ParticipantDeadlines[]
}

/**
 * Resolve one declared clock against what this run asked for.
 *
 * The only place the precedence lives: an unsupported clock stays unsupported however hard
 * it is configured, a request beats the adapter's default, and an absent default with no
 * request is off rather than infinite.
 *
 * The first of those three is what makes `--silence-timeout` safe to ACCEPT on a seat that
 * cannot honour it. The alternative was to refuse the flag whenever any seat lacked the
 * clock, which would discard a valid setting for every seat in the same run that has one --
 * a run of two Claude seats and one Kimi would lose the setting on both Claude seats to
 * report a fact about the third. Resolving per seat keeps both halves of the truth.
 */
export function resolveClock(support: ClockSupport, requestedMs: number | undefined): DeadlineClock {
  if (!support.supported) return { status: 'unsupported' }
  const ms = requestedMs ?? support.defaultMs
  return ms === undefined ? { status: 'disabled' } : { status: 'enforced', ms }
}

/** One seat, as much of it as resolving a deadline needs. */
export interface DeadlineSeat {
  id: string
  agent: string
  /** What that seat's ADAPTER declares, read from the registry by the caller. */
  declared: DeadlineSupport
}

/**
 * Every seat's resolved policy, plus what the invocation asked for.
 *
 * Handed the seats rather than a registry, so the relay can pass live participants and the
 * banner can pass specs it has not launched yet -- and both get the same answer from the same
 * precedence. Which is the point: the banner prints before any seat exists, and the one thing
 * it must not do is describe a policy the run will not actually be under.
 */
export function resolveDeadlines(input: {
  requestedAbsoluteMs?: number | undefined
  requestedSilenceMs?: number | undefined
  seats: readonly DeadlineSeat[]
}): RunDeadlines {
  return {
    configuredAbsoluteMs: input.requestedAbsoluteMs ?? null,
    configuredSilenceMs: input.requestedSilenceMs ?? null,
    participants: input.seats.map((s) => ({
      id: s.id,
      agent: s.agent,
      absolute: resolveClock(s.declared.absolute, input.requestedAbsoluteMs),
      silence: resolveClock(s.declared.silence, input.requestedSilenceMs),
    })),
  }
}

/** Seconds, for a line a human reads. Whole where it divides, which every real setting does. */
function secs(ms: number): string {
  const s = ms / 1000
  return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`
}

/** One clock, spelled for a launch line. */
function clockText(c: DeadlineClock): string {
  if (c.status === 'enforced') return secs(c.ms)
  return c.status === 'disabled' ? 'off' : 'unsupported'
}

/**
 * One clock, as one line: the flag that sets it, what was asked of it, and what each seat
 * resolved to.
 *
 * Both public summaries below are this function with a different flag name and a different
 * field read off each participant, because the two lines sit next to each other wherever
 * either appears -- the launch banner, and the dry-run plan -- and a reader comparing them is
 * comparing the numbers, not the punctuation. Two formatters would eventually differ in the
 * separator, the word for "nobody asked", or whether an unsupported seat is named at all, and
 * the last of those is the one that matters.
 *
 * Seats are named individually rather than collapsed when they agree, and `unsupported` is
 * printed rather than omitted. Both follow `ceilingSummary`: a line that listed only the seats
 * with something to say would be silent exactly on the run where a seat has NO clock, and that
 * seat -- one that can go quiet forever and produce no verdict at all -- is the one an operator
 * most needs to see named.
 */
function clockSummary(
  flag: string,
  askedMs: number | null,
  d: RunDeadlines,
  of: (p: ParticipantDeadlines) => DeadlineClock,
): string {
  const asked = askedMs === null ? 'unset' : secs(askedMs)
  const seats = d.participants.map((p) => `${p.id} ${clockText(of(p))}`).join(' · ')
  return seats ? `${flag} ${asked} — ${seats}` : `${flag} ${asked}`
}

/**
 * The SILENCE policy, as one line at launch.
 *
 * The full pair, per seat, is in the run report and in `status --json`; this is the reading an
 * operator needs BEFORE the work exists to lose it -- which is the same argument the ceilings
 * line makes three lines above it.
 */
export function silenceSummary(d: RunDeadlines): string {
  return clockSummary('--silence-timeout', d.configuredSilenceMs, d, (p) => p.silence)
}

/**
 * The ABSOLUTE policy, the same way, and the half the launch surfaces used to leave out.
 *
 * The argument for omitting it was that `--turn-timeout` has been reportable since it shipped
 * and a launch line restating both would double in width. That was wrong about where it was
 * reportable: the run report and `status --json` carry it, and BOTH are documents of a run that
 * already exists. Before the run there was nothing -- so an operator who mistyped
 * `--turn-timeout`, or who seated an adapter that runs no absolute clock at all, learned it
 * from a turn that ran to the wrong bound or never stopped waiting. That is the same failure
 * the silence line was added for, one clock over, and the width is worth it.
 */
export function absoluteSummary(d: RunDeadlines): string {
  return clockSummary('--turn-timeout', d.configuredAbsoluteMs, d, (p) => p.absolute)
}
