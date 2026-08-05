#!/usr/bin/env python3
"""
Local hook receiver. Dependency-free.

Stores every hook delivery as a fixture pair:
    fixtures/<seq>-<agent>-<event>.raw        exact request body bytes, untouched
    fixtures/<seq>-<agent>-<event>.meta.json  headers, timestamps, peer, sequence

and appends a one-line summary to fixtures/index.ndjson.

Fixtures are append-only across restarts: the sequence resumes from whatever is already
on disk, so killing and restarting the receiver mid-session (objective 6) produces a
visible gap in the index rather than a silent overwrite.

  python3 receiver.py                 # serve
  python3 receiver.py --summary       # report what was captured, no server
"""

import argparse
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
INDEX = os.path.join(FIXTURES, "index.ndjson")

_lock = threading.Lock()
_seq = 0
_started_at = time.time()


def _safe(s, limit=40):
    return re.sub(r"[^A-Za-z0-9._-]", "_", (s or "none"))[:limit]


def _init_seq():
    """Resume numbering from disk so a restart appends rather than clobbers."""
    global _seq
    os.makedirs(FIXTURES, exist_ok=True)
    highest = 0
    for name in os.listdir(FIXTURES):
        m = re.match(r"^(\d{4})-", name)
        if m:
            highest = max(highest, int(m.group(1)))
    _seq = highest


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # our own logging below is more useful

    def _json(self, code, obj):
        payload = json.dumps(obj, indent=2, sort_keys=True).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json(200, {"ok": True, "seq": _seq, "started_at": _started_at})
        if self.path.startswith("/events"):
            return self._json(200, {"events": read_index()})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        global _seq
        received = time.time()
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""

        h = {k: v for k, v in self.headers.items()}
        agent = h.get("X-Spike-Agent", "unknown")
        event = h.get("X-Spike-Event", "unknown")

        with _lock:
            _seq += 1
            seq = _seq

        stem = f"{seq:04d}-{_safe(agent)}-{_safe(event)}"
        rawpath = os.path.join(FIXTURES, stem + ".raw")
        metapath = os.path.join(FIXTURES, stem + ".meta.json")

        sent_at = None
        try:
            sent_at = float(h.get("X-Spike-Sent-At", ""))
        except ValueError:
            pass

        meta = {
            "seq": seq,
            "agent": agent,
            "event": event,
            "run_id": h.get("X-Spike-Run-Id", ""),
            "session_id": h.get("X-Spike-Session-Id", ""),
            "cli_version": h.get("X-Spike-Cli-Version", ""),
            "hook_pid": h.get("X-Spike-Hook-Pid", ""),
            "hook_ppid": h.get("X-Spike-Hook-Ppid", ""),
            "cwd": h.get("X-Spike-Cwd", ""),
            "method": self.command,
            "path": self.path,
            "peer": f"{self.client_address[0]}:{self.client_address[1]}",
            "headers": h,
            "body_bytes": len(body),
            "sent_at": sent_at,
            "received_at": received,
            "received_at_iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(received))
            + f".{int(received % 1 * 1e6):06d}",
            "transit_ms": round((received - sent_at) * 1000, 1) if sent_at else None,
            "receiver_generation": _started_at,
            "raw_file": os.path.basename(rawpath),
        }

        try:
            with open(rawpath, "wb") as fh:
                fh.write(body)
            with open(metapath, "w") as fh:
                json.dump(meta, fh, indent=2, sort_keys=True)
            with open(INDEX, "a") as fh:
                fh.write(json.dumps(meta, sort_keys=True) + "\n")
        except OSError as e:
            print(f"  ! fixture write failed: {e}", file=sys.stderr)

        print(
            f"[{seq:04d}] {meta['received_at_iso']}  {agent:7s} {event:14s} "
            f"run={meta['run_id'] or '-':16s} sess={(meta['session_id'] or '-')[:8]:8s} "
            f"{len(body)}B"
        )
        self._json(200, {"ok": True, "seq": seq})


def read_index():
    out = []
    if os.path.exists(INDEX):
        with open(INDEX) as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except ValueError:
                        pass
    return out


def summary():
    events = read_index()
    if not events:
        print("no events captured")
        return 1
    print(f"{len(events)} deliveries in {INDEX}\n")
    print(f"{'seq':>4}  {'agent':7} {'event':14} {'run_id':18} {'session':10} {'time'}")
    for e in events:
        print(
            f"{e['seq']:>4}  {e['agent']:7} {e['event']:14} "
            f"{(e.get('run_id') or '-')[:18]:18} {(e.get('session_id') or '-')[:8]:10} "
            f"{e['received_at_iso']}"
        )
    print("\nStop count per (run_id, session_id):")
    counts = {}
    for e in events:
        if e["event"] == "Stop":
            counts[(e.get("run_id") or "-", (e.get("session_id") or "-")[:8])] = (
                counts.get((e.get("run_id") or "-", (e.get("session_id") or "-")[:8]), 0) + 1
            )
    for k, v in sorted(counts.items()):
        flag = "" if v == 1 else f"   <-- expected 1, got {v}"
        print(f"  {k[0]:18} {k[1]:10} {v}{flag}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--summary", action="store_true")
    args = ap.parse_args()

    if args.summary:
        return summary()

    _init_seq()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    print(f"receiver on http://{args.host}:{args.port}/hook  fixtures -> {FIXTURES}")
    print(f"resuming sequence at {_seq + 1}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
