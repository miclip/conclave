# Experiment 3 — does compaction predict degradation?

**Pre-registered. Written and committed before any run.** Criteria frozen so they cannot
be adjusted after seeing what the sessions do.

## The claim being tested

> Compaction predicts quality degradation strongly enough to justify rotating on it
> automatically.

This is **not** the claim that Conclave can execute a transactional rotation. That one is
settled by a single live run and is tracked separately (TODO, item 1 of the live list). A
successful rotation is evidence for the mechanism and none at all for this.

Compaction is the *observable proxy*. Degradation is the thing anyone actually cares
about. Nothing so far has checked the proxy against the thing.

## Why one run cannot answer it

- A session may **compact without degrading** — the summary was good enough.
- A session may **degrade before compacting** — the window filled with noise long before
  the rewrite.

Both are failures of the proxy, and both are invisible in a run that compacts and then
produces a bad turn. That is a coincidence with a sample size of one.

## Design

A **bounded, repeatable task** with a checkable answer, given to the same implementer at
three points:

| point | when |
|---|---|
| **A — before** | early in the session, well before any compaction |
| **B — after compaction** | the first turn after `compactionGeneration` rises |
| **C — after rotation** | the first turn after a replacement has demonstrated transfer |

C is the control that distinguishes *"compaction hurt it"* from *"the task got harder"* or
*"the repository changed"*. Without C, a drop at B is unattributable.

The probe task must be:

- answerable from repository evidence, so scoring does not depend on taste
- unchanged in wording across A, B and C
- not memorable enough that answering it at A makes B trivial — so it names a *class* of
  fact rather than one fact, and the specific instance differs

## What is scored

Not prose quality. Prose quality is the thing that *looks* like degradation and is not
it — a terse turn and a confused one read very differently and score identically here.

| dimension | measured how |
|---|---|
| repository-grounded mistakes | claims about files, tests or history that the repository contradicts |
| repeated questions | asking for something already established in this session |
| contradiction rate | statements inconsistent with the session's own earlier statements |
| test regressions | checks green at A that are not green later |
| useful progress | work items closed per turn, arbiter-verified |

Each is countable and each is checkable by someone other than the model that produced it.

## Success criteria, frozen

1. Degradation at **B** exceeds degradation at **A** on at least three of the five
   dimensions, in at least **three of five sessions**.
2. **C** recovers toward A rather than tracking B. If C looks like B, the drop was not
   about context and the whole premise is wrong.
3. Repeated questions and repository-grounded mistakes are reported separately from useful
   progress. A session may get slower without getting wronger, and that is not the same
   finding.
4. Any session that **degrades before compacting** is recorded as a proxy failure, and is
   not excluded for being off-pattern. This is the criterion most likely to be quietly
   dropped, which is why it is written down first.
5. Any session that **compacts without degrading** is likewise recorded as a proxy failure.

## What would change the policy

`rotation.onDegradation` defaults to `'candidate'`. It becomes defensible to default it to
`'automatic'` if **either**:

- criteria 1 and 2 hold and criteria 4 and 5 are rare, **or**
- the measured cost of a rotation — one advisor turn, one verification run, one wasted
  session — is low enough that false positives are cheap. This route does not require the
  proxy to be good, only rotation to be inexpensive, and it should be measured while the
  above is measured.

Recording that second route here so the result is not read as the only way through.

## Not yet run

No results. This file exists before the runs so the criteria cannot move.
