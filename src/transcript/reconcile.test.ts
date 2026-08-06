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
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TranscriptSessionView } from './reconcile.ts'
import { parseClaude, parseCodex } from './parse.ts'
import { guaranteesFor } from '../contract/session.ts'
import { RewriteAwareTail, parseJsonLine } from './tail.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'reconcile-'))

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

test('SYNTHETIC: an unrecognised rewrite is flagged as a caveat, not asserted as compaction', async () => {
  const p = join(SCRATCH, 'unmarked.jsonl')
  const user = (c: string) => JSON.stringify({ type: 'user', message: { content: c } }) + '\n'
  writeFileSync(p, user('one') + user('two'))
  const v = view(p, 'claude')
  await v.poll()

  writeFileSync(p, user('two'))
  const after = await v.poll()
  const revision = after.find((e) => e.type === 'revision')!
  const unmarked = revision.provenance.find((p) => p.detail.includes('no compaction marker'))
  assert.ok(unmarked, 'an unexplained rewrite must say so')
  assert.equal(unmarked.caveat, true)
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
