# Conclave — Multi-Agent Orchestrator REPL — Design Brief

Status: steps 1–4 complete for Claude Code. Findings are folded in below and recorded in
full in `spikes/pty/FINDINGS.md`, `spikes/hooks/FINDINGS.md` and
`spikes/transcripts/FINDINGS.md`. The adapter contract and the first live adapter are in
`src/` — see `src/README.md`.

Amendments made after the original draft are marked **[Amended 2026-08-05]**. The
original reasoning is preserved rather than overwritten, because several corrections
strengthened the original conclusion by a different route than the one first argued.

---

## 1. What this is

A REPL that sits above two or more coding agent CLIs and mediates a working session
between them, with a human in the loop.

**[Revised 2026-08-05 — the participants are not peers.]** One agent is declared the
**lead** (architect). It starts the coding session, reads what the implementer reports
back, and generates the instructions that continue it. The implementer does the work and
can push back or disagree. The human follows along through summaries of both sides and
can intervene at any point.

The orchestrator is therefore plumbing, not a participant: routing, visibility, evidence
and budget. What the original draft called the "orchestrator model" (build step 7) is
collapsed into the lead, which is one of the two agents rather than a third one.

The earlier peer framing is preserved below where it still applies, but the exchange is
asymmetric now: the lead directs and the implementer executes.

The observed behavior this is built around: two frontier models with different training
and different harness prompts have genuinely different blind spots, and routing an
architectural question through one while the other holds the implementation context
produces better outcomes than either alone. Part of the benefit is model diversity and
part is context isolation, since the advisor never accumulates the implementation detail
that bogs down the implementer.

## 2. What this is not

- Not a new coding agent. The children are the real Claude Code and Codex CLIs, unmodified.
- Not an API harness. It must ride existing subscription auth, not API keys.
- Not consensus-by-committee. Two models that cannot run the code will converge on
  whoever sounds most confident. Confidence is not correlated with correctness. The
  design has to actively resist agreement-seeking rather than encourage it.

  **[Revised — it is a committee, just not a flat one.]** The objection above is to
  *consensus-seeking*, not to committees. A ranked committee does not have the problem:

  ```
  human  >  advisor  >  implementer
  ```

  All three participate and any of them may disagree. What changes is that disagreement
  resolves by **rank**, not by who sounds more confident — which is precisely the failure
  mode the original objection names. Nobody has to be talked round, so nothing is gained
  by sounding certain.

  The risk inverts rather than disappearing. The implementer will be inclined to *defer*
  for exactly the training reasons flat peers converged, so "the implementer can push
  back" is the property that erodes silently — and it erodes while producing confident
  status updates, which is harder to notice than two agents talking each other into
  nonsense. If the implementer stops disagreeing, this is one model with extra latency.

  Rank makes pushback safe rather than optional: a subordinate that may state its case and
  then comply is more useful than one that either caves immediately or digs in. That only
  works if rank is *legible* to the participants — see §5c on attribution.
- Not a transcript viewer. If reading the panel costs as much attention as doing the
  work, it failed.

## 3. Core architectural decision: transport

Three candidate transports were considered.

**MCP (rejected as primary).** Wrapping Codex as an MCP server that Claude Code calls
does preserve the child harness, since the wrapper spawns the real `codex exec`
underneath. What it loses is the shape of the exchange. A tool call is one prompt in,
one blob out. There is no multi-turn negotiation, and the parent authors the child's
prompt, so the child works from the parent's compression of the problem rather than the
problem. It also forces a hierarchy where one agent is the tool of another, when the
design wants peers.

**Agent SDK / app-server (viable, cleaner, more fragile commercially).** Both vendors
expose a programmatic session layer that keeps the harness intact.

- Claude: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, `claude-agent-sdk` on
  PyPI), or the headless CLI with `--input-format stream-json --output-format
  stream-json`. Session continuity via `--resume <session-id>`, `--continue`,
  `--fork-session`.
- Codex: `@openai/codex-sdk` (TS) or `openai-codex` (Python), with `thread_start` /
  `resumeThread`. Deeper integration via the Codex app-server, a JSON-RPC interface
  exposing `thread/start`, `thread/resume`, `thread/fork`, `turn/start` and streamed
  agent events. This is what powers Codex's own VS Code extension.

This is the ergonomic path. The problem is commercial, not technical. See section 8.

**PTY driving the real TUI (chosen for input).** Spawn each CLI under a pseudo-terminal.
Both check `isatty()` and boot their full interactive UI. Writing to the PTY master is
indistinguishable from keystrokes. Nothing about harness, auth, or usage accounting
differs from a human typing.

**[Amended 2026-08-05] Verified.** Both CLIs boot their real interactive UI under a PTY
and accept synthetic keystrokes. See `spikes/pty/FINDINGS.md`. Two corrections:

> **Durable finding 1: "full interactive TUI" does not imply alternate-screen mode.**
> The original draft asserted that both CLIs are full-screen apps using the alternate
> buffer. Neither is. Claude Code 2.1.222 and Codex 0.146.0 both render *inline* on the
> main buffer with cursor-addressed partial redraws; neither ever emits `ESC[?1049h`.
> Any readiness or liveness check keyed on alternate-screen mode reports a false
> negative on both. The reliable signal that a child booted a real interactive UI is
> raw-mode negotiation — bracketed paste (`?2004h`), focus events (`?1004h`), and in
> Codex's case the Kitty keyboard protocol (`ESC[>7u`).

> **Durable finding 2: terminal output is non-semantic regardless of buffer strategy.**
> The original conclusion — never parse the screen — was argued from alternate-buffer
> full-screen rendering. That premise was wrong, and the conclusion is nonetheless
> stronger than first stated. Inline rendering with cursor-up rewrites is no more
> recoverable than an alt-screen app: the same region is overwritten repeatedly, so
> accumulated stdout contains every intermediate frame with no way to tell which was
> final. Codex additionally negotiates the Kitty keyboard protocol, so even keystroke
> encoding is non-trivial. Screen bytes are usable for exactly two things: proving a
> child is alive, and human debugging. Never for semantics, and never for turn
> boundaries.

Never parse the screen. Both CLIs redraw in place; accumulated stdout is meaningless
without a VT emulator maintaining screen state, and even with one you are diffing
rendered frames to guess at semantics. That layer rots on every upstream release.

**The hybrid, which is the actual design:**

```
input  →  PTY (or tmux send-keys)     → child CLI runs natively
output ←  lifecycle hooks             → turn boundaries, tool events, structured payloads
output ←  session transcript JSONL    → full conversation content
```

**[Amended 2026-08-05]** Step 2 found that hooks alone do not cover every way a turn can
end — cancelled turns and refused permissions emit no `Stop` at all. The output side
needs a third input: a supervisor that can declare a turn over without a hook. See
section 4a.

## 4. Integration surface per child

### Codex CLI

- Hooks configured in a sidecar `hooks.json` or an inline `[hooks]` table in
  `config.toml`. User-level hooks load independently of project trust; project-local
  hooks require the project `.codex/` layer to be trusted.
- Documented events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `PermissionRequest`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`,
  `Stop`. **[Amended]** `SessionEnd` also exists in 0.146.0 and is absent from this list.
- Hook payload includes `session_id`, `turn_id`, `transcript_path`, `cwd`,
  `hook_event_name`, `model`, `permission_mode`.
- Transcripts (rollout files) under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Root
  is `CODEX_HOME`, default `~/.codex`.
- Hook stdout can return `hookSpecificOutput.additionalContext` to inject a developer
  message into the conversation. This is the human-constraint channel. See section 6.
  **[Amended]** Confirmed present. Note `additionalContextLimit`: injected context above
  ~2,500 tokens spills to disk and the model sees a preview plus recovery metadata, so
  long constraints do not arrive verbatim.
- `/hooks` in the TUI lists active hooks, useful when debugging. **[Amended]** The
  app-server `hooks/list` RPC does the same thing scriptably and costs no model tokens;
  `spikes/hooks/verify_codex_hooks.py` uses it.

**[Amended 2026-08-05] The sidecar file format differs from the wire format.**
`.codex/hooks.json` is `{"description": ..., "hooks": {"SessionStart": [{"hooks": [...]}]}}`.
The handler field is `timeout` (seconds), *not* the `timeoutSec` used by the app-server
protocol — and an unrecognised handler field is silently ignored, leaving the default of
600 seconds. Unrecognised *top-level* keys do warn. Registration is easy to get subtly
wrong and look fine.

**[Amended] Codex gates hooks behind a content-hash trust prompt.** A registered hook
whose `trustStatus` is `untrusted` is loaded, listed and *enabled*, but never executed,
with no signal to the driver. Trust is granted interactively ("Hooks need review — 2
hooks are new or changed") and persisted to the *user-level* `~/.codex/config.toml` as:

```toml
[hooks.state."<abs path>/.codex/hooks.json:session_start:0:0"]
trusted_hash = "sha256:..."
```

Editing hooks.json re-hashes and re-prompts. The orchestrator must pre-seed these
entries or answer the prompt on every change to its own hook wiring.

**[Verified 2026-08-05, quota-free]** The full invalidation cycle is now covered by
`src/deployment/codexHookTrust.test.ts`, which mutates the real files and restores both
byte-for-byte (asserted). Results on codex 0.146.0:

| change | trustStatus | hash |
|---|---|---|
| baseline | `trusted` | — |
| command edited | **`modified`** | changed |
| reverted byte-for-byte | `trusted` | identical to baseline |
| whitespace-only reformat | `trusted` | **unchanged** |
| re-trusted after a timeout change | `trusted` | new `sha256:` written |

The useful finding is the fourth row: **the hash covers the normalised handler — command,
type, async, timeout — not the file bytes.** Reformatting `hooks.json` does not
re-prompt, so a formatter in CI is harmless; but trust is scoped per handler, so changing
`description` or adding an unrelated event does not re-validate handlers that did not
themselves change. JSON has no comments, so that half of the question is moot for the
sidecar format; an inline `[hooks]` table in `config.toml` could behave differently.

**Operational rule: a Codex hook is trusted per normalised handler definition, not per
sidecar file.** That single sentence explains every row above.

The diagnostic vocabulary keeps the four states separate rather than collapsing them,
because `enabled` says nothing about permission to execute:

```
loaded: true      Codex parsed and registered the handler
enabled: true     not switched off by configuration
trusted: false    the trust decision does not cover this handler's current content
executable: false loaded && enabled && trusted -- the ONLY one that means "will run"
```

A doctor command or panel that renders `enabled` as "working" would reproduce the
original silent failure behind a nicer UI, so `executable` is computed once in
`deployment/codexHookTrust.ts` rather than left as a judgement for each caller, and the
diagnostic message states all four.

`assertCodexHooksExecutable()` is wired as a registry **preflight**, which runs before
`create` and prevents construction. A session whose hooks cannot execute has no
turn-completion signal at all, so its lifecycle guarantees are knowingly absent before
it starts — that is a reason to refuse, not to start it and infer badly. It is declared
on the Codex agent definition *now*, ahead of the adapter, so it cannot be forgotten
when the adapter lands.

This is a **configuration/deployment invariant, not lifecycle evidence.** It answers
"will this session's hooks run", never "did a turn complete", and it does not touch any
capability grade — there is a test asserting Codex's outcome grades are unchanged by it.
`diagnoseHookTrust()` turns it into a launch-time readiness check, which exists to
prevent the specific silent failure that cost a scenario run in spike 2: hooks correctly
registered, `hooks/list` showing them enabled, and not one hook ever firing.

### Claude Code

- Same hook architecture. `SessionStart` supplies the current transcript path.
- Transcripts under `~/.claude/projects/<project-slug>/<session-id>.jsonl`.
- Headless equivalents if the PTY path is abandoned: `claude -p`,
  `--output-format stream-json`, `--resume`, `--fork-session`, `--max-turns`.
- `claude setup-token` produces a long-lived OAuth token for scripted use, requires a
  subscription.
- **[Amended]** Verified payloads (2.1.222). `SessionStart`: `session_id`,
  `transcript_path`, `cwd`, `hook_event_name`, `model`, `source`. `Stop`: `session_id`,
  `transcript_path`, `cwd`, `hook_event_name`, `prompt_id`, `permission_mode`, `effort`,
  `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`.
  Turn correlation is `prompt_id`, not `turn_id`. `last_assistant_message` carries the
  answer text directly, which may remove the need to tail the transcript for simple
  relays. Raw fixtures in `spikes/hooks/fixtures/`.

### Terminal host

Consider using tmux rather than raw PTY. It gives process supervision, `send-keys` for
input, and session survival across orchestrator restarts for free. This is where most
existing multi-agent tools landed (Claude Squad, amux, ntm). The orchestrator would not
scrape `capture-pane` for meaning, only use tmux as the terminal host.

## 4a. Child process environment [Amended 2026-08-05 — new section]

> **Durable finding 3: transcript availability depends on sanitized process ancestry.**
> A child spawned from inside an agent session inherits the parent's session markers.
> Claude Code, on seeing `CLAUDE_CODE_CHILD_SESSION`, silently disables transcript
> persistence and writes no session file at all. Since the transcript files *are* the
> orchestrator's output path, an inherited environment is silent data loss that surfaces
> far downstream, looking like a schema or parsing bug.

This is an adapter invariant, not a caveat: **the child environment is constructed,
never inherited.** `spikes/common/childenv.py` implements it, with `sanitized_copy()`
(denylist) and `allowlist_env()` (strict) behind one assertion that refuses to return an
environment containing any parent-agent marker. `tests/test_childenv.py` proves both
directions — a sanitized spawn writes its transcript, and a deliberately re-polluted
spawn does not. The negative half matters more than the positive: the failure is silent,
so a happy-path-only test would pass with the sanitizer removed.

Markers observed leaking from a Claude Code parent: `CLAUDECODE`,
`CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_BRIDGE_SESSION_ID`,
`CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_ENABLE_TELEMETRY`,
`CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`.

**Startup interstitials belong here too.** Both CLIs may show blocking dialogs before
the composer is live, and typed input selects menu items in them. During spike 1 this
was not hypothetical: keystrokes intended as a prompt hit Codex's update prompt and
triggered `npm install -g @openai/codex`, and later answered a directory-trust dialog.
Known interstitials: Codex update check (`-c check_for_update_on_startup=false`),
directory trust (pre-seed `[projects."<path>"] trust_level`), hook review (pre-seed
`[hooks.state...]`), and paste-burst coalescing (`-c disable_paste_burst=true`). The
adapter must suppress these by configuration rather than answer them by keystroke.

## 5. Orchestrator design

### Session adapter interface

Put an adapter seam between the orchestrator and every child. The transport will need to
change at least once (see section 8), so make it swappable from day one.

```
interface AgentSession {
  start(cwd, role, systemContext) -> SessionHandle
  send(message, provenance) -> void
  events() -> AsyncIterable<AgentEvent>   // turn_start, tool_use, message, turn_end, error
  transcript() -> AsyncIterable<Turn>
  fork() -> SessionHandle
  close() -> void
}
```

Implement `PtyHookAdapter` first. Keep `SdkAdapter` as a second implementation behind
the same interface. Both should pass the same conformance test suite.

**[Amended]** The spawn path must go through `childenv` (section 4a). Implementation
language is still undecided and is the first decision with long-term consequences; it
should be made when this interface is defined, not before.

**[Amended after step 3] `events()` cannot honestly promise a clean `turn_end`.**
`Stop` is evidence of normal completion, not a universal turn-finalisation event. The
interface stays as written, but the conformance contract must require every terminal
event to carry an explicit outcome, a confidence grade, and provenance describing how it
was determined — and must permit that event to be *synthesized* rather than observed.
An adapter emitting a bare `turn_end` would hide exactly the transport differences this
seam exists to contain.

**Evidence precedence, not arrival order.** Where two records bear on the same turn, the
classifier ranks them; it never lets whichever arrived first decide. The case designed
for ahead of observing it:

```
turn_aborted  >  Stop
```

- `turn_aborted` establishes **cancelled**.
- `Stop` establishes only that the turn reached a **terminal boundary** — the child
  saying "this turn is over", which a cancelled turn also is.
- `Stop` must never upgrade an aborted turn to `completed`.
- If both appear the outcome stays `cancelled`, and provenance names both channels.

Agreement between the two does **not** raise confidence. They plausibly originate from a
single internal lifecycle transition, so they corroborate one source rather than testing
it twice; the provenance says so explicitly (*"corroborating channel, not independent
evidence: likely one shared cause"*). There is no grade above `proven`, and the risk
being guarded against is the wording, not the enum.

Order-independence is enforced one level up, in `outcomes/tracker.ts`. `classify()` is
pure over the evidence set, and evidence is monotonic, so both arrival orders reach an
identical final verdict *and* an identical provenance chain. What differs is the
intermediate events: a `Stop` seen first yields a provisional `completed` that a later
`turn_aborted` **withdraws** via a revision, rather than leaving it standing next to its
own contradiction. Both orders are covered by synthetic tests written before the Codex
run, precisely so the fixture answers the question instead of recording whatever
happened.

Terminal outcomes are modelled explicitly, never collapsed into one event:

```
completed | cancelled | permission_refused | process_exited
timed_out | transport_lost | unknown_abnormal_end
```

plus a distinct non-terminal `in_progress`, because "still going" and "ended somehow"
are different claims and silence supports only the first.

Confidence grades: `proven` (a positive signal from the child says so), `inferred`
(composite, none decisive alone), `assumed` (orchestrator bookkeeping, unverifiable from
the child), `uncertain` (absence of evidence only). Only `completed` is currently proven
from `Stop`; see `spikes/transcripts/outcomes.py` for the classifier and
`spikes/transcripts/FINDINGS.md` for the evidence table it was validated against.

Two further contract obligations follow: a terminal event may be **revised** — a turn
classified `timed_out` can be superseded by a late `Stop` — and `turn_key` must stay
opaque, because it is `prompt_id` on Claude Code and `turn_id` on Codex.

### Invariants promoted from spikes 2 and 3

- Hook delivery is **at-most-once, not durable**. No upstream retry exists.
- **A hook that cannot deliver exits non-zero.** Exit 0 makes the loss invisible.
- **Journal durably before acknowledging.** An ack that outruns the write converts a
  crash into silent loss, because the sender treats it as delivered.
- **Delivery identities are minted at fire time** from payload digest plus hook pid plus
  fire timestamp, and replayed verbatim. Payload alone is not an identity: two genuine
  Stop deliveries in one session can be byte-identical.
- **Reconcile before finalising.** A completed turn whose `Stop` was lost must not become
  `process_exited` at shutdown; transcript evidence of completion outranks process death.
- **Readiness and input-acceptance are separate capabilities**, not one flag.
- Hooks **journal locally before attempting delivery**, so a lost delivery is countable.
- The receiver **deduplicates journal replays**, even though no duplicate has been
  observed — replay is the recovery mechanism, so duplicates are a matter of time.
- **Readiness differs per adapter**: Claude Code uses `SessionStart`, which fires at boot
  and blocks the first turn. Codex fires **no hook at all** before the first turn, so its
  readiness is the TUI negotiating raw mode. Both observed; see
  `spikes/codex/FINDINGS.md`.
- **Hook configuration is validated against the loaded configuration**, not against the
  file we wrote. Unknown fields degrade silently into dangerous defaults.
- **Codex hook trust is deployment state** and changes whenever hook content changes.
- `prompt_id` is the observed correlation key. `turn_id` does not enter the interface
  until proven for both adapters.
- `last_assistant_message` (Claude) and `task_complete.last_agent_message` (Codex) can
  optimise the common case; transcripts remain necessary for recovery, auditing and
  richer event reconstruction.
- **Always SIGTERM and wait before escalating.** SIGKILL leaves no transcript at all,
  while SIGTERM leaves a truncated but real one.

## 5a. Input mediation [Decided 2026-08-05: orchestrator-mediated by default]

On Claude Code, `cancelled` is only ever `assumed`: it rests entirely on the orchestrator
knowing it sent ESC. That holds if and only if the orchestrator owns all input. If a
human can also type directly into the child pane, a cancelled turn becomes
indistinguishable from a stalled one and collapses to `unknown_abnormal_end`. Codex is
unaffected, because its transcript records the abort regardless of who caused it.

So the question is a product decision, not an implementation detail: **is the child pane
directly interactive, or is all meaningful input mediated by the orchestrator?**

- **Mediated only.** `cancelled` and `permission_refused` stay determinable on both
  agents; session state stays authoritative. Cost: the human loses direct access to a
  working TUI and the orchestrator must proxy every affordance, including permission
  dialogs, which are latency-sensitive and have their own keybindings.
- **Directly interactive.** Better ergonomics, and the human can rescue a stuck child.
  Cost: on Claude Code the orchestrator can no longer maintain authoritative turn state.
- **Mediated by default, direct as an explicit escape hatch** that marks the session
  no-longer-authoritative until the next `Stop`. Keeps the common path determinable and
  makes the degradation visible rather than silent.

**Decision: orchestrator-mediated input is the default product mode.** It is the only
option under which the adapter can make authoritative lifecycle claims without
interpreting the screen.

Direct pane interaction remains available as an explicit escape hatch, and entering it
must *visibly* degrade guarantees rather than silently weaken them:

```
Input ownership:            external
Cancellation attribution:   unavailable
Unmatched turns:            may remain in_progress or resolve as unknown_abnormal_end
```

This is encoded in `Guarantees` / `guaranteesFor()` in `src/contract/session.ts`, is
carried on every `SessionSnapshot`, and changes classifier behaviour directly: with
`inputIsMediated: false`, a cancellation drops from `assumed` to `uncertain` and a
watchdog expiry resolves to `unknown_abnormal_end` rather than `timed_out`.

Preferred mechanism for the escape hatch is a **transparent keystroke proxy** rather
than raw tmux attach: it preserves most of the native experience while still recording
input provenance. Raw attachment is more convenient and turns authoritative session
state into a promise the adapter cannot keep.

## 5b. Configuration [Direction set 2026-08-05 — subsystem deliberately not built]

The project is **Conclave**, and it will use layered configuration:

- **Global user configuration** defines the available agents and personal defaults.
- **Project-local `.conclave/` configuration** selects agents and assigns them to roles.

The configuration subsystem is *not* being built yet, and nothing in `src/registry/`
reads a file, resolves a layer, or merges anything. What exists is the shape that
configuration will eventually produce, so the machinery is data-driven from the start
rather than being retrofitted:

- **Adapter registration** — `AgentRegistry.register()`. Agents are values, not
  branches. Adding one is a registration, never an edit to the code that constructs
  participants; a live test proves a session built through the registry behaves
  identically to one built directly.
- **Participant construction** — `ParticipantSpec` is plain data: seat id, agent, role,
  optional input-ownership override and args. `resolve()` validates a spec without
  launching anything, so a config file can be fully checked before any child starts.
- **Role assignment** — `RoleDefinition` carries context policy, whether the seat
  mutates the workspace, default input ownership, and whether it is a model seat at all.
  `Role` is deliberately an open string: a config naming an unknown role must be a
  validation error with a good message, not a compile error in someone else's checkout.
- **Input policy** — resolved from the role's default and overridable per participant,
  producing the §5a `Guarantees` rather than a bare flag.

Two things this already buys. The `arbiter` seat is marked `isModel: false` and the
registry refuses to fill it with an agent — a model in that seat would defeat its
purpose. And Codex is registered *without* a `create`, so it is listed, described and
conformance-graded while remaining unconstructible; omitting it entirely would have made
it look finished by absence.

Per-agent launch specs also carry *why* each suppression flag exists, because a bare
flag list rots into cargo cult. Codex's records that an unsuppressed update dialog once
consumed a prompt and ran `npm install -g @openai/codex`, and its deployment-state notes
record the directory-trust and hook-trust preconditions the adapter cannot fix itself.

## 5c. Visibility [Added 2026-08-05]

**Both agents exchange prose only, symmetrically.** Neither sees the other's tool use,
file contents, diffs, or reasoning traces — only what the other chose to say, and each
receives all of it: the full narration of a turn, not just its closing message.

The rationale is that this channel already exists and is already written for the right
audience. An agent's prose is what it produces for a human who cannot see its tools; it
is not a synthetic summary generated for a peer, so nothing is lost in translation and no
summarisation step can distort it. Context isolation then comes for free rather than
being enforced: the lead physically cannot accumulate the working set, because the
working set never reaches it.

`thinking` blocks are excluded on the same principle. Reasoning traces are the
implementer's working, not its report.

**Every human message carries an audience: one participant, or all.** Not a broadcast
with an exception bolted on — addressing is explicit at send time, and generalises to
however many participants exist rather than assuming two. Sending to all is the ordinary
case; sending to one is a private aside the others never see, which is useful as an
instrument, since one side can be biased and the effect on the exchange observed.

The audience belongs on the message, not on a mode the orchestrator is in. A mode is
state that can be wrong; an addressed message cannot be mis-delivered by forgetting to
change it back. `SendProvenance` already carries `kind` and attribution, so audience is a
third field on the same envelope.

Consequences, each of which needs handling rather than noting:

- **Privacy holds for one hop only.** The channel is confidential; the recipient is not.
  An aside can be repeated verbatim in the recipient's next status update, which is
  ordinary prose and goes straight to the other side. Undecided: mark asides confidential
  in the instruction (a request, not a guarantee), accept the leak, or filter outbound
  prose — which means reading it, and that is its own problem.
- **A single-recipient message can manufacture apparent disagreement.** Positions diverge for reasons that
  look technical but are actually informational. The orchestrator must be able to tell
  that apart from a real design dispute, or it will escalate its own routing to the human
  as if it were a technical deadlock.
- **No child's transcript is the full record.** Each is a partial view. The orchestrator's
  routing log becomes the only complete account of who saw what, which makes it something
  to preserve deliberately rather than a debugging artifact.
- **The advisor sees the artifact, not the activity.** *(Corrected: an earlier draft of
  this section claimed a prose-only lead cannot verify anything. That was wrong, and an
  argument was built on it.)* Both agents share a working directory and a branch, so the
  advisor has independent access to ground truth — it can read the files, run `git diff`,
  and run the test suite itself. "Fixed, tests pass" is entirely falsifiable; it just has
  to be checked rather than believed.

  What the advisor lacks is *process* context: which approaches were tried and abandoned,
  what the implementer read, the intermediate states. It has full *state* access. That is
  a better position than trusting a report, and better than two models agreeing — an
  independently run test is corroboration of a kind that peer agreement never is.

  It also means the thin context diet is self-directed rather than imposed. The advisor
  chooses what to look at and pays for it deliberately, instead of passively accumulating
  whatever the implementer happened to touch.
- **Permission dialogs escalate to the human by construction.** A lead that cannot see
  tool use has no basis on which to authorise one.

### Rank

```
human  >  advisor  >  implementer
```

Rank is what resolves disagreement, so it has to be enforced by the orchestrator rather
than merely requested in prose. Two obligations follow.

**Rank must be legible.** Every message reaching a participant carries who it came from
and where they sit. An instruction the implementer cannot distinguish from a human
directive gets human-level compliance; one it reads as a suggestion from an equal gets
argued with. Neither is what a ranked committee wants: the implementer should be able to
disagree, say so, and then comply.

**Rank breaks ties. It does not buy silence.** Any participant may disagree with any
other, including with the human. Dissent is the point, not a tolerated side effect: two
models are worth having only because they have different blind spots, and an implementer
that never contradicts the advisor has stopped contributing one of them. The expected
shape is *state the objection, then comply* — the objection is recorded and surfaced to
the human either way, so a correct dissent is not lost just because the work proceeded.

That gives the orchestrator two obligations of its own. A pushback is not a failure and
not a deadlock; it is content, and it belongs in the human's summary rather than being
absorbed as noise. And **an implementer that stops disagreeing is a signal, not a
success** — if dissent goes to zero, deference has set in and the second model has
quietly become expensive latency. That is worth measuring rather than assuming.

**A superior's constraint outlives a subordinate's instruction.** If the human sets a
constraint and the advisor later instructs against it, the constraint wins — the
orchestrator cannot let a lower-ranked instruction silently supersede a higher-ranked one
just by arriving later. This is what §6's privilege channel is for.

It also gives the manufactured-disagreement problem a defined resolution. If a private
human message to the implementer conflicts with an advisor instruction, the implementer
follows the human, and the advisor cannot see why. The orchestrator *can* see why — it
routed both — so it should recognise that divergence as its own doing rather than escalate
it as a technical deadlock.

Attribution stops being an experiment here. §5 treats it as a per-message flag to test;
under a lead it is a requirement. The implementer must know an instruction came from a
peer model rather than from the human — Claude Code treats user turns as authoritative,
so an unattributed instruction arrives carrying the human's authority and pushback becomes
very unlikely. The human's own constraints (§6) then need a genuinely higher privilege
than the lead's instructions, or an intervention is indistinguishable from routine
steering.

### Workspace: a worktree per agent [Decided 2026-08-05]

Each agent gets its own git worktree rather than sharing one directory. This dissolves
both hazards of a shared tree — concurrent writes, and verification racing a half-written
edit — instead of gating around them. The advisor can run the suite whenever it likes,
because nothing is being edited underneath it.

Verified against git 2.x on this machine, because three of these bite immediately:

**Git refuses the same branch in two worktrees.** `git worktree add <path> main` fails
outright while main is checked out elsewhere. The advisor's worktree is therefore detached
at a commit, or on its own branch.

**The advisor sees committed work only — this is the significant one.** An uncommitted
edit in the implementer's worktree is invisible in the advisor's: measured, zero files.
So "the advisor sees the artifact" narrows to "the advisor sees the last commit". Getting
work in front of it needs a deliberate mechanism, and the choice is open:

  - the implementer commits per turn (natural, pollutes history with WIP)
  - the orchestrator syncs the implementer's tree into the advisor's at turn boundaries
  - the advisor reviews only at commit boundaries, which may be the honest cadence anyway

**`node_modules` is not shared.** A fresh worktree has none, so a test run there fails for
environmental reasons that look exactly like real failures to an advisor reading the
output. Either install per worktree or share a store deliberately. This generalises: any
gitignored build state the tests need is absent by construction.

**Hook configuration is per worktree.** `.claude/settings.json` and `.codex/hooks.json`
are git-ignored and rendered per checkout, so each worktree needs its own
`conclave config install`. And because Codex's trust hash covers the command string —
which contains the absolute path — **each worktree is a separate Codex trust decision**.
The registry preflight already refuses to construct a session whose hooks are registered
but untrusted, so this surfaces as a clear error rather than a silent no-hooks session.

The advisor is still read-only within its own worktree (`roles.ts` declares
`mutatesWorkspace: false`), enforced at launch via Codex's `sandbox_mode="read-only"` or
Claude's permission mode. A worktree removes the collision hazard; it does not make it
sensible for the advisor to edit.

This also reframes the arbiter (§7). It is not a separate seat compensating for an
advisor that cannot check things; it is the tool the advisor uses to check them. The
value is unchanged — a test result is ground truth neither model authored — but it is
reached by the advisor running it, not by a third participant existing.

### Open decisions

1. ~~**Narration or final message?**~~ **Decided: all prose, in both directions.** Every
   text block in a turn — the running narration — not just `last_assistant_message`.
   Symmetric: the lead receives the implementer's narration and the implementer receives
   the lead's. This matches what a human following along over remote control actually
   sees.

   The transcript is therefore the source of truth for prose, and the `Stop` hook's
   `last_assistant_message` is a fallback for when the transcript is unreadable, not the
   primary. Delivery is at turn boundaries, since that is where the orchestrator has a
   complete record with a verdict attached; streaming mid-turn is possible later but the
   evidence machinery works on turns.
2. **What ends the loop?** lead → instruct → implement → report → lead is unbounded and
   both sides spend tokens. The arbiter is the natural stopping condition.
3. **Is the recipient told an aside was private?** Bears directly on the leak above.

### Roles

Roles are orchestrator-assigned and explicit. Suggested starting set:

- `implementer` — holds the codebase context, writes and runs code, has filesystem and shell.
- `advisor` — architecture, design review, adversarial critique. Deliberately kept on a
  thin context diet. Gets summaries and diffs, not the full working set.
- `arbiter` — not a model. Tests, type checker, linter, benchmark, compiler. See section 7.

Do not let the advisor accumulate implementation context. The context isolation is a
feature, and if the advisor ends up with the same context as the implementer you have
paid for two models and bought one perspective.

### Attribution is a variable, not a default

**[Superseded for the lead model — see §5c.]** Under a lead it stops being a variable and
becomes a requirement. The reasoning below still explains why.

When the orchestrator relays a peer's position, whether it attributes the source changes
behavior measurably. "The architect thinks X" and "consider X" produce different
deference. A model that believes it is talking to a human tends toward accommodation. A
model told it is reviewing a peer model's output calibrates more skeptically.

Neither framing is obviously correct. Make it a per-message flag and run the experiment
rather than assuming the naive framing is neutral.

## 6. Human injection channel

The human's constraints must arrive at a different privilege level than peer opinion. If
"no, use GCP" looks like just another argument in the thread, the implementer may
relitigate it against the advisor's counter-argument.

Options, in rough order of preference:

1. Hook-injected developer message via `additionalContext` on `UserPromptSubmit` or
   `SessionStart`. Arrives outside the peer conversation entirely.
2. Explicitly tagged user turn, with a stable convention the system context defines up
   front, for example `[CONSTRAINT: authoritative, not open to debate] ...`.
3. Restart or fork the session with the constraint baked into the initial context.

Whatever the mechanism, the constraint should also be replayed into any newly forked or
restarted session, or it will silently expire.

**[Amended]** Option 1 is confirmed available on both CLIs. Two constraints on it: Codex
spills `additionalContext` over ~2,500 tokens to disk, so keep injected constraints
short; and on Claude Code a `SessionStart` hook blocks the first turn until it returns
or times out (measured: 2.1s baseline vs 10.0s with a hook stalled to its 10s timeout).
An injection hook that reaches out to a slow service delays session readiness by exactly
that much.

## 7. Anti-spiral mechanisms

Two agents relaying opinions will sometimes talk themselves into extended nonsense. The
fix is structural, not prompt engineering.

- **Hard round budget.** Cap agent-to-agent exchanges per topic. Two rounds, then escalate.
- **Disagreement escalates to the human, not to a third round.** Rounds three and beyond
  are where models start agreeing for social reasons rather than technical ones.
- **Non-model arbiter.** Any factual disagreement that can be resolved by running
  something should be. Write the failing test, run the type checker, benchmark it. A
  resolved empirical question ends the thread; an unresolved one goes to the human.
- **Spiral detection.** Track semantic similarity of successive turns. If positions stop
  moving, stop the loop. Do not wait for the round budget.
- **Cost ceiling per topic.** Both usage meters are finite.

## 8. Commercial risk (important, affects architecture)

Subscription-backed programmatic access has been repeatedly targeted. Timeline as
understood:

- Jan 2026: subscription OAuth tokens blocked from third-party tools, reversed within days.
- Feb 2026: ToS revised to restrict OAuth auth to Claude Code and Claude.ai.
- Early Apr 2026: policy prohibiting subscriptions powering third-party agents and harnesses.
- ~May 13 2026: reversed, with an Agent SDK credit subcategory introduced.
- Apr 21–22 2026: Claude Code removed from the Pro plan for a slice of new signups,
  reversed inside 24 hours.
- May 14 2026: announced that Agent SDK and `claude -p` usage would exit
  Pro/Max/Team/Enterprise subscription pools on June 15, moving to a separate monthly
  dollar credit at API rates.
- June 15–16 2026: that change was paused, not cancelled. Anthropic said it was revising
  the plan and would give advance notice. Some later sources describe a separate weekly
  pool as live, which contradicts the pause reporting. **Current status is genuinely
  unclear and must be checked.** Still unchecked as of step 2.

Every one of these carved at the same joint: interactive terminal use stays inside the
subscription, programmatic access gets separated. This orchestrator is squarely in the
targeted category if it uses the SDK, and squarely outside it if it drives the
interactive TUI.

That is the real reason for the PTY choice, and the reason the adapter seam in section 5
is not optional. Assume you will swap transports at least once.

Note: this is a single human at a single console using their own subscriptions on their
own machine, which is what interactive use means. It is not multi-user, not resale, not
always-on unattended automation. Keep it that way; the ToS lines that have been drawn
consistently target shared and unattended use.

**[Amended]** Codex's app-server is used in this repo only for reading configuration
(`hooks/list`), never to run turns. That stays true; it is a build-time inspection tool,
not a transport.

## 9. The panel

The panel should probably not show the transcript at all. What is useful is the diff of
positions over time:

- Where the participants disagreed, and on what specifically.
- What evidence moved someone. This is the highest-value signal and the easiest to lose.
- What is still open and awaiting the human.
- A tree of tool calls and file edits per agent, collapsed by default.
- Live cost and round-budget burn per topic.

Derive all of this from hook events and transcript JSONL. Render on a separate pane or a
local web view; do not fight the child TUIs for the terminal.

## 10. Build order

1. ~~**Spike the PTY.**~~ **Done.** `spikes/pty/`. Both CLIs boot under a PTY and accept
   keystrokes. Codex's end-to-end leg is still owed a re-run — it was cut short by an
   account usage limit, not by anything about the transport.
2. ~~**Wire hooks.**~~ **Done.** `spikes/hooks/`. `Stop` is reliable for turns that end
   on their own and useless for turns that do not. Details in section 4a and
   `spikes/hooks/FINDINGS.md`.
3. ~~**Read transcripts.**~~ **Done.** `spikes/transcripts/`. Both schemas surveyed, and
   the widened question answered: four of seven terminal outcomes are derivable from the
   child alone. `cancelled` is **not** derivable for Claude Code under any combination —
   Codex writes `turn_aborted` into its transcript, Claude Code writes nothing anywhere.
   Classifier validated at 17/17 against the recorded corpus.
4. ~~**AgentSession adapter** over 1–3, with a conformance test suite.~~ **Done for
   Claude Code.** The step-4 checkpoint passes live: start → ready → send → completed,
   send → cancel → cancelled, plus hook loss recovered via transcript reconciliation and
   transport abandonment kept distinct from process death. 38 offline tests, 5 live. Language decided: **TypeScript**, run directly on Node 24 via native type
   stripping, with `node:test` — zero runtime dependencies, matching the spikes.
   Done so far: the contract (`src/contract/`), the outcome classifier ported and
   checked for parity against the Python corpus (17/17, 4 superseded), the
   compaction-aware transcript reader with `events()`/`snapshot()` reconciliation, and
   the evidence-graded conformance suite. 24 tests passing.
   Not done: `CodexPtyHookAdapter` (hook lifecycle unverified until quota resets),
   `fork()`, and the transparent keystroke proxy from §5a.
   Registration, participant construction, role assignment and input policy are
   data-driven ahead of the configuration subsystem — see §5b.

   ~~**Next checkpoint: Codex.**~~ **Done 2026-08-05** against codex 0.146.0 — see
   `spikes/codex/FINDINGS.md`. All six questions answered from live fixtures:
   `task_complete` + `Stop`; `turn_aborted reason=interrupted` with **no** `Stop`;
   permission deny and allow (allow encoding is `y`, now verified); process exit leaving
   no terminal record in either channel; and readiness firing no hook before the first
   turn. `Stop` and `turn_aborted` proved mutually exclusive, so the precedence rule is a
   guard rather than a live path. `SessionEnd` was never observed — registered, trusted,
   and no run achieved a clean exit, so it stays *not observed* rather than unsupported. Until those
   exist, Codex staying visibly lower-confidence than Claude is correct behaviour rather
   than unfinished polish.
5. **Two-party relay.** **[Revised — see §1 and §5c.]** Not a peer relay: declare a lead,
   let it start the implementer's session, feed it the implementer's prose, and route its
   instructions back. Prose only in both directions. Broadcast the human's messages to
   both, support a private aside to one. Print a raw routing log — it is the only complete
   record of who saw what. Confirm the loop is stable before adding intelligence.
6. **Round budget and escalation.** Add the anti-spiral machinery before the orchestrator
   model, because you will need it immediately.
7. **Orchestrator model.** Role assignment, summarization, constraint routing.
8. **Panel.**
9. **Third participant.** Only once two works. A local open-weights model is a reasonable
   adversarial critic for "does this claim match what the code actually does," and cheap
   enough to run several and take a majority. It is a poor fit for architectural
   judgment, where a weak participant adds plausible noise the strong models then spend
   rounds refuting. Tier roles by what the seat needs.

Stop after step 5 and evaluate honestly whether the output is better than a single agent.
It may not be. That is a real possible finding and worth recording either way.

## 11. Verify first

These change frequently. Check before relying on any of them.

- `codex --version`, `claude --version`. **Verified 2026-08-05:** claude 2.1.222,
  codex 0.146.0.
- Hook event names and payload schema for the installed Codex version. **Verified**; see
  section 4.
- Claude Code hook event names and payload schema. **Verified**; see section 4.
- Actual transcript JSONL schema for both. **Verified**; see `spikes/pty/FINDINGS.md`.
- Current subscription billing status for Agent SDK and `claude -p`. Anthropic Help
  Center is authoritative; secondary reporting on this has been wrong repeatedly in both
  directions. **Still unverified.**
- Whether Codex still requires a git repo for non-interactive runs
  (`codex exec --skip-git-repo-check` exists as an override). **Verified:** the TUI does
  not require a git repo; it requires directory trust. This project is not a git repo and
  Codex runs in it.

## 12. Open questions

- Does the implementer behave differently when it knows a peer model is reviewing versus
  when the review arrives as user feedback? Testable, and the answer should drive the
  attribution flag.
- Does context isolation or model diversity contribute more of the benefit? Run the
  advisor as a second Claude Code instance with a thin context diet and compare against
  Codex as advisor.
- Is there a clean way to hand the advisor a diff plus a targeted slice of the codebase
  without it going and reading everything? Both CLIs will explore if allowed to.
- How much does the orchestrator's summarization lose? Consider logging both the raw
  relay and the summary and diffing them periodically.
- **[Added]** What is the authoritative turn-completion signal for a cancelled turn? No
  hook fires and no assistant entry is written. Candidates: UI-idle detection (rejected —
  section 3), a `UserPromptSubmit`-to-`Stop` watchdog, or driving cancellation only
  through the orchestrator so it always knows. See `spikes/hooks/FINDINGS.md`.
