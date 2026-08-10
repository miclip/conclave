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
 * results reproduces the exchange loop it replaced — same turns, same order, same routing log.
 * One pass of that loop is one advisor turn, which is what `RelayOptions.maxAdvisorTurns` bounds.
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
 * What a task is FOR, as distinct from where it goes.
 *
 * Two values, and the second exists because a `merge_blocked` seat must accept exactly one
 * kind of work — the repair — and the dispatcher must be able to tell which that is without
 * reading the instruction. Classifying prose would be guessing: an advisor that happened to
 * write "resolve the conflict" in an ordinary instruction would slip work onto a blocked seat,
 * and one that wrote a repair in different words would be locked out of its own seat.
 *
 * So the purpose is DESIGNATED, by the orchestrator, at admission, on the one path that
 * creates a repair: the relay redirected this instruction to the blocked seat and knows it
 * did. It is a fact about how the task was routed, not a reading of what it says.
 */
export type TaskPurpose =
  /** Ordinary work. Everything, unless the relay redirected it to a blocked seat. */
  | 'work'
  /** The mechanically designated repair for the seat named in `target`. */
  | 'merge_resolution'

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
   * Why this task exists. Required, and required with no default: a task whose purpose could
   * be left unstated is a task the blocked-seat rule would have to guess about.
   */
  readonly purpose: TaskPurpose
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

/**
 * Whether this seat can take THIS task. Free, or blocked and holding its own designated repair.
 *
 * A `merge_blocked` seat is not free, and ordinary work must never land on it: work sent to a
 * seat whose branch will not merge produces more commits on that branch and makes the conflict
 * bigger while the run reports healthy. But it has to remain reachable, because the only way
 * out is a task that resolves the conflict IN ITS OWN worktree, and a seat nothing can be sent
 * to is a seat nothing can repair.
 *
 * Three conditions, all of them, and none of them a reading of the instruction: the task must
 * be the designated `merge_resolution`, it must name a seat, and the seat it names must be
 * this one. Targeting alone was not enough — it let ANY seat-targeted task in, so the moment
 * something other than the relay's own redirection could address a seat, ordinary work would
 * flow onto a blocked one again.
 */
export function canTake(seat: SeatExecution, task: Pick<Task, 'target' | 'purpose'>): boolean {
  if (seat.current !== undefined) return false
  if (isFree(seat)) return true
  return (
    seat.state === 'merge_blocked' &&
    task.purpose === 'merge_resolution' &&
    task.target.kind === 'seat' &&
    task.target.seat === seat.seat
  )
}

/**
 * How much admitted work is waiting for a seat.
 *
 * The reading behind `Ceilings.maxQueueDepth`. `admitted` and `ready` are the two states in
 * which a task exists and no seat has it: `admitted` is waiting on a dependency, `ready` is
 * waiting only on a seat, and an operator asking "how deep is the backlog" means both. Every
 * later state belongs to a seat and is `concurrentSeats`' problem, not this one.
 *
 * Here rather than in `guardrails.ts` because this module owns what these states mean.
 * `breached()` compares numbers; deciding which tasks are a queue is a scheduling fact.
 */
export function queueDepth(queue: readonly Task[], runtime: ReadonlyMap<string, TaskRuntime>): number {
  return queue.filter((t) => {
    const state = runtime.get(t.id)?.state
    return state === 'admitted' || state === 'ready'
  }).length
}

/**
 * How many seats are working right now.
 *
 * The reading behind `Ceilings.maxConcurrentSeats`. A seat counts from `#assign` to
 * `#reported` -- `state === 'running'` with a task in hand, which spans the task's `assigned`
 * and `running` states. Both conditions, not just the state: a seat left `running` with no
 * `current` would be a bookkeeping fault, and counting it would report phantom work rather
 * than surfacing the fault.
 *
 * `integrating` is excluded deliberately. That seat is occupied, but no agent is running on
 * it and no quota is being spent; a concurrency ceiling asks how much is IN FLIGHT. Counting
 * it would also make the number depend on how long the integration boundary takes, which at
 * N=1 is no time at all and at N>1 is not agent work either.
 */
export function concurrentSeats(seats: readonly SeatExecution[]): number {
  return seats.filter((s) => s.state === 'running' && s.current !== undefined).length
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
  task: Pick<Task, 'target' | 'purpose'>,
): SeatExecution | undefined {
  const free = seatsFor(seats, task.target).filter((s) => canTake(s, task))
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
 * Every queued task that can never become ready, and the dependency that killed each.
 *
 * `dependenciesMet` reads a PERSISTENT routed fact, so a task that failed keeps having
 * failed: nothing later makes `routedSuccessfully` true for it again. A dependent of a failed
 * task is therefore not waiting, it is finished waiting and does not know — it sits in the
 * queue at `admitted` forever, no seat is blocked by it, no request is outstanding, and every
 * individual state reports healthy while the run stops progressing. Cancelling it is the
 * PREVENTION of that state rather than the detection of it, and prevention is strictly
 * better: a detector reports after the fact something that need not have happened at all.
 *
 * Transitive, and computed to a fixpoint here rather than one round per dispatch. A chain
 * a -> b -> c dies whole the moment `a` fails; sweeping one hop at a time would leave `c`
 * queued until the next boundary, which is a queue that briefly holds a task nothing will
 * ever run — the exact state this exists to remove.
 *
 * Returns rather than mutates, unlike `recordCompletion`. Cancelling a task is a transition,
 * and transitions are `Relay`'s to perform because only it owns the objects and the ordinal
 * counter the marks are stamped from. Handing back a settled list also means the caller
 * applies a complete sweep or none of it; a fixpoint that mutated as it went could be
 * interrupted halfway into a state nobody designed.
 *
 * `admitted` and `ready` only. Anything further along belongs to a seat and is that seat's
 * turn to finish; killing a running task from the queue side would abandon a child mid-turn.
 */
export function cancelledByFailedDependencies(
  queue: readonly Task[],
  runtime: ReadonlyMap<string, TaskRuntime>,
): { task: Task; cancelledBy: string }[] {
  const doomed = new Map<string, string>()
  const ordered = [...queue].sort((a, b) => a.seq - b.seq)
  for (let changed = true; changed; ) {
    changed = false
    for (const task of ordered) {
      if (doomed.has(task.id)) continue
      const state = runtime.get(task.id)?.state
      if (state !== 'admitted' && state !== 'ready') continue
      // The single-hop rule stays in one place; this adds only the tasks THIS sweep has
      // already condemned, which the runtime does not know about yet.
      const cause = cancelledByDependency(task, runtime) ?? task.dependsOn.find((id) => doomed.has(id))
      if (cause === undefined) continue
      doomed.set(task.id, cause)
      changed = true
    }
  }
  // In `seq` order, so the chain reads from the failure outwards rather than in map order.
  return ordered.filter((t) => doomed.has(t.id)).map((task) => ({ task, cancelledBy: doomed.get(task.id)! }))
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
    const seat = seatFor(seats, task)
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
  task?: Pick<Task, 'target' | 'purpose'>,
): string | undefined {
  if (seat.current !== undefined) {
    const held = runtime.get(seat.current)
    return held?.grade === undefined
      ? `${seat.seat} still holds ${seat.current}, whose verdict is not graded`
      : `${seat.seat} still holds ${seat.current}`
  }
  // Without a task this is the old question — "is this seat free" — which is the right one for
  // every caller that is not about to dispatch a specific one. With one it is the same question
  // `seatFor` answered, and the two must not be able to disagree: a seat `seatFor` chose and
  // `refuseDispatch` then refused would be a dispatcher deadlocking on itself.
  if (task ? !canTake(seat, task) : !isFree(seat)) return `${seat.seat} is ${seat.state}`
  return undefined
}

/**
 * An advisor reply, read as assignment decisions.
 *
 * The existing keywords survive as decisions of their own, matched exactly as the exchange loop
 * this replaced matched them, because a reply that ended a run yesterday must end one today.
 */
export type Decision =
  | { kind: 'instruct'; instruction: string; target: TaskTarget }
  | { kind: 'done'; instruction: string }
  | { kind: 'escalate'; instruction: string }

/**
 * Why a reply produced no decisions.
 *
 * `empty` is today's empty instruction. The rest belong to the ADDRESSED form: a reply that
 * uses `@seat`/`@role` at all is held to it completely, because a reply that is half addressed
 * and half not is exactly the ambiguity a parser must not resolve on its own.
 *
 *   - `unknown_target` — a seat id or role the run does not have. A hallucinated seat id that
 *     silently created capacity would be a scheduling decision nobody made.
 *   - `stray_prose` — text outside every directive. It is an instruction with no target, and
 *     attaching it to a neighbouring one would put work on a seat nobody named.
 *   - `empty_instruction` — a directive with nothing after it. A seat addressed and given
 *     nothing is a turn spent on a routing header.
 *   - `mixed_keyword` — DONE or ESCALATE inside an addressed reply. Ending the run and
 *     assigning work are different decisions and a reply cannot be both.
 */
export type ParseFailure = {
  why: 'empty' | 'unknown_target' | 'stray_prose' | 'empty_instruction' | 'mixed_keyword'
  detail: string
}

export type ParseResult = { ok: true; decisions: Decision[] } | { ok: false } & ParseFailure

/**
 * A line that addresses one seat or one role, and everything after it until the next such line.
 *
 * `@seat <id>:` and `@role <id>:`, anchored to the start of a line. Two spellings rather than
 * one, because seat ids and role ids share no namespace and cannot be told apart by shape: a
 * run has a seat called `implementer` AND a role called `implementer`, so a single `@implementer`
 * would need a precedence rule, and a precedence rule is a silent answer to a question the
 * advisor thought it had asked explicitly. Naming the KIND makes the reply say which it meant.
 *
 * `@` because that is the sigil this product already uses for addressing a participant -- the
 * console's `@advisor` / `@implementer` asides -- so the advisor is not learning a second
 * convention for the same idea.
 */
const DIRECTIVE = /^@(seat|role)[ \t]+([^\s:]+)[ \t]*:[ \t]*(.*)$/

/** DONE and ESCALATE, matched the way the whole-reply forms are, for the mixed-form refusal. */
const KEYWORD_LINE = /^(DONE|ESCALATE)\b/i

/**
 * Parse an advisor reply into decisions, and **fail closed**.
 *
 * Two forms, and which one a reply is in is decided by whether it contains a directive line at
 * all:
 *
 *   - **unaddressed** — no `@seat`/`@role` anywhere. The whole reply is one instruction and it
 *     goes to `fallback`, which is exactly what this function did before the addressed form
 *     existed. This is the form the default run's advisor writes, because the syntax is only in
 *     its briefing when the run has more than one seat, and it must stay byte-identical.
 *   - **addressed** — at least one directive. Then EVERY part of the reply must belong to one,
 *     and any defect fails the WHOLE reply rather than the offending decision. Atomic on
 *     purpose: admitting the three decisions that parsed and dropping the fourth would run
 *     three-quarters of a plan the advisor wrote as one, and the quarter that vanished is the
 *     one nothing reports.
 *
 * A failure of either kind is treated exactly as an empty instruction is treated today:
 * recorded, and the advisor asked once more.
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
  // Whole-reply keywords first, and matched exactly as they were before any of this existed: a
  // reply that ended a run yesterday must end one today.
  if (/^DONE\b/i.test(instruction)) return { ok: true, decisions: [{ kind: 'done', instruction }] }
  if (/^ESCALATE\b/i.test(instruction)) {
    return { ok: true, decisions: [{ kind: 'escalate', instruction }] }
  }

  const lines = instruction.split('\n')
  const first = lines.findIndex((l) => DIRECTIVE.test(l))
  if (first === -1) {
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

  // Anything before the first directive is work addressed to nobody. Not silently attached to
  // the first decision: the advisor that wrote a preamble and the advisor that wrote an
  // instruction it forgot to address look identical here, and one of them is asking for work to
  // happen on a seat it did not name.
  const preamble = lines.slice(0, first).join('\n').trim()
  if (preamble !== '') {
    return {
      ok: false,
      why: 'stray_prose',
      detail: `text before the first @seat/@role directive: ${JSON.stringify(preamble.slice(0, 80))}`,
    }
  }

  /** One directive and its body, before either has been validated. */
  const blocks: { kind: string; name: string; body: string[] }[] = []
  for (const line of lines.slice(first)) {
    const m = DIRECTIVE.exec(line)
    if (m) {
      blocks.push({ kind: m[1]!, name: m[2]!, body: m[3]! === '' ? [] : [m[3]!] })
      continue
    }
    blocks.at(-1)!.body.push(line)
  }

  const decisions: Decision[] = []
  for (const block of blocks) {
    const body = block.body.join('\n').trim()
    if (body === '') {
      return {
        ok: false,
        why: 'empty_instruction',
        detail: `@${block.kind} ${block.name} was addressed and given no instruction`,
      }
    }
    const keyword = body.split('\n').find((l) => KEYWORD_LINE.test(l.trim()))
    if (keyword !== undefined) {
      return {
        ok: false,
        why: 'mixed_keyword',
        detail:
          `${keyword.trim().split(/\s/)[0]!.toUpperCase()} appears inside an addressed reply. ` +
          `Ending the run and assigning work are different decisions; send them in different turns.`,
      }
    }
    const target: TaskTarget =
      block.kind === 'seat' ? { kind: 'seat', seat: block.name } : { kind: 'role', role: block.name }
    if (seatsFor(seats, target).length === 0) {
      return {
        ok: false,
        why: 'unknown_target',
        detail:
          target.kind === 'seat' ? `no seat named ${target.seat}` : `no seat fills the role ${target.role}`,
      }
    }
    decisions.push({ kind: 'instruct', instruction: body, target })
  }
  return { ok: true, decisions }
}
