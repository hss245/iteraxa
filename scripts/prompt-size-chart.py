"""Measure how big a work prompt gets over a long run, and draw the README chart from it.

Both lines come from the real loop code and ixpack on the same synthetic run: one failing check that prints
60 lines, and a turn note per turn. The flat line is the prompt Iteraxa sends; the other is the same prompt
with the ledger's 8-turn window removed, so every note stays in.

    cargo build -p ixpack
    IXPACK_BIN=target/debug/ixpack PYTHONPATH=python python3 scripts/prompt-size-chart.py

Writes docs/prompt-size-light.svg and docs/prompt-size-dark.svg and prints the README table.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from iteraxa.loop import Loop, failure_text, run_ixpack

TURNS = 20
CAUSES = ["Pillow 11 opens palette PNGs in mode PA", "resize() rejects mode PA images",
          "the expected thumbnails used the old resampling", "save() writes RGB and drops the alpha channel",
          "EXIF rotation is applied twice", "the cache key ignores the target size", "a temp file is left open on Windows",
          "the CLI exits 0 even when a file fails"]


def measure() -> list[dict]:
    ws = Path(tempfile.mkdtemp())
    loop = Loop({"intent": "The thumbnail tests fail since the Pillow upgrade. Make transparent PNGs resize correctly again.",
                 "agent": "claude", "budget_usd": 5, "max_turns": 30, "checks": [{"id": "thumbs", "cmd": "true"}]}, ws, ws)
    results = [{"id": "thumbs", "code": 1, "ok": False, "output": "\n".join(
        f"[thumbs] {i:02d} ValueError: image has wrong mode at resize (thumbnailer/resize.py:{40 + i})" for i in range(60))}]
    failure, rows = failure_text(results), []
    for n in range(1, TURNS + 1):
        ledger, turns = loop.ledger(), loop.st["turns"]
        unwindowed = {**ledger, "turns": [{k: t[k] for k in ("n", "agent", "check", "cause", "fix")} for t in turns]} if turns else ledger
        ledger_json = json.dumps(ledger, separators=(",", ":"))
        rows.append({"turn": n, "prompt": len(loop.work_prompt(ws, ledger, failure).encode()),
                     "unwindowed": len(loop.work_prompt(ws, unwindowed, failure).encode()),
                     "ledger_json": len(ledger_json), "ledger_toon": len(run_ixpack("encode", ledger_json)) if ledger else 0})
        cause = CAUSES[(n - 1) % len(CAUSES)]
        turns.append({"n": n, "agent": "Claude Sonnet", "check": "thumbs", "hash": "x", "cost_usd": 0.1, "tokens": 0,
                      "cause": cause, "probe": "ran the failing request", "fix": f"tried a fix for: {cause}",
                      "ruled_out": [f"not {CAUSES[(n + 2) % len(CAUSES)]}"], "ask": ""})
    return rows


# Categorical slots 1 and 2 of the validated chart palette, per theme.
THEMES = {
    "light": dict(bg="#fcfcfb", text="#0b0b0b", sub="#52514e", grid="#e6e5e0", axis="#c9c8c2", a="#2a78d6", b="#eb6834"),
    "dark": dict(bg="#1a1a19", text="#f0efec", sub="#c3c2b7", grid="#2e2e2c", axis="#4a4a46", a="#3987e5", b="#d95926"),
}
FONT = 'font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"'


def svg(rows: list[dict], c: dict) -> str:
    w, h, left, right, top, bottom = 760, 340, 64, 160, 70, 48
    pw, ph = w - left - right, h - top - bottom
    ymax = 1000 * (max(r["unwindowed"] for r in rows) // 1000 + 2)  # headroom above the top line
    x = lambda n: left + (n - 1) / (TURNS - 1) * pw
    y = lambda v: top + ph - v / ymax * ph
    text = lambda px, py, s, size=12, fill=c["sub"], extra="": f'<text x="{px:.1f}" y="{py:.1f}" font-size="{size}" fill="{fill}" {FONT}{extra}>{s}</text>'
    g = [f'<rect width="{w}" height="{h}" rx="12" fill="{c["bg"]}"/>', text(left - 40, 26, "Prompt size per turn", 15, c["text"], ' font-weight="600"')]
    for kb in range(0, ymax // 1000 + 1, 2):
        g.append(f'<line x1="{left}" x2="{left + pw}" y1="{y(kb * 1000):.1f}" y2="{y(kb * 1000):.1f}" stroke="{c["grid"] if kb else c["axis"]}"/>')
        g.append(text(left - 10, y(kb * 1000) + 4, f"{kb} KB", extra=' text-anchor="end"'))
    for n in (1, 5, 10, 15, 20):
        g.append(text(x(n), top + ph + 20, n, extra=' text-anchor="middle"'))
    g.append(text(left + pw / 2, h - 8, "Turn", extra=' text-anchor="middle"'))
    drop = 10  # the first prompt with more than 8 earlier turns, so the window starts dropping notes
    g.append(f'<line x1="{x(drop):.1f}" x2="{x(drop):.1f}" y1="{top}" y2="{top + ph}" stroke="{c["axis"]}" stroke-dasharray="3 4"/>')
    g.append(text(x(drop) + 8, top + ph - 12, "from here the ledger keeps only the last 8 turns"))
    # The lines match until the window starts dropping notes, so the Iteraxa line is drawn last, on top.
    series = [("unwindowed", c["b"], "Without the window"), ("prompt", c["a"], "Iteraxa prompt")]
    lx, last = left - 40, rows[-1]
    for key, col, label in series:
        pts = " L".join(f"{x(r['turn']):.1f},{y(r[key]):.1f}" for r in rows)
        g.append(f'<path d="M{pts}" fill="none" stroke="{col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>')
        ex, ey = x(TURNS), y(last[key])
        g.append(f'<circle cx="{ex:.1f}" cy="{ey:.1f}" r="4.5" fill="{col}" stroke="{c["bg"]}" stroke-width="2"/>')
        g.append(text(ex + 12, ey - 2, label, fill=c["text"], extra=' font-weight="600"'))
        g.append(text(ex + 12, ey + 13, f"{last[key] / 1000:.1f} KB at turn {TURNS}"))
        g.append(f'<line x1="{lx}" x2="{lx + 18}" y1="47" y2="47" stroke="{col}" stroke-width="2" stroke-linecap="round"/>')
        g.append(text(lx + 24, 51, label))
        lx += 170
    label = (f"Prompt size per turn: Iteraxa's prompt levels off at {last['prompt'] / 1000:.1f} KB once the ledger holds 8 turns; "
             f"without that window it reaches {last['unwindowed'] / 1000:.1f} KB by turn {TURNS}.")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" '
            f'aria-label="{label}">' + "".join(g) + "</svg>\n")


def main() -> None:
    rows = measure()
    docs = Path(__file__).resolve().parent.parent / "docs"
    for name, colors in THEMES.items():
        (docs / f"prompt-size-{name}.svg").write_text(svg(rows, colors))
    print("| Turn | Iteraxa prompt | Without the window | Ledger as JSON | Ledger as TOON |\n| --- | --- | --- | --- | --- |")
    for r in rows:
        if r["turn"] in (1, 4, 8, 12, 16, 20):
            print(f"| {r['turn']} | {r['prompt']:,} B | {r['unwindowed']:,} B | {r['ledger_json']:,} B | {r['ledger_toon']:,} B |")


if __name__ == "__main__":
    main()
