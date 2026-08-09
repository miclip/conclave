/**
 * What the picker does with the arrow keys, and what it does when nothing is picked.
 *
 * Driven through fake streams rather than a pty: a pty proves the escape sequences land on
 * the right rows, which `session.tty.test.ts` already does. What is under test here is
 * selection state, and a pty would only make the same assertions slower and flakier.
 */

import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import type { Suggestion } from './complete.ts'
import { Screen } from './screen.ts'

const ESC = '\x1b['
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

async function harness(suggestion?: Suggestion, pending?: () => string[]) {
  const input = new PassThrough()
  const written: string[] = []
  const output = Object.assign(new PassThrough(), {
    rows: 24,
    columns: 80,
    isTTY: false,
    write: (chunk: string) => (written.push(chunk), true),
  })
  const lines: string[] = []
  const screen = new Screen({
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    onLine: (l) => lines.push(l),
    onInterrupt: () => {},
    status: () => '',
    hint: () => 'hint',
    prompt: () => '› ',
    ...(suggestion ? { suggest: () => suggestion } : {}),
    ...(pending ? { pending } : {}),
  })
  await screen.open()

  return {
    screen,
    lines,
    press: (name: string, ch?: string) => input.emit('keypress', ch, { name, sequence: ch ?? '' }),
    type: (text: string) => {
      for (const ch of text) input.emit('keypress', ch, { name: ch, sequence: ch })
    },
    /** Everything drawn below the input rule in the most recent frame. */
    menuRow: () => {
      const frame = written.at(-1) ?? ''
      // The last rule drawn is the one under the input; the menu follows it.
      const at = frame.lastIndexOf('───')
      return at < 0 ? '' : strip(frame.slice(at))
    },
    /** Everything written since the harness was made, escape codes intact. */
    raw: () => written.join(''),
    /** Which item is reverse-videoed, if any. */
    selected: () => /\x1b\[7m ([^\x1b]+) \x1b\[0m/.exec(written.at(-1) ?? '')?.[1],
    /** Change the terminal height and emit a resize event. */
    resize: (rows: number) => {
      output.rows = rows
      output.emit('resize')
    },
  }
}

const PARTICIPANTS: Suggestion = {
  items: ['>advisor', '>implementer', '>both'],
  start: 0,
  end: 1,
  suffix: ' ',
  note: 'plain text reaches both',
}

test('the menu opens with nothing selected', async () => {
  // Pre-selecting would mean the menu had already chosen on the operator's behalf, and for
  // participants that choice is wrong: no prefix at all reaches both.
  const h = await harness(PARTICIPANTS)
  h.type('>')
  assert.equal(h.selected(), undefined)
  assert.match(h.menuRow(), />advisor.*>implementer.*>both/)
})

test('right moves through the candidates in the order they are shown', async () => {
  const h = await harness(PARTICIPANTS)
  h.type('>')
  h.press('right')
  assert.equal(h.selected(), '>advisor')
  h.press('right')
  assert.equal(h.selected(), '>implementer')
  h.press('right')
  assert.equal(h.selected(), '>both')
  h.press('right')
  assert.equal(h.selected(), '>advisor', 'and wraps rather than stopping')
})

test('left from nothing selected lands on the last, not the first', async () => {
  const h = await harness(PARTICIPANTS)
  h.type('>')
  h.press('left')
  assert.equal(h.selected(), '>both')
})

test('up and down still work, because a menu is not the place to be strict', async () => {
  const h = await harness(PARTICIPANTS)
  h.type('>')
  h.press('down')
  assert.equal(h.selected(), '>advisor')
  h.press('up')
  assert.equal(h.selected(), '>both')
})

test('enter with nothing selected submits the line rather than picking', async () => {
  // This is what keeps the default reachable: `both` is what you get by typing nothing, so
  // getting it must not require dismissing the menu first.
  const h = await harness(PARTICIPANTS)
  h.type('hello')
  h.press('return')
  assert.deepEqual(h.lines, ['hello'])
})

test('enter with something selected accepts it and does not submit', async () => {
  const h = await harness(PARTICIPANTS)
  h.type('>')
  h.press('right')
  h.press('return')
  assert.deepEqual(h.lines, [], 'a picker you cannot leave without submitting is a trap')
  assert.equal(h.screen.line, '>advisor ')
})

test('tab accepts the first candidate even with nothing selected', async () => {
  // Tab has always meant "complete the obvious one"; requiring an arrow first would make
  // the menu slower than the completer it replaced.
  const h = await harness(PARTICIPANTS)
  h.type('>')
  h.press('tab')
  assert.equal(h.screen.line, '>advisor ')
})

test('escape dismisses, and then the arrows belong to the line again', async () => {
  const h = await harness(PARTICIPANTS)
  h.type('>')
  h.press('escape')
  assert.equal(h.selected(), undefined)
  assert.match(h.menuRow(), /hint/)
})

test('the note says how to reach both without picking anything', async () => {
  const h = await harness(PARTICIPANTS)
  h.type('>')
  assert.match(h.menuRow(), /plain text reaches both/)
})


test('pending messages are pinned above the box, dim and italic', async () => {
  // Both attributes, because a terminal that drops one usually keeps the other, and this is
  // the difference between "said" and "not yet said".
  let queue = ['→ advisor  check the error path']
  const h = await harness(undefined, () => queue)
  h.screen.draw()
  const frame = h.raw()
  assert.match(frame, /check the error path/)
  assert.match(frame, /\x1b\[2;3m {2}→ advisor {2}check the error path/)
})

test('the box grows and shrinks with the queue rather than reserving rows for nothing', async () => {
  let queue: string[] = []
  const h = await harness(undefined, () => queue)
  const region = () => {
    const all = [...h.raw().matchAll(/\x1b\[1;(\d+)r/g)]
    return Number(all.at(-1)?.[1])
  }
  h.screen.draw()
  const empty = region()
  queue = ['→ advisor  one', '→ implementer  two']
  h.screen.draw()
  assert.equal(region(), empty - 2, 'two queued messages cost exactly two rows')
  queue = []
  h.screen.draw()
  assert.equal(region(), empty, 'and the rows come back when the queue drains')
})

test('a long queue stops at a fixed height and says how much it is hiding', async () => {
  // An unbounded box would eat the transcript it exists to annotate.
  const h = await harness(undefined, () => ['a', 'b', 'c', 'd', 'e'])
  h.screen.draw()
  assert.match(h.raw(), /3 more queued — \/queue/)
})


test('every command is reachable, wrapping rather than silently truncating', async () => {
  // A fixed cap of eight hid `/exit` — the tenth command, and the one an operator most
  // needs to find. The bug was not that two were missing; it was that nothing said so.
  const commands = ['/pause', '/continue', '/rotate', '/abort', '/state', '/log', '/queue', '/audit', '/help', '/exit']
  const h = await harness({ items: commands, start: 0, end: 1, suffix: ' ' })
  h.type('/')
  const shown = h.menuRow()
  for (const c of commands) assert.match(shown, new RegExp(c.replace('/', '\\/')), `${c} should be listed`)
})

test('a list too long even to wrap says how many it is hiding', async () => {
  const many = Array.from({ length: 80 }, (_, i) => `@file-${i}.ts`)
  const h = await harness({ items: many, start: 0, end: 1, suffix: ' ' })
  h.type('@')
  assert.match(h.menuRow(), /\+\d+ more/)
})

test('resize resets the scroll region and redraws the pinned box', async () => {
  const h = await harness()
  h.screen.draw()
  const initial = h.raw().match(/\x1b\[1;(\d+)r/)
  assert.ok(initial, 'initial scroll region should be set')
  assert.equal(Number(initial[1]), 20, 'initial region ends at the last scrolling row')

  h.resize(30)
  const resized = h.raw().match(/\x1b\[1;(\d+)r/g)
  assert.ok(resized, 'resized scroll region should be set')
  const last = resized.at(-1)
  assert.equal(Number(last?.match(/\x1b\[1;(\d+)r/)?.[1]), 26, 'resized region ends at the new last scrolling row')

  // The box is redrawn after the resize, and redrawn UNDER THE CONTENT rather than at the new
  // floor. A terminal that grew by six rows did not move the transcript, so the box does not
  // move either — it goes on descending from where it was, and reaches the floor when the
  // output does. Asserting a row here would re-fix the box to the bottom of the terminal,
  // which is the arrangement two operators reported as a jump.
  const frame = h.raw().slice(h.raw().lastIndexOf('\x1b[1;26r'))
  assert.match(frame, /\x1b\[21;1H/, 'the box should be redrawn at its current top, not at the floor')
  assert.match(frame, /›/)
  // Everything below it is cleared, so the box does not leave a copy behind as it descends.
  assert.match(frame, /\x1b\[25;1H\x1b\[0J/)
})

/**
 * A terminal that answers the cursor query, one that answers it in pieces, and one that
 * never answers at all.
 *
 * These three paths decide where the box starts, and until now none of them had a test. The
 * default harness gives the console a non-TTY input, which skips the query entirely — so
 * every existing test in this file exercised the same branch, and the branch that runs on a
 * real terminal ran only on real terminals.
 *
 * That matters more since the box began descending from the cursor rather than sitting at
 * the floor: the reply is now the difference between a console that starts where it was
 * launched and one that starts at the bottom of the screen.
 */
async function ttyHarness(reply?: (write: (s: string) => void) => void) {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => {},
  })
  // The console attaches a keypress listener, a data listener for the reply, and a resize
  // listener; several harnesses in one process otherwise trip Node's leak warning, which is
  // noise here rather than a signal.
  input.setMaxListeners(50)
  const written: string[] = []
  const output = Object.assign(new PassThrough(), {
    rows: 24,
    columns: 80,
    isTTY: true,
    write: (chunk: string) => {
      written.push(chunk)
      // Answer as a terminal would: only once the query has actually been written, so the
      // test cannot pass by replying to a query that was never sent.
      if (chunk.includes(`${ESC}6n`) && reply) {
        const r = reply
        reply = undefined
        setImmediate(() => r((s) => input.emit('data', Buffer.from(s))))
      }
      return true
    },
  })
  const lines: string[] = []
  const screen = new Screen({
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    onLine: (l) => lines.push(l),
    onInterrupt: () => {},
    status: () => '',
    hint: () => 'hint',
    prompt: () => '› ',
  })
  await screen.open()
  return {
    screen,
    lines,
    raw: () => written.join(''),
    /** The most recent redraw. `draw()` emits one write, so the last one is a whole frame. */
    frame: () => written.at(-1) ?? '',
  }
}

test('the box starts under the cursor the terminal reports', async () => {
  const h = await ttyHarness((write) => write(`${ESC}8;1R`))
  // Reported row 8, so the box begins on row 9 — directly under the setup messages, with
  // the operator's own scrollback above it untouched.
  assert.match(h.raw(), /\x1b\[9;1H/, 'the box should start on the row below the cursor')
  assert.doesNotMatch(h.raw(), /\x1b\[\d*T/, 'nothing on screen should be scrolled to meet it')
})

test('a cursor reply split across reads is still understood', async () => {
  // Terminals are under no obligation to deliver the reply in one read, and a console that
  // assumed they did would fall back to the anchored box on whichever machine happened to
  // split it. Worth a test precisely because it would be intermittent and blamed elsewhere.
  const h = await ttyHarness((write) => {
    write(`${ESC}8`)
    write(';1')
    write('R')
  })
  assert.match(h.raw(), /\x1b\[9;1H/, 'the reassembled reply should place the box at row 9')
})

test('a terminal that never answers gets the anchored box rather than a hang', async () => {
  // No reply at all. `open()` resolves on its own timeout — the assertion is that it
  // resolves and that the fallback is the fully-anchored arrangement, which is the one
  // layout known to be safe on a terminal nothing is known about.
  const h = await ttyHarness()
  // 24 rows, a 4-row box: the floor is 20 and the box begins at 21.
  assert.match(h.raw(), /\x1b\[1;20r/, 'the region should end at the floor')
  assert.match(h.raw(), /\x1b\[21;1H/, 'the box should be drawn at the floor')
  assert.doesNotMatch(h.raw(), /\x1b\[\d*T/, 'and still nothing should be scrolled')
})

test('keystrokes typed before the terminal answers are not swallowed', async () => {
  // The query is written and then awaited; anything typed in that window arrives on the same
  // stream as the reply and is consumed with it. It has to be given back, or the first thing
  // an operator types into a slow terminal disappears.
  const h = await ttyHarness((write) => write(`ab${ESC}8;1Rc\r`))
  assert.deepEqual(h.lines, ['abc'], 'the typed line should survive the cursor query')
})

/**
 * Where the descending box lands is decided by counting the rows the transcript just took,
 * and that count was `String.length` — the wrong unit for anything but ASCII.
 *
 * Both of these go wrong in the same place and in opposite directions, which is why they
 * are tested together: CJK under-counts the rows and puts the box on top of the last line
 * of text, combining marks over-count them and leave a blank gap above the box.
 *
 * The assertion is on the FIRST row each frame addresses, which is the top of the box. The
 * rows after it are the box's own three, so matching those proves nothing.
 */
test('wrapped wide text leaves the box below the last row it rendered', async () => {
  const h = await ttyHarness((write) => write(`${ESC}8;1R`))
  // 60 ideographs at two columns each is 120 columns, which wraps to two rows in an
  // 80-column terminal: text on rows 9 and 10, so the box opens on 11. Counted as 60
  // characters it is one row, and the box opens on 10 — erasing the second half of the
  // sentence to draw its top rule there.
  h.screen.write('\u754c'.repeat(60))
  assert.match(
    h.frame(),
    /^\x1b\[s\x1b\[11;1H/,
    'the box should open below both rendered rows, not on the second one',
  )
})

test('combining marks do not push the box down a row they never used', async () => {
  const h = await ttyHarness((write) => write(`${ESC}8;1R`))
  // `e` + U+0301, seventy-nine times: 158 UTF-16 units, 79 columns, one row. Written as a
  // decomposed sequence deliberately — the precomposed U+00E9 is one unit and would pass
  // under the bug this is here to catch.
  h.screen.write('e\u0301'.repeat(79))
  assert.match(
    h.frame(),
    /^\x1b\[s\x1b\[10;1H/,
    'one row of text, so the box opens on the next — not a row lower with a gap above it',
  )
})
