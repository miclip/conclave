#!/usr/bin/env python3
"""
Confirm codex actually loaded our project-local .codex/hooks.json.

Uses the app-server's `hooks/list` RPC rather than the TUI's /hooks command: it is
scriptable, and critically it costs no model tokens, so registration can be verified
while the account is rate-limited.

Note this is a *verification* tool, not a step towards the app-server transport. The
PTY decision in the brief's section 8 stands.
"""

import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import childenv  # noqa: E402

CWD = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def rpc(proc, ident, method, params):
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": ident, "method": method, "params": params}) + "\n")
    proc.stdin.flush()
    while True:
        line = proc.stdout.readline()
        if not line:
            return None
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("id") == ident:
            return msg


def main():
    env = childenv.sanitized_copy()
    proc = subprocess.Popen(
        ["codex", "app-server"],
        cwd=CWD,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )
    try:
        init = rpc(proc, 1, "initialize", {"clientInfo": {"name": "spike-verify", "version": "0", "title": "spike"}})
        if init is None or "error" in (init or {}):
            print(f"initialize failed: {init}")
            return 1

        resp = rpc(proc, 2, "hooks/list", {"cwds": [CWD]})
        if resp is None or "error" in resp:
            print(f"hooks/list failed: {resp}")
            return 1

        entries = resp["result"]["data"]
        rc = 0
        for entry in entries:
            print(f"cwd: {entry['cwd']}")
            if entry.get("errors"):
                rc = 1
                for e in entry["errors"]:
                    print(f"  ERROR {e['path']}: {e['message']}")
            for w in entry.get("warnings", []):
                print(f"  WARN  {w}")
            ours = [h for h in entry["hooks"] if "spikes/hooks/hook_post.py" in (h.get("command") or "")]
            print(f"  {len(entry['hooks'])} hook(s) loaded, {len(ours)} ours")
            for h in entry["hooks"]:
                mark = "*" if h in ours else " "
                print(
                    f"   {mark} {h['eventName']:16} {h['handlerType']:8} "
                    f"source={h['source']:8} trust={h['trustStatus']:9} "
                    f"enabled={str(h['enabled']):5} timeout={h.get('timeoutSec')}"
                )
                if h.get("sourcePath"):
                    print(f"       from {h['sourcePath']}")
            events = sorted({h["eventName"] for h in ours})
            if events != ["sessionStart", "stop"]:
                print(f"  MISMATCH: expected ['sessionStart', 'stop'], got {events}")
                rc = 1
        return rc
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
