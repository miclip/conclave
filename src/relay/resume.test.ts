/**
 * Continuing a run that ended with work in flight.
 *
 *   node --test src/relay/resume.test.ts
 */

import { strict as assert } from 'node:assert'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { tempDir } from '../testkit/tempDir.ts'
import type { RelayMessage } from './message.ts'
import { readRunLog, resumeBriefing, RunLogWriter } from './resume.ts'

function msg(seq: number, text: string, over: Partial<RelayMessage> = {}): RelayMessage {
  return {
    seq,
    at: seq,
    from: 'implementer',
    fromRank: 'implementer',
    to: ['advisor'],
    kind: 'report',
    text,
    visibility: 'all',
    excluded: [],
    ...over,
  } as RelayMessage
}

test('the log is written as it happens, not assembled at the end', (t) => {
  // A record written on exit is exactly the record a crash destroys, and a crash is one of
  // the endings a resume exists for.
  const dir = tempDir(t, 'conclave-resume')
  const path = join(dir, 'nested', 'run.ndjson')
  const w = new RunLogWriter(path)

  w.write(msg(1, 'first'))
  // Readable BEFORE anything closes it: this is what a killed process leaves behind.
  assert.equal(readRunLog(path).length, 1)
  w.write(msg(2, 'second'))
  assert.deepEqual(readRunLog(path).map((m) => m.text), ['first', 'second'])
})

test('a truncated final line is dropped, not thrown on', (t) => {
  // The expected shape of a log whose writer was killed mid-append -- precisely the case a
  // resume is for. Refusing to read it would make the crash unrecoverable a second time.
  const dir = tempDir(t, 'conclave-resume')
  const path = join(dir, 'run.ndjson')
  writeFileSync(path, `${JSON.stringify(msg(1, 'complete'))}\n{"seq":2,"text":"cut off`)

  const read = readRunLog(path)
  assert.equal(read.length, 1)
  assert.equal(read[0]!.text, 'complete')
})

test('the briefing says it is a continuation rather than pretending to be memory', () => {
  // Replaying the log as though the participants had said those things themselves would have
  // a fresh session believe it holds context it does not, and it would stop asking.
  const b = resumeBriefing([msg(1, 'I measured six wall times')])
  assert.match(b, /THIS RUN IS A CONTINUATION/)
  assert.match(b, /You do not remember it/)
  assert.match(b, /I measured six wall times/, 'the log is replayed verbatim')
  assert.match(b, /ask rather than assuming/)
})

test('internal notes are not replayed', () => {
  // Orchestrator bookkeeping is about the previous run's machinery, not about the work. It
  // would read to a participant as instructions from a party it cannot see.
  const b = resumeBriefing([
    msg(1, 'real work'),
    msg(2, 'rotation candidate closed at compaction generation 1', { visibility: 'internal', kind: 'note', to: [] }),
  ])
  assert.match(b, /real work/)
  assert.doesNotMatch(b, /rotation candidate closed/)
})

test('truncation drops the OLDEST messages and says how many', () => {
  // The tail is where the unfinished work is. And a participant that was silently handed a
  // partial history would assume it saw everything -- the exact failure this replaces,
  // where anything untranscribed was silently lost.
  const many = Array.from({ length: 40 }, (_, i) => msg(i + 1, `entry ${i + 1} `.repeat(40)))
  const b = resumeBriefing(many, 4_000)

  assert.match(b, /OLDEST message\(s\) were dropped/)
  assert.match(b, /entry 40/, 'the most recent work survives')
  assert.doesNotMatch(b, /entry 1 entry 1/, 'the oldest is gone')
  assert.match(b, /If you need what came before, say so/)
})

test('a log that fits carries no truncation notice', () => {
  // The notice must not appear when nothing was dropped, or it trains a reader to skip the
  // exact line that matters when something was.
  const b = resumeBriefing([msg(1, 'short')])
  assert.doesNotMatch(b, /dropped to fit/)
})

/**
 * The failure this pair is written from is on disk, not imagined: an oath-lang run whose
 * seq 19 is a `report` with `unsettled: true` and a zero-length body, and whose seq 20 halt
 * says in as many words "a resume from this log starts with that turn saying nothing" (#94).
 */
test('a lost report is replayed as missing information, not as a turn that said nothing', () => {
  const brief = resumeBriefing([msg(19, '', { unsettled: true })])

  assert.ok(!/\[19\] implementer -> advisor\s*$/.test(brief), 'an empty body must not be replayed as a blank')
  assert.match(brief, /no readable account of itself/)
  // The distinction the briefing exists to protect. Its own opening tells the reader to treat
  // what follows as established and not to redo work it shows as done -- so a turn whose
  // account was LOST must not read as a turn that reported nothing, or the resumed
  // participant concludes the work was never done and does it again.
  assert.match(brief, /may be on disk/)
  assert.match(brief, /not as a turn that did nothing/)
})

test('an unsettled body that HAS text is replayed in full, and qualified rather than cut', () => {
  // The salvaged case from the same run (seq 13-14): narration rebuilt from 10 streamed
  // messages. It is real content and the only thing wrong with it is that it is not the
  // closing statement, so withholding it would discard the turn a second time.
  const brief = resumeBriefing([msg(14, 'Falsifier settled; moving to the real implementation.', { unsettled: true })])

  assert.match(brief, /Falsifier settled; moving to the real implementation\./)
  assert.match(brief, /may be incomplete/)
})

test('a settled report is replayed exactly as it was, with nothing added', () => {
  // The guard on the two above: a qualification that appeared on ordinary reports would put a
  // hedge on every message in the log and teach the reader to skip it.
  const brief = resumeBriefing([msg(5, 'The work is done and the tests pass.')])

  assert.match(brief, /\[5\] implementer -> advisor\nThe work is done and the tests pass\./)
  assert.ok(!/unverified|incomplete|no readable account/.test(brief), 'a settled report must carry no qualification')
})
