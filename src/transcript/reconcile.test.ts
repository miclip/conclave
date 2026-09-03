/**
 * Reconciliation tests.
 *
 * Real transcripts are used where they exist (Claude Code sessions recorded during
 * spikes 2 and 3, and Codex rollouts from the user's history). Compaction has no
 * recorded fixture, so those cases are SYNTHETIC and labelled as such -- per the
 * evidence-level discipline, a synthesised fixture must never be mistaken for an
 * observed one.
 *
 *   node --test src/transcript/reconcile.test.ts
 */

import { strict as assert } from 'node:assert'
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isChildOutput } from '../contract/session.ts'
import { suiteTempDir, tempDir } from '../testkit/tempDir.ts'
import { TranscriptSessionView } from './reconcile.ts'
import { parseClaude, parseCodex } from './parse.ts'
import { guaranteesFor } from '../contract/session.ts'
import type { AgentEvent, SessionSnapshot } from '../contract/session.ts'
import { assess, detectDegradation } from '../rotation/degradation.ts'
import { RewriteAwareTail, parseJsonLine } from './tail.ts'

const SCRATCH = suiteTempDir('reconcile')

function view(path: string, agent: string) {
  return new TranscriptSessionView({
    path,
    agent,
    sessionId: 'test-session',
    cwd: '/tmp',
    guarantees: guaranteesFor('mediated'),
  })
}

function readJsonl(path: string): Record<string, any>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
}

// --- real fixtures -----------------------------------------------------------------

function findRealClaudeTranscript(): string | undefined {
  // Claude keys its project directory by the checkout path, so a hardcoded name stops
  // resolving the moment the directory is renamed -- and this test then silently skips
  // rather than failing. Derive it instead: every non-alphanumeric character becomes `-`.
  const slug = process.cwd().replace(/[^a-zA-Z0-9]/g, '-')
  const dir = join(homedir(), '.claude', 'projects', slug)
  if (!existsSync(dir)) return undefined
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(dir, f))
  // Prefer one that actually contains a completed assistant turn.
  for (const f of files) {
    const records = readJsonl(f)
    const parsed = parseClaude(records)
    if (parsed.turns.some((t) => t.state === 'completed')) return f
  }
  return undefined
}

test('OBSERVED: a real Claude transcript yields a completed turn, marked transcript-only', () => {
  const path = findRealClaudeTranscript()
  if (!path) {
    console.log('  (no recorded Claude transcript with a completed turn; run the step-2 matrix)')
    return
  }
  const parsed = parseClaude(readJsonl(path))
  const done = parsed.turns.find((t) => t.state === 'completed')!
  assert.ok(done.prompt.length > 0)
  assert.equal(done.confidence, 'inferred')
  assert.ok(
    done.provenance!.some((p) => p.caveat && p.detail.includes('Stop hook is what proves')),
    'transcript-derived completion must not claim to be proven',
  )
})

test('OBSERVED: real Codex rollouts parse, and turn_aborted proves cancellation', () => {
  const root = join(homedir(), '.codex', 'sessions')
  if (!existsSync(root)) {
    console.log('  (no Codex sessions on this machine)')
    return
  }
  const files: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) files.push(p)
    }
  }
  walk(root)
  assert.ok(files.length > 0, 'expected some codex rollouts')

  let sawComplete = false
  let sawAborted = false
  for (const f of files) {
    const parsed = parseCodex(readJsonl(f))
    for (const t of parsed.turns) {
      if (t.state === 'completed') sawComplete = true
      if (t.state === 'cancelled') {
        sawAborted = true
        assert.equal(t.confidence, 'proven', 'codex cancellation is proven, not inferred')
        assert.ok(t.provenance!.some((p) => p.detail.includes('turn_aborted')))
      }
    }
  }
  assert.ok(sawComplete, 'expected at least one task_complete across the rollout history')
  assert.ok(sawAborted, 'expected at least one turn_aborted across the rollout history')
})

// --- append behaviour --------------------------------------------------------------

test('OBSERVED: appended records emit incrementally and only once', async () => {
  const p = join(SCRATCH, 'append.jsonl')
  writeFileSync(p, '')
  const v = view(p, 'claude')

  appendFileSync(p, JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n')
  let events = await v.poll()
  assert.equal(events.filter((e) => e.type === 'turn_start').length, 1)

  // Polling again with no new bytes must not re-announce anything.
  events = await v.poll()
  assert.deepEqual(events, [])

  appendFileSync(
    p,
    JSON.stringify({
      type: 'assistant',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] },
    }) + '\n',
  )
  events = await v.poll()
  const end = events.find((e) => e.type === 'turn_end')
  assert.ok(end, 'expected a turn_end once stop_reason=end_turn appears')
  assert.equal(end.synthesized, true, 'transcript-derived terminals are synthesized')
  assert.equal(end.provisional, true)
})

test('OBSERVED: a partially written final line is not parsed until complete', async () => {
  const p = join(SCRATCH, 'partial.jsonl')
  writeFileSync(p, '')
  const v = view(p, 'claude')

  // No trailing newline: the record is still being written.
  appendFileSync(p, '{"type":"user","message":{"content":"half')
  assert.deepEqual(await v.poll(), [])

  appendFileSync(p, '-written"}}\n')
  const events = await v.poll()
  assert.equal(events.filter((e) => e.type === 'turn_start').length, 1)
})

// --- compaction: SYNTHETIC -------------------------------------------------------

test('SYNTHETIC: a rewritten prefix is detected even with no compaction marker', async () => {
  const p = join(SCRATCH, 'rewrite.jsonl')
  const line = (c: string) => JSON.stringify({ type: 'user', message: { content: c } }) + '\n'
  writeFileSync(p, line('first') + line('second'))

  const tail = new RewriteAwareTail(p, parseJsonLine)
  const before = await tail.poll()
  assert.equal(before.appended.length, 2)
  assert.equal(before.rewritten, false)

  // Same byte length, different content -- the case a size check alone would miss.
  writeFileSync(p, line('FIRST') + line('second'))
  const after = await tail.poll()
  assert.equal(after.rewritten, true, 'prefix digest must catch an in-place rewrite')
  assert.equal(after.all?.length, 2)
})

test('SYNTHETIC: truncation is treated as a rewrite', async () => {
  const p = join(SCRATCH, 'truncate.jsonl')
  const line = (c: string) => JSON.stringify({ type: 'user', message: { content: c } }) + '\n'
  writeFileSync(p, line('a') + line('b') + line('c'))

  const tail = new RewriteAwareTail(p, parseJsonLine)
  await tail.poll()
  writeFileSync(p, line('a'))
  const after = await tail.poll()
  assert.equal(after.rewritten, true)
  assert.equal(after.all?.length, 1)
})

test('#198 SYNTHETIC: a turn that has only thought is emitting child output', async () => {
  // Extended thinking is the one state where a Claude seat is working and silent by every other
  // measure: no assistant text, no tool call, no hook. Claude Code writes each thinking block as
  // its OWN transcript entry -- 1,736 of them in the session this was written from, none carrying
  // anything else -- so the file grows while the seat looks dead to the silence clock.
  const p = join(SCRATCH, 'thinking-only.jsonl')
  const user = (c: string) => JSON.stringify({ type: 'user', message: { content: c } }) + '\n'
  const thought = () =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'weighing two approaches', signature: 'x' }] } }) + '\n'

  writeFileSync(p, user('do the hard one') + thought() + thought())
  const v = view(p, 'claude')

  const out = await v.poll()
  const thinking = out.filter((e) => e.type === 'thinking')
  assert.equal(thinking.length, 2, `one event per block written; got ${JSON.stringify(out.map((e) => e.type))}`)
  assert.ok(
    thinking.every((e) => isChildOutput(e)),
    'and each must count as the child working, or the silence clock is no better off',
  )

  // The count is a diff, like every other derivation here: polling again with nothing appended
  // must not re-report blocks already seen, or a stalled turn would look alive forever.
  assert.deepEqual((await v.poll()).filter((e) => e.type === 'thinking'), [], 'no new blocks, no new events')

  // A third block appended is the turn continuing to reason, and must be reported on its own.
  writeFileSync(p, user('do the hard one') + thought() + thought() + thought())
  assert.equal(
    (await v.poll()).filter((e) => e.type === 'thinking').length,
    1,
    'only the newly written block is emitted',
  )
})

test('SYNTHETIC: re-emitted history is marked as replay, and fresh output is not', async () => {
  // The distinction a consumer cannot draw for itself. On the rewrite path `#emitted` is
  // cleared, so the whole transcript is emitted again -- every message and every tool call the
  // child ever made, in one burst, at a moment the FILE chose. Downstream, two readers treat
  // child output as a sign of life: the watchdog's silence clock and #82's launch diagnosis.
  // Neither can tell an hours-old record from a fresh one by its shape, and both were wrong
  // about a stalled turn every time a transcript was rewritten under it.
  const p = join(SCRATCH, 'replay-flag.jsonl')
  const user = (c: string) => JSON.stringify({ type: 'user', message: { content: c } }) + '\n'
  const spoke = (t: string) =>
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: t }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    }) + '\n'

  writeFileSync(p, user('turn one') + spoke('working on it'))
  const v = view(p, 'claude')

  const fresh = await v.poll()
  assert.ok(
    fresh.some((e) => e.type === 'message'),
    'precondition: the append path must have produced child output',
  )
  assert.ok(
    fresh.every((e) => e.replay === undefined),
    'the append path emits only what is new, so nothing there is a replay',
  )

  // A consumed record MUTATED -- not appended to. That is what `#reserialized` refuses to
  // forgive, and it is what sends the poll down the withdraw-and-re-emit path.
  writeFileSync(p, user('turn one, rewritten') + spoke('working on it'))
  const after = await v.poll()

  assert.ok(
    after.some((e) => e.type === 'revision' && e.reason === 'rewrite'),
    'precondition: this must be the rewrite path, not a reserialization',
  )
  const replayed = after.filter((e) => e.type !== 'revision')
  assert.ok(replayed.length > 0, 'the surviving history must still be re-emitted')
  assert.ok(
    replayed.every((e) => e.replay === true),
    `every re-emitted event is history: ${JSON.stringify(replayed.map((e) => [e.type, e.replay]))}`,
  )
  assert.ok(
    replayed.some((e) => e.type === 'message') && replayed.some((e) => e.type === 'tool_use'),
    'including the two kinds a liveness reader would otherwise have counted',
  )
  // The revision itself is not replayed history; it is news about the file, and it is the one
  // event in this batch that describes something that just happened.
  assert.equal(after.find((e) => e.type === 'revision')!.replay, undefined)
})

test('SYNTHETIC: compaction withdraws prior events and re-emits surviving history', async () => {
  const p = join(SCRATCH, 'compact.jsonl')
  const user = (c: string) => JSON.stringify({ type: 'user', message: { content: c } }) + '\n'
  const done = (t: string) =>
    JSON.stringify({
      type: 'assistant',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: t }] },
    }) + '\n'

  writeFileSync(p, user('turn one') + done('answer one') + user('turn two') + done('answer two'))
  const v = view(p, 'claude')
  const first = await v.poll()
  const firstSeqs = first.map((e) => e.seq)
  assert.equal(first.filter((e) => e.type === 'turn_end').length, 2)
  assert.equal(v.compactionGeneration, 0)

  // Compaction: history rewritten, first turn replaced by a summary reference.
  writeFileSync(
    p,
    JSON.stringify({ type: 'attachment', attachment: { type: 'compact_file_reference' } }) +
      '\n' +
      user('turn two') +
      done('answer two'),
  )

  const after = await v.poll()
  const revision = after.find((e) => e.type === 'revision')
  assert.ok(revision, 'compaction must produce a revision event')
  assert.equal(revision.reason, 'compaction')
  assert.equal(v.compactionGeneration, 1)

  // Everything previously emitted is explicitly withdrawn, not silently abandoned.
  assert.deepEqual(
    [...revision.replaces].sort((a, b) => a - b),
    [...firstSeqs].sort((a, b) => a - b),
  )
  assert.ok(
    revision.provenance.some((p) => p.detail.includes('declares a compaction')),
    'a recognised marker should be reported as such',
  )

  // A consumer following only events() must end up agreeing with snapshot().
  assert.equal(after.filter((e) => e.type === 'turn_start').length, 1)
  const snap = await v.snapshot()
  assert.equal(snap.turns.length, 1)
  assert.equal(snap.turns[0]!.prompt, 'turn two')
  assert.equal(snap.compactionGeneration, 1)
})

test('SYNTHETIC: an unrecognised rewrite is a rewrite, not a compaction (#122)', async () => {
  // Records really did change here -- 'one' is gone -- so the derivations are withdrawn. What
  // is no longer claimed is that the participant lost context: counting a moved byte as a
  // compaction reported nine of them in one afternoon against a 1M-context seat whose
  // transcripts held zero markers.
  const p = join(SCRATCH, 'unmarked.jsonl')
  const user = (c: string) => JSON.stringify({ type: 'user', message: { content: c } }) + '\n'
  writeFileSync(p, user('one') + user('two'))
  const v = view(p, 'claude')
  const first = await v.poll()
  const firstSeqs = first.map((e) => e.seq)

  writeFileSync(p, user('two'))
  const after = await v.poll()
  const revision = after.find((e) => e.type === 'revision')!
  const unmarked = revision.provenance.find((p) => p.detail.includes('no compaction marker'))
  assert.ok(unmarked, 'an unexplained rewrite must say so')
  assert.equal(unmarked.caveat, true)

  assert.equal(revision.reason, 'rewrite', 'the event must be named for what was seen')
  assert.equal(v.compactionGeneration, 0, 'no compaction was declared, so none is counted')
  assert.equal(v.rewriteGeneration, 1, 'the rewrite is counted, on its own counter')
  assert.equal((await v.snapshot()).compactionGeneration, 0)

  // Still a revision in every other respect: stale evidence is withdrawn, not left standing.
  assert.deepEqual(
    [...revision.replaces].sort((a, b) => a - b),
    [...firstSeqs].sort((a, b) => a - b),
    'a rewrite still voids everything derived from the old bytes',
  )
  assert.ok(
    revision.provenance.some((p) => /rewrite 1/.test(p.detail)),
    'and reports which rewrite this was',
  )

  // Repeated churn accumulates on the rewrite counter and nowhere else.
  writeFileSync(p, user('three'))
  await v.poll()
  assert.equal(v.rewriteGeneration, 2)
  assert.equal(v.compactionGeneration, 0, 'churn never becomes a compaction by repetition')
})

/** The same record written a different way: key order reversed, recursively. */
function reserialize(v: any): any {
  if (Array.isArray(v)) return v.map(reserialize)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .reverse()
        .map((k) => [k, reserialize(v[k])]),
    )
  }
  return v
}

test('SYNTHETIC: reserialization plus an append is not an event at all (#122)', async () => {
  // The guard at the seam. The digest is a claim about BYTES; the records are what consumers
  // were told about. When every consumed record is still there, unchanged and in order,
  // nothing we said has become false -- so there is nothing to withdraw and no counter to
  // move, whatever the file did to its own formatting.
  const p = join(SCRATCH, 'reserialized.jsonl')
  const rec = (c: string) => ({ type: 'user', message: { role: 'user', content: c } })
  const line = (o: any) => JSON.stringify(o) + '\n'

  writeFileSync(p, line(rec('one')) + line(rec('two')))
  const v = view(p, 'claude')
  const first = await v.poll()
  assert.equal(first.filter((e) => e.type === 'turn_start').length, 2)
  const seqBefore = Math.max(...first.map((e) => e.seq))

  // Byte-for-byte different and semantically identical: reversed key order on the first
  // record, a trailing space on the second. Then genuinely new material after it.
  const rewritten =
    JSON.stringify(reserialize(rec('one'))) + '\n' + JSON.stringify(rec('two')) + ' \n'
  assert.notEqual(rewritten, line(rec('one')) + line(rec('two')), 'the bytes must really differ')
  writeFileSync(p, rewritten + line(rec('three')))

  const after = await v.poll()
  assert.equal(
    after.filter((e) => e.type === 'revision').length,
    0,
    'a reserialized prefix withdraws nothing, because nothing it said stopped being true',
  )
  assert.equal(v.compactionGeneration, 0, 'and no compaction is claimed')
  assert.equal(v.rewriteGeneration, 0, 'nor is it counted as a rewrite: no record changed')

  // Only the suffix is emitted. Re-emitting the prefix is the expensive half of the old
  // behaviour: it clears what consumers were told and makes them reconcile for nothing.
  const starts = after.filter((e) => e.type === 'turn_start')
  assert.equal(starts.length, 1, 'exactly the appended record')
  assert.equal(starts[0]!.prompt, 'three')
  assert.ok(Math.min(...after.map((e) => e.seq)) > seqBefore, 'seqs continue rather than restart')

  const snap = await v.snapshot()
  assert.deepEqual(
    snap.turns.map((t) => t.prompt),
    ['one', 'two', 'three'],
    'and the view is complete either way',
  )
})

test('SYNTHETIC: a mutated record is still a rewrite, and still withdraws (#122)', async () => {
  // The other side of the guard. Same record count, same order, one record whose content
  // changed under us -- what a consumer holds is now wrong, and it is told so.
  const p = join(SCRATCH, 'mutated.jsonl')
  const rec = (c: string) => ({ type: 'user', message: { role: 'user', content: c } })
  const line = (o: any) => JSON.stringify(o) + '\n'

  writeFileSync(p, line(rec('one')) + line(rec('two')))
  const v = view(p, 'claude')
  const first = await v.poll()
  const firstSeqs = first.map((e) => e.seq)

  writeFileSync(p, line(rec('ONE, changed in place')) + line(rec('two')))
  const after = await v.poll()

  const revision = after.find((e) => e.type === 'revision')
  assert.ok(revision, 'a mutated record must still produce a revision')
  assert.equal(revision.reason, 'rewrite')
  assert.equal(v.rewriteGeneration, 1)
  assert.equal(v.compactionGeneration, 0)
  assert.deepEqual(
    [...revision.replaces].sort((a, b) => a - b),
    [...firstSeqs].sort((a, b) => a - b),
    'everything derived from the old bytes is withdrawn',
  )
  assert.equal(
    after.filter((e) => e.type === 'turn_start').length,
    2,
    'and the surviving history is re-emitted so events() agrees with snapshot()',
  )
})

test('SYNTHETIC: a compaction declared in a reserialized suffix still counts (#122)', async () => {
  // The guard must not swallow the real signal. A marker arriving in the appended part is
  // counted exactly as it would be without the reserialization -- generation up, nothing
  // withdrawn, because the history is still there.
  const p = join(SCRATCH, 'reserialized-compaction.jsonl')
  const rec = (c: string) => ({ type: 'user', message: { role: 'user', content: c } })
  const line = (o: any) => JSON.stringify(o) + '\n'
  const marker =
    JSON.stringify({ type: 'attachment', attachment: { type: 'compact_file_reference' } }) + '\n'

  writeFileSync(p, line(rec('one')) + line(rec('two')))
  const v = view(p, 'claude')
  await v.poll()

  writeFileSync(
    p,
    JSON.stringify(reserialize(rec('one'))) + '\n' + line(rec('two')) + marker + line(rec('three')),
  )
  const after = await v.poll()

  assert.equal(v.compactionGeneration, 1, 'the marker counts wherever the bytes moved')
  assert.equal(v.rewriteGeneration, 0)
  const revision = after.find((e) => e.type === 'revision')
  assert.ok(revision)
  assert.equal(revision.reason, 'compaction')
  assert.deepEqual(revision.replaces, [], 'appended, so nothing is withdrawn')
})

test('SYNTHETIC: a rewrite raises no rotation candidate; a declared compaction does (#122)', async () => {
  // End to end, because the bug lived in the seam: the reconciler named an unexplained
  // rewrite `compaction`, and `detectDegradation` -- which reads that name and the
  // generation -- turned it into a rotation candidate. Either half alone looks fine.
  const churn = join(SCRATCH, 'no-candidate.jsonl')
  const user = (c: string) => JSON.stringify({ type: 'user', message: { content: c } }) + '\n'
  const marker =
    JSON.stringify({ type: 'attachment', attachment: { type: 'compact_file_reference' } }) + '\n'

  writeFileSync(churn, user('one') + user('two'))
  const v = view(churn, 'claude')
  const baseline = (await v.snapshot()).compactionGeneration
  // Take delivery of what the baseline read produced. A snapshot runs the same read as a poll
  // and banks the events for whoever asks next, so without this the `poll()` below would hand
  // back the baseline's two turns instead of the rewrite -- the history, not the change.
  await v.poll()

  // A byte-level rewrite with no marker anywhere in the result.
  writeFileSync(churn, user('two') + user('three'))
  const events = await v.poll()
  const snap = await v.snapshot()

  const d = detectDegradation({
    baselineGeneration: baseline,
    currentGeneration: snap.compactionGeneration,
    events,
  })
  assert.equal(d.degraded, false, 'a changed digest is not evidence that context was lost')
  assert.deepEqual(d.evidence, [])
  const verdict = assess({
    participant: 'implementer',
    prose: 'Done. Tests pass.',
    baselineGeneration: baseline,
    currentGeneration: snap.compactionGeneration,
    events,
    at: 1,
  })
  assert.equal(verdict.decision, 'continue')
  assert.equal(verdict.reason, 'nothing')

  // The same machinery, on a transcript that actually declares one.
  const real = join(SCRATCH, 'candidate.jsonl')
  writeFileSync(real, user('one') + user('two'))
  const w = view(real, 'claude')
  const realBaseline = (await w.snapshot()).compactionGeneration
  await w.poll()

  writeFileSync(real, marker + user('two'))
  const realEvents = await w.poll()
  const realSnap = await w.snapshot()

  assert.equal(realSnap.compactionGeneration, realBaseline + 1)
  const realD = detectDegradation({
    baselineGeneration: realBaseline,
    currentGeneration: realSnap.compactionGeneration,
    events: realEvents,
  })
  assert.equal(realD.degraded, true, 'a declared compaction is still the rotation trigger')
  assert.ok(realD.evidence.some((e) => /declares a compaction/.test(e)))
  assert.equal(
    assess({
      participant: 'implementer',
      prose: 'Done. Tests pass.',
      baselineGeneration: realBaseline,
      currentGeneration: realSnap.compactionGeneration,
      events: realEvents,
      at: 1,
    }).decision,
    'rotate',
  )
})

test('snapshot is authoritative and independent of what events() already said', async () => {
  const p = join(SCRATCH, 'snap.jsonl')
  const user = (c: string) => JSON.stringify({ type: 'user', message: { content: c } }) + '\n'
  writeFileSync(p, user('only turn'))

  // Never poll; snapshot must build the view itself.
  const v = view(p, 'claude')
  const snap = await v.snapshot()
  assert.equal(snap.turns.length, 1)
  assert.equal(snap.turns[0]!.state, 'in_progress')
  assert.equal(snap.guarantees.cancellationAttributable, true)
})

test('OBSERVED: the tail survives file REPLACEMENT, not just append and truncate', async () => {
  // A rotated or atomically-replaced transcript is a new inode at the same path. A
  // watcher holding a file descriptor would keep reading a file nobody writes to any
  // more and report silence forever. Re-resolving by path each poll is what avoids that.
  const p = join(SCRATCH, 'replaced.jsonl')
  const line = (c: string) => JSON.stringify({ type: 'user', message: { content: c } }) + '\n'
  writeFileSync(p, line('original'))

  const v = view(p, 'claude')
  const before = await v.poll()
  assert.equal(before.filter((e) => e.type === 'turn_start').length, 1)
  const inodeBefore = statSync(p).ino

  // Atomic replace: write a sibling, rename over the original.
  const tmp = join(SCRATCH, 'replaced.jsonl.new')
  writeFileSync(tmp, line('replacement one') + line('replacement two'))
  renameSync(tmp, p)
  assert.notEqual(statSync(p).ino, inodeBefore, 'the test must actually replace the inode')

  const after = await v.poll()
  const revision = after.find((e) => e.type === 'revision')
  assert.ok(revision, 'replacement must be treated as a rewrite')
  const snap = await v.snapshot()
  assert.deepEqual(
    snap.turns.map((t) => t.prompt),
    ['replacement one', 'replacement two'],
    'the view must follow the path, not the descriptor',
  )
})

test('OBSERVED: a transcript that does not exist yet is not an error', async () => {
  // SessionStart gives us the path before the file necessarily has content.
  const p = join(SCRATCH, 'not-yet.jsonl')
  const v = view(p, 'claude')
  assert.deepEqual(await v.poll(), [])
  const snap = await v.snapshot()
  assert.deepEqual(snap.turns, [])

  writeFileSync(p, JSON.stringify({ type: 'user', message: { content: 'appeared' } }) + '\n')
  const after = await v.poll()
  assert.equal(after.filter((e) => e.type === 'turn_start').length, 1)
})

test('an APPENDED compaction marker raises the generation (#10)', async (t) => {
  // The instrument bug behind every null result in the degradation experiment.
  //
  // The generation used to increment only when the tail reported a rewritten prefix. Claude
  // Code does not rewrite -- it appends `compact_file_reference` attachments and leaves the
  // history in place, verified against a real 57,493-line transcript carrying 37 of them.
  // So on Claude Code the counter could never move, and across four live runs and 34
  // assessments it never did. A true null and an instrument that cannot fire are
  // indistinguishable from outside, which made every negative unfalsifiable.
  const dir = tempDir(t, 'conclave-compact')
  const path = join(dir, 'transcript.jsonl')

  const user = (text: string) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
  const marker = JSON.stringify({ type: 'attachment', attachment: { type: 'compact_file_reference' } })

  writeFileSync(path, `${user('first')}\n`)
  const session = view(path, 'claude')
  await session.poll()
  assert.equal(session.compactionGeneration, 0, 'nothing has compacted yet')

  // Append only: every earlier byte is left exactly where it was.
  writeFileSync(path, `${user('first')}\n${marker}\n${user('second')}\n`)
  const events = await session.poll()

  assert.equal(session.compactionGeneration, 1, 'a declared compaction counts, however it was written')
  const revision = events.find((e) => e.type === 'revision')
  assert.ok(revision, 'and it is announced')
  assert.deepEqual(revision!.replaces, [], 'nothing is withdrawn: the history is still there')

  // A second marker is a second generation; a re-poll with nothing new is not.
  writeFileSync(path, `${user('first')}\n${marker}\n${user('second')}\n${marker}\n${user('third')}\n`)
  await session.poll()
  assert.equal(session.compactionGeneration, 2)
  await session.poll()
  assert.equal(session.compactionGeneration, 2, 'an append with no new marker changes nothing')
})

// --- concurrent reads: SYNTHETIC ----------------------------------------------------

test('SYNTHETIC: concurrent poll() and snapshot() neither duplicate nor skip records', async () => {
  // A view has two readers in a live session and always did: the adapter's tail loop calls
  // `poll()` on an interval, and the deadline re-check calls `snapshot()` whenever a turn's
  // clock fires. Nothing made those two take turns, and neither one is atomic --
  // `RewriteAwareTail.poll()` awaits a stat, then a prefix digest, then a range read, and only
  // then advances its offset.
  //
  // Land a second reader anywhere inside that window and it reads the same range as the first:
  // both return the same records, both push them into `#records`, and the parser is handed a
  // history in which the child said everything twice. Land it the other way, after the offset
  // moved but before the caller's own stat, and it consumes nothing while believing it has
  // caught up -- the same records, skipped.
  //
  // Both directions are checked here from the OUTSIDE, on the events and the snapshot, because
  // that is where a consumer would meet them: a duplicated turn is a turn the relay believes
  // happened twice, and a skipped one is prose the peer never receives.
  const p = join(SCRATCH, 'concurrent-reads.jsonl')
  const user = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
  const done = (text: string) =>
    JSON.stringify({
      type: 'assistant',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
    }) + '\n'

  const TURNS = 12
  const prompts = Array.from({ length: TURNS }, (_, i) => `prompt ${i}`)
  const answers = Array.from({ length: TURNS }, (_, i) => `answer ${i}`)

  // Half the history before the first read, half appended while reads are in flight: the first
  // half exercises the duplicate direction (many readers over the same unconsumed range) and the
  // second the skip direction (readers arriving either side of an append).
  const half = TURNS / 2
  const chunk = (from: number, to: number) =>
    prompts.slice(from, to).map((q, i) => user(q) + done(answers[from + i]!)).join('')
  writeFileSync(p, chunk(0, half))

  const v = view(p, 'claude')
  const events: AgentEvent[] = []
  const snapshots: SessionSnapshot[] = []

  // Started in one tick and never awaited between: this is the interleaving, not a simulation of
  // one. `Promise.all` over already-created promises -- calling them lazily inside the map would
  // still start them all before the first await resolves, but starting them explicitly here
  // makes it impossible to mistake for a sequential loop.
  //
  // The view now answers all of them from ONE read -- callers attach to the operation in flight
  // rather than each starting their own (`reconcile.ts`, `#inflight`) -- so the duplicate
  // direction is closed by construction here rather than by winning a race. The skip direction
  // is not: the append below lands under a read that is already running, and whether those
  // records are picked up by that read or the next one, the deltas still have to add up.
  const inFlight: Promise<unknown>[] = []
  for (let i = 0; i < 8; i++) {
    inFlight.push(v.poll().then((e) => events.push(...e)))
    inFlight.push(v.snapshot().then((s) => snapshots.push(s)))
  }
  // Written from underneath the readers, mid-flight, with no coordination at all.
  appendFileSync(p, chunk(half, TURNS))
  for (let i = 0; i < 8; i++) {
    inFlight.push(v.poll().then((e) => events.push(...e)))
    inFlight.push(v.snapshot().then((s) => snapshots.push(s)))
  }
  await Promise.all(inFlight)

  // Drain anything the last append left unread, so the accounting below covers the whole file
  // rather than however much the concurrent burst happened to reach.
  events.push(...(await v.poll()))
  const final = await v.snapshot()

  // --- not duplicated ---------------------------------------------------------------
  //
  // Claude keys transcript turns positionally, so a record consumed twice is not a repeated key
  // -- it is EXTRA keys, and the count is the tell.
  assert.equal(final.turns.length, TURNS, `the file holds ${TURNS} turns and the view must hold ${TURNS}`)
  assert.deepEqual(
    final.turns.map((t) => t.prompt),
    prompts,
    'in order, once each: a doubled read shows up here as the whole history repeated',
  )

  const starts = events.filter((e) => e.type === 'turn_start')
  assert.equal(starts.length, TURNS, 'every turn is announced exactly once across every reader')
  assert.deepEqual(
    starts.map((e) => e.prompt),
    prompts,
    'and in file order, whichever reader happened to see each one first',
  )

  const seqs = events.map((e) => e.seq)
  assert.equal(new Set(seqs).size, seqs.length, 'no sequence number is issued twice')

  // --- not skipped ------------------------------------------------------------------
  //
  // Message events are DELTAS against what has already been emitted, so concatenating them per
  // turn reconstructs exactly what the child wrote -- if nothing was lost, and if nothing was
  // counted twice. Either failure shows up as a mismatch here, which is why this is the check
  // that covers both directions at once.
  const said = new Map<string, string>()
  for (const e of events) {
    if (e.type !== 'message') continue
    said.set(String(e.turnKey), (said.get(String(e.turnKey)) ?? '') + e.text)
  }
  assert.deepEqual(
    final.turns.map((t) => said.get(String(t.key)) ?? ''),
    answers,
    'the deltas add up to what the child wrote, once',
  )

  const ends = events.filter((e) => e.type === 'turn_end')
  assert.equal(ends.length, TURNS, 'each completed turn ends exactly once')

  // --- every snapshot was a real state ----------------------------------------------
  //
  // A snapshot taken while another read was mid-flight must still be a prefix of the file, in
  // order: never a partial rebuild, never a history with a hole in it.
  for (const snap of [...snapshots, final]) {
    assert.deepEqual(
      snap.turns.map((t) => t.prompt),
      prompts.slice(0, snap.turns.length),
      'a snapshot is the file up to some point, and nothing else',
    )
  }
  assert.equal(snapshots.length, 16, 'precondition: every concurrent caller was answered, none rejected')
  assert.ok(
    snapshots.some((s) => s.turns.length >= half),
    'precondition: the burst ran against a view that had really read the file',
  )
  assert.equal(
    final.turns.length,
    TURNS,
    'and the append made under the readers is picked up, by that read or by the next one',
  )
})
