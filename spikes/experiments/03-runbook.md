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

None yet. Recorded here as they happen.
