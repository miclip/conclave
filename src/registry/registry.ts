/**
 * The agent registry.
 *
 * Resolution is deliberately explicit and produces good errors, because its inputs will
 * eventually come from a config file written by a human rather than from a call site
 * written by a compiler.
 */

import type { AgentSession } from '../contract/session.ts'
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
    // Preconditions first. An adapter must not be able to skip them by construction.
    if (resolved.agent.preflight) await resolved.agent.preflight(resolved, ctx)
    return resolved.agent.create(resolved, ctx)
  }
}
