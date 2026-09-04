/**
 * Reading OpenCode's `/event` stream, which is where everything this adapter knows comes from.
 *
 * The run-per-turn adapter learns what a turn did by waiting for a process to exit and parsing
 * its stdout. This one is told, continuously, by a server that is already tracking it — so the
 * whole adapter is a consumer of this stream, and its failure modes are this file's failure
 * modes.
 *
 * NOT `EventSource`. Node has one now, but it reconnects on its own schedule with its own
 * backoff and surfaces neither decision — and a transport that silently reconnects is one that
 * can silently MISS, which is the difference between "the seat is quiet" and "we stopped
 * listening". The caller here is told when the stream ends and decides what that means.
 */

/** One `data:` frame, parsed. OpenCode sends a JSON object per event and no other field. */
export interface ServerEvent {
  /** OpenCode's own event id, kept so a consumer can say which frame it acted on. */
  id?: string
  /** Dotted name: `session.idle`, `message.part.delta`, `server.heartbeat`. */
  type: string
  properties?: Record<string, unknown>
}

/**
 * Split a byte stream into SSE frames and yield the JSON in each `data:` line.
 *
 * FRAMES ARE SEPARATED BY A BLANK LINE and may be split across chunks anywhere -- mid-frame,
 * mid-line, mid-UTF-8-character. The buffer is therefore held as a string decoded incrementally,
 * and only complete frames are emitted; a partial tail survives to the next chunk.
 *
 * A frame whose data is not JSON is DROPPED rather than thrown on. The stream carries comments
 * (`: keep-alive`) and may gain fields this parser does not know, and an adapter that dies on an
 * unfamiliar frame is one that dies when the server is upgraded under it.
 */
export async function* readServerEvents(
  body: AsyncIterable<Uint8Array>,
  onDropped?: (raw: string, why: string) => void,
): AsyncGenerator<ServerEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    // `\n\n` is the frame separator. `\r\n\r\n` is legal too, so both are normalised first.
    buffer = buffer.replace(/\r\n/g, '\n')
    let cut = buffer.indexOf('\n\n')
    while (cut >= 0) {
      const frame = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      const parsed = frameToEvent(frame, onDropped)
      if (parsed) yield parsed
      cut = buffer.indexOf('\n\n')
    }
  }
  // A final frame with no trailing blank line, which is what a server closing cleanly produces.
  const last = frameToEvent(buffer.replace(/\r\n/g, '\n'), onDropped)
  if (last) yield last
}

function frameToEvent(frame: string, onDropped?: (raw: string, why: string) => void): ServerEvent | undefined {
  // A frame may carry several `data:` lines, which the spec says to join with newlines. OpenCode
  // sends one, and joining is still correct for one.
  const data = frame
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart())
    .join('\n')
  if (data === '') return undefined
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    onDropped?.(data, 'not JSON')
    return undefined
  }
  if (typeof value !== 'object' || value === null) {
    onDropped?.(data, 'not an object')
    return undefined
  }
  const type = (value as Record<string, unknown>)['type']
  if (typeof type !== 'string') {
    // Every frame observed carries one, and a frame without it cannot be dispatched on. Reporting
    // rather than guessing: a consumer that invented a type here would attribute the properties
    // of an unknown event to a known one.
    onDropped?.(data, 'no type')
    return undefined
  }
  const id = (value as Record<string, unknown>)['id']
  const properties = (value as Record<string, unknown>)['properties']
  return {
    ...(typeof id === 'string' ? { id } : {}),
    type,
    ...(typeof properties === 'object' && properties !== null ? { properties: properties as Record<string, unknown> } : {}),
  }
}
