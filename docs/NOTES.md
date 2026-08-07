# Engineering notes and record

Standing caveats, decisions that must not be quietly reversed, and the record of what was
verified. Open work lives in GitHub issues; this is the part that is not a task.

Moved out of a `TODO.md` that mixed the two.

---

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

1. ~~**Live rollback proof.**~~ **DONE 2026-08-06** — `npm run test:live:rollback` passes.
   Divergence injected through the test-only `hooks.afterCapture` barrier, because the
   trigger has to be causal rather than timed. See DESIGN-BRIEF §7a, "The rollback branch,
   live".
2. ~~**Human-scale long pause.**~~ **DONE 2026-08-06** — 30 minutes, no degradation. A duration resembling actual operator behaviour, not
   another two-minute probe. Confirm observation stays live while orchestration stays
   suspended. `ORCH_PAUSE_SECONDS` exists for this; the longest run so far is 120s.
3. ~~**Authority-conflict coverage is offline only.**~~ **DONE 2026-08-06** —
   `npm run test:live:authority` passes; five live runs total, three post-fix, all citing
   the adjudication as the operative cause. See DESIGN-BRIEF §7a.

   Left open from it: **artifact attribution is perturbable.** It diffs `git status
   --porcelain`, so anything another editor dirties in the interval is attributed to the
   aside. Token matching is unaffected. Worth narrowing before the detector is trusted in a
   shared checkout.

4. **Acceptance relevance semantics.** A contract design question, not another boolean: a
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


## Conventions the participants are asked to use, and whether they use them

Three now depend on a participant choosing to write a marker. Their adoption is a fact about
live runs, not about the code, and it is recorded here because the code cannot tell you.

| marker | who | added for | observed adoption |
|---|---|---|---|
| `FLAG:` | implementer | #30 | **zero**. The one real participant with something to flag wrote prose (#38) |
| `NOTE:` | advisor | #1 | unmeasured |
| `NONE` | implementer | #37 | unmeasured; asked directly, so it does not depend on memory |

The difference that matters is what an unwritten marker COSTS.

An unwritten `FLAG:` made `flags: []` read as "nothing outstanding" when it meant "nobody told
us" — worse than absent, which is why #37 added a closing question that asks directly rather
than waiting to be told.

An unwritten `NOTE:` leaves things exactly as they were before the channel existed. That is
why it was shipped on weaker evidence than `FLAG:` had.

`NONE` is different in kind: the participant is asked a direct question at the moment it
matters, so nothing depends on it having remembered a convention from fifteen turns earlier.
If adoption of that ALSO turns out to be poor, the conclusion is not "ask harder" — it is that
prose from a participant cannot be relied on to carry structure, and anything that needs
structure has to come from a hook or a tool call instead.

**Do not report an empty `flags` array as a measurement** until one of these paths has been
observed working in a live run. Today it means "nobody volunteered anything".
