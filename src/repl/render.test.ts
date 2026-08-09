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
import test from 'node:test'
import { markdown, setColor, summaryLine, titleSequence } from './render.ts'

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

test('a short summary line is left exactly as it was', () => {
  // Most lines are short and must not gain padding for the sake of a rule about long ones.
  assert.equal(summaryLine('===', 'run ended: done — DONE', 96), '=== run ended: done — DONE')
  assert.equal(summaryLine('===', '8 messages routed', 96), '=== 8 messages routed')
})
