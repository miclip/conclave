# Kimi Code 2.3.2 — the npm successor, measured beside 1.49.0

Measured against **`@moonshot-ai/kimi-code@2.3.2`** (npm, `engines.node >=22.19.0`, run on
node v24.13.1) on 2026-10-25. Installed with `npm install --ignore-scripts` into a scratch
directory; the `kimi` binary (`bin.kimi` → `dist/main.mjs`) was invoked by full path only.
Every invocation ran under `env -i` with `HOME=$H` (a scratch directory), `TERM=dumb`,
`KIMI_CODE_NO_AUTO_UPDATE=1` and stdin from `/dev/null`. Two homes:

- `$H` = fresh: empty, a first-run machine.
- `$H` = migrated: a `cp -Rp` copy of the operator's `~/.kimi`, so the legacy-data path is
  exercised against a copy and never the original.

The installed 1.49.0 (`kimi-cli`, uv) was not touched: before and after, `command -v kimi`
is `~/.local/bin/kimi` → `~/.local/share/uv/tools/kimi-cli/bin/kimi`, `kimi --version` is
`kimi, version 1.49.0`, and a sha256 manifest of all 70 files under `~/.kimi` is identical.
`~/.kimi-code` did not exist before and does not exist after.

## The install takes over `kimi` when it is global

`scripts/postinstall.mjs`, verbatim from its header:

```
when this package is installed globally, ensure typing `kimi`
invokes the new TypeScript CLI. [...] this script
removes any pre-existing `kimi` shim left behind by the previous
Python CLI (installed via `uv tool install`, `pipx install`,
`pip install`, etc.) that would otherwise shadow ours via PATH
ordering. The renamed shim is kept as `kimi-legacy`
```

Gated on `npm_config_global` / `pnpm_config_global` / `npm_config_location`; a local install
is a no-op. It was skipped here anyway (`--ignore-scripts`). Consequence: on a machine where
the operator runs `npm i -g @moonshot-ai/kimi-code`, the binary named `kimi` changes from
1.x to 2.x underneath anything that resolved it by name.

## `--version`: the bytes changed shape

```
$ kimi --version | od -c
0000000    2   .   3   .   2  \n
0000006
```

Six bytes, exit 0, nothing on stderr. 1.49.0 prints `kimi, version 1.49.0\n` (21 bytes). There
is no `kimi, version ` prefix in 2.x. `-V` is the documented alias (`-V, --version  output the
version number`, commander's default).

Prompt mode separately writes `kimi version 2.3.2` (no comma) to **stderr** before its error,
see below.

## `--print -- <prompt>`: the flag does not exist

```
$ kimi --print -- "Reply with the single word OK." </dev/null
error: unknown option '--print'
(Did you mean --prompt?)
```

exit 1, stdout empty. The non-interactive surface is now `-p, --prompt <prompt>` (the prompt
is the option's VALUE, not a positional after `--`), with `--output-format <format>`
choices `"text"`, `"stream-json"`.

`-p` itself, from both homes:

```
$ kimi -p "Reply with the single word OK." </dev/null
kimi version 2.3.2
error: failed to run prompt: No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml.
See log: $H/.kimi-code/logs/kimi-code.log
```

exit 1, all three lines on stderr, stdout empty. **No model turn was run.** The operator's
legacy config has `default_model = ""` and empty `[models]`/`[providers]`; the only credential
is a `kimi-code` OAuth login, which the migrator reports as `oauth logins requiring re-login
after migration: kimi-code`. Re-login is the interactive device-code flow (`kimi login`) and
was not attempted. No `KIMI_*`/`MOONSHOT_*` key is in the environment. So the shape of a
completed `-p` turn — text or `stream-json` — is **unmeasured**.

## `models`: the command does not exist

```
$ kimi models </dev/null
unknown command 'models'. See 'kimi --help'.
```

exit 1, stderr only. The nearest surface is `kimi provider`:

```
Commands:
  add [options] <url>  Import every provider listed in a custom registry (api.json).
  remove <providerId>  Remove a provider and every model alias that referenced it.
  list [options]       Show configured providers and their model counts.
  catalog              Discover and import providers from the public models.dev catalog.
  help [command]       display help for command
```

`kimi provider list` in the migrated home: `No providers configured.`, exit 0.

## Config: new directory, same TOML, reshaped schema

Location: `KIMI_CODE_HOME`, else `~/.kimi-code` (bundle: `resolveKimiHome` returns
`homeDir ?? env["KIMI_CODE_HOME"] ?? join(osHomeDir, ".kimi-code")`). Not `~/.kimi`. Files
named by the bundle and by `kimi doctor`: `config.toml`, `tui.toml`, `mcp.json`, plus a
project-level `<project>/.kimi-code/{local.toml,mcp.json,AGENTS.md}`.

`kimi doctor`, fresh home, exit 0:

```
Kimi doctor

SKIP config.toml  $H/.kimi-code/config.toml
  File does not exist; built-in defaults will apply.
SKIP tui.toml     $H/.kimi-code/tui.toml
  File does not exist; built-in defaults will apply.

All checked config files are valid.
```

Probed one invocation per fresh home: `--version`, `--help`, `models`, `--print -- hi` and
`doctor` each leave the home empty. `-p` creates `$H/.kimi-code/` with `device_id`,
`workspaces.json`, `telemetry/` and `logs/kimi-code.log`, even though it fails.

`~/.kimi` is NOT read implicitly by `-p`: the migrated home still said `No model configured`
until `kimi migrate --run --config-only` was run. Its log, verbatim (paths shortened to `$H`):

```
[kimi-migrate 14:16:33] source: $H/.kimi (default ~/.kimi)
[kimi-migrate 14:16:33] target: $H/.kimi-code
[kimi-migrate 14:16:33] scope: config-only (config, mcp, user-history, skills)
[kimi-migrate 14:16:33] detected: 11 sessions across 6 workdirs · config=true · mcp=false · user-history=true · skills=false
[kimi-migrate 14:16:33] oauth logins requiring re-login after migration: kimi-code
[kimi-migrate 14:16:33] config: migrated=true tui-extracted=true hooks-migrated=0 hooks-dropped=0 dropped-keys=[default_thinking, skip_afk_prompt_injection, show_thinking_stream, telemetry, notifications]
[kimi-migrate 14:16:33] result: complete — completion marker written; future launches will not re-prompt
```

The migrated `config.toml`, whole:

```toml
default_plan_mode = false
merge_all_available_skills = true
extra_skill_dirs = []

[loop_control]
reserved_context_size = 50000

[background]
max_running_tasks = 4
keep_alive_on_exit = false

[services]
[mcp.client]
tool_call_timeout_ms = 60000
```

Still TOML, still `[providers.<name>]` / `[models.<name>]`, but the keys moved. The bundle's
schemas (snake_case in TOML, converted on read):

```
[providers.<name>]  model_source = "static"|"discover"|"oauth-catalog", base_url, custom_headers,
                    default_model, type, api_key, api_key_env, oauth{storage,key,oauth_host},
                    env, source
[models.<alias>]    provider, model, max_context_size (required, int >= 1), max_input_size,
                    max_output_size, capabilities, display_name, reasoning_key,
                    protocol = "anthropic"|"openai_responses", adaptive_thinking, ...
```

An environment-only provider binds `KIMI_MODEL_API_KEY`, `KIMI_MODEL_PROVIDER_TYPE`,
`KIMI_MODEL_BASE_URL`. `max_context_size` survives as configuration, so the deliberate-limit
experiment in FINDINGS.md remains possible in principle. Whether `--config-file` survives is
moot: **there is no `--config-file` or `--config` option in 2.3.2's help at all.**

## Top-level `--help`, verbatim

```
Usage: kimi [options] [command]

The Starting Point for Next-Gen Agents

Options:
  -V, --version                 output the version number
  -S, --session [id]            Resume a session. With ID: resume that session. Without ID:
                                interactively pick.
  -c, --continue                Continue the previous session for the working directory. (default:
                                false)
  -y, --yolo                    Start in Ask When Needed mode: routine edits and commands run
                                automatically; risky actions, questions, and plans still ask.
                                (default: false)
  --auto                        Start in Never Ask mode: never interrupts you; everything runs and
                                is decided automatically. (default: false)
  -m, --model <model>           LLM model alias to use for this invocation. Defaults to
                                default_model in config.toml.
  -p, --prompt <prompt>         Run one prompt non-interactively and print the response.
  --output-format <format>      Output format for prompt mode. Defaults to text. (choices: "text",
                                "stream-json")
  --skills-dir <dir>            Load skills from this directory instead of auto-discovered user and
                                project directories. Can be repeated. (default: [])
  --agent <name>                Agent profile to start the new session with. Custom profiles are
                                discovered from agent directories or loaded via --agent-file. Cannot
                                be combined with --session/--continue.
  --agent-file <path>           Load an agent definition from a Markdown file and select it for the
                                new session. Cannot be combined with --session/--continue. (default:
                                [])
  --add-dir <dir>               Add an additional workspace directory for this session. Can be
                                repeated. (default: [])
  --plan                        Start in plan mode. (default: false)
  -h, --help                    Show help.

Commands:
  export [options] [sessionId]  Export a session as a ZIP archive.
  fork [options] [sessionId]    Fork a session into a new session.
  provider                      Manage LLM providers non-interactively.
  session                       Manage sessions non-interactively.
  acp [options]                 Run kimi-code as an Agent Client Protocol (ACP) server over stdio.
  web [options]                 Run the local Kimi server and open the web UI.
  server                        Deprecated — use `kimi web` instead.
  rc|remote [options]           Run the local Kimi server and open the web UI through Remote
                                Control.
  login [options]               Authenticate with Kimi Code CLI via the device-code flow.
  doctor                        Validate Kimi Code configuration files.
  vis [options] [sessionId]     Launch the session visualizer in your browser.
  install-desktop               Print the Kimi Code desktop app page and open it in your browser.
  app [path]                    Open a new chat in the Kimi Code desktop app for this directory.
  migrate [options]             Migrate data from a legacy kimi-cli installation into kimi-code.
  upgrade|update [options]      Upgrade Kimi Code to the latest version.

Documentation:        https://moonshotai.github.io/kimi-code/
```

exit 0, stderr empty. Of the flags `src/adapters/kimi.ts` passes to 1.49.0, `--print`,
`--afk` and `--config-file` are absent; `--output-format` survives with the same two
choices. The `models` command is absent too.

## Untested

- Any completed `-p` turn, in either output format: blocked on an interactive OAuth re-login.
  So whether `stream-json` keeps 1.x's OpenAI-chat message shape is unknown.
- Whether `-p` reads stdin when stdin is not `/dev/null`.
- Hooks under 2.x: the migrator reports `hooks-migrated=0 hooks-dropped=0`, so a hooks section
  exists in the new config, but its keys and which events fire were not examined.
- Whether `--auto` is the equivalent of 1.x `--print`'s auto-approval, and whether prompt mode
  can be made to ask.
- `acp`, `session`, `export`, `fork` subcommands.
