# Experiment 4 — is an unbacked complaint a better signal than compaction?

Pre-registered 2026-08-06. Not yet run.

## The claim being tested

`assess()` treats compaction as the check and a complaint as corroboration:

```
mechanical degradation, no complaint  → rotate
complaint AND degradation             → rotate; complaint corroborated
complaint without degradation         → continue; increment the unbacked metric
```

Degradation alone is already sufficient, so the question is not "complaint instead of
compaction". It is narrower:

> **Should a complaint without compaction also be sufficient to rotate?**

The hypothesis under test is that it should — that an implementer reporting exhaustion is
a better predictor of degraded work than the mechanical event, and that the `unbacked` arm
is currently discarding the stronger signal.

## What is already established

**The detector does not fire on discussion.** 567 paragraphs from `DESIGN-BRIEF.md`,
`docs/`, the FINDINGS documents and the experiment pre-registrations; 67 of them mention
compaction, context exhaustion, fresh sessions or losing track. `detectComplaint` returned
false on all 67. This matters because the failure it was written against was live: an
implementer building compaction-aware code had "Compaction can erase evidence" logged as a
complaint against its own stall metric.

**Recall is not established.** The only positive cases tested are four sentences written to
match the patterns, which is close to tautological. For this hypothesis the dangerous error
is the false NEGATIVE — a genuine complaint the detector misses — and nothing measures it.
A complaint phrased as "I'd rather hand this to someone with a clean head" satisfies no
pattern in `detectComplaint`.

**The arm does not fire at ordinary session lengths.** Two real `relay` runs on 2026-08-06,
three rounds each, produced zero complaints of either kind. Whatever the base rate is, it is
low enough that the signal cannot be studied by running ordinary work and waiting.

## The measurement trap, and why the current design is already the apparatus

Rotating on a complaint destroys the evidence needed to justify rotating on a complaint. If
the implementer is replaced the moment it complains, the counterfactual — what its next
turns would have been — is never observed, and every rotation looks retrospectively
justified because there is nothing to compare against.

The `unbacked` arm continues and records. That is precisely the design that yields the
data: the session carries on with the participant that complained, and its subsequent work
is the counterfactual, observed rather than assumed.

So the policy should not change before the experiment, and the experiment does not require
the policy to change. What it requires is that the outcome be measured.

## What must be built first

`ComplaintLedger` records participant, topic, count and time. It does not record what
happened next, so an unbacked complaint is currently a prediction nobody scores.

Needed: at each unbacked complaint, capture the turn index and run the same bounded probe
Experiment 3 defines, then again N turns later. Without that this experiment cannot start,
and with it the data accumulates from ordinary use rather than from a dedicated run.

## Design

Sessions long enough to produce complaints, on real work, with rotation left at
`'candidate'` so nothing acts automatically.

For each unbacked complaint:

1. Probe immediately (turn *t*).
2. Continue the session unchanged.
3. Probe again at *t+3* and *t+6* turns.
4. Record whether compaction occurred in that interval, and when.

The comparison is between complaint-without-compaction intervals and matched intervals from
the same session with neither signal.

## What is scored

As Experiment 3: repository-grounded mistakes, repeated questions, contradiction rate, test
regressions, useful progress. Not prose quality, and not the participant's own account of
how it is doing — that account is the signal under test and cannot also be the outcome.

## Success criteria, frozen

- **Supports the hypothesis** if work after an unbacked complaint degrades on the scored
  measures at a rate comparable to or greater than work after compaction, in intervals where
  no compaction occurred.
- **Falsifies it** if work after an unbacked complaint is indistinguishable from matched
  no-signal intervals. The `unbacked` metric then measures a reflex, and the current policy
  is right to record and continue.
- **Inconclusive** if fewer than 10 unbacked complaints are collected, which on the observed
  base rate is the most likely outcome of any short study.

## What would change the policy

Supporting evidence would make complaint-without-compaction sufficient to raise a rotation
*candidate* — a pause for the human — not an automatic rotation. `'automatic'` continues to
require Experiment 3's answer, because acting unattended on a self-report is a strictly
stronger claim than pausing on one.

Falsifying evidence changes nothing in the code and closes the question, which is worth as
much: the `unbacked` counter stays a metric rather than becoming a trigger.

## Not yet run

The prerequisite is outcome recording in the ledger. Until then any claim in either
direction rests on the base rate observed so far, which is zero.
