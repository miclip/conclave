# Engineering notes and record

Standing caveats, decisions that must not be quietly reversed, and the record of what was
verified. Open work lives in GitHub issues; this is the part that is not a task.

Moved out of a `TODO.md` that mixed the two.

---

## Content reads the record; presentation pins the width

**Standing rule for every assertion in this repository (#109).**

> Content reads the record. Presentation pins the width. Rendered output never stands in for
> content.

The console is a lossy view. `markdown()` and `summaryLine()` put every message through `wrap()`,
which splits on `/\s+/` and rejoins at the terminal width — so runs of spaces collapse, line
breaks disappear into the flow, and a phrase can be broken across a row mid-word. Three failures
follow, all of them silent in the direction that keeps a test green:

1. **An assertion that greps rendered output for a message's wording cannot see a whitespace or
   line-break change in that message.** Measured: a routed message altered from
   `Blank lines survive.` to `Blank   lines   survive.` left every console assertion about it
   passing, with the run log showing the change. Fifteen assertions in `session.test.ts` shared
   this defect and none of them could fail on it.
2. **A negative console assertion — "this phrase was not printed" — is satisfied whenever a wrap
   falls inside the phrase.** Measured: padding the preceding text so `half` ended one row and
   `an answer` began the next left a `doesNotMatch` green with the words plainly on screen. An
   absence claim has to be made against the absence of a RECORD.
3. **A rendered assertion means nothing at an unknown width**, so the test harness pins one
   rather than inheriting whatever the stream happens to report.

A console assertion is still correct for a console-only notice — a hint, a refusal, a banner,
the answer to a REPL command — because no record carries those. Say so where you write one, so a
later reader can tell a deliberate rendering claim from a content claim that went to the wrong
place. And note what a rendering assertion cannot pin even in principle: the producer's own
spacing, which the renderer normalises before anyone sees it. The drawn form is the contract.

The helpers that make this cheap live beside each other at the top of `src/repl/session.test.ts`:
`collect()` for presentation, `routed()`/`routedAll()` for what was said, `events()` for what
happened. The rule is written out there too, next to the code it governs.

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

Addendum [2026-08-23]: `327c56c` ("WIP #125: a forced /continue is recorded with what it
overrode") lists the two force-population tests as "not done" while containing them — the
implementer landed them between the advisor's verification of the diff and its staging.
Explicit staging by filename did not save it, because the participant was editing those very
files at the time. So the rule's stronger form is the real one: explicit staging is
necessary and NOT sufficient; re-read the diff between staging and committing, or hold the
commit until the participant is quiescent. Not rewritten: the branch is unpushed WIP, the
problem is the message's done/not-done list rather than the content, and the correction
rides the commits that followed.

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


---

## A shared test-fixture race across three adapters (#154)

**Current state, not a chronology.** Everything below is measured on this machine unless it
says otherwise. One question is left unanswered by all of it, and it is named at the end.

### The report that started it, and the correction to it

The issue records two flakes under full-suite load, in unrelated files, neither touched by
the branch it failed on, both green when re-run in isolation:

- `a red integration tree mid-run is repaired: a task is dispatched, taken, merged, and the
  tree measured green` (`src/relay/integrationRed.test.ts`), which took 14943ms failing;
- `a run that produced records and then stalled is not blamed on its model`, attributed there
  to `src/adapters/watchdogWiring.test.ts`.

**That second attribution cannot be right as written.** No test of that name has ever existed
in `watchdogWiring.test.ts` on any branch (`git log --all -S`). The name belongs to
`src/adapters/opencode.test.ts`, where it has lived since `7f29ac9`. `watchdogWiring.test.ts`
has a sibling test with the same intent under a different name — `claude: a turn that spoke and
then went quiet is not blamed on its model` — so #154 pairs one test's name with the other
test's file, and the record does not say which half is accurate. Both files turned out to carry
the defect, so the investigation did not depend on resolving it; the ambiguity is recorded
because a citation nobody can check is the failure this repo already has a guard for.

**The falsifier, established early and still standing.** `integrationRed.test.ts` drives
`FakeRotationSession` and registers `NO_DEADLINE_CLOCKS`. It constructs neither PTY adapter nor
a `TranscriptSessionView`, so no watchdog timing, no deadline reconciliation and no transcript
serialization executes anywhere inside it. Nothing found below can reach it. Treat the two
halves of #154 as two investigations that happen to share an issue number.

### One mechanism, three adapters

Every adapter's `#82` tests ask the same question — did the child produce ANYTHING before its
deadline, because a first turn that produced nothing makes the model it was launched with a
suspect — and each one left the precondition to a race:

| adapter | the precondition | what it raced |
|---|---|---|
| `ClaudePtyHookAdapter` | a `PermissionRequest` hook recorded before `UserPromptSubmit` arms the watchdog | two unawaited `fetch` POSTs, ordered by nothing |
| `OpenCodeRunAdapter` | `turn.heard > 0` from a parsed record or a stderr byte | a real 600ms deadline vs. fork + exec + shell startup + parsing |
| `KimiPrintAdapter` | the same, on its own record and stderr paths | the same |

The shape is worth recognising on sight: **if a test's precondition arrives through the same
clock the test is measuring, it is a race, and a loaded machine will find it before review
does.** All six were test defects. None was an adapter defect.

It was already being paid for. `watchdogWiring.test.ts` carried a bespoke 5-second deadline for
its spoken-turn test where every other test in the file used 400ms, with a comment arguing that
enough time makes the right order likely.

### Reproduced deterministically, then fixed

Six simultaneous copies of a file against 14 CPU burners on a 10-core machine. At that load
these stop being flakes and fail in every run:

| file | `HEAD` | fixed | load avg |
|---|---|---|---|
| `src/adapters/opencode.test.ts` | **4 of 18 fail**, 6 runs of 6 | **0**, 6 of 6 | 6.7 → 12.8 |
| `src/adapters/kimi.test.ts` | **2 of 13 fail**, 6 of 6 | **0**, 6 of 6 | ~19 |

The OpenCode arm was run as a factorial, and the middle row is what makes the two fixes
independent rather than one covering for the other:

| tree | fail / 18 |
|---|---|
| `HEAD` | 4, 6 of 6 |
| + stalled-run and provider fixes | 2, 6 of 6 |
| + the fixture barrier | 0, 6 of 6 |

Confirmed harder on the last arm: eight simultaneous copies against 20 burners, load average
15.1, **18/18 in all eight runs**. `watchdogWiring.test.ts` was verified the same way — 24 runs
up to six-way against 14 burners, all green, with its spoken test collapsing from 6.2s into a
1619–1640ms band.

**No deadline was raised.** Every fix takes the precondition out of competition with a real
deadline — the clock no longer runs while the test is waiting for the thing it depends on. That
is the property all six share, and it is weaker than causality in two of the three cases. What
each fix actually establishes differs, and the difference is worth keeping straight:

- **Claude — causal.** The fake CLI awaits its `PermissionRequest` POST before sending the
  submit. The receiver dispatches a delivery to the adapter before the client can observe the
  response completing, so a resolved fetch in the child means the speech is already recorded in
  the parent. There is no window left: the submit cannot be sent until the precondition holds.
  The bespoke 5-second deadline is deleted and the file runs on one 400ms deadline again.
- **OpenCode's stalled-run test — causal.** `node:test` mock timers freeze the clock; the test
  consumes events until a `tool_use` arrives, and only then advances exactly 600ms. The event IS
  the precondition, observed in the adapter's own output, so waiting on it proves the thing the
  assertion needs rather than standing in for it.
- **The four no-content tests** (two OpenCode, two Kimi) — **not causal; a bounded assumption.**
  They cannot use the proof above: their whole premise is that the child's output produces NO
  event, and `turn.heard` is private with `snapshot()` not exposing it, so there is nothing
  observable to wait on. Instead the fixture reports on itself — a marker file the stub touches
  after its writes return, content-neutral by construction — and the test then yields a bounded
  number of event-loop turns before advancing the frozen clock. The marker PROVES the child
  finished writing. It does not prove the adapter read or counted those bytes; that step rests
  on available pipe data being delivered within those turns. See "What the fixture barrier does
  not establish" below.

So the first two remove the race outright, and the last four replace a race against process
spawn — fork, exec, shell startup, a `cat` — with an assumption about pipe delivery into an
already-parked event loop. Both are large improvements over a fixed deadline, and they are not
the same kind of claim.

All `no message/tool_use event exists` assertions and all verdict/provenance assertions are
unchanged; that is what keeps these tests pinning the gap they were written for.

### Mutation evidence

Each path was proven by deleting the line it depends on and confirming the right test fails on
the right assertion. Every control was restored byte-for-byte, verified by sha256:

| removed | fails | on |
|---|---|---|
| `ClaudePtyHookAdapter`'s `#producedBeforeTurn` handling | `claude: a turn that spoke and then went quiet …`, alone | the launch-caveat assertion |
| `turn.heard += 1` in `OpenCodeRunAdapter.#onRecord` | its record test and its stalled-run test | the launch-caveat assertion |
| `turn.heard += 1` in OpenCode's stderr callback | its stderr test, alone | the launch-caveat assertion |
| `turn.heard += 1` in `KimiPrintAdapter.#onRecord` | its record test, alone | the launch-caveat assertion |
| `turn.heard += 1` in Kimi's stderr callback | its stderr test, alone | the launch-caveat assertion |

The stdout and stderr halves of `heard` are separately pinned in both adapters — neither
control disturbed the other's test.

### What the fixture barrier does not establish

It covers the part that blows out under load: fork, exec, shell startup, a `cat`. It does not
PROVE the adapter counted the bytes, because there is no observable to assert on. What follows
the marker is a bounded number of event-loop turns with the data already readable in the pipe —
a far smaller and far less load-sensitive assumption than the one it replaces, but an
assumption. If these flake again, that is the line to look at, and the answer is an observable
for `heard`, not more yields.

### A second defect in the same file, unrelated to any clock

`a provider failure the child announced reaches the verdict` failed on `the turn must settle`,
and that test sets no `watchdogMs` at all. It collected events from a detached `for await` loop,
slept a flat 600ms, and asserted the turn had ended — a guess about how fast the machine is
(spawn `sh`, print two records, exit 1, settle) rather than a wait for the event it was about.
It now does `await nextTurn(session)` and asserts against the returned events; every verdict and
provenance assertion is unchanged, and it went from 603ms to 166ms.

### Three fixture defects found on the way, all worth keeping

- **A failing Kimi test hung instead of failing.** `KimiPrintAdapter` starts a `HookReceiver`, a
  listening server closed only by `close()`, and these tests called `close()` on the success
  path only. An assertion that threw leaked it and the process never exited: six copies sat for
  ten minutes with all thirteen tests already reported, and a negative control could not be read
  until this was fixed. Both now close in `finally`. OpenCode's file holds no receiver and was
  never affected.
- **A mocked clock leaked out of a failing test.** `t.mock.timers.enable()` replaces a global,
  and a manual `reset()` at the end of a body is skipped when an assertion throws — so the
  frozen `setTimeout` reached whatever ran next, and the next test waiting on a real deadline
  never woke. All five mocked-clock tests restore through `t.after()`, which runs on both paths.
  A guard that fails by hanging is a guard that gets re-run rather than read.
- **`exec sleep`, not `sleep`, in every hanging stub.** Otherwise the shell stays alive as the
  parent and `sleep` is a grandchild holding the inherited stdout pipe, so SIGTERM ends the
  shell and leaves the stream open. That is a real adapter case with its own dedicated test and
  a real grandchild; in these stubs it only made every hang test wait out the adapter's 250ms
  post-exit grace for nothing. Unloaded, `kimi.test.ts` went from 35.2s to 2.3s.

### Whole suite, and the one thing still unexplained

`npm test` on the four-file change, run against the pristine-main loop for load: **1257 tests,
1231 pass, 0 fail, 26 skipped, 359.1s**, no failure text of any kind. Every hardened case is
green and faster than it was — Claude's spoken test 1828ms, OpenCode's four at 207/283/417/736ms,
Kimi's two at 391/841ms.

`integrationRed` passed at **4114ms**, against 11166ms in the previous full run on this tree and
11771–12882ms across ten runs on pristine `main` below. The suite as a whole went 461.4s →
359.1s over the same interval. That is consistent with `exec sleep` freeing a
`--test-concurrency=4` slot roughly 33 seconds earlier and easing contention for everything
sharing the run, but it is one sample with differing background load and is not established.
None of these durations bears on why the original run failed; see the paragraph on why total
duration is non-diagnostic, below.

**The 10-run loop on pristine `main` did not reproduce anything.** It has now run, and the
result is a clean negative:

| | |
|---|---|
| runs | 10 of 10, `status=0` |
| per run | 1257 tests, 1231 pass, **0 fail**, 26 skipped |
| red tests, all runs | **none** — no `✖`, no `AssertionError`, no failure text anywhere |
| suite duration | 549–568s (mean 557) |
| `integrationRed` | passed 10/10, **11771–12882ms** (mean 12304) |
| `a run that produced records and then stalled …` | passed 10/10, 854–856ms |

**What that does and does not tell us.** It did not reproduce `integrationRed`, and it did not
reproduce the OpenCode test #154 names. The second of those is expected and is not evidence of
anything: this loop runs one suite at a time, and the fixture races above need roughly six
concurrent copies of a file to go red — a green result here is a statement about this
configuration, not about whether those races exist. They demonstrably do; see the rates above.

For `integrationRed` it is a genuine 0/10, and it leaves the original occurrence unexplained.
The durations above are recorded as raw measurements and nothing is inferred from them. In
particular, that they sit below the 14943ms of the failing run does NOT argue the failure was or
was not slowness: without the assertion text, a total duration cannot say where inside the test
the time went, or which assertion failed, or whether the run failed early on a missed window or
late after slow work. Total duration is non-diagnostic here.

So: `integrationRed` has now passed 10/10 full-suite runs on pristine `main`, 12/12 simultaneous
targeted runs, and one run with its entire event loop held under `SIGSTOP` for 16 seconds inside
the window where it previously failed (19.4s total) — which rules out a comparable missed-timer
window and nothing more. **The cause of the original failure remains unknown**, and on the
present evidence it is a single unreproduced occurrence rather than a diagnosed defect.

The one thing that would have settled it was never captured: what the failure actually was. If
it appears again, keep the assertion text and the file it came from before anything else.

---

## LIVE: #156's premise does not hold on main — the unverified-generation guards live only in the uncommitted fix-36 worktree

**Subject: #156's premise does not hold on main — the unverified-generation guards live only in the uncommitted fix-36 worktree.**

1. The defect shape is real on main: both PTY adapters answer `snapshot()` from a synthesized object before the transcript view exists (`src/adapters/claude.ts:1658-1671`, `src/adapters/codex.ts:1219-1232`), carrying `compactionGeneration: 0` with nothing distinguishing "not looked" from "looked, none". But the guards the issue says it passes — `containedFallback`, `UNKNOWN_GENERATION` at `src/rotation/rotate.ts:484`, the `#considerRotation` withholding — exist only as uncommitted work in the fix-36 worktree (`containedFallback` appears in no ref; `git grep` on main finds neither symbol). The issue was filed against that state.

2. Every consumer of a snapshot's `compactionGeneration` on main, and whether a pre-view snapshot can reach it:

   - `#considerRotation` (`src/relay/relay.ts:4555`, plus downstream `#acknowledge`/`#answeredByReplacement` at `src/relay/relay.ts:4778-4782, :4823-4827, :4849, :4880-4890, :4894-4897`): runs only after a completed implementer turn (`src/relay/relay.ts:7335`). A completed first turn means Codex's `SessionStart` hook already delivered `transcript_path` (`src/adapters/codex.ts:557-563`); Claude's view is created at boot (`src/adapters/claude.ts:1026-1030`). Cannot observe pre-view — and would be inert anyway, since `baselineGeneration` starts at 0 (`src/relay/relay.ts:2246`) and `assess()` would see no delta.

   - `runReport` (`src/relay/report.ts:286-296`): reachable — a never-prompted Codex participant is snapshotted pre-view and the report records 0. But a session that never received a turn has no context and nothing to compact, so a verified read would also return 0; the report is descriptive, nothing acts on it, and it already carries the documented permanent-0 limitation from `KimiPrintAdapter`/`OpenCodeRunAdapter` (`src/adapters/kimi.ts:727`, `src/adapters/opencode.ts:765`).

   - `rotate` (`src/rotation/rotate.ts:412`): reachable — both adapters initialize `#state = 'running'` (`src/adapters/claude.ts:1443`, `src/adapters/codex.ts:1027`), so rotating an idle never-prompted Codex seat records `handoff.compactionGeneration: 0` from a pre-view snapshot. On main that field is written once and read nowhere in production (`src/rotation/handoff.ts:74` is the definition; only tests read it). Dead data unless an external embedder reads it — and again the value equals what a verified read of a never-prompted session would produce.

   - Snapshot reads at `src/workspace/sessionRecord.ts:1408` and `src/relay/relay.ts:3720` consume only `snap.turns`; unaffected.

   **Conclusion:** there is no live misstatement of fact on main today. What is missing is provenance — a 0 meaning "not looked" is indistinguishable from "looked, none" — and no consumer on main acts on that distinction.

3. The falsifier answer, recorded for whoever lands fix-36: there, `containedFallback` is documented as "this snapshot is the last projection the view was in a position to build rather than one read just now" — a STALE-read marker, set when a bounded transcript read fails and a prior verified projection is served. "No view yet" is a NEVER-read: no projection exists and none ever did. Flagging the pre-view returns with it folds a second, distinct condition into the flag — a widening, not a restatement. If fix-36 does that, its contract doc must say the flag now covers both, and the guard comments (which reason about a fallback of a prior read) must be re-checked against a case with no prior read.

4. No behaviour change was made; #156 stays open.

---

## A forced resume records what it overrode, and what its send met (#125) — done, awaiting the operator

**Done [2026-08-23] on `fix-125`. The issue is deliberately not closed; the call to close is the operator's.**

WHAT FORCE OVERRIDES TODAY, because the issue quotes a guard that no longer exists. #117 moved
the send precondition onto turn state, so the CPU-sampling refusal the issue describes is gone.
The console guard in `resumeRun` refuses `/continue` when a seat the pause scopes it to sample
has an open `activeTurn` over the child's own `turn_start`/`turn_end` events — bypassed when the
pause's verdict was superseded by a completed replacement, and when the open turn is a withdrawn
record rather than an observation (#66) — with the CPU reading printed as colour beside the
refusal and deciding nothing. `/continue force` overrides exactly that refusal, and nothing
else. In particular it does NOT bypass the relay's own precondition: `session.send` has exactly
one call site in the relay, inside `#exchangeTurn`, immediately after `#awaitSendable`, so every
send a forced continue releases — including queued human text — first waits out a live turn,
bounded by `sendPreconditionMs`, and ends the run `peer_busy` (cancel-first) if the turn never
ends. A fatal force therefore reads `peer_busy` today, not the `transport_failed` the issue
names; the console refusal's "sends anyway, into a child that may still be working" wording is
a pre-#117 leftover, left in place because console wording was out of scope here.

THE RECORD. One `ForceRecord` per `/continue force`, ledgered on the `RunHandle` (the one object
both the console that applies the force and the relay that learns the outcome can see), exposed
through `Relay.forceRecords`, and surfaced in both documents a reader actually has — the status
file and the run report — spelled out as an empty array when nothing was forced (#103), so "no
forces" and "this build does not report forces" are different facts. Each entry carries:

- `overrode` — per sampled seat, `describeActiveTurn` of its open turn or an explicit `null`,
  with the liveness colour when one was sampled: the evidence the guard read at the moment of
  the force, gathered by the guard's own reads.
- `refusedFirst` — whether a refusal was already on the pause. Forcing past a seen refusal and
  forcing blind are both legal and are different populations when the guard's refusal rate is
  scored; recording them as one is the contamination #75 named for rotations.
- `send` — the fate of the FIRST post-force send to an overridden seat, stamped at
  `#awaitSendable`'s three ordinary exits: `sent` (no open turn), `sent_after_wait` (still
  mid-turn, turn ended inside the bound — the near-miss population, recorded rather than argued
  about), `expired` (the bound lapsed against the live turn). `null` means no send to an
  overridden seat happened before the run ended; teardown mid-wait is a real case and stamps
  nothing.
- `followedBy` — the run's terminal outcome and its distance from the force in completed turns
  and milliseconds, stamped when the handle settles.

THE FALSIFIER, ANSWERED. Only the immediate send fate is the force's own consequence; the
terminal outcome is the run's. So the entry records both as facts and never a causal label:
`send.outcome === 'expired'` marks a force whose send met a still-live turn; `followedBy` says
what the run later did and how far away, and a run that ends three turns on died of its own
affairs. "Forces that were justified" and "forces that killed a run" are separated by reading
the record, not by a claim the ledger makes — a ledger that overclaims is worse than one that
records less. An earlier cut (preserved at `881d9d5`, reverted at `9da62e5`) tried to make
`turnsCompleted === 0` the separator by skipping the advisor re-ask after a forced continue;
that changed what a force DOES — policy, not recording, which the task forbids — and bypassed
`#routed`, which carries #79's targeting denominator. The send's fate is the honest linkage and
the run loop is untouched.

VERIFICATION. Both populations were driven through the console and read off the record, never
off rendered output (#109): refused-then-forced into a held turn ends `peer_busy` with
`send: expired`; a blind force on an idle seat ends normally with `send: sent`; and the two
entries differ in the load-bearing fields. Every new assertion was mutation-checked — the
recording disabled, the assertion observed to fail, the tree restored byte-for-byte — and the
full `npm test` gate (typecheck first) ran 1349 pass, 0 fail.
