/**
 * The task queue and the seat table. Build order step 4 (D4).
 *
 * Two structures, one owner. The queue is a FIFO of immutable `Task` records — what the
 * advisor decided, written once at admission and never edited. The seat table is the mutable
 * execution state, keyed by participant id — what actually happened, and where. Keeping them
 * apart is what makes "the advisor asked for X" and "X ran on seat B and its verdict was
 * withdrawn" separately readable; a record that can be rewritten after the fact is a record no
 * audit can rely on.
 *
 * Only `Relay` mutates either. Not the adapters, not the participants, not `RunHandle`. This
 * is the rule `#pending`/`#drain` already follows for human asides and it exists for the same
 * reason: the routing log is the audit record, and a second writer makes attribution wrong
 * without making it look wrong.
 *
 * ## N=1 is the identity case, not a special case
 *
 * D1: if an abstraction needs an `if (seats.length === 1)` branch, it is the wrong
 * abstraction. Nothing here counts seats. One advisor and one implementer is a queue that
 * admits one task at a time and a table with one dispatchable seat, and the dispatch loop that
 * results IS the round loop it replaced — same turns, same order, same routing log.
 *
 * ## What this module does not do
 *
 * No I/O, no clock, no `#record`. Every decision here is made from state the caller holds and
 * values it passes in, so the scheduling rules can be tested without a relay, two sessions and
 * a repository. `recordCompletion` is the one function that writes, and it writes only to the
 * runtime handed to it: the rule it encodes has to be in exactly one place, and the bug it
 * replaces was that same rule written twice with a shared field between the copies.
 *
 * Performing the transitions is still `relay.ts`'s job, because only `Relay` owns the objects.
 *
 *   node --test src/relay/dispatch.test.ts
 */

import type { Outcome } from '../contract/outcome.ts'
import type { TurnEndEvent } from '../contract/session.ts'
import type { RoleId } from '../registry/roles.ts'

/**
 * Where the advisor pointed a task.
 *
 * A seat id or a role, and never a rank: `Rank` is an authority ordering feeding `outranks()`
 * (D5), so targeting by it would say "give this to anyone who may be overruled" rather than
 * "give this to whoever does this job". At N=1 the advisor's replies carry no target syntax at
 * all, so the dispatcher supplies the implementer seat's role as the default; `seatFor` below
 * owns what a role resolves to.
 */
export type TaskTarget = { kind: 'seat'; seat: string } | { kind: 'role'; role: RoleId }

/**
 * What the advisor decided. Immutable from the moment it is admitted.
 *
 * Every field is what was ASKED FOR. Nothing about how it went belongs here; that is
 * `TaskRuntime`, and the separation is the point.
 */
export interface Task {
  /** Stable identifier, distinct from `seq` so a record can be referenced before it is ordered. */
  readonly id: string
  /** Admission order. An identity and an audit key, **not** a scheduling priority. */
  readonly seq: number
  /** The advisor turn (`TurnEndEvent.seq`) whose reply produced this task. */
  readonly origin: number
  /** The prose the seat will receive, notes already split off. */
  readonly instruction: string
  /** The advisor's assignment, validated against the run's configured seats at admission. */
  readonly target: TaskTarget
  /**
   * Task ids that must reach successful `routed` before this one may be assigned.
   *
   * Empty for independent work, which is every task at N=1: today's advisor emits one
   * instruction per turn and cannot express an edge. The field is here because the dependency
   * rules are a property of the queue rather than of the seat count, and a queue that grows
   * the concept later would have no record of what the earlier tasks depended on.
   */
  readonly dependsOn: readonly string[]
  /**
   * Restricted human message seqs this task was adjudicated against, so `detectConflict` runs
   * once at admission rather than once per dispatch.
   */
  readonly restrictedOrigins: readonly number[]
  /** Wall clock, for ceiling accounting. */
  readonly admittedAt: number
}

/**
 * How far a task has got. One linear axis, ending in `complete`.
 *
 * `integrated` and `routed` are NOT on it, deliberately, and that is the whole point of this
 * type's shape. They are two independent facts — the seat's tree being ready and the advisor
 * having heard the report — reached in either order, and a single field cannot hold two of
 * those. Writing them both here was a real bug: at N=1 integration happens first and routing
 * second, so the final value came out `routed` by luck of the ordering, and the day a report
 * dispatched to the advisor before its merge finished, `integrated` would have overwritten
 * `routed` and every dependent of that task would have waited forever for a fact that had
 * already happened. `TaskRuntime.integratedAt` and `.routedAt` carry them instead.
 *
 * `complete` is therefore derived rather than declared: it means both facts hold. See
 * `recordCompletion`.
 *
 * At N=1 the integration boundary has nothing to do — one tree, and it is the operator's cwd
 * (D1) — but it is still a boundary that is crossed, because "nothing to commit" is a real
 * outcome that every read-only task takes at N>1 too.
 */
export type TaskState =
  | 'admitted'
  | 'ready'
  | 'assigned'
  | 'running'
  | 'reported'
  | 'complete'
  | 'cancelled'
  | 'failed'

/**
 * The verdict a task's turn is judged on, after a late revision has been taken into account.
 *
 * A seat is free when its turn ended **and** its verdict is graded (D4) — a `timed_out
 * (uncertain)` seat must not be handed more work. This is that grade, and its presence is the
 * dispatcher's proof that the judgement happened rather than an assumption that it did.
 */
export interface TaskGrade {
  /** The outcome acted on: the replacement's when a revision withdrew the original. */
  outcome: Outcome
  /** Whether a late signal withdrew the verdict the turn ended on. */
  superseded: boolean
}

/**
 * A dispatcher transition, stamped with a monotonic ordinal.
 *
 * Wall-clock timestamps cannot answer "did the next task get assigned before the previous
 * one's verdict was graded?" — two transitions in the same millisecond are indistinguishable,
 * and that is exactly the pair a scheduling bug would reorder. An ordinal from a single
 * counter can, and it is the only thing in this module that exists for the sake of being
 * checked rather than for the sake of scheduling.
 */
export interface TaskMark {
  event: TaskEvent
  ordinal: number
}

/**
 * Transitions worth stamping. A superset of `TaskState`: `sent` and `graded` are moments
 * inside `running` and `reported` respectively, and both are load-bearing for the invariant
 * above, which a state name alone would not record.
 */
export type TaskEvent =
  | 'admitted'
  | 'ready'
  | 'assigned'
  | 'sent'
  | 'ended'
  | 'reported'
  | 'graded'
  | 'released'
  | 'integrated'
  | 'routed'
  | 'cancelled'
  | 'failed'

/** What happened to a task. Every field here changes over its life; none of them are in `Task`. */
export interface TaskRuntime {
  state: TaskState
  /** The seat it was dispatched to, once assigned; unset while `ready`. */
  seat?: string | undefined
  /** Turn boundaries, for deadlines and liveness evidence. */
  sentAt?: number | undefined
  endedAt?: number | undefined
  /**
   * The `TurnEndEvent` this task's verdict was actually read from.
   *
   * The REPLACEMENT when a late revision withdrew the original, never the withdrawn one — so
   * it is set at grading rather than when the turn ended, because until supersession has been
   * resolved there is no answer to which event that is. Writing the first `turn_end` here and
   * overwriting it later would leave a window in which the field said something the relay had
   * already stopped believing, which is the same fault the pause path exists to avoid.
   */
  end?: TurnEndEvent | undefined
  /** When the boundary flow merged this task's work, or found nothing to commit. */
  integratedAt?: number | undefined
  /** When the report reached the advisor. Independent of `integratedAt`, in either order. */
  routedAt?: number | undefined
  /** The global `#seq` its report was recorded at — the task's place in real time. */
  reportSeq?: number | undefined
  /** Whether the transcript settle window was exhausted, as `#exchange` already returns. */
  unsettled?: boolean | undefined
  /** Set once the verdict has been resolved through supersession and judged. */
  grade?: TaskGrade | undefined
  /** When cancelled by a dependency, the causal `Task.id`; unset otherwise. */
  cancelledBy?: string | undefined
  /** Every transition, in order. Append-only. */
  marks: TaskMark[]
}

/**
 * Whether a seat can take a dispatch. Derived state: a seat is free because the dispatcher
 * finished handling its last task, not because anything told it so — the `AgentEvent` union
 * has no "idle" member and should not grow one, since a seat's freedom is a fact about the
 * dispatcher's bookkeeping rather than about the child process.
 */
export type SchedulerState =
  | 'idle'
  | 'queued'
  | 'running'
  | 'integrating'
  | 'rotation_pending'
  | 'merge_blocked'

/** The mutable execution state of one seat, keyed by participant id. */
export interface SeatExecution {
  readonly seat: string
  readonly role: RoleId
  state: SchedulerState
  /** `Task.id` in flight, or none. */
  current?: string | undefined
  /** When the seat last became free; the ordering key for role-targeted dispatch. */
  idleSince: number
  /** Tasks this seat has been dispatched. Diagnostic only; the queue is the record. */
  dispatched: number
}

/** Only `idle` and `queued` can take a dispatch, and only with nothing already in flight. */
export function isFree(seat: SeatExecution): boolean {
  return seat.current === undefined && (seat.state === 'idle' || seat.state === 'queued')
}

function matches(seat: SeatExecution, target: TaskTarget): boolean {
  return target.kind === 'seat' ? seat.seat === target.seat : seat.role === target.role
}

/** Seats a target could ever resolve to, free or not. Validation reads this; dispatch does not. */
export function seatsFor(seats: readonly SeatExecution[], target: TaskTarget): SeatExecution[] {
  return seats.filter((s) => matches(s, target))
}

/**
 * The seat a ready task should go to, or nothing if none is free.
 *
 * Role-targeted work goes to the **longest-idle** compatible seat, with the participant id as
 * the tie-breaker. Longest-idle spreads load and keeps one seat's context from growing much
 * faster than its peers'; the id tie-breaker makes the choice deterministic rather than
 * dependent on map iteration order, which is what lets a test assert it at all. At N=1 both
 * rules are trivially satisfied by the only seat that fills the role, which is the point.
 */
export function seatFor(
  seats: readonly SeatExecution[],
  target: TaskTarget,
): SeatExecution | undefined {
  const free = seatsFor(seats, target).filter(isFree)
  return free.sort((a, b) => a.idleSince - b.idleSince || a.seat.localeCompare(b.seat))[0]
}

/**
 * Record one of the two completion facts, and derive the state that results.
 *
 * Order-independent by construction. Both facts are their own field, so recording one cannot
 * erase the other however they interleave, and `complete` is computed from both rather than
 * being a place either of them writes to. This is one function rather than two so the rule
 * lives in one place: the bug it replaces was exactly the same rule written twice, once at
 * each boundary, with a shared field between them.
 *
 * `at` is passed in rather than read from a clock, so this stays testable without one.
 *
 * A task that failed or was cancelled keeps that state. Its facts are still recorded — the
 * record of what happened does not become less true because the task ended badly — but a
 * terminal failure is not overwritten by a boundary that ran anyway.
 */
export function recordCompletion(
  runtime: TaskRuntime,
  fact: 'integrated' | 'routed',
  at: number,
): void {
  if (fact === 'integrated') runtime.integratedAt = at
  else runtime.routedAt = at
  if (runtime.state === 'cancelled' || runtime.state === 'failed') return
  runtime.state =
    runtime.integratedAt !== undefined && runtime.routedAt !== undefined ? 'complete' : 'reported'
}

/**
 * Whether a task's report reached the advisor, and did so successfully.
 *
 * The PERSISTENT fact, not a state a later transition can move off. A dependent is written
 * against the advisor having heard its dependency's report; integration is a separate
 * question, and one the dependent has no stake in.
 *
 * Success, not merely terminality: a task that failed or was cancelled did not produce the
 * state its dependents were written against, even if a report of it was routed.
 */
export function routedSuccessfully(runtime: TaskRuntime | undefined): boolean {
  return (
    runtime?.routedAt !== undefined && runtime.state !== 'cancelled' && runtime.state !== 'failed'
  )
}

/**
 * Whether every dependency of a task has been successfully routed.
 *
 * Those that failed or were cancelled cancel the dependent instead, which is
 * `cancelledByDependency` below.
 */
export function dependenciesMet(
  task: Task,
  runtime: ReadonlyMap<string, TaskRuntime>,
): boolean {
  return task.dependsOn.every((id) => routedSuccessfully(runtime.get(id)))
}

/** The dependency that killed this task, if one did. Records the causal id, not merely the fact. */
export function cancelledByDependency(
  task: Task,
  runtime: ReadonlyMap<string, TaskRuntime>,
): string | undefined {
  return task.dependsOn.find((id) => {
    const state = runtime.get(id)?.state
    return state === 'failed' || state === 'cancelled'
  })
}

/**
 * The next task to assign, and where to put it.
 *
 * The lowest-`seq` ready task whose target seat is free. A later task may overtake an earlier
 * one that is still blocked on a dependency or whose target seat is busy: `seq` orders the
 * scan, so among tasks that *can* run the oldest wins, but it does not hold the queue behind
 * one that cannot. Head-of-line blocking on `dependsOn` would reintroduce lockstep through the
 * back door — a serial chain would idle every other seat for the length of the chain.
 */
export function nextDispatch(
  queue: readonly Task[],
  runtime: ReadonlyMap<string, TaskRuntime>,
  seats: readonly SeatExecution[],
): { task: Task; seat: SeatExecution } | undefined {
  for (const task of [...queue].sort((a, b) => a.seq - b.seq)) {
    if (runtime.get(task.id)?.state !== 'ready') continue
    const seat = seatFor(seats, task.target)
    if (seat) return { task, seat }
  }
  return undefined
}

/**
 * Why a seat cannot be handed this task, in words, or nothing if it can.
 *
 * The **ungraded** case is the one this exists for. A seat is free when its turn ended AND its
 * verdict is graded; freeing it at `turn_end` would hand more work to a session whose last
 * turn may have timed out, and the failure would look like a scheduling decision somebody made
 * rather than a check that was skipped. Returning the reason rather than a boolean is what
 * lets the caller put it in the error it raises.
 */
export function refuseDispatch(
  seat: SeatExecution,
  runtime: ReadonlyMap<string, TaskRuntime>,
): string | undefined {
  if (seat.current !== undefined) {
    const held = runtime.get(seat.current)
    return held?.grade === undefined
      ? `${seat.seat} still holds ${seat.current}, whose verdict is not graded`
      : `${seat.seat} still holds ${seat.current}`
  }
  if (!isFree(seat)) return `${seat.seat} is ${seat.state}`
  return undefined
}

/**
 * An advisor reply, read as assignment decisions.
 *
 * The existing keywords survive as decisions of their own, matched exactly as the round loop
 * matched them, because a reply that ended a run yesterday must end one today.
 */
export type Decision =
  | { kind: 'instruct'; instruction: string; target: TaskTarget }
  | { kind: 'done'; instruction: string }
  | { kind: 'escalate'; instruction: string }

/**
 * Why a reply produced no decisions.
 *
 * `empty` is today's empty instruction. `unknown_target` is a reply naming a seat id or role
 * the run does not have — unreachable at N=1, where no reply carries a target, and included
 * because the alternative is a parser that invents a seat the moment one does.
 */
export type ParseFailure = { why: 'empty' | 'unknown_target'; detail: string }

export type ParseResult = { ok: true; decisions: Decision[] } | { ok: false } & ParseFailure

/**
 * Parse an advisor reply into decisions, and **fail closed**.
 *
 * A reply that does not parse cleanly — including one naming a target the run does not have —
 * is treated exactly as an empty instruction is treated today: recorded, and the advisor asked
 * once more. Guessing at an ambiguous reply would let a parser invent work nobody authorised,
 * and guessing at an unrecognised target would let it invent a seat; a hallucinated seat id
 * that silently created capacity would be a scheduling decision nobody made.
 *
 * `instruction` arrives already trimmed and with NOTE: lines lifted, because those are
 * addressed to the operator and must not reach a seat as part of the work.
 */
export function parseDecisions(
  instruction: string,
  seats: readonly SeatExecution[],
  fallback: TaskTarget,
): ParseResult {
  if (instruction === '') return { ok: false, why: 'empty', detail: 'the reply carried no instruction' }
  if (/^DONE\b/i.test(instruction)) return { ok: true, decisions: [{ kind: 'done', instruction }] }
  if (/^ESCALATE\b/i.test(instruction)) {
    return { ok: true, decisions: [{ kind: 'escalate', instruction }] }
  }
  // Validated against the run's CONFIGURED seats, not against the free ones: a task for a busy
  // seat is a scheduling wait, and a task for a seat that does not exist is a parse failure.
  if (seatsFor(seats, fallback).length === 0) {
    return {
      ok: false,
      why: 'unknown_target',
      detail:
        fallback.kind === 'seat'
          ? `no seat named ${fallback.seat}`
          : `no seat fills the role ${fallback.role}`,
    }
  }
  return { ok: true, decisions: [{ kind: 'instruct', instruction, target: fallback }] }
}
