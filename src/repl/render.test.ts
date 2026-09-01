/**
 * Markdown to ANSI.
 *
 * Participants write markdown — headings, tables, fenced code, bold — and it was printing
 * as raw asterisks and pipes. These assert on structure rather than on exact escape bytes,
 * because the point is that a reader can find the information, not that a particular
 * colour was chosen.
 *
 *   node --test src/repl/render.test.ts
 */

import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { markdown, Progress, setColor, summaryLine, titleSequence } from './render.ts'

test('colour is off when asked, so piped output stays clean', () => {
  setColor(false)
  const out = markdown('**bold** and `code`')
  assert.ok(!out.includes('\x1b['), `escape codes leaked into a non-colour render: ${JSON.stringify(out)}`)
  assert.match(out, /bold and code/)
})

test('a table becomes aligned columns rather than pipes', () => {
  setColor(false)
  const out = markdown(
    ['| record type | arg field | count |', '|---|---|---|', '| `custom_tool_call` | `input` | 2839 |'].join('\n'),
  )
  const lines = out.split('\n')
  assert.ok(!lines[0]!.includes('|'), 'the header must not still be pipe-delimited')
  assert.match(lines[0]!, /record type/)
  assert.match(lines[1]!, /─/, 'a rule separates the header')
  assert.match(lines[2]!, /custom_tool_call/)
  // Columns line up: the separator is as wide as the header.
  assert.equal(lines[1]!.trimEnd().length, lines[0]!.trimEnd().length)
})

test('fenced code is verbatim and never wrapped', () => {
  setColor(false)
  const long = 'const r = await tools.exec_command({"cmd":"pwd && rg --files --hidden --glob !node_modules"})'
  const out = markdown(['```ts', long, '```'].join('\n'), { width: 40 })
  assert.ok(out.includes(long), 'a wrapped code line is a broken code line')
})

test('prose wraps to the width, and lists keep their hanging indent', () => {
  setColor(false)
  const out = markdown('- ' + 'word '.repeat(40).trim(), { width: 40 })
  const lines = out.split('\n')
  assert.ok(lines.length > 1, 'it should have wrapped')
  for (const l of lines) assert.ok(l.length <= 40, `line over width: ${l.length}`)
  assert.match(lines[0]!, /•/)
  assert.ok(!lines[1]!.includes('•'), 'continuation lines carry no bullet')
  assert.match(lines[1]!, /^\s{4}/, 'and are indented under the first')
})

test('headings, quotes and inline spans survive', () => {
  setColor(false)
  const out = markdown(['## Findings', '', '> approximate, the direction is not in doubt', '', 'see `parse.ts:76`'].join('\n'))
  assert.match(out, /Findings/)
  assert.match(out, /▏ approximate/)
  assert.match(out, /parse\.ts:76/)
  assert.ok(!out.includes('##'), 'heading markers are consumed')
  assert.ok(!out.includes('`'), 'backticks are consumed')
})

test('a table too wide for the terminal truncates rather than wrapping', () => {
  // A wrapped table is unreadable; a truncated cell is lossy and says so.
  setColor(false)
  const out = markdown(
    ['| a | b |', '|---|---|', `| ${'x'.repeat(80)} | ${'y'.repeat(80)} |`].join('\n'),
    { width: 50 },
  )
  for (const l of out.split('\n')) assert.ok(l.length <= 50, `line over width: ${l.length}`)
  assert.match(out, /…/)
})

test('a title puts the state first and cannot escape its own sequence', () => {
  // Tabs truncate from the right, so losing the end of a goal costs less than losing the
  // word that says the session is waiting for you.
  assert.match(titleSequence('paused', 'rewrite the parser'), /^\x1b\]0;paused — rewrite the parser\x07$/)
  // A newline inside an OSC string ENDS it, leaving the remainder to print as text on the
  // terminal — a goal is operator input and can contain anything.
  const injected = titleSequence('working', 'do a thing\x07\x1b]0;something else')
  assert.equal(injected.match(/\x07/g)?.length, 1, 'exactly one terminator')
  assert.equal(injected.match(/\x1b\]0;/g)?.length, 1, 'exactly one sequence')
  // Long goals are cut here rather than handed to the terminal whole.
  assert.ok(titleSequence('working', 'x'.repeat(200)).length < 60)
  // No subject yet is legitimate: a session with no goal typed is still worth naming.
  assert.equal(titleSequence('waiting'), '\x1b]0;waiting\x07')
})

test('a long summary line wraps under its sentence, not under the marker', () => {
  // The closing block writes one line per fact, and a carried flag is a sentence a
  // participant wrote — often long. On a real terminal those soft-wrapped to column zero, so
  // each continuation read as a separate broken line; seven in a row looked like the console
  // had come apart, which is how it was reported.
  const flag =
    '  implementer [msg 7] — buildUrl sends orderby=time with limit=500 while toQuakes sorts ' +
    'nearest-first client-side, so a wide search silently shows the nearest among the 500 ' +
    'most recent rather than the nearest overall.'
  const lines = summaryLine('===', flag, 96).split('\n')
  assert.ok(lines.length > 1, 'it must actually wrap')
  assert.ok(lines.every((l) => l.length <= 96), `no line may exceed the width:\n${lines.join('\n')}`)

  // The marker introduces the first line only.
  assert.match(lines[0]!, /^=== {3}implementer/)
  assert.ok(!lines[1]!.startsWith('==='), 'a continuation is not a new item')

  // ...and it hangs under the sentence, so the eye follows the text rather than the marker.
  const textStarts = lines[0]!.indexOf('implementer')
  assert.equal(lines[1]!.search(/\S/), textStarts, 'continuations align with the sentence')
})

test('a short summary line keeps its words and its width, and normalises the space between them', () => {
  // Two claims, and they are not the same claim.
  //
  // The first is about WIDTH: a short line must not gain padding, a hanging indent, or a
  // second row for the sake of a rule that exists for long ones. Width is passed explicitly
  // (96) so the expectation does not move with anyone's terminal.
  assert.equal(summaryLine('===', 'run ended: done — DONE', 96), '=== run ended: done — DONE')
  assert.equal(summaryLine('===', '8 messages routed', 96), '=== 8 messages routed')

  // The second is about SPACE, and it is the one the old name of this test got wrong. Nothing
  // here is left "exactly as it was": `wrap()` splits on runs of whitespace and rejoins with
  // single spaces, so every double space, tab and newline inside the text is gone before the
  // line is returned. That is a contract, not an accident -- a summary is one fact per row and
  // a participant's stray spacing must not open a gap in the middle of it -- so it is pinned
  // rather than left to be discovered by whoever next assumes the input survives verbatim.
  assert.equal(summaryLine('===', 'run  ended:   done', 96), '=== run ended: done')
  assert.equal(summaryLine('===', 'run\tended:\ndone', 96), '=== run ended: done')
  // Including the marker's own gap: the leading run collapses with the rest.
  assert.equal(summaryLine('===', '  8   messages  routed', 96), '===   8 messages routed')
})

test('a pinned detail may be recomputed at draw time, so a duration in it stays true', () => {
  // The footer redraws on a timer -- that is what animates the spinner and advances the seat's
  // own elapsed clock. A detail stored as a fixed string is frozen at the moment of the last
  // event, so "2 subagents running (12s)" sits there reading 12s beside a seat clock that has
  // reached four minutes. One of the two numbers is then a lie, and it is the one a reader has
  // no way to check.
  setColor(false)
  const progress = new Progress(new PassThrough(), false)
  progress.start('implementer')

  let ticks = 0
  progress.note('implementer', () => `2 subagents running (${++ticks}s)`)
  assert.match(progress.line(), /2 subagents running \(1s\)/)
  assert.match(progress.line(), /2 subagents running \(2s\)/, 'the second draw must ask again')

  // A plain string still works and is still fixed, which is what every other caller wants.
  progress.note('implementer', 'Bash')
  assert.match(progress.line(), /Bash/)
  assert.match(progress.line(), /Bash/)
})
