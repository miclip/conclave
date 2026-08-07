# Kimi CLI — `--print --output-format stream-json`

Measured against **kimi 1.49.0** (`kimi-cli` on PyPI, Python >=3.12) on 2026-08-07, driving a
Moonshot provider. Fixtures: `fixtures/edit-turn.ndjson` and `fixtures/edit-turn.stderr.txt`,
from a real two-tool, file-writing turn.

## The output is the conversation, not the lifecycle

```
{role:"assistant", content:[{type:"think"|"text"}], tool_calls:[{id, function:{name, arguments}}]}
{role:"tool",      content:..., tool_call_id}
{role:"assistant", content:[...]}                      <- no tool_calls: the model stopped
```

OpenAI-chat shaped. `function.arguments` is a JSON *string*, per that convention.

**There is no announced turn end in this mode.** Completion is the shape of the final message
plus a zero exit, which is a materially weaker claim than OpenCode's `step_finish
reason=stop`. The capability grades `completed` as `observed` (a fixture exists and the parser
reads it) with confidence `inferred` (nothing declared it). Those two axes must not be
collapsed: the fixture proves producibility, not announcement.

## What this output mode gives up, and where it went

The DEFAULT (text) UI carries records `stream-json` omits entirely:

```
StatusUpdate(context_usage=0.0406, context_tokens=10654, max_context_tokens=262144,
             TokenUsage(input_other=158, output=49, input_cache_read=10496, ...))
TurnEnd()
```

`context_usage` is a continuous fraction of the limit, per turn. That is the measurement
`spikes/experiments/04-complaint-as-signal.md` has twice been unable to take: both attempts
waited on compaction as a proxy for context pressure and observed none. Kimi reports proximity
to the boundary directly.

And `max_context_size` is CONFIGURATION (`[models.<name>] max_context_size`), so the limit can
be lowered deliberately. That turns the degradation question from observational into
experimental — the thing two null results have been asking for.

Neither is available through `stream-json`. Getting both means the hook path below.

## Hooks: thirteen events, Claude Code's payload shape, unused so far

`kimi_cli/hooks/config.py`:

```
SessionStart · UserPromptSubmit · PreToolUse · PostToolUse · PostToolUseFailure
Stop · StopFailure · SubagentStart · SubagentStop · PreCompact · PostCompact
SessionEnd · Notification
```

Payloads are `{hook_event_name, session_id, cwd, ...}` — Claude Code's shape, so the existing
classifier and journal largely apply. Registration is `config.toml`:
`{event, command, matcher, timeout}`, command receives JSON on stdin, timeout 1–600s and
**fail-open** (unlike Codex, which clamps `SessionEnd` to 3s and kills the handler).

Four of these have no Claude Code equivalent, and each closes something open in this project:

- `PostToolUseFailure` — a failed tool distinguished at the source. **This adapter currently
  reports every tool as `failed: false`, because `stream-json` does not distinguish them.**
- `StopFailure` — a badly-ended turn, announced rather than inferred from absence.
- `SubagentStart` — Claude Code has only `SubagentStop`, which is why subagent work is
  invisible while it runs (issue #5).
- `tool_call_id` on tool events — a stable per-call identifier, which artifact attribution
  (issue #8) currently lacks.

Because the adapter already passes `--config-file`, hooks can be declared in a file Conclave
generates. **No mutation of the user's own configuration** — unlike Matilda, which appears to
offer no equivalent.

## Permissions cannot be mediated, and cannot be re-enabled either

`--print` "auto-dismisses AskUserQuestion and auto-approves tool calls for this invocation".
That is a property of print mode, not a flag this adapter chose. `--afk` is passed as well,
because an unattended turn that stops on a question never ends.

Consequence worth stating plainly: **`.conclave/config.json` `permissions: "ask"` cannot be
honoured for Kimi.** There is no bypass flag in `BYPASS_ARGS` for this agent because there is
nothing to bypass — it is already permissive and cannot be made otherwise in this mode.
`permission_refused` is `unsupported`, and `decidePermission` throws.

## The session id is on stderr

```
To resume this session: kimi -r e5c1ee8d-5bc8-41c4-9acb-de94ccd28c9e
```

Not in the structured stream. Parsing human-facing text for a machine-readable fact is
unpleasant and is done because it is the only channel carrying it. A `session_id` from any hook
would replace it.

## Provider configuration: the waitlist does not gate the CLI

`kimi login` gates Moonshot's hosted Kimi Code service, which is waitlisted. The CLI's model
config is independent:

```toml
[providers.<name>]   type = "kimi"|"openai_legacy"|"openai_responses"|"anthropic"|"gemini"|"vertexai"
                     base_url, api_key, env, custom_headers
[models.<name>]      provider, model, max_context_size, capabilities
```

Verified against `https://api.moonshot.ai/v1`. Any OpenAI-compatible endpoint works, so the
REPL remains the integration and Conclave never holds a key.

## Untested

- Every outcome but `completed`.
- Whether `PreCompact`/`PostCompact` fire, and whether transcripts are rewritten under a
  resumed session. `compactionGeneration` is 0 here as a statement about this adapter's
  evidence, not about the agent.
- ACP (`agent-client-protocol==0.8.0`, `kimi acp`) — a documented JSON-RPC surface, and
  plausibly better than either of the above. Not evaluated.
