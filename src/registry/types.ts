/**
 * Registration and participant construction, as data.
 *
 * Conclave will use layered configuration -- global user config defining available
 * agents and personal defaults, project-local `.conclave/` config selecting agents and
 * assigning them to roles. That subsystem is NOT built here, and nothing in this
 * directory reads a file or merges a layer.
 *
 * What is built is the shape configuration will produce, so that adding the Codex
 * adapter is a registration rather than an edit to call sites. If the second adapter
 * required touching the code that constructs the first, the seam would not be a seam.
 */

import type {
  AdapterCapabilities,
  AgentSession,
  Guarantees,
  InputOwnership,
} from '../contract/session.ts'
import { guaranteesFor } from '../contract/session.ts'
import type { RoleDefinition, RoleId } from './roles.ts'

/**
 * How a child CLI is launched, including the interstitials that must be suppressed by
 * configuration rather than answered by keystroke.
 *
 * Suppression is not cosmetic. During spike 1 a prompt intended for the composer was
 * consumed by Codex's startup update dialog and its default selection ran
 * `npm install -g @openai/codex`. Anything a driver can accidentally "answer" belongs
 * here as a flag.
 */
export interface LaunchSpec {
  command: string
  baseArgs: string[]
  /** Documented reasons for each suppression flag, keyed by what it suppresses. */
  suppresses?: Record<string, string>
  /** Preconditions the adapter cannot fix itself, e.g. Codex hook trust. */
  deploymentState?: string[]
}

export interface CreateParticipantContext {
  cwd: string
  /** Extra CLI args for this participant, from configuration. */
  args?: string[]
  watchdogMs?: number
  readyTimeoutMs?: number
}

/**
 * A deployment precondition checked BEFORE a session is started.
 *
 * Some guarantees are absent before the first byte is written -- Codex hooks that are
 * registered and enabled but not trusted will never fire, so such a session has no
 * turn-completion signal at all. Starting it anyway means inferring outcomes from
 * evidence we already know will not arrive. Better to refuse, with the reason.
 */
export type Preflight = (
  resolved: ResolvedParticipant,
  ctx: CreateParticipantContext,
) => Promise<void>

export interface AgentDefinition {
  id: string
  displayName: string
  capabilities: AdapterCapabilities
  launch: LaunchSpec
  /** Runs before `create`. Throwing here prevents the session from starting. */
  preflight?: Preflight
  /**
   * Absent when an agent is known and described but has no working adapter yet.
   * Registering it anyway is deliberate: it can be listed and conformance-graded
   * without being constructible, which keeps its lower confidence visible rather than
   * making it look finished by omission.
   */
  create?: (spec: ResolvedParticipant, ctx: CreateParticipantContext) => Promise<AgentSession>
  /** Why `create` is absent, surfaced when someone tries anyway. */
  unavailableReason?: string
}

/** The shape project configuration will produce. Plain data on purpose. */
export interface ParticipantSpec {
  /** Stable id for this seat, e.g. 'impl'. Distinct from the agent id. */
  id: string
  agent: string
  role: RoleId
  /** Overrides the role's default. */
  inputOwnership?: InputOwnership
  args?: string[]
  displayName?: string
}

export interface ResolvedParticipant {
  spec: ParticipantSpec
  agent: AgentDefinition
  role: RoleDefinition
  inputOwnership: InputOwnership
  guarantees: Guarantees
}

export function resolveInputPolicy(
  role: RoleDefinition,
  spec: ParticipantSpec,
): { ownership: InputOwnership; guarantees: Guarantees } {
  const ownership = spec.inputOwnership ?? role.defaultInputOwnership
  return { ownership, guarantees: guaranteesFor(ownership) }
}
