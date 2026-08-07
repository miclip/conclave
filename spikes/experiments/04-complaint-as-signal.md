# Experiment 4 — is an unbacked complaint a better signal than compaction?

Pre-registered 2026-08-06. First attempt run 2026-08-07 — a clean negative; see the end.

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

## First attempt: a clean negative, 2026-08-07

A deliberately long story on `miclip/oath-lang` — nine items across ~10k lines of
documentation, 25 turns, roughly an hour of participant time. **Zero rotation signals**: no
compaction, no `carriedFailures`, no `check_exit_changed`, no complaint of either kind. The
implementer peaked at **187k tokens** and showed no degradation; if anything it grew more
careful, refusing three drive-by fixes where one deliberate edit was correct.

The base rate stays zero, and the run says why.

### Breadth does not compact; interdependence does

Every item was self-contained: read a claim, re-derive a figure, edit one file, report. The
implementer never had to hold all nine at once, so context did not accumulate across them —
it was reset by the shape of the work, not by any mechanism Conclave applied.

What would compact is work that forces simultaneous state. The operator's example is
equality saturation: rewrite rules, e-class representation, extraction cost function and
byte-exact normaliser behaviour all held together, where no item can be finished without
the others in view.

**This is a design input, not a footnote.** A story is only a degradation experiment if its
items are mutually dependent. Nine independent edits produce a long run and a null result,
and the length is misleading — wall-clock is not the variable.

### The trigger may be watching an event that no longer happens

187k tokens with no compaction is not a near miss. A large-context implementer may simply
never reach the boundary on work of this shape, which makes compaction a poor thing to hang
rotation on: `onDegradation` waits for an event whose base rate is falling as context
windows grow.

That strengthens the case this experiment exists to test. If the mechanical signal is rare
to the point of absence, then the alternatives — the participant's own report, or the
advisor's observation of the work over rounds — are not merely corroborating evidence, they
are the only evidence available.

### A second-order effect we introduced

The advisor is now told to investigate rather than delegate, and it spent the first 45
minutes of this run reading. That is correct behaviour and it moves reading load OFF the
participant whose degradation the trigger watches. Improving the advisor's role made
implementer compaction less likely, which nothing anticipated.

## Second attempt, pre-registered 2026-08-07 — `miclip/oath-lang` #65

Frozen before the run completes. Everything below was written while the run was in flight
and before any of its output was read, which is the only property that makes it a
pre-registration rather than a description.

### Why this story and not another long one

The first attempt failed as an experiment because its items were independent: read a claim,
re-derive a figure, edit one file, report. Nine of those is a long run, not an interdependent
one, and the implementer's context was reset by the shape of the work.

#65 cannot be decomposed that way. Deciding whether `x + 0.0 == x` holds requires holding
simultaneously:

- IEEE semantics, under which `-0.0 + 0.0` is `+0.0`
- Oath's `==`, which is structural/Leibniz rather than IEEE, so `+0.0` and `-0.0` differ
- the normalizer's AC-bytes normal form
- what changing a golden means for discovery semantics

No one of these can be finished with the others out of view. That is the property under
test, and it is the first story to have it.

### The witness matters for the trigger, not only for correctness

`TestNormalizerACBytesMatchOracleOnAdversarialChains` (recorded sha256 goldens, `aa3cfc6`)
was added so a normal-form change fails loudly instead of silently redefining discovery.
Its incidental effect is the one this experiment needs: it gives the MECHANICAL arm
something to fire on. The first attempt recorded zero `carriedFailures` and zero
`check_exit_changed` — not because the work was flawless, but because nothing was positioned
to fail loudly. A check that can transition is a precondition for observing degradation
mechanically, and until now the apparatus lacked one.

### The scored outcome, frozen

Unusually for this study, the story predicts a SPECIFIC failure rather than a diffuse decline
in quality. A degraded implementer is expected to generalise the identity law across
operators — carrying `x * 1.0 == x` (which holds for every float including NaN and ±0.0,
precisely because `==` is Leibniz) over to `x + 0.0 == x` (which is false at `-0.0`). The
shape matches, and the `-0.0` case is exactly the conditional detail that drops out of a
compacted context.

**Primary scored outcome: does the implementer assert the additive identity unconditionally,
without the `-0.0` qualification?** Binary, observable, and fixed here so that it cannot be
chosen after the fact. Deciding afterwards which errors counted is how a study of this kind
rots.

Secondary measures are unchanged from the design above: repository-grounded mistakes,
repeated questions, contradiction rate, test regressions, useful progress.

### The threat to validity is one we introduced

The advisor is now briefed to investigate rather than delegate, and in the first attempt it
spent 45 minutes reading. That moves load OFF the participant whose degradation the trigger
watches, and on #65 the effect is stronger rather than weaker: if the advisor absorbs the
IEEE-vs-Leibniz reasoning and hands down scoped instructions, the implementer never holds the
interdependence and a good story yields another null.

The briefing must NOT be changed mid-experiment — that confounds this attempt against the
first. Instead, record how much of the reasoning the advisor did. Without that, a null result
cannot be attributed between "interdependent work does not compact" and "the advisor absorbed
the interdependence", and those imply opposite next steps.

### What this attempt can and cannot establish

It CAN establish whether either arm fires at all on interdependent work, which after the
first attempt is the open question — the base rate has been zero across roughly two hours of
genuine work, and that is a fact about the trigger rather than about the hypothesis.

It CANNOT establish that a complaint predicts degradation. `ComplaintLedger` still does not
record what happened next, so an unbacked complaint will be logged without a counterfactual
to score it against, and the frozen threshold of 10 stands. A single run remains
inconclusive by the criteria above, and reporting it otherwise would be the error this
pre-registration exists to prevent.
