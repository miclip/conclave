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

function harness(suggestion?: Suggestion, pending?: () => string[]) {
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
  screen.open()

  return {
    screen,
    lines,
    press: (name: string, ch?: string) => input.emit('keypress', ch, { name, sequence: ch ?? '' }),
    type: (text: string) => {
      for (const ch of text) input.emit('keypress', ch, { name: ch, sequence: ch })
    },
    /** The menu row: the fourth of the four reserved rows in the most recent draw. */
    menuRow: () => {
      const frame = written.at(-1) ?? ''
      const row = String(24 - 4 + 4)
      const at = frame.lastIndexOf(`${ESC}${row};1H`)
      return at < 0 ? '' : strip(frame.slice(at))
    },
    /** Everything written since the harness was made, escape codes intact. */
    raw: () => written.join(''),
    /** Which item is reverse-videoed, if any. */
    selected: () => /\x1b\[7m ([^\x1b]+) \x1b\[0m/.exec(written.at(-1) ?? '')?.[1],
  }
}

const PARTICIPANTS: Suggestion = {
  items: ['>advisor', '>implementer', '>both'],
  start: 0,
  end: 1,
  suffix: ' ',
  note: 'plain text reaches both',
}

test('the menu opens with nothing selected', () => {
  // Pre-selecting would mean the menu had already chosen on the operator's behalf, and for
  // participants that choice is wrong: no prefix at all reaches both.
  const h = harness(PARTICIPANTS)
  h.type('>')
  assert.equal(h.selected(), undefined)
  assert.match(h.menuRow(), />advisor.*>implementer.*>both/)
})

test('right moves through the candidates in the order they are shown', () => {
  const h = harness(PARTICIPANTS)
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

test('left from nothing selected lands on the last, not the first', () => {
  const h = harness(PARTICIPANTS)
  h.type('>')
  h.press('left')
  assert.equal(h.selected(), '>both')
})

test('up and down still work, because a menu is not the place to be strict', () => {
  const h = harness(PARTICIPANTS)
  h.type('>')
  h.press('down')
  assert.equal(h.selected(), '>advisor')
  h.press('up')
  assert.equal(h.selected(), '>both')
})

test('enter with nothing selected submits the line rather than picking', () => {
  // This is what keeps the default reachable: `both` is what you get by typing nothing, so
  // getting it must not require dismissing the menu first.
  const h = harness(PARTICIPANTS)
  h.type('hello')
  h.press('return')
  assert.deepEqual(h.lines, ['hello'])
})

test('enter with something selected accepts it and does not submit', () => {
  const h = harness(PARTICIPANTS)
  h.type('>')
  h.press('right')
  h.press('return')
  assert.deepEqual(h.lines, [], 'a picker you cannot leave without submitting is a trap')
  assert.equal(h.screen.line, '>advisor ')
})

test('tab accepts the first candidate even with nothing selected', () => {
  // Tab has always meant "complete the obvious one"; requiring an arrow first would make
  // the menu slower than the completer it replaced.
  const h = harness(PARTICIPANTS)
  h.type('>')
  h.press('tab')
  assert.equal(h.screen.line, '>advisor ')
})

test('escape dismisses, and then the arrows belong to the line again', () => {
  const h = harness(PARTICIPANTS)
  h.type('>')
  h.press('escape')
  assert.equal(h.selected(), undefined)
  assert.match(h.menuRow(), /hint/)
})

test('the note says how to reach both without picking anything', () => {
  const h = harness(PARTICIPANTS)
  h.type('>')
  assert.match(h.menuRow(), /plain text reaches both/)
})


test('pending messages are pinned above the box, dim and italic', () => {
  // Both attributes, because a terminal that drops one usually keeps the other, and this is
  // the difference between "said" and "not yet said".
  let queue = ['→ advisor  check the error path']
  const h = harness(undefined, () => queue)
  h.screen.draw()
  const frame = h.raw()
  assert.match(frame, /check the error path/)
  assert.match(frame, /\x1b\[2;3m {2}→ advisor {2}check the error path/)
})

test('the box grows and shrinks with the queue rather than reserving rows for nothing', () => {
  let queue: string[] = []
  const h = harness(undefined, () => queue)
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

test('a long queue stops at a fixed height and says how much it is hiding', () => {
  // An unbounded box would eat the transcript it exists to annotate.
  const h = harness(undefined, () => ['a', 'b', 'c', 'd', 'e'])
  h.screen.draw()
  assert.match(h.raw(), /3 more queued — \/queue/)
})
