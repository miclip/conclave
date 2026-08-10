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

### The table above is the END STATE, not what the first commit does

Caught by an advisor mid-implementation, and it is a contradiction in this document rather
than a misreading of it.

D2 says `RunPause` exists only when an operator-authority request meets interactive latency,
and the table then classifies `turn_incomplete` as mechanical and armed `rotation_candidate`
as mechanical. **Both of those raise pauses today.** Implemented literally, the first commit
would silently delete two decision points an operator has now — which D1 forbids, and D1
outranks D2.

So the classification and the routing land separately:

- **#56 introduces the metadata only.** Compute authority and scope for all six reasons,
  record them, assert them, and leave every existing pause exactly where it is. A test
  asserts each of the six still produces the pause it produces today, so the metadata cannot
  quietly begin changing behaviour later without a failure.
- **Routing consequences are gated behind the work that makes them safe.** A `mechanical`
  classification is not permission to stop pausing: nothing in the control plane can yet
  RESOLVE `turn_incomplete`, and that promotion path is D3's work. Removing the pause before
  building the resolution does not make the condition mechanical — it drops it on the floor.
- The one DECLARED exception, `implementer_unanswered` routing to the advisor, is a routing
  change and lands with the routing work, not with the classification.

The general rule this is an instance of: **classifying a condition is not the same as acting
on the classification**, and the design's tables describe where it is going rather than what
any one commit should do.

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

## D9b. A reviewer seat, because the advisor cannot see the code

The advisor judges from reports — it cannot see the implementer's tools, by design. So it
catches reasoning errors and reported errors, and cannot catch an error the implementer never
mentions. That bound is real and no amount of advisor capability removes it.

Concurrent seats remove it, because a seat can be given the role of reading what another seat
WROTE rather than what it said. This is a better argument for the feature than the throughput
one #42 leads with: it converts a class of undetectable error into a detectable one.

**The load-bearing condition: the reviewer reads the diff and the tree, never the producer's
summary.** A reviewer fed the producer's report inherits exactly the defect it exists to
catch. Observed in dogfooding: an implementer produced correct, well-covered code and
reported a test failure in a script that does not exist, in a suite that was clean. The code
was right and the story about it was wrong, and only reading the tree distinguishes those.

**It slots into the merge boundary already designed in D6**, and needs no new machinery: seat
completes, checks run in its own tree, review runs against the diff, then merge to integration.
A rejection becomes a new task with `parent` set, assigned back to the producing seat —
identical to the conflict handling D6 already specifies. The reviewer never needs write access.

**Rank `implementer`, role `reviewer`.** This is what D5's split is for. A reviewer must not
outrank a producer: its rejection creates WORK, which the dispatcher admits, and authority
stays with the advisor. If review required widening `Rank`, the model would be wrong.

**It does not replace human review.** It is a gate before one, and it changes what reaches a
human: a diff that has already been read by something that cannot be fooled by its author's
description of it.

### Consequence for cost

It inverts the obvious allocation. Review is read-heavy but BOUNDED — one diff — where
production is unbounded. So the frontier spend belongs on the reviewer rather than the
advisor: same money, but positioned where it can see the code instead of only the story about
the code.

    advisor      mid-tier; judgement-heavy, low token volume
    producers    cheap, numerous, high token volume
    reviewer     frontier; bounded input, gates the merge

Unmeasured, and it stays that way until #71 records which model a seat ran.

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
