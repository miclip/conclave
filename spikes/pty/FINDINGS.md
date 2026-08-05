# Spike 1 — PTY transport. Findings

Run date: 2026-08-05. Machine: darwin 25.5.0, macOS/arm64.
Reproduce: `python3 spikes/pty/spike.py --target both`

## Verdict

**The PTY transport works.** Both CLIs boot their real interactive TUI under a
pseudo-terminal, and bytes written to the PTY master arrive as genuine keystrokes.

| | claude 2.1.222 | codex 0.146.0 |
|---|---|---|
| (a) real interactive TUI under PTY | PASS | PASS |
| (b) keystrokes land and echo | PASS | PASS |
| (c) turn submitted, agent answered | PASS | blocked — see below |
| (d) answer reached on-disk transcript | PASS | not reached |

Codex's (c)/(d) did not fail for transport reasons. The turn was accepted and the UI
entered "Working" before the account hit its usage limit ("try again at Aug 9th, 2026").
Everything the spike was designed to prove about the mechanism was proven; re-run the
codex leg after the quota resets to close it out.

Build order step 1 is satisfied. Nothing found here blocks step 2.

## Corrections to the design brief

**§3 is wrong about the alternate screen buffer.** The brief states "Both CLIs are
full-screen apps using the alternate buffer". Claude Code 2.1.222 never emits
`ESC[?1049h` — it renders *inline* on the main buffer with cursor-addressed partial
redraws. Codex does not emit it either. Private modes actually observed:

- claude: `?2004h` (bracketed paste), `?1004h` (focus events), `?25l/h` (cursor)
- codex: `?2004h`, plus `>4;0m` / `>7u` (modifyOtherKeys, Kitty keyboard protocol)

The brief's *conclusion* survives intact and is arguably strengthened — inline redraw
with cursor-up rewrites is no more parseable than an alt-screen app, and codex
negotiating the Kitty keyboard protocol means even keystroke encoding is non-trivial.
Do not parse the screen. But the detection heuristic had to change: the spike now tests
for bracketed-paste/focus-event mode, not alt-screen, because alt-screen would have
reported a false negative on both.

## Blockers a driver must handle

### 1. Env leakage silently disables transcript persistence

Spawning from inside an agent session leaks `CLAUDE_CODE_CHILD_SESSION`, and the child
then prints:

```
⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker
```

No transcript file is written at all. Since build order step 3 reads exactly those
files, this would have looked like a transcript-schema problem much later. The spike
now scrubs `CLAUDE*`, `CODEX*`, `ANTHROPIC_*`, `OPENAI_*`, `AI_AGENT`, `CI`,
`TERM_PROGRAM*` before exec. **The adapter must own its child env explicitly rather
than inheriting.**

Leaking vars observed: `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`,
`CLAUDE_CODE_EXECPATH`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`.

### 2. Pre-session interstitials eat input

Both CLIs may show blocking dialogs before the composer is live. Typing into them
selects menu items. This is not hypothetical — during this spike:

- codex's **startup update prompt** consumed the typed text and its default selection
  ran `npm install -g @openai/codex`, upgrading 0.144.6 → 0.146.0 mid-run;
- codex's **directory trust prompt** swallowed the first word of the prompt ("Reply "),
  and answering it wrote `trust_level = "trusted"` for this directory into `config.toml`.

Suppress rather than answer. Config keys found in the codex binary:

```
-c check_for_update_on_startup=false     # kills the update interstitial
-c disable_paste_burst=true              # keystroke coalescing can swallow the submit
```

Trust should be pre-seeded in `~/.codex/config.toml` under `[projects."<path>"]`, not
clicked through. Note the dialog's own wording: *"Trusting the directory allows
project-local config, hooks, and exec policies to load"* — this confirms §4's claim
that project-local hooks require trust, which matters directly for step 2.

There is no general "wait until ready" signal from the screen, and inventing one means
screen-scraping. **Prefer the `SessionStart` hook as the readiness gate** (step 2)
rather than a settle-timer. The spike's `wait_quiet` heuristic is spike-grade only.

### 3. Input must be typed, then submitted separately

Writing the text and `\r` as one burst is unreliable. The spike types the body, waits
~400ms, then sends `\r` alone. Combined with `disable_paste_burst`, this was reliable
across runs.

## Verified against the installed toolchain

- `claude --version` → **2.1.222**; `codex --version` → **0.146.0** (was 0.144.6).
- Codex `hooks` feature: **stable and enabled by default** (`codex features list`).
- Codex hook events present in the 0.146.0 binary — matches §4 exactly:
  `SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest,
  PreCompact, PostCompact, SubagentStart, SubagentStop, Stop`.
- `hookSpecificOutput.additionalContext` exists as a wire type for `SessionStart` and
  `UserPromptSubmit`. **The §6 human-constraint channel is real.**
- Hook payload fields confirmed: `hook_event_name`, `transcript_path`, and additionally
  `agent_transcript_path` (undocumented in the brief; relevant to subagent turns).
- Codex hooks support three handler kinds, not just shell commands:
  `ConfiguredHookHandler::{Command, Prompt, Agent}`. Worth investigating for step 7 —
  a `Prompt` handler may inject without a subprocess round-trip.
- Codex rollout JSONL line types: `session_meta`, `turn_context`, `world_state`,
  `event_msg`, `response_item`. `session_meta` carries `session_id`, `parent_thread_id`,
  `cwd`, `cli_version`, `source`, `git`. `event_msg` carries `turn_id` — usable turn
  boundaries without hooks, as a fallback.
- Claude transcript JSONL line types: `assistant`, `user`, `attachment`, `system`,
  `permission-mode`, `mode`, `last-prompt`, `ai-title`, `file-history-snapshot`,
  `bridge-session`. Path confirmed: `~/.claude/projects/<slug>/<session-id>.jsonl`
  where `<slug>` is the cwd with `/` → `-`.
- `codex exec --skip-git-repo-check` still exists. The **TUI** does not require a git
  repo; it requires trust. This directory is not a git repo and codex ran fine.
- Codex app-server exposes `turn/start.additionalContext` and
  `turn/steer.additionalContext` — a second constraint-injection channel if the
  transport is ever swapped per §8.

## Not yet verified

- Current subscription billing status for Agent SDK / `claude -p` (§8, §11). Needs the
  Anthropic Help Center; unresolved as of this spike.
- Claude Code hook payload schema against 2.1.222 specifically. Global hooks are
  already wired on this machine (`~/.claude/settings.json` → sinesync), so step 2 must
  add project-local hooks rather than edit the global file.
- Whether `Stop` is a reliable turn-complete signal for both. That is step 2 and the
  single most valuable thing to nail down next — it removes every timing heuristic in
  this spike.

## Side effects of this spike on the machine

1. codex upgraded 0.144.6 → 0.146.0 (unintended; see blocker 2).
2. `/Users/miclip/workspace/coding-repl` added to `~/.codex/config.toml` as trusted.
3. Codex account usage limit exhausted; resets Aug 9th 2026.
4. Two short claude sessions written to `~/.claude/projects/-Users-miclip-workspace-coding-repl/`.
