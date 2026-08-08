# Conclave

A REPL over coding-agent CLIs. One advises, one implements, a human steers.

The children are the real Claude Code, Codex, OpenCode and Kimi CLIs, unmodified. Their harness,
auth and usage accounting are the same as when you type at them yourself. Conclave never
speaks to a model API and never holds a model API key.

Two seats, four agents to fill them with. OpenCode and Kimi both select their model per
invocation, so any model they can reach — including open-weight ones — can take a seat
without Conclave learning anything about that model.

Supervised use. There is no orchestrator model, no summariser, and no third seat.

## Supported REPLs

| agent id | CLI | how it is driven | what registration it needs |
|---|---|---|---|
| `claude` | Claude Code | pty + hooks + transcript | generated `--settings`, written per session |
| `codex` | Codex CLI | pty + hooks + transcript | project `.codex/hooks.json`, **and** those hooks trusted in your user-level config |
| `opencode` | OpenCode | `run --format json` on stdout | none |
| `kimi` | Kimi CLI | `--print --output-format stream-json` | none |

Any of the three can take either seat. Assign them per participant:

```sh
conclave relay "<goal>" --advisor codex --implementer claude
```

OpenCode additionally selects its model per invocation, so a participant can be seated on a
model Conclave has never heard of:

```sh
conclave relay "<goal>" --advisor codex --implementer opencode \
  --implementer-args "-m opencode/kimi-k2.6"
```

That is a different MODEL in the same harness, which is not the same thing as a different
REPL — the OpenCode system prompt, tool set and agent loop still apply. `kimi` is the Kimi
REPL itself, with its own prompt, tools and agent loop; point it at a provider with
`--implementer-args "--config-file ~/.kimi-conclave.toml"`. Maincode's Matilda is
[#25](https://github.com/miclip/conclave/issues/25).

The four are not equally well understood, and `npm run conformance` prints the difference
rather than hiding it. Claude Code and Codex announce turn completion through hooks; OpenCode
announces it in its output stream; **Kimi's print mode announces nothing**, so its completions
are inferred from the shape of the final message and graded accordingly. Kimi also cannot
mediate permissions — `--print` auto-approves for the invocation, so
`.conclave/config.json`'s `"permissions": "ask"` cannot be honoured for it.

## Install

Node 24 or newer.

```sh
curl -fsSL https://raw.githubusercontent.com/miclip/conclave/v0.2.6/scripts/install.sh | sh
```

Installs the newest tagged release into `~/.local/share/conclave`, compiles `node-pty`, and
symlinks `conclave` into `~/.local/bin`. Re-running upgrades in place.

`CONCLAVE_REF` installs a specific ref. `CONCLAVE_PREFIX` and `CONCLAVE_BINDIR` move where
it lands.

```sh
CONCLAVE_REF=v0.1.0 sh install.sh
```

By hand:

```sh
git clone https://github.com/miclip/conclave.git && cd conclave
npm install
ln -sf "$PWD/bin/conclave.ts" ~/.local/bin/conclave
```

## Using it

Run it in the project you want worked on. Conclave registers its own hooks there; the
project needs nothing installed.

```sh
cd ~/some/project
conclave session "make the failing test pass" --checks "npm test"
```

The goal goes to the advisor only. It decides what the implementer needs to know for each
piece of work. The implementer is told the advisor holds the goal.

`--checks` enables rotation: a degraded implementer is replaced by one that reproduces the
verification first. Without it, a degraded implementer escalates to you.

By default degradation raises a *candidate* rather than acting: an attended session stops and
asks, an unattended one records it and carries on, and the count appears in the summary.
Rotating unattended requires `onDegradation: 'automatic'` as well as checks, because nothing
yet shows that compaction predicts degradation — which is what
[#10](https://github.com/miclip/conclave/issues/10) exists to establish.

Those checks are *required* — a replacement that cannot reproduce one is rolled back. Use
`--checks-informational` or `--checks-unrelated` for commands that should run and be
reported without gating the transfer, because a check can reproduce faithfully and still say
nothing about the work being handed over. Relevance is declared by you, never by a
participant: a replacement that classified its own checks would be grading its own transfer.

The goal is optional. Start with none and the first thing you type becomes it.

### At the console

```
<text>                 to both, at human rank
>advisor <text>        to the advisor only
>implementer <text>    to the implementer only
@src/relay/relay.ts    a path. Tab completes both sigils.

/pause  /continue  /rotate [reason]  /abort   /allow [who]  /deny [who]
/state  /log [n]  /queue  /audit  /help  /exit
```

During a run, an addressed line is queued and delivered at the next turn boundary. Neither
CLI takes input mid-turn.

Between runs the participants are still alive, and an addressed line is asked directly: you
get the answer back. Both can be asked at once. The same one twice waits, since a session
runs one turn at a time.

Permission prompts appear as `! advisor needs a permission decision for Bash — /allow or
/deny` and are answered from the console.

Activity is shown while a turn runs, naming every participant that is working.

### Configuration

`.conclave/config.json`, per project, gitignored.

```json
{ "permissions": "bypass" }
```

Launches each CLI in its most permissive mode: `--dangerously-skip-permissions` for Claude
Code, `--dangerously-bypass-approvals-and-sandbox` for Codex, `--auto` for OpenCode. The
models then run commands in your working directory without asking. The console reports it
at the top of the session.

Note the asymmetry: two of those flags say what they are and one does not. OpenCode's is
`--auto`, and its own help text is the only place the word "dangerous" appears. Each CLI's
wording is quoted in `src/config/project.ts` so the mildest-looking flag is not the one
nobody reads.

**Kimi has no entry, because there is nothing to switch.** `kimi --print` auto-approves tool
calls for the invocation, so `"permissions": "ask"` cannot be honoured for it — it is
permissive and cannot be made otherwise in the mode Conclave drives it in. Seat it knowing
that, or seat something else.

Per agent:

```json
{ "permissions": "ask", "agents": { "claude": { "permissions": "bypass" } } }
```

You do not have to write it by hand. `--bypass` on `relay` or `session` sets it and records
it, and `--bypass claude` scopes it to one agent:

```sh
conclave session "<goal>" --bypass
```

It merges rather than replaces, so a narrower per-agent policy already in the file survives.
And it persists — the run says so, because `.conclave/` is gitignored and the change is
invisible to everyone else, including you tomorrow. Set `"permissions": "ask"` to undo.

## The idea

Two models with different training and different harness prompts have different blind
spots. The advisor answers architectural questions while the implementer holds the
implementation context, and never accumulates that context itself.

It is not a coding agent, and not an API harness. The children are the real CLIs: Claude
Code and Codex on subscription auth, OpenCode and Kimi on whatever credential each of them
wants.
That distinction is the line the project holds — a CLI may need an API key, Conclave may
not have one. It is not consensus-by-committee either. Two models that cannot run the
code converge on whoever sounds most confident, so the design resists agreement-seeking.
The reasoning is in [`DESIGN-BRIEF.md`](DESIGN-BRIEF.md).

## What works

- Four CLIs under one `AgentSession` contract. Claude Code and Codex have eight live
  acceptance flows each; OpenCode and Kimi are graded against recorded runs.
- A two-party relay: prose only in both directions, a ranked committee, and human asides
  addressed to one participant with an audit trail of who was excluded.
- Pauses as decision points — rotation candidate, advisor escalation, authority conflict —
  resolved from the console or from `RunHandle`.
- Rotation as a transaction: quiesce the old implementer, the advisor authors a handoff,
  the replacement reproduces the verification, and it rolls back if it cannot. Both
  branches proven live, rollback included.
- Subagents, which both participants may use as they judge. A subagent that modifies
  anything works in its own git worktree.
- The advisor can tell you something without stopping the run. A line beginning `NOTE:` is
  recorded for you and withheld from the implementer, while the rest of the reply is still
  the instruction. `ESCALATE` remains for when it actually needs an answer before continuing.
- Subagent work is named rather than shown as a raw tool call, and the run records whether
  delegation happened without any worktree being created — the shape a violation of the
  worktree rule takes. It is reported, never enforced: the repository cannot tell a
  subagent's write from its parent's.
- Unresolved items carried into the summary. A participant ending a report with a line
  beginning `FLAG:` has it lifted verbatim into the final lines, so a run that completed
  while something stayed unchecked does not read as unqualified success.
- Outcomes graded by evidence, and the four agents do not offer the same evidence. `Stop`
  proves normal completion on Claude Code and Kimi, `step_finish reason=stop` on OpenCode,
  `task_complete` on Codex; anything weaker is labelled as what it is. A run exiting 0 is
  not evidence a turn finished, and is not treated as any. `npm run conformance` prints
  each agent's claims with what backs them.

`--operator agent` tells the advisor a machine is answering escalations: ask readily, but
about premises and unobservable criteria rather than permission — and treat the answer as an
opinion with authority over the goal, not as independent confirmation. It is declared rather
than detected, because an agent and a human at a terminal are indistinguishable from inside
the relay.

The goal is linted before anything starts — an ask with nothing observable in it cannot be
graded better than `reasoned_but_unverified` however well the work goes, and a goal is the
last artefact you can fix for free. Warnings by default; `--strict-goal` refuses.

`--dry-run` resolves configuration, checks and arguments and starts nothing, and `relay`
refuses to run outside a git repository unless you pass `--force` — attribution and rotation
both diff the tree, so neither means anything without one. `--max-turns` and `--max-minutes`
stop a run that is still going and exit non-zero; a silent stop is indistinguishable from a
run that simply finished.

Every message is recorded to `.conclave/runs/` as it happens, and `--resume <log>` replays it
into both seats. `relay` ends at every pause point by design, so the normal way a long run
stops is with work still in flight — resuming continues it rather than having you transcribe
what was established into a new goal, where anything you miss is silently re-derived or
silently lost.

`conclave relay --json` prints the run as a structured record rather than prose: the outcome,
each turn's verdict with the confidence and provenance behind it, the rotation counters, and
anything a participant flagged as unresolved. Every human-facing line moves to stderr, so
stdout parses in full. That is the interface an agent driving Conclave needs — confirming a
run should not mean grepping a transcript.

## Driving a session as an agent

Use `conclave session`, not `conclave relay`.

`relay` returns an outcome, and a call that returns an outcome has nowhere to suspend to —
so every pause point ENDS the run. `--operator agent` does not change that; it only changes
what the advisor is told about who is answering. An agent that picks `relay --operator agent`
gets a run that dies at the first escalation and a hand-reconstruction of state on every
resume. Both commands take the flag; only one of them can hold a pause open.

```sh
conclave session "<goal>" --operator agent   # stdin stays open; the driver writes to it
conclave status --json                       # state: paused, with reason, evidence, options
```

A pause suspends the run with everything it had — the round counter, the last instruction,
the report — and the process stays alive. Commands arrive on stdin as lines: `/continue`,
`/rotate`, `/abort`, `/allow`, `/deny`, or a message addressed with `@advisor` /
`@implementer`. Nothing needs to be scraped off the console; `status` carries the pause as
data, including the options you may answer with.

Every message is recorded to `.conclave/runs/` as it happens, and `--resume <log>` replays
it into both seats — so a run that ended with work in flight is continued rather than
re-described by hand. Resume **here** rather than into `relay`: a resumed run that hits a
pause is held open for you, where `relay` would end again at the first one.

One limit worth knowing: piped, the session ends when its run does — a script has no way to
say "I am finished thinking" other than closing stdin. That is one run per process. At a
terminal the session outlives the run and waits for the next goal.

## Watching a session from somewhere else

Every session — console or relay — writes what it is doing to `.conclave/sessions/<id>/`,
continuously, so it can be read from another terminal, over ssh, or after the process is
gone. Which is when you most want it.

```sh
conclave relay "<goal>" --detach   # prints a session id and gives you your terminal back
conclave sessions                  # every session in this project, newest first
conclave status                    # what the most recent one is doing; a prefix picks another
conclave events <id> --follow      # its NDJSON stream: routed messages and adapter events
```

`status` reports who is in each seat, what each is working on, whether either is stopped at a
permission prompt, the current pause with its evidence and options, and the outcome once
there is one. `--json` gives the same record as data.

Liveness is never read from the file. A status saying `running` proves only that the process
was running when it last wrote, so every read checks the pid and reports both — a run whose
process is gone shows as **abandoned**, not as whatever it last claimed. That distinction is
the point: a session that looks busy because nothing has updated it is otherwise
indistinguishable from one that is busy, and telling a retry from a double start depends on
it.

A detached run's stdout and stderr go to `stdio.log` in the same directory. A crash before
the relay starts appears nowhere else.

```sh
npm test                    # typecheck and the offline suite
npm run conformance         # what each adapter claims, graded by evidence
```

Live suites spawn real sessions and consume quota, so they are opt-in: `test:live`,
`test:live:codex`, `test:live:relay`, `test:live:pause`, `test:live:rotate`,
`test:live:rollback`, and `test:codex`.

## Not built

No orchestrator model, no summariser, no third seat. The anti-spiral ladder is a round
budget and stall metrics, not the full escalation.

OpenCode is newer than the other two and graded accordingly: `completed` is observed from a
recorded run, and every other outcome is claimed no higher than `reasoned_but_unverified`.
It also cannot mediate permissions — `opencode run` has no dialog to answer, so approval is
settled by configuration before the process starts and `decidePermission` refuses rather
than pretending. `npm run conformance` prints the difference.

Two controlled experiments have run, in [`spikes/experiments/`](spikes/experiments). The
second falsified its own hypothesis. What they support is that the participants contribute
different information, not that one catches the other's blind spots.

## As a library

`relay.run(goal)` is the unattended form, where every pause ends the run. `relay.start(goal)`
suspends and hands back.

```ts
const relay = await Relay.start({
  registry: defaultRegistry(),
  cwd: repo,
  lead:        { id: 'advisor',     agent: 'codex',  role: 'advisor' },
  implementer: { id: 'implementer', agent: 'claude', role: 'implementer' },
  rotation: { checks: ['npm test'] },
})

const run = relay.start('Add a rate limiter to the request path.')

for (;;) {
  const s = await run.settled()
  if (s.kind === 'ended') break
  console.log(s.pause.reason, s.pause.detail)   // rotation_candidate, advisor_escalated, ...
  await run.continue()                          // or rotateImplementer / injectConstraint / abort
}
```

## Layout

| path | what it is |
|---|---|
| [`DESIGN-BRIEF.md`](DESIGN-BRIEF.md) | the design, with corrections folded in |
| [`docs/DESIGN.md`](docs/DESIGN.md) | why it is shaped this way, and what was measured |
| [`docs/NOTES.md`](docs/NOTES.md) | standing caveats and what was verified |
| [`src/`](src/README.md) | the contract, adapters, classifier and registry |
| `src/relay/` | the relay, the audit trail, and the run handle |
| `src/repl/` | the console |
| `src/rotation/` | record, handoff, degradation, rollback |
| `spikes/pty/` | the pty transport |
| `spikes/hooks/` | hook lifecycle, delivery semantics, the evidence corpus |
| `spikes/transcripts/` | schemas and the outcome classifier |
| `spikes/codex/` | Codex runtime-semantics fixtures |
| `spikes/opencode/` | OpenCode `run --format json` fixtures |
| `spikes/kimi/` | Kimi `stream-json` fixtures |
| `spikes/experiments/` | pre-registered experiments |

Each spike has a `FINDINGS.md` recording what was measured. Open work is in
[issues](https://github.com/miclip/conclave/issues).

## Requirements

Node 24+ and Python 3 for the spike tooling. One runtime dependency, `node-pty`.

You need whichever CLIs you actually seat, installed and authenticated: `claude`, `codex`,
`opencode`, `kimi`. Claude Code and Codex need Conclave's hook registration, which
`conclave config install` writes and a session installs for you; Codex additionally
requires those hooks to be trusted. OpenCode needs neither — it reports its own lifecycle
on stdout, so there is nothing to register and nothing to trust.

## License

[Functional Source License 1.1, Apache 2.0 Future License](LICENSE) (`FSL-1.1-ALv2`).

Use it, read it, change it, redistribute it. Run it at work, on client projects, in
research — those are all explicitly permitted. The one thing it withholds is a **Competing
Use**: taking Conclave and offering it to others as a commercial product or service that
substitutes for it.

Two years after each version is released, that version becomes available under the
**Apache License 2.0**, unconditionally. The restriction has an expiry date; it is not a
permanent enclosure of the code.

So it is source-available rather than OSI open source, and calling it "open source" would
be inaccurate while the current terms apply. That is the honest description, and the reason
for the Apache grant above.
