/**
 * How much of a terminal a string actually takes up.
 *
 * `String.length` counts UTF-16 code units, which is the wrong unit three times over: a CJK
 * ideograph is one unit but two columns, a combining accent is one unit but no columns at
 * all, and an emoji is two units, two columns, and one character. Anything that places a
 * box relative to printed output has to count columns, or it lands on top of the last line
 * for CJK text and leaves a gap for accented Latin.
 *
 * Measured in grapheme clusters rather than code points, because that is the unit a
 * terminal advances the cursor by: `e` + U+0301 is one cell, not two, and a ZWJ emoji
 * sequence is one cell-pair, not one per component.
 */

/** Colour codes occupy no columns; counting them wraps text that fits. */
const SGR = /\x1b\[[0-9;]*m/g

/**
 * Ranges that render two columns wide, from the East Asian Width property (W and F).
 *
 * A table rather than a dependency: the package keeps exactly one runtime dependency, and
 * the alternative is `string-width` plus its four transitive packages to answer a question
 * that fits in twenty lines. The table is coarse where being coarse is harmless — a
 * character misjudged here costs at most one row of box placement while it is descending.
 */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2329, 0x232a], // angle brackets
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // kana, Hangul compatibility jamo, CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x20000, 0x2fffd], // CJK extensions B onwards
  [0x30000, 0x3fffd],
]

/** Default-emoji-presentation characters are wide wherever they are not in the table. */
const EMOJI_WIDE = /^\p{Emoji_Presentation}$/u
/** Pictographs that are narrow alone but wide once U+FE0F asks for emoji presentation. */
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u
/**
 * Marks, format characters and controls advance the cursor by nothing.
 *
 * `Cf` covers the joiners and the variation selectors, which matters for emoji sequences:
 * counting a ZWJ as a column makes a family emoji four cells wide.
 */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]$/u

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Columns taken by one grapheme cluster: 0, 1, or 2. */
function clusterWidth(cluster: string): number {
  const cp = cluster.codePointAt(0)
  if (cp === undefined) return 0
  const base = String.fromCodePoint(cp)
  if (ZERO_WIDTH.test(base)) return 0
  if (EMOJI_WIDE.test(base)) return 2
  // U+FE0F on a pictograph is a request for the emoji rendering, which is the wide one.
  if (cluster.includes('\uFE0F') && PICTOGRAPHIC.test(base)) return 2
  for (const [lo, hi] of WIDE) {
    if (cp < lo) break
    if (cp <= hi) return 2
  }
  return 1
}

/** Columns a single line of text occupies, ignoring colour codes and wrapping. */
export function displayWidth(text: string): number {
  let n = 0
  for (const { segment } of graphemes.segment(text.replace(SGR, ''))) n += clusterWidth(segment)
  return n
}

/**
 * How many screen rows `text` occupies once the terminal has wrapped it to `columns`.
 *
 * Walked cluster by cluster rather than `ceil(width / columns)`, because a two-column
 * character with one column left does not straddle the boundary — the terminal moves the
 * whole thing to the next row and leaves the last column blank. Dividing ignores that and
 * under-counts by a row for every two wasted columns, which is exactly the case (a wall of
 * CJK in a narrow terminal) where being wrong puts the box on top of the text.
 *
 * A line that exactly fills the width stays on one row: terminals defer the wrap until
 * there is another character to print, and here there never is.
 */
export function rowsUsed(text: string, columns: number): number {
  const w = Math.max(1, columns)
  let rows = 0
  for (const line of text.split('\n')) {
    let col = 0
    rows += 1
    for (const { segment } of graphemes.segment(line.replace(SGR, ''))) {
      const cw = clusterWidth(segment)
      if (col + cw > w) {
        rows += 1
        col = cw
      } else {
        col += cw
      }
    }
  }
  return rows
}
