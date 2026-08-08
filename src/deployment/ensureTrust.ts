/**
 * Making Codex actually run the hooks a project has registered.
 *
 * Registration is not enough. Codex never executes hooks in a directory it does not trust,
 * and it does so SILENTLY — turns end on watchdog inference, every verdict is `uncertain`,
 * and nothing says why. Worse, at the very first turn there is no `UserPromptSubmit` at all,
 * so the run ends `transport_failed` with a message that sends the operator to `config
 * check`, which cheerfully reports the hooks as registered.
 *
 * ## Why this is its own module
 *
 * It lived inside the console, and only inside the console. `conclave relay` registered the
 * sidecar and never trusted it and never even checked — so an unattended run in a fresh
 * project produced hooks Codex would not execute, with nobody present to answer the TUI
 * prompt that would have fixed it. The front-end designed to run without a human was the one
 * missing the step that removes the need for one.
 *
 * That is the ninth time a capability has been wired into one front-end and not the other,
 * which is why it is a shared function rather than a second copy.
 *
 * It cannot live in `codexHookTrust.ts`, which owns the trust primitives: `install.ts`
 * already imports from there, and this needs `installConfig` to diagnose.
 *
 * ## What it does to the operator's machine
 *
 * It spawns a real `codex` under a pty and answers the prompts Codex itself shows, which
 * writes to their GLOBAL config. That is heavier than anything else conclave does before a
 * run, so it is append-only, idempotent, announced, and attempted only when a diagnosis says
 * the hooks are not currently executable.
 */

import { installConfig, type AgentKind } from '../config/install.ts'
import {
  CONCLAVE_HOOK_MATCH,
  recordedTrustLevel,
  seedCodexTrust,
  trustCodexHooks,
  waitForCodexHooksExecutable,
} from './codexHookTrust.ts'

export interface EnsureTrustOptions {
  projectRoot: string
  /** Only the CLIs this run will launch. A Claude-only run spawns nothing here. */
  agents: AgentKind[]
  say: (line: string) => void
  /**
   * Run slow work while telling the operator it is still going.
   *
   * Injected because the two front-ends say "still working" differently — the console
   * redraws one line at a terminal, an unattended run appends — and neither should be
   * reimplemented here. Defaults to running the work silently, which is right for a caller
   * that has nowhere to put progress.
   *
   * It is not cosmetic. This waits on a real Codex TUI to draw its prompts: up to 8s for
   * the directory question, up to 45s for the hook review, plus settle time. A minute of
   * silence is indistinguishable from a hang.
   */
  slow?: <T>(label: string, detail: string, work: () => Promise<T>) => Promise<T>
  /**
   * The trust primitives, injectable.
   *
   * Not a testing convenience bolted on: every one of these spawns a real Codex or writes
   * the operator's global config, so without this seam the branch that decides BETWEEN them
   * can only be exercised by doing both to the machine running the suite. That is why the
   * flow this replaces had no test at all, and why it shipped a version that recorded the
   * opposite of what it intended.
   */
  deps?: Partial<TrustDeps>
}

export interface TrustDeps {
  trust: typeof trustCodexHooks
  recorded: typeof recordedTrustLevel
  seed: typeof seedCodexTrust
  waitExecutable: typeof waitForCodexHooksExecutable
  diagnose: typeof installConfig
}

export interface EnsureTrustResult {
  /** False when the diagnosis said there was nothing to do. */
  attempted: boolean
  /** Whether Codex will now execute the hooks. False after a failed attempt. */
  ready: boolean
}

/**
 * Diagnose, and if Codex will not run the hooks, answer its prompts once.
 *
 * NOT gated on having just written a registration. Trust is a decision in the operator's
 * global config and is entirely independent of whether the project files are current: a
 * project registered yesterday, or by `config install`, is registered and untrusted today.
 * Gating on "did we just change something" meant the second run in a new project skipped the
 * step that would have fixed it.
 */
export async function ensureCodexHooksTrusted(
  opts: EnsureTrustOptions,
): Promise<EnsureTrustResult> {
  const { projectRoot, agents, say } = opts
  const slow = opts.slow ?? (<T>(_l: string, _d: string, work: () => Promise<T>) => work())
  const d: TrustDeps = {
    trust: trustCodexHooks,
    recorded: recordedTrustLevel,
    seed: seedCodexTrust,
    waitExecutable: waitForCodexHooksExecutable,
    diagnose: installConfig,
    ...opts.deps,
  }

  const diagnosed = await d.diagnose({ projectRoot, agents, dryRun: true, diagnose: true })
  // The diagnosis messages are written for `config check`, where the operator is the one who
  // has to act: five near-identical paragraphs, each naming a `hooks.state` key to paste into
  // a TOML file. Here the tool is about to do that itself, so printing them is telling
  // someone how to perform a job already in hand. Held back, and shown only if the fix does
  // not work — the one case where the operator needs them.
  if (!diagnosed.codex || diagnosed.codex.ready) return { attempted: false, ready: true }

  say('  trusting this directory and its hooks with Codex — answers its own prompts once')
  const t = await slow('configuring', 'waiting for Codex to show its trust prompts', () =>
    d.trust(projectRoot),
  )

  // What was RECORDED, not whether a prompt appeared. `askedAboutDirectory` says only that
  // Codex asked; a keystroke landing on the wrong option is indistinguishable from one
  // landing on the right one until hook trust fails a minute later and the message blames a
  // directory that is by then recorded as decided. Reported from another project on 0.147.0,
  // which finished with `trust_level = "untrusted"` written by the very flow trying to trust
  // it.
  const level = d.recorded(projectRoot)
  if (t.askedAboutDirectory && level !== 'trusted') {
    // Seeded rather than refused. The operator opted into trusting this directory by asking
    // for a session in it, and the alternative is a run that will not start. `seedCodexTrust`
    // writes the same two keys Codex writes and verifies them, where driving the TUI depends
    // on prompt wording and option ordering in someone else's interface across versions --
    // so on the day those disagree, the escape hatch is the reliable path and the default is
    // not.
    say(
      `  Codex recorded this directory as ${level ?? 'undecided'} after its own prompts; ` +
        `writing the trust entries directly instead`,
    )
    const seeded = await slow('configuring', 'recording the trust decision', () =>
      d.seed(projectRoot),
    )
    for (const a of seeded.added) say(`    ${a}`)
    if (seeded.ready) {
      say('  configured: trusted directory and hooks')
      return { attempted: true, ready: true }
    }
  }
  // Codex records the decision when it EXITS, so confirm rather than assume. Without this a
  // preflight a moment later reads the pre-trust state and refuses, which presents as the
  // run being flaky rather than as Codex having been slow.
  const ready = await slow('configuring', 'confirming Codex recorded the decision', () =>
    d.waitExecutable(projectRoot, CONCLAVE_HOOK_MATCH),
  )

  const did = [t.askedAboutDirectory ? 'directory' : '', t.prompted ? 'hooks' : '']
    .filter(Boolean)
    .join(' and ')
  if (ready) {
    say(`  configured: trusted ${did || 'nothing left to trust'}`)
  } else {
    // Now the operator does have to act, so give them everything: what Codex reports for
    // each handler, and the exact key to pre-seed.
    say('  Codex still will not run these hooks. Turn outcomes will be inferred:')
    // Named first, because it is the one command that fixes this without a TUI and it was
    // never mentioned -- the message sent people to hand-edit TOML instead, which is both
    // harder and the thing they are least equipped to get right.
    say('  try: conclave config install --trust   (records the entries directly, no prompts)')
    const detail = await d.diagnose({ projectRoot, agents, dryRun: true, diagnose: true })
    for (const m of detail.codex?.messages ?? []) say(`  ${m}`)
  }
  return { attempted: true, ready }
}
