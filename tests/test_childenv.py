#!/usr/bin/env python3
"""
Regression test for the adapter invariant (spike 1, blocker 1).

The unit half is cheap and always runs. The integration half actually spawns two
Claude sessions -- one with a sanitized environment, one with the parent's
CLAUDE_CODE_CHILD_SESSION deliberately reintroduced -- and asserts that only the
sanitized one produces a transcript file. That asymmetry is the whole point: the
failure mode is silent, so a test that only checks the happy path would pass even if
the sanitizer stopped working.

The integration half costs one short model turn per spawn. Skip it with
SKIP_INTEGRATION=1 when you only want the unit checks.

  python3 tests/test_childenv.py
  SKIP_INTEGRATION=1 python3 tests/test_childenv.py
"""

import os
import sys
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "spikes"))

from common import childenv, ptydriver  # noqa: E402

TRANSCRIPT_DIR = os.path.expanduser(
    "~/.claude/projects/" + ROOT.replace("/", "-")
)


class TestSanitizer(unittest.TestCase):
    def test_strips_the_transcript_killer(self):
        for var in childenv.TRANSCRIPT_KILLING_VARS:
            env = childenv.sanitized_copy({var: "1", "PATH": "/usr/bin"})
            self.assertNotIn(var, env)

    def test_strips_all_known_parent_agent_vars(self):
        polluted = {v: "x" for v in childenv.KNOWN_PARENT_AGENT_VARS}
        polluted["PATH"] = "/usr/bin"
        env = childenv.sanitized_copy(polluted)
        for v in childenv.KNOWN_PARENT_AGENT_VARS:
            self.assertNotIn(v, env)

    def test_keeps_what_a_cli_needs(self):
        src = {"PATH": "/usr/bin", "HOME": "/home/x", "HTTPS_PROXY": "http://p:1",
               "CLAUDE_CODE_CHILD_SESSION": "1"}
        env = childenv.sanitized_copy(src)
        self.assertEqual(env["PATH"], "/usr/bin")
        self.assertEqual(env["HOME"], "/home/x")
        self.assertEqual(env["HTTPS_PROXY"], "http://p:1")

    def test_allowlist_is_stricter(self):
        src = {"PATH": "/usr/bin", "SOME_RANDOM_VAR": "1", "CLAUDECODE": "1"}
        env = childenv.allowlist_env(src)
        self.assertIn("PATH", env)
        self.assertNotIn("SOME_RANDOM_VAR", env)
        self.assertNotIn("CLAUDECODE", env)

    def test_extra_cannot_smuggle_a_leak_back_in(self):
        with self.assertRaises(AssertionError):
            childenv.sanitized_copy({"PATH": "/usr/bin"},
                                    extra={"CLAUDE_CODE_CHILD_SESSION": "1"})

    def test_terminal_defaults_are_set(self):
        env = childenv.sanitized_copy({"PATH": "/usr/bin"}, rows=24, cols=80)
        self.assertEqual(env["TERM"], "xterm-256color")
        self.assertEqual(env["LINES"], "24")
        self.assertEqual(env["COLUMNS"], "80")

    def test_no_novel_parent_agent_vars_in_this_process(self):
        """Fails when the toolchain introduces a marker we have not reviewed. That is
        a prompt to look at it, not necessarily a bug."""
        d = childenv.discover_parent_agent_vars()
        self.assertEqual(
            d["novel"], [],
            f"unreviewed parent-agent variables present: {d['novel']}. "
            f"Review them and add to KNOWN_PARENT_AGENT_VARS.",
        )


def _transcripts_newer_than(ts):
    if not os.path.isdir(TRANSCRIPT_DIR):
        return []
    out = []
    for name in os.listdir(TRANSCRIPT_DIR):
        if not name.endswith(".jsonl"):
            continue
        p = os.path.join(TRANSCRIPT_DIR, name)
        try:
            if os.path.getmtime(p) >= ts and os.path.getsize(p) > 0:
                out.append(p)
        except OSError:
            pass
    return out


def _run_claude_turn(env_extra, marker):
    """Spawn claude, run one trivial turn, return transcripts created during it."""
    started = time.time() - 1
    env = childenv.sanitized_copy(rows=40, cols=120)
    # Applied after sanitising on purpose: this is how we simulate the leak that the
    # sanitizer is supposed to prevent, without weakening the sanitizer itself.
    env.update(env_extra)

    pid, fd = ptydriver.spawn(["claude"], ROOT, env)
    reader = ptydriver.Reader(fd)
    try:
        ptydriver.detect_tui(reader, 30)
        reader.wait_quiet(quiet_for=1.5, max_wait=25)
        ptydriver.type_and_submit(fd, f"Reply with exactly {marker} and nothing else. No tools.")
        reader.wait_for_text(marker.encode(), 120, since=len(reader.buf))
        reader.wait_quiet(quiet_for=2.0, max_wait=30)
    finally:
        ptydriver.teardown(pid, fd, reader)
        reader.close()
        try:
            os.close(fd)
        except OSError:
            pass

    time.sleep(1.5)
    hits = []
    for p in _transcripts_newer_than(started):
        try:
            with open(p, "rb") as fh:
                if marker.encode() in fh.read():
                    hits.append(p)
        except OSError:
            pass
    return hits


@unittest.skipIf(os.environ.get("SKIP_INTEGRATION"), "SKIP_INTEGRATION set")
class TestTranscriptCreation(unittest.TestCase):
    """The actual regression: a spawned Claude session must write its transcript."""

    def test_sanitized_env_produces_a_transcript(self):
        marker = f"CHILDENV-CLEAN-{int(time.time())}"
        hits = _run_claude_turn({}, marker)
        self.assertTrue(
            hits,
            "a session spawned with a sanitized environment wrote no transcript "
            "containing its own answer. The orchestrator's output path is broken.",
        )

    def test_leaked_marker_suppresses_the_transcript(self):
        """Proves the sanitizer is load-bearing rather than incidental. If this ever
        starts passing transcripts through, the vendor changed the behaviour and the
        invariant can be relaxed -- check before doing so."""
        marker = f"CHILDENV-LEAKED-{int(time.time())}"
        hits = _run_claude_turn({"CLAUDE_CODE_CHILD_SESSION": "1"}, marker)
        self.assertFalse(
            hits,
            "CLAUDE_CODE_CHILD_SESSION no longer suppresses transcripts. The leak is "
            "now harmless; confirm and update childenv.TRANSCRIPT_KILLING_VARS.",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
