#!/usr/bin/env python3
"""
Transcript schema survey for both CLIs (build order step 3).

Both formats are undocumented and version-specific, so this reads what is actually on
disk rather than asserting a schema. Run it after a toolchain bump; a diff in the output
is a diff in the contract.

    python3 spikes/transcripts/characterize.py
    python3 spikes/transcripts/characterize.py --agent codex --limit 200
"""

import argparse
import collections
import glob
import json
import os
import sys

CLAUDE_GLOB = "~/.claude/projects/*/*.jsonl"
CODEX_GLOB = "~/.codex/sessions/**/rollout-*.jsonl"

# Markers that let a reader reconstruct turn lifecycle without hooks. The asymmetry
# between the two agents here is the main result of step 3.
TURN_MARKERS = {
    "codex": ["task_started", "task_complete", "turn_aborted"],
    "claude": [],
}


def load(path):
    try:
        with open(path) as fh:
            return [json.loads(l) for l in fh if l.strip()]
    except (OSError, ValueError):
        return []


def survey_claude(limit):
    files = sorted(glob.glob(os.path.expanduser(CLAUDE_GLOB)), key=os.path.getmtime)[-limit:]
    types = collections.Counter()
    keys = collections.defaultdict(set)
    stop_reasons = collections.Counter()
    content_kinds = collections.Counter()
    attach = collections.Counter()
    for f in files:
        for d in load(f):
            t = d.get("type")
            types[t] += 1
            keys[t].update(d.keys())
            if t == "assistant":
                msg = d.get("message", {})
                if msg.get("stop_reason"):
                    stop_reasons[msg["stop_reason"]] += 1
                for x in msg.get("content", []) or []:
                    if isinstance(x, dict):
                        content_kinds["assistant:" + str(x.get("type"))] += 1
            elif t == "user":
                c = d.get("message", {}).get("content")
                if isinstance(c, list):
                    for x in c:
                        if isinstance(x, dict):
                            content_kinds["user:" + str(x.get("type"))] += 1
            elif t == "attachment":
                attach[(d.get("attachment") or {}).get("type")] += 1
    return {
        "files": len(files), "line_types": types, "keys": keys,
        "stop_reasons": stop_reasons, "content_kinds": content_kinds,
        "attachments": attach,
    }


def survey_codex(limit):
    files = sorted(glob.glob(os.path.expanduser(CODEX_GLOB), recursive=True),
                   key=os.path.getmtime)[-limit:]
    types = collections.Counter()
    ev = collections.Counter()
    ri = collections.Counter()
    meta_keys = set()
    abort_reasons = collections.Counter()
    for f in files:
        for d in load(f):
            t = d.get("type")
            types[t] += 1
            p = d.get("payload") or {}
            if t == "event_msg":
                ev[p.get("type")] += 1
                if p.get("type") == "turn_aborted":
                    abort_reasons[p.get("reason")] += 1
            elif t == "response_item":
                ri[p.get("type")] += 1
            elif t == "session_meta":
                meta_keys.update(p.keys())
    return {
        "files": len(files), "line_types": types, "event_msg": ev,
        "response_item": ri, "session_meta_keys": meta_keys,
        "abort_reasons": abort_reasons,
    }


def show(title, counter, indent="  "):
    print(f"{indent}{title}")
    for k, v in sorted(counter.items(), key=lambda kv: -kv[1]):
        print(f"{indent}  {str(k):32} {v}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", choices=["claude", "codex", "both"], default="both")
    ap.add_argument("--limit", type=int, default=400, help="most recent N transcripts")
    args = ap.parse_args()

    if args.agent in ("claude", "both"):
        s = survey_claude(args.limit)
        print(f"=== Claude Code — {s['files']} transcript(s) ===")
        show("line types", s["line_types"])
        show("assistant stop_reason", s["stop_reasons"])
        show("message content blocks", s["content_kinds"])
        show("attachment types", s["attachments"])
        print("  turn lifecycle markers: NONE — a cancelled turn writes no record at all")
        print()

    if args.agent in ("codex", "both"):
        s = survey_codex(args.limit)
        print(f"=== Codex — {s['files']} rollout(s) ===")
        show("line types", s["line_types"])
        show("event_msg payload types", s["event_msg"])
        show("response_item payload types", s["response_item"])
        show("turn_aborted reasons", s["abort_reasons"])
        print(f"  session_meta keys: {sorted(s['session_meta_keys'])}")
        present = [m for m in TURN_MARKERS["codex"] if m in s["event_msg"]]
        print(f"  turn lifecycle markers: {present}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
