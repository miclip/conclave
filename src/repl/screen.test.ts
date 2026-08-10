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
import { displayWidth } from './width.ts'

const ESC = '\x1b['
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

async function harness(suggestion?: Suggestion, pending?: () => string[], seats?: () => string[]) {
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
    ...(seats ? { seats } : {}),
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
    /** The most recent frame alone: one `draw()`, so its rows and its cursor agree. */
    frame: () => written.at(-1) ?? '',
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

test('every busy seat gets a row of its own, above the queue', async () => {
  // The alternative — several seats inlaid into the one status rule — is a line that has to
  // fit the terminal, and four seats do not. A wrapped rule takes a row the box never
  // reserved, which lands on the transcript.
  let busy = ['seat-alpha 12s  t-3 · rebuild the parser', 'seat-beta 4s  t-4 · rewrite the docs']
  const h = await harness(undefined, () => ['→ advisor  a queued line'], () => busy)
  h.screen.draw()
  const frame = h.raw()
  assert.match(frame, /seat-alpha 12s {2}t-3 · rebuild the parser/)
  assert.match(frame, /seat-beta 4s {2}t-4 · rewrite the docs/)
  // Above the queue, not below it: the queue sits directly on the box because it is about
  // what was just typed, and the seats are the ambient state behind it.
  const at = (s: string) => strip(h.raw()).indexOf(s)
  assert.ok(at('seat-alpha') < at('a queued line'), 'seat rows belong above the pending queue')

  // And the cursor still lands on the input row, which every seat row above it pushes down.
  // Miscounting here does not misplace a row — it puts the operator's typing on top of one,
  // and the box looks right until somebody types.
  const last = h.frame()
  const promptRow = [...last.matchAll(/\x1b\[(\d+);1H\x1b\[2K(.?)/g)].find((m) => m[2] === '›')?.[1]
  assert.ok(promptRow, 'the input row must have been drawn')
  const cursorRow = [...last.matchAll(/\x1b\[(\d+);(\d+)H/g)].at(-1)?.[1]
  assert.equal(cursorRow, promptRow, 'the cursor must sit on the input row, not on a seat’s')
})

test('more busy seats than rows stops at a fixed height and says where to read the rest', async () => {
  // The count alone would tell the operator they are missing something without telling them
  // how to stop missing it. `/state` prints every seat with its task and its branch.
  const h = await harness(undefined, undefined, () => ['alpha', 'beta', 'gamma', 'delta', 'epsilon'])
  h.screen.draw()
  assert.match(h.raw(), /3 more working — \/state/)
  // And the cap is a cap: the two it does show, the overflow row, and nothing else.
  assert.match(h.raw(), /alpha/)
  assert.match(h.raw(), /beta/)
  assert.doesNotMatch(h.raw(), /epsilon/, 'a box that grew with the seat count would eat the transcript')
})

test('exactly as many seats as rows are all shown, with nothing claiming to be hidden', async () => {
  // The boundary, and it is the one an off-by-one lands on: a cap that fires at the limit
  // rather than past it drops a seat that fits and reports `1 more working` over a row it had
  // the space to draw. Neither the two-seat nor the five-seat case above can see that.
  const h = await harness(undefined, undefined, () => ['alpha', 'beta', 'gamma'])
  h.screen.draw()
  const frame = strip(h.frame())
  for (const seat of ['alpha', 'beta', 'gamma']) assert.match(frame, new RegExp(seat), `${seat} fits and must be drawn`)
  assert.doesNotMatch(frame, /more working/, 'nothing is hidden, so nothing may say it is')
})

test('an over-wide seat row is clipped to one row rather than wrapping onto the next seat', async () => {
  // The box reserved exactly one row for this seat. A row that wraps is drawn into the row
  // below it, which belongs to another seat — so the terminal shows one seat's instruction
  // over another seat's name, and every row under it is off by one.
  //
  // Clipping is measured in VISIBLE columns: the seat id carries a colour, and escapes occupy
  // no columns. A slice taken against `.length` would cut the row short and, worse, could cut
  // a colour sequence in half and leave the rest of the box wearing it.
  const wide = `\x1b[36mseat-alpha\x1b[0m ${'x'.repeat(200)}`
  const h = await harness(undefined, undefined, () => [wide])
  h.screen.draw()
  const drawn = [...h.frame().matchAll(/\x1b\[\d+;1H\x1b\[2K([^\x1b]*(?:\x1b\[[0-9;]*m[^\x1b]*)*)/g)]
    .map((m) => m[1]!)
    .find((row) => row.includes('seat-alpha'))
  assert.ok(drawn, 'the seat row must have been drawn')
  // EXACTLY the width, not merely within it. A clip that counted the colour escapes as
  // columns would also fit — by throwing away nine columns of the instruction it was given
  // room to show — and "fits" cannot tell that from a correct cut.
  assert.equal(displayWidth(drawn), 80, 'a seat row must use its row and not overflow it')
  assert.match(strip(drawn), /…$/, 'and must say it was cut rather than simply stopping')
  assert.ok(drawn.includes('\x1b[36m'), 'the colour it carries must survive the clip')
  assert.doesNotMatch(drawn, /\x1b\[[0-9;]*$/, 'and no escape may be cut in half')
})

test('busy seats grow the box, and growing it pushes the transcript up rather than over', async () => {
  // The half of the change that is not about text. The box reserves rows from the BOTTOM of
  // the screen, so two extra rows lower the floor by two — and the content already sitting on
  // those two rows is content a participant just wrote. Growing without scrolling it up first
  // paints the box over the last thing said, which is the failure #54 was.
  let busy: string[] = []
  const h = await harness(undefined, undefined, () => busy)
  const regions = () => [...h.raw().matchAll(/\x1b\[1;(\d+)r/g)].map((m) => Number(m[1]))
  /** Every push: save cursor, jump to the OLD floor, newline per overflowing row, restore. */
  const pushes = () => [...h.raw().matchAll(/\x1b\[s\x1b\[(\d+);1H(\n+)\x1b\[u/g)].map((m) => [Number(m[1]), m[2]!.length])

  h.screen.draw()
  assert.equal(regions().at(-1), 20, 'a 24-row terminal with a four-row box scrolls the top 20')
  // The harness answers no cursor query, so the box starts anchored at the floor: `#contentRow`
  // is 20, which is BELOW the floor of 18 that two more rows will create. That is the state the
  // push exists for, and a test that started with a descending box would never reach it.
  assert.deepEqual(pushes(), [], 'nothing has grown yet, so nothing has been pushed')

  busy = ['seat-alpha  t-3', 'seat-beta  t-4']
  h.screen.draw()
  assert.equal(regions().at(-1), 18, 'two seat rows cost exactly two rows of scrolling region')
  assert.deepEqual(
    pushes(),
    [[20, 2]],
    'the two rows the box took must be scrolled up from the OLD floor, one newline each',
  )

  busy = ['seat-alpha  t-3', 'seat-beta  t-4', 'seat-gamma  t-5']
  h.screen.draw()
  assert.equal(regions().at(-1), 17, 'a third seat takes a third row')
  assert.deepEqual(
    pushes(),
    [
      [20, 2],
      [18, 1],
    ],
    'growing again pushes again, by the one further row it took, from the floor it grew from',
  )

  busy = []
  h.screen.draw()
  assert.equal(regions().at(-1), 20, 'and the rows come back when the seats go idle')
  assert.equal(pushes().length, 2, 'shrinking pushes nothing: those rows are the box giving screen back')
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

  // The box anchors at the new floor rather than continuing to descend.
  //
  // This assertion said the opposite when the descending box was written, on the reasoning
  // that a terminal which grew by six rows had not moved the transcript, so the box need not
  // move either. That was wrong, and #54 is what it looked like: the terminal REFLOWS its
  // scrollback on a resize, so `#contentRow` — a row conclave increments itself — stops
  // describing anything real, and every subsequent frame is drawn against it. The screen
  // ended up holding several box frames at once.
  //
  // Nothing in the process can recover the true position: the cursor is in the box, so the
  // cursor query answers where the box was, not where the text is. Anchoring is the same
  // answer given to a terminal that never replies to that query — when the content's
  // position is unknown, the floor is the one row the box is certainly not on top of.
  const frame = h.raw().slice(h.raw().lastIndexOf('\x1b[1;26r'))
  assert.match(frame, /\x1b\[27;1H/, 'the box should anchor at the new floor after a resize')
  assert.match(frame, /›/)
  // And the frame drawn for the old dimensions is erased before the new one is painted.
  // `draw()` alone only clears BELOW the box, which cannot reach a frame left above it.
  assert.match(h.raw(), /\x1b\[21;1H\x1b\[0J/, 'the old frame should be erased, not left behind')
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
