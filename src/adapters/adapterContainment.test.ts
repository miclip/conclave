/**
 * Every test file that boots an adapter contains the run directories it makes (#211).
 *
 * An adapter takes a `mkdtemp` under `os.tmpdir()` at boot. Since #203 it gives that back on
 * close, which covers the ordinary path and not the two that matter here: a boot that throws
 * before anything can call close, and the run that deliberately KEEPS its directory because its
 * attempts journal was named to the operator.
 *
 * So a file that boots an adapter and forgets `containAdapterRunDirs()` scatters `orch-*`
 * directories into the developer's real `$TMPDIR`, and NOTHING NOTICES: the file compiles, its
 * tests pass, and the only evidence is a temp root that grows. #195 removed 154 call sites of
 * that hazard; #211 is the fourteen copies of a smaller one it left behind, and this is the
 * check that stops a fifteenth being written.
 *
 * A TEXT PIN, deliberately. The alternative -- counting directories before and after the suite --
 * measures the machine rather than the file, and cannot say WHICH file forgot.
 */

import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const SRC = join(import.meta.dirname, '..')

/** Every `.test.ts` under `src/`, by path. */
function testFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...testFiles(p))
    else if (entry.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/**
 * What counts as taking a run directory.
 *
 * THE THREE THAT `mkdtemp`, established by counting rather than by memory: `claude.ts`,
 * `codex.ts` and `kimi.ts` each do; `opencodeApi/adapter.ts` and its `server.ts` do not, because
 * that transport's child is a server with no per-session scratch. A file that boots only an
 * OpenCode seat has nothing to contain, and demanding containment there would be noise -- and a
 * check that cries wolf is a check somebody deletes.
 *
 * `createParticipant` is deliberately NOT here. It boots whichever adapter the spec names, and
 * the tests that use it mostly hand it a stub, so matching on it flagged nine files that cannot
 * leak. The narrower rule is the honest one: name the constructor that takes the directory.
 */
const BOOTS = [/ClaudePtyHookAdapter\.start\(/, /CodexPtyHookAdapter\.start\(/, /KimiPrintAdapter\.start\(/]

test('#211 a test file that boots an adapter contains the run directories it makes', () => {
  const offenders: string[] = []
  let checked = 0
  for (const path of testFiles(SRC)) {
    const src = readFileSync(path, 'utf8')
    // The live tests are gated on an env var and do not run in the ordinary suite, but they boot
    // real adapters when they DO run, so they are held to the same rule.
    if (!BOOTS.some((re) => re.test(src))) continue
    checked++
    if (!/containAdapterRunDirs\(/.test(src)) offenders.push(path.slice(SRC.length + 1))
  }
  assert.ok(checked > 0, 'the boot patterns matched nothing, so this test proves nothing')
  assert.deepEqual(
    offenders,
    [],
    `these files boot an adapter without containing its run directory -- add ` +
      `\`containAdapterRunDirs()\` at module scope (see src/testkit/tempDir.ts):\n  ${offenders.join('\n  ')}`,
  )
})

test('#211 the containment helper is the only place TMPDIR is redirected for adapters', () => {
  // The two lines were copied fourteen times; a fifteenth copy would drift from the helper and
  // the check above would still pass, because it only asks whether containment happened. This
  // asks that it happened THE ONE WAY, so the rationale lives in one comment rather than
  // fourteen that can disagree.
  const offenders: string[] = []
  for (const path of testFiles(SRC)) {
    const src = readFileSync(path, 'utf8')
    if (path.endsWith('tempDir.test.ts')) continue // it tests TMPDIR handling itself
    if (/process\.env\['TMPDIR'\]\s*=/.test(src) || /process\.env\.TMPDIR\s*=/.test(src)) {
      offenders.push(path.slice(SRC.length + 1))
    }
  }
  assert.deepEqual(offenders, [], `redirect TMPDIR through containAdapterRunDirs():\n  ${offenders.join('\n  ')}`)
})
