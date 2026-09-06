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
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'

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

/**
 * `in_use` itself, run from the script against real processes (#245).
 *
 * Lifted rather than reimplemented, for the reason the helper above gives: a test that
 * reassembles something resembling the guard tests the resemblance. These are the script's own
 * functions, sourced into `/bin/sh` — which is its shebang, and which matters, because `argv`
 * is special in zsh and an earlier version of this harness silently found nothing.
 */
function inUse(checkout: string, pids: Record<string, number>): Record<string, boolean> {
  const script = `
    eval "$(sed -n '/^in_use() {/,/^}/p;/^resolve() {/,/^}/p;/^conclave_runs() {/,/^}/p' ${SCRIPT})"
    in_use "${checkout}"
  `
  const out = execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' })
  const seen = new Set(out.trim().split('\n').filter(Boolean))
  return Object.fromEntries(Object.entries(pids).map(([k, v]) => [k, seen.has(String(v))]))
}

test('#245 in_use finds a run through ANY symlink into the checkout, and ignores a mention', (t) => {
  // The two failures this replaced, measured together because the fix has to do both:
  //
  //   FALSE POSITIVE — `pgrep -f "$checkout"` matched a shell that merely named the directory.
  //     That refused the v0.5.26 install and left the release half-done.
  //   FAIL OPEN — a run was only ever caught by a second pattern, the path `command -v conclave`
  //     resolves to. Launched through any other path, it matched nothing and the guard reported
  //     the checkout free while a session was live from it. Worse, and silent.
  const root = tempDir(t, 'release-guard')
  const checkout = join(root, 'checkout')
  const other = join(root, 'other')
  mkdirSync(join(checkout, 'bin'), { recursive: true })
  mkdirSync(join(other, 'bin'), { recursive: true })
  mkdirSync(join(root, 'bin'), { recursive: true })
  mkdirSync(join(root, 'elsewhere'), { recursive: true })

  const entry = join(checkout, 'bin', 'conclave.ts')
  writeFileSync(entry, '#!/usr/bin/env node\nsetTimeout(() => {}, 60000)\n')
  // Two DIFFERENT symlinks into the same checkout. The second is the case the old guard missed:
  // it only knew the one `command -v conclave` happened to resolve to.
  symlinkSync(entry, join(root, 'bin', 'conclave'))
  symlinkSync(entry, join(root, 'elsewhere', 'conclave'))

  const spawned: ChildProcess[] = []
  const start = (cmd: string, args: string[]) => {
    const c = spawn(cmd, args, { stdio: 'ignore' })
    spawned.push(c)
    return c.pid!
  }
  try {
    const viaInstall = start(process.execPath, [join(root, 'bin', 'conclave'), 'session', 'probe-a'])
    const viaOther = start(process.execPath, [join(root, 'elsewhere', 'conclave'), 'session', 'probe-b'])
    // A shell that NAMES the checkout and runs nothing from it. This is the shape that blocked
    // the v0.5.26 install: a command checking the install, not a run.
    const mention = start('/bin/sh', ['-c', `sleep 30; echo cd ${checkout} && git describe`])

    // Give the children a moment to appear in `ps` with their full argv.
    execFileSync('/bin/sh', ['-c', 'sleep 1'])

    const seen = inUse(checkout, { viaInstall, viaOther, mention })
    assert.equal(seen['viaInstall'], true, 'a run through the install symlink is in use')
    assert.equal(seen['viaOther'], true, 'and so is one through any other symlink — the fail-open case')
    assert.equal(seen['mention'], false, 'a shell that merely names the checkout is not running from it')

    // And it does not over-match: the same runs are NOT using an unrelated checkout.
    const elsewhere = inUse(other, { viaInstall, viaOther })
    assert.equal(elsewhere['viaInstall'], false, 'a run resolves to ONE checkout, not to any of them')
    assert.equal(elsewhere['viaOther'], false)
  } finally {
    for (const c of spawned) c.kill('SIGKILL')
  }
})
