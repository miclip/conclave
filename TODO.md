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

## Portable project hook configuration

**Next task, before collecting Codex fixtures.**

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

## Deferred, with reasons

- `AgentSession.fork()` throws. Honest until session forking is actually needed.
- Permission **allow** has an unverified byte encoding; only **deny** has a fixture.
  Recorded in `src/process/input.ts` as `'allow (unverified encoding)'` so later code
  cannot mistake it for established behaviour.
- The transparent keystroke proxy for the §5a `external` input-ownership escape hatch.
- The layered configuration subsystem (§5b). Registration, participant construction,
  role assignment and input policy are already data-driven in anticipation.
