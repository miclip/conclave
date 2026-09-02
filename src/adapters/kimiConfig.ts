/**
 * Generating a Kimi config that carries Conclave's hooks without touching the user's.
 *
 * `kimi` loads exactly ONE config file. `--config-file` REPLACES `~/.kimi/config.toml`
 * rather than layering over it, and `--config` (inline) cannot be combined with
 * `--config-file` at all -- the CLI refuses with "Cannot combine --config, --config-file".
 *
 * So there is no way to add a hook without also supplying every provider and model the run
 * needs. The adapter therefore reads whatever config the operator already uses, injects its
 * own hooks, and writes the result to a private temp file. The user's file is never modified,
 * which is the same guarantee `--settings` buys on Claude Code and which Matilda appears not
 * to offer at all (#25).
 *
 * ## Why this shells out to Python
 *
 * Kimi's config is TOML, Node has no TOML parser, and vendoring one to read a file we are
 * about to rewrite as JSON is a poor trade. Python's `tomllib` is standard library from 3.11,
 * and `kimi-cli` itself requires Python >= 3.12 -- so a machine that can run Kimi can always
 * parse Kimi's config. The dependency is real and it is bounded by something already true.
 *
 * Kimi accepts a `.json` config directly (`config_file.suffix.lower() == ".json"`), so only
 * the READ needs Python; the write is `JSON.stringify`.
 *
 * ## The credential wrinkle
 *
 * That config holds an API key, so the generated copy does too. It is written 0600 inside a
 * `mkdtemp` directory and deleted when the session closes. Worth stating rather than leaving
 * for someone to discover: Conclave does not ask for the key and does not transmit it, but it
 * does briefly hold a second copy of it on disk.
 */

import { hookTimeoutSeconds } from './hookTimeout.ts'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where `kimi` looks when nothing is passed. */
export function defaultKimiConfigPath(): string {
  return join(homedir(), '.kimi', 'config.toml')
}

/**
 * Read a Kimi config as a plain object.
 *
 * A missing file is `{}` rather than an error: Kimi creates a default when none exists, and
 * a run that fails only because the operator has not written a config yet would be reporting
 * the wrong problem.
 */
export function readKimiConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  if (path.toLowerCase().endsWith('.json')) {
    return JSON.parse(execFileSync('cat', [path], { encoding: 'utf8' })) as Record<string, unknown>
  }
  try {
    const json = execFileSync(
      'python3',
      ['-c', 'import sys,tomllib,json; json.dump(tomllib.load(open(sys.argv[1],"rb")), sys.stdout)', path],
      { encoding: 'utf8' },
    )
    return JSON.parse(json) as Record<string, unknown>
  } catch (err) {
    throw new Error(
      `kimi: could not read ${path} as TOML (${err instanceof Error ? err.message : String(err)}). ` +
        'Conclave reads it with python3 tomllib, which ships with the Python that kimi-cli ' +
        'itself requires. Pass a .json config instead if python3 is unavailable.',
    )
  }
}

/**
 * The hook events Conclave registers, and what each is for.
 *
 * Not all thirteen. Registering an event nothing consumes costs a subprocess on every
 * occurrence and buys a journal entry nobody reads, and the two adapters that already exist
 * were both slowed by exactly that before their event lists were trimmed.
 */
export const KIMI_HOOK_EVENTS = [
  /** The announced turn end. This is the whole reason for hook mode. */
  'Stop',
  /**
   * A turn that ended badly, announced. Had no Claude Code equivalent when this list was
   * written; 2.1.251 dispatches `StopFailure` too. Kimi is no longer the only seat that could
   * report one -- it is still the only seat that does.
   */
  'StopFailure',
  /** Correlates a turn with the prompt that started it. */
  'UserPromptSubmit',
  /** Tool failure, which `--output-format stream-json` cannot distinguish at all. */
  'PostToolUseFailure',
  /**
   * Compaction, announced on both sides. "Codex does not" stood here from this file's first
   * commit and is false: Codex 0.147.0 carries a `hook_event_name` schema for each, and
   * DESIGN-BRIEF.md has listed both among Codex's documented events since the survey. Claude
   * Code 2.1.258 dispatches them too. The claim outlived #36 -- the commit that turned this
   * file's other two dated comments into checks -- because the Codex half of
   * `hookEventNames.test.ts` reads the sidecar's own registered keys, and the sidecar
   * registers no compaction event, so the names were outside everything it examined.
   *
   * What survives is not "only Kimi hears compaction" either, and the reason is worth having
   * here: on the other two seats compaction is counted from the TRANSCRIPT, by
   * `transcript/reconcile.ts`, which is where `compactionGeneration` comes from -- the Codex
   * sidecar registers neither event and loses nothing by it. Kimi's adapter reads no
   * transcript; it rebuilds from the stream and its `snapshot()` returns
   * `compactionGeneration: 0` and says so. These two hooks are the only evidence of compaction
   * this adapter can get at all, which is why they are registered here and nowhere else.
   */
  'PreCompact',
  'PostCompact',
  /**
   * Both halves of subagent work. Kimi was once the only participant that COULD say a subagent
   * started -- Claude Code had only `SubagentStop` at 2.1.224, which is why delegation reads
   * there as an ending without a beginning (issue #5). Claude Code 2.1.251 dispatches
   * `SubagentStart`, so #5 is now a question of what conclave registers rather than of what the
   * CLI can tell it. Kimi remains the only participant that DOES report both halves.
   */
  'SubagentStart',
  'SubagentStop',
  /** Session lifecycle, for readiness and teardown. */
  'SessionStart',
  'SessionEnd',
] as const

export interface HookDef {
  event: string
  command: string
  timeout: number
}

/**
 * The user's config with Conclave's hooks added.
 *
 * Existing hooks are PRESERVED and Conclave's are appended. An operator who registered their
 * own `Stop` hook has a reason for it, and a config generator that silently dropped it would
 * break something the operator cannot see from here.
 *
 * `timeout` is 10s, well inside Kimi's 1-600 range. The handler posts to loopback and
 * returns; anything longer means the receiver is gone, and Kimi fails hooks OPEN, so a slow
 * handler delays a turn rather than breaking it.
 */
export function withConclaveHooks(
  config: Record<string, unknown>,
  command: string,
  events: readonly string[] = KIMI_HOOK_EVENTS,
): Record<string, unknown> {
  const existing = Array.isArray(config.hooks) ? (config.hooks as HookDef[]) : []
  const ours: HookDef[] = events.map((event) => ({ event, command, timeout: hookTimeoutSeconds() }))
  return { ...config, hooks: [...existing, ...ours] }
}

/** Write the generated config where only this user can read it, and return the path. */
export function writeKimiConfig(dir: string, config: Record<string, unknown>): string {
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify(config, null, 2))
  // It carries whatever credential the operator's own config carries.
  chmodSync(path, 0o600)
  return path
}
