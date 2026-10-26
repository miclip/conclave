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
 * about to rewrite as JSON is a poor trade. So reading a TOML config needs a SEPARATE
 * `python3` on PATH whose standard library has `tomllib` (Python 3.11+).
 *
 * Running Kimi does not supply that. `uv tool install kimi-cli` gives the tool its own
 * interpreter: the `kimi` shim's shebang names `~/.local/share/uv/tools/kimi-cli/bin/python`,
 * a link into uv's managed `~/.local/share/uv/python/`, and none of it is put on PATH. A
 * machine can run Kimi with no `python3` at all, or with one older than 3.11.
 *
 * Kimi accepts a `.json` config directly (`config_file.suffix.lower() == ".json"`), and a
 * JSON config avoids the dependency entirely: only the TOML READ needs Python; the write is
 * `JSON.stringify`.
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
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where `kimi` looks when nothing is passed. */
export function defaultKimiConfigPath(): string {
  return join(homedir(), '.kimi', 'config.toml')
}

/**
 * A Kimi config that exists and cannot be read. One shape for both formats, so an operator
 * cannot tell which branch failed by how well the message is written (#389): the file, the
 * reader's reason as one line, what the file is for, and what to do. The file and its reason
 * come first and the remedy last, as in `UnreadableMarkerError` in
 * src/workspace/mutationMarker.ts. Kept to one line rather than
 * that error's two, because the one caller, `kimi.ts`, embeds it in a single-line event.
 */
export class UnreadableKimiConfigError extends Error {
  readonly path: string

  constructor(path: string, format: 'TOML' | 'JSON', reason: string, remedy: string, cause: unknown) {
    super(
      `kimi: could not read ${path} as ${format} (${reason}) — it is the config the kimi seat runs ` +
        `with, which Conclave copies to add its hooks. ${remedy}`,
      { cause },
    )
    this.name = 'UnreadableKimiConfigError'
    this.path = path
  }
}

/**
 * The TOML read, as the script `python3 -c` runs. It reports its own failure as ONE line on
 * stderr rather than leaving python to print a traceback, because the traceback's shape is not
 * ours to rely on: "the last line is the exception" stops being true when an exception carries
 * notes (PEP 678), which python prints AFTER it. `json.dump` adds one on every value it cannot
 * serialize, so a TOML datetime ended its stderr with `when serializing dict item 'd'` and the
 * reason was the line above. The notes are kept, after the reason, because they name the key.
 *
 * `allow_nan=False` because TOML has `inf` and `nan` and JSON does not: left to its default,
 * `json.dump` writes `Infinity`, python exits 0, and the failure surfaces in node's `JSON.parse`
 * with nothing to say which key it was. The generated config is JSON, so such a value could
 * not be carried into it anyway; the question is only where the failure is reported.
 *
 * `import tomllib` is inside the `try` so that a python older than 3.11 lands here too.
 */
const READ_TOML = [
  'import sys, json',
  'try:',
  '    import tomllib',
  '    json.dump(tomllib.load(open(sys.argv[1], "rb")), sys.stdout, allow_nan=False)',
  'except Exception as e:',
  '    parts = [type(e).__name__ + ": " + str(e)] + ["(" + n + ")" for n in getattr(e, "__notes__", [])]',
  '    sys.stderr.write(" ".join(" ".join(parts).split()) + "\\n")',
  '    sys.exit(1)',
].join('\n')

/**
 * Why `python3` failed, in one line.
 *
 * Normally `READ_TOML`'s own one-line report. The last non-empty line is taken rather than the
 * whole stream for what fails before that script's `try` can run -- a python so old the script
 * does not compile prints its own traceback, and there the last line is still the best there
 * is. Where python printed nothing -- it could not be started, or was killed -- the fallback
 * says which, rather than leaving the parentheses empty.
 *
 * Not `err.message`: `execFileSync` builds that as "Command failed: python3 -c ..." followed by
 * the whole of stderr, and interpolating it was the traceback's second copy.
 */
function pythonReason(err: unknown): string {
  const e = err as { stderr?: unknown; status?: number | null; signal?: string | null; code?: unknown }
  const stderr = typeof e.stderr === 'string' ? e.stderr : ''
  const last = stderr.split('\n').map((l) => l.trim()).filter(Boolean).at(-1)
  if (last) return last
  if (typeof e.code === 'string') return `python3 could not be run: ${e.code}`
  if (e.signal) return `python3 was killed by ${e.signal} and printed nothing`
  return `python3 exited with status ${e.status ?? 'unknown'} and printed nothing`
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
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch (err) {
      throw new UnreadableKimiConfigError(
        path,
        'JSON',
        err instanceof Error ? err.message : String(err),
        'Fix the JSON in it, or point the seat at a config that parses.',
        err,
      )
    }
  }
  const unreadable = (reason: string, err: unknown) =>
    new UnreadableKimiConfigError(
      path,
      'TOML',
      reason,
      'If the reason is in the file, fix the TOML in it. ' +
        'Conclave reads TOML with a separate python3 on PATH that has tomllib (Python 3.11+); ' +
        'the Python kimi-cli runs on is not used. Install one, or pass a .json config, which ' +
        'needs no Python.',
      err,
    )
  let json: string
  try {
    json = execFileSync(
      'python3',
      ['-c', READ_TOML, path],
      // stdio set EXPLICITLY. Left to the default, execFileSync captures the child's stderr on
      // the error AND copies it to conclave's own stderr, where python's traceback drew over the
      // console (#389). Set, the stream is only captured, and arrives on the error alone.
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (err) {
    throw unreadable(pythonReason(err), err)
  }
  // `READ_TOML` exits non-zero rather than write what JSON cannot hold, so this failing means
  // the python3 on PATH printed something other than that script's output. Wrapped all the
  // same: every way the TOML read fails reaches the operator in the one shape.
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch (err) {
    throw unreadable(`python3 printed something that is not JSON: ${err instanceof Error ? err.message : String(err)}`, err)
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
