/**
 * Two axes for an unresolved condition: who can resolve it, and what it stops.
 *
 * `RunPause` conflates DETECTION of an unresolved condition with ESCALATION to a human. They
 * look like one thing only because the first operator happened to be a person. D2 separates
 * them: **authority answers who can resolve it, scope answers what it stops.** Seat identity
 * lives on the second axis; putting it on the first was the error in both original designs,
 * which is why nothing here adds a `seat` field to `RunPause`.
 *
 * ## This is metadata, and metadata only
 *
 * Every request computed here is recorded on the pause that was going to be raised anyway.
 * Nothing in this module routes, halts, resolves, or changes an option list, and #56 changes
 * none of those either. Three reasons, from the ruling that settled it:
 *
 *   1. D1 outranks D2. A default N=1 run must behave identically, and acting on a
 *      `mechanical` authority by dropping the `turn_incomplete` pause would delete a
 *      decision point the operator has today.
 *   2. Nothing in the mechanical layer can yet RESOLVE `turn_incomplete`. Removing the pause
 *      before building the resolution would not make the condition mechanical, it would drop
 *      it on the floor. That promotion is #60's work.
 *   3. `implementer_unanswered` routing to the advisor is a ROUTING change, declared as
 *      pending in #55's guard (`DECLARED` in `defaultUnchanged.test.ts`). It does not land
 *      here either.
 *
 * So today every request whose authority is not `operator` still produces an operator pause.
 * That gap is deliberate and it is pinned by `resolution.test.ts`, which asserts both the
 * computed axes and the unchanged pause behaviour for all six reasons — so the metadata
 * cannot quietly start changing behaviour later without a failure.
 *
 * ## Derived, not declared
 *
 * A caller supplies the EVIDENCE its condition is about — which participant, which
 * workstream — and nothing else. It cannot state an authority and cannot hand over a
 * prebuilt scope, because a condition that can nominate its own authority is a condition
 * that will eventually nominate the wrong one. Both axes are computed here from the reason
 * and the run's configuration.
 *
 *   node --test src/relay/resolution.test.ts
 */

import type { PauseReason } from './run.ts'

/**
 * The condition. Named for what it IS rather than for its current effect: `RunPause` is what
 * an operator-authority request looks like against interactive latency, and at N=1 that
 * happens to be every one of them. The two sets are identical today and the alias is what
 * stops the vocabulary from having to change when they stop being identical.
 */
export type ResolutionReason = PauseReason

/**
 * Who is ENTITLED to resolve the condition -- not who is asked today.
 *
 * `operator` deliberately, not `human`: it is a person interactively and an agent under
 * `--operator agent`. Naming it `human` bakes latency into an epistemic classification. The
 * authority boundary is the same in both modes; only the cost of crossing it differs.
 */
export type ResolutionAuthority = 'mechanical' | 'advisor' | 'operator'

/**
 * What the condition stops: block the smallest scope whose continuation would require
 * making the unresolved decision.
 */
export type ResolutionScope =
  | { kind: 'participant'; participantId: string }
  | { kind: 'workstream'; workstreamId: string }
  | { kind: 'conclave' }

export interface ResolutionRequest {
  reason: ResolutionReason
  authority: ResolutionAuthority
  scope: ResolutionScope
}

/**
 * What the caller knows about its own condition.
 *
 * A discriminated union rather than a bag of optionals, so the compiler demands exactly the
 * evidence each reason's scope is computed from and refuses the evidence it is not: a
 * `participant` on `operator_requested` would be a seat id attached to a conclave-wide
 * suspension, which is the conflation this whole decision is about.
 */
export type ResolutionSubject =
  /** The seat whose degradation was measured. */
  | { reason: 'rotation_candidate'; participant: string }
  /** The seat whose turn ended as something other than `completed`. */
  | { reason: 'turn_incomplete'; participant: string }
  /** The seat that asked the question. */
  | { reason: 'implementer_unanswered'; participant: string }
  /** The workstream whose instruction is being adjudicated. */
  | { reason: 'authority_conflict'; workstream: string }
  /** The seat whose branch will not merge, after its own repair attempt failed. */
  | { reason: 'merge_blocked'; participant: string }
  /** The seat whose work was rejected twice by review against the same original task. */
  | { reason: 'review_blocked'; participant: string }
  | { reason: 'advisor_escalated' }
  | { reason: 'operator_requested' }

/** Both directions, so neither set can grow past the other. */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** Fails to compile with its argument, which is the only thing this does. */
type Assert<T extends true> = T

/**
 * The union above covers `PauseReason` exactly -- no missing reason, no invented one.
 *
 * The switch in `resolutionFor` is exhaustive over `ResolutionSubject`, which on its own
 * proves nothing about `PauseReason`: the two are written separately, so a seventh reason
 * added to `run.ts` would compile everywhere and simply never be classified, which is the
 * quiet failure this decision is meant to prevent. This ties them together. A reason added
 * to one side and not the other fails the typecheck here, before it can reach a pause.
 *
 * Exported so it cannot be mistaken for dead code and deleted, and so `resolution.test.ts`
 * can name the guarantee it is relying on.
 */
export type EveryReasonIsClassified = Assert<Exactly<ResolutionSubject['reason'], PauseReason>>

/**
 * Who is actually ASKED today, as opposed to who is entitled to answer.
 *
 * One member, and that is the honest shape of it: every request routes to the operator,
 * whatever its authority says. `authority` is an epistemic classification and this is the
 * routing table, and the whole reason both exist is that they are not the same thing yet.
 */
export type ResolutionActor = 'operator'

/**
 * The routing that actually happens. Every authority falls back to the operator.
 *
 * A `Record` keyed by the authority union rather than a switch or a partial map, so a
 * seventh authority cannot be added without deciding here who answers it -- the same
 * argument `EveryReasonIsClassified` makes one axis over.
 */
const ROUTES: Record<ResolutionAuthority, ResolutionActor> = {
  mechanical: 'operator',
  advisor: 'operator',
  operator: 'operator',
}

/**
 * The actor that will answer this request, and an invariant that one exists.
 *
 * Vacuous today: the table above sends everything to the operator, so this cannot throw and
 * a test of it proves only that the routing is total. It stops being vacuous the day a
 * request stops being routed to the operator — when a `mechanical` authority is wired to a
 * resolver, the failure mode is a request classified as mechanically resolvable and handed
 * to a mechanism that was never built. That request has no respondent, nothing is waiting on
 * it, and the run reports healthy. Two lines now, and the alternative is discovering it as
 * silence later.
 *
 * A throw rather than a returned `undefined`, deliberately: a caller that has to remember to
 * check a result is a caller that will forget, and this runs at the one place every pause
 * passes through.
 */
export function actorFor(request: ResolutionRequest): ResolutionActor {
  const actor = ROUTES[request.authority]
  if (actor === undefined) {
    throw new Error(
      `no actor is routed for ${request.authority} authority (${request.reason}): ` +
        `a request nobody answers would leave the run waiting on nothing`,
    )
  }
  return actor
}

/** The run configuration authority is derived from. */
export interface ResolutionConfig {
  /**
   * Rotation checks are configured.
   *
   * `--checks` IS the operator pre-delegating rotation authority, by supplying the
   * verification method that makes the decision mechanical: without it the console says a
   * degraded implementer "escalates to you rather than being replaced"
   * (`src/repl/session.ts:1053`) and the run reports `rotation: NOT ARMED (no checks
   * configured)` (`src/relay/relay.ts:3487`).
   */
  rotationArmed: boolean
}

/**
 * Classify an unresolved condition. Pure: same subject and configuration, same request.
 *
 * The switch is exhaustive over `ResolutionSubject`, and `EveryReasonIsClassified` pins that
 * union equal to `PauseReason` -- so between them, a seventh reason cannot be added and left
 * unclassified. It fails the typecheck, which is the cheapest place for that argument to
 * happen. The switch alone would not have said this: it constrains only the union it reads.
 */
export function resolutionFor(subject: ResolutionSubject, config: ResolutionConfig): ResolutionRequest {
  switch (subject.reason) {
    case 'rotation_candidate':
      return {
        reason: subject.reason,
        // Derived from configuration, per D2. Note what this does NOT claim: that a run
        // with checks resolves the candidate without asking. Today it asks either way --
        // `onDegradation` defaults to `candidate` because the policy is not earned yet --
        // resolved for the seat in `rotationFor` (`src/relay/relay.ts:347`), which is where a
        // per-seat policy may override it (D7) and where the default is written once. So this
        // axis records the entitlement the operator has already delegated.
        //
        // The `operator` branch is REACHABLE, and it was not until #96. An unarmed run used to
        // end on degradation rather than pause, so the one configuration this branch describes
        // was the one that never produced a pause to describe -- the classification was honest
        // and unreachable at the same time. An unarmed run attended by a HUMAN now pauses
        // (`src/relay/relay.ts:5082`), which is what makes the derivation mean anything: with
        // checks the candidate is mechanical because a replacement could reproduce them, and
        // without checks it is the operator's because nothing else can settle it.
        //
        // Under `--operator agent` that same unarmed candidate is recorded and the run carries
        // on (#107) -- the operator this axis names cannot re-launch the run it is driving, so
        // the pause offered it no answer it did not already have. That narrows where the branch
        // is reached; it does not change what the branch SAYS. Who is entitled to settle an
        // unarmed candidate is still the operator, and it is still nobody else.
        authority: config.rotationArmed ? 'mechanical' : 'operator',
        scope: { kind: 'participant', participantId: subject.participant },
      }
    case 'turn_incomplete':
      // Mechanical: a turn that ended badly is a fact about a transport, and judging it
      // needs no privilege. Nothing can act on that yet -- see the header.
      return {
        reason: subject.reason,
        authority: 'mechanical',
        scope: { kind: 'participant', participantId: subject.participant },
      }
    case 'implementer_unanswered':
      // The advisor is the one holding the instruction that failed to settle the question,
      // so it is the one that can answer without the operator. Routing is unchanged.
      return {
        reason: subject.reason,
        authority: 'advisor',
        scope: { kind: 'participant', participantId: subject.participant },
      }
    case 'authority_conflict':
      // Structurally non-delegable: the restricted message is deliberately withheld from
      // the advisor, so no capability moves this decision. Only the workstream carrying the
      // instruction stops -- the operator holds both sides and nothing else needs to wait.
      return {
        reason: subject.reason,
        authority: 'operator',
        scope: { kind: 'workstream', workstreamId: subject.workstream },
      }
    case 'merge_blocked':
      // The advisor's authority has already been spent on this: it was told the seat was
      // blocked and dispatched the repair, and the repair did not take. What is left needs
      // hands in the repository, which is the operator's. The scope is the SEAT, not the
      // conclave -- its branch and tree are what cannot proceed, and every other seat's work
      // is unaffected by this decision. That the run happens to stop while the operator
      // answers is a property of how pauses are delivered today, not of what is blocked.
      return {
        reason: subject.reason,
        authority: 'operator',
        scope: { kind: 'participant', participantId: subject.participant },
      }
    case 'review_blocked':
      // Same shape as `merge_blocked` and for the same reason: a repair was dispatched
      // automatically, came back, and the reviewer rejected it again. What is left is a real
      // disagreement between what the seat produced and what the reviewer will accept, which
      // needs a human rather than a third automatic repair. Scope is the SEAT: its work is
      // what cannot proceed, and every other seat's work is unaffected.
      return {
        reason: subject.reason,
        authority: 'operator',
        scope: { kind: 'participant', participantId: subject.participant },
      }
    case 'advisor_escalated':
      // The advisor has already used up its own authority by asking. Scope is the conclave
      // because what stops is the admission of new work: at N=1 there is no admission queue
      // distinct from the conclave, which is the identity D1 is about.
      return { reason: subject.reason, authority: 'operator', scope: { kind: 'conclave' } }
    case 'operator_requested':
      // A suspension, not an escalation: the operator stopped the conclave and the operator
      // is the only one who can start it again.
      return { reason: subject.reason, authority: 'operator', scope: { kind: 'conclave' } }
  }
}
