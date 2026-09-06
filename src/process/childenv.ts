/**
 * Adapter invariant: a child agent CLI never inherits this process's environment.
 *
 * Ported from spikes/common/childenv.py. Spawning from inside an agent session leaks the
 * parent's session markers, and Claude Code responds to CLAUDE_CODE_CHILD_SESSION by silently
 * disabling transcript persistence -- writing no session file at all. Since the transcript IS
 * the adapter's recovery and audit path, an inherited environment is silent data loss that
 * surfaces much later looking like a parser bug.
 *
 * THAT IS MODE-DEPENDENT, and the mode it holds in is the one this adapter drives (#238).
 * Measured on 2.1.261, twice each:
 *
 *   interactive pty (`entrypoint: cli`)   set -> NO transcript written.  unset -> written.
 *   `claude --print` (`entrypoint: sdk-cli`)  set -> written.  unset -> written.
 *
 * Said explicitly because the easy way to check this claim is `--print`, where it is FALSE --
 * and a reader who checks it that way concludes the guard is obsolete and removes something
 * that is preventing silent data loss in the mode that matters. The turn ran in every case, so
 * what is suppressed is persistence, not the child.
 *
 * The variable is not vestigial: it appears 20 times in the installed 2.1.263 bundle, and
 * `childenvClaims.test.ts` checks that against the binary rather than restating it here. Plain
 * `grep` on the bundle finds nothing -- it is a Mach-O executable -- which is a trap worth
 * knowing for anyone re-checking this by hand.
 *
 * The environment is constructed, never inherited. There is deliberately no default
 * that reaches for process.env behind the caller's back.
 */

export const PARENT_AGENT_PREFIXES = [
  'CLAUDE',
  'CODEX',
  'ANTHROPIC_',
  'OPENAI_',
  'CURSOR_',
  'AIDER_',
  'COPILOT_',
] as const

export const PARENT_AGENT_EXACT = new Set(['AI_AGENT', 'AGENT_SESSION_ID', 'CI'])

/** Not agent markers, but they change how a TUI renders or whether it colours output. */
export const TERMINAL_NOISE = new Set([
  'NO_COLOR',
  'FORCE_COLOR',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'COLORTERM',
  'TERM_SESSION_ID',
  'ITERM_SESSION_ID',
])

/**
 * Observed leaking from a Claude Code parent on 2026-08-05 (claude 2.1.222). Recorded so
 * a toolchain bump that renames them shows up as a diff rather than a mystery.
 */
export const KNOWN_PARENT_AGENT_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
] as const

/**
 * The ones whose leakage is destructive rather than merely untidy.
 *
 * Read by `assertClean`, so the failure says which it was. Every parent-agent variable is
 * stripped and any leak is a bug, but these two facts are not the same size: an inherited
 * CLAUDE_CODE_ENTRYPOINT is untidy, and an inherited CLAUDE_CODE_CHILD_SESSION means the run
 * that just started is writing no transcript at all -- which is the adapter's recovery and
 * audit path, and which fails much later looking like a parser bug.
 *
 * It was a bare exported constant that nothing read (#238): dead code asserting a fact, which
 * is the shape that rots without anything failing. It is wired now, and the fact is checked
 * against the installed binary in `childenvClaims.test.ts`.
 */
export const TRANSCRIPT_KILLING_VARS = ['CLAUDE_CODE_CHILD_SESSION'] as const

const ALLOWLIST_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
])

const ALLOWLIST_PREFIXES = ['ORCH_'] as const

export type Env = Record<string, string>

export function isParentAgentVar(name: string): boolean {
  return PARENT_AGENT_PREFIXES.some((p) => name.startsWith(p)) || PARENT_AGENT_EXACT.has(name)
}

export interface Discovery {
  present: string[]
  known: string[]
  /** Matches the parent-agent pattern but is not in KNOWN_PARENT_AGENT_VARS. */
  novel: string[]
}

export function discoverParentAgentVars(env: Env = process.env as Env): Discovery {
  const present = Object.keys(env).filter(isParentAgentVar).sort()
  const known = new Set<string>(KNOWN_PARENT_AGENT_VARS)
  return {
    present,
    known: present.filter((n) => known.has(n)),
    novel: present.filter((n) => !known.has(n)),
  }
}

export interface BuildOptions {
  extra?: Env
  rows?: number
  cols?: number
}

function terminalDefaults(rows: number, cols: number): Env {
  return { TERM: 'xterm-256color', COLUMNS: String(cols), LINES: String(rows) }
}

/**
 * Fail loudly rather than let a leak through.
 *
 * If this throws, the child would have run with a parent's markers. For most of them that is
 * an attribution problem; for `TRANSCRIPT_KILLING_VARS` it is silent data loss in the pty mode
 * this adapter drives -- see the header -- so the message says which kind was caught rather
 * than leaving that to be looked up.
 */
function assertClean(env: Env): Env {
  const leaked = Object.keys(env).filter(isParentAgentVar).sort()
  if (leaked.length > 0) {
    const destructive = leaked.filter((n) => (TRANSCRIPT_KILLING_VARS as readonly string[]).includes(n))
    const why = destructive.length
      ? ` — ${destructive.join(', ')} would have left the child writing no transcript at all in pty mode`
      : ''
    throw new Error(`parent-agent variables leaked into child env: ${leaked.join(', ')}${why}`)
  }
  return env
}

/** Denylist. Permissive: keeps proxies, cert bundles and toolchain shims working. */
export function sanitizedCopy(source: Env = process.env as Env, opts: BuildOptions = {}): Env {
  const { extra, rows = 40, cols = 120 } = opts
  const out: Env = {}
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue
    if (isParentAgentVar(k) || TERMINAL_NOISE.has(k)) continue
    out[k] = v
  }
  Object.assign(out, terminalDefaults(rows, cols), extra ?? {})
  return assertClean(out)
}

/** Allowlist. Strict: use when the child must be reproducible rather than merely working. */
export function allowlistEnv(source: Env = process.env as Env, opts: BuildOptions = {}): Env {
  const { extra, rows = 40, cols = 120 } = opts
  const out: Env = {}
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined || isParentAgentVar(k)) continue
    if (ALLOWLIST_EXACT.has(k) || ALLOWLIST_PREFIXES.some((p) => k.startsWith(p))) out[k] = v
  }
  Object.assign(out, terminalDefaults(rows, cols), extra ?? {})
  return assertClean(out)
}
