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
      .register(OPENCODE_AGENT)
      .createParticipant({ id: 'implementer', agent: 'opencode', role: 'implementer', args }, { cwd: process.cwd() })
  } finally {
    ;(OpenCodeApiAdapter as unknown as { start: unknown }).start = original
  }
  return captured
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
