# Concurrent implementers — merge of two independent designs

Two designs for #42 were produced at the same time and without contact: one by a conclave
session (Codex advisor, Claude implementer, working in `conclave-dogfood`), one by me. This
records what each got that the other did not, what they contradicted each other about, and
which parts are adopted.

`concurrent-implementers.md` is the session's document and is the detailed design. This file
is the decision layer over it — read that one for the model, this one for what changed and
why.

## Superseded first: pauses are not one thing

Both designs below treat the pause as a structure to *scope* — mine by adding a seat, the
session's by splitting `PauseReason` into a per-seat `SeatBlock`. Both are wrong in the same
way, and the correction came from the operator after reading them:

**Classify unresolved conditions by resolution authority, not by originating seat.**

`RunPause` conflates DETECTION of an unresolved condition with ESCALATION to the human. They
look like one thing only because the first operator happened to be a person.

```ts
type ResolutionAuthority = 'mechanical' | 'advisor' | 'operator'
```

`operator`, not `human`: it is a person interactively and an agent under `--operator agent`.
Naming it `human` bakes latency into an epistemic classification. The authority boundary is
identical in both modes; only the cost of crossing it differs — an interactive operator
suspends the run, an agent operator resolves synchronously and continues.

Of today's six reasons, `advisor_escalated`, `authority_conflict` and `operator_requested`
are operator authority; `implementer_unanswered` is the advisor's, because the advisor
authored the instruction being questioned; `turn_incomplete` is mechanical. Two of six are
handed to a human today that the advisor could answer — at N=1, now.

`operator_requested` is operator-directed but is not an escalation: it is an externally
requested suspension, and probably a distinct shape in the type even though it shares a
respondent.

**And authority is derived, not declared — the product already does this.** Supplying
`--checks` IS the operator pre-delegating rotation authority, by supplying the verification
method that makes the decision mechanical: `session.ts:472` says a degraded implementer
"escalates to you rather than being replaced" without it, and `relay.ts:1170` reports
`rotation: NOT ARMED (no checks configured)`. The same condition is `mechanical` when armed
and `operator` when not. So the authority is computed from configuration and evidence rather
than stored per reason.

That splits operator authority in two: **delegable** (rotation, once a verification method
exists) and **structurally non-delegable** (`authority_conflict`, where the information is
deliberately withheld from the advisor — no capability moves it).

Advisor-authority conditions need one bound: the advisor's answer is untrusted text like any
other, so a condition that recurs unresolved escalates on its second occurrence. Same rule as
the merge-conflict design.

**Consequence for the build order below.** Section 4 of "Where I had something the session
did not" said scope the pause first at N=1. That still holds, but the work is *split
`PauseReason` by resolution authority*, not *add a `seat` field* — adding `seat` would
fossilize the abstraction that needs removing. Everything below is preserved as written, and
should be read knowing this supersedes the pause treatment in both designs.

## The headline: both designs found the same fracture, from opposite ends

I led with it: **a pause today is a global quiescent point and concurrency destroys it.**
The round loop's own evidence string is `` `round ${round} of ${maxRounds}; no turn is in
flight` `` (`relay.ts:1818` region), and "no turn is in flight" is what makes a pause safe.
With N seats there is never such a moment, so `/continue` has no defined subject.

The session reached the same place from the other direction, arriving at splitting
`PauseReason` into a per-seat `SeatBlock` after its advisor pushed back on an earlier draft.
Two independent designs converging on the same structural break is the strongest signal
either of them produced, and it is worth more than either argument alone.

**Adopted: the session's naming (`SeatBlock` distinct from a run pause), my framing** — that
this is the load-bearing assumption of the operator interface rather than a detail, and that
the design should be organised around it rather than reaching it late.

## Where the session was right and I was wrong

**Worktrees would have silently destroyed attribution, not upgraded it.**

I claimed per-seat worktrees move attribution from elimination-based inference to
observation, and called it the strongest argument for the feature. That is wrong as stated.
`#treeAtOrigin` snapshots `dirtyPaths(this.#opts.cwd)` (`relay.ts:1400`) and
`#attributeArtifacts` (`:1493`) diffs against the same integration cwd. Seat writes inside a
separate worktree — especially under a gitignored `.conclave/`, which is exactly where I put
them — are **invisible to it entirely**.

So the upgrade is real but not free, and done naively the feature makes attribution strictly
worse in the worst way: silently. Attribution must become per-seat and read each seat's tree.
The session caught this, verified it against the code, and corrected its own earlier draft
that had made the same mistake I did.

**`RoleId` is already open, and the relay throws the role away.**

I wrote `role: string` into my `Task` type without checking. `RoleId` is already
`export type RoleId = string` (`registry/roles.ts:15`) and `ParticipantSpec` already carries
`role: RoleId` (`registry/types.ts:143`). `#join` reads `spec.agent` and never `spec.role`
(`relay.ts:665`) — the role arrives on every spec and is dropped at the one point it would
become run state.

That reframes the feature: "named roles" is not new type work, it is one missing property in
one object literal. And the session's argument for keeping `Rank` closed is correct and
better than anything I had — `Rank` is an **authority** ordering (`message.ts:9`), three
implementers are different in job and identical in authority, and widening it would force an
invented ordering among peers into the routing header that `envelope()` renders.

All verified independently before adoption.

## Where I had something the session did not

Four things, none of them in its document:

**1. Checks contend on machine-global resources and cannot be run N-up.** `npm test` in four
worktrees at once means four test runners, four `node_modules` resolutions, and direct
collision for anything binding a port or a fixture path. This project already learned this
about itself: `package.json` caps `--test-concurrency=4`, and `session.tty.test.ts:132-140`
records that raising a timeout was the *wrong* fix for contention and capping concurrency
was the right one.

**Adopted: checks are serialised across seats by default**, behind a run-scoped mutex, with
a `--check-concurrency` escape for suites known to be isolated. A seat waiting for the check
lane stays `assigned`, not blocked. Without this the per-seat checks the session designed are
correct in principle and unusable at N=4.

**2. Most seat blocks must go to the advisor, not the operator.** A blocked seat is work, not
a question for a human. The advisor holds the goal (`relay.ts:368`) and is the right party to
redirect or reassign; escalate to the human only when the advisor itself says `ESCALATE`
(`relay.ts:331`). N seats otherwise produce N times the interruptions and the feature is
unusable at N=4 however good the dispatcher is.

This composes with the session's conflict design rather than competing: it already routes a
merge conflict back to the seat as a new task. The same principle, one level up.

**3. The console should reuse the overflow pattern it already has.** `#pendingRows()` caps at
`MAX_PENDING_ROWS` and emits `"N more queued — /queue"` (`screen.ts:82`, `:356`). Seats get
the same treatment — show busy seats, cap, overflow to `/seats` — rather than a new
mechanism. The session hand-computed column budgets and flagged them as unmeasured; the cap
makes the exact threshold stop mattering.

One constraint neither document noted and I am adding: **the box's height now determines
`#floor`**, and `#resize()` pushes the transcript up when `#contentRow` falls below it. With
N seats that path runs constantly instead of rarely, and it has one unit test. It needs more
before this ships.

**4. Build order.** Neither the issue nor the session says what to build first. The issue is
right that "roles first, concurrency later" is wrong because the sequential half is the half
that does not matter — but that is an argument about *shipping*, not about *sequencing the
work*.

**Adopted: scope the pause first, at N=1.** It is a pure refactor with no behaviour change,
every existing test still applies, and it de-risks the part of the design that touches the
operator interface — the part most likely to be wrong and most expensive to get wrong. Then
dispatcher and queue at N=1 (still no behaviour change, still green), then worktrees, then
N>1. Nothing ships until the last step; the point is that each step is independently
verifiable.

## Where they conflicted

**Completion ordering.** The session's implementer proposed routing reports to the advisor in
task `seq` order rather than completion order, for reproducibility and to keep `resume`
meaningful. Its advisor overturned this, on the grounds that holding a finished report until
lower-`seq` tasks report makes every seat wait on the advisor — reintroducing the lockstep
the feature exists to remove.

**The advisor was right, and the resolution is better than either.** I had not considered
ordering at all, and would have shipped completion-order by default without noticing the
reproducibility cost. The session's final position — dispatch immediately, do not buffer for
a batched advisor turn — is adopted. The reproducibility concern is real but is answered by
the routing log recording admission order (`#seq` is one global counter stamped at record
time, `relay.ts:868`), not by delaying dispatch.

## What the session found that neither the issue nor I did

Kept from its document, all verified:

- **`#turnsTaken` counts every participant's turns and is what `breached()` reads.** N seats
  burn the turn ceiling N times faster in wall-clock terms, so every existing `--max-turns`
  means something different the day this ships. That belongs in a release note.
- **A maximum queue depth is required.** An advisor admitting tasks faster than they drain is
  a failure mode with no analogue today: a run that never ends while reporting healthy.
- **Linked worktrees have a Codex hook requirement** (`config/install.ts:333`), graded
  "observed, version-scoped" because the comment records CLI measurements rather than a
  protocol guarantee.
- **A clean-base rule**: refuse to start a concurrent run against a dirty tree, including
  untracked files. Its earlier draft proposed naming them without blocking; it corrected
  itself on the grounds that naming a file and then omitting it produces exactly the
  divergence the rule exists to prevent.
- **Seat id sanitisation** — operator-supplied ids are simultaneously a path traversal and a
  broken ref name.
- **A manifest with `baseSha` and `mergeState`**, so a crash leaves something better than a
  directory that may or may not be anyone's.
- **`SessionOptions` has `rounds` (`repl/session.ts:137`) but no `ceilings`**, and only the
  relay CLI constructs them (`bin/conclave.ts:996`) — the front-end parity gap the issue
  gestures at, located exactly.

## Honest note on the exercise

The session produced 1320 lines to my 200, and the difference is not verbosity: it verified
every citation it made, including re-reading sites when its advisor challenged them, and it
corrected itself twice in the document rather than quietly. I asserted several line numbers
from memory of greps and had one wrong (`run.ts:205`, actually `:204`).

It also caught a real error in my strongest claim. The two designs agreeing on the pause
fracture is worth more than either finding it alone — but the parts where they disagreed are
where the value was, and in three of the four disagreements the session was right.
