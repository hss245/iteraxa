"""Drive the loop with fake agents and assert it iterates like a person: switch and escalate when stuck,
ask after three approaches, resume with the user's hint, propose checks, and verify a hypothesis verdict."""

from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from iteraxa import loop as loop_mod
from iteraxa import team
from iteraxa.loop import clean_report, differences, failure_hash, is_limit, main, render_report_html, reset_at

FAKE_IX = """#!/usr/bin/env python3
import json, os, subprocess, sys
args = sys.argv[1:]

def flag(name):
    return args[args.index(name) + 1] if name in args else ""

role = sys.stdin.read().split()[-1]
agent, model, readonly, ws = flag("-agent"), flag("-model"), "-readonly" in args, flag("-workspace")
open(flag("-pidfile"), "w").write("0\\n")
line = [agent, flag("-max-usd"), str("-lean" in args), flag("-effort") or "-"] + ([model] if model else [])
line += (["copy"] if os.path.realpath(ws) != os.path.realpath(os.environ["REAL_WS"]) else []) + (["readonly"] if readonly else [])
with open(os.environ["SPAWN_LOG"], "a") as fh:
    fh.write(" ".join(line) + "\\n")
fail = json.loads(os.environ.get("FAKE_FAIL") or "{}").get(agent)  # [message, how many calls fail]
if fail:
    count = os.environ["SPAWN_LOG"] + "." + agent
    n = int(open(count).read()) if os.path.exists(count) else 0
    if n < fail[1]:
        open(count, "w").write(str(n + 1))
        open(flag("-result"), "w").write(json.dumps({"agent": agent, "ok": False, "cost_usd": 0, "tokens": 0, "has_usd": True,
                                                     "output": fail[0], "error": fail[0]}))
        sys.exit(1)
work = os.environ.get("FAKE_WORK_" + role.upper()) or json.loads(os.environ.get("FAKE_WORK_BY") or "{}").get(model) or os.environ.get("FAKE_WORK")
if not readonly and work:
    subprocess.run(work, shell=True, cwd=ws, check=True)
note = '{"cause": "guess %s", "probe": "p", "fix": "f %s", "ruled_out": ["not %s"], "ask": ""}' % (agent, model or agent, agent)
said = os.environ.get("FAKE_" + role.upper()) if role != "work" else None
out = said or os.environ.get("FAKE_READONLY_OUTPUT" if readonly else "FAKE_OUTPUT") or "worked. " + note
open(flag("-result"), "w").write(json.dumps({"agent": agent, "ok": True, "cost_usd": 0.01, "tokens": 0, "has_usd": True, "output": out}))
"""

FAKE_PACK = """#!/usr/bin/env python3
import os, sys
data = sys.stdin.read()
cmd = sys.argv[1]
ROLES = {"You lead a team": "lead", "You are one investigator": "investigate", "reviewing a teammate": "review",
         "Scope this task": "scope", "Judge progress on this task": "judge"}
if cmd == "decode":
    sys.stdout.write(os.environ["GOAL_JSON"])
elif cmd == "pack":
    with open(os.environ["PACK_LOG"], "a") as fh:
        fh.write(data.replace("\\n", " ") + "\\n")
    sys.stdout.write("PROMPT " + next((r for k, r in ROLES.items() if k in data), "work") + "\\n")
else:
    sys.stdout.write("turns[0]:\\n")
"""

PASS_ON_THIRD = """
import pathlib, sys
p = pathlib.Path(__file__).with_name("count")
n = int(p.read_text()) if p.exists() else 0
p.write_text(str(n + 1))
sys.exit(0 if n + 1 >= 3 else 1)
"""

ALWAYS_FAIL = "import sys, time\nprint('connection refused at', time.time())\nsys.exit(1)\n"

ANALYSIS = """cat > analysis.py <<'EOF'
import json
xs = [1, 2, 3, 4]
json.dump({"hypothesis": "h", "method": "mean test", "threshold": "mean > 3", "results": {"mean": sum(xs) / len(xs), "n": len(xs)},
           "verdict": "rejected", "evidence": "mean 2.5 is not above 3", "reproduce": "python3 analysis.py"}, open("verdict.json", "w"))
EOF
python3 analysis.py
"""


def write_exe(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(0o755)


def run_case(tmp: Path, goal: dict, env: dict[str, str] | None = None, check: str | None = None):
    ws, bin_dir = tmp / "ws", tmp / "bin"
    ws.mkdir(parents=True, exist_ok=True)
    if not bin_dir.exists():
        bin_dir.mkdir()
        write_exe(bin_dir / "ix", FAKE_IX)
        write_exe(bin_dir / "ixpack", FAKE_PACK)
    if check is not None:
        (ws / "check.py").write_text(check)
        goal.setdefault("checks", [{"id": "done", "cmd": f"\"{sys.executable}\" check.py"}])
    log, packs = tmp / "spawns", tmp / "packs"
    log.write_text("")
    packs.write_text("")
    (ws / "goal.toon").write_text("ignored\n")
    # report defaults off so cases can assert exact agent sequences; the dedicated report case turns it on.
    full = {"intent": "Make the check pass", "agent": "claude", "budget_usd": 5, "max_turns": 8, "report": False, **goal}
    saved = os.environ.copy()
    os.environ.update({
        "IX_BIN": str(bin_dir / "ix"), "IXPACK_BIN": str(bin_dir / "ixpack"), "SPAWN_LOG": str(log), "REAL_WS": str(ws),
        "PACK_LOG": str(packs), "GOAL_JSON": json.dumps(full),
        "ITERAXA_CLAUDE_BIN": sys.executable, "ITERAXA_CODEX_BIN": sys.executable,
        "ITERAXA_CURSOR_BIN": str(tmp / "missing-cursor"), **(env or {}),
    })
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            code = main(["run", "--goal", str(ws / "goal.toon"), "--workspace", str(ws), "--state", str(tmp / "state")])
    finally:
        os.environ.clear()
        os.environ.update(saved)
    events = [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]
    agents = [line for line in log.read_text().splitlines() if line]
    return code, events, agents, [json.loads(p) for p in packs.read_text().splitlines() if p]


def expect(cond: bool, what: str, *detail: object) -> None:
    if not cond:
        print("selfcheck failed:", what, *detail, file=sys.stderr)
        sys.exit(1)


def last(events: list[dict], kind: str) -> dict:
    return next((e for e in reversed(events) if e["type"] == kind), {})


def main_check() -> int:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)

        # The same failure after a turn: switch agent and raise effort, then pass. Claude is capped at the budget left.
        code, events, agents, packs = run_case(root / "pass", {}, check=PASS_ON_THIRD)
        expect(code == 0 and agents == ["claude 5.00 True -", "codex 4.99 True xhigh"], "pass case", code, agents)
        expect(last(events, "finished").get("reason") == "checks_passed", "pass finish", events[-1])
        turn = last(events, "turn")
        expect(turn["cause"] == "guess codex" and turn["ruled_out"] == ["not codex"], "turn note parsed", turn)
        expect(packs[1]["ledger"]["ruled_out"] == ["not claude"] and packs[1]["ledger"]["turns"][0]["cause"] == "guess claude",
               "second prompt carries what the first turn ruled out", packs[1])

        # Three approaches on an unchanged failure (timestamps differ) rotate through installed agents, then ask the user.
        stuck = root / "stuck"
        code, events, agents, _ = run_case(stuck, {}, check=ALWAYS_FAIL)
        expect(code == 3 and [a.split()[0] for a in agents] == ["claude", "codex", "claude"], "stuck case", code, agents)
        ask = last(events, "ask")
        expect(ask.get("kind") == "hint" and "3 different approaches" in ask["question"], "stuck asks for a hint", ask)
        expect(all(a.endswith("xhigh") for a in agents[1:]), "effort rises when stuck", agents)

        # The user's hint resumes the same run: spend and turns carry over, the hint reaches the prompt.
        code, events, agents, packs = run_case(stuck, {"hints": ["use the test server"], "max_turns": 4}, check=ALWAYS_FAIL)
        expect(code == 2 and len(agents) == 1 and last(events, "finished").get("reason") == "max_turns", "resume after hint", code, agents)
        expect(packs[0]["ledger"]["user_notes"] == ["use the test server"] and agents[0].split()[1] == "4.97",
               "hint in prompt and budget carried over", packs[0], agents)

        # With no other agent installed, it keeps the same agent and still asks after three approaches.
        code, events, agents, _ = run_case(root / "lone", {}, {"ITERAXA_CODEX_BIN": str(root / "missing")}, check=ALWAYS_FAIL)
        expect(code == 3 and [a.split()[0] for a in agents] == ["claude"] * 3, "lone agent case", code, agents)

        # An agent blocked on something only the user knows pauses the run with its question.
        out = 'stuck. {"cause": "no credentials", "probe": "env", "fix": "", "ruled_out": [], "ask": "Which database should I use?"}'
        code, events, _, _ = run_case(root / "asks", {}, {"FAKE_OUTPUT": out}, check=ALWAYS_FAIL)
        expect(code == 3 and last(events, "ask").get("question") == "Which database should I use?", "agent question", events[-1])
        # Answering it is a fresh start: the asking turn does not count as a stuck attempt.
        code, events, agents, _ = run_case(root / "asks", {"hints": ["use the local server"], "max_turns": 2}, check=ALWAYS_FAIL)
        expect(agents == ["claude 4.99 True -"], "no switch or extra effort right after an answer", agents)

        # Stopped by the budget, then the limit is raised: the run continues where it left off.
        broke = root / "broke"
        code, events, agents, _ = run_case(broke, {"budget_usd": 0.02}, check=ALWAYS_FAIL)
        expect(code == 2 and last(events, "finished").get("reason") == "budget" and len(agents) == 2, "budget stop", code, agents)
        code, events, agents, _ = run_case(broke, {"budget_usd": 1, "max_turns": 3}, check=ALWAYS_FAIL)
        expect(events[0].get("resumed") and last(events, "turn").get("n") == 3 and agents[0].split()[1] == "0.98",
               "raising the budget resumes with turns and spend kept", events[0], agents)

        # No checks: a read-only turn proposes them, then the run waits for approval.
        proposal = '{"checks": [{"id": "db ok!", "cmd": "python3 -c 1", "why": "connects"}, {"id": "db ok!", "cmd": "true"}, {"cmd": ""}]}'
        code, events, agents, _ = run_case(root / "propose", {"checks": []}, {"FAKE_READONLY_OUTPUT": "Here. " + proposal})
        ask = last(events, "ask")
        ids = [c["id"] for c in ask.get("checks", [])]
        expect(code == 3 and ask.get("kind") == "checks" and ids == ["db-ok", "db-ok-2"] and agents == ["claude 5.00 True - readonly"],
               "propose checks", code, ask, agents)

        # Autonomous, no checks: a cheap read-only scope infers the goal (no approval gate), a work turn runs, then a
        # read-only judge says it is done and the run finishes with a report.
        scoped = '{"goal": "tidy the notes", "success": "notes.md reads cleanly", "checks": [], "confidence": "high", "question": ""}'
        done = '{"done": true, "worth_continuing": true, "progress": "improved", "reason": "notes read cleanly now"}'
        auto_rep = '{"report": {"title": "Notes", "outcome": "Tidied the notes", "summary": "The notes now read cleanly.", "sections": []}}'
        code, events, agents, packs = run_case(root / "auto", {"autonomous": True, "checks": [], "report": True}, {
            "FAKE_SCOPE": "Looked around. " + scoped, "FAKE_JUDGE": done, "FAKE_READONLY_OUTPUT": "Done. " + auto_rep})
        sc = last(events, "scoped")
        expect(code == 0 and last(events, "finished").get("reason") == "goal_met", "autonomous reaches goal_met", code, events[-1])
        expect(sc.get("success") == "notes.md reads cleanly" and not last(events, "ask"), "scope proceeds without asking", sc)
        expect(last(events, "judged").get("done") is True and last(events, "report"), "judge decides done and a report is written", events)
        expect(agents == ["claude 5.00 True - readonly", "claude 4.99 True -", "claude 4.98 True - readonly", "claude 4.97 True - readonly"],
               "scope and judge are cheap read-only calls around one work turn", agents)
        expect(any("What a good result looks like" in p["brief"] for p in packs), "the work turn aims at the inferred success", packs)

        # Autonomous but the task is genuinely unclear: scope asks one question instead of guessing, then stops to wait.
        unclear = '{"goal": "?", "success": "", "checks": [], "confidence": "low", "question": "Which dataset should I use?"}'
        auto2 = root / "auto-ask"
        code, events, agents, _ = run_case(auto2, {"autonomous": True, "checks": []}, {"FAKE_SCOPE": "Unsure. " + unclear})
        expect(code == 3 and last(events, "ask").get("question") == "Which dataset should I use?" and agents == ["claude 5.00 True - readonly"],
               "ambiguous scope asks once", code, events, agents)

        # Answering re-scopes with the hint; now confident it proceeds, and the judge stops it on diminishing returns.
        stop = '{"done": false, "worth_continuing": false, "progress": "same", "reason": "further rounds would not help"}'
        code, events, _, packs = run_case(auto2, {"autonomous": True, "checks": [], "hints": ["use rides.csv"], "max_turns": 6, "report": False},
                                          {"FAKE_SCOPE": "Clear now. " + scoped, "FAKE_JUDGE": stop})
        fin = last(events, "finished")
        expect(code == 0 and fin.get("reason") == "good_enough" and fin.get("note") == "further rounds would not help",
               "judge stops when more work is not worth it", code, fin)
        expect(packs[0]["ledger"].get("user_notes") == ["use rides.csv"], "the answer reaches the re-scope", packs[0])

        # Hypothesis: the agent writes verdict.json, Iteraxa re-runs it, a different agent reviews it read-only.
        code, events, agents, _ = run_case(root / "hyp", {"kind": "hypothesis", "hypothesis": "mean is above 3"},
                                           {"FAKE_WORK": ANALYSIS, "FAKE_READONLY_OUTPUT": '{"accept": true, "issues": []}'})
        fin = last(events, "finished")
        expect(code == 0 and fin.get("verdict", {}).get("verdict") == "rejected", "hypothesis verdict", code, fin)
        expect(agents == ["claude 5.00 True xhigh", "codex 4.99 True xhigh readonly"], "hypothesis agents", agents)
        expect(last(events, "review").get("accept") is True, "review event", events)

        # Team: the lead's plan is kept within limits, investigators probe in copies, one implementer fixes in place,
        # and a reviewer from the other vendor signs off.
        accept = '{"accept": true, "issues": []}'
        fixed = [{"id": "fixed", "cmd": "test -f fixed.txt"}]
        plan = {"difficulty": "medium", "why": "cause unclear", "implement": ["claude-opus"], "review": "claude-sonnet",
                "investigate": [{"theory": "wrong config file", "member": "claude-haiku"}, {"theory": "bad host", "member": "claude-opus"}],
                "budget_usd": 12, "rounds": 6}
        found = 'probed. {"theory": "x", "verdict": "refuted", "evidence": "printed the loaded config", "fix": ""}'
        tws = root / "team" / "ws"
        code, events, agents, packs = run_case(root / "team", {"team": True, "checks": fixed, "auto_limits": True}, {
            "FAKE_LEAD": json.dumps(plan), "FAKE_INVESTIGATE": found, "FAKE_REVIEW": accept,
            "FAKE_WORK_INVESTIGATE": "echo probe > probe.txt", "FAKE_WORK": "echo fixed > fixed.txt"})
        p = last(events, "plan")
        expect(code == 0 and last(events, "finished").get("reason") == "checks_passed", "team passes", code, events[-1])
        expect([x["member"]["id"] for x in p["investigate"]] == ["claude-haiku", "claude-sonnet"] and
               [m["id"] for m in p["implement"]] == ["claude-sonnet"] and p["review"]["id"] == "codex-sol",
               "no premium on a medium problem, reviewer from the other vendor", p)
        expect(agents[0] == "claude 5.00 True - haiku readonly" and all(a.endswith("copy") for a in agents[1:3]),
               "a cheap lead staffs read-only; investigators work in copies", agents)
        expect(not (tws / "probe.txt").exists() and (tws / "fixed.txt").exists(), "probes are discarded, the fix lands")
        turn = last(events, "turn")
        expect("wrong config file (refuted by Claude Haiku)" in turn["ruled_out"] and turn["member"]["id"] == "claude-sonnet",
               "refuted theories are ruled out", turn)
        expect(last(events, "review").get("member", {}).get("id") == "codex-sol" and packs[0]["ledger"]["team"][0]["id"] == "claude-haiku",
               "code review and roster in the lead's prompt", last(events, "review"), packs[0])
        sized = last(events, "sized")
        expect(sized.get("budget_usd") == 5 and sized.get("max_turns") == 6 and sized.get("estimate") == {"budget_usd": 12.01, "max_turns": 6}
               and p.get("estimate") == {"budget_usd": 12.01, "max_turns": 6},
               "the lead sizes the run within the limits it started with: fewer turns, never a bigger budget", sized, p)
        calls = [json.loads(x) for x in (root / "team" / "state" / "calls.jsonl").read_text().splitlines()]
        expect([c["role"] for c in calls] == ["lead", "investigate", "investigate", "work", "review"] and calls[0]["label"] == "Claude Haiku",
               "every agent call is logged for the Logs panel", calls)

        # Claude's account hits its usage limit: the whole vendor sits out and Codex proposes instead, without waiting.
        weekly = "You've hit your weekly limit · resets 7:30am (Europe/Lisbon)"
        code, events, agents, _ = run_case(root / "switch", {"team": True, "checks": []}, {
            "FAKE_FAIL": json.dumps({"claude": [weekly, 9]}), "FAKE_READONLY_OUTPUT": proposal})
        prop = [e for e in events if e["type"] == "proposed"]
        expect(code == 3 and [a.split()[0] for a in agents] == ["claude", "codex"] and not prop[0]["ok"] and weekly in prop[0]["error"],
               "a usage limit switches to another vendor", code, agents, prop)

        # Every installed agent is out on a usage limit: the run pauses until it lifts (read from the agent's message),
        # then the same agent carries on. The pause is real time, so the case swaps the sleep out and adds it up.
        slept: list[float] = []
        real_pause, loop_mod.pause = loop_mod.pause, slept.append
        try:
            code, events, agents, _ = run_case(root / "limit", {"checks": fixed}, {
                "ITERAXA_CODEX_BIN": str(root / "missing"), "FAKE_WORK": "echo fixed > fixed.txt",
                "FAKE_FAIL": json.dumps({"claude": ["You've hit your usage limit. Upgrade or try again in 45 minutes.", 1]})})
        finally:
            loop_mod.pause = real_pause
        lim = last(events, "limited")
        ahead = lim.get("resume_at", 0) / 1000 - time.time()
        expect(code == 0 and [a.split()[0] for a in agents] == ["claude", "claude"] and last(events, "failed").get("agent") == "claude",
               "a usage limit pauses the run, then the same agent finishes it", code, agents, events)
        expect(lim.get("agent") == "claude" and 45 * 60 < ahead < 47 * 60 and abs(sum(slept) - 46 * 60) < 5 and max(slept) <= 60,
               "the pause lasts until the limit lifts, waking each minute to look for another agent", lim, sum(slept))


        code, events, agents, _ = run_case(root / "fallback", {"checks": fixed}, {
            "FAKE_FAIL": json.dumps({"claude": ["claude exited with status 1: segfault", 1]}), "FAKE_WORK": "echo fixed > fixed.txt"})
        expect(code == 0 and [a.split()[0] for a in agents] == ["claude", "codex"] and last(events, "failed").get("agent") == "claude"
               and last(events, "turn").get("n") == 1, "a failed agent hands over to the next one", code, agents, events)

        # Nobody left (Claude replies without checks, Codex is signed out, Cursor is missing): stop at once with each reason.
        code, events, agents, _ = run_case(root / "allout", {"checks": []}, {
            "FAKE_READONLY_OUTPUT": "Looks fine to me.", "FAKE_FAIL": json.dumps({"codex": ["Not logged in · Please run /login", 9]})})
        fin = last(events, "finished")
        expect(code == 2 and fin.get("reason") == "agent_failed" and len(agents) == 2 and fin.get("error") ==
               "Cursor: not installed · Claude: replied without any checks · Codex: Not logged in · Please run /login",
               "every agent out stops with each one's reason", code, fin, agents)

        # Goal reached with the report on: one read-only call becomes a report event and a self-contained report.html.
        rep = ('{"report": {"title": "Security review", "outcome": "Found 2 issues", "summary": "Two flaws found.",'
               ' "sections": [{"heading": "Findings", "items": [{"title": "SQL injection", "severity": "critical",'
               ' "detail": "user input <script> reaches the DB", "steps": ["open /login", "enter payload"]}]}],'
               ' "next_steps": ["patch the query"]}}')
        code, events, agents, _ = run_case(root / "report", {"report": True}, {"FAKE_READONLY_OUTPUT": "Done. " + rep},
                                           check="import sys; sys.exit(0)")
        rv = last(events, "report")
        expect(code == 0 and rv.get("report", {}).get("outcome") == "Found 2 issues", "report event emitted", code, rv)
        expect(len(agents) == 1 and agents[0].endswith("readonly"), "the report is one read-only call", agents)
        page = (root / "report" / "state" / "report.html").read_text()
        # The report is the user's deliverable: the author credit belongs in the app, never in the report.
        expect("Security review" in page and "critical" in page and "&lt;script&gt;" in page
               and "Harpreet Singh" not in page and "Created by" not in page, "report.html rendered and escaped, with no author credit", page[:120])

        # clean_report keeps only known fields, drops empty items and bad severities; render escapes and colours severity.
        rp = clean_report({"title": "T", "outcome": "O", "summary": "S", "next_steps": ["n", ""], "sections": [
            {"heading": "H", "items": [{"title": "X", "severity": "BOGUS", "detail": "d", "steps": ["a", "", "b"]}, {}]}]}, "intent")
        it = rp["sections"][0]["items"]
        expect(rp["title"] == "T" and len(it) == 1 and it[0]["severity"] == "" and it[0]["steps"] == ["a", "b"]
               and rp["next_steps"] == ["n"], "clean_report keeps known fields and drops junk", rp)
        page = render_report_html(clean_report(
            {"title": "<b>t</b>", "sections": [{"items": [{"title": "i", "severity": "high", "steps": ["s1"]}]}]}, "g"), "g", "code", None)
        expect("&lt;b&gt;t&lt;/b&gt;" in page and "background:#c2410c" in page and "Harpreet Singh" not in page,
               "render_report_html escapes content and colours severity", page[:80])

        # Stuck in a git repo: competing attempts in worktrees; only the attempt that passes is applied.
        gws = root / "git" / "ws"
        gws.mkdir(parents=True)
        for cmd in ("git init -q", "git -c user.email=a@b -c user.name=t commit -q --allow-empty -m init"):
            subprocess.run(cmd, shell=True, cwd=gws, check=True)
        (gws / "notes.txt").write_text("uncommitted\n")
        plan = {"difficulty": "easy", "implement": ["claude-haiku", "codex-sol"], "investigate": []}
        code, events, agents, _ = run_case(root / "git", {"team": True, "checks": fixed}, {
            "FAKE_LEAD": json.dumps(plan), "FAKE_REVIEW": accept,
            "FAKE_WORK_BY": json.dumps({"sonnet": "echo loser > loser.txt", "gpt-6.1-sol": "test -f notes.txt && echo fixed > fixed.txt"})})
        att = last(events, "attempts")
        expect(code == 0 and att.get("merged") and att.get("changed") == ["fixed.txt"], "winning attempt merged", code, att)
        expect([i["member"]["id"] for i in att["items"]] == ["claude-sonnet", "codex-sol"] and att["items"][1]["winner"],
               "stuck raises the implementer to strong and adds another vendor", att)
        expect((gws / "fixed.txt").exists() and not (gws / "loser.txt").exists(), "only the winner reaches the workspace")
        trees = subprocess.run(["git", "worktree", "list"], cwd=gws, capture_output=True, text=True).stdout.splitlines()
        expect(len(trees) == 1, "worktrees are removed after the round", trees)

        pool = [m for m in team.ROSTER if m["agent"] != "cursor"]
        s = team.staff({"implement": ["claude-opus"], "investigate": [{"theory": "t", "member": "nobody"}]}, pool, 0, "claude")
        expect(s["implement"][0]["id"] == "claude-sonnet" and s["investigate"] == [], "premium needs a hard problem; unknown members drop", s)
        s = team.staff({"difficulty": "hard", "implement": ["claude-opus"]}, pool, 0, "claude")
        expect(s["implement"][0]["id"] == "claude-opus" and s["review"]["agent"] == "codex", "hard allows premium", s)
        s = team.staff("not json", pool, 2, "codex")
        expect([m["tier"] for m in s["implement"]] == ["premium", "premium"] and len({m["agent"] for m in s["implement"]}) == 2,
               "stuck twice: premium attempts from both vendors", s)

        expect(differences({"verdict": "supported", "results": {"p": 0.01, "n": 10}},
                           {"verdict": "supported", "results": {"p": 0.01 + 1e-12, "n": 10}}) == [], "float noise is not a difference")
        expect(differences({"verdict": "supported", "results": {"p": 0.01}}, {"verdict": "rejected", "results": {"p": 0.2}}) ==
               ["verdict: supported -> rejected", "p: 0.01 -> 0.2"], "real differences are reported")
        # Reset times come from the agent's own words; anything unreadable is retried in 30 minutes.
        now = datetime(2026, 11, 4, 1, 0, tzinfo=timezone.utc).timestamp()  # 01:00 in Europe/Lisbon (UTC+0 in November)
        for msg, want in [
            ("Claude AI usage limit reached|%d" % (now + 3600), now + 3660),
            ("You've hit your usage limit. Upgrade to Pro, or try again in 2 hours 5 minutes.", now + 7560),
            ("You've hit your weekly limit · resets 2am (Europe/Lisbon)", now + 3660),
            ("5-hour limit reached · resets 12:30am (Europe/Lisbon)", now + 23 * 3600 + 1860),
            ("Rate limit reached for requests", now + 1800),
            ("Claude AI usage limit reached|%d" % (now + 30 * 86400), now + 8 * 86400),
        ]:
            expect(is_limit(msg) and reset_at(msg, now) == want, "usage limit reset time", msg, reset_at(msg, now) - now, want - now)
        for msg in ("Not logged in · Please run /login", "Credit balance is too low", "claude exited with status 1: segfault",
                    "replied without any checks", "timeout"):
            expect(not is_limit(msg), "only a limit that lifts by itself pauses a run", msg)
        review = {"id": "review", "ok": False, "code": 1}
        expect(failure_hash([{**review, "output": "Reviewer rejected: the test was deleted"}]) ==
               failure_hash([{**review, "output": "Reviewer rejected: assertions were removed"}]),
               "a reviewer that keeps rejecting counts as the same failure, however it words it")

        row = {"id": "db", "ok": False, "code": 1}
        expect(failure_hash([{**row, "output": "refused at 12:00:01 port 5432"}]) == failure_hash([{**row, "output": "refused at 12:09:44 port 5433"}]),
               "timestamps and ports do not make a failure look new")
    print("selfcheck ok")
    return 0


if __name__ == "__main__":
    sys.exit(main_check())
