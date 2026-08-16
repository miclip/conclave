/**
 * Terminating the CLI without cutting its own output off mid-sentence.
 *
 * `process.exit()` does not flush. On a TTY, writes to stdout are synchronous, so nothing is
 * ever pending and the bug is invisible. On a PIPE they are not: the kernel takes the first
 * 64 KiB, Node buffers the rest, and `process.exit()` throws that buffer away. `conclave
 * sessions --json` over 200 records produced exactly 65,536 bytes of unparseable JSON
 * through a pipe and 115,203 valid bytes when redirected to a file -- the same command, the
 * same records, and the only difference was what stdout happened to be connected to.
 *
 * That makes it a defect of process termination rather than of any one command. Every
 * `--json` path (`sessions`, `sessions --prune`, `status`, `guard`, `config check`,
 * `config show`, relay's dry-run, detach and final payloads) and the NDJSON of `events`
 * share the single exit at the bottom of the entry point, so they are all fixed here at
 * once and none of them has to know about it.
 *
 * The exit code is preserved exactly. Nothing about WHICH code is chosen belongs here.
 */

/**
 * Resolve once `stream` has actually handed its buffer to the OS.
 *
 * Deliberately unbounded. A timeout would reintroduce the bug for the exact case it is
 * supposed to fix -- a reader slower than the writer -- and would do it nondeterministically,
 * which is worse than the honest truncation we started with. Blocking until the reader
 * consumes is what every other well-behaved Unix program does; a consumer that stalls
 * stalls `cat` too. The closed-reader case does not hang: the write fails, the callback
 * still fires, and the exit proceeds.
 */
function flush(stream: NodeJS.WriteStream | undefined): Promise<void> {
  // Nothing pending is the common case: a TTY writes synchronously, and so does a small
  // payload to a pipe. Checking first keeps the exit path free of an extra event-loop turn.
  if (!stream || stream.writableLength === 0) return Promise.resolve()
  if (stream.writableEnded || stream.destroyed || stream.errored) return Promise.resolve()

  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    /**
     * Whichever comes first, and all three are possible: the buffer drains, the stream
     * errors, or the stream closes underneath us. `finish` is idempotent because more than
     * one of them does arrive -- EPIPE reaches the write callback and then closes the stream.
     *
     * The invariant, stated exactly: THE ERROR LISTENER MUST SURVIVE THE WRITE CALLBACK
     * SETTLING THE PROMISE. `conclave sessions --json | head -1` closes the read end while
     * ~50 KiB is still queued, and Node reports the resulting EPIPE TWICE -- once to the
     * write callback and once as an `error` event, in that order. Settle on the callback and
     * then REMOVE this listener and the event has nowhere to land: a clean `| head` becomes
     * an unhandled-error stack trace and a non-zero exit. Adding `off('error', finish)`
     * inside `finish` reproduces exactly that, and fails the "reader that stops early" test
     * in `sessionsCli.test.ts` on every run.
     *
     * `once` would also be correct, and was measured to be -- it only detaches after firing,
     * so a listener that has not fired is still there for the error event. `on` is the more
     * conservative of the two equals: it also handles a second error, which `once` would
     * not, and it makes the invariant true by construction rather than by argument.
     *
     * A separate blanket `on('error', () => {})` over both streams was tried alongside this
     * and removed as redundant: the listener below is already attached to the same stream and
     * is already permanent, so it handles the `error` event whenever it arrives and a second
     * handler adds nothing. Not because the event loses a race with `process.exit` -- the
     * `off` mutation above shows the event can and does arrive first. Handling it here, on a
     * listener that has to exist anyway, is what makes the extra one unnecessary.
     *
     * Staying attached costs nothing: by the time either can fire the exit code is decided
     * and the output is already lost, so there is nothing left that could act on them.
     */
    stream.on('error', finish)
    stream.on('close', finish)
    // An empty write is ordered behind everything already queued, so its callback is the
    // cheapest true "the buffer is gone" signal. `drain` is not a substitute: it only fires
    // if some earlier write returned false, and a 60 KiB backlog under the high-water mark
    // never does.
    try {
      stream.write('', finish)
    } catch {
      // A stream torn down between the guard above and here. Nothing left to wait for.
      finish()
    }
  })
}

/**
 * Exit with `code` once stdout and stderr have actually left this process.
 *
 * `process.exitCode` is set before the wait, so that a stream teardown or anything else
 * that ends the process mid-flush still ends it with the code the command chose. The
 * explicit `process.exit` afterwards is not redundant: letting the event loop drain
 * naturally would be tidier, but a CLI that spawns PTYs and holds sockets can be left with
 * a live handle, and hanging is a worse failure than stopping hard.
 */
export async function exitAfterFlush(code: number): Promise<never> {
  process.exitCode = code
  await Promise.all([flush(process.stdout), flush(process.stderr)])
  process.exit(code)
}
