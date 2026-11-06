"""The team: which models are on hand, how a lead's staffing plan is kept within limits, and isolated copies
of the workspace so several agents can work at once without touching the user's folder."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

TIERS = ("fast", "strong", "premium")
# Start with Cursor, then Claude, then Codex: the primary agent, the tie-break between equal models, and the
# fallback order when a vendor fails or hits a usage limit. Cursor leads so a Claude weekly limit never stalls a run.
VENDORS = ("cursor", "claude", "codex")
MAX_PARALLEL = 8  # ponytail: hard ceiling on agents at once, whatever the lead asks for

# usd_in / usd_out are per million tokens and only guide the lead; real spend comes from each CLI.
ROSTER = [
    {"id": "claude-haiku", "agent": "claude", "model": "haiku", "effort": "", "tier": "fast", "label": "Claude Haiku", "usd_in": 0.1, "usd_out": 0.5},
    {"id": "claude-sonnet", "agent": "claude", "model": "sonnet", "effort": "", "tier": "strong", "label": "Claude Sonnet", "usd_in": 2, "usd_out": 10},
    {"id": "claude-opus", "agent": "claude", "model": "opus", "effort": "", "tier": "premium", "label": "Claude Opus", "usd_in": 4, "usd_out": 20},
    {"id": "codex-luna", "agent": "codex", "model": "gpt-6-luna", "effort": "low", "tier": "fast", "label": "Codex Luna", "usd_in": 0.1, "usd_out": 0.5},
    {"id": "codex-sol", "agent": "codex", "model": "gpt-6.1-sol", "effort": "medium", "tier": "strong", "label": "Codex Sol", "usd_in": 2, "usd_out": 10},
    {"id": "codex-astra", "agent": "codex", "model": "gpt-6-astra", "effort": "high", "tier": "premium", "label": "Codex Astra", "usd_in": 10, "usd_out": 50},
    {"id": "grok-high", "agent": "cursor", "model": "", "effort": "high", "tier": "strong", "label": "Grok 4.6 high", "usd_in": 2, "usd_out": 6},
    {"id": "grok-xhigh", "agent": "cursor", "model": "", "effort": "xhigh", "tier": "premium", "label": "Grok 4.7 extra-high", "usd_in": 2, "usd_out": 6},
]

# Dependency and build folders are linked into a copy instead of copied; agents must not write into them.
HEAVY = {"node_modules", ".venv", "venv", "target", "dist", "build", ".next", ".nuxt", ".gradle", ".tox",
         "__pycache__", ".pytest_cache", ".mypy_cache", ".cache"}
SKIP = {".git", ".iteraxa"}
SMALL = 1 << 20  # ignored files up to this size (.env, local config) are copied; bigger ones are linked


def rank(m: dict) -> int:
    return TIERS.index(m["tier"])


def public(m: dict) -> dict:
    return {k: m[k] for k in ("id", "label", "agent", "tier")}


def members(installed: set[str]) -> list[dict]:
    return [m for m in ROSTER if m["agent"] in installed]


def roster_rows(pool: list[dict]) -> list[dict]:
    return [{k: m[k] for k in ("id", "tier", "usd_in", "usd_out")} for m in pool]


def pick(pool: list[dict], tier: int, prefer: str = "", avoid: set[str] = frozenset(), skip: set[str] = frozenset()) -> dict | None:
    """The member closest to `tier`, from `prefer`'s vendor when possible and not from `avoid` vendors or `skip` ids;
    on a tie Cursor comes before Claude before Codex (VENDORS order)."""
    left = [m for m in pool if m["id"] not in skip] or pool
    return min(left, key=lambda m: (m["agent"] in avoid, abs(rank(m) - tier), m["agent"] != prefer, rank(m), VENDORS.index(m["agent"])),
               default=None)


def lead(pool: list[dict], prefer: str) -> dict | None:
    return pick(pool, 0, prefer)


def staff(plan: object, pool: list[dict], stuck: int, prefer: str) -> dict:
    """Keep the lead's plan within limits: known members only, investigators never premium, premium only for hard
    problems or when stuck, competing attempts only when stuck (at least two, different vendors first), stronger
    implementers the longer it is stuck, and a reviewer from another vendor. Anything missing gets a sensible default."""
    plan = plan if isinstance(plan, dict) else {}
    ids = {m["id"]: m for m in pool}
    difficulty = plan.get("difficulty") if plan.get("difficulty") in ("easy", "medium", "hard") else "medium"
    top = 2 if difficulty == "hard" or stuck > 0 else 1
    floor = min(stuck, 2)

    def within(m: dict, lo: int, hi: int) -> dict:
        want = min(max(rank(m), lo), hi)
        return min((x for x in pool if x["agent"] == m["agent"]), key=lambda x: (abs(rank(x) - want), rank(x)))

    inv, seen = [], set()
    raw = plan.get("investigate")
    for x in raw if isinstance(raw, list) else []:
        x = x if isinstance(x, dict) else {}
        theory, m = str(x.get("theory") or "").strip()[:300], ids.get(x.get("member"))
        if theory and m and theory not in seen:
            seen.add(theory)
            inv.append({"theory": theory, "member": within(m, 0, 1)})

    want = plan.get("implement")
    want = [want] if isinstance(want, str) else want if isinstance(want, list) else []
    impl: list[dict] = []
    for i in want:
        if i in ids and (m := within(ids[i], floor, top)) not in impl:
            impl.append(m)
    if not impl:
        impl = [pick(pool, max(floor, 0 if difficulty == "easy" else 1), prefer)]
    if stuck == 0:
        impl = impl[:1]
    while stuck and len(impl) < 2 and len(impl) < len(pool):
        used = {m["id"] for m in impl}
        impl.append(pick(pool, max(floor, 1), avoid={m["agent"] for m in impl}, skip=used))
    impl = impl[:MAX_PARALLEL]

    vendors = {m["agent"] for m in impl}
    rev = ids.get(plan.get("review"))
    if rev is None or rev["agent"] in vendors:
        rev = pick(pool, 1, avoid=vendors, skip={m["id"] for m in impl})
    rev = within(rev, 1, top)
    return {"difficulty": difficulty, "why": str(plan.get("why") or "").strip()[:300],
            "investigate": inv[:MAX_PARALLEL], "implement": impl, "review": rev}


# --- isolated copies ---

def _git(cwd: Path | str, *args: str) -> str | None:
    proc = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True)
    return proc.stdout.strip() if proc.returncode == 0 else None


def _paths(top: str, *args: str) -> list[str]:
    proc = subprocess.run(["git", "-C", top, *args], capture_output=True)
    return [p for p in proc.stdout.decode(errors="surrogateescape").split("\0") if p] if proc.returncode == 0 else []


def _copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst, follow_symlinks=False)


def _link(src: Path, dst: Path, info: dict) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(src, dst)
    info["links"].append(str(dst))


def _clone(src: Path, dst: Path) -> None:
    """Copy-on-write where the filesystem supports it (APFS, Btrfs, XFS), a plain copy otherwise."""
    flags = ["-cRp"] if sys.platform == "darwin" else ["-a", "--reflink=auto"]
    if subprocess.run(["cp", *flags, str(src), str(dst)], capture_output=True).returncode == 0:
        return
    if src.is_dir() and not src.is_symlink():
        shutil.rmtree(dst, ignore_errors=True)
        shutil.copytree(src, dst, symlinks=True)
    else:
        _copy(src, dst)


def _git_base(ws: Path) -> tuple[str, str] | None:
    """The repository top and a commit of the current working state (uncommitted edits included)."""
    top = _git(ws, "rev-parse", "--show-toplevel")
    base = top and (_git(top, "stash", "create") or _git(top, "rev-parse", "--verify", "-q", "HEAD"))
    return (top, base) if top and base else None


def fork(ws: Path, dst: Path) -> dict:
    """An isolated copy of `ws` at `dst`: a git worktree at the current working state for repositories, a copy
    otherwise. Big ignored or dependency folders are linked, not copied."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    info: dict = {"root": str(dst), "links": []}
    git = _git_base(ws)
    if git and _git(git[0], "worktree", "add", "--detach", "--quiet", str(dst), git[1]) is not None:
        top = git[0]
        rel = os.path.relpath(Path(ws).resolve(), Path(top).resolve())
        info.update(kind="git", top=top, path=str(dst / rel))
        for f in _paths(top, "ls-files", "-o", "--exclude-standard", "-z", "--", rel):
            _copy(Path(top) / f, dst / f)
        for f in _paths(top, "ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z", "--", rel):
            src, out = Path(top) / f.rstrip("/"), dst / f.rstrip("/")
            if out.name in SKIP or out.exists() or out.is_symlink():
                continue
            if src.is_file() and not src.is_symlink() and src.stat().st_size <= SMALL:
                _copy(src, out)
            else:
                _link(src, out, info)
    else:
        info.update(kind="copy", path=str(dst))
        dst.mkdir()
        for entry in Path(ws).iterdir():
            if entry.name in SKIP:
                continue
            if entry.name in HEAVY and entry.is_dir() and not entry.is_symlink():
                _link(entry.resolve(), dst / entry.name, info)
            else:
                _clone(entry, dst / entry.name)
    info["manifest"] = manifest(Path(info["path"]))
    return info


def manifest(root: Path) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP and not os.path.islink(os.path.join(d, x))]
        for f in files:
            p = os.path.join(d, f)
            if f not in SKIP and not os.path.islink(p):  # in a worktree .git is a file
                st = os.stat(p)
                out[os.path.relpath(p, root)] = [st.st_size, st.st_mtime_ns]
    return out


def merge_back(info: dict, ws: Path) -> list[str]:
    """Apply what changed in the copy to the user's workspace: new and edited files are copied, removed ones deleted."""
    src, before, now = Path(info["path"]), info["manifest"], manifest(Path(info["path"]))
    changed = []
    for rel, sig in now.items():
        if before.get(rel) != sig:
            _copy(src / rel, ws / rel)
            changed.append(rel)
    for rel in before.keys() - now.keys():
        (ws / rel).unlink(missing_ok=True)
        changed.append(rel)
    return sorted(changed)


def drop(info: dict) -> None:
    for link in info.get("links", []):
        Path(link).unlink(missing_ok=True)  # never follow a link back into the user's folders
    if info.get("kind") == "git":
        _git(info["top"], "worktree", "remove", "--force", info["root"])
    shutil.rmtree(info["root"], ignore_errors=True)


def prune(ws: Path) -> None:
    """Forget worktrees left behind by a run that was killed mid-round."""
    if top := _git(ws, "rev-parse", "--show-toplevel"):
        _git(top, "worktree", "prune")


# --- what changed since the run started, for the reviewer ---

def snapshot(ws: Path, state: Path) -> dict:
    if git := _git_base(ws):
        return {"git": git[1]}
    write = state / "base-manifest.json"
    write.write_text(json.dumps(manifest(ws)))
    return {"manifest": str(write)}


def changes(ws: Path, snap: dict, limit: int = 8000) -> str:
    if snap.get("git"):
        top = _git(ws, "rev-parse", "--show-toplevel") or str(ws)
        rel = os.path.relpath(Path(ws).resolve(), Path(top).resolve())
        diff = _git(top, "diff", snap["git"], "--", rel)
        if diff is None:
            return "Could not compute the diff; read the workspace directly."
        new = _paths(top, "ls-files", "-o", "--exclude-standard", "-z", "--", rel)
        out = diff[:limit] + ("\n[diff clipped]" if len(diff) > limit else "")
        return out + ("\nUntracked files: " + ", ".join(new[:50]) if new else "") or "No changes."
    try:
        before = json.loads(Path(snap["manifest"]).read_text())
    except (OSError, ValueError, KeyError):
        return "Could not tell what changed; read the workspace directly."
    now = manifest(ws)
    rows = [f"edited {p}" for p in now if p in before and now[p] != before[p]]
    rows += [f"added {p}" for p in now if p not in before] + [f"removed {p}" for p in before if p not in now]
    return "Changed files:\n" + "\n".join(sorted(rows)[:200]) if rows else "No changes."
