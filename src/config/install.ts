/**
 * `conclave config install` — render project-local hook registrations for this checkout.
 *
 * Both CLIs require an absolute command path in their hook configuration, so an active
 * registration is necessarily machine-local. Committing one bakes somebody's home
 * directory into portable source. The split here is: canonical templates are versioned,
 * rendered registrations are generated and git-ignored.
 *
 * A consequence worth surfacing rather than hiding: Codex's trust hash covers the
 * normalised handler, which includes that command string. Every checkout therefore
 * produces a different hash and must trust its own hooks once. That is inherent to
 * diagnosing trust via `hooks/list` instead of reimplementing Codex's hashing, and the
 * installer says so instead of leaving the next person to rediscover it.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { CONCLAVE_HOOK_MATCH, diagnoseHookTrust, readCodexHooks } from '../deployment/codexHookTrust.ts'

export const TEMPLATE_TOKEN = '{{REPO_ROOT}}'

export interface RenderTarget {
  /** Template path, relative to the repository root. */
  template: string
  /** Rendered output path, relative to the repository root. */
  output: string
  label: string
}

export const TARGETS: RenderTarget[] = [
  {
    template: 'config/templates/claude-settings.json',
    output: '.claude/settings.json',
    label: 'Claude project hooks',
  },
  {
    template: 'config/templates/codex-hooks.json',
    output: '.codex/hooks.json',
    label: 'Codex sidecar',
  },
]

/** Prefer git, because a checkout can be nested anywhere; fall back to walking up. */
export function resolveRepoRoot(from: string = process.cwd()): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: from,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out) return out
  } catch {
    /* not a git checkout, or git absent */
  }
  let dir = resolve(from)
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`could not resolve a repository root from ${from}`)
    dir = parent
  }
}

export function render(templateText: string, repoRoot: string): string {
  if (!templateText.includes(TEMPLATE_TOKEN)) {
    throw new Error(`template contains no ${TEMPLATE_TOKEN}; it would render identically everywhere`)
  }
  const rendered = templateText.split(TEMPLATE_TOKEN).join(repoRoot)
  // Fail here rather than handing a broken registration to a CLI that will ignore it
  // silently -- an unparseable sidecar is exactly the failure mode that looks like
  // "hooks just don't fire".
  JSON.parse(rendered)
  return rendered
}

/**
 * Write via a temporary sibling plus rename. A half-written hooks.json is not merely
 * inconvenient: Codex would fail to parse it and load no hooks at all, which presents as
 * a lifecycle problem rather than a config one.
 */
export function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, contents)
    renameSync(tmp, path)
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* best effort */
    }
    throw err
  }
}

export interface InstallResult {
  repoRoot: string
  dryRun: boolean
  written: { label: string; path: string; changed: boolean }[]
  codex?: {
    ready: boolean
    retrustRequired: boolean
    messages: string[]
  }
}

export interface InstallOptions {
  repoRoot?: string
  /** Skip the Codex diagnosis (it spawns `codex app-server`, costing a second or two). */
  diagnose?: boolean
  /**
   * Report what would change without writing anything.
   *
   * Rendering is already a no-op on an unchanged checkout -- identical bytes are not
   * rewritten, so mtime does not move and no trust transition occurs. This exists so that
   * property can be *verified* before something that depends on it, rather than
   * remembered. Before collecting fixtures, check; only install if something drifted.
   */
  dryRun?: boolean
}

export async function installConfig(opts: InstallOptions = {}): Promise<InstallResult> {
  const repoRoot = opts.repoRoot ?? resolveRepoRoot()
  const written: InstallResult['written'] = []

  for (const target of TARGETS) {
    const templatePath = join(repoRoot, target.template)
    if (!existsSync(templatePath)) {
      throw new Error(`missing template ${target.template}; the checkout is incomplete`)
    }
    const outputPath = join(repoRoot, target.output)
    const contents = render(readFileSync(templatePath, 'utf8'), repoRoot)
    const previous = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : undefined
    const changed = previous !== contents
    // Never rewrite identical bytes. Harmless for Claude; for Codex a rewritten handler
    // would re-hash and invalidate an existing trust decision for no reason.
    if (changed && !opts.dryRun) writeAtomic(outputPath, contents)
    written.push({ label: target.label, path: outputPath, changed })
  }

  const result: InstallResult = { repoRoot, dryRun: opts.dryRun === true, written }

  if (opts.diagnose !== false) {
    try {
      const report = await readCodexHooks(repoRoot)
      const diagnosis = diagnoseHookTrust(report, CONCLAVE_HOOK_MATCH)
      result.codex = {
        ready: diagnosis.ready,
        // Re-trust is needed when hooks loaded but are not permitted to execute. A
        // changed command string re-hashes the handler, so this is expected on a fresh
        // checkout rather than a sign something is wrong.
        retrustRequired: !diagnosis.ready && report.hooks.length > 0,
        messages: diagnosis.messages,
      }
    } catch (err) {
      result.codex = {
        ready: false,
        retrustRequired: false,
        messages: [`could not diagnose Codex state: ${String(err)}`],
      }
    }
  }

  return result
}

/** True when the checkout's registrations differ from what the templates would render. */
export function hasDrift(r: InstallResult): boolean {
  return r.written.some((w) => w.changed)
}

/**
 * The same report as `formatInstallResult`, for consumers rather than readers.
 *
 * `drift` is emitted explicitly even though it is derivable from `written`, because it is
 * the field the exit code is computed from. Leaving it out would oblige every consumer to
 * reconstruct that rule, and a consumer that reconstructed it slightly differently would
 * disagree with the process it was reading.
 */
export function formatInstallResultJson(r: InstallResult): string {
  return JSON.stringify({ drift: hasDrift(r), ...r }, null, 2)
}

export function formatInstallResult(r: InstallResult): string {
  const lines = [`repository root: ${r.repoRoot}`]
  for (const w of r.written) {
    const state = w.changed ? (r.dryRun ? 'DRIFT  ' : 'wrote  ') : 'current'
    lines.push(`  ${state} ${w.label}: ${w.path}`)
  }
  if (r.dryRun && hasDrift(r)) {
    lines.push('')
    lines.push('Registrations differ from the templates. Running `config install` would')
    lines.push('rewrite them, which re-hashes the Codex handlers and requires re-trusting.')
  }
  if (!r.codex) return lines.join('\n')

  lines.push('')
  if (r.codex.ready) {
    lines.push('Codex hooks are loaded, enabled and trusted — they will run.')
  } else if (r.codex.retrustRequired) {
    lines.push('Codex hooks need re-trusting before they will run.')
    lines.push('  Codex hashes the normalised handler, which includes the absolute command')
    lines.push('  path, so every checkout must trust its own hooks once. Start `codex` in')
    lines.push('  this directory and choose "Trust all and continue" at the review prompt.')
  } else {
    lines.push('Codex state could not be confirmed.')
  }
  for (const m of r.codex.messages) lines.push(`  - ${m}`)
  return lines.join('\n')
}
