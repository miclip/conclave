/**
 * What each adapter claims it can do, graded by how well the claim is supported.
 *
 * Adapters differ in what they can *know*, not merely in how they are wired. Before a
 * single production adapter exists, Claude Code and Codex already disagree on
 * readiness, correlation identifiers, transcript structure, interruption
 * observability, and probably cancellation semantics. Encoding that here — and having
 * the suite check it against fixtures — is what stops the seam from quietly averaging
 * the two into a contract neither actually honours.
 *
 * Evidence levels (contract/outcome.ts):
 *   observed                        produced in a real run, fixture captured
 *   inferred_from_documented_event  the event exists per vendor/binary, not yet seen
 *   reasoned_but_unverified         argued from design; no fixture, no documentation
 *   unsupported                     this adapter cannot produce it at all
 *
 * Grades are claims. `suite.ts` verifies them.
 */

import type { AdapterCapabilities } from '../contract/session.ts'

/**
 * claude 2.1.222. Everything here except the last three was produced in a real run
 * during spikes 2 and 3; see spikes/hooks/FINDINGS.md.
 */
export const CLAUDE_CAPABILITIES: AdapterCapabilities = {
  agent: 'claude',
  // SessionStart fires at boot and blocks the first turn until it returns.
  readinessSignal: 'session_start_hook',
  turnKeySource: 'prompt_id',
  outcomes: {
    completed: 'observed',
    // Only ever `assumed` in confidence: nothing in the child records a cancellation.
    // The outcome itself was still produced in a real run.
    cancelled: 'observed',
    permission_refused: 'observed',
    process_exited: 'observed',
    // No fixture. A watchdog firing is trivially producible but says nothing we have
    // validated, so it stays unverified until a scenario exercises it.
    timed_out: 'reasoned_but_unverified',
    transport_lost: 'reasoned_but_unverified',
    unknown_abnormal_end: 'reasoned_but_unverified',
  },
}

/**
 * codex 0.146.0. The transcript-derived outcomes are observed across 530 historical
 * rollouts. The hook lifecycle is entirely unverified: the account hit its usage limit
 * during spike 1 and every Stop scenario needs a real turn.
 *
 * `turn_aborted` strongly suggests Codex offers a cleaner cancellation signal than
 * Claude Code, and the common interface still must not assume it until the
 * quota-reset fixtures exist.
 */
export const CODEX_CAPABILITIES: AdapterCapabilities = {
  agent: 'codex',
  // SessionStart did NOT fire at boot, nor on an app-server thread/start. Most likely
  // turn-scoped; unverified.
  readinessSignal: 'unknown',
  turnKeySource: 'turn_id',
  outcomes: {
    completed: 'observed',
    // The only turn_aborted fixtures on this machine are from February 2026 rollouts,
    // written by a much older CLI. They prove the record and the parser shape existed;
    // they do not prove 0.146.0 still emits it under the same circumstances.
    cancelled: 'observed_historically',
    // PermissionRequest is declared in the 0.146.0 binary's hook enum; never seen fire.
    permission_refused: 'inferred_from_documented_event',
    // SessionEnd is declared in the hook enum and in ManagedHooksRequirements.
    process_exited: 'inferred_from_documented_event',
    timed_out: 'reasoned_but_unverified',
    transport_lost: 'reasoned_but_unverified',
    unknown_abnormal_end: 'reasoned_but_unverified',
  },
}

export const ALL_CAPABILITIES = [CLAUDE_CAPABILITIES, CODEX_CAPABILITIES]
