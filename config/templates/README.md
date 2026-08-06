# Hook registration templates

Canonical, versioned source for Conclave's hook registrations. `{{CONCLAVE_ROOT}}` is
replaced by `conclave config install` with the path of the Conclave checkout the command
ran from — NOT the project being registered. The rendered outputs land in the target
project; the commands inside them point back at Conclave, because the hook that runs is
always Conclave's own.

The templates are pure JSON with no extra keys, because rendering is a plain string
substitution and the outputs must be byte-exact. Codex in particular rejects unrecognised
top-level keys in its sidecar (`expected 'description' or 'hooks'`), and its trust hash
covers the normalised handler — so any stray field or reformatting is a real change, not
cosmetic.

| template | renders to | consumed by |
|---|---|---|
| `claude-settings.json` | `.claude/settings.json` | `claude --settings` layer for the spike scripts |
| `codex-hooks.json` | `.codex/hooks.json` | Codex project-local sidecar |

Both outputs are git-ignored: each CLI requires an absolute command path, so an active
registration is necessarily machine-local. Committing one bakes a home directory into
portable source.

The live TypeScript adapter does not use these. `ClaudePtyHookAdapter` generates its own
settings into a per-session temporary directory and passes `--settings`, so it never
depends on a file in the checkout. These registrations exist for the Python spike scripts
and for the Codex trust diagnostics.
