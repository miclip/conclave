# TODO

Tracked because "it works without it" is how a deliberate deferral becomes an accident.

## ~~Before enabling any adapter with contradictory late evidence~~ — done

**Migrated.** `ClaudePtyHookAdapter` now routes all terminal handling through
`TurnVerdictTracker`; the one-shot finalisation is gone. Proofs in
`src/outcomes/migration.test.ts` and the live suite. The gate on
`CodexPtyHookAdapter` is lifted as far as terminal handling goes — what remains for
Codex is transport integration over semantics already established.

Kept below for the reasoning, which still explains why the tracker exists.

**Original entry: migrate adapters to the shared evidence tracker.**

`src/outcomes/tracker.ts` implements the self-correcting path: a provisional terminal
verdict is *withdrawn* when stronger evidence lands, and weaker repeated evidence cannot
resurrect it. It is tested standalone (`src/outcomes/precedence.test.ts`, both arrival
orders converging on identical verdict *and* provenance).

`ClaudePtyHookAdapter` does not use it. `#finalise()` calls `classify()` directly and is
guarded by `if (turn.verdict) return`, so a Claude verdict never revises. That is
currently harmless — nothing in Claude Code produces contradicting late evidence, since
no abort record exists and the hook-loss path only ever *adds* a completion nothing
contests.

**This remains a hard gate. Do not enable `CodexPtyHookAdapter` until `#finalise` runs
through the tracker.**

The live fixtures changed the argument for it rather than weakening it. 0.146.0 turned
out NOT to emit `turn_aborted` and `Stop` together, so the original motivation -- a
provisional `completed` needing withdrawal -- is not currently reachable. But the run
established something more important: on Codex a refused permission and a user
cancellation produce the *identical* transcript record (`turn_aborted reason=interrupted`),
so the only thing separating them is `PermissionRequest` having fired plus the
orchestrator's own record of the mediated deny.

That makes mediated input and permission events **classification evidence, not optional
metadata**, on both adapters. An adapter that finalises a verdict once and never revisits
it cannot incorporate evidence that arrives after the fact, and cannot express the
degradation when input ownership is `external`. The tracker is where that lives.

Otherwise "Claude works without it" quietly becomes "all adapters bypass it", and the
revision semantics stay proven in a unit test and absent in production.

## Codex abort/Stop precedence is synthetically verified, not live-observed

`turn_aborted > Stop` is covered by `src/outcomes/precedence.test.ts` in both arrival
orders. On 0.146.0 the two records are mutually exclusive, so the rule never fires in
practice and the live fixtures could not exercise it.

It stays because it is correct and costs nothing, and because a future version emitting
both must not silently upgrade a cancellation into a completion. Grade it as a guard, not
as validated behaviour, and do not cite the Codex fixtures as evidence for it.

## Non-resurrection rests on evidence monotonicity, not an explicit guard

The tracker accumulates and never drops, so a repeated `Stop` cannot outrank an abort
already in the evidence set. Compaction is the case where that assumption could fail: a
rewritten transcript that no longer contains a `turn_aborted` the tracker had already
seen. The reconciliation path handles this today by rebuilding from scratch and emitting
a revision, so two separate designs agree rather than one rule enforcing the property.

If non-resurrection ever needs to be load-bearing on its own, make it an explicit
precedence floor rather than a consequence.

## Evidence corpus counts are intentionally exact

The classifier parity test asserts exactly 17 classifiable and 4 superseded records. The
corpus is labelled evidence supporting the current conformance claims, not an append-only
runtime log.

Re-running spike scripts may append records and intentionally break the test. Updating the
corpus therefore requires an explicit review of:

- the newly added evidence;
- expected classifications;
- supersession relationships;
- TypeScript/Python parity;
- any affected conformance grades.

Do not replace the exact-count assertion with a loose lower bound merely to make casual
spike reruns pass.

## ~~Portable project hook configuration~~ — done

Landed in `8df69d7` (templates + `conclave config install`), `83cd17f` (paths untracked,
guard test), `bda5cad` (`config check`). Kept for the rationale, which is still live: the
trust-hash consequence in particular explains why every checkout re-trusts once.

The committed `.claude/settings.json` and `.codex/hooks.json` contain checkout-specific
absolute paths. Replace them with portable source templates and generated machine-local
registrations.

Requirements:

1. Keep canonical hook definitions or templates under version control.
2. Generate active project-local Claude and Codex hook files using the current checkout
   path.
3. Ignore generated machine-local files where possible.
4. Run Codex trust tests against temporary copies by default; mutate the real installed
   sidecar only in explicitly gated deployment tests.
5. Preserve the ability to diagnose Codex trust from `hooks/list`, rather than
   reimplementing Codex's normalization or hashing.
6. Do not weaken the registry preflight: a participant must not be created when required
   hooks are loaded and enabled but non-executable.

Intended shape:

```
conclave config install
    ├── resolve repository root
    ├── render Claude project hooks
    ├── render Codex sidecar
    ├── write atomically
    ├── diagnose loaded Codex state
    └── explain whether re-trust is required
```

Note the consequence of requirement 5: because Codex's trust hash covers the normalised
handler — including the command string, which contains the absolute path — every checkout
necessarily produces a different hash and must trust its own hooks once. That is inherent,
not a defect, and `config install` should say so rather than hide it.

Git history is deliberately **not** being rewritten to remove `/Users/miclip` from
`c46a1ea`. The path disclosure is low sensitivity, the repository contains no secrets, and
a rewrite would add operational risk without meaningfully undoing publication. `c46a1ea`
stays as the audited experimental baseline; the paths come out in the next commits so the
public tip is portable.

## Errata: two commits contain work their messages do not describe

`3c2c8b5` ("Record the intervention gap that streaming opens") and `74f5aee` ("Human
input splits into context and control") are documentation commits that also contain
~600 lines of watchdog implementation and tests — `src/outcomes/watchdog.ts`,
`watchdog.test.ts`, and `src/adapters/watchdogWiring.test.ts`.

Cause: `git add -A` run while a relay session was live and its implementer was editing the
same tree. That is the shared-workspace hazard recorded in §5c of the brief, walked into by
the orchestrator rather than by either agent — the advisor is read-only, the human was not.

Not rewritten, on the same reasoning applied to `/Users/miclip` in `c46a1ea`: the commits
are pushed, the problem is attribution rather than correctness or secrets, and a rewrite
would add operational risk without meaningfully undoing publication. Recorded here instead
so the history is explained rather than merely wrong.

**The rule that follows: never stage with `-A` while a participant session is live.** Stage
explicitly, or hold commits until participants are quiesced. The orchestrator has to obey
the workspace discipline it enforces on its participants.

## Rotation: what is left to verify

Two claims, deliberately separated (DESIGN-BRIEF §7a). A successful rotation settles the
first and says nothing about the second.

### Claim 1 — the mechanism. BOTH RUNS PASS [2026-08-06]

```
ORCH_LIVE_PAUSE=1  node --test src/relay/pause.live.test.ts      192s, passed
ORCH_LIVE_ROTATE=1 node --test src/rotation/rotate.live.test.ts  152s, passed
```

Live rotation against real CLIs is established: a real advisor produced the seven headings,
a real replacement emitted `CHECK n: exit <code>` and reproduced the record, promotion kept
the participant identity, and the original was terminated. A real session also survived a
two-minute hold and resumed without drift, with ingestion and audit live throughout.

Five defects came out of getting there; see DESIGN-BRIEF §7a, "First live runs". Four were
product bugs invisible to the offline suite.

**Next, in order:**

1. **Live rollback proof.** Both runs took the promotion path, so leak-free
   abandonment rests on the run-1 diagnosis plus offline tests. Needs a deliberately
   failing acceptance. Assert the replacement terminates, the original unquiesces, the run
   escalates, and no child process survives. `rotate.rollback.live.test.ts`.
2. **Human-scale long pause.** A duration resembling actual operator behaviour, not
   another two-minute probe. Confirm observation stays live while orchestration stays
   suspended. `ORCH_PAUSE_SECONDS` exists for this; the longest run so far is 120s.
3. **Acceptance relevance semantics.** A contract design question, not another boolean: a
   check may reproduce faithfully and still be irrelevant to the transferred artifact.
   Likely `required` / `informational` / `unrelated`, **declared by the orchestrator** —
   a replacement classifying its own checks is the evidence-into-judgement collapse this
   design exists to prevent. See DESIGN-BRIEF §7a.

**Harness rules earned the hard way:**

- A live test must wait for a report before pausing, or it measures an empty session.
- Write live output to a file, never through `tail` — a buffered pipe cannot flush while
  the process it reads from cannot exit, which is exactly the state a liveness bug creates.
- Correlate process, filesystem and phase before diagnosing. Three separate wrong readings
  came from a grep pattern that could not match, an inspector probe that loaded a second
  module graph, and invisible buffered output.

### Claim 2 — does compaction predict degradation?

**A comparison, not a success.** Pre-registered in
`spikes/experiments/03-compaction-degradation.md`: the same bounded probe before
compaction, after compaction, and after rotation, scored on repository-grounded mistakes,
repeated questions, contradiction rate, test regressions and useful progress — not prose
quality.

Until it has evidence, `'automatic'` stays opt-in.

## Deferred, with reasons

- `AgentSession.fork()` throws. Honest until session forking is actually needed.
- Permission **allow** is verified on Codex (`y`, dialog captured, file created, `Stop`
  fired) and still unverified on **Claude**, where it is presumed to be Enter taking the
  highlighted option. `src/process/input.ts` now carries per-agent encodings rather than
  one blanket caveat, and only Claude's records `'allow (unverified encoding)'`.
- `SessionEnd` has never fired on Codex. It is registered and trusted, but no run achieved
  a clean exit — every teardown escalated to SIGTERM because Codex does not quit promptly
  on Ctrl-C. Collect a `/quit` fixture before concluding anything about it.
- The transparent keystroke proxy for the §5a `external` input-ownership escape hatch.
- The layered configuration subsystem (§5b). Registration, participant construction,
  role assignment and input policy are already data-driven in anticipation.
