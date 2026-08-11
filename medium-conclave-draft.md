# Introducing Conclave: Claude Code, Codex, and OpenCode in one session

*Different vendors, different authority, one session — without giving up their native CLIs.*

You could always open three terminals and point three coding agents at the same repository. What you could not do is put them in one session — where they talk to each other. One holds the goal and instructs; another does the work and reports back; several work at once without overwriting each other. Every message is routed and recorded, so you can see who told whom what, and every turn carries a record of what is actually known about it.

Introducing Conclave. It is a REPL that orchestrates coding-agent CLIs — Claude Code, Codex, and OpenCode — as participants in a single run, with a rank order between them, an evidence model over what is known about each turn, and multiple implementers working concurrently in isolated worktrees.

It has been building itself since the first version worked. 

## The problem it solves

Writing code stopped being the bottleneck. It did not become cheap — inference costs real money, and the more capable the model the more it costs — but the constraint moved. The expensive part now is deciding whether to trust what came back.

The usual answer is that you read the diff. That works at fifty lines and fails at eight hundred, and fails completely when two agents produced them simultaneously.

Conclave's answer is structural: put a second model in a different seat, give it a different job, and record what is actually known about every turn rather than what the agent said about it.

Some of that is already possible. Claude Code subagents give you a second seat with a different job today, they can run a different model, and they are good. What they cannot give you is a second *vendor*: a subagent runs inside the parent's client, on that vendor's models, with that vendor's harness and tool surface.

That matters more than it sounds. Fresh context decorrelates context. It does not decorrelate model family, training, harness, system prompting, or tool surface. If the second seat exists to provide independent review, using another vendor removes several shared sources of failure at once. It does not guarantee independence, but it is meaningfully different from opening another context window on the same stack.

The other option is an API harness that talks to several providers. That gets you different vendors, but now you are building the agent runtime yourself: tool execution, permissions, lifecycle handling, local configuration, authentication, and whatever session semantics the vendor's client already implements.

Conclave is the third thing — different vendors, each driven through its own client, with everything that client already knows how to do left intact.

## One run, multiple vendors, nothing flattened

Conclave drives the real CLIs, so each participant keeps its native machinery.

The clients already expose structured signals about what they are doing — hooks, event streams, terminal records, and provider-specific failures. Conclave consumes those signals in their native forms rather than flattening every client into the same lowest-common-denominator protocol. That is how a provider outage or a spent account arrives as a stated cause rather than a bare exit code.

It also means the setup each tool needs — hook registration, trust decisions, permission modes — is handled for you, including the parts that normally expect somebody to be sitting at a terminal.

Each client authenticates however you have configured it — subscription or API key, whatever that CLI already uses when you type at it yourself. Conclave never holds a credential.

Seats are independent — any CLI, any model it supports:

```bash
conclave session --advisor codex --implementer claude
conclave session --advisor claude --implementers "opencode -m opencode/kimi-k2.7-code"
conclave session --advisor codex --implementers "claude --model opus, claude --model sonnet"
```

## Concurrent implementers, isolated by construction

Multiple implementer seats run at the same time, each in its own git worktree:

```
.conclave/worktrees/<run-id>/implementer      branch conclave/<run-id>/implementer
.conclave/worktrees/<run-id>/implementer-2    branch conclave/<run-id>/implementer-2
manifest.json                                 baseSha and mergeState per seat
```

A seat cannot write into another's tree, because its process was launched with a different working directory. Isolation is a property of the setup, not a request in a prompt.

There are no rounds. A dispatcher admits tasks and runs them concurrently, so a seat finishing in four minutes does not wait for one taking forty. The advisor targets work by seat or by role.

Completed work merges into the integration tree automatically. A conflict becomes a repair task assigned back to the seat that produced it — not a question for you — and that seat's work stays on its own branch throughout, so a failed merge discards nothing. A second failure on the same lineage escalates.

**One implementer creates no worktrees at all.** The seat works in your checkout, on your branch, and the merge is a no-op, so an ordinary run still shows its work in your own `git status`. A guard compares the observable surface of a default run against a declared baseline, recursively, and fails if it drifts.

## Evidence instead of assertions

Every turn gets a verdict with a grade: `observed`, `inferred_from_documented_event`, `reasoned_but_unverified`, `unsupported`.

When the only evidence is that a turn exceeded its deadline without a terminal signal, the verdict is `timed_out (uncertain)` rather than a guess about why it stopped. Pauses arrive with their evidence attached:

```
child pid 35529 is still working (cpu 8.3%, 6.9%, 5.2%) — 322 event(s) since the prompt
Continuing sends into a live turn, which neither CLI accepts
```

That is enough to decide without going to read the process table yourself.

**Checks run against the integration tree, not only per seat.** Two seats can produce work that merges cleanly and fails together — one moves lines the other's new test cited. Git sees no conflict because there is none at the text level. So the configured checks run after every merge, and a failure after the last one is a reported outcome rather than a queued task, because no seat remains to fix it.

## Disagreement that goes somewhere

Three ranks: human, advisor, implementer. The advisor holds the goal and steers. The implementer is told what to do rather than what the goal is. You answer decisions.

The advisor sees reports, not the implementer's tool calls. It can read the repository like any agent; what it does not get for free is a record of what the implementer actually did.

It is not one-directional. An implementer can refuse, and does. From this repository's own history: one declined to reverse a design statement without recording why. One said plainly it could not supply an enumeration it had been asked for, rather than inventing one. One stopped to report that an acceptance criterion described a state no code path could construct — which was true, and which I had done three times.

Escalations halt the run and hand the question up. Twice they surfaced contradictions between two constraints I had written myself.

## When the operator is a program

`--operator agent` tells the advisor a machine is answering, so it escalates about premises and ambiguous criteria rather than permissions. `conclave status --json` and `conclave events --follow` expose run state without scraping a console, so a supervising process can be woken at a decision point rather than polling a terminal.

Ceilings bound a run on both front-ends: advisor turns, elapsed minutes, queue depth, concurrent seats.

Rotation replaces a degraded seat, transactionally. The replacement reproduces what was established from the handoff record and must pass an acceptance gate before the swap commits; it rolls back if acceptance fails. Rotation is per seat — replacing one leaves the others working.

## The cost argument

The economic point is token placement, not price per token. The implementer burns most of the tokens in a run — it reads files, runs suites, edits, re-reads. The advisor reads a report and writes an instruction. So the advisor can be considerably more expensive per token and still be a small fraction of what a run costs.

I want to be careful here: I cannot show you the split. Conclave deliberately records no token usage — it drives your CLI on your subscription, so your spend stays with your account, and a partial count scraped from one adapter's transcript would be a confident wrong number. The asymmetry is structural and I have not measured it, which by this article's own standard makes it an argument rather than a result.

What I can show is the price gap it would exploit. Per million tokens, 10 August 2026:

| | input | output |
|---|---|---|
| Kimi K2.7 Code | $0.95 | $4.00 |
| Claude Sonnet 5 | $2.00 | $10.00 |
| Claude Opus 5 | $5.00 | $25.00 |

And one real result: a Kimi implementer under a Codex advisor produced correct, mutation-verified work across three issues in this repository. Its failures showed up in self-reports rather than in code — which is what an advisor reading reports is positioned to catch.

Which is the question worth asking: **as open-weight models improve, when does it stop making sense to write code with a frontier model, and start making sense to use one only as an advisor?**

My read is that it has already flipped for well-specified work with clear acceptance criteria, and has not flipped where the implementer's judgement carries the outcome. Conclave lets you test where that line sits for your work, with the same tooling on either side of it.

## Getting it

Conclave is on GitHub:

```bash
conclave session "fix the flaky test in src/repl" \
  --advisor codex \
  --implementer claude \
  --checks "npm test"
```


