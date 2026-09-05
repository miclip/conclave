/**
 * The pattern `scripts/release.sh` uses to find a run in flight (#230).
 *
 * The guard exists because "a run in flight owns a branch this tag would collide with, and its
 * participants are writing to the tree being tagged". It used to match `conclave.ts session`,
 * which is how a run is started FROM A CHECKOUT and not how anyone starts one: the installed CLI
 * is a symlink, and the symlink's own path is what lands in argv.
 *
 *     node /Users/x/.local/bin/conclave session --advisor codex ...
 *
 * So `pgrep -f "conclave.ts session"` returned nothing while three such runs were live, and both
 * guards -- the tag one and the install one -- would have let all three through. Observed while
 * cutting v0.5.22, which is why this is pinned rather than argued.
 *
 * Tested as the pattern rather than through the script: what went wrong was a regex, the shell
 * around it is one `awk`, and a test that spawned real sessions to check a string would be slower
 * and less certain about which case it had covered.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'release.sh')

/**
 * The whole awk program the script runs, lifted from it so the two cannot drift.
 *
 * The program INCLUDING its action, not just the condition: an earlier version of this helper
 * captured the condition and appended its own `{ print $1 }`, which ran the print twice and
 * reported every pid as two. The lesson is the one this file is about -- take what the script
 * actually runs rather than reassembling something that resembles it.
 */
function programFromScript(): string {
  const src = readFileSync(SCRIPT, 'utf8')
  const m = /awk '(\$0 ~ .*?)'/.exec(src)
  assert.ok(m, 'release.sh must still select runs with an awk program')
  return m[1]!
}

/** Which of these `ps` lines the guard would report as a live run. */
function matches(lines: string[]): string[] {
  const out = execFileSync('awk', [programFromScript()], {
    input: lines.join('\n') + '\n',
    encoding: 'utf8',
  })
  return out.trim().split('\n').filter(Boolean)
}

test('#230 a run started through the installed CLI is seen', () => {
  // The exact argv observed while cutting v0.5.22, which the old pattern missed entirely.
  assert.deepEqual(
    matches(['24629 node /Users/x/.local/bin/conclave session --advisor codex --implementer claude']),
    ['24629'],
  )
})

test('#230 a run started from a checkout is still seen', () => {
  // What the old pattern DID match. Widening must not trade one blindness for another.
  assert.deepEqual(matches(['31 node /repo/bin/conclave.ts session --checks "npm test"']), ['31'])
  assert.deepEqual(matches(['32 node /repo/bin/conclave.ts relay "goal"']), ['32'])
})

test('#230 a shell that NAMES the command is not a run', () => {
  // What the leading slash actually discriminates, measured rather than assumed: a real run
  // carries a resolved path because the shebang resolves before exec, so a launcher naming the
  // command it is about to start is not one. Counting it would refuse a release for a shell,
  // and the run it starts shows up as its own process a moment later.
  //
  // The first version of this test asserted the slash prevented a shell that QUOTED the pattern
  // from matching. That was wrong -- such a line does not match either way -- and the mutation
  // dropping the slash survived because of it.
  assert.deepEqual(matches(['71 /bin/sh -c conclave session --advisor codex']), [])
  assert.deepEqual(matches(['72 /bin/zsh -c "conclave relay \\"goal\\""']), [])
  assert.deepEqual(matches(['73 /bin/sh scripts/release.sh 0.5.22']), [])
})

test('#230 other conclave commands are not runs', () => {
  // Only `session` and `relay` own a branch and write to the tree. Tagging while someone reads
  // `status` is fine, and refusing it would make the guard something people work around.
  assert.deepEqual(matches(['51 node /Users/x/.local/bin/conclave status --json']), [])
  assert.deepEqual(matches(['52 node /Users/x/.local/bin/conclave guard']), [])
  assert.deepEqual(matches(['53 node /Users/x/.local/bin/conclave notify tell "hi"']), [])
})

test('#230 the guard still discriminates', () => {
  // The canary. A pattern that matched everything would pass every test above by accident.
  assert.deepEqual(matches(['61 node /usr/bin/something-else --unrelated']), [])
  assert.deepEqual(matches(['62 vim scripts/release.sh']), [])
})
