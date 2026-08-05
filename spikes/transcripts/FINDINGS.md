# Spike 3 — transcripts and terminal outcomes. Findings

Run date: 2026-08-05. claude 2.1.222, codex 0.146.0.
Purpose was widened beyond schema discovery: determine whether any combination of
transcript state, process state and hooks can distinguish the abnormal terminal
outcomes.

```
python3 spikes/transcripts/characterize.py          # schema survey, both formats
python3 spikes/transcripts/outcomes.py --validate   # classifier vs recorded corpus
python3 spikes/transcripts/outcomes.py --demo       # the discriminating cases
```

## Answer

Partly, and asymmetrically. Four of the seven outcomes are now derivable from the child
alone. **`cancelled` is not derivable for Claude Code under any combination** — it is
knowable only from the orchestrator's record of its own actions. Codex, by contrast,
writes the abort into its transcript outright.

`PermissionRequest` turned out to be the missing discriminator on Claude Code, and it
does fire — the earlier conclusion that it did not was wrong, and wrong for an
instructive reason (below).

## Evidence table — Claude Code 2.1.222

Hooks now registered: `SessionStart`, `UserPromptSubmit`, `PermissionRequest`,
`Notification`, `Stop`, `SessionEnd`.

| how the turn ended | UserPromptSubmit | PermissionRequest | Stop | SessionEnd | assistant entry | process |
|---|---|---|---|---|---|---|
| completed | 1 | 0 | **1** | on exit | yes, `end_turn` | alive |
| tool exited 42 | 1 | 0 | **1** | on exit | yes, `tool_use`→`end_turn` | alive |
| ESC while thinking | 1 | 0 | **0** | on exit | **none** | alive |
| permission refused | 1 | **1** | **0** | on exit | **none** | alive |
| SIGTERM mid-turn | 1 | 0 | 0 | **1**, `reason=other` | none | dead |
| SIGKILL mid-turn | 1 | 0 | 0 | **0** | **no transcript file at all** | dead |

Three things fall out of this.

**`SessionEnd` fires on SIGTERM and not on SIGKILL.** That makes it a real
process-exit signal with a `reason` field — observed values `prompt_input_exit`
(graceful Ctrl-C) and `other` (SIGTERM). It is a *session* boundary, not a turn
boundary, so it cannot substitute for `Stop`.

**SIGKILL destroys the transcript.** The SIGKILLed session left no transcript file
whatsoever, while the SIGTERMed one left a truncated but real file. Whatever flush
happens on SIGTERM does not happen on SIGKILL. **The adapter must always SIGTERM and
wait before escalating**, or it discards the only durable record of the turn.

**`PermissionRequest` separates refusal from cancellation.** Payload carries
`tool_name`, `tool_input`, `permission_suggestions`, `prompt_id`, `permission_mode`. It
fires on *request*, not on decision — so it does not prove a refusal by itself. Combined
with the absence of `Stop` it does, because an allow would have produced one.

## Why the earlier "PermissionRequest never fires" reading was wrong

Worth recording, because the failure mode will recur. Three successive runs of the
permission scenario never exercised a permission decision at all:

1. The scenario waited for its own prompt text (`spike-permission-probe`) to appear,
   which the TUI echoes immediately — so ESC was sent while the model was still
   thinking. It measured cancellation and labelled it refusal.
2. Corrected to wait for dialog text, but a bare `echo` is **auto-allowed even in manual
   mode**, so no dialog ever appeared and the turn completed normally.
3. Corrected to a file write, but an in-cwd write did not prompt either.

Only a write *outside the workspace* (`/tmp/...`) produced a dialog, and then
`PermissionRequest` fired immediately. The general lesson matches spike 1's: **any check
that can be satisfied by the CLI echoing our own input is not a check.** All four of
these runs are kept in the corpus and reported as excluded rather than deleted;
`outcomes.py --validate` prints them with what the classifier says they actually were.

## Codex writes turn lifecycle into the transcript

Surveyed 530 historical rollouts. `event_msg` payload types include `task_started`
(699), `task_complete` (696), and **`turn_aborted` (6)**:

```json
{"type": "turn_aborted", "turn_id": "019c7c37-...", "reason": "interrupted"}
```

So for Codex, cancellation is **proven** from the transcript with no hook involvement
and no orchestrator bookkeeping. `task_complete` carries `turn_id` and
`last_agent_message`, mirroring Claude's `Stop.last_assistant_message`.

This is the largest behavioural asymmetry found so far, and it cuts against the earlier
assumption that the two adapters would differ mainly in wiring:

| | Claude Code | Codex |
|---|---|---|
| turn completion | `Stop` hook | `task_complete` in transcript (and presumably `Stop`) |
| turn cancellation | **nothing, anywhere** | `turn_aborted` with reason, in transcript |
| turn correlation key | `prompt_id` | `turn_id` |
| session readiness | `SessionStart` at boot | **not** at boot — see spike 2 |

Codex's hook lifecycle is still unverified pending quota (resets Aug 9). If its `Stop`
behaves like Claude's, the transcript remains the better source for Codex regardless,
because it distinguishes more outcomes.

## Schema notes for step 4

**Claude Code** line types: `assistant`, `user`, `attachment`, `system`, `last-prompt`,
`mode`, `permission-mode`, `ai-title`, `pr-link`, `bridge-session`, `queue-operation`,
`file-history-snapshot`, `file-history-delta`. Assistant `stop_reason` observed:
`tool_use` (20410), `end_turn` (1304), `stop_sequence` (6). Content blocks:
`tool_use`/`tool_result` pairs, `text`, `thinking`.

Hook outcomes are recorded in the transcript as attachments — `hook_success`,
`hook_cancelled`, `hook_non_blocking_error`, `hook_additional_context`,
`command_permissions`. So a hook failure is auditable after the fact even though the UI
does not surface it live (spike 2, objective 5).

**Codex** line types: `session_meta`, `turn_context`, `world_state`, `response_item`,
`event_msg`, `compacted`. `response_item` types: `message`, `reasoning`, `function_call`,
`function_call_output`, `custom_tool_call`, `custom_tool_call_output`, `web_search_call`.
`session_meta` carries `session_id`, `id`, `parent_thread_id`, `cwd`, `cli_version`,
`originator`, `source`, `thread_source`, `git`, `base_instructions`, `context_window`.

Note `compacted` and `context_compacted` — compaction rewrites history, so a reader that
caches parsed transcript state must invalidate on those.

## The classifier

`spikes/transcripts/outcomes.py` implements the outcome enum with provenance and a
confidence grade:

- `proven` — a positive signal from the child says so
- `inferred` — composite of signals, none decisive alone
- `assumed` — the orchestrator's own bookkeeping, unverifiable from the child
- `uncertain` — absence of evidence only

Validated against the step-2 corpus: **17 runs classified, 0 mismatches**, 4 runs
excluded as superseded and reported individually.

Rule order matters and is deliberate. `Stop` wins outright. Codex's `turn_aborted` is
next. A dead process outranks permission and cancellation because it explains a missing
`Stop` on its own. The watchdog is **last** and never returns `cancelled`:

```
silent for 400s, input mediated       -> timed_out             uncertain
silent for 400s, input NOT mediated   -> unknown_abnormal_end  uncertain
```

Both carry the provenance line *"completion is uncertain; this is not evidence of
cancellation"*. A deadline can retire a stuck turn; it cannot say why it stuck.

`IN_PROGRESS` is modelled separately from `UNKNOWN_ABNORMAL_END` on purpose. "Still
going" and "ended somehow" are different claims, and silence supports only the first.

## The product decision this forces

On Claude Code, `cancelled` is only ever `assumed` — it rests entirely on the
orchestrator knowing it sent ESC. That holds if and only if the orchestrator owns all
input. The classifier makes the consequence explicit rather than hiding it:

```
ESC while thinking, input mediated    -> cancelled             assumed
ESC while thinking, human typed it    -> unknown_abnormal_end  uncertain
```

So: **is the child pane directly interactive, or is all meaningful input mediated by the
orchestrator?**

- **Mediated only.** `cancelled` and `permission_refused` stay determinable on both
  agents. Session state stays authoritative. Cost: the human loses direct access to a
  working TUI, and the orchestrator must proxy every affordance — including permission
  dialogs, which are latency-sensitive and have their own keybindings.
- **Directly interactive.** Better ergonomics, and the human can rescue a stuck child.
  Cost: on Claude Code the orchestrator cannot distinguish a cancelled turn from a
  stalled one, so `cancelled` collapses into `unknown_abnormal_end`. Codex is unaffected
  because its transcript records the abort regardless.
- **Mediated by default, direct as an explicit escape hatch** that marks the session's
  state as no-longer-authoritative until the next `Stop`. Keeps the common path
  determinable and makes the degradation visible instead of silent.

This is not resolvable from the code and should be decided before `AgentSession` is
defined.

## Consequences for the adapter interface

`events()` cannot promise a clean `turn_end`. The conformance contract should require
that a terminal event carry `outcome`, `confidence` and `provenance`, and permit it to
be synthesized rather than observed. An adapter that emits a bare `turn_end` is hiding
exactly the transport difference the seam exists to contain.

Corollaries: the terminal event may arrive with no corresponding child signal
(synthesized from process state or a watchdog); it may be revised — a turn classified
`timed_out` can later be superseded by a late `Stop`; and `turn_key` should stay opaque,
since it is `prompt_id` on one adapter and `turn_id` on the other.

## Still open

- Codex hook lifecycle, entirely. Quota resets Aug 9.
- Whether Codex's `Stop` fires on cancellation given that `turn_aborted` already exists.
- `timed_out` and `transport_lost` have no recorded fixtures — both are currently
  reasoned, not observed. `transport_lost` in particular is modelled as "an observation
  channel went away", which is not yet exercised by any scenario.
- Whether a granted permission followed by a stall is distinguishable from a refusal.
  Current rule assumes an allow always yields `Stop`; unverified.
