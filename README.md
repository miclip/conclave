# Conclave

A REPL over coding-agent CLIs. One advises, one implements, a human steers.

The children are the real Claude Code, Codex and OpenCode CLIs, unmodified. Their harness,
auth and usage accounting are the same as when you type at them yourself. Conclave never
speaks to a model API and never holds a model API key.

Two seats, three agents to fill them with. OpenCode selects its model per invocation, so
any model it can reach — including open-weight ones — can take a seat without Conclave
learning anything about that model.

Supervised use. There is no orchestrator model, no summariser, and no third seat.

## Install

Node 24 or newer.

```sh
curl -fsSL https://raw.githubusercontent.com/miclip/conclave/v0.1.1/scripts/install.sh | sh
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

Per agent:

```json
{ "permissions": "ask", "agents": { "claude": { "permissions": "bypass" } } }
```

## The idea

Two models with different training and different harness prompts have different blind
spots. The advisor answers architectural questions while the implementer holds the
implementation context, and never accumulates that context itself.

It is not a coding agent, and not an API harness. The children are the real CLIs: Claude
Code and Codex on subscription auth, OpenCode on whatever credential OpenCode itself wants.
That distinction is the line the project holds — a CLI may need an API key, Conclave may
not have one. It is not consensus-by-committee either. Two models that cannot run the
code converge on whoever sounds most confident, so the design resists agreement-seeking.
The reasoning is in [`DESIGN-BRIEF.md`](DESIGN-BRIEF.md).

## What works

- Three CLIs under one `AgentSession` contract. Claude Code and Codex have eight live
  acceptance flows each; OpenCode is graded against a recorded run.
- A two-party relay: prose only in both directions, a ranked committee, and human asides
  addressed to one participant with an audit trail of who was excluded.
- Pauses as decision points — rotation candidate, advisor escalation, authority conflict —
  resolved from the console or from `RunHandle`.
- Rotation as a transaction: quiesce the old implementer, the advisor authors a handoff,
  the replacement reproduces the verification, and it rolls back if it cannot. Both
  branches proven live, rollback included.
- Subagents, which both participants may use as they judge. A subagent that modifies
  anything works in its own git worktree.
- Outcomes graded by evidence. `Stop` proves normal completion on Claude Code,
  `step_finish reason=stop` on OpenCode; anything weaker is labelled as what it is. A run
  exiting 0 is not evidence a turn finished, and is not treated as any.

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
| `spikes/experiments/` | pre-registered experiments |

Each spike has a `FINDINGS.md` recording what was measured. Open work is in
[issues](https://github.com/miclip/conclave/issues).

## Requirements

Node 24+ and Python 3 for the spike tooling. One runtime dependency, `node-pty`.

You need whichever CLIs you actually seat, installed and authenticated: `claude`, `codex`,
`opencode`. Claude Code and Codex need Conclave's hook registration, which
`conclave config install` writes and a session installs for you; Codex additionally
requires those hooks to be trusted. OpenCode needs neither — it reports its own lifecycle
on stdout, so there is nothing to register and nothing to trust.
