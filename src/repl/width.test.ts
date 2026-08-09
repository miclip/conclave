/**
 * The column arithmetic, tested directly rather than only through the box it places.
 *
 * `screen.test.ts` proves the box lands on the right row, which is the behaviour anyone
 * cares about; these are the cases underneath it that a box test cannot reach without an
 * absurd terminal geometry — and the wrap-boundary case, which is exactly where a
 * width-aware count and a `ceil(width / columns)` count stop agreeing.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { displayWidth, rowsUsed } from './width.ts'

test('a column is not a character', () => {
  assert.equal(displayWidth('abc'), 3)
  assert.equal(displayWidth('世界'), 4, 'ideographs take two columns each')
  assert.equal(displayWidth('ｆｕｌｌ'), 8, 'and so do fullwidth forms')
  assert.equal(displayWidth('e\u0301'), 1, 'a combining accent takes none of its own')
  assert.equal(displayWidth('\uac00'), 2, 'and a Hangul syllable takes two')
})

test('emoji are one grapheme however many code points they are', () => {
  assert.equal(displayWidth('\u{1f44d}'), 2)
  // The joiners inside a ZWJ sequence are format characters and take no columns; counting
  // them would make one emoji as wide as the sentence around it.
  assert.equal(displayWidth('\u{1f468}‍\u{1f469}‍\u{1f467}'), 2)
  // U+FE0F asks a narrow pictograph for its emoji rendering, which is the wide one.
  assert.equal(displayWidth('⚠️'), 2)
})

test('colour codes are measured as the nothing they occupy', () => {
  assert.equal(displayWidth('\x1b[31mred\x1b[0m'), 3)
})

test('a wide character does not straddle the wrap boundary', () => {
  // Five ideographs in five columns: two per row with the last column wasted, so three
  // rows. Ten columns divided by five says two, and the box then opens on the last row of
  // the text. This is the whole reason the count walks the string instead of dividing.
  assert.equal(rowsUsed('界'.repeat(5), 5), 3)
})

test('a line that exactly fills the width stays on one row', () => {
  // Terminals defer the wrap until there is another character to print, and at the end of a
  // line there never is. Treating the fill as a wrap costs a blank row above the box.
  assert.equal(rowsUsed('a'.repeat(80), 80), 1)
  assert.equal(rowsUsed('a'.repeat(81), 80), 2)
})

test('every newline is a row, including the empty ones', () => {
  assert.equal(rowsUsed('', 80), 1)
  assert.equal(rowsUsed('a\nb', 80), 2)
  assert.equal(rowsUsed('a\nb\n', 80), 3, 'a trailing newline opens a row that exists')
})
