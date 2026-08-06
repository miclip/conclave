# Conclave

A REPL that sits above two or more coding-agent CLIs and mediates a working session
between them, with a human in the loop.

The children are the **real** Claude Code and Codex CLIs, unmodified, driven under a
pseudo-terminal exactly as a human would. Nothing about their harness, auth, or usage
accounting differs from someone typing.

> **Status: foundations only. There is no relay yet, so there is nothing to *use*.**
> Two adapters can drive real sessions and report honestly what happened to each turn.
> The orchestration that would make this a product — relaying between two children,
> summarising for the human, routing constraints — is not built. See
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
| **5. Two-party relay** | **not built** — this is what would make it usable |
| 6. Round budgets / anti-spiral | not built |
| 7. Orchestrator model | not built |
| 8. Panel | not built |
| 9. Third participant | not built |

The brief says to stop after step 5 and evaluate honestly whether two agents beat one.
That evaluation has not happened, because step 5 does not exist.

## What works today

```bash
npm install
npm run config:install     # render hook registrations for this checkout
npm test                   # typecheck + 118 offline tests
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
npm run test:live          # Claude, 8 flows
npm run test:live:codex    # Codex, 8 flows
npm run test:codex         # Codex hook-trust deployment invariants (no model tokens)
npm run conformance        # what each adapter claims, graded by evidence
```

There is no command that runs a two-child session. Building one today means using the
registry directly — see `src/registry/` — which is a library, not a product.

## The ideas that shaped it

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
| `spikes/pty/` | step 1 — transport, and what it corrected about the brief |
| `spikes/hooks/` | step 2 — hook lifecycle, delivery semantics, the evidence corpus |
| `spikes/transcripts/` | step 3 — schemas and the outcome classifier's Python reference |
| `spikes/codex/` | Codex 0.146.0 runtime-semantics fixtures |

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

Requirements and design direction throughout came from the human; the implementation and
the empirical work were done by Claude (Opus 5) in Claude Code.

## Requirements

Node 24+ (executes TypeScript directly via native type stripping — no build step),
Python 3 for the spike tooling, and the `claude` and `codex` CLIs installed and
authenticated. One runtime dependency, `node-pty`.
