import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
/**
 * Codex hook trust — a configuration/deployment invariant, not lifecycle evidence.
 *
 * Codex gates hooks behind a content-hash trust decision. A registered hook whose
 * `trustStatus` is not `trusted` is loaded, listed, and never executed -- silently, from
 * a driver's point of view. Spike 2 lost a full scenario run to this: hooks were
 * correctly registered, `hooks/list` showed them enabled, and no hook ever fired.
 *
 * Editing hooks.json re-hashes it and re-prompts, so this is not a one-time setup step.
 * Any change to the adapter's own hook wiring invalidates trust on every project that
 * uses it.
 *
 * Nothing here produces or influences turn outcomes. It answers a readiness question --
 * "will this session's hooks actually run" -- and its result must never be folded into
 * an evidence grade. A trusted hook is not evidence that a turn completed.
 */

import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { sanitizedCopy } from '../process/childenv.ts'
import { PtyProcess, squash } from '../process/pty.ts'

/**
 * Substring identifying hooks this project installed, used to tell ours apart from any
 * the user has configured. Kept here so the registry preflight, the installer and the
 * tests cannot drift apart -- they did once, when the sidecar moved off the spike's
 * Python client and the diagnostic silently reported "no matching hooks are loaded".
 */
export const CONCLAVE_HOOK_MATCH = 'src/hooks/client.ts'

export type HookTrustStatus = 'managed' | 'untrusted' | 'trusted' | 'modified'

/**
 * Four separate booleans, deliberately not collapsed.
 *
 * `enabled` says nothing about whether a hook is permitted to execute. Codex reports an
 * untrusted hook as loaded AND enabled, and never runs it. A doctor command or panel
 * that renders `enabled` as "working" would reproduce the original silent failure in a
 * nicer UI, which is why `executable` is a distinct field computed here rather than a
 * judgement left to each caller.
 *
 *   loaded      Codex parsed and registered the handler
 *   enabled     not switched off by configuration
 *   trusted     the trust decision covers this handler's current content
 *   executable  loaded && enabled && trusted -- the ONLY one that means "will run"
 *
 * Trust is per *normalised handler definition* (command, type, async, timeout), not per
 * sidecar file. So formatting changes are harmless, unrelated handlers do not disturb an
 * existing decision, and a semantic change invalidates only the handler it touched.
 */
export interface CodexHookStatus {
  /** Codex's own key for this hook, and what a `hooks.state` entry is keyed by. */
  key?: string | undefined
  eventName: string
  handlerType: string
  source: string
  trustStatus: HookTrustStatus
  loaded: boolean
  enabled: boolean
  trusted: boolean
  executable: boolean
  timeoutSec?: number
  sourcePath?: string
  command?: string
  currentHash?: string
}

/** `managed` is trust conferred by policy rather than by a user decision. */
function isTrusted(status: HookTrustStatus): boolean {
  return status === 'trusted' || status === 'managed'
}

export interface CodexHookReport {
  cwd: string
  hooks: CodexHookStatus[]
  errors: { path: string; message: string }[]
  warnings: string[]
}

/**
 * Read hook configuration as Codex itself sees it, via the app-server `hooks/list` RPC.
 *
 * Reading our own hooks.json would only tell us what we wrote. This reports what was
 * actually loaded -- including silently ignored fields and the trust decision -- and it
 * costs no model tokens, so it can run while an account is rate-limited.
 */
export async function readCodexHooks(cwd: string, timeoutMs = 30_000): Promise<CodexHookReport> {
  const env = sanitizedCopy(process.env as Record<string, string>)
  const proc = spawn('codex', ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
  const rl = createInterface({ input: proc.stdout })

  const pending = new Map<number, (msg: any) => void>()
  rl.on('line', (line) => {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    const resolve = pending.get(msg.id)
    if (resolve) {
      pending.delete(msg.id)
      resolve(msg)
    }
  })

  const rpc = (id: number, method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`codex app-server: ${method} timed out`))
      }, timeoutMs)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })

  try {
    await rpc(1, 'initialize', {
      clientInfo: { name: 'conclave', version: '0', title: 'Conclave' },
    })
    const res = await rpc(2, 'hooks/list', { cwds: [cwd] })
    if (res.error) throw new Error(`hooks/list failed: ${JSON.stringify(res.error)}`)

    const entry = res.result.data[0] ?? { cwd, hooks: [], errors: [], warnings: [] }
    return {
      cwd: entry.cwd,
      hooks: (entry.hooks ?? []).map((h: any): CodexHookStatus => {
        const trusted = isTrusted(h.trustStatus)
        return {
          eventName: h.eventName,
          handlerType: h.handlerType,
          source: h.source,
          trustStatus: h.trustStatus,
          // It appeared in hooks/list, so Codex parsed and registered it.
          loaded: true,
          enabled: Boolean(h.enabled),
          trusted,
          executable: Boolean(h.enabled) && trusted,
          timeoutSec: h.timeoutSec,
          sourcePath: h.sourcePath,
          command: h.command ?? undefined,
          currentHash: h.currentHash,
          key: h.key,
        }
      }),
      errors: entry.errors ?? [],
      warnings: entry.warnings ?? [],
    }
  } finally {
    proc.kill('SIGTERM')
  }
}

/**
 * Where Codex looks for a project's `.codex/hooks.json`, which is not always the project
 * directory itself.
 *
 * Codex resolves project configuration from the repository's main worktree. Render the
 * sidecar into a LINKED worktree and Codex never reads it: `hooks/list` reports whatever
 * the main worktree has -- possibly nothing, possibly another checkout's stale command
 * path -- and the registration that was just written has no effect at all. That failure
 * is invisible from the linked worktree, because the file is right there and looks
 * installed.
 *
 * The command string still points at `conclaveRoot` (see `render`); only the file's
 * location follows the main worktree. So a linked worktree runs Conclave's hook code from
 * a sidecar its sibling owns, which is the honest description of what Codex supports.
 */
export function resolveCodexProjectRoot(checkoutRoot: string): string {
  const dotGit = join(checkoutRoot, '.git')
  // A linked worktree is exactly the case where `.git` is a FILE pointing into the main
  // worktree's admin directory. A normal checkout has a directory, and a non-repository
  // has neither -- both are already their own project root, so do not spawn git to ask.
  if (!existsSync(dotGit) || statSync(dotGit).isDirectory()) return checkoutRoot

  let commonDir: string
  try {
    commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: checkoutRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return checkoutRoot
  }
  if (!commonDir) return checkoutRoot

  const mainRoot = dirname(commonDir)
  // A submodule also has a `.git` file, and its common directory lives under the
  // superproject's `.git/modules/<name>` -- whose parent is not a worktree at all.
  // Requiring the result to look like a checkout keeps that case on the safe path.
  return existsSync(join(mainRoot, '.git')) ? mainRoot : checkoutRoot
}

/** The sidecar file Codex will actually read for a project. */
export function codexSidecarPath(projectRoot: string): string {
  return join(resolveCodexProjectRoot(projectRoot), '.codex', 'hooks.json')
}

export interface TrustDiagnosis {
  ready: boolean
  /** Loaded and enabled, but not permitted to execute. */
  blocked: CodexHookStatus[]
  messages: string[]
}

/**
 * Turn a report into a launch-time readiness decision.
 *
 * The failure this prevents is the silent one: launching, watching no hooks arrive, and
 * concluding something is wrong with the lifecycle rather than with deployment state.
 * A session whose hooks cannot execute has no turn-completion signal at all, so its
 * lifecycle guarantees are knowingly absent before it starts -- which is a reason to
 * refuse to start it, not to start it and infer badly.
 */
export function diagnoseHookTrust(report: CodexHookReport, matchCommand?: string): TrustDiagnosis {
  const ours = matchCommand
    ? report.hooks.filter((h) => h.command?.includes(matchCommand))
    : report.hooks
  const blocked = ours.filter((h) => !h.executable)
  const messages: string[] = []

  for (const w of report.warnings) messages.push(`config warning: ${w}`)
  for (const e of report.errors) messages.push(`config error in ${e.path}: ${e.message}`)

  for (const h of blocked) {
    // Say all four states out loud. "enabled but not executable" is the whole point,
    // and a summary that omits it invites the reader to assume the hook works.
    messages.push(
      `${h.eventName}: loaded=${h.loaded} enabled=${h.enabled} trusted=${h.trusted} ` +
        `executable=${h.executable} (trustStatus=${h.trustStatus}) — it is registered and ` +
        `enabled but will NOT run. Trust it via the Codex TUI, or pre-seed ` +
        `[hooks.state."${h.sourcePath}:${snakeEvent(h.eventName)}:0:0"] in ~/.codex/config.toml.`,
    )
  }
  if (ours.length === 0) {
    // Codex reports an untrusted DIRECTORY as an empty hook list: no error, no warning,
    // no hint that a decision is outstanding. Saying "check the sidecar file format" sent
    // the reader to inspect a file that is almost never the problem — and cannot be, when
    // the file is one this tool rendered moments earlier. Distinguish the two causes by
    // the only evidence available, which is whether the sidecar is there at all.
    const sidecar = codexSidecarPath(report.cwd)
    messages.push(
      existsSync(sidecar)
        ? `Codex loaded no hooks from ${sidecar}, which it reports the same way whether ` +
            `the sidecar is missing or the DIRECTORY is untrusted. The file is present, so ` +
            `this is the directory: run \`codex\` once in ${report.cwd} and accept the ` +
            `prompts — it asks about the directory first, then about the hooks.`
        : `no Codex sidecar at ${sidecar}; run \`conclave config install\` in ${report.cwd}`,
    )
  }

  return { ready: blocked.length === 0 && ours.length > 0, blocked, messages }
}

/** Launch precondition. Throws rather than starting a session with no lifecycle signal. */
export async function assertCodexHooksExecutable(cwd: string, matchCommand: string): Promise<void> {
  const diagnosis = diagnoseHookTrust(await readCodexHooks(cwd), matchCommand)
  if (diagnosis.ready) return
  throw new Error(
    `codex hooks are not executable in ${cwd}; refusing to start a session with no ` +
      `turn-completion signal.\n  ${diagnosis.messages.join('\n  ')}`,
  )
}

/**
 * Record Codex's two trust decisions directly, instead of driving a TUI to make them.
 *
 * Codex gates on two separate things and both live in the user's global config:
 *
 *   [projects."<cwd>"]                     trust_level  — may hooks load here at all
 *   [hooks.state."<key>"]                  trusted_hash — may THIS handler execute
 *
 * The second is unreachable until the first is granted: an untrusted directory reports an
 * empty hook list, so there are no keys or hashes to record. That is why this seeds the
 * directory, re-reads, and only then seeds the handlers — the same two passes the TUI
 * needs, for the same reason.
 *
 * OPT-IN, and it stays that way. This writes a file Conclave does not own, granting
 * command execution in a directory. `trustCodexHooks` remains the default because it goes
 * through the prompts Codex itself shows; this exists because those prompts require a
 * terminal, and every new project needing one is the largest obstacle to starting.
 *
 * Idempotent: an entry that already carries the right value is left alone, and the caller
 * is told exactly which lines were added.
 */
/**
 * What Codex has recorded about a directory, or undefined if it has never been asked.
 *
 * The check that was missing. `trustCodexHooks` returns `{prompted, askedAboutDirectory}`,
 * which says a prompt APPEARED and never what was DECIDED -- so a keystroke that lands on
 * the wrong option is indistinguishable from one that lands on the right one, until hook
 * trust fails a minute later and the message blames a directory that is now recorded as
 * decided. The docstring on `trustCodexHooks` already establishes that `prompted` is not
 * evidence a decision was recorded; the same scepticism was never applied to the directory.
 *
 * Reported from another project on 0.147.0, where a run left `trust_level = "untrusted"`
 * behind and then refused to start. Reading the file is cheap and settles it.
 */
export function recordedTrustLevel(cwd: string): string | undefined {
  const path = join(homedir(), '.codex', 'config.toml')
  if (!existsSync(path)) return undefined
  const real = (() => {
    try {
      return realpathSync(cwd)
    } catch {
      return cwd
    }
  })()
  const escaped = real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`\\[projects\\."${escaped}"\\]\\s*\\n\\s*trust_level\\s*=\\s*"([^"]*)"`).exec(
    readFileSync(path, 'utf8'),
  )
  return m?.[1]
}

export async function seedCodexTrust(cwd: string): Promise<{ added: string[]; ready: boolean }> {
  const path = join(homedir(), '.codex', 'config.toml')
  const added: string[] = []

  const read = () => (existsSync(path) ? readFileSync(path, 'utf8') : '')
  const upsert = (header: string, body: string): void => {
    const text = read()
    const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const existing = new RegExp(`${escaped}\\n${body.split(' = ')[0]} = "[^"]*"`)
    if (existing.test(text)) {
      const wanted = `${header}\n${body}`
      if (text.includes(wanted)) return
      writeFileSync(path, text.replace(existing, wanted))
    } else {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${text.replace(/\n*$/, '')}\n\n${header}\n${body}\n`)
    }
    added.push(header)
  }

  // The directory first. Realpath'd, because Codex records the resolved path and a symlink
  // would produce an entry that never matches.
  const real = existsSync(cwd) ? realpathSync(cwd) : cwd
  upsert(`[projects."${real}"]`, 'trust_level = "trusted"')

  // Now the handlers, which only appear once the directory is trusted.
  const report = await readCodexHooks(cwd)
  for (const h of report.hooks) {
    if (!h.key || !h.currentHash) continue
    upsert(`[hooks.state."${h.key}"]`, `trusted_hash = "${h.currentHash}"`)
  }

  const after = diagnoseHookTrust(await readCodexHooks(cwd), CONCLAVE_HOOK_MATCH)
  return { added, ready: after.ready }
}

/**
 * Answer the "Hooks need review" interstitial once, selecting "Trust all and continue".
 *
 * Bootstrap only -- not part of the transport, and it costs no model tokens. Codex
 * persists the decision to the USER-level ~/.codex/config.toml as
 * `[hooks.state."<file>:<event>:<group>:<index>"] trusted_hash`, so this mutates global
 * state even though the hooks themselves are project-local.
 */
async function trustCodexHooksOnce(
  cwd: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ prompted: boolean; askedAboutDirectory: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 45_000
  const pty = await PtyProcess.spawn({
    file: 'codex',
    args: ['-c', 'check_for_update_on_startup=false', '-c', 'disable_paste_burst=true'],
    cwd,
    env: sanitizedCopy(process.env as Record<string, string>),
  })

  try {
    // A directory Codex has not seen before is asked about FIRST, and the hook review
    // prompt only follows once it is answered. Skipping this leaves the helper waiting
    // for a prompt that will never appear -- which is how a project the caller just
    // created silently fails to get trusted at all.
    const askedAboutDirectory = await pty.waitForOutput(
      (all) => squash(all).includes('Doyoutrustthecontentsofthisdirectory'),
      8_000,
    )
    if (askedAboutDirectory) {
      await new Promise((r) => setTimeout(r, 600))
      pty.write('1') // "Yes, continue"
      await new Promise((r) => setTimeout(r, 400))
      pty.write('\r')
      await new Promise((r) => setTimeout(r, 1200))
    }

    const prompted = await pty.waitForOutput(
      (all) => squash(all).includes('Hooksneedreview'),
      timeoutMs,
    )
    if (prompted) {
      await new Promise((r) => setTimeout(r, 1000))
      pty.write('2') // "Trust all and continue"
      await new Promise((r) => setTimeout(r, 500))
      pty.write('\r')
      await pty.waitQuiet(1500, 20_000)
      await new Promise((r) => setTimeout(r, 1500))
    }
    return { prompted, askedAboutDirectory }
  } finally {
    await pty.terminate()
  }
}

/**
 * Trust a project's directory AND its hooks, which takes TWO launches, not one.
 *
 * Codex will not load project hooks from a directory it has not been told to trust. So
 * the launch that answers the directory question cannot also answer the hook review: at
 * the moment that launch is running, the hooks do not exist as far as Codex is concerned.
 * The hook prompt string can still appear in that first launch's output, so `prompted`
 * is not evidence the decision was recorded -- measured on a fresh project, launch one
 * reported `prompted: true` and wrote ZERO `hooks.state` entries, and launch two wrote
 * all five.
 *
 * Relaunching is therefore keyed on `askedAboutDirectory`: if this launch had to answer
 * the directory question, the hooks were invisible to it and a second pass is required.
 * A project whose directory was already trusted needs one launch, and a fully trusted one
 * exits without prompting at all.
 */
export async function trustCodexHooks(
  cwd: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ prompted: boolean; askedAboutDirectory: boolean; launches: number }> {
  let prompted = false
  let askedAboutDirectory = false
  let launches = 0

  // Two at most: the directory can only be untrusted once.
  for (let i = 0; i < 2; i++) {
    launches++
    const r = await trustCodexHooksOnce(cwd, opts)
    prompted ||= r.prompted
    askedAboutDirectory ||= r.askedAboutDirectory
    if (!r.askedAboutDirectory) break
  }

  return { prompted, askedAboutDirectory, launches }
}

/**
 * Wait until Codex reports our hooks as executable, because it records trust when it
 * EXITS.
 *
 * The write lands after the pty is gone, so a diagnosis run immediately after trusting
 * reads the old state and concludes the trust did not take. That is not a theoretical
 * race: it is what made a freshly trusted project refuse at the registry preflight and
 * then start fine on the next attempt, which is the worst possible presentation -- it
 * looks like flakiness in the session rather than a settled fact about Codex.
 */
export async function waitForCodexHooksExecutable(
  cwd: string,
  matchCommand: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const diagnosis = diagnoseHookTrust(await readCodexHooks(cwd), matchCommand)
    if (diagnosis.ready) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 1_000))
  }
}

/**
 * The event name as Codex writes it in `hooks.state` keys: snake_case, not lowercased.
 *
 * The remedy in `diagnoseHookTrust` used to print `sessionstart`, and Codex writes
 * `session_start` — so it named an entry that could never match. Verified against all five
 * entries Codex itself wrote for a trusted checkout.
 */
export function snakeEvent(eventName: string): string {
  return eventName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}
