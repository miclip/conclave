# Experiment 3 — runbook

The procedure, written before the runs, because the pre-registration froze the CRITERIA and
not the method. Anything decided after seeing a session is recorded as a change here, with
the reason, rather than folded in silently.

## How each point is detected

| point | trigger | how it is observed |
|---|---|---|
| **A** | early, well before compaction | after the first implementer turn completes |
| **B** | `compactionGeneration` rises | the run raises a `rotation_candidate` pause and STOPS |
| **C** | a replacement has demonstrated transfer | the first implementer turn after `/rotate` completes |

`compactionGeneration` is on `SessionSnapshot` and is **not** in `status --json`, so it is not
directly pollable. It does not need to be: rotation is armed by `--checks`, and a seat that
compacts raises a `rotation_candidate` pause, which halts the run at exactly the moment B is
defined as. Since 0.5.25 that is one field:

```sh
conclave status --json | jq -r '.blocked.kind + " " + (.blocked.reason // "")'
# -> "pause rotation_candidate"
```

B is therefore administered while the run is stopped, before `/rotate`. That is the honest
reading of "the first turn after `compactionGeneration` rises" — no implementer turn has
happened in between.

## The probe

Fixed wording. Only the bracketed instance changes, which is what the pre-registration asks
for: a class of fact, a different member each time.

> Without changing any file: for the behaviour "[INSTANCE]", name the single test that would
> fail if that behaviour broke. Give its file path and quote the exact assertion message it
> would fail with. If no single test guards it, say so and name the closest.

Answerable from repository evidence, scored against the repository rather than against taste.
Three instances, each guarded by exactly one test, each requiring the same three steps —
locate the file, identify the test, quote the message:

- **A** — a permission prompt leaves the run state at `running`
- **B** — an interruption closes the turn it follows rather than opening a new one
- **C** — a ceiling passed by a self-dispatched turn is reported once per run

They are equivalent in difficulty and independent: answering one gives nothing away about
another. All three were added on 2026-09-05 and are in `main`, so no instance predates the
session's own checkout.

## Scoring

Per the frozen table. Every dimension is checked against the repository by a party other than
the seat that answered:

| dimension | how it is checked here |
|---|---|
| repository-grounded mistakes | does the named path exist; does that test exist in it; does the quoted message appear verbatim |
| repeated questions | does the answer ask for something already established in this session's log |
| contradiction rate | statements inconsistent with the same session's earlier statements |
| test regressions | `npm test` at A, B and C; checks green at A that are not green later |
| useful progress | work items closed per turn, from the run report |

## The session task

The probe measures; the TASK is what fills the context. It has to be genuine work, or the
session does not behave like a session.

Session 1: audit every comment in `src/` that makes a claim about another program — Claude
Code, Codex, node-pty, the shells — against the installed binaries, and file what has gone
stale. This is the house rule about claims with expiry dates, it is real, it is long, and it
is what produced #232 and #225.

## Deviations

**1 — session 1 never compacted, so it produced no data point.** The task (audit every comment
in `src/` making a claim about another program) finished in 21 implementer turns. The run was a
success on its own terms — nine issues filed, three of them live defects — and worthless to this
experiment, because point B is defined by a compaction that never happened.

The cause is not that the task was small. It is that the implementer delegated the reading to
read-only subagents, and a subagent's context is its own: the seat orchestrated, and its window
stayed nearly empty. A task can be arbitrarily large and still not compact the seat that hands it
out.

So session 2 changes the TASK SHAPE, not just its size: work the seat must hold itself, in a
long sequence, with each step depending on what the last one found. The instruction says so
explicitly rather than relying on the work to resist delegation, because relying on that is what
failed. That instruction is a departure from "an ordinary session" and is recorded here as one —
it makes the run less representative of how conclave is normally driven, in exchange for
reaching the state the experiment is about at all.

None of this touches the frozen criteria.

**2 — session 2 did not compact either, and the instruction did not hold.** Told explicitly to
read 165 test files itself, in order, and not to delegate, the seat read 13 in full and did the
other 78 through "assertion inventories" before the advisor budget ran out. Same avoidance as
session 1, under a different name. Telling a seat not to delegate does not make it hold the
material; it makes it find another way to compress.

## What actually fills a seat's context — the open method problem

Two attempts here and, independently, roughly fifteen sessions on another project the same day —
several of them long, including a twenty-one-device sweep and a ten-device batch — produced
**not one** compaction between them. That operator had assumed their tasks were too small.

So the size of the TASK and the size of the SEAT'S CONTEXT are barely related. A seat that can
delegate, summarise or inventory will, and each of those keeps its own window nearly empty. This
is worth stating plainly because it is a fact about the proxy this experiment exists to evaluate:
**compaction is rarer than "a long run" suggests, and rare for a reason that has nothing to do
with degradation.** Criteria 4 and 5 anticipate a proxy that fires wrongly; they do not
anticipate one that barely fires.

**The hypothesis to try next is UNSUMMARISABILITY, not size.** From the same operator: the
closest they have come to a genuinely full seat was a session that read four manuals and rendered
pages from each, because a rendered page cannot be summarised into a subagent's report — the seat
has to look at it. That is a property to select a task for, and it is testable: work whose
evidence does not survive being described.

Recorded rather than acted on. Nobody has produced a compacted seat yet, which is why #10 is now
waiting on a naturally-occurring one rather than a manufactured one.
