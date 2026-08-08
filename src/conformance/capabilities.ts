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
    // Driven past a 6s watchdog with a turn shelling out to `sleep 40`, on 2.1.224. The
    // recorded verdict carries the screen tail, which is what separates "alive and slow"
    // from "dead": the terminal was still animating a thinking indicator.
    timed_out: 'observed',
    // `close('abandoned')` with a turn genuinely in flight, on 2.1.224. Captured as a
    // recorded fixture rather than found in a transcript, because an adapter that stopped
    // observing leaves nothing in the file it stopped reading -- the verdict IS the evidence.
    transport_lost: 'observed',
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
    // Driven past an 8s watchdog on 0.146.0 with hooks trusted. `uncertain`, like Claude
    // Code's: on a pty adapter a timeout means only that nothing arrived.
    timed_out: 'observed',
    // `close('abandoned')` with a turn in flight, on 0.146.0.
    transport_lost: 'observed',
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
    // We own the process; killing it IS the cancellation, which is why this is `proven`
    // rather than the `assumed` the pty adapters have to settle for. Captured live.
    cancelled: 'observed',
    // No dialog exists in `run` mode. See above.
    permission_refused: 'unsupported',
    // `close('graceful')` with a turn in flight. Distinct from `cancelled`, which is the
    // same signal with our own bookkeeping saying we asked for it.
    process_exited: 'observed',
    // Driven past a 5s watchdog on a real run.
    timed_out: 'observed',
    transport_lost: 'reasoned_but_unverified',
    // Deliberately distinct from `completed`: a run CAN exit non-zero, or exit 0 having
    // silently failed an auxiliary model call, so exit status alone never proves a turn
    // finished. Captured from a paid model on an account with no payment method.
    unknown_abnormal_end: 'observed',
  },
}

/**
 * kimi 1.49.0, via `--print --output-format stream-json`.
 *
 * `completed` is `observed`, and since the adapter registers hooks its CONFIDENCE is now
 * `proven`: a live run reports `provenance: hook:Stop` with `synthesized: false`. The
 * message-stream fixture in `spikes/kimi/fixtures/` still backs the outcome; the hook is what
 * makes it announced rather than inferred.
 *
 * The `inferred` grading has not gone away -- it is the documented fallback when hook mode
 * cannot be set up, and it then describes that SESSION rather than this agent.
 *
 * `permission_refused` stays `unsupported`: `--print` auto-approves for the invocation, so
 * there is no dialog to refuse and no hook can create one.
 */
export const KIMI_CAPABILITIES: AdapterCapabilities = {
  agent: 'kimi',
  readinessSignal: 'first_turn',
  turnKeySource: 'run_invocation',
  outcomes: {
    completed: 'observed',
    // Captured live, after fixing a cancel that waited out orphaned grandchildren.
    cancelled: 'observed',
    // `--print` auto-approves for the invocation; there is no dialog to refuse.
    permission_refused: 'unsupported',
    process_exited: 'reasoned_but_unverified',
    timed_out: 'observed',
    transport_lost: 'reasoned_but_unverified',
    // Captured live from a model name the provider does not have.
    unknown_abnormal_end: 'observed',
  },
}

export const ALL_CAPABILITIES = [
  CLAUDE_CAPABILITIES,
  CODEX_CAPABILITIES,
  OPENCODE_CAPABILITIES,
  KIMI_CAPABILITIES,
]
