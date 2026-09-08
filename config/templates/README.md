# Hook registration templates

Canonical, versioned source for Conclave's **project** hook registrations, rendered into a
target project by `conclave config install`.

Two things are easy to conflate and the whole design turns on keeping them apart:

- **Where the templates come from** — the Conclave release that ran `config install`. That
  is a version directory (`conclave-releases/v0.5.32`) and it changes on every release.
- **Which hook executable runs** — whatever `conclave` resolves to on PATH at the moment
  the hook fires. That is not decided here, and it is not decided at install time either.

The commands in these templates name no directory at all: they are `conclave hook claude`
and `conclave hook codex`. So the rendered output is byte-identical for every project, every
checkout and every release, and upgrading Conclave does not silently leave a project firing
an old release's hook code — the failure #258 was filed for. `{{CONCLAVE_ROOT}}` is no
longer substituted into either template; `render` still supports the token, for a template
that ever needs one again.

**`conclave` must be on PATH, and it must be new enough to understand `hook`.** This is the
one way a registration can now fail, and it is deliberately a loud one: an older `conclave`
answers `unknown command: hook` on stderr and exits non-zero, which both CLIs surface as a
failed hook rather than as silence. `config install` checks for both and says so. Measured
against codex-cli 0.153.4: Codex resolves a bare command name through PATH and passes the
invoking shell's PATH to the hook, and with a current `conclave` on it every handler in
this sidecar reports `Completed`.

**A run's own seat hooks are NOT these.** An adapter writes those per run, as
`node <release>/src/hooks/client.ts <agent>`, and they stay pinned to the release the run
started on — a run must keep the hook code it began with (#250). Both paths execute
`runHookClient` in `src/hooks/client.ts`, which is what stops them drifting apart the way
this Claude template and the live client did before #258.

`SessionEnd` asks for **3 seconds** where every other hook asks for 10. Codex clamps that
handler to 3 and says so — on install and on every `config check` — so asking for 10 bought
a warning on every invocation and no extra budget. Noise in a diagnostic channel is not
free: it trains the reader to skim the exact place a real warning appears.

Worth knowing rather than only tidy: a SessionEnd handler that needs more than 3s is killed
regardless of how teardown is initiated, which is a *budget* cause that would look identical
from outside to the *shutdown-sequencing* cause recorded in issue #12. The `/quit` fixture
that issue asks for should measure the handler's duration against 3s, or it cannot tell the
two apart. If a later Codex raises the ceiling, this is the place to change.

The templates are pure JSON with no extra keys, because rendering is a plain string
substitution and the outputs must be byte-exact. Codex rejects unrecognised top-level keys
in its sidecar (`expected 'description' or 'hooks'`). Its trust hash covers the **normalised
handler**, not the file: a whitespace-only reformat leaves trust intact (measured on codex
0.146.0, `src/deployment/codexHookTrust.test.ts`), while any change to a handler's own
fields — `command`, `type`, `async`, `timeout`, and `statusMessage` — invalidates that
handler. So trust now moves when the handler bytes move, and no longer once per Conclave
checkout: two checkouts render the same handler and share one decision.

| template | renders to | consumed by |
|---|---|---|
| `claude-settings.json` | `.claude/settings.json` | Claude Code's project settings layer |
| `codex-hooks.json` | `.codex/hooks.json` | Codex project-local sidecar |

Both outputs are git-ignored, and the reason has changed. They no longer carry an absolute
path, so they are portable and a project *could* commit them — the objection now is only
that they are generated: `config install` writes them into a repository that did not ask
for them, and untracked files are a real hazard in a repo with a `git add -A` habit.
`config install` reports the ones a project does not ignore; it never edits `.gitignore`
itself.

Both are load-bearing at run time, which was not true when this file was first written:

- The **Codex sidecar** is the only hook registration Codex has. `CodexAdapter` writes none
  of its own, and the registry preflight refuses to construct it until these handlers are
  loaded, enabled and trusted.
- The **Claude settings** are what an ordinary `claude` in the project runs. A conclave run
  does not depend on them — `ClaudePtyHookAdapter` generates its own settings into a
  per-session temporary directory and passes `--settings` — but they fire on every
  invocation by someone who never started a run, which is exactly why the hook client exits
  zero rather than one when there is no receiver (#137). Whether Claude Code MERGES the two
  layers or lets one win is not established here and nothing depends on it.
