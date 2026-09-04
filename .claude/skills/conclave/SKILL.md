---
name: conclave
description: Drive a conclave run as the operator - start it, read what it is doing, answer the decisions it raises, and act on how it ended. Use when running or supervising conclave sessions, or when a conclave run has paused, refused to start, or ended non-zero.
---

# Operating conclave

Conclave runs two or more agent sessions against one goal: an **advisor** that holds the thread and **implementer** seats that do the work, optionally a **reviewer**. You are the operator. Your job is to start it, answer what it asks, and act on how it ended.

Everything here is about judgement. `conclave --help` and `/help` inside the console carry the full syntax; reach for them when you need a flag, not to decide what to do.

## Starting a run

```
conclave session "<goal>" --implementers "claude, claude"
```

`session` keeps a pause open and waits for you. `relay` returns an outcome and ends at the first pause point, so a pause has nowhere to suspend to — **use `session` unless you specifically want a run that cannot be resumed.**

`--dry-run` prints the plan and starts nothing. It is the answer to "is this invocation what I meant", and it costs a moment.

**Ceilings put the intended shape of the run into the record.** `--rounds 6` is a claim about the work, not a budget: a run that hits a ceiling ends loudly and non-zero, so a stop is never mistaken for a finish. Set them because you have a view about how long the work should take. Absent means no limit, which is a real and sometimes correct choice.

## Reading a run without scraping the console

```
conclave status --json
conclave events --follow
```

`status` answers what it is doing now: seats, what each is working on, the current pause with its evidence, per-turn verdicts. `events --follow` is the same run as NDJSON and **wakes you at a decision point instead of making you poll** — prefer it to a loop around `status`.

Two fields, and they are not the same question:

- `state` is what the session last said about itself
- `alive` is whether its process exists

`state: running` with `alive: false` is a crashed run, not a busy one. The record names that pair `abandoned`. A liveness question is answered by `alive`, never by `state`.

## Answering a pause

At a pause, **a plain message is the answer** — you do not need a command. The run resumes on it.

```
/continue                    resume with nothing further to say
/continue <text>             resume, and say that
/continue force              resume even though a child reads mid-turn
```

`force` is the whole word and nothing after it; anything else is a message rather than an override.

For a multi-line answer, open a block **on its own line**. A command cannot open one:

```
<<EOF
first line

third line
EOF
```

Everything up to a line reading exactly `EOF` is one message, blank lines and all. Any word works as the tag. `>implementer <<EOF` sends the block to one seat.

## Reaching a human when you are the operator

When a run is `--operator agent`, **you** are the operator, and the seats escalate to you. What
you do not get by default is a way to reach the person whose project this is — so a question only
they can answer has nowhere to go, and the run stalls on it or the seat gives up and flags it.

`conclave notify` is that channel:

```
conclave notify tell "<headline>"                        say something; expect no answer
conclave notify ask  "<headline>" --options a:Yes,b:No   ask, and wait for one of those
conclave notify vetoes                                   collect answers that arrived late
conclave notify log                                      what was asked, answered, and by whom
```

**Conclave never sends these for you.** It does not turn pauses into messages, deliberately: you
have the context that decides whether a human is needed, and it does not. The cost of that design
is that an unasked question is simply never asked.

**Ask for the things an outside view settles**, which is the same rule the seats are given for
escalating to you: a premise in the goal that looks wrong, acceptance criteria you cannot make
observable, a choice between two defensible designs where intent decides. Not permission, and not
progress.

**What travels is deliberately thin.** An allow-list decides which fields reach a transport at
all, and the headline is cut to what the surface can show — no file contents, no diffs, no tool
output. Write the headline as a POINTER: enough to decide whether to look, not a summary someone
might approve on instead of looking.

**An answer is not an instruction.** An option you did not offer is refused rather than passed
through, and free text comes back as a MESSAGE — so "continue, force it" said out loud reaches
you as words, never as `/continue force`. The log records who answered and through which
transport, and a human answer and an agent's are distinguishable in it afterwards.

## Restricting a message, and the pause it can raise

`>advisor <text>` deliberately withholds that message from the other seats, and the record keeps saying so — `/audit` answers who was informed and who was excluded.

If a later instruction touches what a withheld message covered, the run raises an **`authority_conflict`** pause. It stops only the workstream carrying that instruction, and it is yours to answer rather than the advisor's — by construction, since the advisor is the seat the message was kept from.

**The repair the pause is asking for is to hand the withheld message over in full** to the seat that never saw it. Do that and the record moves: the conflict cites that message only against seats it is *still* withheld from. The routing log is unchanged — what happened at the original message still happened — so an audit answers the same historical question it always did.

Restrict a message when the reason to restrict it is real. Broadcasting to avoid a pause you can answer trades a decision you made for one you did not.

## Addressing seats

`>advisor`, `>implementer`, `>implementer-2` — any seat by the id it answers to; `/state` lists them. No prefix reaches everyone. A name no seat has is refused rather than broadcast.

## When it refuses to start

A refusal names the condition and the remedy, and several are forceable. **Read the remedy before deciding it is a wall.**

- **not inside a git repository** — conclave attributes work by diffing the tree, so this is meaningless outside one. `--force` starts anyway; a scratch directory is a real if unusual case.
- **low disk** — a run writes a worktree per seat plus a growing transcript. `--force` overrides it. Above the floor you may instead see a warning and the run starts.
- **participant sessions are live** — someone else's run owns this tree. This one is not forceable, and should not be: starting would overwrite their record of what was dirty before they began.
- **a file is deliberately mutated and was never restored** — a mutation-testing marker outlived its restore. `conclave mutations` says what, `conclave mutations restore <path>` puts it back. This warns rather than refuses.

## How it ended

`relay` and `session` exit non-zero on `transport_failed`, `peer_busy`, `invariant_violated`, `ceiling` and `integration_failed`. Each says something different about where to look:

- `done` — finished
- `ceiling` — a limit you set was reached; the run stopped rather than failed
- `integration_failed` — the work finished and the tree does not pass its own checks
- `peer_busy` — a child stayed mid-turn through the whole send window. About pacing, not transport
- `transport_failed` — conclave lost the ability to observe a turn. This one is worth checking the CLI and the provider for
- `invariant_violated` — conclave contradicted itself. Nothing about the child, network or provider is wrong; the detail names the broken rule
- `escalated` — the agents wanted a human

`status` is non-zero only for an abandoned run, because a run that ended badly still ended and its outcome is in the record.

## Mutation testing

`conclave mutations begin <path>` records a file's hash and keeps a copy before you break it; `mutations end <path>` verifies the restore against that hash and **keeps the marker if the file is not genuinely back**. Bare, it lists what is outstanding and exits non-zero while the tree holds a mutation.

Use it whenever you deliberately break a file to prove a test fails — a crash in between otherwise leaves a reverted fix that looks exactly like work in progress.
