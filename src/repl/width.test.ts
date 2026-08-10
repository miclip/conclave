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

import { clipToWidth, displayWidth, rowsUsed } from './width.ts'

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

test('clipping counts columns, so a row of CJK is cut where the terminal would wrap it', () => {
  // The failure this prevents is not cosmetic: a pinned box gives a row exactly one row, and
  // a line one column too wide wraps onto the row below — which belongs to something else.
  // `.slice(0, columns)` on ten ideographs keeps twenty columns of a ten-column row.
  const wide = '実装は並行に走る'.repeat(4)
  const clipped = clipToWidth(wide, 10)
  // Stripped, because every clipped row ends with a reset after the ellipsis: an unterminated
  // colour would otherwise leak onto whatever the frame draws next.
  assert.match(clipped.replace(/\x1b\[[0-9;]*m/g, ''), /…$/)
  // Nine, not ten, and that is the boundary rule rather than an off-by-one: a two-column
  // cluster with one column left does not straddle the edge — the whole thing moves — so four
  // ideographs plus the ellipsis is the most that fits in ten. Counting characters instead
  // would keep NINE ideographs here: eighteen columns in a ten-column row.
  assert.equal(displayWidth(clipped), 9, 'a two-column cluster is never half-drawn to fill a row')
  assert.ok(displayWidth(clipped) <= 10, 'and never exceeds the row it was given')
  assert.equal(displayWidth(clipToWidth(wide, 9)), 9, 'one column narrower fits the same four')
})

test('clipping spends no columns on colour, and closes the colour it kept', () => {
  const coloured = `\x1b[36m${'a'.repeat(40)}\x1b[0m`
  const clipped = clipToWidth(coloured, 10)
  assert.equal(displayWidth(clipped), 10, 'escapes occupy no columns and must not be charged for any')
  assert.ok(clipped.startsWith('\x1b[36m'), 'the colour it was given must survive the cut')
  assert.ok(clipped.endsWith('\x1b[0m'), 'and must be closed, or the rest of the frame wears it')
})

test('text that already fits is returned untouched, ellipsis and all', () => {
  // The identity case: a row within the width must be byte-for-byte what it was, or every
  // unclipped row in the box changes the moment clipping exists.
  assert.equal(clipToWidth('  seat-alpha  t-3', 80), '  seat-alpha  t-3')
  assert.equal(clipToWidth('exactly-ten', 11), 'exactly-ten', 'a line that exactly fills its row still fits')
})

test('the cut is a cut: nothing after it is smuggled back in because it happens to fit', () => {
  // Skipping the cluster that does not fit, rather than STOPPING there, passes every
  // uniform-width test in this file — once one 'x' does not fit, no later 'x' does either. It
  // fails the moment a row mixes widths, which a seat row does the instant an instruction
  // contains a wide character: the wide part is dropped and narrow text from further along is
  // pulled up into its place, so the operator reads a sentence the seat was never given.
  const mixed = `${'世界'.repeat(3)}abcdef`
  const clipped = clipToWidth(mixed, 6)
  assert.equal(clipped.replace(/\x1b\[[0-9;]*m/g, ''), '世界…', 'the row must end where it ran out of columns')
  assert.doesNotMatch(clipped, /[a-f]/, 'text from beyond the cut must not appear before it')
})
