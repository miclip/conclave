# Concurrent implementers

A design note for running more than one implementer at a time. Nothing here is built. This
records what the constraint actually is, what an earlier reading of it got wrong, the task
model that would replace the round loop, and the worktree and integration lifecycle the
seats would run under.

---

## Decision and corrections

**Lockstep is the constraint, not advisor throughput.**

The reason rounds advance one at a time is structural, not a capacity limit on the advisor.
`#runLoop` (`src/relay/relay.ts:1789`) is a `for` loop over a round counter, and each
iteration contains exactly one advisor turn followed by exactly one implementer turn, each
awaited before the next begins. Nothing in that loop is waiting on the advisor being busy.
It is waiting because the next thing to do is not known until the previous thing has
returned: the advisor's reply *is* the instruction, and the implementer's report *is* the
advisor's next input. A second implementer would not be blocked by an overloaded advisor.
It would be blocked because the loop has one variable — `next` — holding the one reply the
one round is built around.

This matters because it points at a different fix. If the advisor were the bottleneck, the
answer would be batching, or a second advisor, or making advisor turns cheaper. None of
those help. The answer is to stop treating "a round" as the unit of scheduling and make the
unit a **task**, dispatched when its inputs are ready rather than when its turn in the
sequence comes up.

**Correction: the seats are not a general participant collection.**

An earlier reading of `#participants` — a `Map`, iterated by `get participants()` — took it
for an already-general N-seat structure that concurrency could just fill up. It is not.
`RelayOptions` (`src/relay/relay.ts:151`) declares two named, singular fields, `lead` and
`implementer` (`:185`–`:186`), not a list. `Relay.start` (`src/relay/relay.ts:599`) joins
exactly those two, in that order and deliberately sequentially, then hands exactly that
pair to `acquire()` as the run's claim on the working directory. `#runLoop` recovers them
with two `find`s by rank and asserts both non-null. The `Map` is a lookup keyed by id, not
an open roster. Adding a seat is a change to the options type, the startup path, the
directory claim, and every `find(p => p.rank === 'implementer')` — not a matter of pushing
another entry in.

**Correction: seat identity is already stateful, and that state is per-seat, not per-task.**

`RelayParticipant` (`src/relay/relay.ts:75`) carries `session`, `events`,
`baselineGeneration`, and `degradationCursor`. Those exist because rotation replaces the
session while keeping the seat: the cursor is what stops a replacement from being judged
against its predecessor's compaction events. So a seat is already a durable thing with a
history, distinct from the work passing through it. The concurrency model should keep that
split rather than inventing a new one — the task is what varies, the seat is what persists.

**Correction: "concurrent implementers" is not free of the ceiling.**

`#turnsTaken` is documented at `src/relay/relay.ts:577` as turns across *all* participants,
and it is what `breached()` counts. Two implementers do not run a fixed budget twice as
fast in wall-clock terms and leave the turn count alone; they burn the turn ceiling at
roughly twice the rate while the elapsed-time ceiling runs at the same rate as before. A
design that adds seats without saying what happens to ceilings has changed the meaning of
every existing ceiling setting silently.

**Decision.** Model the work as a dispatcher-owned FIFO of immutable `Task` records, with
mutable `TaskRuntime` state held separately and per-seat execution state separately again.
`Relay` is the only mutator of any of them. Advisor replies are parsed as *assignment
decisions* rather than as a single instruction to forward. Completions are processed in the
order they arrive, and a released seat takes matching ready work immediately rather than
waiting for an advisor turn.

---

## Dispatcher/task model

### Two structures, one owner

**The queue** is a FIFO of immutable `Task` records, owned by the dispatcher inside
`Relay`. A record is never edited after admission. Anything that would be an edit is
instead a new record, or a change to the seat state that references it.

**The seat table** is the per-seat mutable execution state, keyed by participant id — an
extension of the `RelayParticipant` that already exists (`src/relay/relay.ts:75`) rather
than a parallel structure.

Only `Relay` mutates either. Not the adapters, not the participants, not `RunHandle`. This
is the same rule `#pending`/`#drain` (`src/relay/relay.ts:1376`, `:1445`) already follows
for human asides, and it exists for the same reason: the routing log is the audit record,
and a second writer makes attribution wrong without making it look wrong.

### `Task` — the immutable definition

What the advisor decided. Written once at admission and never edited; the record is what
the routing log and a later `resume` can be checked against, and a field that can be
rewritten after the fact is a field no audit can rely on.

| field | meaning |
| --- | --- |
| `id` | stable identifier, distinct from `seq` so a record can be referenced before it is ordered |
| `seq` | admission order — an identity and an audit key, **not** a scheduling priority |
| `origin` | the advisor turn (`endSeq`) whose reply produced this task |
| `instruction` | the prose the seat will receive, notes already split off |
| `target` | the advisor's assignment: a seat id, or a role. See dispatch below |
| `dependsOn` | task ids that must reach **successful `routed`** before this one may be assigned; any of them failing or being cancelled cancels this one. Empty for independent work |
| `restrictedOrigins` | human message seqs this task is adjudicated against, so `detectConflict` runs once at admission rather than per dispatch |
| `admittedAt` | wall clock, for ceiling accounting |

### `TaskRuntime` — the mutable execution state

What happened to a task, keyed by `Task.id`. Every field here changes over the task's life;
none of them are in `Task`. Keeping the two apart is what makes "the advisor asked for X"
and "X ran on seat B, twice, and failed the second time" separately readable.

| field | meaning |
| --- | --- |
| `state` | see transitions below |
| `seat` | the seat it was dispatched to, once assigned; unset while `ready` |
| `sentAt`, `endedAt` | turn boundaries, for deadlines and liveness evidence |
| `end` | the validated `TurnEndEvent` this task finished on |
| `reportSeq` | the global `#seq` its report was recorded at — the task's place in real time |
| `unsettled` | whether the transcript settle window was exhausted, as `#exchange` already returns |
| `cancelledBy` | when cancelled by a dependency, the causal `Task.id`; unset otherwise |
| `integratedAt`, `mergeCommit` | when the boundary flow merged this task's work, and the resulting integration commit |

### The seat table — mutable, per seat

Keyed by participant id, an extension of the `RelayParticipant` that already exists
(`src/relay/relay.ts:75`) rather than a parallel structure.

| field | meaning |
| --- | --- |
| `schedulerState` | `running` \| `integrating` \| `queued` \| `idle` \| `rotation_pending` \| `merge_blocked`. Derived state — see release below. Only `idle` and `queued` can take a dispatch |
| `current` | `Task.id` in flight, or none |
| `idleSince` | when the seat last became free; the ordering key for role-targeted dispatch |
| `emittedSinceSend` | already threaded through `#exchange` today; stays per-seat |
| `degradationCursor`, `baselineGeneration` | unchanged from `src/relay/relay.ts:75` — they follow the seat through rotation, never the task |

### States and transitions

```
admitted ──▶ ready ──▶ assigned ──▶ running ──▶ reported ──▶ integrated ──▶ routed
     │          │                       │            │
     │          └──────▶ cancelled ◀────┴────────────┴──────▶ failed
     └──▶ cancelled  (a dependency failed or was cancelled)
```

`routed` and `integrated` are both required for a task to count as **successfully
complete**. They are independent — see *Advisor delivery and integration are independent*
below — so a task reaches them in either order.

- **admitted → ready**: every id in `dependsOn` has reached **successful `routed`**.
  Success, not merely terminality: a dependency that failed or was cancelled did not
  produce the state its dependent was written against.
- **admitted → cancelled (dependency)**: if any id in `dependsOn` reaches `failed` or
  `cancelled`, the dependent is **terminally cancelled**, recording the **causal task id**
  in its `TaskRuntime`. It does not become ready, and it is not retried. An earlier draft of
  this note said both — that a failed dependency satisfied `admitted → ready` *and* that it
  failed the dependent — which is a contradiction that would have shipped as whichever
  branch the implementer wrote first. Cancelling is the correct half: running a task whose
  premise never materialised produces work against a state that does not exist, and the
  causal id is what lets an operator see the whole subtree one failure took out.
- A task with no dependencies is ready at admission.
- **ready → assigned**: the dispatcher picks the **lowest-`seq` ready task whose target seat
  is free**, and assigns it. A later task may overtake an earlier one that is still blocked
  on a dependency or whose target seat is busy. `seq` orders the queue scan, so among tasks
  that *can* run the oldest wins; it does not hold the queue behind one that cannot.
  Head-of-line blocking on `dependsOn` would reintroduce lockstep through the back door —
  a serial chain would idle every other seat for the length of the chain.
- **assigned → running**: the turn is sent. This is the point `#turnsTaken` increments,
  which is where `#exchange` already counts it (`src/relay/relay.ts:1199`).
- **running → reported**: `turn_end` validated, transcript settled, supersession checked,
  report recorded. The existing guards apply unchanged and per task: an empty-and-unsettled
  report escalates (`src/relay/relay.ts:2055`), an `UNANSWERED:` line halts (`:2032`), a
  non-`completed` verdict halts after supersession is resolved (`:2130`). The seat moves to
  `integrating` here — **not** to free; see below.
- **reported → integrated**: the boundary flow committed and merged this task's work, or
  found nothing to commit. This is what frees the seat.
- **reported → routed**: the report has reached the advisor in an advisor turn. Independent
  of `integrated`.
- **any → cancelled**: shutdown, or a dependency that failed or was cancelled. A `running`
  task cannot be cancelled without discarding a turn's work, so cancellation of a running
  task is deferred to its own completion — the same reason ceilings are checked at
  boundaries and `#exchange` has no timeout of its own (`src/relay/relay.ts:1821`).
- **any → failed**: transport failure on the seat. A dependency failure cancels rather than
  fails its dependents, so that the record distinguishes "this task broke" from "this task
  never got its premise".

Transitions happen only in the dispatcher, only at dispatch and release boundaries — never
mid-turn — and each one writes a `#record` note, so the routing log explains the schedule
and not just the traffic. With seats running concurrently that note is the only way to
reconstruct why a given seat was idle at a given moment.

### Advisor replies as assignment decisions

Today the advisor's reply is one instruction and the round forwards it verbatim
(`src/relay/relay.ts:2010`). Under this model the reply is parsed into zero or more
assignment decisions, with the existing keywords surviving as decisions of their own:

- one or more instructions, each admitted as a `Task` naming a `target` — a seat id or a
  role — and optionally naming dependencies. The `target` is the advisor's selection; the
  dispatcher validates it against configured seats and chooses the actual seat, per
  *Seat dispatch and release* below;
- `DONE` — admit nothing; still subject to the outstanding-human-instruction override at
  `src/relay/relay.ts:1933`, which must now consider every seat's pending queue, not one;
- `ESCALATE` — admit nothing, halt;
- notes — already split before anything else looks at the reply (`:1853`), unchanged.

Parsing is the risky part and it should fail closed: a reply that does not parse cleanly
into decisions — including one naming a seat id or role the run does not have — is treated
exactly as an empty instruction is treated today: recorded, and the advisor asked once more
(`:1894`). Guessing at an ambiguous multi-task reply would let a parser invent work nobody
authorized, and guessing at an unrecognised target would let it invent a seat.

### Completion ordering: observed arrival order

**Completions are processed in the order they arrive.** A task that finishes first is
recorded first, regardless of its `seq`.

An earlier draft of this note buffered reports and released them in task `seq` order, and
gave the advisor the whole batch in one turn. Both are wrong, and wrong in the same way
issue #42 already corrected: they recreate lockstep. Buffering by `seq` makes a fast seat's
report wait on a slow seat's — a barrier, reintroduced under a different name — and holding
reports for a batched advisor turn makes every seat wait on the advisor, which is the exact
dependency this design opened by arguing lockstep rather than advisor throughput is the
constraint. A design cannot both name lockstep as the problem and then synchronise on it
for tidiness.

The determinism argument that motivated the buffering does not survive contact with the
routing log. `#record` stamps every message with `seq: ++this.#seq` from a single global
counter (`src/relay/relay.ts:840`, `:868`), assigned at the moment of recording. That
sequence *is* the real order things happened in — it already records concurrent arrival
faithfully, and it is what `audit()` and `asymmetryAt(seq)` read. Reordering reports before
recording them would not produce determinism; it would produce a log that disagrees with
the run it describes.

`resume` (`src/relay/relay.ts:162`) therefore replays the observed order rather than a
manufactured one. Replaying a reordered log would hand the participants a history that
never happened, and the whole point of the resume path is that the recovered state is the
state the run actually reached.

The cost is real and accepted: two runs of the same tasks can interleave differently, so
the advisor's context is not byte-reproducible across runs. That is a property of running
work concurrently, not a defect of the log. What is guaranteed is weaker and more useful —
the log says truthfully what order things arrived in, and any run can be replayed from it.

### Seat dispatch and release

**Adapters emit no "idle" event.** The `AgentEvent` union
(`src/contract/session.ts:144`, under the events banner at `:70`) has exactly seven
members: `turn_start`, `message`, `tool_use`, `permission_requested`, `turn_end`,
`revision`, `error`. Nothing in it announces that a session is ready for more work, and
nothing should be added — a seat's freedom is a fact about the dispatcher's bookkeeping,
not about the child process. **Freedom is dispatcher state derived from completion.** A
seat is free because the dispatcher finished handling its last task, not because anything
told it so.

That derivation has exactly one source. `#attach` (`src/relay/relay.ts:684`) runs a single
`for await` consumer per session, pushing every event onto `p.events` and feeding
`#trackPermission` and `#trackSupersession` on the way past. One consumer per session is
load-bearing here: with concurrent seats, a second reader on the same stream would let two
observers disagree about whether a turn has ended. The guard already in `#attach` —
`if (p.session !== session) return` — exists so a rotated-out session's reader stops rather
than pushing events under the new one, and it keeps that job unchanged.

**Release is two stages, not one.** An earlier draft of this note freed the seat at
`reported`, which contradicts the worktree lifecycle: that flow requires quiesce → commit →
merge → reset *before* redispatch, and a seat handed new work at `reported` would be
writing into a tree the boundary flow is still committing. The report being ready and the
tree being ready are different facts.

**Stage 1 — `running` → `reported` → `integrating`.** The task's report is complete, which
is the sequence `#exchange` already performs (`src/relay/relay.ts:1193`):

1. `turn_end` observed and validated — polled out of `p.events.slice(before)`, with no
   deadline of its own, because the adapter's watchdog owns that clock;
2. the transcript settled — the bounded snapshot wait that exists because `Stop` fires
   before the final assistant message flushes, plus the longer salvage wait when a
   completed turn's report comes back empty;
3. supersession checked — `supersessionOf` against the events `#trackSupersession` recorded,
   so a verdict already withdrawn by a late signal is not the one acted on;
4. the report recorded via `#record`, taking its global `#seq`.

Only then. Reaching `integrating` at step 1 would run the boundary commit against a tree
whose turn was still being read out of its transcript, and the settle window exists
precisely because that read is not instant.

At this point the seat is **`integrating`: not running, and not available.** The report is
enqueued for the advisor immediately.

**Stage 2 — `integrating` → `idle` or `merge_blocked`.** The boundary flow runs (quiesce →
commit → merge → reset). Then, and only then:

- **merged and reset, or nothing to commit** → task reaches `integrated`, seat becomes
  `idle`, `idleSince` is stamped, and the dispatcher immediately dispatches any ready task
  targeting it;
- **conflict** → seat becomes `merge_blocked`, a `SeatBlock` is raised, and no dispatch
  happens until a resolution task clears it.

A **no-change boundary** — a task that read code, ran a query, or answered a question
without touching the tree — has nothing to commit and passes straight through to `idle`.
This must not be treated as an error or made to wait: most advisory tasks change no files,
and requiring a commit to free a seat would deadlock every read-only task.

**Advisor delivery and integration are independent.** These two run in parallel and neither
waits on the other:

- **enqueue** the report for the single advisor as soon as the task reaches `reported`, to
  be delivered in its next turn;
- **integrate** the seat's work, and on success **dispatch** any already-ready task whose
  target matches this seat, without waiting for that advisor turn to happen.

Decoupled on purpose. The advisor remains one seat taking one turn at a time — there is no
second advisor here — but a seat whose integration succeeded, with matching ready work in
the queue, must not idle through an advisor turn to collect it. Equally, the advisor must
not wait on a merge to hear what a seat found. If the queue holds nothing for that seat, it
idles until the advisor's next reply admits something; that is a genuinely empty queue, not
a synchronisation point.

**Assignment is advisor-selected, code-validated.** The advisor names a `target` on each
task: either a specific seat id, or a role. The dispatcher validates it against the run's
**configured** seats — an unknown seat id, or a role no configured seat fills, is a parse
failure and fails closed exactly as an unparseable reply does. The advisor cannot conjure a
seat by naming one, and validation is code's job rather than the advisor's, because a
hallucinated seat id that silently created capacity would be a scheduling decision nobody
made.

- **Seat id targeted**: dispatched to that seat when it is free; the task stays `ready`
  while it is busy. Later ready tasks for other free seats overtake it in the meantime.
- **Role targeted**: dispatched to the **longest-idle compatible seat** — greatest
  `idleSince` age among free seats whose role matches — with **participant id as the
  tie-breaker** when two seats have identical idle timestamps. Longest-idle spreads load
  and keeps any one seat's context from growing much faster than its peers'; the id
  tie-breaker makes the choice deterministic rather than dependent on map iteration order,
  which matters for a test being able to assert it at all.

### Ceilings

- `#turnsTaken` keeps counting every seat's turns, unchanged. Concurrency therefore
  consumes the turn ceiling faster in wall-clock terms; this is correct and should be
  stated in the release note, because an existing `maxTurns` means something different the
  day concurrency ships.
- The elapsed-time ceiling is unaffected.
- `maxRounds` (`src/relay/relay.ts:188`, defaulted at `:1814`) no longer describes the
  structure once rounds are gone, and is **removed** rather than reinterpreted. See
  *`--rounds` cannot survive* in the inventory below for why redefining its unit is not an
  option, and what replaces it.
- A new ceiling is required: **maximum concurrent seats**, and **maximum queue depth**. An
  advisor that admits tasks faster than they drain is the failure mode with no analogue in
  the current design, and an unbounded queue turns it into a run that never ends while
  reporting healthy.
- Ceilings are checked at dispatch boundaries — before assigning, never mid-turn — which is
  where the round loop checks them today (`src/relay/relay.ts:1821`).

### Shutdown

Two forms, and the difference is whether in-flight work is kept.

**Drain** (the normal end: `DONE`, ceiling, budget). Admit nothing further, and dispatch
nothing further — a released seat stops taking ready work the moment draining begins, which
is the one point where release does not lead to dispatch. Let every `running` task reach
`reported`, recording each as it arrives, in arrival order like any other completion.
Cancel everything still `ready`, recording each cancellation with its `seq` and instruction
so the operator can see exactly what was dropped. Then `#end` once, with the first terminal
reason — `#end` is already documented as emitted exactly once however the run and `stop()`
interleave (`src/relay/relay.ts:896`).

**Halt** (pause, escalation, `stop()`). Every seat with a task in flight is a seat whose
work would be discarded, so `#halt` must carry the full seat table into the pause: which
tasks are running, on which seats, since when. A pause that reports one in-flight turn when
three are running is worse than no pause, because the operator adjudicates against a
picture that is wrong. Rotation stays legal when **the seat being rotated** has no turn in
flight — not, as an earlier draft of this note said, when no seat anywhere does. Rotation
is seat-local (see below): it replaces one session in one worktree, and a turn running on
some other seat cannot race it. Requiring a globally quiet run would make rotation
practically unreachable, since with several seats working there is usually a turn in flight
somewhere. Today the single-implementer case guarantees the condition by pausing between
turns; with concurrency it becomes a per-seat condition to check rather than a property to
assume.

`stop()` (`src/relay/relay.ts:2280`) closes every participant session gracefully and
releases the directory claim. Neither is sufficient on its own any more: it must stop
dispatch first, then drain or retain each seat worktree through the manifest, and only then
release the claim. Releasing while a seat worktree still holds uncommitted work would
report the run cleanly finished with work stranded outside the integration checkout.

### Two kinds of stop

One `RunPause` for everything does not survive N seats, and the fix is not a bigger pause —
it is recognising that two different things were being called the same name.

`PauseReason` today has six members (`src/relay/run.ts:38`–`:72`). Two of them are facts
about **one seat** and two of the remaining four are facts about **the run**; the type does
not currently distinguish them because with one implementer there was no difference.

**A seat-local block** stops one seat. It is a `SeatBlock` held in the seat table, and it
takes over two reasons that move out of `PauseReason`:

| kind | moved from | raised when |
| --- | --- | --- |
| `rotation_pending` | `PauseReason.rotation_candidate` (`:40`) | a degradation candidate is being decided for this seat |
| `turn_incomplete` | `PauseReason.turn_incomplete` (`:52`) | this seat's turn ended on a non-`completed` verdict |
| `merge_blocked` | *(new)* | this seat's merge conflicted |

A seat-local block **stops that seat and nothing else.** Every other seat keeps running,
keeps being dispatched to, and keeps merging. This is the whole point: a single implementer
having a bad turn must not idle the other two.

**`SeatBlock` carries the full verdict apparatus.** This is not optional, and an earlier
draft of this note got it wrong by saying the sub-records "inherit seat identity from the
enclosing pause's `verdictOf`". Once a seat block is not inside a `RunPause` there is no
enclosing pause to inherit from, and every one of these still applies to a blocked seat:

- **`verdictOf: { participant, endSeq }`** — which turn the block rests on. Required, since
  supersession matching is keyed on it (`#verdictPause`, `src/relay/relay.ts:2133`).
- **`PauseSupersession`** (`src/relay/run.ts:101`) — a late `Stop` withdrawing a
  `timed_out` verdict happens on a seat whether or not the run is paused. Without this on
  the block, a seat would sit `turn_incomplete` on a verdict the system already retracted.
- **`PauseWait`** (`:129`) — an operator who looked, judged the child healthy and chose to
  keep waiting is making that judgement about **one seat**. It is more seat-shaped than
  run-shaped, not less.
- **`PauseContinueRefusal`** (`:144`) — a `/continue` refused because that seat's child was
  still working.

So these four types **survive unchanged in shape** but must become usable on `SeatBlock` as
well as `RunPause`. They stop being "pause sub-records" and become "block sub-records" that
a run-wide pause also uses.

**A run-wide `RunPause`** keeps four reasons. Three are obviously run-wide:

- `operator_requested` (`:72`) — the operator asked the *run* to stop,
- `advisor_escalated` (`:41`) — the advisor is declining to steer at all,
- `authority_conflict` (`:60`) — whether the run may proceed is the question,

plus shutdown, which is a halt context rather than a `PauseReason` member.

**`implementer_unanswered` (`:50`) stays run-wide**, and it is the interesting one, because
it is raised by a single seat and could plausibly have been a block. It is not, because of
what the reason *is*: a build-changing scope question that the instruction did not settle.
The field's own doc says continuing would choose an answer on the implementer's authority
rather than the human's — and under concurrency that choice is not contained to the asking
seat. If the answer redefines the build, work already in flight on the other two seats is
being done against a premise that may be about to change, and work merged from them
afterwards compounds it. A seat-local block would let two seats keep building on an
assumption the human is in the middle of overturning. Halting the run is the point.

The remaining run-wide reasons share that property: there is no sensible way to continue
*any* seat past them. Nothing is gained by letting three seats keep writing while the human
decides whether the run should be happening at all.

### One decision queue, serviced serially

Seat blocks enter a **single FIFO decision queue**. The advisor/operator services it **one
at a time**, in the order blocks were raised, while unblocked seats continue working.

Serial rather than parallel because there is one advisor and one operator. Presenting three
simultaneous decisions to one human is how a wrong answer gets given to the right question,
and the existing pause machinery — one `#pause`, one `#decide` resolver — is built for one
question at a time for exactly that reason. What changes is that the queue *behind* that
one question is now explicit, and that a queued block does not stop the run.

`RunHandle` therefore gains:

- **`activeSeatDecision()`** — the block currently at the head of the queue, or none. This
  is what a console or an agent operator renders.
- **a required seat id on every seat-scoped decision**, and on `rotateSeat`. Deciding
  without naming a seat is **rejected, not defaulted.** With one implementer the target was
  inferable and `rotateImplementer(reason)` could omit it; with three, an omitted seat id
  is an ambiguity, and resolving it by picking the head of the queue would silently apply
  an operator's decision to a seat they were not looking at.

The FIFO is not a priority queue. A blocked seat is already stopped, so nothing is gained
by reordering, and an order that depends on a severity judgement is an order the operator
cannot predict. Blocks are serviced in the order they were raised, which is the order the
operator watched them appear.

---

## Worktree and integration lifecycle

This is settled, not deferred. Concurrent implementers **do not share a working directory.**

### Why the current mechanisms do not cover it

Three things exist today, and none of them is a substitute for isolation:

- **Worktree detection is observational only.** `worktreePaths`
  (`src/relay/subagents.ts:53`) documents its own limit in as many words: the rule cannot be
  *enforced* from there, because the repository cannot distinguish a write by a subagent
  from a write by its parent. It is "reported, never blocking", and a zero is often
  correct. So it records the shape of a violation; it does not prevent one, and nothing
  about adding seats changes that.
- **The session lock guards the operator, not the participants.**
  `src/workspace/sessionLock.ts:1` exists because an operator's `git add -A` swept ~600
  lines of a live implementer's work into unrelated commits. It records `treeAtStart` and
  refuses broad staging while participants are live, and it is *deliberately* not a git
  hook — the comment says so — because a hook would also block an implementer from
  committing its own work, which is legitimate. It is a guard on one path. Two implementers
  writing one checkout is a hazard on a different path entirely, and the lock will not see
  it.
- **The same file notes why committing matters here**: an advisor in a separate worktree can
  only see committed state. That is the constraint the integration flow below is built
  around.

### Startup

For a run with **more than one implementer**:

1. **Require a clean base.** No staged or unstaged modifications to tracked files in the
   integration checkout, **and no untracked files outside `.conclave/`**. If either is
   present, **refuse to start** and say which paths are in the way.
2. **Create each implementer's linked worktree before starting its adapter.** Not after —
   the adapter's cwd is fixed at launch, and a session started in the integration checkout
   cannot be moved into a worktree afterwards.
3. The advisor and the integration checkout stay where they are. Only implementer seats get
   worktrees.

The refusal in step 1 is the whole point and it is not negotiable down to a warning. The
alternative — starting anyway — silently omits the operator's uncommitted base changes from
every seat's worktree, because a new linked worktree is created from a commit and carries
nothing uncommitted. Each seat would then work from a base that does not match what the
operator sees, produce diffs against the wrong parent, and the mismatch would surface as
conflicts at merge time attributed to the seats rather than to the launch. **Refuse
concurrent startup rather than omit uncommitted base changes.**

Untracked files block on the same grounds, and an earlier draft of this note got that
wrong: it proposed naming them in the refusal message without treating them as blocking, on
the reasoning that stray build output should not stop a run. That reasoning is wrong,
because naming a file and then omitting it produces exactly the divergence the rule exists
to prevent — the seats get a base that differs from the operator's, and the fact that a
message mentioned it does not make the base match. `.conclave/` is excluded because it is
Conclave's own bookkeeping and is already filtered out of `porcelain()`; anything else
untracked is either the operator's work or noise they can gitignore, and both are cheap for
them to resolve before a concurrent run starts.

### Layout

| | |
| --- | --- |
| worktree | `.conclave/worktrees/<run-id>/<seat-id>` |
| branch | `conclave/<run-id>/<seat-id>` |
| manifest | `.conclave/worktrees/<run-id>/manifest.json` |

`.conclave/` is already gitignored and already treated as Conclave's own bookkeeping —
`sessionLock.ts` filters it out of `porcelain()` precisely so the tooling's own state is
never reported as anyone's work. Putting seat worktrees there means creating them does not
dirty the integration tree, which the clean-base rule above depends on.

`<run-id>` and `<seat-id>` are **sanitized and unique**: lowercased, non-`[a-z0-9-]`
collapsed to `-`, trimmed, and suffixed on collision. Seat ids come from participant specs
and are operator-supplied, so they can contain path separators, spaces, or `..`; an
unsanitized id is a path traversal and a broken ref name at the same time.

The **manifest** records, per seat: `seatId`, `worktreePath`, `branch`, `baseSha` (the
integration HEAD the worktree was created from), and `mergeState` — one of `clean`,
`merge_blocked`, `merged`, `retained`. It is written at creation and updated at every
transition below. It is what makes recovery possible after a crash, when the only other
evidence is a directory that may or may not be anyone's.

### Orchestration commits and merging

At a **completed task boundary** — the `reported` transition, after `turn_end` is validated,
the transcript settled and supersession checked — the orchestrator, for that seat only:

1. **Quiesce the seat.** No turn in flight, and no new dispatch to it until this completes.
   The commit must be of a tree nobody is writing.
2. **Commit** its dirty tracked *and* untracked work on the seat branch, with task metadata
   in the message — task id, `seq`, seat id, and the originating advisor turn — so the
   commit is attributable to a decision without reading the routing log alongside it.
3. **Merge that commit into the integration checkout.**

**No checks run here.** An earlier draft of this note inserted "run that seat's checks"
between quiesce and commit, reusing the existing `--checks` configuration. That is wrong,
and quietly so. `rotation.checks` has one established meaning — what a replacement must
*reproduce* (`src/rotation/record.ts:54`) — and `RelayOptions.rotation` already refuses to
rotate without it, on the grounds that rotating without checks is a transfer nobody
demonstrated (`src/relay/relay.ts:2188`). Firing the same commands at every task boundary
turns a rotation gate into a per-task CI step, changes how often they run and what a
failure means, and does it to an existing operator's configuration without them asking.
Whether a merge boundary should gate on anything is a separate decision that needs its own
option; it must not be acquired by reinterpreting this one.

**On success**: update the manifest to `merged`, then **reset the now-clean seat branch to
the new integration HEAD** before the seat is redispatched. Without the reset, the seat's
next task starts from a base that is already behind, and every subsequent merge re-resolves
history the integration branch has already absorbed. The reset is safe *only* because the
seat tree is clean at this point — step 3 committed everything.

**On conflict**:

- **Abort the integration merge.** The integration checkout returns to exactly its
  pre-merge state and stays usable.
- Mark **only that seat** `merge_blocked` in the manifest. No other seat's state changes.
- **Retain** its branch and worktree untouched. The work is intact and committed on its own
  branch; nothing is discarded to make the merge tidy.
- **Notify the advisor** — this is a report it must be able to act on, since resolution is
  work that has to be dispatched as a task. Mechanically this raises a `merge_blocked`
  `SeatBlock` onto the decision queue (*Two kinds of stop*), not a run-wide `RunPause`.
- **Other seats continue.** A conflict on one seat is not a run-wide stop. Blocking every
  seat on one seat's conflict would be lockstep again, arrived at from a different
  direction.
- The blocked seat is **not free for ordinary dispatch**. It accepts exactly one kind of
  task — the resolution below — and any other task targeting it stays `ready` until the
  block clears. A seat id targeted at a blocked seat therefore waits; role-targeted work
  routes to a compatible seat that is not blocked, since `merge_blocked` excludes a seat
  from the longest-idle selection.

**Retry is a task, not a repair.** The advisor dispatches a task *to the blocked seat*
which: merges current integration HEAD into its own branch, resolves the conflict **in its
own worktree**, runs whatever verification that task's instruction names, and resubmits. On
resubmission the boundary flow above runs again from step 1. The verification is part of
the dispatched instruction rather than an automatic orchestrator step, for the same reason
the boundary runs no checks: the resolution is work, and what proves it is the advisor's to
specify.

**Conflicts are never resolved in the shared integration checkout.** A half-resolved merge
there stops every other seat from integrating, puts conflict markers in the tree the
advisor reads as committed state, and makes the resulting commit attributable to the
orchestrator rather than to the seat whose work it is. The blocked seat owns its conflict
because the blocked seat owns the work.

### Cleanup

Cleanup applies to **successfully merged, clean** seat trees and nothing else. For each:
close the adapter session, remove **that exact worktree path**, delete its **merged**
branch, and update the manifest.

**Retained, never cleaned:** any tree that is `merge_blocked`, dirty, holds unmerged
commits, or was recovered from a crashed run. For each retained tree, print the recovery
commands — its path, its branch, and what to run to inspect, merge, or discard it — and
leave it alone.

**No blanket `git worktree prune`, and no `-f`/`--force` anywhere in this path.** Both are
the same mistake the session lock was written in response to: a broad operation that cannot
tell one participant's live work from stale bookkeeping. `prune` removes entries for
directories that are merely *missing*, which on a network mount or a half-finished
checkout is a live seat; `--force` removes a worktree with uncommitted changes, which is
the exact loss the clean-base rule and the commit-before-merge step exist to prevent.
Remove by exact recorded path, delete only branches already merged, and where the state is
ambiguous, retain and report.

The precedent is already in the codebase: `guard()` handles a lock left by a dead pid by
telling the operator to remove it *once they have accounted for the files below*, rather
than clearing it automatically. Crash recovery here inherits that posture — the manifest
plus the retained trees are the account, and the operator makes the call.

### Codex, and one thing this rests on

A seat in a linked worktree needs an empty `.codex/` directory in the **main** worktree, or
Codex loads no hooks there at all — no turn-completion signal, and preflight correctly
refuses to start the session. `installConfig` already creates it when the resolved Codex
project root differs from the project root (`src/config/install.ts:333`).

**Observed, version-scoped.** The comment at that site records CLI measurements on Codex
**0.146.0** — no `.codex` dir → 0 hooks; an empty one → 5 hooks sourced from the main
worktree; its own `hooks.json` → still sourced from the main worktree — establishing that
the directory is a trigger whose contents are ignored. That is a measured behaviour of one
CLI version, not a documented protocol guarantee, and this design depends on it for every
Codex-filled seat. It should be re-measured when Codex is upgraded, and a preflight failure
for a worktree-hosted Codex seat should point here first.

---

## Per-seat checks and rotation

### Checks belong to a seat, and run in that seat's tree

Checks keep the meaning they already have: **what a replacement must reproduce.** Nothing
below fires them at a task boundary.

- The existing CLI `--checks` is **copied to every seat by default.** One flag configures a
  run, and an operator who has never thought about seats gets the behaviour they already
  expect on each of them.
- **Seat configuration may override it.** Seats can be filled by different agents against
  different parts of a repository, and a check that is the right gate for one seat can be
  irrelevant or unrunnable in another. The override is per seat and replaces the default
  rather than adding to it, so what a given seat must reproduce is readable in one place.

`CheckSpec` (`src/rotation/record.ts:54`) is unchanged, including its `relevance` grading
(`:46`) — a bare string stays `required`, so copying a run-level `--checks` onto seats
cannot silently downgrade a gate anyone was relying on.

**Everything is rooted at the seat's worktree.** `runCheck` (`src/rotation/record.ts:157`)
takes `root` and passes it as `cwd` to a shell; `capture` (`:178`) reads `root` for
`rev-parse HEAD`, the branch, `status --porcelain`, and every file digest, and hands the
same `root` to each check. The whole record is root-sensitive, which is exactly what makes
per-seat rotation possible without changing `record.ts` at all: a capture taken with `root`
set to a seat's worktree describes that seat's HEAD, that seat's tree and that seat's check
results, and nothing else's. Seat configuration supplies `root`; `record.ts` needs no
concept of seats.

Both of rotation's captures use that root — the handoff record before replacement
(`src/rotation/rotate.ts:205`) and the acceptance record after it (`:256`), each reading
`root: deps.root`. Under this design `deps.root` is **the rotating seat's worktree**, so
before and after are measured in the same tree and the comparison stays honest.

**A failing check reproduced with the same exit status remains acceptable.** This is
already how `compare` works and it must not be "fixed" when seats arrive: a differing exit
status is `blocking` (`check_exit_changed`, `src/rotation/record.ts:247`), while the same
exit status with different output is only `advisory` (`check_output_changed`, `:253`). The
question rotation asks is whether the replacement reproduces the state it was handed, not
whether the tree is green. A seat handed a red test suite must be able to demonstrate it
inherited the same red suite.

### Rotation is seat-local

A degradation candidate affects **one seat**:

- That seat moves to `rotation_pending` and **redispatch to it stops.** It is not free for
  ordinary work, in the same way a `merge_blocked` seat is not.
- **Every other implementer continues.** A candidate on one seat says nothing about the
  others, and stopping the run to consider one would be lockstep re-entering through the
  rotation path.
- **Candidate decisions are serialized through the single advisor/operator.** There is one
  advisor and one operator; concurrent rotations would have them authoring two narrative
  handoffs at once, against two moving trees, with the human adjudicating both. One at a
  time. A second candidate raised while one is pending waits its turn — its seat sits in
  `rotation_pending` and stops redispatching, which is the correct thing to do anyway.

**The replacement starts in the same seat worktree.** On success the swap is narrow: only
that seat's *session* changes. Its **id, role, branch, task history, and worktree** all
survive. This is the same guarantee the current code already provides for the single
implementer — the session is swapped in place so id, rank and routing history survive —
extended to the fields a seat has that a lone implementer did not. On rollback, only that
original session is restored; no other seat's state is touched, and the seat's branch and
worktree were never candidates for cleanup because they are neither merged nor clean.

`baselineGeneration` and `degradationCursor` (`src/relay/relay.ts:75`) already follow the
seat rather than the session, which is what stops a replacement being judged against its
predecessor's compaction events. Per-seat rotation needs them per seat, which is where they
already are.

### `rotationWatch` becomes per-seat

`rotationWatch` (`src/relay/relay.ts:1011`) is a single flat object — `armed`, plus
run-wide counters for assessments, degradations, complaints and peak generation. With one
implementer that is unambiguous. With several it silently answers a different question than
the reader thinks: "three degradations seen" could be one seat degrading three times or
three seats degrading once, and those call for opposite responses.

Conceptually it becomes a **per-seat map plus an aggregate summary.** `armed` stays
run-wide — it is a property of the options, set once at construction, and issue #31 is
specifically about it not being derivable from what happened during the run. The counters
move per seat, and the aggregate is derived from them for the summary line, so the existing
one-line report survives while the per-seat detail becomes reachable.

### `rotateImplementer()` cannot survive

`rotateImplementer(reason)` (`src/relay/relay.ts:2186`) is singular in its signature and in
its body, and the body is the part that cannot be patched around:

- `this.participants.find((p) => p.rank === 'implementer')!` (`:2195`) — picks *the*
  implementer by rank. With several seats this returns an arbitrary one, and the `!` means
  it never complains.
- `const spec = this.#opts.implementer` (`:2196`) — the one spec from `RelayOptions`, which
  is where the fixed-seat problem started.
- `root: this.#opts.cwd` (`:2207`) — captures against the integration checkout, not a seat
  tree.
- `cwd: this.#opts.cwd` in `startReplacement` (`:2218`) — starts the replacement in the
  integration checkout, which would put two sessions in one directory: the precise hazard
  the worktree lifecycle exists to prevent.

It becomes **`rotateSeat(seatId, reason)`**, which resolves the named seat from the seat
table rather than by rank, passes **that seat's worktree as `deps.root`**, starts the
replacement with **that seat's worktree as `cwd`**, and uses **that seat's spec and
checks** rather than the run-level ones. The `reason` parameter and the "callable by the
human as well as by the run loop" property both survive; the docstring's promise that an
operator need not wait for the orchestrator to notice is *more* useful with several seats,
not less.

The audition path needs one change beyond the root: the temporary participant is
constructed as `${spec.id}~replacement` (`:2221`) and `#attach`ed, and with concurrent
seats that id must be unique per seat, not per run, or two simultaneous auditions collide
in the participant lookup. Serializing candidate decisions makes that collision unlikely
rather than impossible, and an id that is only unique when a policy holds is the kind of
thing that breaks the first time the policy is relaxed.

---

## Console and status for N seats

### The transcript stays arrival-ordered

Transcript blocks print in the order reports arrive, which is the ordering the dispatcher
already committed to. Each block is labelled with **seat id and role**, because with three
implementers "the implementer said" identifies nobody. The label is the only new thing; the
ordering is not a console decision, it is the run's real order and the console must not
sort it into something tidier than what happened.

### The pinned footer

The footer shows **every configured seat, in configured-seat order**, with its scheduler
state. Configured order rather than activity order: a footer whose rows reorder as seats
start and stop makes the operator re-find the seat they were watching on every frame.

| state | meaning |
| --- | --- |
| `running` | a turn is in flight; shows elapsed and current tool |
| `integrating` | the turn is done and reported; committing and merging its work |
| `queued` | ready work targets this seat but it has not been dispatched yet |
| `idle` | nothing is waiting for it |
| `rotation_pending` | a degradation candidate is being decided; redispatch stopped |
| `merge_blocked` | its merge conflicted; retained, awaiting a resolution task |

Six states, and three of them look like "not working" from outside. The distinctions are
the whole value of the row:

- `integrating` — the seat is busy, just not with a model turn. The operator should expect
  it to clear on its own.
- `queued` — the scheduler *has* work for this seat and something is holding it. Worth
  looking at.
- `idle` — the queue genuinely has nothing for it. Normal.

Three implementers plus the advisor, one frame:

```
──── ⋯ impl-a 1m12s · Bash ───────────────────────────────────────────
  advisor                 idle
  impl-a    running       1m12s · Bash
  impl-b    integrating   merging t-05
  impl-c    merge_blocked conclave/r3f9/impl-c
──────────────────────────────────────────────────────────────────────
> _
```

`impl-b` is the state the earlier draft could not express: its turn finished, its report is
already on its way to the advisor, and it is unavailable for dispatch because its work is
mid-merge.

### Why `Progress.line()` cannot carry this

`Progress.line()` (`src/repl/render.ts:294`) returns **one unbounded string**. It already
does the right thing conceptually — it maps over *every* started participant rather than
the most recent, for the stated reason that turns overlap and showing one made the other
look idle — but it joins them with three spaces into a single line and never sees the
terminal width.

`Screen.draw()` inlays that string into the top rule (`src/repl/screen.ts:431`):

```
const head = status
  ? `${'─'.repeat(2)} ${status} ${'─'.repeat(Math.max(0, w - visible(status) - 4))}`
  : rule
```

The `Math.max(0, …)` clamps the *trailing* rule to nothing, but nothing clamps `status`
itself. One seat — `⋯ impl-a 1m12s · Bash` — is about 22 visible columns. Four seats plus
the joins is over 90, which **overflows an 80-column rule and wraps**, and a wrapped rule
inside a region whose height was computed as one row paints over the transcript above it.
The failure is not cosmetic; it is a height calculation being wrong.

### `Progress.lines(width, …)` and `status: () => string[]`

- **`Progress.lines(width: number, colour?): string[]`** — the same per-participant cells
  `line()` builds, packed into as many rows as `width` requires, returning `[]` when
  nothing is active. `line()` can remain as a one-row convenience for callers with nowhere
  to pin a footer; `lines()` is what a screen-owning caller uses.
- **`ScreenOptions.status: () => string[]`** — currently `() => string` (`screen.ts:49`).
  Returning rows lets the screen decide placement rather than the caller pre-flattening.

Placement: **the first row stays inlaid in the top rule**, which is the existing behaviour
and the reason the rule exists — a permanent row for one short phrase is a row spent on
nothing, as `ScreenOptions.status` says. Rows two and beyond get their own reserved rows
below the rule.

### Status rows must be in `Screen.#height`

This is the part that breaks quietly if it is got wrong, and `Screen`'s existing
descend-then-anchor behaviour must be **preserved, not worked around**.

`#contentRow` (`src/repl/screen.ts:109`) is the last row transcript occupies, and the box's
position is *derived* from it rather than fixed at the floor — the console starts where it
was launched and the box follows output down a row at a time. `#floor`
(`src/repl/screen.ts:159`) is `rows - #height`, computed rather than stored precisely
because `#height` changes as the box grows, and a stored floor plus a grown box disagree,
with the box winning by painting over something.

So status rows must be counted into `#height` — `draw()` computes
`#base + queued + menuRows - 1` today and must add the extra status rows. Painting rows the
height does not know about is the one thing that must not happen: the floor would not move,
the scroll region would still include those rows, and the box would overwrite transcript.

`#resize` (`src/repl/screen.ts:406`) then does the right thing in **both** phases, unchanged:

- **While descending** — `#contentRow < #floor`, so `overflow = #contentRow - #floor` is
  negative and no transcript is pushed. The extra status rows come out of the blank screen
  underneath, which is what the comment there already says: "while the box is still
  descending there is nothing to push, because it takes its extra rows from the blank
  screen underneath rather than from the transcript."
- **Once anchored** — `#contentRow === #floor`, and a taller box lowers the floor, so
  `overflow > 0` and `#resize` writes newlines at the *old* floor first. That scrolls
  transcript up into scrollback the way ordinary output does, **before** the rows are
  reserved and the scroll region is reset.

A seat count that changes mid-run — a rotation, a seat going `merge_blocked` and gaining a
branch suffix — is therefore just a height change, handled by the same path that already
handles the queue and the menu growing. Nothing new is required, provided the height is
honest.

One consequence worth stating: `#onResize` gives up the descending box for the rest of the
session and anchors to the floor, because after a reflow the console does not know where
its own output is. With a taller multi-seat footer that costs more blank space above the
box on a run that resizes early. That is the correct trade for the same reason it was
before — the alternative is several frames painted at rows that no longer mean anything.

---

## `conclave status --json`

### What already scales, and what does not

`seats()` (`src/workspace/sessionRecord.ts:609`) maps `relay.participants` — **every**
participant, not a fixed pair. It needs no structural change to describe three
implementers, which is the one part of the status path that was built general.

`SessionParticipantStatus` (`:101`) is the gap. It carries `id`, `agent`, `rank`, `turns`,
`activity`, `awaitingPermission` — everything about a session and nothing about a *seat*.
There is no scheduler state, no worktree, no branch, no current task, no per-seat checks or
rotation. Its `rank` is `advisor`/`implementer`, which does not distinguish three
implementers from each other.

`SessionStatus` (`:132`) has no queue and no integration state, because neither existed.

### Shape

`participants` **stays an array**. It is already ordered and already general, and a
by-id map alongside it would be a second copy of the same data that can disagree with the
first. **No duplicate participant map is added.**

Each `SessionParticipantStatus` **retains** `turns`, `activity`, and `awaitingPermission`
unchanged — including `turns` being required-and-empty rather than absent, for the reason
the field already documents — and **gains**:

| field | meaning |
| --- | --- |
| `role` | `advisor` \| `implementer`. Distinct from `id`, which is now what identifies a seat |
| `schedulerState` | one of the six footer states |
| `worktree` | absolute path, or the integration checkout for the advisor |
| `branch` | `conclave/<run-id>/<seat-id>`, or the integration branch for the advisor |
| `currentTask` | `{ id, state, since }`, or absent when nothing is in flight |
| `queuedTasks` | count of ready-or-blocked tasks targeting this seat |
| `checks` | this seat's resolved `CheckSpec[]` — the defaults it inherited or its override |
| `rotation` | this seat's slice of what `rotationWatch` counted run-wide |

Top level **gains** `queue` totals and `integration` state, and nothing else.

### Excerpt

Advisor plus three implementers, matching the footer frame above:

```json
{
  "schema": 2,
  "id": "r3f9",
  "front": "relay",
  "state": "running",
  "messages": 47,
  "queue": {
    "admitted": 12,
    "ready": 2,
    "running": 1,
    "blocked": 1,
    "terminal": 8
  },
  "integration": {
    "branch": "design-42",
    "head": "cf9ec3f",
    "baseWasClean": true,
    "blockedSeats": ["impl-c"]
  },
  "participants": [
    {
      "id": "advisor",
      "agent": "claude",
      "rank": "advisor",
      "role": "advisor",
      "schedulerState": "idle",
      "worktree": "/Users/m/workspace/conclave",
      "branch": "design-42",
      "queuedTasks": 0,
      "checks": [],
      "rotation": { "assessments": 0, "degradationsSeen": 0 },
      "turns": [{ "state": "completed" }]
    },
    {
      "id": "impl-a",
      "agent": "codex",
      "rank": "implementer",
      "role": "implementer",
      "schedulerState": "running",
      "worktree": "/Users/m/workspace/conclave/.conclave/worktrees/r3f9/impl-a",
      "branch": "conclave/r3f9/impl-a",
      "currentTask": { "id": "t-07", "state": "running", "since": 1754740872000 },
      "queuedTasks": 0,
      "checks": ["npm test", { "command": "npm run lint", "relevance": "informational" }],
      "rotation": { "assessments": 3, "degradationsSeen": 0 },
      "turns": [{ "state": "completed" }],
      "activity": { "kind": "tool_use", "tool": "Bash", "since": 1754740872000 }
    },
    {
      "id": "impl-b",
      "agent": "claude",
      "rank": "implementer",
      "role": "implementer",
      "schedulerState": "integrating",
      "worktree": "/Users/m/workspace/conclave/.conclave/worktrees/r3f9/impl-b",
      "branch": "conclave/r3f9/impl-b",
      "currentTask": { "id": "t-05", "state": "reported", "since": 1754740901000 },
      "queuedTasks": 2,
      "checks": ["npm test"],
      "rotation": { "assessments": 2, "degradationsSeen": 0 },
      "turns": [{ "state": "completed" }, { "state": "completed" }]
    },
    {
      "id": "impl-c",
      "agent": "codex",
      "rank": "implementer",
      "role": "implementer",
      "schedulerState": "merge_blocked",
      "worktree": "/Users/m/workspace/conclave/.conclave/worktrees/r3f9/impl-c",
      "branch": "conclave/r3f9/impl-c",
      "queuedTasks": 1,
      "checks": ["npm test"],
      "rotation": { "assessments": 1, "degradationsSeen": 1 },
      "turns": [{ "state": "completed" }],
      "block": {
        "kind": "merge_blocked",
        "detail": "merge of t-04 into design-42 conflicted in src/relay/relay.ts",
        "raisedAt": 1754740840000,
        "queuePosition": 1,
        "verdictOf": { "participant": "impl-c", "endSeq": 214 }
      },
      "awaitingPermission": { "tool": "Write" }
    }
  ]
}
```

`rank` and `role` are both present and both `"implementer"` here. That is redundant on
purpose for one release: `rank` is an existing consumer-visible field and dropping it would
break readers, while `role` is the name the seat model uses throughout. `rank` should be
deprecated in the record and removed on a later schema bump, not silently repurposed.

### What changes and what survives

- **`recordSession` (`src/workspace/sessionRecord.ts:585`) — changes.** `seats()` (`:609`)
  keeps its shape, still mapping every participant, but must populate the new per-seat
  fields, which means it needs the dispatcher and worktree manifest as inputs; today it
  closes over `relay` alone. The new top-level `queue` and `integration` blocks are written
  by the same recorder. `SESSION_SCHEMA` (`:62`) goes from `1` to `2`: new required fields
  on an existing shape is exactly what the version is for.
- **`formatSession` (`src/workspace/sessionView.ts:40`) — changes.** It renders prose for a
  human and currently has no per-seat lines to render. It needs the same
  configured-order-per-seat listing as the footer, and the same `queued`/`idle`
  distinction.
- **`formatSessionJson` (`src/workspace/sessionView.ts:87`) — survives unchanged.** It is
  `JSON.stringify({ ...s.status, alive, abandoned })`: it spreads the whole record rather
  than picking fields, so every field added above serializes with no edit. That is not an
  accident — the function's own doc says `alive` and `abandoned` are the only two fields
  not read from the file, which is what makes the spread safe to extend.

The last point is worth stating plainly because it is the strongest evidence the status
path was built for this: the serializer is already general, the iterator is already
general, and the only thing that has to grow is the record's shape.

---

## Exact code change inventory

### First, a correction: issue #42's rank premise

Issue #42 treated "more than one implementer" as blocked on the rank type — as though
naming a third seat meant opening `Rank`. That premise is wrong in both directions, and it
matters because it points the work at the wrong file.

**Role is already open, and already on the spec.** `RoleId` is
`export type RoleId = string` (`src/registry/roles.ts:15`), and the module's own doc says
why in as many words: project configuration will assign agents to roles, so a role "cannot
be a closed union baked into the type system" — a config naming an unknown role must be a
validation error, not a compile error. `ParticipantSpec` already carries `role: RoleId`
(`src/registry/types.ts:143`), alongside a per-seat `id` documented as "Stable id for this
seat".

**The relay throws it away.** `#join` builds the participant like this
(`src/relay/relay.ts:665`):

```ts
const p: RelayParticipant = { id: spec.id, agent: spec.agent, rank, session, events: [], baselineGeneration: 0, degradationCursor: 0 }
```

`spec.agent` is read; `spec.role` never is. The role reaches the relay on every spec and is
discarded at the one point where it would become run state. The gap is not in the type
system — it is one missing property in one object literal.

**`Rank` and `RANK_ORDER` stay closed.** `Rank = 'human' | 'advisor' | 'implementer'`
(`src/relay/message.ts:9`) and `RANK_ORDER` (`:12`) exist to feed `outranks()` (`:14`).
They are **authority levels**, and there are exactly three because the design's central
claim is a ranked committee: `human > advisor > implementer`.

Opening rank to carry seat identity would conflate **job identity** with **authority**.
Three implementers are *different in job* and *identical in authority* — none outranks
another, and there is no fact that would make one do so. Widening `Rank` forces an
`RANK_ORDER` entry per seat, which means inventing an authority ordering among peers that
the design does not have and cannot justify. It also corrupts what the operator reads:
`envelope()` (`:100`) renders rank into the routing header precisely because "Rank has to
be legible or it does nothing" (`:93`), so a job name in the authority slot makes the
briefing text assert an ordering that is not real.

**So: keep `Rank` closed, and add `role` separately** to participants, messages, and
events. Rank answers "who defers to whom"; role and seat id answer "which of the three
implementers is this". Neither question is served by making one field try to do both.

### Relay core

| symbol | disposition | reason |
| --- | --- | --- |
| `RelayOptions` (`src/relay/relay.ts:151`) | **changes** | `lead`/`implementer` are singular `ParticipantSpec` fields (`:185`–`:186`). Becomes `lead` plus `implementers: ParticipantSpec[]`. |
| `RotationConfig` (`:107`) | **changes** | One global policy for the run. Becomes the run-level default, overridable per seat. |
| `RelayParticipant` (`:75`) | **changes** | Gains `role` (currently dropped), plus seat execution state: `schedulerState`, `worktree`, `branch`, `idleSince`. `baselineGeneration`/`degradationCursor` already follow the seat and are unchanged. |
| `Relay.start` (static, `:599`) | **changes** | Joins exactly two seats and hands a hardcoded two-element array to `acquire()`. Becomes a loop over the implementer list; also creates each seat's worktree *before* `#join`, since cwd is fixed at launch. |
| `#join` (`:660`) | **changes** | Already general in shape — takes any `(spec, rank)`, keys by `spec.id`. Two edits: carry `spec.role` onto the participant (`:665`), and take the seat's worktree as cwd instead of `this.#opts.cwd` (`:662`). |
| `#runLoop` (`:1789`) | **replaced** | The round loop is the lockstep. `find(p => p.rank === 'implementer')!` (`:1791`) silently picks one of N. Replaced by the dispatcher loop. |
| `#exchange` (`:1193`) | **changes** | Seat-general already, and its `turn_end` + settle + salvage sequence is reused verbatim. But it samples repo-wide `dirtyPaths(cwd)` for `changedDuringTurn`, which with shared cwd would attribute another seat's writes to this turn — correct once each seat has its own worktree, which is a reason the worktree rule is load-bearing rather than tidy. |
| `#closingQuestion` (`:1073`) | **changes** | Takes one `impl` and is called once at DONE (`:1962`); with N seats only one gets a last word. Becomes per-seat over live seats. |
| `#considerRotation` (`:1629`) | **changes** | Takes one `impl` and mutates global counters. Becomes per-seat, feeding the per-seat rotation map. |
| `rotationWatch` (`:1011`) | **changes** | Flat run-wide counters. Becomes a per-seat map; `armed` stays run-wide (issue #31 — it is a property of the options, set at construction). |
| `rotationSummary()` (`:1167`) | **changes** | Renders the flat counters into one line. Keeps the one-line output, derived from the per-seat map, so the summary survives as a reader-facing surface. |
| `rotateImplementer()` (`:2186`) | **replaced** | Four singular sites: rank `find` (`:2195`), `#opts.implementer` (`:2196`), `root: #opts.cwd` (`:2207`), `cwd: #opts.cwd` (`:2218`). Becomes `rotateSeat(seatId, reason)`. |
| `#attributeArtifacts()` (`:1493`) | **changes** | An earlier draft of this note called it survives-unchanged and had it backwards. `#treeAtOrigin` (`:1400`) snapshots `dirtyPaths(this.#opts.cwd)` once, and `#attributeArtifacts` diffs `dirtyPaths(this.#opts.cwd)` against it — both read the **integration** checkout. A seat writing inside `.conclave/worktrees/…` is in a separate working tree *and* an ignored path, so its writes produce **no candidates at all** and attribution silently returns nothing until merge. Origin snapshots and evidence cursors must become seat-scoped, and the diff must run against the informed seat's own worktree. |
| `subagentUse()` (`:1144`) | **changes** | Already scans all participants, but collapses to a single `delegated` boolean with no seat attribution. Becomes per-seat, or keeps the boolean and adds the seat list. |
| `stop()` (`:2280`) | **changes** | Closing every session and releasing the claim is no longer the whole of teardown. It must first **stop dispatch**, then **drain or retain each seat worktree through the manifest** — merged-and-clean trees removed, blocked/dirty/unmerged retained with recovery commands — and only then release the integration claim. Releasing the claim while seat worktrees still hold uncommitted work would report the run as cleanly finished with work stranded outside the integration checkout. |

### Run handle and pauses

| symbol | disposition | reason |
| --- | --- | --- |
| `RunControl` (`src/relay/run.ts:192`) | **changes** | Its `rotate(reason)` verb takes no seat, so the handle-to-relay contract itself encodes "there is one rotatable seat". Gains a seat id. |
| `RunHandle.rotateImplementer` (`:303`) | **changes** | Operator-facing, no seat parameter. Becomes `rotateSeat(seatId, reason?)`. |
| `PauseReason` (`src/relay/run.ts:38`) | **changes** | Loses two members: `rotation_candidate` (`:40`) and `turn_incomplete` (`:52`) become `SeatBlock` kinds. Keeps `advisor_escalated`, `implementer_unanswered`, `authority_conflict`, `operator_requested` — all genuinely run-wide. |
| `RunPause` (`:150`) | **changes** | Not merely narrowed. Its `reason` type shrinks with `PauseReason`, and `verdictOf` plus the three sub-records stop being exclusively its — they must be shared with `SeatBlock`. The single `#pause` slot (`:360`) does stop being a contention point, but that is a consequence, not the whole change. |
| `SeatBlock` (new) | **new** | `{ seatId, kind, detail, evidence, options, raisedAt, verdictOf, superseded?, wait?, refusal? }`, one per blocked seat, held in the seat table rather than on the handle. |
| `PauseSupersession` (`:101`), `PauseWait` (`:129`), `PauseContinueRefusal` (`:144`) | **survive in shape, re-homed** | Unchanged as types, but must attach to a `SeatBlock` as well as a `RunPause`. Late revisions, operator waits and continue-refusals all still happen to a seat whose block is not a run-wide pause. |
| `PauseOption` (`:86`) | **changes** | `'rotate'` is unparameterised, matching the single-target assumption. The relay decides whether to offer it by comparing `verdictOf.participant` against `find(x => x.rank === 'implementer')?.id` — a hardcoded single-implementer lookup that becomes "is this any rotatable seat". |
| `RunHandle` decision surface (`:303`, `:360`) | **changes** | Gains `activeSeatDecision()` and requires a seat id on every seat-scoped decision and on `rotateSeat`. Deciding without naming a seat is rejected rather than defaulted. |
| `RunHandle.requestPause` (`:317`) | **survives** | Run-wide by intent — an operator asking the *run* to pause. Consumed at a dispatch boundary instead of a round boundary. |

### The adapter seam — unchanged, deliberately

**Concurrency belongs above the seam.** Nothing below changes, and that is the strongest
evidence the seam was drawn in the right place.

| symbol | disposition | reason |
| --- | --- | --- |
| `AgentSession` (`src/contract/session.ts:255`) | **survives unchanged** | A per-child handle. The worktree it runs in is supplied at creation via `CreateParticipantContext.cwd`, not held here. |
| `AgentEvent` union (`:144`) | **survives unchanged** | A second seat is a second stream, not a new event shape. In particular **no "idle" event is added** — seat freedom is dispatcher state. |
| `Rank` (`src/relay/message.ts:9`), `RANK_ORDER` (`:12`) | **survive unchanged** | Authority levels; see the correction above. |
| `RelayMessage` (`:52`) | **changes, additively** | `from: string` + `to: string[]` is already seat-keyed and needs nothing. Gains an optional `fromRole` so a reader can tell which implementer job produced a message without a seat-table lookup. |
| `envelope()` (`:100`) | **changes, cosmetically** | Already interpolates the sender id, so it works verbatim; "THE IMPLEMENTER" just reads wrong with three. Renders role where it has one. |
| `Audience` (`:22`) | **survives unchanged** | `'all' \| { only: string }` already addresses one participant by id, which is exactly how a single seat is addressed. |
| `ParticipantSpec` (`src/registry/types.ts:139`) | **survives unchanged** | Already carries per-seat `id`, `agent`, `role`, `args`. cwd is deliberately not on it — it lives on `CreateParticipantContext.cwd` (`:42`), which is what lets one spec be launched into a worktree. |
| `AgentRegistry.createParticipant` (`src/registry/registry.ts:92`) | **survives unchanged** | `(spec, ctx)` already takes cwd per call. Only the callers change — `#join` (`relay.ts:662`) and `startReplacement` (`:2218`) both hardcode `this.#opts.cwd`. |
| `rotate()` (`src/rotation/rotate.ts:171`) | **survives unchanged** | Takes one seat's session pair and `deps`. Multi-seat means calling it per degraded seat with seat-scoped `deps.root`. |
| `capture()` (`src/rotation/record.ts:178`), `runCheck()` (`:157`) | **survive unchanged** | Both fully parameterised on `root`. This is what makes per-seat rotation possible with no edit to `record.ts`. |

### Frontends, reporting, console

| symbol | disposition | reason |
| --- | --- | --- |
| `SessionOptions` (`src/repl/session.ts:116`) | **changes** | `implementer: string` (`:127`) and `implementerArgs` (`:136`) are singular; becomes a list. `rounds` (`:137`) is removed and ceilings added — see below. |
| `bin/conclave.ts` relay path (`:981`) | **changes** | Passes one `implementer` spec and `maxRounds` (`:993`); constructs `ceilings` only conditionally (`:996`). |
| `bin/conclave.ts` session path (`:1180`) | **changes** | Passes one implementer and `rounds` (`:1191`), and **constructs no ceilings at all**. |
| `recordSession` (`src/workspace/sessionRecord.ts:585`) | **changes** | `seats()` (`:609`) already maps every participant and keeps its shape, but must populate the new per-seat fields and needs the dispatcher and worktree manifest as inputs. `SESSION_SCHEMA` (`:62`) 1 → 2. |
| `SessionParticipantStatus` (`:101`) | **changes** | Gains `role`, `schedulerState`, `worktree`, `branch`, `currentTask`, `queuedTasks`, `checks`, `rotation`; retains `turns`, `activity`, `awaitingPermission`. |
| `SessionStatus` (`:132`) | **changes** | Gains top-level `queue` and `integration`. `participants` stays an array; no by-id map is added. |
| `runReport` (`src/relay/report.ts:151`) | **changes** | Loops `relay.participants` generically, so extra seats are just extra entries — but the `rotation:` block it copies reads the single aggregate `rotationWatch`, which would lose per-seat detail. |
| `Progress.line()` (`src/repl/render.ts:294`) | **survives** | Kept as the one-row convenience for callers with nowhere to pin a footer. Joined by `Progress.lines(width, …)`. |
| `ScreenOptions.status` (`src/repl/screen.ts:49`) | **changes** | `() => string` becomes `() => string[]`. |
| `Screen.draw()` (`:432`) | **changes** | Inlays status into the top rule without clipping (`:446`); the `Math.max(0, …)` only prevents a negative repeat. Must count status rows into `#height`. Note the queued rows just below (`:453`) already clip — status is missing the treatment its neighbour has. |
| `formatSession` (`src/workspace/sessionView.ts:40`) | **changes** | Needs per-seat lines in configured order. |
| `formatSessionJson` (`:87`) | **survives unchanged** | `JSON.stringify({ ...s.status, alive, abandoned })` spreads the whole record, so every new field serializes with no edit. |

### `--rounds` cannot survive; ceilings become required

**`maxRounds` (`src/relay/relay.ts:188`, defaulted `:1814`, loop `:1818`) and the
`--rounds` flag are removed, not reinterpreted.** A round is one advisor turn plus one
implementer turn. That structure is what the dispatcher replaces, so a bound expressed in
rounds has nothing left to count. Reinterpreting it as a bound on advisor turns is not an
option either, and an earlier draft of this note was wrong to float it: redefining a unit
is exactly the failure this inventory keeps flagging elsewhere, and an operator's `--rounds
8` would come to mean something they never asked for. If an advisor-turn bound is wanted,
it is a new, differently-named flag.

**`--max-turns` and `--max-minutes` become required on both frontends for concurrent
runs.** Today they are optional and unevenly wired:

- `SessionOptions` has `rounds: number` (`src/repl/session.ts:137`), forwarded as
  `maxRounds` (`:582`), and **no ceilings field anywhere** — `ceiling` does not appear in
  `src/repl/` at all. `turnWatchdogMs` (`:181`) is a per-turn deadline, not a run bound.
- Only the relay CLI constructs `ceilings`, and only conditionally
  (`bin/conclave.ts:996`). The session/console path (`:1180`) constructs none.

So the console frontend's *only* bound today is `rounds`. Remove rounds without adding
ceilings and a console run becomes unbounded — and unbounded is worse with N seats than
with one, because `#turnsTaken` counts every seat's turns (`src/relay/relay.ts:577`), so
the thing being left unbounded is now consuming budget N times faster. Requiring both
ceilings for concurrent runs is what keeps the removal of `--rounds` from being a
regression, and it puts the intended length of an expensive run into the record on purpose,
which is what `RelayOptions.ceilings` already says it is partly for.

### New modules and types

| module | contents |
| --- | --- |
| `src/relay/dispatch.ts` | `Task`, `TaskRuntime`, `TaskState`, `Dispatcher` — the FIFO, the runtime map, the transitions. |
| `src/relay/assign.ts` | `AssignmentDecision`, `parseAssignments(reply, seats)` — advisor reply → decisions, validated against configured seats, failing closed. |
| `src/relay/seats.ts` | `Seat`, `SeatTable`, `SchedulerState`, `SeatBlock` — the per-seat table, the six footer states, and the seat-local block records. |
| `src/workspace/worktrees.ts` | `SeatWorktree`, `WorktreeManifest`, `createSeatWorktree`, `removeSeatWorktree`, `readManifest` — creation, the manifest, and the retain-vs-remove rules. |
| `src/relay/integrate.ts` | `commitSeatWork`, `mergeIntoIntegration`, `MergeResult` — the boundary commit and merge, including conflict abort. |

`worktrees.ts` sits in `src/workspace/` rather than `src/relay/` on purpose: it is a
sibling of `sessionLock.ts`, which already owns `.conclave/` state and already knows to
exclude it from `porcelain()`. The two need to agree about what is Conclave's own
bookkeeping and what is someone's work, and that agreement is cheapest when they are
neighbours.

---

## Evidence grades

Not every claim in this note is backed the same way, and a reader deciding whether to build
from it needs to know which is which. Three grades:

| grade | meaning |
| --- | --- |
| **A** | Code-backed contract, read in this repository. Cited to `file:line`. Wrong only if the code changed since. |
| **B** | Observed, version-scoped CLI behaviour, recorded here by a test or a code comment that names what was measured. **Remeasure on upgrade.** |
| **C** | Proposed behaviour, inferred from CLI semantics but **not spiked in this repository**. The implementation must prove it. |

A grade is about *how the claim is supported*, not how confident it feels. A well-known git
behaviour that nobody measured here is still C: the point of the grade is to say where the
evidence lives, and "everyone knows this" is not a location.

### Grade A — code-backed

These rest on contracts read directly in this checkout, and are **not** CLI evidence:

- The `AgentEvent` union has seven members and **no idle event**
  (`src/contract/session.ts:144`); seat freedom is dispatcher state.
- `#attach` is a single event consumer per session (`src/relay/relay.ts:684`).
- `#exchange`'s `turn_end` → transcript-settle → salvage sequence (`:1193`).
- `#record` stamps one global monotonic `seq` (`:840`, `:868`) — the basis for
  arrival-ordered completion.
- `#treeAtOrigin` and `#attributeArtifacts` both read the integration cwd (`:1400`,
  `:1493`) — the basis for regrading that symbol to *changes*.
- `RoleId` is open (`src/registry/roles.ts:15`), `ParticipantSpec` carries `role`
  (`src/registry/types.ts:143`), and `#join` drops it (`src/relay/relay.ts:665`).
- `Rank`/`RANK_ORDER` are closed authority levels (`src/relay/message.ts:9`, `:12`).
- `capture`/`runCheck` are fully parameterised on `root`
  (`src/rotation/record.ts:178`, `:157`); same exit status is non-blocking (`:247`, `:253`).
- `seats()` iterates all participants (`src/workspace/sessionRecord.ts:609`);
  `formatSessionJson` spreads the whole record (`src/workspace/sessionView.ts:87`).
- `SessionOptions` has `rounds` and no ceilings (`src/repl/session.ts:137`); only the relay
  CLI constructs `ceilings` (`bin/conclave.ts:996`).
- `Progress.line()` returns one unbounded string (`src/repl/render.ts:294`) and
  `Screen.draw` does not clip it (`src/repl/screen.ts:446`).

### Grade B — observed, version-scoped

| claim | evidence | remeasure when |
| --- | --- | --- |
| A linked worktree needs an empty `.codex/` in the **main** worktree or Codex loads no hooks — the directory is a trigger, its contents ignored. | Measurement table in the comment at `src/config/install.ts:333`, taken on Codex **0.146.0**: no dir → 0 hooks; empty dir → 5 hooks from main; own `hooks.json` → still from main; main sidecar deleted → 0. | Any Codex upgrade. This gates **every Codex-filled seat**: without hooks there is no turn-completion signal and preflight refuses to start. |

This is the only B-grade claim in the note, and it is load-bearing rather than incidental.

### Grade C — proposed, not spiked here

Every one of these is a git CLI behaviour this design depends on and **this repository has
not exercised**. They are individually unsurprising; that is not the same as verified.

| claim | why it could be wrong |
| --- | --- |
| A new linked worktree is created from a commit and carries **no uncommitted tracked changes and no untracked files** — the basis for the clean-base refusal. | Standard `git worktree add` semantics, but the refusal rule is built entirely on it. If it were partially false the rule would be over-strict rather than unsafe, so this is the least dangerous C. |
| **Nested worktrees under a gitignored `.conclave/`** work normally — `git worktree add` into an ignored subdirectory of the same repository, with `git status` in the integration checkout staying clean. | **The riskiest claim in this note.** It combines three things (worktree inside the repo, inside an ignored path, with the ignore rule owned by `sessionLock.ts`'s `OWN_STATE` filter) and I did not test any of them together. Failure modes: git refusing the path, the integration `status` reporting the worktrees, or the ignore rule interacting badly with `porcelain()`. If this fails, the layout moves outside the repo and the manifest becomes the only link. |
| `git merge --abort` restores the integration checkout to **exactly** its pre-merge state, leaving it usable while one seat is `merge_blocked`. | Documented git behaviour, but the design lets *other seats keep merging* immediately afterwards. An abort that left index or `MERGE_HEAD` residue would corrupt the next seat's merge, not just the failed one. |
| Resetting a clean seat branch to the new integration HEAD after a successful merge loses nothing. | Safe **only** because the boundary flow committed everything first. The claim is really about the ordering, and the ordering is unproven here. |
| `git worktree remove` (no `--force`) and `git branch -d` (not `-D`) refuse rather than destroy when the tree is dirty or the branch unmerged — the basis for "retain, never blanket-prune". | The whole cleanup safety story rests on these refusing. If either is more permissive than assumed, cleanup silently destroys retained work — the exact failure `sessionLock.ts:1` was written about. |
| The multi-seat footer overflows an 80-column rule at roughly four seats (~22 visible columns per cell). | Computed from the format string and representative seat ids, **not rendered**. The wrap threshold depends on actual seat id lengths; the *existence* of the overflow is Grade A from the unclipped `head` expression, only the threshold is C. |

### Implementation-validation checklist

One check per B/C claim. Each is a thing to run, not a thing to reason about.

**B1 — Codex linked-worktree hooks.** In a linked worktree with an empty `.codex/` in the
main worktree, start a Codex seat and confirm hooks load and a turn-completion signal
arrives. Re-run on every Codex version bump; record the version in the test name.

**C1 — worktree base fidelity.** With tracked modifications and untracked files present,
create a seat worktree and assert both are absent from it. Then assert startup refuses
before creating anything.

**C2 — nested ignored worktrees.** `git worktree add` into `.conclave/worktrees/<run>/<seat>`
and assert: the command succeeds; `git status --porcelain` in the integration checkout is
empty; `worktreePaths()` (`src/relay/subagents.ts:53`) lists the new tree; and
`sessionLock.ts`'s `porcelain()` filter still excludes `.conclave/`. **Do this first** — it
is the claim the layout depends on, and a failure here changes the design rather than the
code.

**C3 — merge abort isolation.** Force a conflict from seat A, abort, then merge seat B
successfully into the same integration checkout. Assert B's merge is clean and the tree
carries no residue from A.

**C4 — reset ordering.** After a successful boundary merge, assert the seat tree is clean
*before* the reset runs, then assert the reset leaves the seat branch at integration HEAD
with no lost commits.

**C5 — cleanup refuses.** Attempt `git worktree remove` on a dirty seat tree and
`git branch -d` on an unmerged seat branch; assert **both fail** and the tree and branch
survive. This test passing is what licenses the no-`--force` rule.

**C6 — footer width.** Render the footer with four seats at realistic id lengths in an
80-column terminal and assert no row exceeds the width and the box frame is intact.

A run that cannot pass C2 and C5 should not ship concurrent implementers, regardless of how
much of the dispatcher works: C2 decides whether the layout is possible, and C5 decides
whether cleanup can lose someone's work.
