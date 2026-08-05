# Codex runtime semantics — fixture record

Run date: 2026-08-05. codex-cli **0.146.0**, model `gpt-5.6-sol`.
Collected by `node spikes/codex/collect.ts`. Raw observations in `runs/*.json`, raw PTY
streams in `runs/*.pty.log`, hook journals in `journal/`.

This document records **what was observed**. Grading and classifier changes are a
separate step, deliberately made after the fixtures were written.

Corpus safety: every child was launched with `SPIKE_HOOK_JOURNAL` redirected, so the
frozen `spikes/hooks/journal/hook-journal.ndjson` behind the parity test's exact 17/4
counts was never appended to. Each run asserts this and reported `UNTOUCHED`.

## The matrix

Hooks registered for these runs: `SessionStart`, `UserPromptSubmit`, `PermissionRequest`,
`Stop`, `SessionEnd`.

| scenario | hooks fired | transcript events | file effect |
|---|---|---|---|
| completed | SessionStart, UserPromptSubmit, **Stop** | task_started, user_message, agent_message, **task_complete** | — |
| cancelled (ESC mid-turn) | SessionStart, UserPromptSubmit — **no Stop** | task_started, user_message, **turn_aborted** `reason=interrupted` | — |
| permission deny (ESC) | SessionStart, UserPromptSubmit, **PermissionRequest** — **no Stop** | **turn_aborted** `reason=interrupted`, patch_apply_end | not created |
| permission allow (`y`) | SessionStart, UserPromptSubmit, **PermissionRequest**, **Stop** | patch_apply_end, **task_complete** | created |
| process exit (SIGTERM mid-turn) | SessionStart, UserPromptSubmit — **no Stop, no SessionEnd** | task_started, user_message — **no terminal record** | — |
| readiness (no turn) | **none at all** | — | — |

## Answers to the six questions

**1. Normal completion.** `Stop` fires and carries `turn_id`, `session_id`,
`transcript_path`, `cwd`, `model`, `permission_mode`, `stop_hook_active`, and
`last_assistant_message`. The transcript independently records `task_complete`. Two
channels agree, and `turn_id` is confirmed as the correlation key — previously reasoned,
now observed.

**2. Cancellation — the biggest unknown, now settled.** `turn_aborted` appears with
`reason=interrupted`. **`Stop` does NOT fire.** They are mutually exclusive; no run
produced both, so the ordering question ("which arrives first") does not arise.

The precedence rule (`turn_aborted > Stop`) is therefore **inert in practice** on 0.146.0.
It stays, because it is correct and costs nothing, and because a future version emitting
both must not silently upgrade a cancellation to a completion. But it is now a guard
rather than a live path, and the honest grade for it is unexercised.

Notably this matches Claude Code exactly on the hook channel — neither agent fires `Stop`
on cancellation. The difference is that Codex *records* the cancellation and Claude
records nothing anywhere.

**3. Permission deny.** `PermissionRequest` fires, carrying `tool_name`, `tool_input`,
`turn_id` and `permission_mode`. `Stop` does not follow. The transcript records
`turn_aborted reason=interrupted` — **the same record a user cancellation produces**.

So on Codex, as on Claude, `permission_refused` and `cancelled` are indistinguishable from
the terminal record alone. `PermissionRequest` having fired is the discriminator. The
structure of the evidence is identical across both adapters even though the underlying
records are completely different.

Dialog wording, captured verbatim:

```
Would you like to make the following edits?
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for these files (a)
  3. No, and tell Codex what to do differently (esc)
```

Deny encoding: `ESC`. Confirmed — file not created, `turn_aborted` recorded.

**4. Permission allow.** Encoding: **`y`**. Confirmed — file created, `Stop` fired,
`task_complete` recorded. `PermissionRequest` fires identically for allow and deny, so it
signals a pending decision, never its outcome; only the presence or absence of `Stop`
separates them.

**5. Process exit.** SIGTERM mid-turn produced `SessionStart` and `UserPromptSubmit`, and
nothing else. No `Stop`, **no `SessionEnd`**, and the transcript ends after
`user_message` with no `task_complete` and no `turn_aborted`. A killed Codex turn leaves
no terminal record in either channel.

Caveat worth keeping: `SessionEnd` was registered and trusted but never fired in any
scenario. No run achieved a *clean* exit — `terminate()` reported `sigterm` every time,
because Codex does not quit promptly on Ctrl-C. So this is "not observed", not "does not
exist"; a `/quit` path is untested.

**6. Readiness.** **No hook fires before the first turn** — not even `SessionStart`. This
confirms, on 0.146.0, what spike 2 inferred from a boot that produced nothing and an
app-server `thread/start` that also produced nothing: Codex's `SessionStart` is
turn-scoped, not session-scoped.

Timing across two runs: interactive at 2.5s and 3.7s, with input accepted 3ms and 10ms
later respectively. So for Codex, readiness and input-acceptance are effectively the same
moment, and both are determined by the TUI negotiating raw mode — not by any hook.

This is a hard divergence from Claude Code, where `SessionStart` fires at boot and
*blocks* the first turn until it returns. The two adapters cannot share a readiness
strategy.

## Things observed that were not being looked for

**`SessionEnd` timeout is clamped.** Installing the extended sidecar produced:

```
config warning: clamping SessionEnd hook timeout to 3s
```

Configured at 10s like the others. Codex silently caps `SessionEnd` at 3 seconds — a hook
that needs longer will be killed.

**`patch_apply_end`** appears in the transcript for both allow and deny. Present in the
historical survey but not previously connected to permission flows.

**A parser bug, found by real data.** `task_started` is written **before** `user_message`,
not after. `parseCodex` assumed the opposite and created a phantom second turn for every
exchange — visible as `codex-pending-1` alongside the real `turn_id`-keyed turn. Fixed;
the turn now takes its prompt from `user_message` when it arrives rather than creating a
new record. This was not detectable from the historical rollout survey, which only counted
event types.

**Permission prompts require configuration to reach.** With default TUI settings an
out-of-workspace write was auto-approved with no dialog at all, and the first two
permission runs silently exercised nothing. `-c approval_policy="on-request"` plus
`-c sandbox_mode="read-only"` forces the escalation. Under `codex exec` the escalation is
auto-denied instead (`approval escalation is disabled`), so permission behaviour cannot be
observed non-interactively at all.

## Payload shapes

All five hooks share `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`,
`permission_mode`. Additionally:

- `SessionStart`: `source` (observed: `startup`). **No `turn_id`** — consistent with it
  being turn-scoped but fired before the turn id exists.
- `UserPromptSubmit`: `turn_id`, `prompt`
- `PermissionRequest`: `turn_id`, `tool_name` (observed: `apply_patch`), `tool_input`
- `Stop`: `turn_id`, `stop_hook_active`, `last_assistant_message`
- `SessionEnd`: never observed

## Structural comparison

| | Claude Code 2.1.222 | Codex 0.146.0 |
|---|---|---|
| completion | `Stop` | `Stop` **and** `task_complete` |
| cancellation | nothing, anywhere | `turn_aborted` with reason |
| `Stop` on cancellation | no | no |
| permission discriminator | `PermissionRequest` | `PermissionRequest` |
| deny vs cancel in transcript | both invisible | both `turn_aborted reason=interrupted` |
| correlation key | `prompt_id` | `turn_id` |
| readiness | `SessionStart` at boot, blocks first turn | no hook; TUI raw-mode negotiation |
| `SessionEnd` on SIGTERM | fires, `reason=other` | not observed |
| transcript after SIGKILL/TERM | truncated but present | present, no terminal record |

The evidence *structure* converges more than expected: both need `PermissionRequest` to
separate refusal from cancellation, and neither proves cancellation from `Stop`. The
divergence is in readiness and in whether cancellation is recorded at all.

## Not yet observed

- `SessionEnd` in any Codex scenario, including a clean `/quit`.
- Compaction (`compacted` / `context_compacted`) in a live run.
- `turn_aborted` and `Stop` co-occurring — the precedence rule remains a guard.
- Tool-call failure as distinct from permission denial.
- Whether a second turn in one session re-fires `SessionStart`.
