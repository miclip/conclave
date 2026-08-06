# Conclave

A REPL that sits above two or more coding-agent CLIs and mediates a working session
between them, with a human in the loop.

The children are the **real** Claude Code and Codex CLIs, unmodified, driven under a
pseudo-terminal exactly as a human would. Nothing about their harness, auth, or usage
accounting differs from someone typing.

> **Status: supervised use, not autonomous use.** Two children now hold a real session
> between them, a human can steer or intervene mid-session, and a degraded implementer can
> be replaced without losing the work — all of it verified against the real CLIs. What does
> not exist is a REPL, a summariser, or a third participant. See
> [Where this actually is](#where-this-actually-is).

---

## The idea

Two frontier models with different training and different harness prompts have genuinely
different blind spots. Routing an architectural question through one while the other
holds the implementation context produces better outcomes than either alone. Part of that
is model diversity; part is **context isolation** — the advisor never accumulates the
implementation detail that bogs down the implementer.

What this is *not*:

- Not a new coding agent. The children are the real CLIs.
- Not an API harness. It rides existing subscription auth, not API keys.
- Not consensus-by-committee. Two models that cannot run the code converge on whoever
  sounds most confident, and confidence is not correlated with correctness. The design
  actively resists agreement-seeking.

Full reasoning, including the commercial risk that drove the transport choice, is in
[`DESIGN-BRIEF.md`](DESIGN-BRIEF.md).

## Where this actually is

| build step | state |
|---|---|
| 1. PTY transport | done — both CLIs boot their real TUI and accept synthetic keystrokes |
| 2. Lifecycle hooks | done — turn boundaries, payload schemas, delivery semantics characterised |
| 3. Transcripts | done — both formats parsed; terminal outcomes classified with provenance |
| 4. `AgentSession` adapters | done — Claude and Codex, 8 live acceptance flows each |
| 5. Two-party relay | done — prose-only exchange, ranked committee, restricted human asides |
| 6. Round budgets / anti-spiral | partial — round budget and stall metrics; the spiral ladder is not built |
| **7. Rotation** | **done — replace a degraded implementer transactionally, proven live** |
| 8. Orchestrator model | not built |
| 9. REPL | done — pauses as decision points, addressed asides, live activity |
| 10. Panel / summariser | not built |
| 11. Third participant | not built |

The brief says to stop after step 5 and evaluate honestly whether two agents beat one.
Two controlled experiments have run ([`spikes/experiments/`](spikes/experiments)) and the
second **falsified its own hypothesis** — the advisor did not produce the repository-blind
recommendation the trap was built for; it asked to inspect first. The honest claim so far
is narrower than "one catches the other's blind spots": the participants contribute
*different* information, and the roles were not redundant.

## What works today

```bash
npm install
npm run config:install     # render hook registrations for this checkout
npm test                   # typecheck + 268 tests (243 offline, 25 live-gated)
```

Both adapters implement the same contract and pass the same acceptance boundary, built
through the registry so deployment preconditions are enforced:

```
start → acceptsInput        permission deny  → permission_refused
send  → completed           permission allow → completed
cancel → cancelled          abandon → transport_lost
```

Live suites spawn real sessions and consume real quota, so they are opt-in:

```bash
npm run test:live           # Claude adapter, 8 flows
npm run test:live:codex     # Codex adapter, 8 flows
npm run test:live:relay     # a human aside reaches one participant and shapes the work
npm run test:live:pause     # a real session survives a human-scale pause and resumes
npm run test:live:rotate    # the rotation transaction, end to end
npm run test:live:rollback  # the rollback branch, with acceptance rigged to fail
npm run test:codex          # Codex hook-trust deployment invariants (no model tokens)
npm run conformance         # what each adapter claims, graded by evidence
```

`test:live:pause` and `test:live:rotate` both pass. `test:live:rollback` is written and
has not been run.

## Try it

```bash
node examples/one-session.ts            # claude
node examples/one-session.ts codex      # codex
```

Drives one real session through the registry and prints the terminal verdict with its
evidence. Both agents, same contract, same ~40 lines:

```
agents available: claude, codex

codex: session started, input ownership mediated
> Reply with exactly DEMO-N and nothing else, where N is 41 plus 1. No tools.

turn_end   completed (proven) [hook:Stop]
           synthesized=false

snapshot (authoritative, rebuilt from the transcript):
  completed            proven   "DEMO-42"
```

### Two participants

```ts
const relay = await Relay.start({
  registry: defaultRegistry(),
  cwd: repo,
  lead:        { id: 'advisor',     agent: 'codex',  role: 'advisor' },
  implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
  rotation: { checks: ['npm test'] },
})

const run = relay.start('Add a rate limiter to the request path.')

for (;;) {
  const s = await run.settled()
  if (s.kind === 'ended') break
  console.log(s.pause.reason, s.pause.detail)   // rotation_candidate, advisor_escalated, ...
  await run.continue()                          // or rotateImplementer / injectConstraint / abort
}
```

### The REPL

```bash
npm run session -- "Add a rate limiter to the request path." --checks "npm test"
```

```
<text>                 to everyone, at human rank
@advisor <text>        to the advisor only — the implementer will not see it
@implementer <text>    to the implementer only — the advisor will not see it

/pause  /continue  /rotate [reason]  /abort
/state  /log [n]  /audit  /help
```

Pauses become decision points rather than the end of the run, and participant **activity**
is shown while a turn is running — the interval between an instruction and the report
answering it, which is the whole duration of the work and is otherwise silent.

It holds no lifecycle logic: every transition is a method on `RunHandle`, so the console is
a client of the state machine rather than the place it lives. A line you type is reported as
*queued for the next exchange*, not delivered — neither child CLI ingests input mid-turn, so
seeing sooner is not intervening sooner.

Still no summariser, and no third participant.

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
[`spikes/experiments/03-compaction-degradation.md`](spikes/experiments/03-compaction-degradation.md).

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

## Layout

| path | what it is |
|---|---|
| [`DESIGN-BRIEF.md`](DESIGN-BRIEF.md) | the design, with corrections folded in as they were found |
| [`TODO.md`](TODO.md) | deferrals with reasons, and the invariants protecting them |
| [`src/`](src/README.md) | the contract, adapters, classifier and registry |
| `src/relay/` | the two-party relay, the audit trail, and the resumable run handle |
| `src/repl/` | the console — a client of the run handle, holding no lifecycle logic |
| `src/rotation/` | the rotation transaction: record, handoff, degradation, rollback |
| `spikes/pty/` | step 1 — transport, and what it corrected about the brief |
| `spikes/hooks/` | step 2 — hook lifecycle, delivery semantics, the evidence corpus |
| `spikes/transcripts/` | step 3 — schemas and the outcome classifier's Python reference |
| `spikes/codex/` | Codex 0.146.0 runtime-semantics fixtures |
| `spikes/experiments/` | pre-registered experiments, including one that falsified its own hypothesis |

Each spike has its own `FINDINGS.md` recording what was measured, including the parts
that contradicted expectations.

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

## Requirements

Node 24+ (executes TypeScript directly via native type stripping — no build step),
Python 3 for the spike tooling, and the `claude` and `codex` CLIs installed and
authenticated. One runtime dependency, `node-pty`.
