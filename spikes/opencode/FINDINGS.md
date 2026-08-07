# OpenCode — `run --format json`

Measured against **opencode 1.18.15** on 2026-08-07. Fixture: `fixtures/edit-turn.ndjson`,
the verbatim stdout of a real three-step, two-tool, file-writing turn.

## The lifecycle is announced, not recovered

Everything Conclave had to reverse-engineer for the other two agents, OpenCode states
directly. One JSON record per line on stdout:

```
step_start                       part.snapshot = content hash
tool_use    part.tool, part.state{status,input,output,metadata.diff}
step_finish part.reason = "tool-calls"  intermediate
                       = "stop"         TERMINAL
            part.tokens{total,input,output,reasoning,cache{read,write}}
text        part.text
```

`sessionID` is on every record, and `run --session <id>` resumes with context intact — so a
long-lived Conclave session is a sequence of short-lived children sharing one id, with no
pty, no hook registration and no transcript parser.

**`step_finish reason=stop` is the `Stop` equivalent.** Verified across a turn with three
steps and two tool calls: it appears exactly once, on the final step.

## Exit 0 is not evidence of a completed turn

A run can exit 0 having silently failed an auxiliary model call. Observed directly: OpenCode
uses a second, small model (`gpt-5.4-nano`) to title sessions, and on an account without a
payment method that call fails —

```
AI_APICallError: No payment method. Add a payment method here: .../billing
```

— while the requested model completes the work and the process exits 0. The adapter
therefore grades on the announced record and treats a bare exit 0 with no `stop` as
`unknown_abnormal_end`.

## The wedge: a plugin without a permission config

The plugin API was investigated first and abandoned in favour of `--format json`. Recorded
because it cost most of a day and the failure is silent.

| plugin | `permission` config | tools | result |
|---|---|---|---|
| no | absent | write | works, 27s |
| yes | absent | none | works, 90 events |
| **yes** | **absent** | **write** | **wedges indefinitely** |
| yes | `allow` | write | works, 10s, 127 events |

Registering a plugin appears to move permission handling off the headless auto-allow path
onto one that waits for a decision non-interactive `run` cannot supply. The process stays
alive, emits nothing and never exits; one run sat for 67 minutes before being killed.

Four diagnoses were proposed and refuted before the matrix settled it — the plugin's
`permission.ask` hook, the plugin alone, write permission alone, and the free tier. Each was
refuted by a control. **The matrix is what produced the answer; reasoning produced four
wrong ones.**

## Permissions

`$defs.PermissionConfig` from `https://opencode.ai/config.json`:

```
read · edit · glob · grep · list · bash · task · external_directory
todowrite · question · webfetch · websearch · lsp · doom_loop · skill
action: "ask" | "allow" | "deny"
```

Finer-grained than either other CLI's all-or-nothing bypass. `--auto` is the blunt form and
is what `.conclave/config.json`'s `bypass` mode passes.

There is no permission DIALOG in `run` mode, so `permission_refused` is `unsupported` for
this adapter rather than unverified, and `decidePermission` throws.

## Authentication

One API key for the `opencode` provider, entered at a blocking TUI prompt — it cannot be
piped — and stored in `~/.local/share/opencode/auth.json`. Free models
(`opencode/deepseek-v4-flash-free` and six others) run on it. Any provider OpenCode supports
can be configured instead, which is how a model that is not OpenCode's own takes a seat.

## Corrections to earlier claims

Two claims made from type definitions rather than from a run, both wrong, both recorded
because the project keeps making this exact mistake:

- **`opencode run` stalls at `init`.** It does not. That was a malformed local plugin, a
  fake provider that had died, and a working directory whose config never loaded.
- **`session.next.step.ended` carries a `finish` reason.** That event does not exist in
  1.18.15. What was attributed to it is carried by `step_finish` parts.

## Untested

- Whether `session.compacted` fires where Claude Code compacts, and whether OpenCode
  compacts server-side across resumed sessions at all. If it does, `snapshot()` would need
  to reconcile and `compactionGeneration` would stop being 0.
- `--fork`, which the help text advertises and nothing here has demonstrated.
- Every outcome other than `completed`.
