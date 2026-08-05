# TODO

Tracked because "it works without it" is how a deliberate deferral becomes an accident.

## Before enabling any adapter with contradictory late evidence

**Migrate adapters to the shared evidence tracker.**

`src/outcomes/tracker.ts` implements the self-correcting path: a provisional terminal
verdict is *withdrawn* when stronger evidence lands, and weaker repeated evidence cannot
resurrect it. It is tested standalone (`src/outcomes/precedence.test.ts`, both arrival
orders converging on identical verdict *and* provenance).

`ClaudePtyHookAdapter` does not use it. `#finalise()` calls `classify()` directly and is
guarded by `if (turn.verdict) return`, so a Claude verdict never revises. That is
currently harmless — nothing in Claude Code produces contradicting late evidence, since
no abort record exists and the hook-loss path only ever *adds* a completion nothing
contests.

Codex is the first adapter that could need it: if 0.146.0 emits both `turn_aborted` and
`Stop` on cancellation, and they arrive in that order, the adapter must withdraw the
provisional `completed`. **Do not enable the Codex adapter until `#finalise` runs through
the tracker.** Otherwise "Claude works without it" quietly becomes "all adapters bypass
it", and the revision semantics stay proven in a unit test and absent in production.

## Non-resurrection rests on evidence monotonicity, not an explicit guard

The tracker accumulates and never drops, so a repeated `Stop` cannot outrank an abort
already in the evidence set. Compaction is the case where that assumption could fail: a
rewritten transcript that no longer contains a `turn_aborted` the tracker had already
seen. The reconciliation path handles this today by rebuilding from scratch and emitting
a revision, so two separate designs agree rather than one rule enforcing the property.

If non-resurrection ever needs to be load-bearing on its own, make it an explicit
precedence floor rather than a consequence.

## The parity test asserts exact corpus counts

`src/outcomes/classify.test.ts` asserts 17 classifiable runs and 4 superseded. Re-running
the Python matrix (`spikes/hooks/matrix.py`) appends to the corpus and will break that
assertion. This is the right trade for now — the exact counts are what make the parity
claim meaningful — but the corpus is committed evidence that a spike run mutates.

Either freeze the corpus and have new runs write elsewhere, or make the assertion
relative rather than absolute. Do this before anyone re-runs the matrix casually.

## Project-local hook registrations hardcode absolute paths

`.claude/settings.json` and `.codex/hooks.json` both point at
`/Users/miclip/workspace/coding-repl/spikes/hooks/hook_post.py`. They are committed
because the Codex hook-trust tests read `.codex/hooks.json` as their subject, and because
the trust hash covers the command string — but neither works on another machine or
checkout path.

The TypeScript adapter already avoids this: it generates a settings file into a mkdtemp
directory and passes `--settings`, so it never depends on a committed absolute path. The
spike-era registrations are what need resolving, most likely by making them relative or
generated.

## Deferred, with reasons

- `AgentSession.fork()` throws. Honest until session forking is actually needed.
- Permission **allow** has an unverified byte encoding; only **deny** has a fixture.
  Recorded in `src/process/input.ts` as `'allow (unverified encoding)'` so later code
  cannot mistake it for established behaviour.
- The transparent keystroke proxy for the §5a `external` input-ownership escape hatch.
- The layered configuration subsystem (§5b). Registration, participant construction,
  role assignment and input policy are already data-driven in anticipation.
