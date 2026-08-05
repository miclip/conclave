"""
Adapter invariant: a child agent CLI never inherits this process's environment.

Rationale (spike 1). Spawning a coding-agent CLI from inside another agent session
leaks the parent's session markers. Claude Code, on seeing CLAUDE_CODE_CHILD_SESSION,
disables transcript persistence entirely and writes no session file. Since the
orchestrator's entire output path is those transcript files, an inherited environment
turns into a silent, far-downstream data loss.

So: the child environment is CONSTRUCTED, never inherited. Two strategies:

  sanitized_copy()  - denylist. Copy the parent env minus anything that identifies a
                      parent agent. Permissive; keeps proxies, cert bundles, toolchain
                      shims working without having to enumerate them.
  allowlist_env()   - allowlist. Only reviewed variables survive. Strict; use when the
                      child must be reproducible rather than merely working.

sanitized_copy() is the default. allowlist_env() is available for when we want to pin
child behaviour down, and the conformance suite should eventually run both.

Nothing here is specific to a transport. When AgentSession lands (step 4) this module
is what its spawn path must call, whichever language the rest ends up in.
"""

import json
import os
import re
import time

# --- the denylist ------------------------------------------------------------------
# Prefixes covering the vendor CLIs and their SDKs. Deliberately broad: a variable we
# strip unnecessarily costs nothing, one we leak can silently disable transcripts.
PARENT_AGENT_PREFIXES = (
    "CLAUDE",
    "CODEX",
    "ANTHROPIC_",
    "OPENAI_",
    "CURSOR_",
    "AIDER_",
    "COPILOT_",
)

# Exact names that don't share a vendor prefix.
PARENT_AGENT_EXACT = frozenset(
    {
        "AI_AGENT",
        "AGENT_SESSION_ID",
        "CI",
    }
)

# Not agent markers, but they change how a TUI renders or whether it colours output.
# Stripped so the child's terminal behaviour depends on the PTY we gave it, not on
# whatever terminal the orchestrator happens to be running under.
TERMINAL_NOISE = frozenset(
    {
        "NO_COLOR",
        "FORCE_COLOR",
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
        "COLORTERM",
        "TERM_SESSION_ID",
        "ITERM_SESSION_ID",
    }
)

# Confirmed present in a Claude Code session on 2026-08-05 (claude 2.1.222). Recorded
# so a future toolchain bump that renames them shows up as a diff rather than a
# mystery. CLAUDE_CODE_CHILD_SESSION is the one that actually breaks transcripts.
KNOWN_PARENT_AGENT_VARS = (
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_ENABLE_TELEMETRY",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "AI_AGENT",
)

# The single variable whose leakage is known to be destructive rather than merely
# untidy. Asserted separately so the regression test can name it.
TRANSCRIPT_KILLING_VARS = ("CLAUDE_CODE_CHILD_SESSION",)

# --- the allowlist -----------------------------------------------------------------
# Reviewed minimum for running a node/rust CLI that has to reach the network, resolve
# a toolchain shim, and read the user's credentials from disk.
ALLOWLIST_EXACT = frozenset(
    {
        "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TZ",
        "LANG", "LC_ALL", "LC_CTYPE",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
        "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
        "http_proxy", "https_proxy", "no_proxy",
        "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
    }
)
ALLOWLIST_PREFIXES = ("SPIKE_",)


def is_parent_agent_var(name: str) -> bool:
    return name.startswith(PARENT_AGENT_PREFIXES) or name in PARENT_AGENT_EXACT


def discover_parent_agent_vars(env=None):
    """Return parent-agent variables present in `env`, split into ones we already know
    about and ones we don't. Unknown hits are what a toolchain bump looks like."""
    env = os.environ if env is None else env
    present = sorted(n for n in env if is_parent_agent_var(n))
    known = [n for n in present if n in KNOWN_PARENT_AGENT_VARS]
    novel = [n for n in present if n not in KNOWN_PARENT_AGENT_VARS]
    return {"present": present, "known": known, "novel": novel}


def record_discoveries(path, env=None):
    """Append a timestamped discovery record. Values are never written -- names only;
    several of these are session identifiers and one is a telemetry flag."""
    d = discover_parent_agent_vars(env)
    d["recorded_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "a") as fh:
        fh.write(json.dumps(d, sort_keys=True) + "\n")
    return d


def sanitized_copy(env=None, extra=None, rows=40, cols=120):
    """Parent env minus every parent-agent marker and terminal-identity variable."""
    env = os.environ if env is None else env
    out = {
        k: v
        for k, v in env.items()
        if not is_parent_agent_var(k) and k not in TERMINAL_NOISE
    }
    out.update(_terminal_defaults(rows, cols))
    if extra:
        out.update(extra)
    _assert_clean(out)
    return out


def allowlist_env(env=None, extra=None, rows=40, cols=120):
    """Only reviewed variables survive."""
    env = os.environ if env is None else env
    out = {
        k: v
        for k, v in env.items()
        if (k in ALLOWLIST_EXACT or k.startswith(ALLOWLIST_PREFIXES))
        and not is_parent_agent_var(k)
    }
    out.update(_terminal_defaults(rows, cols))
    if extra:
        out.update(extra)
    _assert_clean(out)
    return out


def _terminal_defaults(rows, cols):
    return {"TERM": "xterm-256color", "COLUMNS": str(cols), "LINES": str(rows)}


def _assert_clean(env):
    """Fail loudly rather than let a leak through. This is the invariant; if it ever
    trips, the child would have run with degraded or absent transcript persistence."""
    leaked = sorted(n for n in env if is_parent_agent_var(n))
    if leaked:
        raise AssertionError(f"parent-agent variables leaked into child env: {leaked}")


if __name__ == "__main__":
    import sys

    d = discover_parent_agent_vars()
    print(json.dumps(d, indent=2, sort_keys=True))
    if d["novel"]:
        print(
            f"\nNOTE: {len(d['novel'])} variable(s) match the parent-agent pattern but are "
            f"not in KNOWN_PARENT_AGENT_VARS. Add them there so the change is recorded.",
            file=sys.stderr,
        )
