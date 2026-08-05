# Spike 2 — lifecycle hooks. Findings

Run date: 2026-08-05. claude 2.1.222, codex 0.146.0.
Scope was deliberately narrow: register only `SessionStart` and `Stop`, POST raw
payloads to a local receiver, and characterise the lifecycle. No common event model was
built; normalisation waits for step 3/4.

Reproduce:
```
python3 spikes/hooks/receiver.py &          # capture to fixtures/
python3 spikes/hooks/matrix.py --all --agent claude
python3 spikes/hooks/receiver_restart_test.py
python3 spikes/hooks/verify_codex_hooks.py
python3 tests/test_childenv.py
```

## Headline

**`Stop` is a reliable turn-complete signal only for turns that end by themselves.**
Every way a turn can end *early* — user cancellation, refused permission, process
termination — produces no `Stop` at all. An orchestrator that waits on `Stop` as its
only turn boundary will hang on exactly the cases a human is most likely to trigger.

This does not invalidate the hybrid transport in brief §3, but it does mean the output
side needs a third input beyond hooks and transcripts: a supervisor that can declare a
turn over without a hook.

## Objective 4 — does Stop fire exactly once?

Claude Code 2.1.222. Counts are from the hook's own journal (what the CLI fired),
cross-checked against receiver deliveries.

| scenario | how the turn ended | SessionStart | Stop | expected | verdict |
|---|---|---|---|---|---|
| `session_start_only` | no turn at all | 1 | 0 | 0 | ok |
| `normal` | completed | 1 | 1 | 1 | ok |
| `two_turns` | two completed turns | 1 | 2 | 2 | ok — Stop is per-turn, not per-session |
| `tool_error` | tool exited 42, turn completed | 1 | 1 | 1 | ok |
| `interrupted` | ESC mid-turn | 1 | **0** | 1 | **no Stop** |
| `permission_denied` | permission prompt refused | 1 | **0** | 1 | **no Stop** |
| `sigterm` | SIGTERM mid-turn | 1 | **0** | — | **no Stop** |
| `sigkill` | SIGKILL mid-turn | 1 | 0 | 0 | ok (floor case) |

Where it fires at all, it fires exactly once — no duplicates in any scenario, including
two turns in one session and a hook that exited non-zero.

**A tool failing is not a turn failing.** `tool_error` ran a command that exited 42; the
agent reported the code and the turn completed normally, with one `Stop`. So "agent/tool
error" splits in two: tool-level failures are ordinary completed turns, and turn-level
failures produce nothing.

**Cancelled turns are invisible to both channels.** The interrupted session's transcript
(`2d5725bb-…jsonl`) contains the user message and no assistant entry, no partial output,
and no interruption marker. So the transcript does not rescue what the hook misses. This
is the single most important gap found in step 2.

`SessionStart` fired reliably in every scenario including SIGKILL, because it fires at
boot before anything can go wrong.

## Objective 5 — blocking, timeouts, retries, silent drops

- **Blocking: yes for `SessionStart`.** A `SessionStart` hook stalled to its timeout
  delayed the first turn's answer to **10.0s** against a **2.1s** baseline — exactly the
  configured 10s timeout. Session readiness is gated on it.
- **Blocking: no for `Stop`.** After the answer appeared, typing echoed with no
  measurable delay while stop hooks were still running. The UI shows
  `(running stop hooks… 1/2)` but stays responsive.
- **Timeout: yes, enforced by killing the process.** A hook told to sleep 20s under a 10s
  timeout never wrote its post-POST journal record, in any run. The POST itself had
  already succeeded, so the delivery landed and the hook was then killed mid-sleep.
- **Retries: none.** Confirmed twice — see objective 6.
- **Silent drops: yes, when the hook exits 0.** With the receiver unreachable, the hook's
  stderr complaint was never surfaced and the UI showed only
  `(running stop hooks… 1/2)`. The turn completed normally and the user would have no
  idea a delivery was lost.
- **Non-zero exit is surfaced but non-blocking.** With `SPIKE_HOOK_EXIT=1` the UI showed
  `Stop hook error: Failed with non-blocking status code`, a `Ran 2 stop hooks` summary,
  and a persistent `Stop hook error occurred · ctrl+o to see` indicator. The turn still
  completed and `Stop` still fired exactly once.

The practical consequence: **a hook that cannot deliver must exit non-zero**, or its
failure is invisible. Our `hook_post.py` currently exits 0 on POST failure, which is
right for observation and wrong for production.

`Ran 2 stop hooks` also confirms project-local and global hooks are additive. The global
`~/.claude/settings.json` (sinesync) was not modified and continued to run alongside ours
throughout.

## Objective 6 — receiver restart mid-session

One session, three turns, receiver killed after turn 1 and restarted before turn 3:

```
turn 1  receiver up     stop fired=1  delivered=1
turn 2  receiver down   stop fired=2  delivered=1   <- lost
turn 3  receiver back   stop fired=3  delivered=2
totals: fired=3 delivered=2 lost=1
```

- The child session was unaffected: turns 2 and 3 both answered normally.
- No error reached the user during the outage.
- **No retry.** Four seconds after the receiver came back and before turn 3, deliveries
  were still 1. The lost delivery stays lost.
- The receiver resumes its sequence from disk, so the outage shows up as a gap in
  `fixtures/index.ndjson` rather than as overwritten fixtures.

The harness reports `session survived receiver outage: False`, which is a reporting
artifact: turn 1's answer token was not detected in the UI stream even though the turn
completed and its `Stop` fired and delivered. Turns 2 and 3 confirm survival. The
detection miss is cosmetic; the fired/delivered/retry numbers are sound.

**Design consequence:** delivery must be durable at the hook, not at the receiver. The
local journal already works this way and should stay — it is the only reason the lost
delivery above is even countable.

## Codex

Registration is verified; lifecycle is not, because the account hit its usage limit
during spike 1 (resets Aug 9) and every `Stop` scenario needs a real turn.

Confirmed working:
- Project-local `.codex/hooks.json` loads, and both hooks report
  `source=project trust=trusted enabled=True timeout=10` via the app-server
  `hooks/list` RPC.
- Three registration gotchas, all silent, now documented in brief §4.

Confirmed *not* working as assumed:
- **`SessionStart` did not fire on TUI boot**, with hooks trusted and enabled. It also
  did not fire on an app-server `thread/start`. It is therefore not a boot-readiness
  signal for Codex the way it is for Claude Code, and most likely fires on first turn.
  Unverified pending quota.

Still owed for Codex: the whole objective-4 matrix, plus blocking/timeout behaviour.
`async: false` and `timeout` are configured, and `HookExecutionMode: sync|async` in the
protocol implies async hooks are available and would not block — untested.

## Fixtures

27 raw payloads captured under `fixtures/`, as `NNNN-<agent>-<event>.raw` (exact request
body bytes, unmodified) alongside `.meta.json` (headers, both timestamps, transit time,
peer, sequence, receiver generation). Observed keys:

- `SessionStart`: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`,
  `source`
- `Stop`: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `prompt_id`,
  `permission_mode`, `effort`, `stop_hook_active`, `last_assistant_message`,
  `background_tasks`, `session_crons`

Two things worth noting for step 3/4. Turn correlation is `prompt_id`, not the `turn_id`
the brief assumed. And `Stop` carries `last_assistant_message` — for simple relays the
answer may not require reading the transcript at all.

`stop_hook_active` exists to let a hook detect that it is running inside a
stop-hook-triggered continuation. Relevant once the orchestrator starts injecting.

## Environment invariant

`spikes/common/childenv.py` plus `tests/test_childenv.py`, 9 tests, all passing. Both
integration halves run real Claude sessions: a sanitized spawn writes a transcript
containing its own answer, and a spawn with `CLAUDE_CODE_CHILD_SESSION` reintroduced
writes none. The negative half is the one that matters — the failure is silent, so a
happy-path test would pass with the sanitizer deleted.

`test_no_novel_parent_agent_vars_in_this_process` will fail when the toolchain
introduces a marker nobody has reviewed. That is a prompt to look, not necessarily a bug.

## What step 2 changes about the design

1. **Turn completion needs a supervisor, not just a hook.** Options, none yet chosen:
   pair `UserPromptSubmit` with `Stop` and treat an unmatched prompt past a deadline as
   an abnormal end; route all cancellation through the orchestrator so it never has to
   infer one; or watch the transcript file for the assistant entry that a completed turn
   always writes. The first is cheapest and does not require screen parsing.
2. **`SessionStart` is the readiness gate for Claude Code and is not one for Codex.**
   The adapter cannot share one readiness strategy across both.
3. **Hook delivery must be durable at the hook.** No retries exist upstream.
4. **Hooks must exit non-zero to be seen.** Exit 0 makes failure invisible.
5. **Registration is easy to get silently wrong on Codex** — trust hashes, `timeout` vs
   `timeoutSec`, ignored unknown fields. `verify_codex_hooks.py` should run in CI before
   any run that depends on hooks.

## Side effects on the machine

- `~/.codex/config.toml` gained `[hooks.state.…]` trust entries for this project's hooks.
  Written by Codex itself when trust was granted; unavoidable, and user-level rather than
  project-level.
- ~20 short Claude sessions and transcripts under
  `~/.claude/projects/-Users-miclip-workspace-coding-repl/`.
- Global `~/.claude/settings.json` untouched, as instructed and as verified by the
  `Ran 2 stop hooks` output.
