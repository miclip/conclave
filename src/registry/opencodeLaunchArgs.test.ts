/**
 * What an OpenCode seat does with launch args, now that its child is a server. #221.
 *
 * The defect this pins was silence rather than incapacity. `launchRecordFor` composes the args
 * and derives a model from them, and the run report states both as the launch configuration.
 * When the transport moved from `opencode run` to `opencode serve`, none of it reached the seat
 * and nothing said so -- a report describing a configuration the run does not have, which is the
 * failure `executables.test.ts` already calls worse than having no check at all.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { OpenCodeApiAdapter } from '../adapters/opencodeApi/adapter.ts'
import { OPENCODE_AGENT } from './builtin.ts'
import { AgentRegistry } from './registry.ts'

/**
 * The options the production `create` handed the adapter, with `start` stubbed so no server is
 * spawned. Patched on the class rather than reimplemented in the test: what is under test is the
 * composition in `builtin.ts`, and a second copy of it here would agree with itself forever.
 */
async function optionsFor(args: string[]): Promise<Record<string, unknown>> {
  const captured: Record<string, unknown> = {}
  const original = OpenCodeApiAdapter.start
  ;(OpenCodeApiAdapter as unknown as { start: unknown }).start = async (o: Record<string, unknown>) => {
    Object.assign(captured, o)
    return {} as never
  }
  try {
    await new AgentRegistry()
      .register(seatable)
      .createParticipant({ id: 'implementer', agent: 'opencode', role: 'implementer', args }, { cwd: process.cwd() })
  } finally {
    ;(OpenCodeApiAdapter as unknown as { start: unknown }).start = original
  }
  return captured
}

/**
 * `OPENCODE_AGENT` with its launch command pointed at a binary that is present everywhere.
 *
 * The registry's #51 preflight refuses to seat an agent whose command is not on PATH, and CI has
 * no `opencode` -- which is right, and is why the live test is gated separately. What is under
 * test here is the COMPOSITION: the real `create`, the real `models`, the real launch-arg
 * resolution. Only the identity of the binary changes, and `start` is stubbed above so nothing is
 * spawned either way. Swapping in a hand-written `create` instead would have tested a copy of
 * `builtin.ts` that agrees with itself forever.
 */
const seatable = {
  ...OPENCODE_AGENT,
  launch: { ...OPENCODE_AGENT.launch, command: process.execPath },
}

/**
 * A model name this machine's OpenCode will accept, because `OPENCODE_MODELS` is graded
 * `enumerated` and refuses one it cannot find. Where OpenCode is absent the list comes back empty
 * and the selection goes unjudged, so any name serves -- which is what CI runs.
 */
function someInstalledModel(): string {
  try {
    const first = execFileSync('opencode', ['models'], { encoding: 'utf8', timeout: 60_000 })
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.includes('/'))
    if (first !== undefined) return first
  } catch {
    // Not installed, or it did not answer. Either way nothing judges the name below.
  }
  return 'anthropic/claude-sonnet-4-5'
}

test('#221 a model in launch args reaches the seat, because the API takes one per prompt', async () => {
  // `--model` used to work by virtue of the child taking it in argv. The API takes it in the
  // prompt body instead, and the operator's spelling has to keep working across that move.
  const model = someInstalledModel()
  const opts = await optionsFor(['--model', model])
  assert.equal(opts['model'], model)
  assert.equal(opts['ignoredArgs'], undefined, 'the model flag and its value are used, not ignored')
})

test('#221 args this transport cannot use are named in a startup notice, not dropped in silence', async () => {
  // The issue itself. A long-lived server takes no per-turn argv, so these have nowhere to go --
  // and the harm worth preventing is nobody being told while the report goes on stating them.
  const opts = await optionsFor(['--some-flag', 'value'])
  assert.deepEqual(opts['ignoredArgs'], ['--some-flag', 'value'])
})

test('#221 a run that sets nothing is told nothing', async () => {
  // The quiet default matters: a notice on every run is a notice nobody reads.
  const opts = await optionsFor([])
  assert.equal(opts['ignoredArgs'], undefined)
  assert.equal(opts['model'], undefined)
})

test('#221 the args reported as undeliverable never include the ones the model came from', async () => {
  // The two lists have to agree. `modelFromArgs` reads `-c model=X` as well as `-m` and
  // `--model`, so a seat that filtered only the latter would use the model AND report it as
  // undeliverable in the same breath -- a self-contradicting notice, worse than staying quiet.
  for (const spelling of [
    ['--model', 'MODEL'],
    ['-m', 'MODEL'],
    ['--model=MODEL'],
    ['-m=MODEL'],
    ['-c', 'model=MODEL'],
  ]) {
    const opts = await optionsFor([...spelling.map((a) => a.replace('MODEL', someInstalledModel())), '--other'])
    assert.deepEqual(opts['ignoredArgs'], ['--other'], `for ${spelling.join(' ')}`)
  }
})

test('#221 a --model with no value after it is undeliverable like anything else', async () => {
  // It selected nothing, so nothing consumed it. Silently swallowing a dangling flag would hide
  // the operator's typo behind the very notice meant to surface it.
  const opts = await optionsFor(['--model'])
  assert.deepEqual(opts['ignoredArgs'], ['--model'])
  assert.equal(opts['model'], undefined)
})

test('#223 a seat configured to ASK is told plainly that it will not', async () => {
  // The dangerous case, and the DEFAULT one: `permissionModeFor` falls back to 'ask', so an
  // operator who configured nothing believes the seat will stop and ask. It will not -- the API
  // seat has not been observed prompting, and `decidePermission` throws if it ever did.
  const opts = await optionsFor([])
  const notices = ((opts['extraNotices'] ?? []) as string[]).join('\n')
  assert.match(notices, /configured to ASK for permission and it will not/)
  assert.match(notices, /#223/)
})

test('#223 a bypassed seat is told the flag never arrived, even though the effect matches', async () => {
  // `--auto` is opencode's bypass flag, and BYPASS_NOTES records that it is the one of the three
  // whose name does not announce what it does. The outcome happens to match the intent; saying
  // so is what stops the next reader concluding the flag works.
  const opts = await optionsFor(['--auto'])
  const notices = ((opts['extraNotices'] ?? []) as string[]).join('\n')
  assert.match(notices, /not deliverable to this seat and is not needed/)
  assert.equal(opts['ignoredArgs'], undefined, 'and it is not ALSO listed as a generic dropped arg')
})

test('#223 the bypass flag is accounted for once, beside genuinely dropped args', async () => {
  const opts = await optionsFor(['--auto', '--some-flag'])
  assert.deepEqual(opts['ignoredArgs'], ['--some-flag'], 'only the ones nothing else explains')
})
