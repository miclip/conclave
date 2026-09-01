# Conclave — design and provenance

Why the system is shaped the way it is, and the record of what was measured to get there.
Moved out of the README, which is for people who want to run it: this is for people who
want to know whether to trust it, or who are about to change it.

The design itself lives in [`DESIGN-BRIEF.md`](../DESIGN-BRIEF.md), with corrections folded
in as they were found. Each spike keeps its own `FINDINGS.md` recording what was measured,
including the parts that contradicted expectations.

---

## The premise

Two models with different training and different harness prompts have different blind
spots. The advisor answers architectural questions while the implementer holds the
implementation context, and never accumulates that context itself.

Different *models*, specifically. Two instances of one model, given no shared context, still
share their priors — this project has watched two of them make the same wrong call about the
same code independently, and a third model in the advisor seat is what caught it. Fresh
context decorrelates reasoning; it does not decorrelate training.

That is also the argument for putting the expensive model where the judgement is rather than
where the volume is. The implementer reads files, runs suites and edits; the advisor reads a
report and writes an instruction. Those are not the same token bill.

It is not a coding agent, and not an API harness. The children are the real CLIs: Claude
Code and Codex on subscription auth, OpenCode and Kimi on whatever credential each of them
wants. That distinction is the line the project holds — a CLI may need an API key, Conclave may
not have one. It is not consensus-by-committee either. Two models that cannot run the
code converge on whoever sounds most confident, so the design resists agreement-seeking.
The reasoning is in [`DESIGN-BRIEF.md`](../DESIGN-BRIEF.md).

---

## Loop engineering, and graph engineering

Two names the field settled on in mid-2026, after most of this was already built. They are
useful here for the same reason any vocabulary is: they say what kind of thing this is to
someone who has not read the code.

**Loop engineering** is designing the cycle an agent repeats — run, verify, retry, stop — so
that a human is not the one deciding each next instruction. **Graph engineering** is what you
reach for when one loop is not enough: specialised nodes, edges that route work between them,
and shared state travelling along those edges. Every node in a graph is still a loop.

Conclave is the first and has grown into the second:

| the term | what it is here |
|---|---|
| the loop | goal → advisor → instruction → implementer → report → advisor |
| who closes it | code. There is no orchestrator model and no summariser |
| verify | `--checks`, required, and a rotation rolled back when a replacement cannot reproduce them |
| stop | four ceilings, two deadlines, and a graded verdict with the evidence behind it |
| nodes | seats, in roles the operator defines |
| edges | the task queue, and the advisor's own routing decisions |
| shared state | the integration tree, checked after every merge and not only per seat |

The advisor is the node that holds the goal, and it is the one deciding which edge is taken
next: it is inside the loop rather than a step in it. That is the whole reason the goal goes
to it alone — a node that routes work has to know what the work is for, and one that merely
executes does not.

What the vocabulary does not capture is the part this project is actually about. A graph says
which node ran; it does not say whether to believe what came back. `outcomes/` grades every
turn by the evidence available for it — a `Stop` hook proves completion, a clock reading does
not — and a run that cannot be graded better than `reasoned_but_unverified` says so. The
routing is the easy half.

---

## The ideas that shaped it

**A ranked committee, not a panel of peers.** `human > advisor > implementer`. Rank breaks
ties; it does not buy silence. The implementer is told plainly that the advisor outranks it
on process and that silent compliance is worse than disagreement — and it uses that. Asked
to put a test somewhere `package.json`'s own glob would never discover, it refused and said
why.

**Prose only, symmetrically.** Participants exchange full narration and never tool calls,
diffs, or reasoning traces — exactly what a human following along would see. The advisor
shares the working directory, so it can verify any claim rather than believing it.

**A human message carries an audience.** Addressed to one participant or all, and the
audience travels *on the message* rather than as orchestrator state: a mode can be left set
by mistake, an addressed message cannot be mis-delivered by forgetting to change it back.
Visibility is derived from provenance, not topology — an ordinary advisor-to-implementer
instruction is normal traffic, not hidden influence, and only a deliberately withheld human
message is `restricted`.

Withholding is an instrument with a cost, and the cost showed up live. A constraint sent to
the implementer alone produced work the advisor had not asked for, and the advisor
escalated rather than overruling:

> ESCALATE: The implementer refuses to remove `subtract`, citing a direct human instruction
> that is not present in the advisor-visible history; human confirmation is needed.

That is the mitigation working. Asides cannot be kept private — an aside that shapes an
artifact leaks through the artifact — so the guarantee is that the asymmetry stays
**attributable**: `audit()` and `asymmetryAt(seq)` say who was informed and who was not, so
a later divergence can be checked against the record instead of guessed at.

**A pause is a state, not a return value.** `relay.run()` is the unattended form and every
pause point is terminal for it. `relay.start()` returns a handle whose pauses *suspend* the
loop holding everything it had, because restarting a run from the goal is not resuming —
it replays work and hands consumed state to participants that have moved past it.

Rotation is safe at exactly that suspended point and nowhere else: no turn is in flight, so
replacing the implementer cannot race a send.

**Rotation is a transaction.** Quiesce the old implementer → the advisor authors the
narrative handoff → the orchestrator captures the checkable record (HEAD, file digests,
verification exit codes) → the replacement *demonstrates* it can reproduce that record →
only then is the original terminated. On any failure the original is unquiesced and the
work is not stranded between two sessions.

Two things are deliberately not trusted. The advisor cannot see files or tests, so it
writes the narrative and never the record. The replacement's report that the checks pass is
a claim about facts the arbiter owns, so it is compared against an independent run — and a
replacement reporting a *mismatch* has performed a successful transfer. The failure being
caught is one that reports agreement it never observed.

Rotation verifies **continuity, not health**: a check failing identically before and after
is a reproduced state, and refusing over it would strand exactly the session that most
needs replacing.

**Degradation is mechanical; the complaint is a claim.** Compaction is observable and
already parsed. An implementer asking for a fresh session may be reporting exhaustion or
reflexing, so the complaint is checked against the signal rather than believed or
overridden. Compaction alone is sufficient — a model may compact without noticing.

And the response is not automatic. `compaction → rotation candidate` is the default: the run
pauses and the human decides. Defaulting to automatic rotation would encode *"compaction
predicts degradation"* as settled on the strength of evidence that only shows *"rotation
works"* — two different claims, and only the second has evidence. See
[`spikes/experiments/03-compaction-degradation.md`](../spikes/experiments/03-compaction-degradation.md).

**A terminal event is never bare.** `Stop` proves normal completion and nothing else.
Every terminal statement carries an outcome, a confidence grade (`proven` / `inferred` /
`assumed` / `uncertain`) and a provenance chain, so downstream code cannot quietly upgrade
an inference into a fact. Three statements that are easy to collapse are kept apart:

- `in_progress` — no terminal evidence exists
- `unknown_abnormal_end` — evidence the turn ended, but not why
- `cancelled` — cancellation is known, because we mediated the input that caused it

A watchdog therefore never returns `cancelled`. Silence supports only the first.

**Never parse the screen.** Both CLIs render inline with cursor-addressed redraws, so
accumulated stdout contains every intermediate frame with no way to tell which was final.
Screen bytes prove a child is alive and help a human debug. Nothing else.

**`events()` and `snapshot()` are separate** because transcripts are not append-only.
Compaction rewrites history, so a live stream is provisional and may withdraw what it
already said; the snapshot is rebuilt from what the transcript currently says and is
always authoritative. A consumer folding the event stream must converge with the
snapshot — asserted live after every flow, which is how two real bugs were caught.

**Adapters are allowed to differ, and the contract records how.** They disagree on
readiness, correlation key, transcript structure and cancellation observability:

| | Claude Code 2.1.222 | Codex 0.146.0 |
|---|---|---|
| readiness | `SessionStart` at boot, blocks first turn | no hook until the first turn |
| correlation | `prompt_id` | `turn_id` |
| completion | `Stop` | `Stop` **and** `task_complete` |
| cancellation | nothing recorded, anywhere | `turn_aborted` with a reason |
| `Stop` on cancellation | no | no |

**Claims are graded, not asserted.** The conformance suite grades every outcome per
adapter as `observed` / `observed_historically` / `inferred_from_documented_event` /
`reasoned_but_unverified` / `unsupported`, and *fails* a claim of `observed` with no
fixture — or one whose only fixture came from an older CLI version. Finding evidence
produces a recommendation, never an automatic upgrade.

---

---

---

## What works

- Four CLIs under one `AgentSession` contract. Claude Code and Codex have eight live
  acceptance flows each; OpenCode and Kimi are graded against recorded runs.
- A two-party relay: prose only in both directions, a ranked committee, and human asides
  addressed to one participant with an audit trail of who was excluded.
- Pauses as decision points — rotation candidate, advisor escalation, authority conflict,
  and an implementer question that would change the build — resolved from the console or from
  `RunHandle`.
- Rotation as a transaction: quiesce the old implementer, the advisor authors a handoff,
  the replacement reproduces the verification, and it rolls back if it cannot. Both
  branches proven live, rollback included.
- Subagents, which both participants may use as they judge. A subagent that modifies
  anything works in its own git worktree.
- Concurrent implementers. Seats run at the same time, each in its own worktree, dispatched
  by a task queue rather than by rounds — so a seat that finishes in four minutes does not
  wait for one taking forty. Completed work merges into the integration tree; a conflict
  becomes a repair task on the seat that produced it rather than a question for you, and
  that seat's work stays on its own branch throughout.
- Checks against the *integration* tree, not only per seat. Two seats can produce work that
  merges without conflict and fails together — one moves lines the other's new test cited.
  A failure after a mid-run merge is a repair task naming both contributing tasks; after the
  final merge it is a reported outcome, because no seat is left to fix it.
- Seat-local rotation. A degraded seat is replaced without disturbing the others, verified
  in its own worktree, and an acceptance failure with no observable output at all stops
  retrying rather than rolling back repeatedly.
- A reviewer seat, opt-in with `--reviewer`. Rank implementer, so its rejection creates work
  rather than authority. It reads the diff and the tree, never the producing seat's summary.
- The advisor can tell you something without stopping the run. A line beginning `NOTE:` is
  recorded for you and withheld from the implementer, while the rest of the reply is still
  the instruction. `ESCALATE` remains for when it actually needs an answer before continuing.
- Subagent work is named rather than shown as a raw tool call, and the run records whether
  delegation happened without any worktree being created — the shape a violation of the
  worktree rule takes. It is reported, never enforced: the repository cannot tell a
  subagent's write from its parent's.
- Unresolved items carried into the summary. A participant ending a report with a line
  beginning `FLAG:` has it lifted verbatim into the final lines, so a run that completed
  while something stayed unchecked does not read as unqualified success.
- Build-changing scope questions paused for a human answer. A line beginning `UNANSWERED:`
  in an implementer report means it had to choose a build-changing direction without an
  answer; the run pauses until the human settles it, while choices about how to build remain
  the implementer’s. It is distinct from `FLAG:`, which only qualifies the result.
- Outcomes graded by evidence, and the four agents do not offer the same evidence. `Stop`
  proves normal completion on Claude Code and Kimi, `step_finish reason=stop` on OpenCode,
  `task_complete` on Codex; anything weaker is labelled as what it is. A run exiting 0 is
  not evidence a turn finished, and is not treated as any. `npm run conformance` prints
  each agent's claims with what backs them.

`--operator agent` tells the advisor a machine is answering escalations: ask readily, but
about premises and unobservable criteria rather than permission — and treat the answer as an
opinion with authority over the goal, not as independent confirmation. It is declared rather
than detected, because an agent and a human at a terminal are indistinguishable from inside
the relay.

The goal is linted before anything starts — an ask with nothing observable in it cannot be
graded better than `reasoned_but_unverified` however well the work goes, and a goal is the
last artefact you can fix for free. Warnings by default; `--strict-goal` refuses.

So is the seating. A seat whose CLI is not installed, or which names a model its CLI does not
have, is refused before anything is spawned, registered or written — not twelve minutes later
as a watchdog, and not on the first turn as an abnormal exit. Only the agents this run seats
are checked.

`--dry-run` resolves configuration, checks and arguments and starts nothing. It is on both
commands and prints the same plan line for line; on the console it stops above the session
lock, so it registers no hooks, writes no permission mode, takes no lock and creates no
participant, and it says the goal would be asked for when you gave it none. It is refused
together with `--bypass` there, because applying that would leave a permission mode written by
an invocation that started nothing and skipping it would print launch arguments the real run
would not use. `relay` refuses to run outside a git repository unless you pass `--force` —
attribution and rotation both diff the tree, so neither means anything without one.

`--rounds` bounds how many times the advisor gets to steer — one pass of the loop is one
advisor turn — and it is the only bound a run has unless you set another. Four ceilings are
separate from it, and all four stop a run that is still going and exit non-zero, because a
silent stop is indistinguishable from a run that simply finished:

| ceiling | bounds |
|---|---|
| `--max-turns` | advisor turns, whatever they cost |
| `--max-minutes` | time the run spends WORKING |
| `--max-queue-depth` | messages waiting to be delivered |
| `--max-concurrent-seats` | seats working at once |

Passing `--max-turns` when you meant `--rounds` is accepted and bounds something else, so
every launch prints what each ceiling is set to and `status --json` carries them. That is the
whole reason they are printed: two of these are easy to confuse with `--rounds`, and a run
bounded by something other than what you typed looks identical from outside to one that was
not bounded at all.

`--max-minutes` counts the time the run is WORKING: time suspended at a pause, waiting on an
operator who may be asleep, is not charged to it. A ceiling exists to stop a run that has gone
wrong, and a run interrupted overnight has not gone wrong.

A ceiling bounds the RUN; a deadline bounds a TURN. `--turn-timeout` is how long a seat's turn
may take before the adapter grades it `timed_out`, and `--silence-timeout` is how long it may
go without saying anything at all. The second is the one that matters for a child that stopped
working: a stalled turn stops writing its transcript long before it stops being late, so the
silence clock reaches it in minutes where the absolute one would take the better part of an
hour. Both are resolved once and printed in the launch banner, the run report and
`status --json`, so a run that ended at a deadline can say which deadline.

Three more flags exist for reproducing a fault rather than for ordinary use. `--settle` widens
how long a turn's transcript is given to catch up with the hook that ended it, and `--salvage`
how much longer an empty report buys before it is treated as lost — the transcript lags a long
turn the same way whoever is watching does. `--record` tees the rendered bytes to a file, so a
display fault can be read in the bytes rather than guessed at from a screenshot.

Every message is recorded to `.conclave/runs/` as it happens, and `--resume <log>` replays it
into both seats. `relay` ends at every pause point by design, so the normal way a long run
stops is with work still in flight — resuming continues it rather than having you transcribe
what was established into a new goal, where anything you miss is silently re-derived or
silently lost.

`conclave relay --json` prints the run as a structured record rather than prose: the outcome,
each turn's verdict with the confidence and provenance behind it, the rotation counters, and
anything a participant flagged as unresolved. Every human-facing line moves to stderr, so
stdout parses in full. That is the interface an agent driving Conclave needs — confirming a
run should not mean grepping a transcript.

---

## How this was built

Empirically, and the record is deliberately unflattering. Every design claim traces to a
fixture, and where a fixture contradicted the design the design changed. A few examples,
all documented in the FINDINGS files and commit messages:

- The brief asserted both CLIs use the alternate screen buffer. Neither does — which
  strengthened the "never parse the screen" conclusion by a different route.
- Spawning an agent from inside an agent session leaks `CLAUDE_CODE_CHILD_SESSION`, and
  Claude Code then writes **no transcript at all**. Silent data loss that would have
  surfaced much later as a phantom parser bug.
- Two spike checks passed against the TUI echoing the harness's own typed input. Both
  were false positives; prompts now ask for a token the model must *compute*.
- `PermissionRequest` fires when the dialog **opens**, so inferring refusal from "no
  `Stop` yet" closed turns while the user was still being asked.
- Abandonment emitted a verdict the tracker never held, so `events()` and `snapshot()`
  disagreed. Caught by the convergence assertion, on the adapter that had one.
- The orchestrator ran `git add -A` during a live relay and swept ~600 lines of a
  participant's work into an unrelated commit. The rule that followed is now *enforced*
  rather than written down, because a rule that lives only in prose is one the person who
  wrote it breaks.

The first live runs of the relay found four more, none of which the offline suite could
see. The pattern is worth stating: **every one was a case where the code did something
defensible in isolation and wrong in context.**

- The advisor's `DONE` returned immediately, discarding any queued human message — so the
  advisor could end a session out from under a human instruction that had never been
  delivered. The brief's own §7a says the human outranks that.
- `close('abandoned')` recorded that observation was lost and walked away *without
  terminating the child*. The epistemic caution was about the turns; the code applied it to
  cleanup, and a rolled-back replacement outlived its test by 26 minutes.
- A replacement reported `...before doing any work.CHECK 1: exit 0` and was told it had
  reported nothing, because the parser required a line start. A newline the model does not
  control decided that a correct answer was no answer.
- A run that paused with nobody listening hung until a harness timeout filed an
  orchestration deadlock as an agent turn overrunning — both agents idle, nothing
  scheduled. `result()` now rejects when a pause arrives with no watcher: not a timeout,
  but the observation that the promise provably cannot settle.

Diagnosing that last one took three wrong readings first — a process table grepped with a
pattern that could not match, an inspector probe that silently loaded a second copy of the
module graph, and reporter output invisible because a buffered pipe cannot flush while the
process it reads from cannot exit. Each made the system look broken in a way it was not.
The rule that survived: correlate process, filesystem and phase before diagnosing, and
validate a probe against something that must be true before trusting what it says is absent.

Requirements and design direction throughout came from the human; the implementation and
the empirical work were done by Claude (Opus 5) in Claude Code.
