/**
 * The TUI markers are quoted literals belonging to OTHER programs, checked against them (#239).
 *
 * `kittyKeyboard` was `ESC[>7u` and neither CLI has ever sent it — both emit `ESC[>5u`. Nothing
 * referenced the constant from a test, so it was wrong from the day it was written and the suite
 * stayed green: `isInteractive` is an OR over three markers, and the other two carried the vote.
 * A dead branch of an OR costs nothing until the OR narrows, at which point the failure reads as
 * "interactivity detection broke" rather than as a constant nobody checked.
 *
 * This is the `hookEventNames.test.ts` situation with one difference — that one has a guard.
 *
 * Spawning a real CLI costs no quota: the TUI is brought up, its startup bytes are read, and it
 * is killed before a turn is ever sent. It needs the binary, so it returns honestly where there
 * is none, which is every CI runner. Like the Codex rollout guard in #242, it protects a
 * developer machine rather than the pipeline.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { DECISIVE_TUI_MARKERS, PtyProcess, TUI_MARKERS } from './pty.ts'
import { sanitizedCopy } from './childenv.ts'
import { findExecutable } from '../registry/executables.ts'

/**
 * Startup bytes from a real CLI AND the markers the pty recorded, or undefined when it is not
 * installed.
 *
 * Both, because they check different things and only one of them was checked at first. The text
 * says what the program emitted; `markers` says what `PtyProcess`'s own scan made of it. A test
 * that read only the text passed with the scan unable to handle a pattern at all — the marker
 * was correct and nothing recorded it.
 */
async function startupOf(cli: string): Promise<{ seen: string; markers: string[] } | undefined> {
  if (!findExecutable(cli, { cwd: process.cwd() })) return undefined
  let seen = ''
  const pty = await PtyProcess.spawn({
    file: cli,
    args: [],
    cwd: process.cwd(),
    env: sanitizedCopy(process.env as Record<string, string>, {}),
  })
  pty.on('data', (c: string) => {
    seen += c
  })
  try {
    // Long enough for the TUI to finish negotiating. The markers are sent in the first frames;
    // this is slack, not a measurement.
    await pty.waitForOutput((s) => DECISIVE_TUI_MARKERS.every((m) => matches(m, s)), 20_000)
    return { seen, markers: pty.markers }
  } finally {
    await pty.terminate({ graceMs: 1_500, killAfterMs: 1_500 }).catch(() => {})
  }
}

function matches(name: string, text: string): boolean {
  const seq = TUI_MARKERS[name]!
  return typeof seq === 'string' ? text.includes(seq) : seq.test(text)
}

for (const cli of ['claude', 'codex']) {
  test(`#239 every decisive TUI marker is one ${cli} actually emits`, async () => {
    const got = await startupOf(cli)
    if (got === undefined) return

    // EVERY decisive marker, not any. `isInteractive` is an OR, so asserting the OR would pass
    // with two of three dead — which is exactly the state this issue found and the reason the
    // constant went unchecked for as long as it did.
    for (const name of DECISIVE_TUI_MARKERS) {
      assert.ok(
        matches(name, got.seen),
        `${cli} never emitted the ${name} marker (${String(TUI_MARKERS[name])}). ` +
          `isInteractive votes on it, so it is now a dead branch of that OR (#239).`,
      )
      // And the pty RECORDED it. The line above is about the program; this one is about the
      // scan, and a marker the scan cannot match is dead however correctly it is declared.
      assert.ok(
        got.markers.includes(name),
        `${cli} emitted the ${name} marker and PtyProcess did not record it: the scan cannot ` +
          `match how it is declared (#239). Recorded: ${JSON.stringify(got.markers)}`,
      )
    }
  })
}

test('#239 the kitty marker matches the flags both CLIs send, and any other flags', () => {
  // Pinned as a PATTERN rather than a value. The number is a bitmask and both CLIs currently ask
  // for 5; the previous constant asked for 7 and matched nothing. What is decisive is that the
  // protocol was negotiated, so a different bitmask must still count.
  const kitty = TUI_MARKERS['kittyKeyboard']!
  assert.ok(kitty instanceof RegExp, 'a bitmask is not a literal')
  assert.ok(kitty.test('\x1b[>5u'), 'what both CLIs send today')
  assert.ok(kitty.test('\x1b[>7u'), 'and what the constant used to claim they sent')
  assert.ok(kitty.test('\x1b[>1;2u'), 'and a multi-parameter form')
  // Not so loose that it matches an unrelated CSI. `CSI Ps u` without `>` is a cursor restore.
  assert.equal(kitty.test('\x1b[5u'), false, 'a cursor restore is not a keyboard negotiation')
  assert.equal(kitty.test('\x1b[>5m'), false, 'and neither is another CSI with a > prefix')
})
