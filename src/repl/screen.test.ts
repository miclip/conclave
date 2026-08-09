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

  // The box should be redrawn after the resize: prompt and rules are present in the latest frame.
  assert.match(h.raw(), /\x1b\[30;1H/)
  assert.match(h.raw(), /›/)
})
