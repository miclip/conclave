#!/usr/bin/env python3
"""
Spike 1 (build order step 1): can we drive the real interactive TUI under a PTY?

Success criteria:
  a) the child boots its FULL interactive TUI, not a headless/piped mode
  b) bytes written to the PTY master arrive as keystrokes
  c) the prompt is actually submitted and the agent answers

(a) is proven by the alternate-screen-buffer enter sequence, which these CLIs only
emit when they believe they own a real terminal. (b) and (c) are proven by asking
for a unique marker back and finding it in the output stream.

This deliberately does NOT parse the screen for meaning -- screen scraping is out of
scope for the orchestrator. We look for byte-level evidence and nothing more.

Raw output is teed to a log so the boot sequence can be inspected afterwards.
"""

import argparse
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

# Claude Code 2.1.222 does NOT use the alternate screen buffer -- it renders inline
# with cursor-addressed partial redraws. So alt-screen is the wrong test for "is this
# the real interactive TUI". Bracketed paste is the decisive one: a piped/headless run
# has no reason to enable it, an interactive raw-mode line editor always does.
TUI_MARKERS = {
    "alt_screen": b"\x1b[?1049h",
    "bracketed_paste": b"\x1b[?2004h",
    "focus_events": b"\x1b[?1004h",
    "hide_cursor": b"\x1b[?25l",
    "mouse_tracking": b"\x1b[?1000h",
}
DECISIVE_TUI_MARKERS = ("bracketed_paste", "focus_events")

# These leak from a parent agent process and change child behaviour. Most importantly
# CLAUDE_CODE_CHILD_SESSION makes Claude Code disable transcript persistence entirely,
# which would silently break the orchestrator's whole output path.
ENV_SCRUB_PREFIXES = ("CLAUDE", "CODEX", "ANTHROPIC_", "OPENAI_")
ENV_SCRUB_EXACT = ("CI", "AI_AGENT", "NO_COLOR", "TERM_PROGRAM", "TERM_PROGRAM_VERSION")

ANSI_RE = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[]P^_].*?(?:\x07|\x1b\\)|\x1b[@-Z\\-_]", re.S)


def strip_ansi(data: bytes) -> bytes:
    return ANSI_RE.sub(b"", data)


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def spawn(argv, cwd, rows=40, cols=120):
    """Fork the child onto the slave side of a new PTY, with a controlling terminal."""
    master, slave = pty.openpty()
    set_winsize(slave, rows, cols)

    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(ENV_SCRUB_PREFIXES) and k not in ENV_SCRUB_EXACT
    }
    env["TERM"] = "xterm-256color"
    env["COLUMNS"] = str(cols)
    env["LINES"] = str(rows)

    pid = os.fork()
    if pid == 0:
        try:
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            os.dup2(slave, 0)
            os.dup2(slave, 1)
            os.dup2(slave, 2)
            os.close(master)
            if slave > 2:
                os.close(slave)
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        except Exception:
            pass
        os._exit(127)

    os.close(slave)
    os.set_blocking(master, False)
    return pid, master


class Reader:
    """Accumulates raw PTY output and tees it to a log file."""

    def __init__(self, fd, logpath):
        self.fd = fd
        self.buf = bytearray()
        self.log = open(logpath, "wb")
        self.eof = False
        self.last_read_at = time.monotonic()

    def pump(self, timeout=0.1) -> int:
        """Read whatever is available. Returns bytes read this call."""
        try:
            r, _, _ = select.select([self.fd], [], [], timeout)
        except (OSError, ValueError):
            self.eof = True
            return 0
        if not r:
            return 0
        try:
            chunk = os.read(self.fd, 65536)
        except OSError:
            # EIO on macOS means the slave side closed: child is gone.
            self.eof = True
            return 0
        if not chunk:
            self.eof = True
            return 0
        self.buf.extend(chunk)
        self.log.write(chunk)
        self.log.flush()
        self.last_read_at = time.monotonic()
        return len(chunk)

    def wait_for(self, needle: bytes, timeout: float, since: int = 0) -> bool:
        """Pump until `needle` appears in the raw stream (or timeout)."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.buf.find(needle, since) != -1:
                return True
            self.pump(0.1)
            if self.eof:
                break
        return self.buf.find(needle, since) != -1

    def wait_for_text(self, needle: bytes, timeout: float, since: int = 0) -> bool:
        """Same, but ANSI-stripped and whitespace-collapsed, so TUI line-wrapping
        and redraws don't hide a match."""
        deadline = time.monotonic() + timeout
        squashed_needle = re.sub(rb"\s+", b"", needle)
        while True:
            hay = re.sub(rb"\s+", b"", strip_ansi(bytes(self.buf[since:])))
            if squashed_needle in hay:
                return True
            if time.monotonic() >= deadline or self.eof:
                return False
            self.pump(0.2)

    def wait_quiet(self, quiet_for: float, max_wait: float) -> None:
        """Pump until the child stops emitting for `quiet_for` seconds."""
        deadline = time.monotonic() + max_wait
        while time.monotonic() < deadline:
            self.pump(0.1)
            if self.eof:
                return
            if time.monotonic() - self.last_read_at >= quiet_for:
                return

    def close(self):
        self.log.close()


def teardown(pid, fd, reader):
    """Ask nicely (Ctrl-C twice / ESC), then insist."""
    for keys in (b"\x03", b"\x03", b"\x1b"):
        try:
            os.write(fd, keys)
        except OSError:
            break
        time.sleep(0.35)
        reader.pump(0.1)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            break
        for _ in range(20):
            wpid, _status = os.waitpid(pid, os.WNOHANG)
            if wpid:
                return
            time.sleep(0.1)
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass


def find_transcript(globs, since_ts, needle: bytes):
    """Locate a transcript file touched after `since_ts` that contains `needle`.
    This is the honest check for 'the agent really answered': it reads the session
    file the orchestrator will actually consume, not the rendered screen."""
    import glob as globmod

    hits = []
    for pattern in globs:
        for path in globmod.glob(os.path.expanduser(pattern), recursive=True):
            try:
                if os.path.getmtime(path) < since_ts:
                    continue
                with open(path, "rb") as fh:
                    if needle in fh.read():
                        hits.append(path)
            except OSError:
                continue
    return hits


def run(name, argv, cwd, challenge, expect, transcript_globs, boot_timeout, answer_timeout, logdir):
    os.makedirs(logdir, exist_ok=True)
    logpath = os.path.join(logdir, f"{name}.raw")
    print(f"\n=== {name}: {' '.join(argv)}  (cwd={cwd}) ===")

    started_at = time.time()
    pid, fd = spawn(argv, cwd)
    reader = Reader(fd, logpath)
    results = {}

    try:
        # (a) is this the real interactive TUI, or a headless/piped fallback?
        deadline = time.monotonic() + boot_timeout
        found_markers = []
        while time.monotonic() < deadline:
            reader.pump(0.1)
            found_markers = [k for k, v in TUI_MARKERS.items() if v in reader.buf]
            if any(m in found_markers for m in DECISIVE_TUI_MARKERS):
                break
            if reader.eof:
                break
        booted = any(m in found_markers for m in DECISIVE_TUI_MARKERS)
        results["tui_booted"] = booted
        results["tui_markers"] = found_markers
        print(f"[a] interactive TUI : {booted}   markers={found_markers or 'none'}")
        if not booted:
            print(f"    (no raw-mode markers after {boot_timeout}s; see {logpath})")

        # Let the UI finish drawing / clear any first-run banner before typing.
        reader.wait_quiet(quiet_for=1.5, max_wait=20)
        mark = len(reader.buf)

        # (b) do keystrokes land? Type the text, pause, then Enter separately --
        # a single burst can trip paste detection and submit nothing.
        os.write(fd, challenge.encode())
        typed_echoed = reader.wait_for_text(b"PTYSPIKE", 8.0, since=mark)
        results["keystrokes_land"] = typed_echoed
        print(f"[b] keystrokes echo : {typed_echoed}")

        time.sleep(0.4)
        submit_mark = len(reader.buf)
        os.write(fd, b"\r")

        # (c) did it submit and actually answer? `expect` is something the agent has
        # to COMPUTE -- it never appears in the prompt, so the TUI's echo of what we
        # typed cannot produce a false positive (an earlier version of this spike
        # matched its own echo and wrongly reported success).
        answered = reader.wait_for_text(expect.encode(), answer_timeout, since=submit_mark)
        results["submitted_and_answered"] = answered
        print(f"[c] agent answered  : {answered}  (expected token {expect!r})")

        # (d) did that answer reach the on-disk transcript? This is the path the
        # orchestrator consumes; the screen is only ever a debugging aid.
        reader.wait_quiet(quiet_for=1.0, max_wait=10)
        hits = find_transcript(transcript_globs, started_at, expect.encode())
        results["transcript_hits"] = hits
        print(f"[d] in transcript   : {bool(hits)}"
              + (f"  -> {hits[0]}" if hits else "  (no session file contains the answer)"))

    finally:
        teardown(pid, fd, reader)
        reader.close()
        try:
            os.close(fd)
        except OSError:
            pass

    print(f"    raw log: {logpath} ({os.path.getsize(logpath)} bytes)")
    results["log"] = logpath
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", choices=["claude", "codex", "both"], default="both")
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--boot-timeout", type=float, default=25.0)
    ap.add_argument("--answer-timeout", type=float, default=120.0)
    ap.add_argument("--logdir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs"))
    args = ap.parse_args()

    slug = args.cwd.replace("/", "-")
    TARGETS = {
        "claude": {
            "argv": ["claude"],
            "transcript_globs": [f"~/.claude/projects/{slug}/*.jsonl"],
        },
        "codex": {
            # Two interstitials will otherwise eat the orchestrator's input:
            #  - the startup update prompt (an earlier run of this spike typed into it
            #    and unintentionally triggered `npm install -g @openai/codex`)
            #  - paste-burst detection, which coalesces fast keystrokes and can swallow
            #    the submit. Both must be off for any programmatic driver.
            "argv": [
                "codex",
                "-c", "check_for_update_on_startup=false",
                "-c", "disable_paste_burst=true",
            ],
            "transcript_globs": ["~/.codex/sessions/**/rollout-*.jsonl"],
        },
    }
    names = list(TARGETS) if args.target == "both" else [args.target]

    summary = {}
    for name in names:
        # The expected token is derived, not quoted: the agent must do the addition,
        # so finding it in the output proves a turn actually ran.
        a, b = 137, 908
        expect = f"PTYSPIKE-{a + b}"
        challenge = (
            f"Reply with exactly the text PTYSPIKE-N and nothing else, "
            f"where N is {a} plus {b}. No tools, no preamble."
        )
        summary[name] = run(
            name,
            TARGETS[name]["argv"],
            args.cwd,
            challenge,
            expect,
            TARGETS[name]["transcript_globs"],
            args.boot_timeout,
            args.answer_timeout,
            args.logdir,
        )

    print("\n=== SUMMARY ===")
    ok = True
    for name, r in summary.items():
        passed = bool(
            r.get("tui_booted") and r.get("keystrokes_land") and r.get("submitted_and_answered")
        )
        ok = ok and passed
        print(
            f"{name:8s} {'PASS' if passed else 'FAIL'}  "
            f"tui={r.get('tui_booted')} keys={r.get('keystrokes_land')} "
            f"answer={r.get('submitted_and_answered')} transcript={bool(r.get('transcript_hits'))}"
        )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
