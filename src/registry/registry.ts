/**
 * The agent registry.
 *
 * Resolution is deliberately explicit and produces good errors, because its inputs will
 * eventually come from a config file written by a human rather than from a call site
 * written by a compiler.
 */

import type { AgentSession } from '../contract/session.ts'
import { refuseMissingCommands } from './executables.ts'
import { launchRecordFor } from './launch.ts'
import { refuseUnknownModels } from './models.ts'
import { BUILTIN_ROLES, resolveRole, type RoleDefinition, type RoleId } from './roles.ts'
import {
  resolveInputPolicy,
  type AgentDefinition,
  type CreateParticipantContext,
  type ParticipantSpec,
  type ResolvedParticipant,
} from './types.ts'

export class AgentRegistry {
  readonly #agents = new Map<string, AgentDefinition>()
  readonly #roles: Record<RoleId, RoleDefinition>

  constructor(roles: Record<RoleId, RoleDefinition> = BUILTIN_ROLES) {
    this.#roles = { ...roles }
  }

  register(def: AgentDefinition): this {
    if (this.#agents.has(def.id)) throw new Error(`agent '${def.id}' is already registered`)
    // Refused here rather than defaulted at read time. TypeScript already stops the typed
    // callers; the ones this is for are the untyped -- a registration assembled in a
    // generated script or, later, from a config file -- where the alternatives are a report
    // that invents a deadline nobody enforces, or a TypeError thrown while assembling the
    // record of a run that had otherwise finished.
    if (!def.deadlines) {
      throw new Error(
        `agent '${def.id}' must declare its deadline clocks. There is no default: one would ` +
          `report a deadline the adapter does not run. Use NO_DEADLINE_CLOCKS if it runs none.`,
      )
    }
    this.#agents.set(def.id, def)
    return this
  }

  registerRole(role: RoleDefinition): this {
    this.#roles[role.id] = role
    return this
  }

  get roles(): Record<RoleId, RoleDefinition> {
    return { ...this.#roles }
  }

  has(id: string): boolean {
    return this.#agents.has(id)
  }

  get(id: string): AgentDefinition {
    const def = this.#agents.get(id)
    if (!def) {
      throw new Error(
        `unknown agent '${id}'. Registered agents: ${this.list().map((a) => a.id).join(', ') || 'none'}`,
      )
    }
    return def
  }

  list(): AgentDefinition[] {
    return [...this.#agents.values()]
  }

  /** Agents with a working adapter. The rest are described but not constructible. */
  listAvailable(): AgentDefinition[] {
    return this.list().filter((a) => a.create !== undefined)
  }

  /**
   * Validate a spec without launching anything. Configuration will want this to report
   * every problem in a file before starting any child process.
   */
  resolve(spec: ParticipantSpec): ResolvedParticipant {
    const agent = this.get(spec.agent)
    const role = resolveRole(spec.role, this.#roles)
    if (!role.isModel) {
      throw new Error(
        `role '${role.id}' is not a model seat; it cannot be filled by agent '${agent.id}'`,
      )
    }
    const { ownership, guarantees } = resolveInputPolicy(role, spec)
    return { spec, agent, role, inputOwnership: ownership, guarantees }
  }

  async createParticipant(
    spec: ParticipantSpec,
    ctx: CreateParticipantContext,
  ): Promise<AgentSession> {
    const resolved = this.resolve(spec)
    if (!resolved.agent.create) {
      throw new Error(
        `agent '${resolved.agent.id}' has no adapter yet` +
          (resolved.agent.unavailableReason ? `: ${resolved.agent.unavailableReason}` : ''),
      )
    }
    // The CLI this seat launches, looked for before anything is spawned, registered or written
    // (#51). FIRST of the two checks, and the order is load-bearing: asking a CLI to enumerate its
    // models when the CLI is not installed produces a failed spawn, which `checkModelSelection`
    // correctly reports as "could not be established" -- so a missing binary would otherwise be
    // announced as an unverifiable model. The cheaper and more specific question goes first.
    refuseMissingCommands([{ participant: spec.id, agent: resolved.agent, cwd: ctx.cwd }])
    // The model this seat names, asked of the child before it is started (#82). Here as well as
    // in `Relay.start` for the reason the preflight line below is here: this is the funnel every
    // caller passes through, rotation's replacement included, and a check that only the
    // front-ends run is a check the programmatic surface does not have. Costs nothing when the
    // argv names no model, and nothing twice when the run already asked -- the enumeration is
    // cached per command for the life of the process.
    await refuseUnknownModels([
      { participant: spec.id, agent: resolved.agent, model: launchRecordFor(resolved, ctx).model },
    ])
    // Preconditions first. An adapter must not be able to skip them by construction.
    if (resolved.agent.preflight) await resolved.agent.preflight(resolved, ctx)
    return resolved.agent.create(resolved, ctx)
  }
}
