# Concurrent implementers — final design decisions

The authoritative record for #42. Two designs were written independently and then corrected
three times in discussion; this is what survived. The inputs are kept alongside it:

- `concurrent-implementers.md` — the conclave session's design (Codex advisor, Claude
  implementer). The detailed model: task records, worktree lifecycle, change inventory.
- `concurrent-implementers-independent.md` — mine, written at the same time without contact.
- `concurrent-implementers-merge.md` — what was adopted from each and why, with the
  corrections layered in the order they arrived.

Read this file for what was decided. Read those for how it was arrived at.

---

## D1. One advisor and one implementer stays the default

Adding seats brings new arguments and nothing else. Someone who wants one implementer must
not pay for a feature they did not ask for.

**N=1 is the identity case of every new abstraction, not a special case.** If an abstraction
needs an `if (seats.length === 1)` branch, it is the wrong abstraction.

- a seat's tree at N=1 IS the operator's cwd; branch is the current branch; merge is a no-op
- the task queue at N=1 with one seat dispatching serially IS the round loop
- blocking scope at N=1 — `participant`, `workstream`, `conclave` all denote the same set

Enforced by a `DEFAULT_UNCHANGED` guard, not by intention. Divergence is allowed and must be
DECLARED with a reason, the same inversion `frontEndParity.test.ts:20` uses and for the same
reason — nine capabilities had diverged silently before that guard existed.

Gated on N>1, never shipped with the feature: worktrees, the clean-base rule, mandatory
ceilings, seat ids other than `implementer`.

**One declared exception:** authority routing sends `implementer_unanswered` to the advisor
before the operator, so a default run interrupts the human less than today.

## D2. Unresolved conditions have two orthogonal axes

`RunPause` conflates DETECTION of an unresolved condition with ESCALATION to a human. They
look like one thing only because the first operator happened to be a person.

```ts
type ResolutionRequest = {
  reason: ResolutionReason
  authority: 'mechanical' | 'advisor' | 'operator'
  scope:
    | { kind: 'participant'; participantId: string }
    | { kind: 'workstream'; workstreamId: string }
    | { kind: 'conclave' }
}
```

**Authority answers who can resolve it. Scope answers what it stops.** Seat identity lives on
the second axis; putting it on the first was the error in both original designs.

`operator`, not `human`: it is a person interactively and an agent under `--operator agent`.
Naming it `human` bakes latency into an epistemic classification. The authority boundary is
the same in both modes; only the cost of crossing it differs.

| authority | interactive operator | agent operator |
| --- | --- | --- |
| `mechanical` | resolve | resolve |
| `advisor` | ask the advisor | ask the advisor |
| `operator` | suspend the scope | synchronous call, continue |

**Rule: block the smallest scope whose continuation would require making the unresolved
decision.**

`RunPause` becomes an EFFECT — what an operator-authority request looks like against
interactive latency — rather than the model.

### Today's six reasons

| reason | authority | scope |
| --- | --- | --- |
| `advisor_escalated` | operator | admission of new tasks; in-flight seats drain |
| `authority_conflict` | operator | affected workstream |
| `operator_requested` | operator | conclave — a suspension, not an escalation |
| `implementer_unanswered` | advisor | that participant |
| `turn_incomplete` | mechanical | that participant |
| `rotation_candidate` | derived (D3) | that participant |

### Both axes are derived, not declared

**Authority** is computed from configuration and evidence. The product already does this:
`--checks` IS the operator pre-delegating rotation authority by supplying the verification
method that makes the decision mechanical — `session.ts:472` says a degraded implementer
"escalates to you rather than being replaced" without it, and `relay.ts:1170` reports
`rotation: NOT ARMED (no checks configured)`.

**Scope** is computed from the task graph: `dependsOn` makes blast radius the transitive
closure of a blocked task's dependents. Dependencies alone are insufficient, because
contention is discovered at MERGE time — two seats with no declared edge can still collide.
Scope must trace artifacts as well, which is what `#attributeArtifacts` is for.

### Bounds

- Advisor-authority conditions escalate to operator authority on the **second unresolved
  recurrence**. The advisor's answer is untrusted text like any other.
- Operator authority splits into **delegable** (rotation, once armed) and **structurally
  non-delegable** (`authority_conflict`, where the information is deliberately withheld from
  the advisor — no capability moves it).

## D3. The global stop becomes emergent and must be detected

A waits on the advisor, the advisor waits on the operator, the operator is asleep. Nothing in
D2 notices, and N independent waits each look like healthy waiting.

The system must detect that the blocked set covers everything that could progress and report
**one** global stop. This is the failure this project keeps finding in itself: a true state
that does not carry the fact which would resolve it.

The queue-depth ceiling gains a second job: bound outstanding resolution requests, not just
queued tasks.

## D4. The round loop becomes a dispatcher over a task queue

Not because the advisor is a bottleneck — #42's own correction is right that a single-threaded
advisor is fine — but because `for (let round = 1; round <= maxRounds; round++)`
(`relay.ts:1818`) gives every seat exactly one turn per round, so a seat finishing in 30
seconds waits on one taking 20 minutes.

Immutable `Task` records plus per-seat mutable execution state, both owned solely by `Relay`.
The advisor PROPOSES tasks; the dispatcher validates and admits. Advisor replies parse into
assignment decisions and **fail closed** — a reply that does not parse cleanly is treated as
an empty instruction is treated today.

`#exchange` (`relay.ts:1193`) survives unchanged and is why this is tractable: N concurrent
seats are N concurrent `#exchange` calls. The adapter seam is untouched — concurrency belongs
above it.

**Reports dispatch immediately; they are not buffered into admission order.** Buffering a
finished report until lower-`seq` tasks report reintroduces the lockstep the feature exists to
remove. Reproducibility is served by the routing log recording admission order (`#seq` is one
global counter stamped at record time, `relay.ts:868`), not by delaying dispatch.

A seat is free when its turn ended **and** its verdict is graded — a `timed_out (uncertain)`
seat must not be handed more work.

## D5. Rank stays closed; role is already open and is being thrown away

#42's premise that this is blocked on the rank type is wrong in both directions.

- `RoleId` is already `export type RoleId = string` (`registry/roles.ts:15`)
- `ParticipantSpec` already carries `role: RoleId` (`registry/types.ts:143`)
- `#join` reads `spec.agent` and never `spec.role` (`relay.ts:665`)

Named roles is one missing property in one object literal. `Rank`
(`'human' | 'advisor' | 'implementer'`, `message.ts:9`) is an **authority** ordering feeding
`outranks()`; three implementers are different in job and identical in authority. Widening it
would force an invented ordering among peers into the routing header `envelope()` renders.

## D6. Worktrees are enforced at N>1, and they do not upgrade attribution for free

One tree per seat, created by the dispatcher, seat launched with `cwd` set to it — enforcement
by construction rather than by a sentence in a briefing that `worktreePaths()`
(`subagents.ts:68`) can only observe afterwards.

```
.conclave/worktrees/<run-id>/<seat-id>     branch: conclave/<run-id>/<seat-id>
```

Seat ids are operator-supplied and must be sanitised: an unsanitised id is a path traversal
and a broken ref name at once. A manifest records `baseSha` and `mergeState` per seat so a
crash leaves something better than a directory that may or may not be anyone's.

**Attribution must become per-seat or worktrees silently destroy it.** `#treeAtOrigin`
(`relay.ts:1400`) and `#attributeArtifacts` (`:1493`) both diff against `this.#opts.cwd`, so
seat writes in a separate tree are invisible to them.

Integration is the dispatcher's job. A merge conflict is a **new task** assigned back to the
seat that produced it, not a pause; a second failure on the same parent escalates, because
that is the shape of a real disagreement.

A **clean-base rule** refuses to start a concurrent run against a dirty tree, untracked files
included: naming a file and then omitting it produces exactly the divergence the rule exists
to prevent.

## D7. Checks are per-seat and serialised across seats

Per-seat checks in the seat's own tree are correct — a rotation candidate is verified against
that seat's work. But checks contend on machine-global resources: four `npm test` runs mean
four test runners and direct collision for anything binding a port.

This project already learned it about its own suite — `--test-concurrency=4` in
`package.json`, and the recorded note that raising a timeout was the wrong fix for contention
and capping concurrency was the right one.

**Serialised across seats by default**, behind a run-scoped mutex, with `--check-concurrency`
for suites known to be isolated. A seat waiting for the check lane is `assigned`, not blocked.

`rotate()` (`rotation/rotate.ts:171`) gains a root parameter; the plumbing exists —
`record.ts:139` and `:160` already `spawnSync` with `cwd: root`.

### D7a. Per-seat checks are not enough: the integration tree needs its own station (#80)

Added after the first real two-seat run, which is the only reason it is stated as an amendment
rather than as part of D7: three tasks merged with no git conflict at all and the resulting
tree failed two tests. Both failures were cross-seat. Each seat's work was correct, each
seat's own tree was green, every merge was clean, and the result was broken.

D7 is right about what it covers and blind past it. Per-seat checks verify a rotation
candidate against that seat's work, in that seat's tree — which is exactly why every seat can
pass while the tree they produce together fails. D6 designs the merge boundary around
*textual* conflict, which git reports. **Concurrency creates a class of conflict git cannot
see, and no station in the design was positioned to catch it.**

So the **already-configured** `--checks` run against the **integration checkout, after every
merge including the last**. A separate option was built first and then removed: the argument
against reusing `rotation.checks` — that it changes what an existing configuration does, how
often those commands run and what a failure means — is true and was overruled, because an
opt-in station leaves exactly the run that failed unprotected unless someone discovers the new
flag and duplicates configuration they have already supplied. An operator who has said
`--checks "npm test"` has already said what "working" means for this project; asking them to
say it twice is a second chance to say it zero times.

The cost is recorded rather than argued away: at N>1 those commands now run once per merge as
well as at a rotation, and a failure means one of two things depending on where it happened.
At N=1 nothing changes, and not by a seat-count branch — there is no merge, so the boundary
this runs in is not reached.

Two things follow that D6's conflict rule cannot supply:

- **Neither seat is at fault**, so "assign the repair to the producing seat" has no answer.
  The failure belongs to the *pair*, so the repair names **both contributing tasks**, no seat
  is marked, and which seat takes it is the advisor's decision — it is the only participant
  that can see both halves.
- **The final merge has no seat left to repair it.** While a seat is still working the failure
  is self-limiting: the first run recovered only because a seat happened to still be active in
  a tree someone else's merge had just broken, which is luck of timing rather than a mechanism.
  When the last merge lands and nothing is left working, a queued task is a task nobody will
  take — so a red tree at the end is an **outcome the run reports** (`integration_failed`, and
  a non-zero exit), never a task it queues.

This does not replace the argument for #72's reviewer seat; it sharpens it. A reviewer reading
the *integrated* diff is the only station that can catch a defect that exists in neither half
before the checks do. This one catches it after, mechanically, which is what a run with nobody
watching needs.

### D7b. The contention D7 serialises against does not exist, and the flag was withdrawn (#64)

Appended rather than rewritten, for the reason D7a is: what was decided is evidence, and a
decision record that quietly loses its own errors stops being one.

**D7's premise is false in this codebase.** It reasons that `npm test` in four worktrees means
four test runners contending for the machine. But both check runners are `spawnSync` —
`runCheck` in `src/rotation/record.ts` and `runIntegrationChecks` in `src/relay/integrate.ts` —
in the one orchestrator process. A synchronous spawn blocks the process for the whole command,
so there is never more than one check running: **serialisation is already guaranteed by the
call, not by any mutex.** It is narrower still, because the two stations cannot be live at the
same time — there is no merge boundary at N=1, and `rotateImplementer` refuses at N>1.

So of D7's three asks, one was already true and two are not built:

- `--check-concurrency` — **built and removed before shipping.** A control that is accepted and
  plumbed and cannot have an effect is worse than an absent one: someone sets it and believes
  something changed.
- "a seat waiting for the check lane is `assigned`" — **not built.** No production path
  constructs a waiting seat, and a `SchedulerState` value for a state nothing reaches was
  reverted along with the test that manufactured one in order to observe it.
- the run-scoped mutex itself — **kept, inert, and unit-tested** (`src/relay/checkLane.ts`).
  One slot, not configurable, wrapping each station once at its outermost point. It is retained
  as the mechanism that will make **per-seat rotation (#78)** safe, where the hazard is not CPU
  contention but a merge moving the tree between a rotation's two captures and being reported
  as `repository_diverged`. Building an asynchronous runner so the lane had something to
  serialise today would be building the problem in order to keep the solution.

The operator's own note on filing it: this is the third goal on this branch — with #60's
detector and parts of #61 — whose acceptance criteria named states the code cannot reach. The
correction is to ask whether a production path constructs the state *before* writing the
criterion.

## D8. Ceilings change meaning and stop being optional at N>1

`#turnsTaken` counts every participant's turns and is what `breached()` reads. N seats burn
the turn ceiling N times faster in wall-clock terms, so **every existing `--max-turns` means
something different the day this ships** — a release note, not a changelog line.

`maxRounds` (`relay.ts:188`) no longer describes the structure. It is reinterpreted as a bound
on advisor turns and renamed rather than quietly redefined.

`SessionOptions` has `rounds` (`repl/session.ts:137`) but no `ceilings`, and only the relay CLI
constructs them (`bin/conclave.ts:996`). That parity gap must close before N>1 ships on either
front-end.

New ceilings: **maximum concurrent seats**, **maximum queue depth**, **maximum outstanding
resolution requests** (D3).

## D9. Console and status

`status --json` needs little: `SessionRecord.participants` is already an array
(`sessionRecord.ts:147`) and `seats()` already maps over `relay.participants` (`:609`). Add
per-seat task, worktree and scheduler state.

The console is the constrained surface. Reuse the overflow pattern already there —
`#pendingRows()` caps at `MAX_PENDING_ROWS` and emits an overflow line (`screen.ts:82`,
`:356`) — rather than a hand-computed column budget. Show busy seats, cap, overflow to
`/seats`.

One constraint from the descending box: the box's height determines `#floor`, and `#resize()`
pushes the transcript up when `#contentRow` falls below it. With N seats that path runs
constantly instead of rarely, and it has one unit test.

### D9b. A reviewer seat: rank `implementer`, role `reviewer`, dispatched like `merge_resolution` (#72)

Appended rather than folded into D5/D6, for the reason D7a and D7b are: what was decided is
evidence, and #72's own comment thread corrected itself twice before landing here — first
proposing review as a generic role slotted into the merge boundary, then a mandatory pipeline
stage, before settling on the shape below. The corrections are worth keeping visible.

**`--reviewer` is a first-class named seat, not a generic role.** Rank `implementer`, role
`reviewer` — D5's job/authority split is exactly what makes this legal: identical authority to
every implementer seat, a different job. Naming it rather than leaving it an arbitrary role
string is what lets the advisor's briefing teach anything about it at all; a role the operator
might not have used cannot appear in fixed prose.

**No reviewer declared, no review.** `RelayOptions.reviewer` is optional and singular. Absent,
no `reviewer` key reaches `Relay.start`, no review task is ever admitted, and the merge
boundary runs exactly as D6 already specifies — proved as a `DEFAULT_UNCHANGED` guard entry
the same way every other opt-in surface is.

**Review is a task purpose, dispatched through the existing scheduler — never a hook the
boundary calls.** Two new `TaskPurpose` values, `review` and `review_resolution`, admitted
through the same `#admit` every other task is, and two new `SchedulerState` values,
`review_pending` and `review_blocked`, gating dispatch through `canTake` exactly as
`merge_blocked`/`merge_resolution` already do. Concretely: once a task purpose `work` or
`review_resolution` clears grading, and this run has a reviewer, its boundary crossing
(`#crossBoundary`) is DEFERRED rather than skipped — the producing seat moves to
`review_pending`, and a `review` task is admitted, targeted at the reviewer's role. The
boundary itself is unmodified code, called later, from the review's own resolution rather than
from the completion that triggered it.

**The reviewer's context is built the way a rotation handoff's mechanical half is — never from
the producing seat's report.** `rotation/review.ts` reuses `capture()` from `record.ts`
outright: the same file-digest-and-check capture rotation already takes independently of any
participant's account of its own work, with one addition rotation never needed — an actual
diff, because a replacement reproduces a STATE and a reviewer judges a CHANGE. The advisor's
instruction to the producing seat is included; that seat's own report is not, and nothing in
the reviewer's prompt has room for one.

**Rejection is a child task, `parent` set, assigned back to the producing seat — by the relay,
not by the advisor.** Unlike a merge conflict, which the advisor must address by name because
D4 says the advisor proposes and the dispatcher only validates, a review verdict is not
something any advisor instruction produced — it arrives from a task the relay itself admitted.
So the repair is admitted the same way: automatically, targeted `{kind: 'seat', seat:
producingSeatId}`, purpose `review_resolution`, `Task.parent` naming the IMMEDIATE task it
repairs. The advisor sees both the rejection and the repair as ordinary reports; it is told
this happens automatically (`REVIEWER_BRIEFING_FOR_ADVISOR`, appended to `LEAD_BRIEFING`
exactly the way `MULTI_SEAT_BRIEFING` is — only when a reviewer exists) so a report from the
reviewer is not mistaken for one from an implementer.

**A second rejection of the same work escalates rather than repairing a third time.** No
counter, no second Map: a `review_resolution` task whose OWN `parent` is itself a
`review_resolution` task is the second rejection, read directly off `parent.purpose` at
resolution time. It raises a new `PauseReason`, `review_blocked`, classified in
`resolution.ts` identically to `merge_blocked` — operator authority, scope the seat, not the
conclave.

**Rank stays closed at three.** Nothing here widens `'human' | 'advisor' | 'implementer'`; a
reviewer's authority is a producer's authority, and its rejection creates work rather than
outranking anyone.

**One casualty, declared rather than discovered.** `#implementers()` used to read `rank`; every
caller meant `role`, and the two coincided until a reviewer could be rank `implementer` with a
different job. It now reads `role`, and `#dispatchSeats()` (rank-based) is the new accessor for
the one caller that genuinely wants every seat the scheduler may address — `#seatState`
construction, which must include the reviewer. At N=1 with no reviewer the two answer the same
set, so the default run is unaffected; see `DECLARED['--reviewer on both front-ends, and the
review_blocked pause reason']` in `defaultUnchanged.test.ts`.

## D10. One branch, no incremental merges to main

All of it lands on a single long-lived branch, `concurrent-implementers`. Nothing merges to
main until the whole feature is done, so main never carries a half-built dispatcher or a
`ResolutionRequest` with one populated axis.

This design record and its inputs stay on main — they are a record, not feature code, and the
issues reference them.

Two consequences worth planning for rather than discovering:

- **The branch will drift.** Main is active — releases, bug reports from live sessions. The
  branch rebases onto main at each numbered step below rather than at the end, because a
  single reconciliation across eleven steps of `relay.ts` changes is how a feature branch dies.
- **The steps stay separately verifiable anyway.** Each is its own commit with the suite green
  at that commit. "One branch" is about what main sees, not about giving up the ability to
  bisect.

## Build order

Each step is independently verifiable and none ships the feature until the last.

1. `DEFAULT_UNCHANGED` guard — first, so everything after it is protected
2. Resolution authority + blocking scope, at N=1 where both axes have one trivial value
3. Carry `spec.role` through `#join`
4. Dispatcher + task queue at N=1 — behaviourally the round loop
5. Ceiling accounting and the front-end parity gap
6. Emergent global stop detection
7. Per-seat worktrees, manifest, clean-base rule
8. Per-seat attribution
9. N>1: seats, CLI, dispatch
10. Per-seat checks and rotation
11. Console and status for N seats
