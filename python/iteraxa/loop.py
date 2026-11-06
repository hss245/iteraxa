"""Iterate on a goal the way a person does: reproduce, name a cause, probe it, fix, re-check, note what was ruled out.

Exit codes: 0 finished (goal reached, or judged good enough), 2 stopped short (budget, turns, no agent left, an error
mid-run, or SIGTERM), 3 waiting for the user, 1 the goal could not be read.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import html
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from iteraxa import team

SUMMARY_CHARS = 600
AGENTS = team.VENDORS
KINDS = ("code", "research", "hypothesis")
STUCK_LIMIT = 3  # different approaches on an unchanged failure before asking the user
LEDGER_TURNS = 8  # ponytail: older turns drop out of the prompt; their ruled-out causes stay
WAITING = 3
VERDICT_MAX = 64_000  # bytes; verdict.json is agent-written and flows into meta.json, the review and the report
LIMIT_RETRY = 30 * 60  # a usage limit whose message gives no reset time is retried after this many seconds
LIMIT_POLL = 60  # while paused for a usage limit, look for a newly installed agent CLI this often
LIMIT_LONGEST = 8 * 86400  # never plan a pause longer than this; a weekly limit fits
MAX_LIMIT_PAUSES = 400  # pauses in a row with no turn in between (about a week of retries) before giving up

# Set when the daemon stops the run (SIGTERM): start nothing new, kill what is running, remove team copies, exit.
STOP = threading.Event()

WORK_RULES = """Work the way an experienced engineer iterates:
1. Reproduce: run the failing check below and read the real error, not just the exit code.
2. Diagnose: name the most likely cause. Skip anything in ruled_out and any approach already listed in turns.
3. Probe before changing code: confirm the cause with a quick experiment (print the config that is actually loaded, list the real collection or table names, ping the host, run the failing piece alone).
4. Fix: make the smallest change that addresses the confirmed cause, then run the failing check yourself.
Iteraxa re-runs every check and decides when the goal is reached; do not claim success."""

NETWORK_ON = ("Network access is on: you may connect to the databases, services and websites this goal needs. "
              "Do not change remote data unless the goal asks for it.")
NETWORK_OFF = 'Network access is off for this goal. If the fix needs a database, service or the internet, say so in "ask".'

NOTE_RULES = """End your reply with one line of JSON describing this turn:
{"cause": "what you think is wrong", "probe": "what you ran to check it", "fix": "what you changed", "ruled_out": ["causes you eliminated"], "ask": ""}
Fill "ask" only when you are blocked on something only the user knows (credentials, which environment or dataset, intended behaviour). Iteraxa pauses and shows them your question."""

HYPOTHESIS_RULES = """Test it like a careful analyst. Look at the data first, pick a method that fits it, and state the decision threshold before you look at the result. Supported and rejected are both good outcomes; never tune the analysis toward one of them.
Write a script that runs the whole analysis from the raw data and writes verdict.json in the workspace:
{"hypothesis": "...", "method": "...", "threshold": "for example p < 0.05", "results": {"p_value": 0.012, "n": 1200}, "verdict": "supported" or "rejected", "evidence": "two or three sentences", "reproduce": "the command that re-runs the script"}
Fix random seeds so a re-run gives the same numbers. Iteraxa re-runs that command, and a different agent reviews the reasoning."""

PROPOSE_RULES = """Nobody has written a check for this goal yet. Take a quick look around the workspace without changing anything: the README, the file tree and the files the goal points at, a handful of reads rather than an audit, and answer within about a minute; the team digs deeper once work starts. Then propose 1 to 4 shell commands, run from the workspace folder, that exit 0 only when the goal is really met and fail now. Test the real behaviour (connect and run the query, run the analysis, run the tests) rather than only checking that a file exists. The user approves them before work starts.
Reply with one line of JSON: {"checks": [{"id": "short-name", "cmd": "shell command", "why": "what it proves"}]}"""

SCOPE_RULES = """Scope this task: no success criteria were given, so work out what it is really asking and what a good result looks like. Take a quick read-only look around the workspace (the README, the file tree, the files the task points at), a handful of reads over about a minute, and change nothing.
If a shell command could objectively prove the result (a test passes, a build succeeds, a metric clears a bar), propose 1 to 3 such checks; for an open-ended task (research, a review, an explanation) leave checks empty and describe success in words instead.
Set "question" only when the task is genuinely ambiguous and you cannot tell what is wanted; otherwise leave it empty and the work starts without waiting for the user.
Reply with one line of JSON: {"goal": "one-line restatement of the task", "success": "what a good result looks like, in plain language", "checks": [{"id": "short-name", "cmd": "shell command", "why": "what it proves"}], "confidence": "high|medium|low", "question": ""}"""

JUDGE_RULES = """Judge progress on this task, read-only, and change nothing. Look at the workspace and what the team has done so far (turns, and the success criteria below). Decide two things: is the result already good enough to stop, and if not, is another round still worth the cost or has progress stalled?
Judge against the goal, not perfection. More spend is only worth it when the next round would clearly improve the result; when it would not, say so and the run stops without burning more budget.
Reply with one line of JSON: {"done": true, "worth_continuing": true, "progress": "improved|same|worse", "reason": "one sentence", "summary": "where it stands, one or two sentences"}"""

AUTO_WORK_RULES = """Work toward the goal and the success criteria above. There is no preset check, so make real, verifiable progress each turn and leave the result in the workspace: the file, analysis, answer or change the goal calls for. Look first, make the smallest useful change or addition, then confirm it yourself where you can. A separate judge decides when the result is good enough, so do not claim success; just make it better."""

REVIEW_RULES = """You are reviewing someone else's hypothesis test. Be skeptical but fair.
Read verdict.json (shown below), the analysis script and the data in this workspace. Check that the method fits the data and the question, the threshold is stated and applied correctly, the sample is right, and there is no leakage, p-hacking or bug. Then decide whether the evidence supports the verdict. Accept a sound conclusion even if you would have analysed it differently. Do not change any files.
Reply with one line of JSON: {"accept": true, "issues": ["..."]}"""

LEAD_RULES = """You lead a team of AI agents working on this goal. Read the goal, the failing output and what the team already tried (turns, ruled_out, user_notes). Staff the next round from this brief and answer quickly: open a file only if you cannot decide without it, and change nothing; the investigators do the digging. Use only member ids from "team" (tier and price per million tokens are listed).
- Clear, simple failure: no investigators, one fast or strong implementer.
- Unclear cause: a few investigators, each testing a different theory not in ruled_out. They probe in throwaway copies, so fast members are usually enough.
- One implementer makes the fix. List more than one only when "stuck" is above 0: they then compete in separate copies and the checks pick the winner. Mix vendors.
- A reviewer from another vendor checks the work once the checks pass.
- Spend as if it were your own money: premium members only for hard problems or when stuck.
- Estimate what finishing the goal needs from here, this round included: "budget_usd" in dollars and "rounds". Size it to this problem; Iteraxa uses it as the run's limits.
Reply with one line of JSON:
{"difficulty": "easy|medium|hard", "why": "one sentence", "investigate": [{"theory": "...", "member": "id"}], "implement": ["id"], "review": "id", "budget_usd": 1.5, "rounds": 3}"""

INVESTIGATE_RULES = """You are one investigator on a team. Test exactly the theory below about why the check fails. You are in a throwaway copy of the workspace: run whatever probes you need (print the config that is actually loaded, list the real collection or table names, ping the host, run the failing piece alone), but do not try to fix the goal; your changes are discarded. Linked folders (node_modules, .venv and similar) are shared with the real workspace: do not install into or change them.
Reply with one line of JSON: {"theory": "...", "verdict": "confirmed" | "refuted" | "unclear", "evidence": "what you ran and what it showed", "fix": "the fix you would make, if confirmed"}"""

ATTEMPT_RULES = """Other agents are attempting this in parallel, each in its own copy of the workspace; Iteraxa re-runs the checks in every copy and applies only the best one. Linked folders (node_modules, .venv and similar) are shared: do not install into or change them."""

CODE_REVIEW_RULES = """You are reviewing a teammate's change; all the checks now pass. Look for anything that makes them pass without really meeting the goal: weakened or deleted tests, hard-coded results, skipped steps, secrets written to files, behaviour broken elsewhere. Accept a sound change even if you would have written it differently. Do not change any files.
Reply with one line of JSON: {"accept": true, "issues": ["..."]}"""

REPORT_RULES = """The goal is met. Write the final report the person who set this goal will read: they want results, not process, and not a single line of the check commands or code. Look around the workspace read-only so every statement is grounded in what is actually there.
Reply with one line of JSON:
{"report": {"title": "short title for this result", "outcome": "one sentence saying what was achieved or found", "summary": "2 to 4 plain-language sentences anyone can follow", "sections": [{"heading": "...", "body": "a short paragraph, optional", "items": [{"title": "...", "severity": "critical|high|medium|low|info, or empty", "detail": "what it is and why it matters", "steps": ["concrete, ordered steps to reproduce or demonstrate it"]}]}], "next_steps": ["optional follow-ups"]}}
How to write it:
- Say what is true now and what it means, in plain language. No code, no shell, no file dumps.
- If the goal is an audit or analysis (security, performance, data quality and the like), make each finding one item with a severity and numbered steps to reproduce it. Leave severity empty when it does not apply.
- Shape the sections to this goal; keep it tight and drop any field you would leave blank."""

# Each kind of goal is reported its own way.
REPORT_KIND = {
    "code": "This was a coding goal: cover what was broken, the underlying cause, what you changed, and how you confirmed it works now.",
    "research": "This was a research goal: lead with the key findings, each with the evidence or source behind it.",
    "hypothesis": "This was a hypothesis test: state the verdict in plain language, the method and threshold, and the evidence. The measured numbers are shown separately, so do not repeat them all.",
}

SEVERITY = {"critical": "#b91c1c", "high": "#c2410c", "medium": "#b45309", "low": "#2563eb", "info": "#475569"}
KIND_LABEL = {"code": "Code", "research": "Research", "hypothesis": "Hypothesis"}


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def ixpack() -> str:
    return os.environ.get("IXPACK_BIN", "ixpack")


def ix_bin() -> str:
    return os.environ.get("IX_BIN", "ix")


def run_ixpack(cmd: str, payload: str) -> str:
    proc = subprocess.run([ixpack(), cmd], input=payload.encode(), capture_output=True)
    if proc.returncode != 0:
        err = proc.stderr.decode() or proc.stdout.decode()
        raise RuntimeError(err.strip() or f"ixpack {cmd} failed")
    return proc.stdout.decode()


def installed(agent: str) -> bool:
    env = os.environ.get(f"ITERAXA_{agent.upper()}_BIN")
    if env:
        return shutil.which(env) is not None
    names = ("cursor-agent", "agent") if agent == "cursor" else (agent,)
    return any(shutil.which(n) for n in names)


def next_agent(current: str, skip: object = ()) -> str | None:
    """The next installed agent after `current` (Cursor, then Claude, then Codex, round again) not in `skip`."""
    i = AGENTS.index(current)
    return next((a for a in AGENTS[i + 1:] + AGENTS[:i] if installed(a) and a not in skip), None)


def estimate(plan: object, spent: float, done: int) -> dict | None:
    """The lead's estimate for the whole goal: what is spent and done so far plus what it thinks is left."""
    try:
        usd, rounds = float(plan["budget_usd"]), int(plan["rounds"])  # type: ignore[index]
    except (TypeError, KeyError, ValueError):
        return None
    if not math.isfinite(usd) or usd <= 0 or rounds < 1:
        return None
    return {"budget_usd": round(spent + usd, 2), "max_turns": done + rounds}


def text(v: object, n: int = 300) -> str:
    return str(v or "").strip()[:n]


def last_json(s: str, key: str) -> dict | None:
    """The last JSON object in `s` that has `key`; agents put their structured answer at the end."""
    dec = json.JSONDecoder()
    i = s.rfind("{")
    while i != -1:
        try:
            obj, _ = dec.raw_decode(s, i)
            if isinstance(obj, dict) and key in obj:
                return obj
        except ValueError:
            pass
        i = s.rfind("{", 0, i)
    return None


def turn_note(output: str) -> dict:
    n = last_json(output, "cause") or {}
    ruled = n.get("ruled_out") or []
    if isinstance(ruled, str):
        ruled = [ruled]
    return {
        "cause": text(n.get("cause")),
        "probe": text(n.get("probe")),
        "fix": text(n.get("fix")),
        "ruled_out": [text(r, 200) for r in ruled if text(r)][:5] if isinstance(ruled, list) else [],
        "ask": text(n.get("ask"), 500),
    }


def clean_checks(obj: dict | None) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for i, c in enumerate((obj or {}).get("checks") or []):
        if not isinstance(c, dict) or not text(c.get("cmd"), 2000):
            continue
        cid = re.sub(r"[^A-Za-z0-9_.-]+", "-", text(c.get("id"), 40)).strip("-") or f"check-{i + 1}"
        while cid in seen:
            cid = f"{cid[:36]}-{i + 1}"
        seen.add(cid)
        out.append({"id": cid, "cmd": text(c.get("cmd"), 2000), "why": text(c.get("why"), 200)})
    return out[:4]


def run_check(workspace: Path, cmd: str, timeout: int, pidfile: Path | None = None) -> tuple[int, str]:
    """Run one check in its own session, so a timeout can kill everything it started. Its pid goes in `pidfile`,
    so the daemon can kill it too when the run is stopped or the loop dies."""
    if STOP.is_set():
        return 143, "stopped\n"
    proc = subprocess.Popen(
        cmd, shell=True, cwd=workspace, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, start_new_session=True,
    )
    if pidfile:
        pidfile.write_text(str(proc.pid))
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        out, err = proc.communicate()
        return 124, (out or "") + (err or "") + "\ncheck timed out\n"
    except BaseException:  # stopped mid-check: do not leave it running
        with contextlib.suppress(OSError):
            os.killpg(proc.pid, signal.SIGKILL)
        raise
    finally:
        if pidfile:
            pidfile.unlink(missing_ok=True)
    return proc.returncode or 0, (out or "") + (err or "")


def failing(results: list[dict]) -> list[dict]:
    return [r for r in results if not r["ok"] and not r.get("skipped")]


def failure_hash(results: list[dict]) -> str:
    """Same error, same hash: numbers, addresses and timestamps are masked so a retry that only moves a port or clock still counts as unchanged."""
    h = hashlib.sha256()
    for r in failing(results):
        # A reviewer words the same objection differently every time; that it objected again is what counts.
        tail = "" if r["id"] == "review" else "\n".join(r["output"].lower().splitlines()[-40:])
        h.update(f"{r['id']}\0{r['code']}\0{re.sub(r'0x[0-9a-f]+|[0-9]+', '#', tail)}\0".encode())
    return h.hexdigest()[:12]


def failure_text(results: list[dict]) -> str:
    return "\n".join(f"check {r['id']} exit {r['code']}:\n{r['output']}" for r in failing(results))


def failed_ids(results: list[dict]) -> str:
    return "+".join(r["id"] for r in failing(results)) or "none"


# A usage or rate limit lifts by itself; a sign-in problem, a crash or an empty answer does not.
LIMIT = re.compile(r"usage limit|rate.?limit|limit reached|hit your \w+ limit|too many requests|try again (?:in|at|after) \d"
                   r"|resets? (?:at |in )?\d", re.I)
_UNIT = r"(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b"
DELAY = re.compile(rf"\b(?:in|after)\s+(\d+\s*{_UNIT}(?:[\s,]+(?:and\s+)?\d+\s*{_UNIT})*)", re.I)


def is_limit(why: str) -> bool:
    return bool(LIMIT.search(why))


def reset_at(msg: str, now: float) -> float:
    """When a usage limit lifts, read from the agent's own message: an epoch ("usage limit reached|1767225600"), a
    delay ("try again in 2 hours 5 minutes") or a clock time ("resets 7:30am (Europe/Lisbon)"). Unreadable: retry in
    30 minutes. A minute is added so the retry lands after the reset, not on it."""
    t: float | None = None
    if m := re.search(r"\|(\d{10})\b", msg):
        t = float(m[1])
    elif m := DELAY.search(msg):
        unit = {"d": 86400, "h": 3600, "m": 60, "s": 1}
        t = now + sum(int(n) * unit[u[0].lower()] for n, u in re.findall(r"(\d+)\s*([a-z]+)", m[1], re.I))
    else:
        t = clock_time(msg, now)
    if t is None:
        return now + LIMIT_RETRY
    return min(max(t, now) + 60, now + LIMIT_LONGEST)


def clock_time(msg: str, now: float) -> float | None:
    """The next time the clock in "resets 7:30am (Europe/Lisbon)" or "try again at 15:05" comes round, in the time
    zone the message names, else the local one. A date in the message is ignored: an early retry just pauses again."""
    k = re.search(r"resets?|try again|available", msg, re.I)
    if not k:
        return None
    for m in re.finditer(r"\b(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\b\.?)?", msg[k.end():], re.I):
        if m[2] or m[3]:
            break
    else:
        return None
    hour, minute = int(m[1]), int(m[2] or 0)
    if m[3]:
        hour = hour % 12 + (12 if m[3][0].lower() == "p" else 0)
    if hour > 23 or minute > 59:
        return None
    tz = None
    if z := re.search(r"\(([A-Za-z]+/[A-Za-z_+\-/]+)\)", msg):
        with contextlib.suppress(KeyError, ValueError, OSError):
            tz = ZoneInfo(z[1])
    base = datetime.fromtimestamp(now, tz) if tz else datetime.fromtimestamp(now).astimezone()
    at = base.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if at.timestamp() <= now:
        at += timedelta(days=1)
    return at.timestamp()


def pause(seconds: float) -> None:
    """Sleep through part of a usage-limit pause. The selfcheck replaces it so its cases do not wait."""
    time.sleep(seconds)


def stop_on_term(signum: int, frame: object) -> None:
    STOP.set()
    raise SystemExit(2)  # unwinds through every finally: checks are killed, team copies removed


def read_verdict(path: Path) -> tuple[dict | None, str]:
    if not path.exists():
        return None, "verdict.json does not exist yet. Write it from the analysis script."
    if path.stat().st_size > VERDICT_MAX:
        return None, f"verdict.json is over {VERDICT_MAX // 1000} KB; keep it to the verdict and the key numbers"
    try:
        v = json.loads(path.read_text())
    except ValueError as exc:
        return None, f"verdict.json is not valid JSON: {exc}"
    if not isinstance(v, dict):
        return None, "verdict.json must be a JSON object"
    missing = [k for k in ("hypothesis", "method", "threshold", "evidence", "reproduce") if not text(v.get(k))]
    if missing:
        return None, "verdict.json is missing: " + ", ".join(missing)
    if v.get("verdict") not in ("supported", "rejected"):
        return None, 'verdict.json "verdict" must be "supported" or "rejected"'
    if not isinstance(v.get("results"), dict) or not v["results"]:
        return None, 'verdict.json "results" must be an object with the measured numbers'
    return v, ""


def differences(a: dict, b: dict) -> list[str]:
    """What changed between two verdicts. Numbers match within a relative 1e-6, so float noise is not a difference."""
    out = []
    if a.get("verdict") != b.get("verdict"):
        out.append(f"verdict: {a.get('verdict')} -> {b.get('verdict')}")
    ra, rb = a.get("results") or {}, b.get("results") or {}
    for k in sorted(set(ra) | set(rb)):
        x, y = ra.get(k), rb.get(k)
        nums = all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (x, y))
        if nums and math.isclose(x, y, rel_tol=1e-6, abs_tol=1e-9):
            continue
        if x != y:
            out.append(f"{k}: {x} -> {y}")
    return out


def write_atomic(path: Path, data: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(data)
    tmp.replace(path)


def clean_report(data: object, intent: str) -> dict:
    """Trust nothing from the agent: keep only known fields, bounded in size, dropping anything empty."""
    d = data if isinstance(data, dict) else {}
    sections = []
    for s in (d.get("sections") or [])[:12] if isinstance(d.get("sections"), list) else []:
        s = s if isinstance(s, dict) else {}
        items = []
        for it in (s.get("items") or [])[:20] if isinstance(s.get("items"), list) else []:
            it = it if isinstance(it, dict) else {}
            steps = it.get("steps") or []
            steps = [text(x, 400) for x in steps if text(x)][:12] if isinstance(steps, list) else []
            sev = str(it.get("severity") or "").strip().lower()
            item = {"title": text(it.get("title"), 200), "severity": sev if sev in SEVERITY else "",
                    "detail": text(it.get("detail"), 1600), "steps": steps}
            if item["title"] or item["detail"] or item["steps"]:
                items.append(item)
        heading, body = text(s.get("heading"), 160), text(s.get("body"), 1600)
        if heading or body or items:
            sections.append({"heading": heading, "body": body, "items": items})
    nxt = d.get("next_steps") or []
    nxt = [text(x, 400) for x in nxt if text(x)][:8] if isinstance(nxt, list) else []
    return {"title": text(d.get("title"), 160) or text(intent, 160), "outcome": text(d.get("outcome"), 400),
            "summary": text(d.get("summary"), 2400), "sections": sections, "next_steps": nxt}


def _verdict_block(verdict: dict) -> str:
    """The hypothesis verdict rendered below the summary: badge, method/threshold/evidence, measured numbers."""
    e = html.escape
    ok = verdict.get("verdict") == "supported"
    rows = "".join(f'<div class="kv"><span>{e(str(k))}</span><b>{e(str(v))}</b></div>' for k, v in (verdict.get("results") or {}).items())
    extra = "".join(f"<p>{e(str(verdict.get(k)))}</p>" for k in ("method", "threshold", "evidence") if text(verdict.get(k)))
    return f'<div class="verdict {"ok" if ok else "bad"}"><span class="vbadge">{"Supported" if ok else "Rejected"}</span>{extra}<div class="kvs">{rows}</div></div>'


def render_report_html(report: dict, intent: str, kind: str, verdict: dict | None) -> str:
    """A self-contained HTML file the user can open or share: results only, styled, every value escaped."""
    e = html.escape
    blocks: list[str] = []
    if verdict:
        blocks.append(_verdict_block(verdict))
    for s in report["sections"]:
        items = ""
        for it in s["items"]:
            sev = f'<span class="sev" style="background:{SEVERITY[it["severity"]]}">{e(it["severity"])}</span>' if it["severity"] else ""
            steps = ("<ol>" + "".join(f"<li>{e(x)}</li>" for x in it["steps"]) + "</ol>") if it["steps"] else ""
            title = f'<div class="ititle">{sev}<b>{e(it["title"])}</b></div>' if it["title"] or sev else ""
            detail = f"<p>{e(it['detail'])}</p>" if it["detail"] else ""
            items += f'<div class="item">{title}{detail}{steps}</div>'
        body = f"<p>{e(s['body'])}</p>" if s["body"] else ""
        head = f"<h2>{e(s['heading'])}</h2>" if s["heading"] else ""
        blocks.append(f"<section>{head}{body}{items}</section>")
    nxt = ("<section><h2>Next steps</h2><ul>" + "".join(f"<li>{e(x)}</li>" for x in report["next_steps"]) + "</ul></section>") if report["next_steps"] else ""
    outcome = f'<p class="outcome">{e(report["outcome"])}</p>' if report["outcome"] else ""
    summary = f'<p class="summary">{e(report["summary"])}</p>' if report["summary"] else ""
    return _REPORT_TEMPLATE.format(
        title=e(report["title"]), kind=e(KIND_LABEL.get(kind, kind.title())), goal=e(intent),
        outcome=outcome, summary=summary, body="".join(blocks) + nxt)


_REPORT_TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
:root {{ color-scheme: light dark; }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
  color: #0f172a; background: #eef1f7; padding: 32px 16px; }}
.wrap {{ max-width: 820px; margin: 0 auto; background: #fff; border-radius: 16px;
  box-shadow: 0 10px 40px -18px rgba(15,23,42,.35); overflow: hidden; }}
header {{ padding: 28px 32px; border-bottom: 1px solid #e7ebf3; }}
.kind {{ display: inline-block; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  color: #0f6cbd; background: #e8f1fb; padding: 3px 10px; border-radius: 999px; }}
h1 {{ font-size: 26px; margin: 12px 0 0; line-height: 1.25; }}
.goal {{ color: #64748b; font-size: 14px; margin: 8px 0 0; }}
.outcome {{ font-size: 18px; font-weight: 600; margin: 20px 32px 0; }}
.summary {{ margin: 10px 32px 0; color: #334155; }}
main {{ padding: 8px 32px 32px; }}
section {{ margin-top: 26px; }}
h2 {{ font-size: 16px; text-transform: uppercase; letter-spacing: .03em; color: #475569; margin: 0 0 10px;
  padding-bottom: 8px; border-bottom: 1px solid #eef1f7; }}
.item {{ padding: 14px 16px; margin: 10px 0; background: #f8fafc; border: 1px solid #eef1f7; border-radius: 12px; }}
.ititle {{ display: flex; align-items: center; gap: 10px; }}
.ititle b {{ font-size: 15px; }}
.sev {{ color: #fff; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em;
  padding: 2px 8px; border-radius: 999px; }}
.item p {{ margin: 8px 0 0; color: #334155; }}
ol, ul {{ margin: 10px 0 0; padding-left: 22px; }}
li {{ margin: 4px 0; }}
.verdict {{ margin: 20px 32px 0; padding: 16px; border-radius: 12px; border: 1px solid #e7ebf3; }}
.verdict.ok {{ background: #ecfdf3; border-color: #bbf7d0; }}
.verdict.bad {{ background: #fef2f2; border-color: #fecaca; }}
.vbadge {{ font-weight: 700; }}
.kvs {{ display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 10px; }}
.kv span {{ color: #64748b; margin-right: 6px; }}
footer {{ padding: 18px 32px; border-top: 1px solid #e7ebf3; color: #94a3b8; font-size: 13px;
  display: flex; justify-content: space-between; flex-wrap: wrap; gap: 6px; }}
@media (prefers-color-scheme: dark) {{
  body {{ color: #e8ecf4; background: #0c0f16; }}
  .wrap {{ background: #11141c; }}
  header, footer, h2, .item, .verdict {{ border-color: #222634; }}
  .goal, .summary, .item p {{ color: #a7b1c2; }}
  .item {{ background: #161a23; }}
  .kind {{ background: #16263a; color: #4aa3ff; }}
  .verdict.ok {{ background: #0f2419; }} .verdict.bad {{ background: #2a1414; }}
}}
</style></head>
<body><div class="wrap">
<header><span class="kind">{kind}</span><h1>{title}</h1><p class="goal">{goal}</p></header>
{outcome}{summary}
<main>{body}</main>
<footer><span>Iteraxa</span></footer>
</div></body></html>
"""


class Loop:
    def __init__(self, goal: dict, workspace: Path, state: Path):
        self.workspace, self.state = workspace, state
        self.agent = goal["agent"]
        self.kind = goal.get("kind") or "code"
        self.intent = str(goal["intent"])
        self.hypothesis = text(goal.get("hypothesis"), 2000)
        self.budget = float(goal["budget_usd"])
        self.max_turns = int(goal["max_turns"])
        self.checks = goal.get("checks") or []
        self.hints = [text(h, 2000) for h in goal.get("hints") or [] if text(h)]
        self.switch_agent = bool(goal.get("switch_agent", True))
        self.network = bool(goal.get("allow_network", False))
        self.check_timeout = int(goal.get("check_timeout") or 120)
        self.lean = bool(goal.get("lean", True))
        self.models = {a: str(goal.get(f"model_{a}") or "") for a in AGENTS}
        self.team = bool(goal.get("team", False))
        self.report = bool(goal.get("report", True))  # a human-readable results report once the goal is reached
        self.autonomous = bool(goal.get("autonomous", False))  # no checks given: scope the goal and judge when to stop, no approval gate
        self.auto = bool(goal.get("auto_limits", False)) and self.team  # ponytail: sizing needs a lead, so solo runs keep the set limits
        self.log_lock = threading.Lock()
        if self.agent not in AGENTS or self.kind not in KINDS or self.budget <= 0 or self.max_turns < 1:
            raise ValueError("goal fields are invalid")
        if self.kind == "hypothesis" and not self.hypothesis:
            raise ValueError("a hypothesis goal needs the hypothesis")
        self.state_path = state / "state.json"
        try:
            self.st = json.loads(self.state_path.read_text())
        except (OSError, ValueError):
            self.st = {"turns": [], "spent": 0.0, "tokens": 0, "current": self.agent, "stuck": 0, "judged": 0, "hints_seen": 0}
        for k, v in (("reviewer", ""), ("base", None), ("scoped", False), ("success", ""), ("scoped_checks", None),
                     ("limit_pauses", 0)):
            self.st.setdefault(k, v)
        # Autonomous scope stores what it inferred; a resumed run reuses those checks instead of scoping again.
        if not self.checks and self.st["scoped"] and self.st["scoped_checks"]:
            self.checks = self.st["scoped_checks"]
        self.success = self.st["success"] or text(goal.get("success"), 2000)
        # blocked: {agent: why} for agents that failed a call; they sit out until the user replies or raises the limit,
        # or, for a usage limit, until it lifts.
        self.st["blocked"] = {}

    # --- plumbing ---

    def save(self) -> None:
        write_atomic(self.state_path, json.dumps(self.st))

    def finish(self, ok: bool, reason: str, error: str = "", **extra) -> int:
        self.save()
        ev = {"type": "finished", "ok": ok, "reason": reason, "spent_usd": round(self.st["spent"], 6), "tokens": self.st["tokens"], **extra}
        if error:
            ev["error"] = error
        emit(ev)
        return 0 if ok else 2

    def ask_user(self, kind: str, question: str, checks: list[dict] | None = None) -> int:
        self.save()
        emit({"type": "ask", "kind": kind, "question": question, "checks": checks or [], "spent_usd": round(self.st["spent"], 6)})
        return WAITING

    def pack(self, brief: str, ledger: dict, failure: str = "") -> str:
        return run_ixpack("pack", json.dumps({"brief": brief, "ledger": ledger, "failure": failure}))

    def invoke(self, agent: str, prompt: str, *, model: str = "", effort: str = "", readonly: bool = False,
               ws: Path | None = None, tag: str = "", max_usd: float | None = None, label: str = "") -> dict:
        """One agent call. Safe to run several at once when each has its own tag."""
        if STOP.is_set():
            return {"ok": False, "error": "stopped", "cost": 0.0, "duration_ms": 0}
        sfx = f"-{tag}" if tag else ""
        result_path = self.state / f"result{sfx}.json"
        result_path.unlink(missing_ok=True)
        left = self.budget - self.st["spent"] if max_usd is None else max_usd
        argv = [
            ix_bin(), "run-agent", "-agent", agent, "-workspace", str(ws or self.workspace), "-timeout", "10m",
            "-result", str(result_path), "-pidfile", str(self.state / f"agent{sfx}.pid"),
            # Claude stops itself at what is left, so one call can never overshoot the budget.
            "-max-usd", f"{max(left, 0.01):.2f}",
        ]
        if effort:
            argv += ["-effort", effort]
        if model:
            argv += ["-model", model]
        if self.lean:
            argv.append("-lean")
        if readonly:
            argv.append("-readonly")
        if self.network:
            argv.append("-network")
        started = time.monotonic()
        proc = subprocess.run(argv, input=prompt.encode(), capture_output=True)
        try:
            res = json.loads(result_path.read_text())
        except (OSError, ValueError):
            res = {"ok": False, "error": proc.stderr.decode()[:500] or "agent produced no result"}
        res["duration_ms"] = int((time.monotonic() - started) * 1000)
        res["cost"] = float(res.get("cost_usd") or 0) if res.get("has_usd") else 0.0
        role = re.sub(r"^r\d+-(inv|try)\d+$", lambda x: {"inv": "investigate", "try": "attempt"}[x[1]], tag)
        line = json.dumps({"at": int(time.time() * 1000), "role": role, "agent": agent, "label": label,
                           "model": res.get("model") or model, "effort": effort, "ok": bool(res.get("ok")),
                           "cost_usd": res["cost"], "estimated": bool(res.get("estimated")), "tokens": int(res.get("tokens") or 0),
                           "duration_ms": res["duration_ms"], "error": str(res.get("error") or ""), "output": str(res.get("output") or "")})
        with self.log_lock, open(self.state / "calls.jsonl", "a") as f:
            f.write(line + "\n")
        return res

    def charge(self, res: dict, member: dict | None = None, agent: str = "") -> dict:
        self.st["spent"] += res["cost"]
        self.st["tokens"] += int(res.get("tokens") or 0)
        if not res.get("ok"):
            # ponytail: any failed call benches the whole vendor (a usage limit or sign-in covers all its models);
            # a one-off network blip benches a good one too.
            self.block(member["agent"] if member else agent, str(res.get("error") or "the call failed"))
        return res

    def block(self, agent: str, why: str) -> None:
        self.st["blocked"].setdefault(agent, text(why, 500))

    def call(self, agent: str, prompt: str, effort: str, readonly: bool = False, tag: str = "") -> dict:
        return self.charge(self.invoke(agent, prompt, model=self.models[agent], effort=effort, readonly=readonly, tag=tag), agent=agent)

    def ask_member(self, m: dict, prompt: str, **kw) -> dict:
        return self.charge(self.invoke(m["agent"], prompt, model=m["model"], effort=m["effort"], label=m["label"], **kw), m)

    def solo_agent(self, wait: bool = True) -> str | None:
        """The agent for a solo turn: the current one, or the next installed one that has not failed. With nobody left
        only because of usage limits, it first waits for one to lift (unless `wait` is off)."""
        while True:
            cur = self.st["current"]
            if cur in self.st["blocked"] or not installed(cur):
                cur = next_agent(cur, self.st["blocked"])
                if cur:
                    self.st["current"] = cur
            if cur or not wait or not self.wait_out_limits():
                return cur

    def wait_out_limits(self) -> bool:
        """Every installed agent is out and at least one only hit its usage limit: pause until the first limit lifts,
        or until another agent CLI is installed, then let it back in. False when nothing will come back by itself."""
        now = time.time()
        until = {a: reset_at(why, now) for a, why in self.st["blocked"].items() if is_limit(why) and installed(a)}
        if not until or self.st["limit_pauses"] >= MAX_LIMIT_PAUSES:
            return False
        self.st["limit_pauses"] += 1
        first = min(until, key=until.__getitem__)
        emit({"type": "limited", "agent": first, "resume_at": int(until[first] * 1000), "error": self.st["blocked"][first],
              **self.totals()})
        self.save()
        waited, total = 0.0, until[first] - now
        while waited < total and time.time() < until[first]:
            step = min(LIMIT_POLL, total - waited)
            pause(step)
            waited += step
            if any(installed(a) and a not in self.st["blocked"] for a in AGENTS):
                break  # an agent CLI installed during the pause takes over
        lifted = max(time.time(), now + waited)
        for a, t in until.items():
            if t <= lifted:
                del self.st["blocked"][a]
        return True

    def all_out(self) -> int:
        """Nobody is left to work: stop with each agent's reason."""
        why = " · ".join(f"{a.capitalize()}: {self.st['blocked'].get(a) or 'not installed'}" for a in AGENTS)
        return self.finish(False, "agent_failed", why)

    def totals(self) -> dict:
        return {"spent_usd": round(self.st["spent"], 6), "tokens_total": self.st["tokens"]}

    def head(self, ws: Path | None = None) -> list[str]:
        lines = [f"Goal: {self.intent}", f"Workspace: {ws or self.workspace}"]
        if self.kind == "hypothesis":
            lines.append(f"Hypothesis: {self.hypothesis}")
        return lines

    def work_prompt(self, ws: Path, ledger: dict, failure: str, extra: str = "") -> str:
        brief = self.head(ws) + [""] + ([HYPOTHESIS_RULES, ""] if self.kind == "hypothesis" else [])
        # No checks (autonomous): aim at the inferred success criteria, not a failing check.
        rules = WORK_RULES if (self.checks or self.kind == "hypothesis") else AUTO_WORK_RULES
        if self.success and not self.checks:
            brief += [f"What a good result looks like: {self.success}", ""]
        brief += [rules] + ([extra] if extra else []) + [NETWORK_ON if self.network else NETWORK_OFF, "", NOTE_RULES]
        return self.pack("\n".join(brief), ledger, failure)

    def ledger(self) -> dict:
        turns = self.st["turns"]
        led: dict = {}
        if turns:
            led["turns"] = [{k: t[k] for k in ("n", "agent", "check", "cause", "fix")} for t in turns[-LEDGER_TURNS:]]
        ruled = list(dict.fromkeys(r for t in turns for r in t["ruled_out"]))[-12:]
        if ruled:
            led["ruled_out"] = ruled
        if self.hints:
            led["user_notes"] = self.hints
        return led

    # --- phases ---

    def pool(self, wait: bool = True) -> list[dict]:
        """Who can work now. With nobody left only because of usage limits, it first waits for one to lift."""
        while True:
            members = team.members({a for a in AGENTS if installed(a) and a not in self.st["blocked"]})
            if members or not wait or not self.wait_out_limits():
                return members

    def propose(self) -> int:
        prompt = self.pack("\n".join(self.head() + ["", PROPOSE_RULES]), {})
        while True:
            if self.st["spent"] >= self.budget:
                return self.finish(False, "budget")
            member = None
            if self.team:
                pool = self.pool()
                member = team.pick(pool, 1, self.agent) if pool else None
                agent = member["agent"] if member else None
            else:
                agent = self.solo_agent()
            if agent is None:
                return self.all_out()
            emit({"type": "running", "n": 0, "agent": agent, "phase": "propose", **({"members": [member["label"]]} if member else {})})
            res = self.ask_member(member, prompt, readonly=True, tag="propose") if member else self.call(agent, prompt, "", readonly=True, tag="propose")
            checks = clean_checks(last_json(str(res.get("output") or ""), "checks"))
            if res.get("ok") and not checks:
                res = {**res, "ok": False, "error": "replied without any checks"}
                self.block(agent, res["error"])
            emit({"type": "proposed", "agent": agent, "checks": checks, "cost_usd": res["cost"], "tokens": int(res.get("tokens") or 0),
                  "estimated": bool(res.get("estimated")), "model": res.get("model") or "", "duration_ms": res["duration_ms"],
                  "ok": bool(res.get("ok")), **({"error": text(res.get("error"), 500)} if not res.get("ok") else {}),
                  **({"member": team.public(member)} if member else {}), **self.totals()})
            if checks:
                return self.ask_user("checks", "How should Iteraxa know this goal is done? Approve or edit the checks the agent proposed.", checks)

    def scope(self) -> int | None:
        """Autonomous start with no checks: a cheap read-only agent infers the goal and what 'done' looks like, proposes
        runnable checks when they fit, and lets the work begin with no approval gate, asking the user only when the task
        is genuinely ambiguous. Returns WAITING if it asked, None to proceed into the loop."""
        if self.st["spent"] >= self.budget:
            return self.finish(False, "budget")
        member, agent = None, None
        if self.team:
            pool = self.pool()
            member = team.pick(pool, 0, self.agent) if pool else None  # cheapest member: scope first, spend later
            agent = member["agent"] if member else None
        else:
            agent = self.solo_agent()
        if agent is None:
            return self.all_out()
        prompt = self.pack("\n".join(self.head() + ["", SCOPE_RULES]), self.ledger())
        emit({"type": "running", "n": 0, "agent": agent, "phase": "scope", **({"members": [member["label"]]} if member else {})})
        res = self.ask_member(member, prompt, readonly=True, tag="scope") if member else self.call(agent, prompt, "", readonly=True, tag="scope")
        out = str(res.get("output") or "")
        data = last_json(out, "success") or last_json(out, "goal") or {}
        checks = clean_checks(data)
        goal = text(data.get("goal"), 500)
        success = text(data.get("success"), 2000) or goal
        question = text(data.get("question"), 500)
        confidence = str(data.get("confidence") or "").lower()
        emit({"type": "scoped", "agent": agent, "goal": goal, "success": success, "checks": checks,
              "confidence": confidence, "cost_usd": res["cost"], "tokens": int(res.get("tokens") or 0),
              "estimated": bool(res.get("estimated")), "model": res.get("model") or "", "duration_ms": res["duration_ms"],
              "ok": bool(res.get("ok")), **({"error": text(res.get("error"), 500)} if not res.get("ok") else {}),
              **({"member": team.public(member)} if member else {}), **self.totals()})
        if not res.get("ok"):
            return self.propose()  # could not scope: fall back to proposing checks so the run is never stuck
        self.st["success"], self.st["scoped_checks"] = success, checks
        self.success, self.checks = success, checks
        if question or confidence == "low":
            self.save()  # genuinely unclear: ask once, then a reply re-scopes with the answer in the ledger
            return self.ask_user("hint", question or "I want to be sure I understand before spending on this. What should be true when it is done?")
        self.st["scoped"] = True
        self.save()
        return None

    def judge(self, results: list[dict], verdict: dict | None) -> dict:
        """Autonomous stopping: a cheap read-only pass each round decides if the result is good enough to stop, or if
        another round is no longer worth the cost (diminishing returns). Returns {done, worth, reason}."""
        member, agent = None, None
        if self.team:
            pool = self.pool()
            member = team.pick(pool, 0, self.agent) if pool else None
            agent = member["agent"] if member else None
        else:
            agent = self.solo_agent()
        if agent is None:
            return {"done": False, "worth": True, "reason": ""}
        led = self.ledger()
        if self.success:
            led = {**led, "success": self.success}
        if results:
            led = {**led, "checks": [{"id": r["id"], "ok": r["ok"]} for r in results]}
        prompt = self.pack("\n".join(self.head() + ["", JUDGE_RULES]), led)
        emit({"type": "running", "n": len(self.st["turns"]), "agent": agent, "phase": "judge", **({"members": [member["label"]]} if member else {})})
        res = self.ask_member(member, prompt, readonly=True, tag="judge") if member else self.call(agent, prompt, "", readonly=True, tag="judge")
        d = last_json(str(res.get("output") or ""), "done") or {}
        done = d.get("done") is True and bool(res.get("ok"))
        worth = d.get("worth_continuing") is not False  # keep going unless the judge explicitly says it is not worth it
        reason = text(d.get("reason"), 300)
        emit({"type": "judged", "agent": agent, "done": done, "worth_continuing": worth, "progress": text(d.get("progress"), 40),
              "reason": reason, "cost_usd": res["cost"], "tokens": int(res.get("tokens") or 0), "estimated": bool(res.get("estimated")),
              "model": res.get("model") or "", "duration_ms": res["duration_ms"], "ok": bool(res.get("ok")),
              **({"member": team.public(member)} if member else {}), **self.totals()})
        return {"done": done, "worth": worth, "reason": reason}

    def hypothesis_rows(self, ws: Path, tag: str = "") -> tuple[list[dict], dict | None]:
        path = ws / "verdict.json"
        v, err = read_verdict(path)
        if err:
            return [{"id": "verdict", "code": 1, "ok": False, "output": err},
                    {"id": "reproduce", "code": -1, "ok": False, "skipped": True, "output": ""}], None
        rows = [{"id": "verdict", "code": 0, "ok": True, "output": ""}]
        before = self.state / f"verdict.before{'-' + tag if tag else ''}.json"
        shutil.copyfile(path, before)
        path.unlink()
        code, out = run_check(ws, v["reproduce"], self.check_timeout, self.state / f"check{'-' + tag if tag else ''}.pid")
        again, err = read_verdict(path)
        if not path.exists():
            shutil.copyfile(before, path)
        if code != 0:
            rows.append({"id": "reproduce", "code": code, "ok": False, "output": f"`{v['reproduce']}` exited {code}:\n{out}"})
        elif again is None:
            rows.append({"id": "reproduce", "code": 1, "ok": False, "output": f"`{v['reproduce']}` must write verdict.json again. {err}"})
        elif diff := differences(v, again):
            rows.append({"id": "reproduce", "code": 1, "ok": False, "output": "Re-running gave different results:\n" + "\n".join(diff)})
        else:
            rows.append({"id": "reproduce", "code": 0, "ok": True, "output": ""})
        return rows, again or v

    def reviewer(self, wait: bool = True) -> dict | None:
        """The team member who reviews: the lead's pick when still available, else a strong member from another vendor."""
        pool = self.pool(wait)
        by_id = {m["id"]: m for m in pool}
        last = self.st["turns"][-1].get("member", "") if self.st["turns"] else ""
        vendor = by_id[last]["agent"] if last in by_id else self.agent
        return by_id.get(self.st["reviewer"]) or team.pick(pool, 1, avoid={vendor})

    def review(self, rules: str, payload: dict, what: str) -> dict:
        member = self.reviewer() if self.team else None
        agent = member["agent"] if member else next_agent(self.st["current"], self.st["blocked"]) or self.st["current"]
        name = member["label"] if member else agent
        emit({"type": "running", "n": len(self.st["turns"]), "agent": agent, "phase": "review", "effort": "xhigh",
              **({"members": [name]} if member else {})})
        prompt = self.pack("\n".join(self.head() + ["", rules]), payload)
        res = self.ask_member(member, prompt, readonly=True, tag="review") if member else self.call(agent, prompt, "xhigh", readonly=True, tag="review")
        r = last_json(str(res.get("output") or ""), "accept") or {}
        accept = r.get("accept") is True and bool(res.get("ok"))
        issues = [text(x) for x in (r.get("issues") or []) if text(x)][:6] if isinstance(r.get("issues"), list) else []
        if not res.get("ok"):
            issues = issues or [f"The reviewer could not finish: {text(res.get('error'))}"]
        elif not accept and not issues:
            issues = [f"The reviewer did not accept the {what} and gave no reason; make the evidence explicit."]
        emit({"type": "review", "agent": agent, "accept": accept, "issues": issues, "cost_usd": res["cost"],
              "estimated": bool(res.get("estimated")), "duration_ms": res["duration_ms"],
              **({"member": team.public(member)} if member else {}), **self.totals()})
        out = f"accepted the {what}." if accept else f"rejected the {what}:\n- " + "\n- ".join(issues)
        return {"id": "review", "code": 0 if accept else 1, "ok": accept, "output": f"Reviewer ({name}) {out}"}

    def check_all(self, ws: Path | None = None, tag: str = "") -> tuple[list[dict], dict | None]:
        """Run every check in `ws`. Only the real workspace gets a reviewer; copies are compared on the checks alone."""
        real = ws is None
        ws = ws or self.workspace
        results = []
        pidfile = self.state / f"check{'-' + tag if tag else ''}.pid"
        for c in self.checks:
            code, output = run_check(ws, c["cmd"], self.check_timeout, pidfile)
            results.append({"id": c["id"], "code": code, "ok": code == 0, "output": output})
        verdict = None
        if self.kind == "hypothesis":
            rows, verdict = self.hypothesis_rows(ws, tag)
            results += rows
        affordable = self.st["spent"] < self.budget
        if real and self.kind == "hypothesis":
            if all(r["ok"] for r in results) and verdict and affordable:
                results.append(self.review(REVIEW_RULES, {"verdict": verdict}, "verdict"))
            else:
                results.append({"id": "review", "code": -1, "ok": False, "skipped": True, "output": ""})
        elif real and self.team and self.checks and self.st["turns"] and all(r["ok"] for r in results) and affordable:
            changes = team.changes(self.workspace, self.st["base"]) if self.st["base"] else "Read the workspace directly."
            results.append(self.review(CODE_REVIEW_RULES, {"changes": changes}, "change"))
        return results, verdict

    def make_report(self, verdict: dict | None) -> None:
        """Best-effort: one read-only agent call becomes report.html and a report event. It never fails the run."""
        try:
            member, agent = None, None
            # The goal is already met, so the report never waits out a usage limit; it is skipped instead.
            if self.team:
                pool = self.pool(wait=False)
                member = self.reviewer(wait=False) or (team.pick(pool, 1, self.agent) if pool else None)
                agent = member["agent"] if member else None
            else:
                agent = self.solo_agent(wait=False)
            if agent is None:
                return
            kind_note = REPORT_KIND.get(self.kind, "")
            brief = "\n".join(self.head() + ["", REPORT_RULES] + ([kind_note] if kind_note else []))
            led = self.ledger()
            if verdict:
                led = {**led, "verdict": {k: verdict.get(k) for k in ("verdict", "method", "threshold", "results", "evidence")}}
            prompt = self.pack(brief, led)
            emit({"type": "running", "n": len(self.st["turns"]) + 1, "agent": agent, "phase": "report",
                  **({"members": [member["label"]]} if member else {})})
            # ponytail: the report is the final deliverable, so give it a small floor even if the budget is spent.
            cap = max(self.budget - self.st["spent"], 0.40)
            res = self.invoke(agent, prompt, model=(member["model"] if member else self.models[agent]),
                              effort="", readonly=True, tag="report", max_usd=cap, label=(member["label"] if member else ""))
            self.st["spent"] += res["cost"]
            self.st["tokens"] += int(res.get("tokens") or 0)
            report = clean_report((last_json(str(res.get("output") or ""), "report") or {}).get("report"), self.intent)
            write_atomic(self.state / "report.html", render_report_html(report, self.intent, self.kind, verdict))
            write_atomic(self.state / "report.json", json.dumps(report))
            emit({"type": "report", "report": report, "report_path": str(self.state / "report.html"),
                  "cost_usd": res["cost"], "estimated": bool(res.get("estimated")),
                  **({"member": team.public(member)} if member else {}), **self.totals()})
        except (OSError, RuntimeError, ValueError, KeyError, TypeError):
            pass

    def run(self) -> int:
        self.state.mkdir(parents=True, exist_ok=True)
        emit({"type": "start", "agent": self.st["current"], "kind": self.kind, "budget_usd": self.budget,
              "max_turns": self.max_turns, "intent": self.intent, "resumed": bool(self.st["turns"] or self.st["spent"])})
        if len(self.hints) > self.st["hints_seen"]:
            self.st.update(hints_seen=len(self.hints), stuck=0, judged=len(self.st["turns"]))
        if not self.checks and self.kind != "hypothesis" and not self.st["scoped"]:
            if self.autonomous:
                code = self.scope()  # infers the goal and checks; asks only if ambiguous, else falls through
                if code is not None:
                    return code
            else:
                return self.propose()
        if self.team:
            team.prune(self.workspace)
            if self.st["base"] is None:
                self.st["base"] = team.snapshot(self.workspace, self.state)

        turns = self.st["turns"]
        while True:
            results, verdict = self.check_all()
            emit({"type": "checks", "results": [
                {"id": r["id"], "code": r["code"], "ok": r["ok"], **({"skipped": True} if r.get("skipped") else {}),
                 **({"tail": r["output"][-300:]} if not r["ok"] and r["output"] else {})} for r in results]})
            has_checks = bool(self.checks) or self.kind == "hypothesis"
            if has_checks and all(r["ok"] for r in results):
                extra = {"verdict": {k: verdict.get(k) for k in ("verdict", "method", "threshold", "results", "evidence")}} if verdict else {}
                if self.report:
                    self.make_report(verdict)
                return self.finish(True, "checks_passed", **extra)
            if self.st["spent"] >= self.budget:
                return self.finish(False, "budget")
            if len(turns) >= self.max_turns:
                return self.finish(False, "max_turns")

            digest = failure_hash(results)
            if results and turns and self.st["judged"] < len(turns):  # stuck tracking needs a failing check to compare
                self.st["judged"] = len(turns)
                self.st["stuck"] = self.st["stuck"] + 1 if turns[-1]["hash"] == digest else 0
            if results and self.st["stuck"] >= STUCK_LIMIT:
                ruled = self.ledger().get("ruled_out", [])[-5:]
                return self.ask_user("hint", (
                    f"Tried {STUCK_LIMIT} different approaches and {failed_ids(results)} still fails the same way. "
                    f"Ruled out so far: {'; '.join(ruled) or 'nothing yet'}. What should it try next, or what does it need to know?"))
            if self.autonomous and turns:  # a cheap judge each round: stop when done or when more work is not worth it
                j = self.judge(results, verdict)
                if j["done"] or not j["worth"]:
                    if self.report:
                        self.make_report(verdict)
                    return self.finish(True, "goal_met" if j["done"] else "good_enough", note=j["reason"])
            try:
                code = self.team_turn(results, digest) if self.team else self.solo_turn(results, digest)
            except (OSError, RuntimeError) as exc:
                return self.finish(False, "loop_failed", str(exc))
            if code is not None:
                return code

    def record(self, results: list[dict], digest: str, res: dict, note: dict, prompt: str, cost: float, tokens: int,
               **extra) -> int | None:
        """Write the turn to the ledger and the timeline; end or pause the run when the turn says so."""
        n = len(self.st["turns"]) + 1
        who = extra.get("member", {}).get("label") or extra["agent"]
        self.st["turns"].append({"n": n, "agent": who, "check": failed_ids(results), "hash": digest, "cost_usd": cost,
                                 "tokens": tokens, **({"member": extra["member"]["id"]} if "member" in extra else {}), **note})
        self.st["limit_pauses"] = 0
        self.save()
        ledger_json = json.dumps(self.ledger(), separators=(",", ":"))
        ledger_toon = ""
        try:
            ledger_toon = run_ixpack("encode", ledger_json)
            (self.state / "ledger.toon").write_text(ledger_toon)
        except (OSError, RuntimeError):
            pass
        emit({
            "type": "turn", "n": n, "check": failed_ids(results), "hash": digest,
            "model": res.get("model") or "", "cost_usd": cost, "tokens": tokens,
            "has_usd": bool(res.get("has_usd")), "estimated": bool(res.get("estimated")),
            "ok": bool(res.get("ok")), **({"error": text(res.get("error"), 500)} if not res.get("ok") else {}),
            **self.totals(), "duration_ms": res["duration_ms"],
            "summary": str(res.get("output") or "")[-SUMMARY_CHARS:], **note,
            "prompt_bytes": len(prompt.encode()), "ledger_toon_bytes": len(ledger_toon.encode()),
            "ledger_json_bytes": len(ledger_json.encode()), **extra,
        })
        if note["ask"]:
            return self.ask_user("hint", note["ask"])
        return None

    def solo_turn(self, results: list[dict], digest: str) -> int | None:
        if self.st["stuck"] and self.switch_agent:
            self.st["current"] = next_agent(self.st["current"], self.st["blocked"]) or self.st["current"]
        agent = self.solo_agent()
        if agent is None:
            return self.all_out()
        effort = "xhigh" if self.st["stuck"] or self.kind == "hypothesis" else ""
        prompt = self.work_prompt(self.workspace, self.ledger(), failure_text(results))
        emit({"type": "running", "n": len(self.st["turns"]) + 1, "agent": agent, "phase": "work", "effort": effort})
        res = self.call(agent, prompt, effort, tag="work")
        if not res.get("ok"):
            return self.failed_call(agent, res)
        return self.record(results, digest, res, turn_note(str(res.get("output") or "")), prompt,
                           res["cost"], int(res.get("tokens") or 0), agent=agent, effort=effort)

    def failed_call(self, agent: str, res: dict, member: dict | None = None) -> int | None:
        """A work call failed, so it is not a turn: show why and let the next agent in line take over."""
        emit({"type": "failed", "n": len(self.st["turns"]) + 1, "agent": agent, "error": text(res.get("error"), 500),
              "cost_usd": res["cost"], "estimated": bool(res.get("estimated")), "duration_ms": res["duration_ms"],
              **({"member": team.public(member)} if member else {}), **self.totals()})
        self.save()
        return self.finish(False, "budget", str(res.get("error") or "")) if self.st["spent"] >= self.budget else None

    def running(self, phase: str, members: list[dict]) -> None:
        emit({"type": "running", "n": len(self.st["turns"]) + 1, "agent": members[0]["agent"], "phase": phase,
              "members": [m["label"] for m in members]})

    def parallel(self, jobs: list[dict], use=None) -> list[dict]:
        """Run jobs at once, each agent in its own copy of the workspace, then call `use(done)` before the copies are
        dropped. A job has member, tag, prompt(ws) and optionally after(job, ws), which runs in the copy once the agent is done."""
        # Named after the run, so the daemon can sweep what a killed loop left behind (iteraxa-team-<run id>-*).
        root = Path(tempfile.mkdtemp(prefix=f"iteraxa-team-{self.state.name}-"))
        share = max(self.budget - self.st["spent"], 0.01) / len(jobs)

        def one(job: dict) -> dict:
            m = job["member"]
            try:
                job["fork"] = team.fork(self.workspace, root / job["tag"])
                ws = Path(job["fork"]["path"])
                job["res"] = self.invoke(m["agent"], job["prompt"](ws), model=m["model"], effort=m["effort"], ws=ws,
                                         tag=job["tag"], max_usd=share, label=m["label"])
                if job["res"].get("ok") and job.get("after") and not STOP.is_set():
                    job["after"](job, ws)
            except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
                job.setdefault("res", {"ok": False, "error": f"could not set up a copy of the workspace: {exc}", "cost": 0.0, "duration_ms": 0})
            return job

        try:
            with ThreadPoolExecutor(max_workers=min(len(jobs), team.MAX_PARALLEL)) as ex:
                done = list(ex.map(one, jobs))
            for j in done:
                self.charge(j["res"], j["member"])
            if use:
                use(done)
            return done
        finally:
            for j in jobs:
                if "fork" in j:
                    team.drop(j["fork"])
            shutil.rmtree(root, ignore_errors=True)

    def team_turn(self, results: list[dict], digest: str) -> int | None:
        """One round: the lead staffs it, investigators test theories in parallel copies, then one implementer fixes
        in place, or, when stuck, several compete in copies and only the best result is applied."""
        pool = self.pool()
        if not pool:
            return self.all_out()
        n, stuck, failure, ledger = len(self.st["turns"]) + 1, self.st["stuck"], failure_text(results), self.ledger()
        spent0, tokens0 = self.st["spent"], self.st["tokens"]

        raw, lead, res = None, None, {}
        if len(pool) > 1:
            lead = team.lead(pool, self.agent)
            self.running("staff", [lead])
            brief = "\n".join(self.head() + ["", LEAD_RULES, NETWORK_ON if self.network else NETWORK_OFF])
            res = self.ask_member(lead, self.pack(brief, {**ledger, "team": team.roster_rows(pool), "round": n, "stuck": stuck,
                                                         "spent_usd": round(self.st["spent"], 2)}, failure), readonly=True, tag="lead")
            raw = last_json(str(res.get("output") or ""), "implement")
            if not res.get("ok") and not (pool := self.pool()):
                return self.all_out()
        plan = team.staff(raw, pool, stuck, self.agent)
        self.st["reviewer"] = plan["review"]["id"]
        est = estimate(raw, self.st["spent"], n - 1)
        if est:
            self.st["estimate"] = est
        emit({"type": "plan", "n": n, "difficulty": plan["difficulty"], "why": plan["why"], "stuck": stuck,
              "lead": team.public(lead) if lead else None, "cost_usd": round(self.st["spent"] - spent0, 6),
              "estimated": bool(res.get("estimated")), **({"estimate": est} if est else {}),
              "investigate": [{"theory": x["theory"], "member": team.public(x["member"])} for x in plan["investigate"]],
              "implement": [team.public(m) for m in plan["implement"]], "review": team.public(plan["review"]), **self.totals()})
        if self.auto and est and not self.st.get("sized"):
            # The first estimate becomes the run's limits, within the ones it started with: the lead reads the workspace,
            # so it can size a run down but never up. A bigger estimate pre-fills "raise the limit and continue" instead.
            self.budget = min(self.budget, max(est["budget_usd"], round(self.st["spent"] + 0.05, 2)))
            self.max_turns, self.st["sized"] = min(self.max_turns, est["max_turns"]), True
            self.save()
            emit({"type": "sized", "budget_usd": self.budget, "max_turns": self.max_turns, "estimate": est, "lead": team.public(lead),
                  "why": plan["why"], **self.totals()})
        if self.st["spent"] >= self.budget:
            return self.finish(False, "budget")

        findings: list[dict] = []
        if plan["investigate"]:
            self.running("investigate", [x["member"] for x in plan["investigate"]])
            jobs = [{"member": x["member"], "tag": f"r{n}-inv{i}", "theory": x["theory"],
                     "prompt": lambda ws, t=x["theory"]: self.pack("\n".join(self.head(ws) + [
                         "", INVESTIGATE_RULES, NETWORK_ON if self.network else NETWORK_OFF, "", f"Theory to test: {t}"]), ledger, failure)}
                    for i, x in enumerate(plan["investigate"])]
            for j in self.parallel(jobs):
                f = last_json(str(j["res"].get("output") or ""), "verdict") or {}
                findings.append({"theory": j["theory"], "member": team.public(j["member"]), "ok": bool(j["res"].get("ok")),
                                 "verdict": f.get("verdict") if f.get("verdict") in ("confirmed", "refuted") else "unclear",
                                 "evidence": text(f.get("evidence") or j["res"].get("error")), "fix": text(f.get("fix")),
                                 "cost_usd": j["res"]["cost"], "estimated": bool(j["res"].get("estimated"))})
            emit({"type": "findings", "n": n, "items": findings, **self.totals()})
            if self.st["spent"] >= self.budget:
                return self.finish(False, "budget")
            ledger = {**ledger, "findings": [{k: f[k] for k in ("theory", "verdict", "evidence", "fix")} for f in findings if f["ok"]]}
        refuted = [f"{f['theory']} (refuted by {f['member']['label']})" for f in findings if f["verdict"] == "refuted"]

        # A vendor whose investigator failed sits out, so whoever was staffed from it cannot implement either.
        impl = [m for m in plan["implement"] if m["agent"] not in self.st["blocked"]]
        if not impl:
            if not (pool := self.pool()):
                return self.all_out()
            impl = [team.pick(pool, 1, self.agent)]
        if len(impl) == 1:
            m = impl[0]
            self.running("work", [m])
            prompt = self.work_prompt(self.workspace, ledger, failure)
            res = self.ask_member(m, prompt, tag="work")
            note = turn_note(str(res.get("output") or ""))
            extra: dict = {"role": "work", "own_usd": res["cost"]}  # cost_usd is the whole round
        else:
            m, res, note, extra, prompt = self.attempts(impl, results, ledger, failure)
        if not res.get("ok"):
            return self.failed_call(m["agent"], res, m)  # the next round is staffed without that vendor
        note["ruled_out"] = list(dict.fromkeys(note["ruled_out"] + refuted))[:8]
        return self.record(results, digest, res, note, prompt, round(self.st["spent"] - spent0, 6), self.st["tokens"] - tokens0,
                           agent=m["agent"], member=team.public(m), effort=m["effort"], **extra)

    def attempts(self, impl: list[dict], results: list[dict], ledger: dict, failure: str):
        """Competing fixes, each in its own copy; the checks pick the winner, which is applied only if it beats the current state."""
        self.running("attempts", impl)
        base = [r for r in results if r["id"] != "review"]
        prompts: dict[str, str] = {}

        def prompt(ws: Path, tag: str) -> str:
            prompts[tag] = self.work_prompt(ws, ledger, failure, ATTEMPT_RULES)
            return prompts[tag]

        jobs = [{"member": m, "tag": f"r{len(self.st['turns']) + 1}-try{i}", "prompt": None} for i, m in enumerate(impl)]
        for j in jobs:
            j["prompt"] = lambda ws, tag=j["tag"]: prompt(ws, tag)
            j["after"] = lambda job, ws: job.update(rows=self.check_all(ws, job["tag"])[0])
        outcome: dict = {"merged": False, "changed": []}

        def apply(done: list[dict]) -> None:
            scored = [j for j in done if j["res"].get("ok") and "rows" in j]
            best = max(scored, key=lambda j: (sum(r["ok"] for r in j["rows"]), -j["res"]["cost"]), default=None)
            if best:
                passed = sum(r["ok"] for r in best["rows"])
                if passed > sum(r["ok"] for r in base) or (passed == sum(r["ok"] for r in base) and failure_hash(best["rows"]) != failure_hash(base)):
                    outcome.update(merged=True, changed=team.merge_back(best["fork"], self.workspace))
            outcome["best"] = best

        done = self.parallel(jobs, apply)
        best = outcome["best"] or done[0]
        notes = {j["tag"]: turn_note(str(j["res"].get("output") or "")) for j in done}
        note = dict(notes[best["tag"]])
        if not outcome["merged"]:
            note["ruled_out"] = note["ruled_out"] + [f"{j['member']['label']}: {notes[j['tag']]['fix']}" for j in done if notes[j["tag"]]["fix"]]
            note["fix"] = "No attempt beat the current state, so nothing was applied."
        items = [{"member": team.public(j["member"]), "ok": bool(j["res"].get("ok")), "winner": j is outcome["best"] and outcome["merged"],
                  "passed": sum(r["ok"] for r in j.get("rows", [])), "total": len(j.get("rows", [])) or len(base),
                  "fix": notes[j["tag"]]["fix"] or text(j["res"].get("error")), "cost_usd": j["res"]["cost"],
                  "estimated": bool(j["res"].get("estimated"))} for j in done]
        emit({"type": "attempts", "n": len(self.st["turns"]) + 1, "items": items, "merged": outcome["merged"],
              "changed": outcome["changed"][:30], **self.totals()})
        res = {**best["res"], "ok": any(j["res"].get("ok") for j in done)}
        return best["member"], res, note, {"role": "attempts"}, prompts.get(best["tag"], "")


def run_loop(goal_path: Path, workspace: Path, state: Path | None = None) -> int:
    signal.signal(signal.SIGTERM, stop_on_term)
    try:
        goal = json.loads(run_ixpack("decode", goal_path.read_text()))
        loop = Loop(goal, workspace, state or workspace / ".iteraxa")
    except (OSError, RuntimeError, KeyError, TypeError, ValueError) as exc:
        emit({"type": "finished", "ok": False, "reason": "loop_failed", "error": f"goal: {exc}"})
        return 1
    return loop.run()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="iteraxa")
    sub = parser.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run")
    run.add_argument("--goal", required=True)
    run.add_argument("--workspace", required=True)
    run.add_argument("--state", help="run folder for the ledger and agent files (default: WORKSPACE/.iteraxa)")
    args = parser.parse_args(argv)
    return run_loop(Path(args.goal), Path(args.workspace), Path(args.state) if args.state else None)


if __name__ == "__main__":
    sys.exit(main())
