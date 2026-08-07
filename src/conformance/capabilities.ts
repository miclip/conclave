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
  // No hook fires before the first turn -- not even SessionStart. Observed directly on
  // 0.146.0: a booted session that never took a turn produced no hooks at all, and the
  // TUI accepted input ~3ms after negotiating raw mode. Readiness is therefore the
  // terminal going interactive, not a lifecycle event.
  readinessSignal: 'first_turn',
  turnKeySource: 'turn_id',
  outcomes: {
    // Stop fires carrying turn_id and last_assistant_message, and the transcript
    // independently records task_complete.
    completed: 'observed',
    // turn_aborted reason=interrupted. Stop does NOT fire; the two are mutually
    // exclusive on 0.146.0.
    cancelled: 'observed',
    // Observed, with a qualification that matters: the transcript record for a refused
    // permission is `turn_aborted reason=interrupted` -- byte-identical to a user
    // cancellation. What separates them is PermissionRequest having fired plus the
    // orchestrator's own record of having sent the deny. Under `external` input
    // ownership that second half is unavailable, and this outcome degrades to
    // indistinguishable-from-cancelled.
    permission_refused: 'observed',
    // Observed, but from the ABSENCE of evidence plus process state. SIGTERM mid-turn
    // produced no Stop, no SessionEnd, and a transcript ending after user_message with
    // neither task_complete nor turn_aborted. Codex itself emits no terminal record for
    // a killed turn; the classification comes entirely from knowing the process died.
    process_exited: 'observed',
    timed_out: 'reasoned_but_unverified',
    transport_lost: 'reasoned_but_unverified',
    unknown_abnormal_end: 'reasoned_but_unverified',
  },
}

/**
 * opencode 1.18.15, via `run --format json`.
 *
 * The first adapter whose terminal signal is announced by the child in a documented output
 * mode rather than recovered from a hook we had to register or a transcript we had to
 * parse. `step_finish` carries `reason: "stop"` on the final step and `reason: "tool-calls"`
 * on every intermediate one; a real 3-step, 2-tool, file-writing turn is captured in
 * `spikes/opencode/fixtures/edit-turn.ndjson`.
 *
 * `permission_refused` is `unsupported`, which is a stronger statement than the
 * `reasoned_but_unverified` used elsewhere and is meant to be. `run` has no permission
 * dialog at all: approval is settled by configuration before the process starts, so there
 * is no request to refuse and `decidePermission` throws rather than pretending. This is a
 * genuine capability gap rather than an untested claim, and grading it as merely unverified
 * would imply a fixture could someday close it.
 */
export const OPENCODE_CAPABILITIES: AdapterCapabilities = {
  agent: 'opencode',
  // Literal rather than a concession. There is no resident process between turns, so
  // there is nothing that could become ready before the first one.
  readinessSignal: 'first_turn',
  // Neither of the other two sources exists here. A turn is one `run` invocation, and the
  // ids OpenCode does emit (messageID) change per STEP, so they identify something
  // narrower than a turn and cannot stand in for one.
  turnKeySource: 'run_invocation',
  outcomes: {
    // step_finish reason=stop, then process exit. Two independent signals, both observed.
    completed: 'observed',
    // We own the process; killing it IS the cancellation. Not yet captured as a fixture,
    // so the mechanism is argued rather than demonstrated.
    cancelled: 'reasoned_but_unverified',
    // No dialog exists in `run` mode. See above.
    permission_refused: 'unsupported',
    process_exited: 'reasoned_but_unverified',
    timed_out: 'reasoned_but_unverified',
    transport_lost: 'reasoned_but_unverified',
    // Reachable and deliberately distinct from `completed`: a run CAN exit 0 having
    // silently failed an auxiliary model call, so exit status alone never proves a turn
    // finished. Observed in the spike as a billing failure on an account with no payment
    // method, where the run still exited 0.
    unknown_abnormal_end: 'reasoned_but_unverified',
  },
}

/**
 * kimi 1.49.0, via `--print --output-format stream-json`.
 *
 * `completed` is `observed` -- a real run is captured in
 * `spikes/kimi/fixtures/edit-turn.ndjson` -- but its CONFIDENCE is `inferred` rather than
 * `proven`, and the two must not be confused. The fixture proves the outcome is producible
 * and that the parser reads it. It does not make the claim announced: nothing in this output
 * mode says the turn ended. Completion is the shape of the final message plus a zero exit.
 *
 * Kimi has a `Stop` hook, one of thirteen carrying Claude Code's payload shape. Using it
 * would make this announced, and would additionally supply `PostToolUseFailure` -- which is
 * why `permission_refused` is unsupported and tool failure is currently invisible here.
 */
export const KIMI_CAPABILITIES: AdapterCapabilities = {
  agent: 'kimi',
  readinessSignal: 'first_turn',
  turnKeySource: 'run_invocation',
  outcomes: {
    completed: 'observed',
    cancelled: 'reasoned_but_unverified',
    // `--print` auto-approves for the invocation; there is no dialog to refuse.
    permission_refused: 'unsupported',
    process_exited: 'reasoned_but_unverified',
    timed_out: 'reasoned_but_unverified',
    transport_lost: 'reasoned_but_unverified',
    unknown_abnormal_end: 'reasoned_but_unverified',
  },
}

export const ALL_CAPABILITIES = [
  CLAUDE_CAPABILITIES,
  CODEX_CAPABILITIES,
  OPENCODE_CAPABILITIES,
  KIMI_CAPABILITIES,
]
