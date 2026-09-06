/**
 * What `childenv.ts` asserts about Claude Code, checked against the installed binary (#238).
 *
 * The guard strips `CLAUDE_CODE_CHILD_SESSION` because inheriting it means the child writes no
 * transcript — the adapter's recovery and audit path — and the loss is silent. That is worth
 * being sure of, because the cost of being wrong runs both ways: keeping a pointless guard is
 * cheap, and removing a real one loses data in a way that surfaces later looking like a parser
 * bug.
 *
 * The claim is also MODE-DEPENDENT, which the comment did not say. It holds in the interactive
 * pty this adapter drives and does NOT hold under `claude --print`. So the obvious way to check
 * it — `--print`, two minutes — returns the wrong answer, and a reader who checks it that way
 * removes the guard. The behavioural halves are in `claude.live.test.ts`, where a real session
 * can be spawned; this file holds the cheap half that runs everywhere.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { isParentAgentVar, sanitizedCopy, TRANSCRIPT_KILLING_VARS } from './childenv.ts'
import { ABSENT_LITERAL_CANARY, installedBundle } from '../registry/installedBundle.ts'

test('#238 the variable childenv strips is still one Claude Code reads', () => {
  // If this name ever stops appearing in the bundle, the guard is protecting against something
  // the program no longer knows about, and the comment justifying it has become archaeology.
  // That is the state this file exists to notice; it is not by itself a reason to remove it.
  const bundle = installedBundle('claude')
  if ('why' in bundle) return

  assert.equal(
    bundle.bytes.includes(ABSENT_LITERAL_CANARY),
    false,
    'the canary must be absent, or this search matches anything and proves nothing',
  )
  for (const name of TRANSCRIPT_KILLING_VARS) {
    assert.ok(
      bundle.bytes.includes(name),
      `${name} no longer appears in ${bundle.at}: childenv.ts strips a variable the installed ` +
        `Claude Code may no longer read (#238)`,
    )
  }
})

test('#238 every transcript-killing var is one the stripper actually strips', () => {
  // The list is only worth anything if `isParentAgentVar` agrees with it. A name added here
  // that no prefix matches would be documented as destructive and passed straight through.
  for (const name of TRANSCRIPT_KILLING_VARS) {
    assert.ok(isParentAgentVar(name), `${name} is named as destructive but nothing strips it`)
  }
})

test('#238 a leak of the destructive var says what it would have cost', () => {
  // `TRANSCRIPT_KILLING_VARS` was exported and read by nothing — dead code asserting a fact,
  // which is the shape that rots with nothing failing. It is wired into the failure path now,
  // so the distinction it draws is load-bearing rather than decorative.
  // Through `extra`, which is the only way in: the source is filtered first, and `extra` is
  // assigned afterwards. That is exactly the path a caller could get wrong by hand.
  const leak = () => sanitizedCopy({}, { extra: { CLAUDE_CODE_CHILD_SESSION: '1' } })
  assert.throws(leak, (e: Error) => {
    assert.match(e.message, /leaked into child env/)
    assert.match(e.message, /CLAUDE_CODE_CHILD_SESSION/)
    assert.match(e.message, /no transcript at all in pty mode/)
    return true
  })
})
