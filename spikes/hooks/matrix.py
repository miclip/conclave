#!/usr/bin/env python3
"""
Step 2 objective 4: does Stop fire exactly once, for every way a turn can end?

Each scenario spawns a fresh child session under a PTY with a unique SPIKE_RUN_ID,
drives it into one specific terminal state, then tears it down. Correlation is by
run_id, which the orchestrator's own session does not have -- that is what keeps our
fixtures free of this session's events.

Ground truth is the hook's local journal, not the receiver: the two are compared so a
delivery that the CLI fired but the receiver never saw is visible as a discrepancy
(objective 6).

  python3 matrix.py --list
  python3 matrix.py normal interrupted
  python3 matrix.py --all
  python3 matrix.py --report
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.dirname(HERE))

from common import childenv, ptydriver  # noqa: E402

JOURNAL = os.path.join(HERE, "journal", "hook-journal.ndjson")
RESULTS = os.path.join(HERE, "results.ndjson")
LOGDIR = os.path.join(HERE, "logs")

# Codex needs both suppressed or its interstitials eat our input (spike 1, blocker 2).
CODEX_ARGS = ["-c", "check_for_update_on_startup=false", "-c", "disable_paste_burst=true"]


def cli_version(agent):
    try:
        out = subprocess.run([agent, "--version"], capture_output=True, text=True, timeout=30)
        return out.stdout.strip().splitlines()[0] if out.stdout.strip() else "unknown"
    except Exception:
        return "unknown"


def child_env(run_id, agent, **overrides):
    extra = {
        "SPIKE_RUN_ID": run_id,
        "SPIKE_CLI_VERSION": cli_version(agent),
        "SPIKE_HOOK_JOURNAL": JOURNAL,
    }
    extra.update({k: str(v) for k, v in overrides.items() if v is not None})
    return childenv.sanitized_copy(extra=extra)


def start(agent, run_id, argv_extra=(), **env_overrides):
    argv = [agent] + list(argv_extra)
    if agent == "codex":
        argv = [agent] + CODEX_ARGS + list(argv_extra)
    os.makedirs(LOGDIR, exist_ok=True)
    env = child_env(run_id, agent, **env_overrides)
    pid, fd = ptydriver.spawn(argv, ROOT, env)
    reader = ptydriver.Reader(fd, os.path.join(LOGDIR, f"{run_id}.raw"))
    booted, markers = ptydriver.detect_tui(reader, 30)
    # Spike-grade settle. Replaced by the SessionStart hook once we trust it -- which
    # is precisely what this run is measuring.
    reader.wait_quiet(quiet_for=1.5, max_wait=25)
    return pid, fd, reader, booted, markers


# --- scenarios ---------------------------------------------------------------------
# Each returns a dict of observations. Stop-counting happens later, from the journal.


def sc_normal(agent, run_id):
    """A turn that completes on its own."""
    pid, fd, reader, booted, markers = start(agent, run_id)
    try:
        t0 = time.monotonic()
        ptydriver.type_and_submit(
            fd, "Reply with exactly FAST-N and nothing else, where N is 41 plus 1. No tools."
        )
        answered = reader.wait_for_text(b"FAST-42", 120, since=len(reader.buf))
        t_answer = round(time.monotonic() - t0, 1)
        reader.wait_quiet(quiet_for=2.0, max_wait=30)
        # Baseline for slow_hook: how long a turn takes when no hook is stalling.
        return {"booted": booted, "markers": markers, "answered": answered,
                "seconds_to_answer": t_answer,
                "ended": ptydriver.teardown(pid, fd, reader)}
    finally:
        _close(fd, reader)


def sc_interrupted(agent, run_id):
    """A turn cancelled by the user mid-flight (ESC)."""
    pid, fd, reader, booted, markers = start(agent, run_id)
    try:
        ptydriver.type_and_submit(
            fd, "Count slowly from 1 to 500, one number per line. Do not stop early."
        )
        time.sleep(6)  # let it genuinely start producing
        os.write(fd, b"\x1b")
        reader.wait_quiet(quiet_for=2.5, max_wait=30)
        return {"booted": booted, "markers": markers,
                "ended": ptydriver.teardown(pid, fd, reader)}
    finally:
        _close(fd, reader)


def sc_permission_denied(agent, run_id):
    """A tool call the user refuses. Forced out of auto mode so a prompt appears."""
    extra = ["--permission-mode", "default"] if agent == "claude" else []
    pid, fd, reader, booted, markers = start(agent, run_id, argv_extra=extra)
    try:
        # A bare `echo` is auto-allowed even in default mode, so an earlier version of
        # this scenario never produced a dialog at all. A file write always prompts.
        # A bare `echo` is auto-allowed even in manual mode, and an in-cwd write did not
        # reliably prompt either. Writing outside the workspace always does.
        submit_mark = len(reader.buf)
        ptydriver.type_and_submit(
            fd,
            "Use your file-writing tool to create the file /tmp/spike-perm-probe.txt "
            "with the single word probe in it. Do this immediately, no preamble.",
        )
        # Watch BOTH channels. Preferring the hook would beg the question -- if the hook
        # never fires we still need to know whether a dialog was on screen, or the
        # result is unfalsifiable. Screen matching here is measurement scaffolding, not
        # a mechanism the adapter would ever use.
        saw, how = wait_for_permission(run_id, reader, submit_mark, 180)
        if not saw:
            return {"booted": booted, "markers": markers, "saw_permission_hook": None,
                    "note": "no permission dialog or hook observed; refusal not exercised",
                    "ended": ptydriver.teardown(pid, fd, reader)}
        if how == "screen":
            # The decisive observation: a dialog is up and no PermissionRequest fired.
            time.sleep(1.0)
            fired_now = [r["event"] for r in journal_for(run_id) if r.get("phase") == "fired"]
            saw = f"screen-only (hooks so far: {sorted(set(fired_now))})"
        time.sleep(1.5)
        os.write(fd, b"\x1b")  # ESC on this dialog is "No, and tell Claude what to do"
        reader.wait_quiet(quiet_for=2.5, max_wait=40)
        return {"booted": booted, "markers": markers, "saw_permission_hook": saw,
                "ended": ptydriver.teardown(pid, fd, reader)}
    finally:
        _close(fd, reader)


def sc_tool_error(agent, run_id):
    """A tool that runs and fails. The turn itself still completes normally."""
    pid, fd, reader, booted, markers = start(agent, run_id)
    try:
        ptydriver.type_and_submit(
            fd,
            "Run exactly this shell command once with your Bash tool, then tell me the "
            "exit code and stop: `sh -c 'echo spike-fail >&2; exit 42'`",
        )
        reader.wait_for_text(b"42", 120, since=len(reader.buf))
        reader.wait_quiet(quiet_for=2.5, max_wait=40)
        return {"booted": booted, "markers": markers,
                "ended": ptydriver.teardown(pid, fd, reader)}
    finally:
        _close(fd, reader)


def sc_sigterm(agent, run_id):
    """Process killed mid-turn. Does Stop fire when nobody asked politely?"""
    pid, fd, reader, booted, markers = start(agent, run_id)
    try:
        ptydriver.type_and_submit(
            fd, "Count slowly from 1 to 500, one number per line. Do not stop early."
        )
        time.sleep(6)
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and ptydriver.is_alive(pid):
            reader.pump(0.2)
        ended = "sigterm" if not ptydriver.is_alive(pid) else ptydriver.teardown(pid, fd, reader, graceful=False)
        time.sleep(2)  # give any late hook a chance to land
        return {"booted": booted, "markers": markers, "ended": ended}
    finally:
        _close(fd, reader)


def sc_sigkill(agent, run_id):
    """The unsurvivable case. Establishes the floor: no hook can fire here."""
    pid, fd, reader, booted, markers = start(agent, run_id)
    try:
        ptydriver.type_and_submit(
            fd, "Count slowly from 1 to 500, one number per line. Do not stop early."
        )
        time.sleep(6)
        os.kill(pid, signal.SIGKILL)
        time.sleep(2)
        return {"booted": booted, "markers": markers, "ended": "sigkill"}
    finally:
        _close(fd, reader)


def sc_slow_hook(agent, run_id):
    """Objective 5: does a slow Stop hook block the TUI, and is it timed out?

    The hook sleeps past the configured timeout. We time how long the UI takes to
    become responsive again and whether the CLI says anything about it.
    """
    pid, fd, reader, booted, markers = start(agent, run_id, SPIKE_HOOK_DELAY=20)
    try:
        t0 = time.monotonic()
        # Computed token: the prompt must not contain the string we wait for, or the
        # TUI's echo of our own typing satisfies the wait instantly.
        ptydriver.type_and_submit(
            fd, "Reply with exactly SLOW-N and nothing else, where N is 41 plus 1. No tools."
        )
        answered = reader.wait_for_text(b"SLOW-42", 120, since=len(reader.buf))
        t_answer = time.monotonic() - t0

        # Type again immediately. If the UI is blocked by the hook the echo is late.
        probe_mark = len(reader.buf)
        os.write(fd, b"spike-responsive-probe")
        echoed = reader.wait_for_text(b"spike-responsive-probe", 40, since=probe_mark)
        t_echo = time.monotonic() - t0
        reader.wait_quiet(quiet_for=2.0, max_wait=45)
        text = reader.text(probe_mark)
        return {
            "booted": booted, "markers": markers, "answered": answered,
            "seconds_to_answer": round(t_answer, 1),
            "seconds_to_echo_after_answer": round(t_echo - t_answer, 1),
            "echo_ok": echoed,
            "mentions_timeout": any(w in text.lower() for w in ("timeout", "timed out", "hook")),
            "ended": ptydriver.teardown(pid, fd, reader),
        }
    finally:
        _close(fd, reader)


def sc_receiver_down(agent, run_id):
    """Objective 6: receiver unreachable. Does the CLI care? Does it retry?"""
    pid, fd, reader, booted, markers = start(
        agent, run_id, SPIKE_HOOK_URL="http://127.0.0.1:9/hook", SPIKE_HOOK_TIMEOUT=3
    )
    try:
        mark = len(reader.buf)
        ptydriver.type_and_submit(fd, "Reply with exactly OK and nothing else. No tools.")
        answered = reader.wait_for_text(b"OK", 120, since=len(reader.buf))
        reader.wait_quiet(quiet_for=2.0, max_wait=40)
        text = reader.text(mark)
        return {
            "booted": booted, "markers": markers, "answered": answered,
            "surfaced_error": any(
                w in text.lower() for w in ("spike-hook", "hook", "failed", "error")
            ),
            "ended": ptydriver.teardown(pid, fd, reader),
        }
    finally:
        _close(fd, reader)


def sc_hook_nonzero(agent, run_id):
    """Does a hook exiting non-zero change anything the user can see?"""
    pid, fd, reader, booted, markers = start(agent, run_id, SPIKE_HOOK_EXIT=1)
    try:
        mark = len(reader.buf)
        ptydriver.type_and_submit(fd, "Reply with exactly OK and nothing else. No tools.")
        answered = reader.wait_for_text(b"OK", 120, since=len(reader.buf))
        reader.wait_quiet(quiet_for=2.0, max_wait=40)
        text = reader.text(mark)
        return {"booted": booted, "markers": markers, "answered": answered,
                "surfaced_error": any(w in text.lower() for w in ("spike-hook", "hook")),
                "ended": ptydriver.teardown(pid, fd, reader)}
    finally:
        _close(fd, reader)


def sc_two_turns(agent, run_id):
    """Two turns in one session. Stop should fire once per turn, not once per session."""
    pid, fd, reader, booted, markers = start(agent, run_id)
    try:
        ptydriver.type_and_submit(fd, "Reply with exactly ONE and nothing else. No tools.")
        reader.wait_for_text(b"ONE", 120, since=len(reader.buf))
        reader.wait_quiet(quiet_for=2.5, max_wait=30)
        ptydriver.type_and_submit(fd, "Reply with exactly TWO and nothing else. No tools.")
        reader.wait_for_text(b"TWO", 120, since=len(reader.buf))
        reader.wait_quiet(quiet_for=2.5, max_wait=30)
        return {"booted": booted, "markers": markers, "expected_stops": 2,
                "ended": ptydriver.teardown(pid, fd, reader)}
    finally:
        _close(fd, reader)


def sc_session_start_only(agent, run_id):
    """Boot and quit without a turn. Costs no model tokens -- the only scenario that
    can run while an account is rate-limited."""
    pid, fd, reader, booted, markers = start(agent, run_id)
    try:
        time.sleep(3)
        return {"booted": booted, "markers": markers, "expected_stops": 0,
                "ended": ptydriver.teardown(pid, fd, reader)}
    finally:
        _close(fd, reader)


SCENARIOS = {
    "session_start_only": (sc_session_start_only, 0, "boot only, no turn (no model cost)"),
    "normal": (sc_normal, 1, "turn completes normally"),
    "two_turns": (sc_two_turns, 2, "two turns in one session"),
    "interrupted": (sc_interrupted, 1, "turn cancelled with ESC"),
    "permission_denied": (sc_permission_denied, 1, "tool permission refused"),
    "tool_error": (sc_tool_error, 1, "tool runs and exits non-zero"),
    "sigterm": (sc_sigterm, None, "process SIGTERMed mid-turn"),
    "sigkill": (sc_sigkill, 0, "process SIGKILLed mid-turn (floor case)"),
    "slow_hook": (sc_slow_hook, 1, "Stop hook sleeps past its timeout"),
    "receiver_down": (sc_receiver_down, 1, "receiver unreachable"),
    "hook_nonzero": (sc_hook_nonzero, 1, "hook exits non-zero"),
}


def _close(fd, reader):
    reader.close()
    try:
        os.close(fd)
    except OSError:
        pass


# --- correlation -------------------------------------------------------------------


def read_ndjson(path):
    out = []
    if os.path.exists(path):
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except ValueError:
                        pass
    return out


def journal_for(run_id):
    return [r for r in read_ndjson(JOURNAL) if r.get("run_id") == run_id]


PERMISSION_DIALOG_NEEDLES = (
    b"Doyouwant", b"No,andtellClaude", b"Yes,andautoaccept",
    b"esctoreject", b"1.Yes", b"wantstocreate", b"wantstowrite",
)


def wait_for_permission(run_id, reader, since, timeout):
    """Return (evidence, source) for a pending permission decision, watching the hook
    journal and the rendered screen concurrently."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for r in journal_for(run_id):
            if r.get("phase") == "fired" and r["event"] == "PermissionRequest":
                return r["event"], "hook"
        reader.pump(0.2)
        hay = ptydriver.squash(bytes(reader.buf[since:]))
        for n in PERMISSION_DIALOG_NEEDLES:
            if n in hay:
                return n.decode(), "screen"
        time.sleep(0.3)
    return None, None


def wait_for_hook(run_id, events, timeout):
    """Block until one of `events` is journalled for this run. Lets a scenario react to
    a lifecycle event rather than to rendered text."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for r in journal_for(run_id):
            if r.get("phase") == "fired" and r["event"] in events:
                return r["event"]
        time.sleep(0.5)
    return None


def delivered_for(run_id):
    idx = os.path.join(HERE, "fixtures", "index.ndjson")
    return [r for r in read_ndjson(idx) if r.get("run_id") == run_id]


def report():
    results = read_ndjson(RESULTS)
    if not results:
        print("no scenario results yet")
        return 1
    print(f"{'scenario':20} {'agent':7} {'fired':>12} {'delivered':>10} {'expect':>7} {'verdict':9} ended")
    bad = 0
    for r in results:
        fired = r["fired"]
        stops = fired.get("Stop", 0)
        exp = r["expected_stops"]
        if exp is None:
            verdict = "RECORDED"
        elif stops == exp:
            verdict = "ok"
        else:
            verdict = "MISMATCH"
            bad += 1
        fired_s = ",".join(f"{k}={v}" for k, v in sorted(fired.items())) or "-"
        print(
            f"{r['scenario']:20} {r['agent']:7} {fired_s:>12} "
            f"{r['delivered_total']:>10} {str(exp):>7} {verdict:9} {r['obs'].get('ended','-')}"
        )
        gap = sum(fired.values()) - r["delivered_total"]
        if gap:
            print(f"{'':20} {'':7} -> {gap} delivery/deliveries fired but never received")
    print(f"\n{len(results)} scenario(s), {bad} mismatch(es)")
    return 1 if bad else 0


def run_scenario(name, agent):
    fn, expected, desc = SCENARIOS[name]
    run_id = f"{name}-{agent}-{int(time.time())}"
    print(f"\n=== {name} [{agent}] : {desc}")
    print(f"    run_id={run_id}")
    t0 = time.time()
    try:
        obs = fn(agent, run_id)
    except Exception as e:
        obs = {"error": f"{type(e).__name__}: {e}"}
    # Late hooks are common; give them a moment before counting.
    time.sleep(2)

    jrecs = [r for r in journal_for(run_id) if r.get("phase") == "fired"]
    fired = {}
    for r in jrecs:
        fired[r["event"]] = fired.get(r["event"], 0) + 1
    delivered = delivered_for(run_id)

    result = {
        "scenario": name,
        "agent": agent,
        "run_id": run_id,
        "expected_stops": expected,
        "fired": fired,
        "delivered_total": len(delivered),
        "obs": obs,
        "duration_s": round(time.time() - t0, 1),
    }
    with open(RESULTS, "a") as fh:
        fh.write(json.dumps(result, sort_keys=True) + "\n")

    print(f"    fired={fired or '{}'} delivered={len(delivered)} expected_stops={expected}")
    print(f"    obs={json.dumps(obs, sort_keys=True)}")
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scenarios", nargs="*")
    ap.add_argument("--agent", default="claude", choices=["claude", "codex"])
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--report", action="store_true")
    args = ap.parse_args()

    if args.list:
        for k, (_, exp, desc) in SCENARIOS.items():
            print(f"{k:20} expect_stops={str(exp):5} {desc}")
        return 0
    if args.report:
        return report()

    names = list(SCENARIOS) if args.all else args.scenarios
    if not names:
        ap.error("give scenario names, or --all / --list / --report")
    for n in names:
        if n not in SCENARIOS:
            ap.error(f"unknown scenario {n!r}")
    for n in names:
        run_scenario(n, args.agent)
    print()
    return report()


if __name__ == "__main__":
    sys.exit(main())
