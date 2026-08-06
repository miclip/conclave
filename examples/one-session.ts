#!/usr/bin/env node
/**
 * Drive one real agent session through the registry, and print what the adapter can
 * honestly say about the turn.
 *
 * This is the whole of what Conclave can do today: a single participant, driven
 * programmatically, with a terminal verdict that carries its own evidence. There is no
 * relay, no second child, no orchestrator. It exists so "the adapters work" is something
 * you can run rather than something you have to take on trust.
 *
 *   node examples/one-session.ts                          # claude
 *   node examples/one-session.ts codex                    # codex
 *   node examples/one-session.ts claude "your prompt"
 *
 * Spawns a real session and uses real quota.
 */

import { formatVerdict } from '../src/contract/outcome.ts'
import type { AgentEvent } from '../src/contract/session.ts'
import { defaultRegistry } from '../src/registry/builtin.ts'

const agent = process.argv[2] ?? 'claude'
const prompt =
  process.argv[3] ?? 'Reply with exactly DEMO-N and nothing else, where N is 41 plus 1. No tools.'

const registry = defaultRegistry()
console.log(`agents available: ${registry.listAvailable().map((a) => a.id).join(', ')}\n`)

// createParticipant runs the agent's preflight first -- for Codex that refuses to build a
// session whose hooks are registered but not trusted, since it would have no
// turn-completion signal at all.
const session = await registry.createParticipant(
  { id: 'demo', agent, role: 'implementer' },
  { cwd: process.cwd() },
)

console.log(`${agent}: session started, input ownership ${session.guarantees.inputOwnership}`)

const events: AgentEvent[] = []
void (async () => {
  for await (const e of session.events()) events.push(e)
})()

console.log(`> ${prompt}\n`)
await session.send(prompt, { kind: 'orchestrator' })

// Wait for a terminal verdict, then a moment longer in case stronger evidence revises it.
const deadline = Date.now() + 180_000
while (Date.now() < deadline && !events.some((e) => e.type === 'turn_end')) {
  await new Promise((r) => setTimeout(r, 200))
}
await new Promise((r) => setTimeout(r, 3000))

for (const e of events) {
  if (e.type === 'turn_end') {
    console.log(`turn_end   ${formatVerdict(e.verdict)}`)
    console.log(`           synthesized=${e.synthesized}`)
  } else if (e.type === 'revision') {
    console.log(`revision   withdrew seq ${e.replaces.join(', ')} — ${e.reason}`)
  }
}

const snap = await session.snapshot()
console.log('\nsnapshot (authoritative, rebuilt from the transcript):')
for (const t of snap.turns) {
  console.log(`  ${t.state.padEnd(20)} ${t.confidence ?? '-'}   ${JSON.stringify(t.assistantText ?? '').slice(0, 60)}`)
}

await session.close('graceful')
