/**
 * Registration, participant construction, role assignment and input policy must be
 * data-driven, because layered configuration will eventually supply all four.
 *
 * The test that matters most is that adding an adapter is a REGISTRATION and not an
 * edit to the code that constructs participants. If the second adapter required
 * touching the first adapter's call sites, the seam would not be a seam.
 *
 *   node --test src/registry/registry.test.ts
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { AgentRegistry } from './registry.ts'
import { defaultRegistry, CLAUDE_AGENT, CODEX_AGENT } from './builtin.ts'
import { BUILTIN_ROLES, resolveRole } from './roles.ts'
import type { AgentDefinition, ParticipantSpec } from './types.ts'

const spec = (over: Partial<ParticipantSpec> = {}): ParticipantSpec => ({
  id: 'impl',
  agent: 'claude',
  role: 'implementer',
  ...over,
})

test('the default registry lists both agents but only one is constructible', () => {
  const r = defaultRegistry()
  assert.deepEqual(r.list().map((a) => a.id).sort(), ['claude', 'codex'])
  assert.deepEqual(r.listAvailable().map((a) => a.id), ['claude'])
})

test('an agent without an adapter is described, not hidden', () => {
  // Registering Codex without `create` keeps its lower confidence visible. Omitting it
  // entirely would make it look finished by absence.
  const r = defaultRegistry()
  const codex = r.get('codex')
  assert.equal(codex.create, undefined)
  assert.ok(codex.unavailableReason?.includes('unverified'))
  assert.ok(codex.capabilities, 'it must still be conformance-gradeable')
  assert.ok(codex.launch.deploymentState?.length, 'its deployment preconditions are recorded')
})

test('constructing an unavailable agent explains why rather than failing obscurely', async () => {
  const r = defaultRegistry()
  await assert.rejects(
    () => r.createParticipant(spec({ agent: 'codex' }), { cwd: '/tmp' }),
    /no adapter yet.*unverified/s,
  )
})

test('an unknown agent names the ones that exist', () => {
  const r = defaultRegistry()
  assert.throws(() => r.resolve(spec({ agent: 'gemini' })), /unknown agent 'gemini'.*claude, codex/s)
})

test('an unknown role names the ones that exist', () => {
  const r = defaultRegistry()
  assert.throws(() => r.resolve(spec({ role: 'reviewr' })), /unknown role 'reviewr'.*advisor/s)
})

test('input policy comes from the role and is overridable per participant', () => {
  const r = defaultRegistry()

  const fromRole = r.resolve(spec())
  assert.equal(fromRole.inputOwnership, 'mediated')
  assert.equal(fromRole.guarantees.cancellationAttributable, true)

  // The §5a escape hatch is a per-participant decision, and taking it visibly reduces
  // what the adapter is allowed to claim.
  const overridden = r.resolve(spec({ inputOwnership: 'external' }))
  assert.equal(overridden.inputOwnership, 'external')
  assert.equal(overridden.guarantees.cancellationAttributable, false)
  assert.ok(overridden.guarantees.unmatchedTurnsResolveAs.includes('unknown_abnormal_end'))
})

test('roles carry the context policy the design depends on', () => {
  // The brief's claim is that context isolation is half the benefit. Declaring it is not
  // enforcing it -- there is no context-budgeting machinery yet -- but the intent has to
  // live somewhere configuration can read.
  assert.equal(resolveRole('implementer').contextPolicy, 'full')
  assert.equal(resolveRole('advisor').contextPolicy, 'thin')
  assert.equal(resolveRole('implementer').mutatesWorkspace, true)
  assert.equal(resolveRole('advisor').mutatesWorkspace, false)
})

test('the arbiter seat cannot be filled by a model', () => {
  // Any disagreement resolvable by running something should be resolved that way. A
  // model in that seat would defeat the purpose.
  const r = defaultRegistry()
  assert.equal(BUILTIN_ROLES.arbiter!.isModel, false)
  assert.throws(() => r.resolve(spec({ role: 'arbiter' })), /not a model seat/)
})

test('a new adapter arrives by registration alone', () => {
  // The point of the seam: no call site changes to add an agent.
  const fake: AgentDefinition = {
    id: 'local-critic',
    displayName: 'Local open-weights critic',
    capabilities: { ...CODEX_AGENT.capabilities, agent: 'local-critic' },
    launch: { command: 'llama', baseArgs: [] },
    async create() {
      return { agent: 'local-critic' } as any
    },
  }
  const r = defaultRegistry().register(fake)
  assert.equal(r.listAvailable().length, 2)
  assert.equal(r.resolve(spec({ agent: 'local-critic', role: 'advisor' })).agent.id, 'local-critic')
})

test('roles are extensible too', () => {
  const r = new AgentRegistry().register(CLAUDE_AGENT).registerRole({
    id: 'red-team',
    displayName: 'Red team',
    description: 'Adversarial critique only.',
    contextPolicy: 'thin',
    mutatesWorkspace: false,
    defaultInputOwnership: 'mediated',
    isModel: true,
  })
  assert.equal(r.resolve(spec({ role: 'red-team' })).role.contextPolicy, 'thin')
})

test('registering the same agent twice is an error, not a silent replacement', () => {
  const r = defaultRegistry()
  assert.throws(() => r.register(CLAUDE_AGENT), /already registered/)
})

test('resolve() validates without launching anything', () => {
  // Configuration will want every problem in a file reported before any child starts.
  const r = defaultRegistry()
  const resolved = r.resolve(spec({ args: ['--permission-mode', 'default'] }))
  assert.equal(resolved.spec.args?.[0], '--permission-mode')
  assert.equal(resolved.agent.launch.command, 'claude')
})

test('codex launch flags carry the reason each one exists', () => {
  // A bare flag list rots into cargo cult. During spike 1 an unsuppressed update dialog
  // consumed a prompt and ran `npm install -g @openai/codex`.
  const suppresses = CODEX_AGENT.launch.suppresses!
  assert.ok(suppresses['check_for_update_on_startup']?.includes('npm install'))
  assert.ok(suppresses['disable_paste_burst']?.includes('swallow the submit'))
  for (const key of Object.keys(suppresses)) {
    assert.ok(
      CODEX_AGENT.launch.baseArgs.some((a) => a.includes(key)),
      `${key} is documented but not actually passed`,
    )
  }
})
