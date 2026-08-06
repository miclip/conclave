# src — the Conclave adapter seam

TypeScript, run directly on Node 24 via native type stripping. **No build step** and one
runtime dependency: `node src/...` executes `.ts` files and `node:test` is the test
runner. The dependency is `node-pty` — Node has no built-in PTY, and reimplementing
platform PTY handling is not a trade worth making for a dependency count.

Note `scripts/fix-node-pty.cjs`, wired as a postinstall: node-pty's prebuilt
`spawn-helper` ships without its executable bit on macOS, and without it every spawn
fails with a bare `posix_spawnp failed` that reads like a native build failure.

Erasable-syntax-only is a hard constraint of native stripping: no `enum`, no `namespace`,
no parameter properties. Const-object-plus-union is used instead, which is better for
this contract anyway.

```
npm test          # 66 tests
npm run test:codex # 3 more, mutates ~/.codex/config.toml then restores it
npm run test:live # 6 more, spawns real Claude sessions and uses quota
npm run conformance
```

## Layout

| path | what it is |
|---|---|
| `contract/outcome.ts` | terminal outcomes, confidence grades, provenance, evidence levels |
| `contract/session.ts` | `AgentSession`, events, `SessionSnapshot`, input-ownership guarantees |
| `outcomes/classify.ts` | composite classifier, ported from the validated Python spike |
| `outcomes/tracker.ts` | accumulates evidence; reports when a verdict must be withdrawn |
| `transcript/tail.ts` | rewrite-aware tail — expects its file to be rewritten under it |
| `transcript/parse.ts` | per-agent record → turn parsing |
| `transcript/reconcile.ts` | the read → detect → invalidate → rebuild → revise loop |
| `conformance/capabilities.ts` | what each adapter claims, graded by evidence |
| `conformance/suite.ts` | checks claims against fixtures; never upgrades one itself |
| `process/childenv.ts` | the constructed-environment invariant |
| `process/pty.ts` | PTY lifecycle; SIGTERM-before-SIGKILL |
| `process/input.ts` | serialized, semantically attributed input |
| `hooks/journal.ts` | durable journal, stable delivery identities |
| `hooks/receiver.ts` | per-session receiver; journals before acknowledging |
| `hooks/client.ts` | the command the child CLI executes |
| `adapters/claude.ts` | the first live adapter |
| `registry/roles.ts` | role definitions as data |
| `registry/types.ts` | agent definitions, participant specs, input policy |
| `registry/registry.ts` | resolution and participant construction |
| `registry/builtin.ts` | the built-in Claude and Codex definitions |
| `deployment/codexHookTrust.ts` | Codex hook-trust readiness check; registry preflight |

## The three ideas worth knowing before reading the code

**A terminal event is never bare.** `Stop` proves normal completion and nothing else, so
every terminal statement carries an outcome, a confidence grade, and a provenance chain.
Three statements that are easy to collapse are kept apart deliberately:

- `in_progress` — no terminal evidence exists
- `unknown_abnormal_end` — evidence the turn ended, but not why
- `cancelled` — cancellation is known, because we mediated the input that caused it

Silence supports only the first. The watchdog therefore never returns `cancelled`; it
returns `timed_out` with the caveat *"completion is uncertain; this is not evidence of
cancellation"* carried in the provenance, where a consumer cannot drop it by accident.

**`events()` and `snapshot()` are separate because transcripts are not append-only.**
Compaction rewrites history. A byte-offset tailer with append-only derived state will
eventually hold turns its own source no longer contains. So `events()` is live and
provisional and may emit `revision` events that withdraw earlier `seq`s by number, while
`snapshot()` is rebuilt from whatever the transcript currently says and is always
authoritative. Rewrite detection is by prefix digest, not by recognising vendor markers —
an unrecognised rewrite is still a rewrite, and gets reported as a caveat rather than
asserted as a compaction.

**Adapters are allowed to differ, and the contract records how.** Before either
production adapter exists, Claude Code and Codex already disagree on readiness
(`session_start_hook` vs `unknown`), correlation key (`prompt_id` vs `turn_id`),
transcript structure, and cancellation observability — Codex writes `turn_aborted` with a
reason, Claude Code writes nothing anywhere. The conformance suite grades claims as
`observed` / `inferred_from_documented_event` / `reasoned_but_unverified` / `unsupported`
rather than pass/fail, because for most outcomes the honest answer is "designed,
sometimes documented, not yet witnessed". A claim of `observed` with no fixture fails.
A fixture found under a weaker claim produces a *recommendation*, never an automatic
upgrade — whether a fixture really demonstrates an outcome is a judgement about the
fixture.

## Relationship to `spikes/`

The Python spikes are the evidence base, not legacy. They generated every fixture these
tests read, and `spikes/transcripts/outcomes.py` remains the reference implementation the
TypeScript classifier is checked against. They are deliberately left un-refactored while
the underlying behaviour is still being characterised.

Fixtures labelled `SYNTHETIC` in test names have no recorded counterpart — compaction has
never been observed on this machine. They must not be read as evidence that the modelled
behaviour occurs.

## What the live adapter guarantees

`ClaudePtyHookAdapter` owns process lifecycle, sanitized environment, input
serialization, hook ingestion, transcript reconciliation and evidence classification.
It owns no relay policy, round budgets, role prompting or summarisation — those live
above the seam, where they do not complicate what the adapter can be held to.

Failure boundaries it is tested against (`npm run test:live`):

- `send()`, `cancel()` and `decidePermission()` share one serialization chain, so
  keystrokes cannot interleave.
- The receiver journals and fsyncs **before** acknowledging. An ack that outruns the
  write turns a crash into silent loss, because the client treats 200 as delivered.
- Delivery identities are minted at fire time from payload digest plus hook pid plus
  fire timestamp, so replays are stable and two byte-identical Stops stay distinct.
- Process exit resolves every outstanding command promise, and turns are reconciled
  against the transcript *before* anything is finalised — a completed turn whose `Stop`
  was lost comes back as `completed` (confidence `inferred`, with a caveat), never as
  `process_exited`.
- Terminal handling runs through `outcomes/tracker.ts`, so a verdict already reported can
  be **withdrawn by seq** and replaced when stronger cross-channel evidence lands.
  Explicit orchestrator actions outrank process death: closing a session cannot downgrade
  a turn we already cancelled, refused, or saw complete.
- `close('graceful')` and `close('abandoned')` differ: abandonment yields
  `transport_lost` with the caveat that the child may still be running, rather than
  asserting a death.
- Readiness (`isReady`, SessionStart arrived) and the ability to accept input
  (`acceptsInput`, the composer is live) are separate capabilities.
- The input queue records semantic actions — submit, cancel, permission_decision — with
  origin. That log is the entire evidence base for an `assumed` cancellation.

## Configuration is data-driven, but not yet configurable

Conclave will layer global user configuration (available agents, personal defaults) over
project-local `.conclave/` configuration (which agents fill which roles). **That
subsystem is not built**, and nothing in `registry/` reads a file or merges a layer.

What exists is the shape configuration will produce. Agents are values in a registry, so
adding one is a registration rather than an edit to the code that builds participants —
there is a live test asserting a session created through the registry behaves
identically to one created directly. `ParticipantSpec` is plain data and `resolve()`
validates it without launching anything, so a config file can be fully checked before
any child process starts. `Role` is an open string because a config naming an unknown
role should be a validation error with a good message, not a compile error.

Codex is registered *without* a `create`: listed, described, conformance-graded, and not
constructible. Omitting it would have made it look finished by absence.

## Not built yet

`CodexPtyHookAdapter`, and the transparent keystroke proxy for the §5a escape hatch.
Codex's hook lifecycle is entirely unverified — quota resets Aug 9 — which is exactly
why its capabilities are graded below Claude's rather than assumed symmetric.

`fork()` throws. `allow` on a permission dialog has an unverified byte encoding and says
so in `process/input.ts`; only `deny` has a fixture.
