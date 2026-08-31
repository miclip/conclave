/**
 * Roles an operator defined, referenced by name. #89.
 *
 * #3 established that roles exist and reach the record; this is the surface for defining one.
 * The plumbing really was done -- `RoleId` was already `string`, `ParticipantSpec.role` already
 * reached the participant, the routing header, the report and `status --json`, and `#join`
 * already announced a seat as "implementer in role X". What was missing was a way to say so.
 *
 * The decisions this pins, both settled deliberately:
 *
 *   A ROLE IS A JOB, not a seat template. `agent` and `model` are defaults the invocation
 *   overrides, because "same job, cheaper model" is the comparison conclave should make cheap
 *   and a role that fixed the model would make its own best use awkward.
 *
 *   RESOLUTION IS ROLE-FIRST, and a name that is both a role and an agent is refused at config
 *   read. `--implementers "claude"` means an agent today and must keep doing so; picking a
 *   winner silently would make one invocation mean two things.
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readProjectConfig, ROLE_DESCRIPTION_MAX } from '../config/project.ts'
import { BUILTIN_ROLES, rolesWithDefined } from '../registry/roles.ts'
import { implementerSeatPlan, roleBriefingForAdvisor, roleBriefingForSeat } from './relay.ts'

const AGENTS = ['claude', 'codex', 'opencode', 'kimi']
const ROLES = {
  frontend: { description: 'front-end UI work; React and Tailwind only, never migrations', model: 'sonnet' },
  backend: { description: 'API handlers and migrations', agent: 'codex' },
}

const plan = (implementers: string, over: Record<string, unknown> = {}) =>
  implementerSeatPlan({
    implementer: 'claude',
    implementers,
    implementerNamed: false,
    roles: ROLES,
    knownAgents: AGENTS,
    ...over,
  })

/** A project whose config is exactly `config`. Returns the root to read from. */
function projectWith(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'conclave-roles-'))
  mkdirSync(join(root, '.conclave'), { recursive: true })
  writeFileSync(join(root, '.conclave', 'config.json'), JSON.stringify(config))
  return root
}

const refusalFrom = (config: unknown): string => {
  try {
    readProjectConfig(projectWith(config))
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('the config was accepted; it should have been refused')
}

test('a named role seats the job, and the invocation still says who does it', () => {
  const p = plan('frontend, backend')
  assert.equal(p.kind, 'listed')
  assert.deepEqual(p.kind === 'listed' ? p.seats : [], [
    // No agent of its own, so the seat is filled by the one the run was already using.
    { agent: 'claude', args: ['--model', 'sonnet'], role: 'frontend' },
    // Its own default agent, and no model, so nothing is added.
    { agent: 'codex', args: [], role: 'backend' },
  ])
})

test("a role's model is a default the seat's own arguments override", () => {
  // The role's `--model` goes first so the entry's wins under the last-wins rule the child
  // CLIs apply. This is the whole reason a role is a job rather than a seat template: trying
  // the same job on a different model must be a flag, not a config edit.
  const p = plan('frontend --model opus-5')
  assert.deepEqual(p.kind === 'listed' ? p.seats[0]!.args : [], ['--model', 'sonnet', '--model', 'opus-5'])
})

test('an agent entry is untouched, and a run naming no list is still the default', () => {
  assert.deepEqual(plan('claude, codex').kind === 'listed' ? (plan('claude, codex') as { seats: unknown[] }).seats : [], [
    { agent: 'claude', args: [] },
    { agent: 'codex', args: [] },
  ])
  // No `role` key at all, which is what keeps the default spec byte-identical.
  assert.equal(plan('').kind, 'default')
})

test('a name that is neither a role nor an agent is refused at startup, naming both', () => {
  const p = plan('frontnd')
  assert.equal(p.kind, 'refused')
  const why = p.kind === 'refused' ? p.reason : ''
  assert.match(why, /neither a defined role nor an agent/)
  // Both sets, because the operator does not know which one they got wrong.
  assert.match(why, /Agents: claude, codex, kimi, opencode/)
  assert.match(why, /Roles defined in \.conclave\/config\.json: backend, frontend/)
})

test('a run that defines no roles is refused exactly as it was before roles existed', () => {
  // Both front-ends pass `knownAgents` only alongside `roles`, so a project with none reaches
  // the registry preflight and its `unknown agent` message, unchanged. An operator who does
  // not use roles must not be told about them for mistyping an agent -- and the default run
  // has to keep paying nothing, which is the rule every part of this feature answers to.
  const p = plan('frontnd', { roles: undefined, knownAgents: undefined })
  assert.equal(p.kind, 'listed')
  assert.deepEqual(p.kind === 'listed' ? p.seats : [], [{ agent: 'frontnd', args: [] }])
})

test('a role named after an agent is refused at config read, not resolved by precedence', () => {
  const why = refusalFrom({ roles: { claude: { description: 'anything' } } })
  assert.match(why, /role 'claude' has the same name as an agent/)
  assert.match(why, /would mean two things/)
})

test('a role with no description is refused, because the description IS the surface', () => {
  assert.match(refusalFrom({ roles: { frontend: {} } }), /description is required/)
  assert.match(refusalFrom({ roles: { frontend: { description: '  ' } } }), /description is required/)
})

test('a description longer than the bound is refused at read, not trimmed at use', () => {
  const why = refusalFrom({ roles: { frontend: { description: 'x'.repeat(ROLE_DESCRIPTION_MAX + 1) } } })
  assert.match(why, /the limit is 400/)
  // Accepted exactly at the bound: an off-by-one here refuses a config that is within it.
  const ok = readProjectConfig(projectWith({ roles: { frontend: { description: 'x'.repeat(ROLE_DESCRIPTION_MAX) } } }))
  assert.equal(ok.roles?.['frontend']?.description.length, ROLE_DESCRIPTION_MAX)
})

test("a role's default agent must be a real agent", () => {
  assert.match(refusalFrom({ roles: { frontend: { description: 'ui', agent: 'clyde' } } }), /is not an agent/)
})

test('defined roles merge over the built-ins, and cannot redefine one', () => {
  const merged = rolesWithDefined({ frontend: { description: 'ui' } })
  assert.equal(merged['frontend']?.description, 'ui')
  // Implementer-shaped: what distinguishes a defined role is the job, not the machinery.
  assert.equal(merged['frontend']?.mutatesWorkspace, true)
  assert.equal(merged['frontend']?.contextPolicy, 'full')
  // The merge refuses to overwrite a built-in even when handed one directly. Unreachable
  // through config -- `validateRoles` refuses that name first -- but this function is exported
  // and the guard is what makes the refusal above a belt rather than the only strap.
  const hijack = rolesWithDefined({ advisor: { description: 'hijacked' } })
  assert.equal(hijack['advisor']?.description, BUILTIN_ROLES['advisor']!.description)
  assert.equal(hijack['advisor']?.contextPolicy, 'thin', 'and it keeps its whole definition')
})

test('a role named after a BUILT-IN role is refused, rather than silently ignored', () => {
  // Silently dropping it is the failure this replaces: the operator writes a definition, the
  // run behaves as though they had not, and nothing anywhere says why.
  const why = refusalFrom({ roles: { advisor: { description: 'my own advisor' } } })
  assert.match(why, /'advisor' is a built-in role and cannot be redefined/)
  assert.match(why, /would change code that never reads this file/)
})

test('the advisor is told about the roles this run has, and nothing when it has none', () => {
  const describe = (r: string) => (ROLES as Record<string, { description: string }>)[r]?.description
  const brief = roleBriefingForAdvisor(
    [
      { id: 'impl1', role: 'frontend' },
      { id: 'impl2', role: 'backend' },
    ],
    describe,
  )
  assert.match(brief, /impl1 \(frontend\) — front-end UI work/)
  assert.match(brief, /impl2 \(backend\) — API handlers/)
  // Addressed by seat id, because that is what every other surface uses.
  assert.match(brief, /addressed by its seat id/)

  // The default run pays nothing: an ordinary implementer has no defined role, so there is no
  // block at all and the briefing is byte-identical to what it was before roles existed.
  assert.equal(roleBriefingForAdvisor([{ id: 'impl1', role: 'implementer' }], describe), '')
  assert.equal(roleBriefingForAdvisor([], describe), '')
})

test('a seat in a named role is told its own job, and an ordinary seat is told nothing extra', () => {
  const brief = roleBriefingForSeat('frontend', ROLES.frontend.description)
  assert.match(brief, /YOUR SEAT HAS A NAMED ROLE: frontend/)
  assert.match(brief, /never migrations/)
  // It narrows the work; it must not read as a change to how the seat is steered.
  assert.match(brief, /does not change how you report or who steers you/)
  assert.equal(roleBriefingForSeat('implementer', undefined), '')
})
