#!/usr/bin/env python3
"""
Terminal-outcome classification from composite evidence.

`Stop` is evidence of normal completion, not a universal turn-finalisation event, so
there is no single event an adapter can emit as `turn_end`. This module models the
terminal state explicitly and, just as importantly, records HOW it was determined --
because several outcomes are only separable using knowledge the orchestrator has about
its own actions, not from anything the child emits.

Nothing here normalises messages or tool calls. It answers one question: how did this
turn end, and how confident are we?

Validate against the recorded corpus:
    python3 spikes/transcripts/outcomes.py --validate
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from enum import Enum

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
JOURNAL = os.path.join(ROOT, "spikes", "hooks", "journal", "hook-journal.ndjson")
RESULTS = os.path.join(ROOT, "spikes", "hooks", "results.ndjson")
CLAUDE_PROJECTS = os.path.expanduser("~/.claude/projects")


class Outcome(str, Enum):
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    PERMISSION_REFUSED = "permission_refused"
    PROCESS_EXITED = "process_exited"
    TIMED_OUT = "timed_out"
    TRANSPORT_LOST = "transport_lost"
    UNKNOWN_ABNORMAL_END = "unknown_abnormal_end"
    # Not terminal. Distinguished from UNKNOWN_ABNORMAL_END on purpose: "still going"
    # and "ended somehow" are different claims and silence supports only the first.
    IN_PROGRESS = "in_progress"


class Confidence(str, Enum):
    PROVEN = "proven"          # a positive signal from the child says so
    INFERRED = "inferred"      # composite of signals, no single one decisive
    ASSUMED = "assumed"        # orchestrator's own bookkeeping, unverifiable from child
    UNCERTAIN = "uncertain"    # absence of evidence only


@dataclass
class ProcessState:
    alive: bool = True
    how_ended: str | None = None      # "graceful" | "sigterm" | "sigkill" | None


@dataclass
class OrchestratorActions:
    """What the orchestrator itself did. Unavailable if the human types directly into
    the child pane -- which is precisely why that is a product decision, not a detail."""
    sent_cancel: bool = False
    sent_permission_decision: str | None = None   # "allow" | "deny" | None
    input_is_mediated: bool = True


@dataclass
class TranscriptState:
    exists: bool = False
    has_assistant_after_prompt: bool = False
    final_stop_reason: str | None = None
    tool_result_error: bool = False
    # Codex only; Claude Code writes no equivalent.
    turn_aborted_reason: str | None = None
    task_complete: bool = False


@dataclass
class Evidence:
    agent: str
    turn_key: str | None = None                # prompt_id (claude) / turn_id (codex)
    hooks: list[str] = field(default_factory=list)
    hook_payloads: dict = field(default_factory=dict)
    transcript: TranscriptState = field(default_factory=TranscriptState)
    process: ProcessState = field(default_factory=ProcessState)
    orchestrator: OrchestratorActions = field(default_factory=OrchestratorActions)
    elapsed_s: float = 0.0
    watchdog_s: float = 300.0
    observation_gap: bool = False              # a channel we rely on went away


@dataclass
class Verdict:
    outcome: Outcome
    confidence: Confidence
    provenance: list[str]

    def __str__(self):
        return f"{self.outcome.value:22} {self.confidence.value:10} {'; '.join(self.provenance)}"


def classify(ev: Evidence) -> Verdict:
    """Ordered rules, most decisive first. Each appends its own provenance so a caller
    can tell a proven completion from a guess that happens to be right."""
    p: list[str] = []

    # 1. Positive completion signal. The only outcome any child currently proves.
    if "Stop" in ev.hooks:
        p.append("hook:Stop")
        if ev.transcript.final_stop_reason:
            p.append(f"transcript:stop_reason={ev.transcript.final_stop_reason}")
        if ev.transcript.tool_result_error:
            p.append("note:tool reported an error but the turn still completed")
        return Verdict(Outcome.COMPLETED, Confidence.PROVEN, p)

    # 2. Codex writes an explicit abort record. Claude Code writes nothing equivalent,
    #    which is the single largest asymmetry between the two adapters.
    if ev.transcript.turn_aborted_reason:
        p.append(f"transcript:turn_aborted reason={ev.transcript.turn_aborted_reason}")
        return Verdict(Outcome.CANCELLED, Confidence.PROVEN, p)

    # 3. The child is gone. Ranked above permission/cancel because a dead process
    #    explains a missing Stop on its own.
    if not ev.process.alive:
        if "SessionEnd" in ev.hooks:
            reason = (ev.hook_payloads.get("SessionEnd") or {}).get("reason")
            p.append(f"hook:SessionEnd reason={reason}")
            conf = Confidence.PROVEN
        else:
            p.append("process:exited with no SessionEnd (unclean death)")
            conf = Confidence.INFERRED
        if ev.process.how_ended:
            p.append(f"process:{ev.process.how_ended}")
        return Verdict(Outcome.PROCESS_EXITED, conf, p)

    # 4. A permission decision was pending and the turn never completed. The hook fires
    #    on REQUEST, not on decision, so this does not by itself prove a refusal -- an
    #    allow would have produced a Stop, which rule 1 already caught.
    if "PermissionRequest" in ev.hooks:
        pr = ev.hook_payloads.get("PermissionRequest") or {}
        p.append(f"hook:PermissionRequest tool={pr.get('tool_name')}")
        p.append("no hook:Stop after the request")
        if ev.orchestrator.sent_permission_decision == "deny":
            p.append("orchestrator:denied")
            return Verdict(Outcome.PERMISSION_REFUSED, Confidence.INFERRED, p)
        if ev.orchestrator.input_is_mediated:
            p.append("orchestrator:mediated input, no allow recorded")
            return Verdict(Outcome.PERMISSION_REFUSED, Confidence.INFERRED, p)
        p.append("input not mediated: cannot tell refusal from cancellation at the dialog")
        return Verdict(Outcome.PERMISSION_REFUSED, Confidence.UNCERTAIN, p)

    # 5. We cancelled it ourselves. Unverifiable from the child on Claude Code -- this
    #    is bookkeeping, and it is only trustworthy while all input is mediated.
    if ev.orchestrator.sent_cancel:
        p.append("orchestrator:sent ESC")
        if ev.orchestrator.input_is_mediated:
            return Verdict(Outcome.CANCELLED, Confidence.ASSUMED, p)
        p.append("input not mediated: another writer may have ended the turn")
        return Verdict(Outcome.CANCELLED, Confidence.UNCERTAIN, p)

    # 6. A channel we depend on went away. Says nothing about the turn itself.
    if ev.observation_gap:
        p.append("observation channel lost; turn state unobservable")
        return Verdict(Outcome.TRANSPORT_LOST, Confidence.UNCERTAIN, p)

    # 7. Deadline. Deliberately NOT cancellation: silence does not distinguish a long
    #    turn from an abandoned one, and calling it cancelled would manufacture
    #    certainty the evidence does not support.
    if ev.elapsed_s > ev.watchdog_s:
        p.append(f"watchdog:{ev.elapsed_s:.0f}s > {ev.watchdog_s:.0f}s with no Stop")
        p.append("completion is uncertain; this is not evidence of cancellation")
        if not ev.orchestrator.input_is_mediated:
            p.append("input not mediated: a direct keystroke could have ended it unseen")
            return Verdict(Outcome.UNKNOWN_ABNORMAL_END, Confidence.UNCERTAIN, p)
        return Verdict(Outcome.TIMED_OUT, Confidence.UNCERTAIN, p)

    p.append("no terminal signal yet, within watchdog")
    return Verdict(Outcome.IN_PROGRESS, Confidence.UNCERTAIN, p)


# --- corpus loading ----------------------------------------------------------------


def read_ndjson(path):
    out = []
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
    return out


def claude_transcript_state(session_id) -> TranscriptState:
    st = TranscriptState()
    if not session_id:
        return st
    for proj in os.listdir(CLAUDE_PROJECTS):
        p = os.path.join(CLAUDE_PROJECTS, proj, f"{session_id}.jsonl")
        if os.path.exists(p):
            break
    else:
        return st
    st.exists = True
    seen_user = False
    for line in open(p):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get("type") == "user":
            c = d.get("message", {}).get("content")
            if isinstance(c, str):
                seen_user = True
            elif isinstance(c, list):
                for x in c:
                    if isinstance(x, dict) and x.get("type") == "tool_result" and x.get("is_error"):
                        st.tool_result_error = True
        elif d.get("type") == "assistant" and seen_user:
            st.has_assistant_after_prompt = True
            sr = d.get("message", {}).get("stop_reason")
            if sr:
                st.final_stop_reason = sr
    return st


def load_corpus():
    """Rebuild per-run evidence from the step-2 recordings."""
    journal = read_ndjson(JOURNAL)
    by_run = {}
    for r in journal:
        rid = r.get("run_id")
        if not rid or r.get("phase") != "fired":
            continue
        e = by_run.setdefault(rid, {"hooks": [], "payloads": {}, "session": None})
        e["hooks"].append(r["event"])
        if r.get("session_id"):
            e["session"] = r["session_id"]
        try:
            e["payloads"][r["event"]] = json.loads(r.get("body") or "{}")
        except ValueError:
            pass

    cases = []
    for res in read_ndjson(RESULTS):
        rid = res["run_id"]
        if rid not in by_run:
            continue
        h = by_run[rid]
        ended = (res.get("obs") or {}).get("ended")
        scenario = res["scenario"]
        alive = ended not in ("sigterm", "sigkill", "already-exited", "graceful")
        cases.append({
            "run_id": rid,
            "scenario": scenario,
            "agent": res["agent"],
            "hooks": h["hooks"],
            "payloads": h["payloads"],
            "session": h["session"],
            "ended": ended,
            "obs": res.get("obs") or {},
            "alive": alive,
        })
    return cases


# Ground truth for the recorded scenarios. `sigterm`/`sigkill` kill the child mid-turn;
# graceful teardown after a finished turn is still a completed turn.
EXPECTED = {
    "normal": Outcome.COMPLETED,
    "two_turns": Outcome.COMPLETED,
    "tool_error": Outcome.COMPLETED,
    "session_start_only": None,          # no turn was ever submitted
    "interrupted": Outcome.CANCELLED,
    "permission_denied": Outcome.PERMISSION_REFUSED,
    "sigterm": Outcome.PROCESS_EXITED,
    "sigkill": Outcome.PROCESS_EXITED,
    "slow_hook": Outcome.COMPLETED,
    "receiver_down": Outcome.COMPLETED,
    "hook_nonzero": Outcome.COMPLETED,
}


def evidence_for(case) -> Evidence:
    sc = case["scenario"]
    # What the orchestrator would know about its own actions in each scenario.
    orch = OrchestratorActions(
        sent_cancel=sc in ("interrupted",),
        sent_permission_decision="deny" if sc == "permission_denied" else None,
        input_is_mediated=True,
    )
    proc = ProcessState(
        alive=case["scenario"] not in ("sigterm", "sigkill"),
        how_ended=case["ended"],
    )
    return Evidence(
        agent=case["agent"],
        turn_key=None,
        hooks=case["hooks"],
        hook_payloads=case["payloads"],
        transcript=claude_transcript_state(case["session"]),
        process=proc,
        orchestrator=orch,
        elapsed_s=0.0,
    )


def superseded(case):
    """The permission scenario was corrected twice before it genuinely exercised a
    refusal: a bare `echo` turned out to be auto-allowed, and an in-cwd write did not
    prompt either. Those runs are real recordings of something else, so they are
    reported and excluded rather than silently counted as failures."""
    obs = case["obs"]
    if "saw_prompt" in obs:
        return "superseded: matched its own echoed prompt, never reached a dialog"
    if obs.get("note"):
        return f"not exercised: {obs['note']}"
    return None


def validate():
    cases = load_corpus()
    print(f"{len(cases)} recorded runs\n")
    print(f"{'scenario':20} {'hooks':44} {'verdict':22} {'conf':10} ok")
    bad = 0
    checked = 0
    skipped = []
    for c in sorted(cases, key=lambda x: x["scenario"]):
        exp = EXPECTED.get(c["scenario"])
        if exp is None:
            continue
        why = superseded(c)
        if why:
            skipped.append((c["scenario"], c["run_id"], why, classify(evidence_for(c))))
            continue
        v = classify(evidence_for(c))
        ok = v.outcome == exp
        checked += 1
        if not ok:
            bad += 1
        hooks = ",".join(sorted(set(c["hooks"])))
        print(f"{c['scenario']:20} {hooks:44} {v.outcome.value:22} {v.confidence.value:10} "
              f"{'ok' if ok else 'MISMATCH exp=' + exp.value}")
        if not ok:
            for line in v.provenance:
                print(f"{'':20} -> {line}")
    if skipped:
        print(f"\n{len(skipped)} run(s) excluded — recorded, but not of the scenario they are named for:")
        for sc, rid, why, v in skipped:
            print(f"  {sc:20} {rid[-10:]}  {why}")
            print(f"  {'':20} classifier says: {v.outcome.value} ({v.confidence.value})")

    print(f"\n{checked} classified, {bad} mismatch(es)")
    return 1 if bad else 0


def demo():
    """The cases that separate the transports, shown with provenance."""
    print("Claude Code -- cancelled and permission_refused, same silence:\n")
    base = dict(agent="claude", process=ProcessState(alive=True))
    for label, ev in [
        ("ESC while thinking, input mediated",
         Evidence(hooks=["SessionStart", "UserPromptSubmit"],
                  orchestrator=OrchestratorActions(sent_cancel=True), **base)),
        ("ESC while thinking, human typed it",
         Evidence(hooks=["SessionStart", "UserPromptSubmit"], elapsed_s=400,
                  orchestrator=OrchestratorActions(input_is_mediated=False), **base)),
        ("permission dialog refused",
         Evidence(hooks=["SessionStart", "UserPromptSubmit", "PermissionRequest"],
                  hook_payloads={"PermissionRequest": {"tool_name": "Write"}},
                  orchestrator=OrchestratorActions(sent_permission_decision="deny"), **base)),
        ("silent for 400s, nothing else known",
         Evidence(hooks=["SessionStart", "UserPromptSubmit"], elapsed_s=400, **base)),
    ]:
        print(f"  {label:38} {classify(ev)}")

    print("\nCodex -- the transcript says so outright:\n")
    ev = Evidence(agent="codex", hooks=["SessionStart"],
                  transcript=TranscriptState(exists=True, turn_aborted_reason="interrupted"))
    print(f"  {'ESC while thinking':38} {classify(ev)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--demo", action="store_true")
    args = ap.parse_args()
    if args.demo:
        demo()
        return 0
    if args.validate:
        return validate()
    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
