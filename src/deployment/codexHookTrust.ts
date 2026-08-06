import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
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

import { spawn } from 'node:child_process'
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
    messages.push('no matching hooks are loaded at all; check the sidecar file format')
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
 * Answer the "Hooks need review" interstitial once, selecting "Trust all and continue".
 *
 * Bootstrap only -- not part of the transport, and it costs no model tokens. Codex
 * persists the decision to the USER-level ~/.codex/config.toml as
 * `[hooks.state."<file>:<event>:<group>:<index>"] trusted_hash`, so this mutates global
 * state even though the hooks themselves are project-local.
 */
export async function trustCodexHooks(
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
 * The event name as Codex writes it in `hooks.state` keys: snake_case, not lowercased.
 *
 * The remedy in `diagnoseHookTrust` used to print `sessionstart`, and Codex writes
 * `session_start` — so it named an entry that could never match. Verified against all five
 * entries Codex itself wrote for a trusted checkout.
 */
export function snakeEvent(eventName: string): string {
  return eventName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}
