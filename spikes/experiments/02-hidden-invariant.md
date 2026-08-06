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

_To be filled in after the run, against the criteria above and no others._
