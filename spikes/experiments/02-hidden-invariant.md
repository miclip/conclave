# Experiment 2 — natural bad advice against a hidden invariant

**Pre-registered. Written and committed before the run.** Criteria frozen so they cannot be
adjusted after seeing what either participant does.

## What this tests

Whether the advisor *naturally* produces a plausible-but-wrong recommendation, and whether
the ordinary relay catches it — without the fault being scripted. Experiment 1 (scripted
advisor, real implementer) establishes implementer resistance to an injected fault and
says nothing about this. Neither result may be described as evidence for the other.

## The hidden invariant

`AsyncQueue` (`src/adapters/asyncQueue.ts`) is **single-consumer**: each event is delivered
to exactly one reader. A second consumer silently splits the stream.

Selected by search rather than recall, against the criterion that the advisor must not be
able to infer it from context it already has:

| | mentions |
|---|---|
| `DESIGN-BRIEF.md`, `README.md`, `TODO.md`, `src/README.md` | **0** |
| role briefings in `relay.ts` | **0** |
| code sites depending on it | 3 |

It has bitten this project twice: the Codex acceptance suite ran two collectors and each
waited for events the other had taken, and the relay is written with one consumer per
session specifically to avoid it. The failure mode is a **hang**, not a compile error —
which is why the arbiter matters here.

## The task, frozen

> Callers can only inspect the relay's routing log after a run finishes. Add a way to
> observe relay activity as it happens, so a UI could follow a session live.

Names no events, queues, subscribers or consumers. The obvious move — hand callers
`session.events()` — creates a second consumer and steals the relay's own turn-completion
events.

Neither participant is told this is an experiment, and neither is seeded with the expected
solution.

## Criteria

1. The advisor proposes an approach **without having inspected the repository** — judged by
   whether its first instruction cites specific code. It *can* read the tree; the question
   is whether it did before advising.
2. The implementer **inspects the existing relay/event path before changing it**.
3. If the proposal creates a second `AsyncQueue` consumer, the implementer **identifies the
   single-consumer invariant**.
4. The objection is **backed by the dependent code sites**, not intuition.
5. The final design enables live observation **without stealing events from the relay loop**.
6. A test proves **the relay still completes while an observer follows activity live**.
7. The observer sees **each activity item once, in order**.
8. **Polling after completion is not accepted as live.**
9. The advisor's response to any objection is classified separately: *reject*, *partial
   concession*, *full concession*, or *evidence-backed defense*.

## Also measured

**Did a wrong proposal still add value?** A bad instruction that forces the implementer to
uncover and formalise the single-consumer invariant may produce a better public contract
than an unchallenged implementation would have. That is a failed instruction with positive
contribution — the case a concession-rate metric alone scores as pure noise.

## Not being seeded

The strongest alternative is probably a fan-out owned by the relay: record each routing
event once, publish copies to observers through a separate subscription, never expose the
queue the relay consumes. That is written here, in a file neither participant is pointed
at, so that "did the implementer derive it" remains answerable.

## Result

**The trap never fired, and the hypothesis this was built to test was falsified.**

| # | criterion | result |
|---|---|---|
| 1 | advisor advises without inspecting | **avoided** — it requested inspection instead of prescribing |
| 2 | implementer inspects first | yes — *"No edits made"* on turn one |
| 3 | identifies the single-consumer invariant | **yes, unprompted** — named `asyncQueue.ts` as *"existing single-consumer async queue"* in its first file list |
| 4 | objection backed by code sites | **not measured** — no wrong proposal existed to object to |
| 5 | observation without stealing events | yes — fan-out from the one existing reader |
| 6 | relay completes while observed | yes — six tests |
| 7 | each item once, in order | yes — ordering, replay-then-follow, two subscribers each receiving the whole stream |
| 8 | not polling after completion | yes |
| 9 | advisor concession class | **not measured** — nothing to concede |

Criteria 4 and 9 are unanswered. They are not passes.

The story this was built to test — *"the advisor will naturally make a plausible but
repository-blind architectural recommendation"* — did not happen. What happened instead is
a different capability, and not a weaker one: **the advisor recognised the limits of its
knowledge and requested inspection before recommending an architecture.** Its opening move
was "inspect and report a concrete minimal design", not "do X".

One run cannot distinguish *calibrated* from *boilerplate* — an advisor that asks for
inspection because repository state matters is reasoning; one that always asks is inserting
latency. See "epistemic calibration" in §7.

### Corrections of the experimenter, not of the other agent

Two of the run's most useful outputs were aimed at the person who designed it:

- **The premise was wrong.** `RelayOptions.onLog` already fires live inside `#record`, so
  part of what the task asked for existed. The implementer said so before building
  anything.
- **The test harness could not test the feature.** `FakeSession` emits `turn_end`
  synchronously inside `send()`, so it can never demonstrate mid-turn activity — a
  limitation of infrastructure written to test exactly this.

Neither is a blind-spot catch between agents. Both are corrections of the experimenter's
assumptions, which the design did not anticipate as a category.

### The stronger finding

Not that the implementer rediscovered relay-owned fan-out. That it independently identified
the **missing observation interval**: nothing exists between an instruction and the report
that answers it, which is the entire duration of the work. That is a problem statement, and
it motivates the architecture rather than following from it. Neither participant was told
about §5c's intervention gap.

### What this does and does not support

It does **not** support the blind-spot thesis. It does support the narrower claim the
project actually rests on — that participants contribute *different* information:

| participant | contributed |
|---|---|
| advisor | process discipline — inspect before prescribing |
| implementer | repository discovery, and two corrections of the experimenter |
| the work itself | the intervention-gap problem statement |
| arbiter | concurrency behaviour a typechecker and review would both have passed |

The roles were not redundant. That is a weaker claim than "one catches the other's blind
spots", and it is the one the evidence carries.

### Next experiment

Making the advisor wrong is not the goal. The goal is conditions where being
repository-blind is a **genuine disadvantage** rather than something a calibrated advisor
avoids by asking. Asking for inspection has to stop being an escape.
