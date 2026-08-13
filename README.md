# Conclave

A REPL over coding-agent CLIs. One advises, one or more implement, a human steers.

The children are the real Claude Code, Codex, OpenCode and Kimi CLIs, unmodified. Their harness,
auth and usage accounting are the same as when you type at them yourself. Conclave never
speaks to a model API and never holds a model API key.

Four agents, and any of them in any seat. OpenCode and Kimi both select their model per
invocation, so any model they can reach — including open-weight ones — can take a seat
without Conclave learning anything about that model. Seats carry their own launch args, so
two seats can run different agents, or the same agent on different models:

```
--implementers "claude --model opus, opencode -m opencode/kimi-k2.7-code"
```

One advisor and one implementer is the default and is unchanged by any of that. Extra seats
are opt-in, and what they turn on — worktrees, a merge boundary, a clean-base refusal —
turns on with them, not before.

Supervised or unattended. There is no orchestrator model and no summariser: the dispatcher
is code, not an agent.

![The conclave console: a goal routed to the advisor, the advisor instructing the implementer, the implementer narrating to the human and reporting to the advisor](docs/images/console.png)

`conclave demo`, so the participants are scripted and no model was called — the rendering is
the real thing, the conversation is not.

What it shows is the routing. **The goal goes to the advisor only**; the advisor decides what
the implementer needs to know. The implementer then says two different things to two
different audiences: `implementer → you` is narration, printed live so you can see work
happening, and `implementer → advisor` is the report — the closing statement, rendered as
markdown. A peer that received the narration would answer the intention instead of the
result.

The goal is linted before anything starts. That warning is the tool saying this ask names
nothing that could be run, compared or observed, so the outcome cannot be graded better than
`reasoned_but_unverified` however well the work goes.

## Supported REPLs

| agent id | CLI | how it is driven | what registration it needs |
|---|---|---|---|
| `claude` | Claude Code | pty + hooks + transcript | generated `--settings`, written per session |
| `codex` | Codex CLI | pty + hooks + transcript | project `.codex/hooks.json`, **and** those hooks trusted in your user-level config |
| `opencode` | OpenCode | `run --format json` on stdout | none |
| `kimi` | Kimi CLI (needs a provider; access waitlisted — see below) | `--print --output-format stream-json` | none |

Any of the four can take either seat. Assign them per participant:

```sh
conclave relay "<goal>" --advisor codex --implementer claude
```

OpenCode additionally selects its model per invocation, so a participant can be seated on a
model Conclave has never heard of:

```sh
conclave relay "<goal>" --advisor codex --implementer opencode \
  --implementer-args "-m opencode/kimi-k2.6"
```

`--implementer-args` says implementer, so it applies to every implementer seat. A run with
more than one seat gives each its own agent and its own launch arguments in a single flag,
one entry per seat:

```sh
conclave relay "<goal>" --advisor codex \
  --implementers "claude --model opus-5, opencode -m opencode/kimi-k2.7-code"
```

The comma is the seat boundary and the first word of each entry is the agent; everything
after it belongs to that seat alone, and is applied after `--implementer-args` so the seat's
own spelling wins. Seats are named `implementer`, `implementer-2`, … An argument containing a
comma cannot be written here — put it in `.conclave/config.json`, which is keyed by agent.

That is a different MODEL in the same harness, which is not the same thing as a different
REPL — the OpenCode system prompt, tool set and agent loop still apply. `kimi` is the Kimi
REPL itself, with its own prompt, tools and agent loop; point it at a provider with
`--implementer-args "--config-file ~/.kimi-conclave.toml"`. Maincode's Matilda is
[#25](https://github.com/miclip/conclave/issues/25).

**A Kimi seat needs a provider, and says so badly.** With none configured the CLI exits 1
having printed `LLM not set`, and conclave grades that `unknown_abnormal_end (assumed)` from
the exit code alone — accurate, and no help at all in finding the cause. That is what
`--config-file` is for, and omitting it is the first mistake to rule out:

```sh
conclave session "<goal>" --implementer kimi \
  --implementer-args "--config-file ~/.kimi-conclave.toml"
```

Separately, **Kimi Code access is waitlisted** at the time of writing, so a configured seat
may still be unable to reach a model. The adapter is written and fixtured against
`kimi 1.49.0`; what it waits on is access, not work.

A Kimi *model* is reachable today through OpenCode without either:

```sh
conclave session "<goal>" --implementer opencode \
  --implementer-args "-m opencode/kimi-k2.7-code"
```

which is the different-model-same-harness case above, not the Kimi REPL.

The four are not equally well understood, and `npm run conformance` prints the difference
rather than hiding it. Claude Code and Codex announce turn completion through hooks; OpenCode
announces it in its output stream; **Kimi's print mode announces nothing**, so its completions
are inferred from the shape of the final message and graded accordingly. Kimi also cannot
mediate permissions — `--print` auto-approves for the invocation, so
`.conclave/config.json`'s `"permissions": "ask"` cannot be honoured for it.

## Install

Node 24 or newer.

```sh
curl -fsSL https://raw.githubusercontent.com/miclip/conclave/v0.3.4/scripts/install.sh | sh
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

## Two ways to drive it

Someone has to answer when the run stops — a rotation candidate, an escalation, a turn that
ended badly, a permission prompt. That someone is **the operator**, and whether they are a
human or a machine changes more than the interface.

|  | human at a terminal | agent driving |
|---|---|---|
| command | `conclave session` | `conclave session --operator agent` |
| how it answers | typed at the prompt | lines written to stdin, held open |
| how it observes | the console: pinned footer, live narration, tab title | `conclave status --json`, `conclave events --follow` |
| what a pause looks like | prose with its evidence | `pause.reason`, `pause.evidence`, `pause.options` as data |
| what the advisor is told | a person is answering | a machine is: escalate readily about premises and ambiguous criteria, never about permission |

`--operator agent` is not cosmetic. It changes the advisor's briefing, and it is recorded in
the run report — because **it changes what an escalation means**. An agent operator is the
same kind of thing as the participants and may share their blind spots, so its answer is
another opinion with authority rather than independent confirmation. A reader auditing a run
cannot recover that from the routing log, where both look identical.

Use `session` either way. `relay` returns an outcome, so a pause has nowhere to suspend to
and every pause point ENDS the run; `--operator agent` does not change that. The one thing
an agent must not do is pick `relay` because the name sounds unattended.

Everything the tool decides is written where a machine can read it, not only printed: a
refused `/continue`, a pause, a resume, a rotation, a verdict and the evidence behind it.
That is deliberate — see [Watching a session from somewhere else](#watching-a-session-from-somewhere-else).

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

With more than one seat, those same checks are **also** run against the merged tree after
every merge including the last. Nothing else looks at the integration result: git reports
textual conflicts, and the per-seat checks run in each seat's own tree, so every seat can pass
while the tree they produce together fails — which is what
[#80](https://github.com/miclip/conclave/issues/80) is: three tasks, no conflict on any merge,
a red result. A failure while the run is still going becomes a repair naming both contributing
tasks rather than blaming a seat, because the defect exists in neither half. A failure after
the final merge has no seat left to repair it, so the run ends `integration_failed` and exits
non-zero instead of reporting success on a tree that does not build. One seat has no merge, so
nothing about a single-seat run changes.

The goal is optional. Start with none and the first thing you type becomes it.

### At the console

```
<text>                 to both, at human rank
>advisor <text>        to the advisor only
>implementer <text>    to the implementer only
@src/relay/relay.ts    a path. Tab completes both sigils.

/pause  /continue [force]  /wait [minutes]  /rotate [reason]  /abort
/allow [who]  /deny [who]
/state  /log [n]  /queue  /audit  /help  /exit
```

At a pause you may also just answer: a reply is delivered and resumes the run, because
answering a pause is the decision. `/wait` is for the other case — the child is still
working and every option would be destructive, so it records that you looked and chose to
wait rather than leaving the run indistinguishable from one nobody has read. `/continue`
refuses while the child is measurably busy; `force` overrides it.

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

Different *models*, specifically. Two instances of one model, given no shared context, still
share their priors — this project has watched two of them make the same wrong call about the
same code independently, and a third model in the advisor seat is what caught it. Fresh
context decorrelates reasoning; it does not decorrelate training.

That is also the argument for putting the expensive model where the judgement is rather than
where the volume is. The implementer reads files, runs suites and edits; the advisor reads a
report and writes an instruction. Those are not the same token bill.

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
- Pauses as decision points — rotation candidate, advisor escalation, authority conflict,
  and an implementer question that would change the build — resolved from the console or from
  `RunHandle`.
- Rotation as a transaction: quiesce the old implementer, the advisor authors a handoff,
  the replacement reproduces the verification, and it rolls back if it cannot. Both
  branches proven live, rollback included.
- Subagents, which both participants may use as they judge. A subagent that modifies
  anything works in its own git worktree.
- Concurrent implementers. Seats run at the same time, each in its own worktree, dispatched
  by a task queue rather than by rounds — so a seat that finishes in four minutes does not
  wait for one taking forty. Completed work merges into the integration tree; a conflict
  becomes a repair task on the seat that produced it rather than a question for you, and
  that seat's work stays on its own branch throughout.
- Checks against the *integration* tree, not only per seat. Two seats can produce work that
  merges without conflict and fails together — one moves lines the other's new test cited.
  A failure after a mid-run merge is a repair task naming both contributing tasks; after the
  final merge it is a reported outcome, because no seat is left to fix it.
- Seat-local rotation. A degraded seat is replaced without disturbing the others, verified
  in its own worktree, and an acceptance failure with no observable output at all stops
  retrying rather than rolling back repeatedly.
- A reviewer seat, opt-in with `--reviewer`. Rank implementer, so its rejection creates work
  rather than authority. It reads the diff and the tree, never the producing seat's summary.
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
- Build-changing scope questions paused for a human answer. A line beginning `UNANSWERED:`
  in an implementer report means it had to choose a build-changing direction without an
  answer; the run pauses until the human settles it, while choices about how to build remain
  the implementer’s. It is distinct from `FLAG:`, which only qualifies the result.
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

So is the seating. A seat whose CLI is not installed, or which names a model its CLI does not
have, is refused before anything is spawned, registered or written — not twelve minutes later
as a watchdog, and not on the first turn as an abnormal exit. Only the agents this run seats
are checked.

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
`/rotate`, `/abort`, `/allow`, `/deny`, or a message addressed with `>advisor` /
`>implementer`. Nothing needs to be scraped off the console; `status` carries the pause as
data, including the options you may answer with.

Whether `/rotate` is one of those options is a property of the run, not of the pause, so
every implementer seat carries its own `rotation` block: `configured` (this run has a
rotation policy at all), `armed` (this seat has checks, so `rotate` joins `continue`,
`constrain` and `abort` when the seat degrades), the `checks` themselves, and
`onDegradation`. It is per seat because `--checks` can be replaced on one seat and left
alone on the others. An unarmed run reports the block too, with `armed: false` — a key that
appeared only when armed would read as "not armed" on a build that simply did not say.

The liveness line in that evidence — whether the child is working or idle — is **re-measured
while the pause lasts**, so polling `status` twice gets two readings rather than one replayed.
Every reading says when it was taken, and `pause.liveness` carries the same fact as data
(`sample.measuredAt`, `refreshes`). Re-measuring is bounded: after thirty minutes it stops and
the line says so, from which point the timestamp is the whole story. It is evidence to read,
not a decision — `/continue` samples the child itself at the moment you ask, and still refuses
on anything that is not clearly idle.

One line is one message, so an answer of several paragraphs needs framing. `<<TAG` opens a
block — on its own, or after `>advisor`, `>implementer` or `>both`, and only there, so a
message or a `/command` that happens to end in `<<word` still means what it always did. A
line **equal to** `TAG` closes it; everything between is a single message, verbatim, with
its blank lines intact:

```sh
printf '>implementer <<EOF\n%s\nEOF\n' "$(cat answer.txt)" > "$fifo"
```

Without it each physical line is its own message — and only the first carries the
`>implementer` prefix, so the rest of a restricted answer reaches both seats, the run
resumes on whichever line arrives first, and `messages` in `status --json` counts one answer
several times. Closing stdin inside an unterminated block delivers nothing and says so.

Every message is recorded to `.conclave/runs/` as it happens, and `--resume <log>` replays
it into both seats — so a run that ended with work in flight is continued rather than
re-described by hand. Resume **here** rather than into `relay`: a resumed run that hits a
pause is held open for you, where `relay` would end again at the first one.

One limit worth knowing: piped, the session ends when its run does — a script has no way to
say "I am finished thinking" other than closing stdin. That is one run per process. At a
terminal the session outlives the run and waits for the next goal.

### Worktrees

With more than one implementer, each seat gets its own linked worktree and its own branch,
and its process is launched with that directory as its cwd — so isolation is a property of
the setup rather than a request in a briefing. A manifest records the base sha and merge
state per seat, so a crash leaves something better than a directory that may or may not be
anyone's. Merged trees are removed at the end; blocked, dirty or unmerged ones are kept with
recovery commands printed, because deleting work because a run ended badly is unrecoverable.

A concurrent run refuses to start against a dirty tree, untracked files included. Naming a
file and then omitting it would give the seats a base that differs from yours, which is the
divergence the rule exists to prevent.

**One implementer creates no worktrees at all.** The seat works in your checkout, on your
branch, and the merge is a no-op — so an ordinary run still shows its work in your own
`git status`. A guard compares the observable surface of a default run against a declared
baseline, recursively, and fails if it drifts.

The rest of this section is about how the CLIs register hooks across checkouts, which is a
separate matter and applies whether or not seats are involved.

Claude's registration is per-checkout, so linked worktrees are independent. Codex's is not:
it resolves project configuration from the **main** worktree, so one sidecar serves every
worktree of a project. A linked worktree still needs an empty `.codex/` directory of its own
as a trigger — `config install` creates it — but the file it reads lives in the main
worktree.

That means the sidecar has one owner. If a second checkout of *Conclave itself* registers the
same project, `config check` reports the registration as `SHARED` rather than drifted, names
the checkout whose hooks would actually run, and says what re-installing would cost: Codex's
trust hash includes the absolute command path, so rewriting it drops the other checkout's
trust. To develop hook changes, use a separate clone rather than a worktree.

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

### Pruning old records

Records accumulate, and `events.ndjson` is the part that grows without bound.

```sh
conclave sessions --prune              # ended, dead, and last updated over 7 days ago
conclave sessions --prune --days 30    # a longer horizon
conclave sessions --prune --days 0     # everything that qualifies, however recent
```

Pruning removes the whole session directory — `status.json`, `events.ndjson`, `stdio.log`,
all of it — and only for records meeting all three conditions: the session **ended**, its
process is **no longer live**, and it last updated **before** the cutoff. Every id is printed
before the first deletion and again as an outcome, and each record is re-checked against its
pid immediately before its own removal, so a process that came back in the meantime keeps its
files.

What does not age out, however old:

| kept | why |
|---|---|
| a live session | its files are the only account of itself that survives a crash |
| a run that never said `ended` | an **abandoned** record is the evidence of the crash, not litter |
| anything at or inside the cutoff | `--days 7` means seven, not about seven |
| a record that cannot be read | a corrupt `status.json` is a thing to look at, not to delete |
| a directory with no `status.json` | indistinguishable from a session two seconds into launching |

`--days 0` is the after-a-bad-afternoon case — a dozen failed starts, all ended, all dead,
none of them worth reading. It still takes nothing that is running and nothing that crashed.

The argument list is read strictly, because the cost of a loose reading here is measured in
deleted records: `--days` must be zero or more, and anything unrecognised, repeated, or
positional is refused before a single record is chosen. `conclave sessions --prune --dasy 0`
is an error rather than a silent fall back to seven days. A removal that fails is named on
stderr and exits non-zero. Under `--json` the result object is alone on stdout and the
pre-delete announcement goes to stderr, so nothing is ever deleted unannounced.

```sh
npm test                    # typecheck and the offline suite
npm run conformance         # what each adapter claims, graded by evidence
```

Live suites spawn real sessions and consume quota, so they are opt-in: `test:live`,
`test:live:codex`, `test:live:relay`, `test:live:pause`, `test:live:rotate`,
`test:live:rollback`, and `test:codex`.

## Not built

No orchestrator model and no summariser. The dispatcher is code.

No cost or token accounting. Conclave drives your CLI on your subscription, so spend stays
with your account. The record names the model and launch args per seat, which is the join key
if you want to do that accounting yourself.

OpenCode is less well understood than Claude Code and Codex, and graded accordingly:
`completed` is observed from a
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

A registered agent's `launch.command` is the program that spawns, so a seat can be pointed at
a wrapper or a pinned build rather than whatever is first on `PATH`:

```ts
const registry = new AgentRegistry().register({
  ...OPENCODE_AGENT,
  launch: { ...OPENCODE_AGENT.launch, command: '/opt/wrappers/opencode' },
})
```

The availability check above resolves that same string, so what is validated is what runs.

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
`opencode`, `kimi`. **Only the ones you seat** — a Claude-only run does not ask you to install
Codex.

A missing one is refused before the run starts, naming the seat, the command and how to
install it. It used to register both seats, write its hooks, check Codex trust and route the
goal first, and then die on the first turn as `unknown_abnormal_end` — accurate, and no help
at all in working out that the binary was never there. Nothing is spawned to find out; the
lookup is the walk `execvp` does, so a wrapper script or a version manager's shim is honoured
rather than second-guessed.

Claude Code and Codex need Conclave's hook registration, which
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
