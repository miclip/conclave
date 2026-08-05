#!/usr/bin/env python3
"""
Step 2 objective 6: kill the receiver mid-session and watch what breaks.

One Claude session, three turns:
    turn 1  receiver up      -> should deliver
    turn 2  receiver killed  -> hook fires, delivery lost
    turn 3  receiver back    -> should deliver again

The question is not really "does the POST fail" -- of course it does. It is whether the
CLI notices, whether it retries, whether the child session degrades, and whether the
sequence resumes cleanly when the receiver returns. The hook's local journal is the
ground truth against which deliveries are compared.

Run with the main receiver stopped; this manages its own on the same port.
"""

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
INDEX = os.path.join(HERE, "fixtures", "index.ndjson")
RUN_ID = f"receiver-restart-{int(time.time())}"


def start_receiver():
    p = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "receiver.py")],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(1.5)
    return p


def stop_receiver(p):
    if p and p.poll() is None:
        p.send_signal(signal.SIGINT)
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()
    time.sleep(0.5)


def counts(run_id):
    fired = 0
    for line in open(JOURNAL):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get("run_id") == run_id and d.get("phase") == "fired" and d["event"] == "Stop":
            fired += 1
    delivered = 0
    if os.path.exists(INDEX):
        for line in open(INDEX):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("run_id") == run_id and d.get("event") == "Stop":
                delivered += 1
    return fired, delivered


def turn(fd, reader, token, n):
    ptydriver.type_and_submit(
        fd, f"Reply with exactly {token}-N and nothing else, where N is {n} plus 0. No tools."
    )
    ok = reader.wait_for_text(f"{token}-{n}".encode(), 120, since=len(reader.buf))
    reader.wait_quiet(quiet_for=2.5, max_wait=40)
    return ok


def main():
    print(f"run_id={RUN_ID}")
    rec = start_receiver()
    env = childenv.sanitized_copy(
        extra={
            "SPIKE_RUN_ID": RUN_ID,
            "SPIKE_CLI_VERSION": "claude 2.1.222",
            "SPIKE_HOOK_JOURNAL": JOURNAL,
            "SPIKE_HOOK_TIMEOUT": "3",
        }
    )
    os.makedirs(os.path.join(HERE, "logs"), exist_ok=True)
    pid, fd = ptydriver.spawn(["claude"], ROOT, env)
    reader = ptydriver.Reader(fd, os.path.join(HERE, "logs", f"{RUN_ID}.raw"))
    stages = []

    try:
        ptydriver.detect_tui(reader, 30)
        reader.wait_quiet(quiet_for=1.5, max_wait=25)

        ok1 = turn(fd, reader, "RRA", 1)
        f1, d1 = counts(RUN_ID)
        stages.append(("1 receiver up", ok1, f1, d1))
        print(f"  turn 1 (receiver up)      answered={ok1} stop_fired={f1} delivered={d1}")

        print("  -- killing receiver --")
        stop_receiver(rec)
        rec = None
        mark = len(reader.buf)

        ok2 = turn(fd, reader, "RRB", 2)
        f2, d2 = counts(RUN_ID)
        stages.append(("2 receiver down", ok2, f2, d2))
        print(f"  turn 2 (receiver down)    answered={ok2} stop_fired={f2} delivered={d2}")
        ui = reader.text(mark).lower()
        surfaced = "hook error" in ui or "spike-hook" in ui
        print(f"           CLI surfaced a hook error to the user: {surfaced}")

        print("  -- restarting receiver --")
        rec = start_receiver()

        # A retry, if one existed, would land here without a new turn.
        time.sleep(4)
        _, d_retry = counts(RUN_ID)
        print(f"           deliveries after restart, before turn 3: {d_retry} "
              f"({'RETRIED' if d_retry > d2 else 'no retry — the lost delivery stays lost'})")

        ok3 = turn(fd, reader, "RRC", 3)
        f3, d3 = counts(RUN_ID)
        stages.append(("3 receiver back", ok3, f3, d3))
        print(f"  turn 3 (receiver back)    answered={ok3} stop_fired={f3} delivered={d3}")

    finally:
        ptydriver.teardown(pid, fd, reader)
        reader.close()
        try:
            os.close(fd)
        except OSError:
            pass
        stop_receiver(rec)

    fired, delivered = counts(RUN_ID)
    print(f"\n  totals: Stop fired={fired} delivered={delivered} lost={fired - delivered}")
    print("  session survived receiver outage:",
          all(ok for _, ok, _, _ in stages))
    return 0


if __name__ == "__main__":
    sys.exit(main())
