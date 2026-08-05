"""
PTY transport primitives, extracted from spike 1 so the hook spike and the eventual
AgentSession adapter share one implementation.

Scope discipline: this module moves BYTES. It knows how to give a child a real
controlling terminal, type at it, and take it down. It does not know what any of those
bytes mean. Screen content is only ever used for spike-grade liveness checks (and even
those are being retired in favour of hook signals) -- never for semantics.
"""

import errno
import fcntl
import os
import re
import select
import signal
import struct
import termios
import time

# Claude Code 2.1.222 and codex 0.146.0 both render INLINE -- neither uses the
# alternate screen buffer. Bracketed paste is the reliable "this is a real interactive
# raw-mode UI" signal; a piped or headless run has no reason to enable it.
TUI_MARKERS = {
    "alt_screen": b"\x1b[?1049h",
    "bracketed_paste": b"\x1b[?2004h",
    "focus_events": b"\x1b[?1004h",
    "hide_cursor": b"\x1b[?25l",
    "mouse_tracking": b"\x1b[?1000h",
    "kitty_keyboard": b"\x1b[>7u",
}
DECISIVE_TUI_MARKERS = ("bracketed_paste", "focus_events", "kitty_keyboard")

ANSI_RE = re.compile(
    rb"\x1b\[[0-9;?>=]*[ -/]*[@-~]|\x1b[]P^_].*?(?:\x07|\x1b\\)|\x1b[@-Z\\-_]", re.S
)


def strip_ansi(data: bytes) -> bytes:
    return ANSI_RE.sub(b"", data)


def squash(data: bytes) -> bytes:
    """ANSI-stripped, whitespace-collapsed. TUIs wrap and redraw, so a literal match
    against raw output gives false negatives."""
    return re.sub(rb"\s+", b"", strip_ansi(data))


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def spawn(argv, cwd, env, rows=40, cols=120):
    """Fork `argv` onto the slave side of a new PTY with a controlling terminal.

    `env` is required and must be fully constructed -- see spikes.common.childenv.
    There is deliberately no default that would inherit os.environ.
    """
    master, slave = pty_openpty()
    set_winsize(slave, rows, cols)

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


def pty_openpty():
    import pty as _pty

    return _pty.openpty()


class Reader:
    """Accumulates raw PTY output, teeing it to a log for later inspection."""

    def __init__(self, fd, logpath=None):
        self.fd = fd
        self.buf = bytearray()
        self.log = open(logpath, "wb") if logpath else None
        self.eof = False
        self.last_read_at = time.monotonic()

    def pump(self, timeout=0.1) -> int:
        try:
            r, _, _ = select.select([self.fd], [], [], timeout)
        except (OSError, ValueError):
            self.eof = True
            return 0
        if not r:
            return 0
        try:
            chunk = os.read(self.fd, 65536)
        except OSError as e:
            # EIO on macOS means the slave closed: the child is gone.
            if e.errno not in (errno.EIO, errno.EBADF):
                raise
            self.eof = True
            return 0
        if not chunk:
            self.eof = True
            return 0
        self.buf.extend(chunk)
        if self.log:
            self.log.write(chunk)
            self.log.flush()
        self.last_read_at = time.monotonic()
        return len(chunk)

    def wait_for_bytes(self, needle: bytes, timeout: float, since: int = 0) -> bool:
        deadline = time.monotonic() + timeout
        while True:
            if self.buf.find(needle, since) != -1:
                return True
            if time.monotonic() >= deadline or self.eof:
                return self.buf.find(needle, since) != -1
            self.pump(0.1)

    def wait_for_text(self, needle: bytes, timeout: float, since: int = 0) -> bool:
        deadline = time.monotonic() + timeout
        target = squash(needle)
        while True:
            if target in squash(bytes(self.buf[since:])):
                return True
            if time.monotonic() >= deadline or self.eof:
                return False
            self.pump(0.2)

    def wait_quiet(self, quiet_for: float, max_wait: float) -> bool:
        """Pump until the child stops emitting for `quiet_for` seconds.

        Spike-grade only. This is exactly the timing heuristic that hook signals are
        meant to replace; do not carry it into the adapter.
        """
        deadline = time.monotonic() + max_wait
        while time.monotonic() < deadline:
            self.pump(0.1)
            if self.eof:
                return False
            if time.monotonic() - self.last_read_at >= quiet_for:
                return True
        return False

    def text(self, since: int = 0) -> str:
        return strip_ansi(bytes(self.buf[since:])).decode("utf8", "replace")

    def close(self):
        if self.log:
            self.log.close()


def detect_tui(reader, timeout: float):
    """Wait for evidence the child booted a real interactive UI. Returns
    (booted, markers_seen)."""
    deadline = time.monotonic() + timeout
    markers = []
    while time.monotonic() < deadline:
        reader.pump(0.1)
        markers = [k for k, v in TUI_MARKERS.items() if v in reader.buf]
        if any(m in markers for m in DECISIVE_TUI_MARKERS):
            return True, markers
        if reader.eof:
            break
    return False, markers


def type_and_submit(fd, text: str, settle: float = 0.4):
    """Type a body, pause, then send Enter alone.

    Sending text and CR as one burst is unreliable: both CLIs coalesce fast input as a
    paste and the submit can be swallowed. Codex additionally needs
    `-c disable_paste_burst=true`.
    """
    os.write(fd, text.encode())
    time.sleep(settle)
    os.write(fd, b"\r")


def is_alive(pid) -> bool:
    try:
        wpid, _ = os.waitpid(pid, os.WNOHANG)
        return wpid == 0
    except (ChildProcessError, OSError):
        return False


def teardown(pid, fd, reader=None, graceful=True):
    """Ask nicely (Ctrl-C twice, ESC), then insist. Returns how it ended."""
    if graceful:
        for keys in (b"\x03", b"\x03", b"\x1b"):
            try:
                os.write(fd, keys)
            except OSError:
                break
            time.sleep(0.35)
            if reader:
                reader.pump(0.1)
        for _ in range(15):
            if not is_alive(pid):
                return "graceful"
            time.sleep(0.1)
            if reader:
                reader.pump(0.05)

    for sig, label in ((signal.SIGTERM, "sigterm"), (signal.SIGKILL, "sigkill")):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            return "already-exited"
        for _ in range(20):
            if not is_alive(pid):
                return label
            time.sleep(0.1)
            if reader:
                reader.pump(0.05)
    return "unkillable"
