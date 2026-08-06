#!/usr/bin/env python3
"""
The hook command itself. Registered for SessionStart and Stop on both CLIs.

Contract for step 2:
  - the POST body is the hook's stdin, byte-for-byte unchanged (these are fixtures;
    normalisation is step 3/4's problem, not ours)
  - all envelope metadata travels in X-Spike-* headers so the body stays pristine
  - every invocation is journalled locally BEFORE and AFTER the POST, so when the
    receiver is down we can still tell what the CLI actually fired

stdout is kept empty on purpose. Both CLIs treat SessionStart stdout as context to
inject; step 2 is observation only.

Behaviour knobs (env):
  SPIKE_HOOK_URL       receiver endpoint            (default http://127.0.0.1:8787/hook)
  SPIKE_HOOK_JOURNAL   local ground-truth NDJSON    (default alongside this file)
  SPIKE_HOOK_TIMEOUT   POST timeout, seconds        (default 5)
  SPIKE_HOOK_DELAY     sleep before exiting         (default 0) -- probes TUI blocking
  SPIKE_HOOK_EXIT      forced exit code             (default 0) -- probes error handling
  SPIKE_RUN_ID         correlates a spawned child's events; absent for the orchestrator's
                       own session, which is how we keep our fixtures uncontaminated
  SPIKE_CLI_VERSION    recorded verbatim; the payload does not carry it
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
# NOT the frozen corpus. spikes/hooks/journal/hook-journal.ndjson is labelled evidence
# behind the parity test's exact 17/4 counts, and this hook runs for ANY agent session in
# this checkout -- including an unrelated one a developer happens to be running. Pointing
# the default here meant ordinary sessions silently appended to committed evidence.
# A deliberate spike run sets SPIKE_HOOK_JOURNAL explicitly; everything else lands in an
# ad-hoc, git-ignored file.
DEFAULT_JOURNAL = os.path.join(HERE, "journal", "adhoc.ndjson")


def journal(path, record):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # O_APPEND + single write keeps concurrent hook processes from interleaving.
        line = (json.dumps(record, sort_keys=True) + "\n").encode()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        try:
            os.write(fd, line)
        finally:
            os.close(fd)
    except OSError:
        pass  # never let journalling take the CLI down


def main():
    agent = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    started = time.time()
    body = sys.stdin.buffer.read()

    # Parse only to label the journal/fixture. The bytes we POST are untouched.
    event = "unknown"
    session_id = None
    try:
        parsed = json.loads(body or b"{}")
        event = parsed.get("hook_event_name") or parsed.get("hookEventName") or "unknown"
        session_id = parsed.get("session_id") or parsed.get("sessionId")
    except (ValueError, AttributeError):
        pass

    url = os.environ.get("SPIKE_HOOK_URL", "http://127.0.0.1:8787/hook")
    jpath = os.environ.get("SPIKE_HOOK_JOURNAL", DEFAULT_JOURNAL)
    timeout = float(os.environ.get("SPIKE_HOOK_TIMEOUT", "5"))
    delay = float(os.environ.get("SPIKE_HOOK_DELAY", "0"))
    forced_exit = int(os.environ.get("SPIKE_HOOK_EXIT", "0"))
    run_id = os.environ.get("SPIKE_RUN_ID", "")
    cli_version = os.environ.get("SPIKE_CLI_VERSION", "")

    base = {
        "agent": agent,
        "event": event,
        "session_id": session_id,
        "run_id": run_id,
        "cli_version": cli_version,
        "hook_pid": os.getpid(),
        "hook_ppid": os.getppid(),
        "cwd": os.getcwd(),
        "body_bytes": len(body),
        "fired_at": started,
        "fired_at_iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(started))
        + f".{int(started % 1 * 1e6):06d}",
    }

    # Fire-side record: written before the POST so a receiver outage still leaves
    # evidence that the CLI invoked us.
    journal(jpath, dict(base, phase="fired", body=body.decode("utf8", "replace")))

    headers = {
        "Content-Type": "application/json",
        "X-Spike-Agent": agent,
        "X-Spike-Event": event,
        "X-Spike-Run-Id": run_id,
        "X-Spike-Session-Id": session_id or "",
        "X-Spike-Cli-Version": cli_version,
        "X-Spike-Hook-Pid": str(os.getpid()),
        "X-Spike-Hook-Ppid": str(os.getppid()),
        "X-Spike-Cwd": os.getcwd(),
        "X-Spike-Sent-At": repr(started),
    }

    status, error = None, None
    try:
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            resp.read()
    except urllib.error.HTTPError as e:
        status, error = e.code, f"http {e.code}"
    except Exception as e:
        error = f"{type(e).__name__}: {e}"

    if delay > 0:
        time.sleep(delay)

    journal(
        jpath,
        dict(
            base,
            phase="posted",
            http_status=status,
            post_error=error,
            delay_s=delay,
            exit_code=forced_exit,
            duration_ms=round((time.time() - started) * 1000, 1),
        ),
    )

    # Deliberately silent on stdout. stderr only when something went wrong, so we can
    # see whether the CLI surfaces hook failures to the user at all.
    if error:
        print(f"[spike-hook] {agent}/{event} POST failed: {error}", file=sys.stderr)

    return forced_exit


if __name__ == "__main__":
    sys.exit(main())
