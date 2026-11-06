# Contributing

Thanks for taking a look. Bug reports, fixes and small focused improvements are all welcome. For anything larger, open an issue first so we can agree on the shape before you spend time on it.

## Getting set up

You need Go 1.22+, a stable Rust toolchain, Python 3.10+ and Node (only to syntax-check the UI). On macOS `./install.sh` sets most of this up; on Ubuntu it also installs Tauri's build packages.

```sh
./install.sh check                     # every test: cargo test, go vet, go test, the Python selfcheck
python3 -m http.server -d app/ui 8765  # the window on mock data, no backend needed
```

To try a change in the real app, `./install.sh` rebuilds and reinstalls it. The app replaces an idle background service whose version differs from its own. If you're iterating on the daemon without bumping the version, quit the app and run `pkill -f "ixd serve"` before relaunching.

## How the pieces talk to each other

```
window (JS) ⇄ Rust shell ⇄ ixd daemon (Go) → goal loop (Python) → ixd run-agent → agent CLI
                                            ↘ ixpack (Rust)      ↘ check commands
```

- The **loop** writes one JSON event per line on stdout and exits with 0 (finished), 1 (the goal couldn't be read), 2 (stopped short) or 3 (waiting for the user). Waiting for the user is a process exit, and resuming means a new loop process reading `state.json`. A usage-limit pause is the exception: it sleeps inside the running loop.
- The **daemon** stamps each event with a time, appends it to `events.jsonl`, folds it into `meta.json` (`fold` in `manager.go`) and broadcasts it to the window.
- The **window** draws the timeline from those events (`eventItem` in `views/run.js`).

These layers share event names, the team roster and the version number by convention. `internal/daemon/contract_test.go` reads the Python and JS sources to keep them in step. If you add an event type:

1. Emit it in `loop.py`.
2. If it only updates the run's live state, fold it in `fold` (`manager.go`) and add it to `liveEvents` in `contract_test.go`. If it belongs in the timeline, add it to `timelineEvents` in `store.go` (and fold it too if it also changes live state).
3. Give every timeline event a `case` in `views/run.js`.

The contract test fails while an emitted event is in neither list, or a timeline event has no `case` in `run.js`. It doesn't read `fold`, so check that part by hand.

The version lives in `app/Cargo.toml`, `app/tauri.conf.json` and `internal/daemon/store.go`; `TestVersionsMatch` checks they agree.

## Tests

| Suite | What it covers |
| --- | --- |
| `python -m iteraxa.selfcheck` | The loop end to end with fake agents: stuck detection, hand-offs, questions and resumes, proposing and scoping, hypotheses, teams, competing attempts in git worktrees, usage-limit pauses, reports |
| `go test ./internal/daemon` | The daemon with a fake loop: the private socket, approving checks, raising limits, one run per folder, stopping a run's whole process group, crash recovery, the single-daemon lock, usage-limit pauses, cleaning up team copies, and the cross-language contracts |
| `go test ./internal/agent` | CLI flags per vendor, the Claude sandbox settings, cost and token parsing, timeouts killing the whole process group |
| `cargo test -p ixpack` | TOON round trips and per-check failure trimming |

Prefer a fake agent over a mock: the selfcheck's `FAKE_IX` script stands in for `ixd run-agent`, so each case asserts the exact sequence of agent calls.

## Style

- Match what's around you. Comments explain *why*, briefly; most functions have none.
- A comment starting with `ponytail:` marks a known limitation, usually with its upgrade path. If you fix one, remove the comment.
- Keep the Python loop stdlib-only.
- Treat everything a model returns as untrusted input: parse it defensively and bound its size.

## Screenshots

The images in `docs/` come from the mock UI at 1280×800, 2× scale. For example, with Chrome:

```sh
python3 -m http.server -d app/ui 8765 &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
  --window-size=1280,800 --force-device-scale-factor=2 --virtual-time-budget=4000 \
  --screenshot=docs/team-dark.png "http://localhost:8765/?theme=dark&view=r11"
```
