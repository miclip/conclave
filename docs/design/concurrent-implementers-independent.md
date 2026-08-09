# Concurrent implementers — my design

Grounded in the code as it stands at `cf9ec3f`. Every claim about today's behaviour cites
`file:line`; claims about how a CLI will behave are graded.

## 0. The thing the issue gets wrong

The issue names the round loop as the obstacle and the task queue as the fix. That is right
as far as it goes, and it is not the hard part.

The hard part is the **pause**, and the issue does not mention it once.

A pause today is a global quiescent point. `relay.ts:1818`'s loop checks for one at the top
of each round, and the evidence string it writes is literally:

```ts
evidence: [`round ${round} of ${maxRounds}; no turn is in flight`]
```

"No turn is in flight" is what makes a pause safe. It is why `#exchange` has no timeout of
its own — the comment at `relay.ts:1819-1820` says a run "cannot be interrupted mid-turn
without discarding that turn's work". Every pause reason in `run.ts:38-86`, every option in
`PauseOption` (`continue | wait | rotate | constrain | abort`), and the whole of
`RunHandle.pauseAt()` at `run.ts:360` assume a single suspended world that one decision
resumes.

**With N concurrent seats there is never a moment when no turn is in flight.** That is not a
detail to fix later; it is the load-bearing assumption of the operator interface. A design
that replaces rounds with a queue and leaves `RunHandle` alone produces a system where the
operator is asked a question with no defined scope: `/continue` continues *what*?

So the design below is organised around the pause, and the queue falls out of it.

## 1. What replaces the round loop

**A task is the unit; a seat is the worker; the dispatcher is code.** Agreed with the issue,
and agreed with its own correction that lockstep — not advisor throughput — is the reason.

```ts
type TaskId = string           // monotonic, per run
type SeatId = string           // operator-named: 'api', 'ui', 'ui-2'

interface Task {
  id: TaskId
  role: string                 // which role may take it; seats declare roles
  text: string                 // the instruction, as the advisor wrote it
  assignedTo?: SeatId
  state: 'queued' | 'assigned' | 'reporting' | 'done' | 'failed' | 'blocked'
  /** Set when the task exists BECAUSE another failed — a conflict, a check, a rejection. */
  parent?: TaskId
  /** The seat's report, once it has one. Provenance as per the existing verdict model. */
  outcome?: TurnVerdict
}
```

The queue lives on the `Relay` instance, not on a seat and not in a file: it is run-scoped
state exactly like `#turnsTaken` and `#pauseRequested` (`relay.ts:583`). **Only the
dispatcher mutates it.** The advisor *proposes* tasks by emitting them in its reply; the
dispatcher parses, validates the role exists, and enqueues. This matters because the advisor
is an untrusted text source — the codebase already treats it that way, which is why
`NOTE:` lines are lifted out of replies before routing (`relay.ts:1846` region).

`Relay.run()` stops being `for (let round...)` and becomes:

```
while (not stopped, not ceilinged, queue or seats non-empty):
  await Promise.race(seats.map(s => s.idle))     // any seat free
  for each free seat: assign the highest task matching its role
  if no task matches and all seats idle: ask the advisor for more work (one #exchange)
```

`#exchange` at `relay.ts:1193` **survives unchanged** and is the reason this is tractable:
it already models one prompt-to-turn-end against one participant. N concurrent seats are N
concurrent `#exchange` calls. What changes is the caller, not the primitive.

## 2. How the dispatcher learns a seat is free

From `turn_end`, which is what `#exchange` already resolves on. No new adapter surface is
required, and that is the single most important compatibility fact in this design: the
adapter seam (`events()` provisional, `snapshot()` canonical) is untouched.

The subtlety is that "free" is not "turn ended". A seat is free when its turn ended **and**
its verdict has been graded, because a `timed_out (uncertain)` seat must not be handed more
work — that is the case `liveness.ts` exists to disambiguate, and `describeLiveness()` at
`liveness.ts:121` is explicitly phrased as measurement rather than verdict. So:

```
turn_end -> grade verdict -> if completed: seat is free
                          -> if degraded/uncertain: seat is BLOCKED, raise a seat pause
```

`sampleLiveness()` already takes a pid and returns samples. With N seats it is called per
seat, which is fine — it is three `ps` calls 400ms apart (`liveness.ts:99-113`).

## 3. The pause becomes scoped, and mostly stops involving the operator

This is the core of my design.

**`RunPause` gains a `seat: SeatId | 'run'` field.** A seat pause suspends that seat only;
the other seats keep working. A run pause is what exists today and is reserved for ceilings,
operator request, and abort.

`RunHandle` needs three changes:

- `#pause: RunPause | undefined` (`run.ts:204`) becomes `#pauses: Map<SeatId, RunPause>`
- `continue()`, `rotateImplementer()`, `injectConstraint()` take a `SeatId`
- `untilPause()` (`run.ts:250`) yields the *next* pause on any seat, so an agent-operator
  driving this is woken per decision rather than per run

`#waitMemory` (`run.ts:220`) and `#verdictKey(v: {participant, endSeq})` (`run.ts:226`)
**already key by participant** and generalise for free. That is a genuine piece of luck
from #49's design and worth saying out loud.

**The important move: most seat pauses should not reach the operator at all.** A blocked
seat is a *task* for the advisor, not a question for the human. The advisor holds the goal
(`relay.ts:368`) and is the right party to decide whether a blocked seat should be
redirected, have its work reassigned, or wait. Escalate to the human only when the advisor
itself escalates — which the briefing already has a word for (`ESCALATE`, `relay.ts:331`).

Without this, N seats produce N times the interruptions and the feature is unusable at
N=4 regardless of how good the dispatcher is.

## 4. Worktrees

**Enforced, created by the dispatcher, never by the seat.** A seat is launched with `cwd`
set to its own tree, so it cannot write to the shared one by construction rather than by
instruction. This is strictly better than the current arrangement, where the briefing *asks*
(`relay.ts:523`) and `worktreePaths()` (`subagents.ts:68`) can only observe afterwards —
its own doc comment concedes it "cannot be ENFORCED from here".

```
.conclave/trees/<session-id>/<seat-id>        branch: conclave/<session-id>/<seat-id>
```

Under `.conclave/`, which is already gitignored in test fixtures (`session.tty.test.ts:79`)
and is where session state lives.

**Attribution changes class, and this is the strongest argument for the whole feature.**
Today attribution is elimination-based inference and `authority.ts` documents the limit
(#8): the repository cannot distinguish a write by one actor from a write by another. With
one tree per seat, "who changed this file" is answered by *which tree it changed in* — an
observation, not an inference. The evidence grade for per-seat attribution moves from
`reasoned_but_unverified` to `observed`. The issue says worktrees make attribution "better";
it is worth being precise that they make it a different kind of claim.

**Integration is the dispatcher's job, not a seat's.** On task completion:

```
merge seat branch -> integration branch (conclave/<session-id>/integration)
  clean          -> task done
  conflict       -> a NEW task, parent = the completed one, assigned back to the same seat,
                    text names the conflicting paths and the other seat's commit
```

A conflict is work, and the seat that just touched the code is the cheapest party to resolve
it. It is not a pause, and not the operator's problem. Only a *second* failure on the same
parent escalates — that is the shape that means the two seats genuinely disagree about the
design, which is exactly when a human should be told.

**Cleanup:** trees are removed on run end, and `git worktree prune` is run at run start.
A tree whose branch has unmerged commits is **kept** and named in the run report — deleting
work because a run ended badly is unrecoverable, and `SessionRecorder` already exists to
carry that kind of fact forward.

## 5. Checks and rotation per seat

Per-seat checks in the seat's own tree are correct and better than today, as the issue says.
One thing the issue misses:

**Checks contend on machine-global resources and cannot simply be run N-up.** `npm test` in
four worktrees at once means four `node_modules` resolutions, four test runners, and — for
anything that binds a port or a fixture directory — direct collision. This project's own
suite caps concurrency for exactly this reason: `"test": "... --test-concurrency=4"` in
`package.json`, and `session.tty.test.ts:132-140` records that raising a timeout was the
*wrong* fix for contention and capping concurrency was the right one.

So: **checks are serialised across seats by default** behind a run-scoped mutex, with a
`--check-concurrency` escape for suites known to be isolated. A seat waiting for the check
lane is still `assigned`, not blocked.

`rotate()` (`rotation/rotate.ts:171`) already takes `checks: CheckSpec[]`. It needs a root
parameter: `record.ts:139` and `:160` use `spawnSync` with `cwd: root`, so the plumbing
exists and the call site must pass the seat's tree instead of the run's cwd. Rotation
becomes per-seat by construction, and a rotation candidate is verified against that seat's
work — which is a real correctness gain, not just tidiness.

## 6. Console and `status --json`

**`status --json` needs almost nothing.** `SessionRecord.participants` is already an array
(`sessionRecord.ts:147`) and `seats()` already maps over `relay.participants`
(`sessionRecord.ts:609`). Add per-seat `task`, `worktree`, and `pause` fields. An agent
operator polling `conclave status --json` gets N seats without a shape change.

**The console is the constrained one.** The status is inlaid into the top rule — one line
(`session.tty.test.ts` asserts the status appears there and nowhere else). Four seats need
four status lines, and every line spent on the box is a line not spent on the transcript,
which matters more now that the box descends and anchors.

Reuse the pattern that already exists rather than inventing one: `#pendingRows()` caps at
`MAX_PENDING_ROWS` and emits `"N more queued — /queue"` as an overflow line. Do the same for
seats — show busy seats, cap the list, overflow to `/seats`. The box already grows and
shrinks with its contents (`#resize(this.#base + queued.length + menuRows.length - 1)`), so
the mechanism is there.

One new constraint from today's work: the box's height changing now moves `#floor`, and
`#resize()` pushes the transcript up when `#contentRow` would be below the new floor. With N
seats the box height changes far more often than it does today. That path is exercised by
one unit test; it needs more before this ships.

## 7. Types that cannot survive unchanged

| Today | Change | Why |
|---|---|---|
| `RelayOptions.implementer: ParticipantSpec` (`relay.ts:186`) | `implementers: SeatSpec[]` | breaking; every caller and both front-ends |
| `maxRounds` (`relay.ts:188`) | delete | meaningless without rounds; `ceilings` replaces it and stops being optional |
| `for (let round...)` (`relay.ts:1818`) | dispatcher loop | the change |
| `RunPause` (`run.ts:150`) | `+ seat` | pause scope |
| `RunHandle.continue()` / `rotateImplementer()` / `injectConstraint()` | take a `SeatId` | a decision needs a subject |
| `RunHandle.#pause` (`run.ts:204`) | `Map<SeatId, RunPause>` | N seats pause independently |
| `rotate()` (`rotation/rotate.ts:171`) | `+ root` | verify in the seat's tree |
| `worktreePaths()` (`subagents.ts:68`) | keep, repurpose | observation becomes verification of an enforced rule |

Survives unchanged, and is why this is buildable: `#exchange` (`relay.ts:1193`), the whole
adapter seam, `sampleLiveness()`, `#waitMemory`/`#verdictKey`, `SessionRecorder`.

## 8. What I would build first

Not "roles first, concurrency later" — the issue is right that the sequential half is the
half that does not matter. But the **pause scope** can and should land first, on ONE
implementer, where it is a pure refactor with no behaviour change and every existing test
still applies. That de-risks the part of this design that touches the operator interface,
which is the part most likely to be wrong.

Then: dispatcher + queue at N=1 (still no behaviour change, still all tests green), then
worktrees, then N>1.

## 9. Evidence grades

- **observed**: everything cited with `file:line`.
- **reasoned_but_unverified**: that check contention is the binding constraint at N=4. It is
  inferred from this project's own concurrency cap, not measured for concurrent worktrees.
- **reasoned_but_unverified**: that most seat pauses can be handled by the advisor without
  reaching the operator. This is a claim about how well an advisor CLI handles a dispatch
  role it has never been given, and it is the single assumption most likely to be wrong.
- **unsupported, flagged**: that four concurrent CLIs on one machine are affordable in tokens
  and in RAM. Nobody has run it. A 7.5-hour session at N=1 is the only datapoint we have.
