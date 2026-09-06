/**
 * The liveness warning lives WITH the fifo recipe, because the recipe is what gets copied (#244).
 *
 * The README already said the right thing — liveness comes from `alive` and is never read from
 * the file — in the section about `status`. The detached recipe sat elsewhere, unqualified. An
 * operator copied the recipe, asked `pgrep -f 'conclave session'` whether the run was alive,
 * got a hit three and a half hours after it had ended, and reported a wedge in a run that
 * finished cleanly in 26 minutes.
 *
 * What matches is not the fifo holder — `sleep 86400` contains none of those words — but the
 * caller's own wrapper, since a shell carries its whole script in its command line. So the
 * warning has to say "do not use a process check at all", not "the holder outlives the run":
 * a reader who fixes only the fifo still gets the wrong answer. That distinction is the reason
 * this is pinned rather than left as prose, and it is asserted below.
 *
 * Same shape as #234 and #231: the correct answer was in the document and nothing pointed at it
 * from where the mistake is made.
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const README = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8')

/** The detached-run recipe and everything up to the next heading. */
function recipeSection(): string {
  const at = README.indexOf('sleep 86400 > ctl &')
  assert.notEqual(at, -1, 'the README must still document the fifo recipe')
  const nextHeading = README.indexOf('\n#', at)
  return README.slice(at, nextHeading === -1 ? README.length : nextHeading)
}

test('#244 the fifo recipe warns against deriving liveness from a process check', () => {
  const section = recipeSection()
  assert.match(section, /process check/i, 'the warning must sit with the recipe, not in another section')
  assert.match(section, /pgrep/, 'and name the tool an operator would actually reach for')
  assert.match(section, /\balive\b/, 'and name the field that answers the question')
})

test('#244 the warning is about process checks generally, not about the fifo holder', () => {
  // The correction that matters. `sleep 86400 > ctl` has the command line `sleep 86400` and
  // matches `pgrep -f 'conclave session'` on no system. Blaming the holder would send a reader
  // to fix the recipe and leave them with the same wrong answer, because what actually matches
  // is their own wrapper.
  const section = recipeSection()
  assert.doesNotMatch(
    section,
    /holder outlives|sleep .*outlives|fifo .*outlives the run/i,
    'the fifo holder is not what a process check matches; saying so would misdirect the fix (#244)',
  )
  assert.match(section, /shell, watcher or tool invocation|command line contains/i, 'it names what does match')
})

test('#244 the documented liveness command reads fields status --json actually emits', () => {
  // A snippet nobody runs is a claim nobody checked, and asserting only that the README MENTIONS
  // these names would be the same mistake one layer up. So the fields are taken from the README
  // and resolved against a real status document.
  //
  // WHAT THIS CANNOT CATCH, stated because the first version of this comment claimed otherwise:
  // `status --json` reads the last RECORDED document, which an older build may have written. A
  // field the current code has stopped writing still resolves here. That half — that a freshly
  // written record carries them — is asserted in `workspace/runProgress.test.ts`, where a record
  // can be produced on demand. This half catches a rename in the READER, which is where `alive`
  // and `abandoned` are added.
  const section = recipeSection()
  const fields = ['.state', '.alive', '.progress.state']
  for (const field of fields) assert.ok(section.includes(field), `the example must read ${field}`)

  const cli = join(import.meta.dirname, '..', '..', 'bin', 'conclave.ts')
  const r = spawnSync(process.execPath, [cli, 'status', '--json'], { encoding: 'utf8', timeout: 60_000 })
  // No session recorded in this checkout is not a failure — it is a machine that cannot answer.
  // `status --json` still emits a parseable document there (#233), but one with no `progress`.
  if (r.status !== 0) return
  const doc = JSON.parse(r.stdout) as Record<string, unknown>

  for (const field of fields) {
    const path = field.slice(1).split('.')
    let cur: unknown = doc
    for (const key of path) cur = (cur as Record<string, unknown> | undefined)?.[key]
    assert.notEqual(
      cur,
      undefined,
      `the README tells an operator to read ${field}, and status --json does not emit it (#244)`,
    )
  }
})
