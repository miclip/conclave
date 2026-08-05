/**
 * Roles as data.
 *
 * Project configuration will eventually assign agents to roles, so a role cannot be a
 * closed union baked into the type system -- a config file that names a role the code
 * has never heard of has to be a validation error with a good message, not a compile
 * error in someone else's checkout.
 *
 * This is the shape configuration will produce. It is NOT the configuration subsystem:
 * nothing here reads a file, resolves a layer, or merges anything.
 */

import type { InputOwnership } from '../contract/session.ts'

export type RoleId = string

/**
 * How much of the working set a participant in this role should accumulate.
 *
 * The brief's central claim is that context isolation is half the benefit: an advisor
 * that ends up with the implementer's context means two models were paid for and one
 * perspective was bought. Declaring the intent here does not yet enforce it -- the
 * adapter has no context-budgeting machinery, and pretending otherwise would be worse
 * than saying so.
 */
export type ContextPolicy = 'full' | 'thin'

export interface RoleDefinition {
  id: RoleId
  displayName: string
  description: string
  contextPolicy: ContextPolicy
  /** Whether a participant in this role is expected to modify the workspace. */
  mutatesWorkspace: boolean
  /** Default input ownership. Overridable per participant. */
  defaultInputOwnership: InputOwnership
  /** False for seats that are not models at all -- see `arbiter`. */
  isModel: boolean
}

export const BUILTIN_ROLES: Record<RoleId, RoleDefinition> = {
  implementer: {
    id: 'implementer',
    displayName: 'Implementer',
    description: 'Holds the codebase context, writes and runs code, has filesystem and shell.',
    contextPolicy: 'full',
    mutatesWorkspace: true,
    defaultInputOwnership: 'mediated',
    isModel: true,
  },
  advisor: {
    id: 'advisor',
    displayName: 'Advisor',
    description:
      'Architecture, design review, adversarial critique. Deliberately kept on a thin ' +
      'context diet: gets summaries and diffs, not the full working set.',
    contextPolicy: 'thin',
    mutatesWorkspace: false,
    defaultInputOwnership: 'mediated',
    isModel: true,
  },
  arbiter: {
    id: 'arbiter',
    displayName: 'Arbiter',
    description:
      'Not a model. Tests, type checker, linter, benchmark, compiler. Any disagreement ' +
      'that can be settled by running something should be.',
    contextPolicy: 'thin',
    mutatesWorkspace: false,
    defaultInputOwnership: 'mediated',
    isModel: false,
  },
}

export function resolveRole(id: RoleId, roles: Record<RoleId, RoleDefinition> = BUILTIN_ROLES): RoleDefinition {
  const role = roles[id]
  if (!role) {
    throw new Error(`unknown role '${id}'. Known roles: ${Object.keys(roles).sort().join(', ')}`)
  }
  return role
}
