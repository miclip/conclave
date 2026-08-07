/**
 * The degradation trigger, driven by a REAL transcript rather than a fake that sets the
 * counter directly.
 *
 * Every existing rotation test calls `FakeRotationSession.compact()`, which assigns
 * `compactionGeneration` itself. That proves rotation fires WHEN the generation moves, and
 * says nothing about whether anything can move it. The link it skips is the one that was
 * broken: a real transcript declaring a compaction has to reach `snapshot()` as a raised
 * generation.
 *
 * It did not, on Claude Code, for as long as the feature has existed. `#compactionGeneration`
 * incremented only when the tail found the file's PREFIX changed, and Claude Code appends its
 * `compact_file_reference` marker rather than rewriting around it. So the counter was pinned
 * at 0 through 34 assessments across four live runs, and every negative result the
 * degradation experiment collected was taken with an instrument that could not register a
 * positive.
 *
 * This is the test that would have caught it: inject a compaction into a transcript the way a
 * CLI actually writes one, and require the trigger to fire.
 *
 *   node --test src/rotation/injectedDegradation.test.ts
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { guaranteesFor } from '../contract/session.ts'
import { TranscriptSessionView } from '../transcript/reconcile.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-injected-'))
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  return dir
}

/** A transcript record as Claude Code writes one. */
const userRecord = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } })

/** The marker Claude Code appends when it compacts. Not a rewrite: the history stays. */
const COMPACTION = JSON.stringify({
  type: 'attachment',
  attachment: { type: 'compact_file_reference' },
})

function viewOver(path: string): TranscriptSessionView {
  return new TranscriptSessionView({
    path,
    agent: 'claude',
    sessionId: 'injected',
    cwd: '/tmp',
    guarantees: guaranteesFor('mediated'),
  })
}

test('an injected compaction raises the generation a snapshot reports', async () => {
  const dir = repo()
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, `${userRecord('do the work')}\n`)

  const view = viewOver(path)
  await view.poll()
  assert.equal((await view.snapshot()).compactionGeneration, 0, 'baseline')

  // Exactly how a real CLI records it: appended, with every earlier byte untouched.
  appendFileSync(path, `${COMPACTION}\n${userRecord('carry on')}\n`)
  await view.poll()

  const snap = await view.snapshot()
  assert.equal(snap.compactionGeneration, 1, 'the trigger can fire at all')
})

test('the generation a snapshot reports is what degradation is measured against', async () => {
  // The relay compares `impl.baselineGeneration` with `snap.compactionGeneration`. Both come
  // from here, so a counter that cannot move makes `assess` structurally unable to see
  // degradation -- which is what "34 assessments, zero degraded" was actually measuring.
  const dir = repo()
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, `${userRecord('first')}\n`)

  const view = viewOver(path)
  await view.poll()
  const baseline = (await view.snapshot()).compactionGeneration

  for (let i = 0; i < 3; i++) {
    appendFileSync(path, `${COMPACTION}\n${userRecord(`turn ${i}`)}\n`)
    await view.poll()
  }

  const current = (await view.snapshot()).compactionGeneration
  assert.equal(baseline, 0)
  assert.equal(current, 3, 'three compactions, three generations')
  assert.ok(current > baseline, 'which is the comparison the relay actually makes')
})

test('a rewrite and an append are both compactions, and both count', async () => {
  // Codex rewrites, Claude Code appends. Rotation cares that context was DISCARDED, not how
  // the CLI chose to write it down -- counting only rewrites made the trigger a property of
  // one vendor's file format.
  const dir = repo()
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, `${userRecord('first')}\n`)

  const view = viewOver(path)
  await view.poll()

  appendFileSync(path, `${COMPACTION}\n${userRecord('after append')}\n`)
  await view.poll()
  const afterAppend = (await view.snapshot()).compactionGeneration

  // Now a genuine rewrite: the prefix changes under us.
  writeFileSync(path, `${userRecord('rewritten history')}\n`)
  await view.poll()
  const afterRewrite = (await view.snapshot()).compactionGeneration

  assert.equal(afterAppend, 1)
  assert.ok(afterRewrite > afterAppend, 'a rewrite still counts, as it always did')
})

test('polling with nothing new does not inflate the generation', async () => {
  // The failure in the other direction. A counter that climbed on every poll would make
  // degradation fire constantly, and a trigger that always fires is as useless as one that
  // never does -- worse, because it looks like it is working.
  const dir = repo()
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, `${userRecord('first')}\n${COMPACTION}\n`)

  const view = viewOver(path)
  await view.poll()
  const first = (await view.snapshot()).compactionGeneration

  for (let i = 0; i < 5; i++) await view.poll()
  assert.equal((await view.snapshot()).compactionGeneration, first, 'unchanged by re-polling')
})
