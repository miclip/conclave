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
import { markdown, setColor } from './render.ts'

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
