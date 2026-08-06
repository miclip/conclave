# Conclave

A REPL that sits above two or more coding-agent CLIs and mediates a working session
between them, with a human in the loop.

The children are the **real** Claude Code and Codex CLIs, unmodified, driven under a
pseudo-terminal exactly as a human would. Nothing about their harness, auth, or usage
accounting differs from someone typing.

> **Status: supervised use, not autonomous use.** Two children hold a real session between
> them, a human can steer or intervene mid-session, and a degraded implementer can be
> replaced without losing the work — all verified against the real CLIs. There is no
> orchestrator model, no summariser, and no third participant. Nothing here runs unattended
> on purpose.

---

## Install

Requires **Node 24 or newer** — Conclave runs its TypeScript directly, with no build step.

```sh
curl -fsSL https://raw.githubusercontent.com/miclip/conclave/v0.1.1/scripts/install.sh | sh
```

That installs the newest tagged release. It clones into `~/.local/share/conclave`,
compiles its one native dependency (`node-pty`), and symlinks `conclave` into
`~/.local/bin`. Re-running it upgrades in place.

`CONCLAVE_REF` installs a specific ref instead — a tag, a branch, a sha.
`CONCLAVE_PREFIX` and `CONCLAVE_BINDIR` move where it lands.

```sh
CONCLAVE_REF=v0.1.0 sh install.sh
```

To install by hand, or to work on Conclave itself:

```sh
git clone https://github.com/miclip/conclave.git && cd conclave
npm install
ln -sf "$PWD/bin/conclave.ts" ~/.local/bin/conclave
```

---

## Using it

Run it in the project you want worked on. Conclave registers its own hooks there; the
project needs nothing installed.

```sh
cd ~/some/project
conclave session "make the failing test pass" --checks "npm test"
```

The goal goes to the **advisor only**. It decides what the implementer needs to know for
each piece of work. The implementer is told that the advisor holds the goal.

`--checks` enables rotation: a degraded implementer is replaced by one that reproduces the
verification first. Without it, a degraded implementer escalates to you.

The goal is optional — start with none and the first thing you type becomes it.

### At the console

```
<text>                 to both, at human rank — no prefix needed
>advisor <text>        to the advisor only — the implementer will not see it
>implementer <text>    to the implementer only
@src/relay/relay.ts    a path, anywhere in the line. Tab completes both sigils.

/pause  /continue  /rotate [reason]  /abort   /allow [who]  /deny [who]
/state  /log [n]  /queue  /audit  /help  /exit
```

**During a run**, an addressed line is queued and delivered at the next turn boundary.
Neither CLI takes input mid-turn.

**Between runs** the participants are still alive, and an addressed line is asked directly
— you get the answer back. Useful for the things that are not a new goal: *start the server
so I can try it*, *explain that change*. Both can be asked at once; the same one twice
waits, since a session runs one turn at a time.

**Permission prompts** appear as `! advisor needs a permission decision for Bash — /allow
or /deny`, answered from the console.

Activity is shown while a turn runs, naming every participant that is working.

### Configuration

`.conclave/config.json`, per project, gitignored:

```json
{ "permissions": "bypass" }
```

That launches each CLI in its most permissive mode: `--dangerously-skip-permissions` for
Claude Code, `--dangerously-bypass-approvals-and-sandbox` for Codex — which Codex
documents as *"Skip all confirmation prompts and execute commands without sandboxing.
EXTREMELY DANGEROUS."* Two models then run commands in your working directory with nothing
asking first. The console says so at the top of every session that has it on.

Per agent, for an implementer that acts freely and an advisor that still asks:

```json
{ "permissions": "ask", "agents": { "claude": { "permissions": "bypass" } } }
```

---

## The idea

Two frontier models with different training and different harness prompts have genuinely
different blind spots. Routing an architectural question through one while the other
holds the implementation context produces better outcomes than either alone. Part of that
is model diversity; part is **context isolation** — the advisor never accumulates the
implementation detail that bogs down the implementer.

What this is *not*:

- Not a new coding agent. The children are the real CLIs.
- Not an API harness. It rides existing subscription auth, not API keys.
- Not consensus-by-committee. Two models that cannot run the code converge on whoever
  sounds most confident, and confidence is not correlated with correctness. The design
  actively resists agreement-seeking.

Full reasoning, including the commercial risk that drove the transport choice, is in
[`DESIGN-BRIEF.md`](DESIGN-BRIEF.md).

## What works today

- **Both CLIs, unmodified**, driven under a pty through one `AgentSession` contract, with
  eight live acceptance flows each.
- **A two-party relay**: prose only in both directions, a ranked committee, and human
  asides addressed to one participant, with an audit trail of who was excluded.
- **Pauses as decision points** — rotation candidate, advisor escalation, authority
  conflict — resolved from the console or from `RunHandle`.
- **Rotation as a transaction**: quiesce the old implementer, the advisor authors a
  handoff, the replacement reproduces the verification, and the whole thing rolls back if
  it cannot. Proven live.
- **Subagents**, which both participants may use as they judge. A subagent that modifies
  anything works in its own git worktree.
- **Outcomes graded by evidence.** `Stop` proves normal completion; everything weaker is
  labelled as what it is.

```sh
npm test                    # typecheck + the offline suite
npm run conformance         # what each adapter claims, graded by evidence
```

Live suites spawn real sessions and consume real quota, so they are opt-in:
`test:live`, `test:live:codex`, `test:live:relay`, `test:live:pause`, `test:live:rotate`,
`test:live:rollback`, and `test:codex` (deployment invariants, no model tokens).

## What is not built

No orchestrator model, no summariser, no third participant. The anti-spiral ladder is a
round budget and stall metrics, not the full escalation. `test:live:rollback` is written
and has not been run.

Two controlled experiments have run ([`spikes/experiments/`](spikes/experiments)) and the
second **falsified its own hypothesis** — the advisor did not produce the repository-blind
recommendation the trap was built for; it asked to inspect first. So the claim is narrower
than "one catches the other's blind spots": the participants contribute *different*
information, and the roles were not redundant.

## As a library

Everything the console does is available without it. `relay.run(goal)` is the unattended
form, where every pause point ends the run; `relay.start(goal)` suspends and hands back.

### Two participants

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
| [`DESIGN-BRIEF.md`](DESIGN-BRIEF.md) | the design, with corrections folded in as they were found |
| [`TODO.md`](TODO.md) | deferrals with reasons, and the invariants protecting them |
| [`src/`](src/README.md) | the contract, adapters, classifier and registry |
| `src/relay/` | the two-party relay, the audit trail, and the resumable run handle |
| `src/repl/` | the console — a client of the run handle, holding no lifecycle logic |
| `src/rotation/` | the rotation transaction: record, handoff, degradation, rollback |
| `spikes/pty/` | step 1 — the pty transport |
| `spikes/hooks/` | step 2 — hook lifecycle, delivery semantics, the evidence corpus |
| `spikes/transcripts/` | step 3 — schemas and the outcome classifier's Python reference |
| `spikes/codex/` | Codex 0.146.0 runtime-semantics fixtures |
| `spikes/experiments/` | pre-registered experiments, including one that falsified its own hypothesis |
| [`docs/DESIGN.md`](docs/DESIGN.md) | why it is shaped this way, and what was measured to find out |

Each spike has its own `FINDINGS.md` recording what was measured, including the parts
that contradicted expectations.

## Requirements

Node 24+ (runs TypeScript directly, no build step), the `claude` and `codex` CLIs
installed and authenticated, and Python 3 for the spike tooling. One runtime dependency,
`node-pty`.
