# Changelog

## 0.4.0

### Fixed

- **A second background service no longer kills running goals.** Two starts could race when the app launched. The losing daemon ended every run it found marked as running, including the live runs of the daemon that won. The daemon now takes a lock on the data folder before it touches any run, and the app serializes its own start-up.
- **Stopping a run cleans up after itself.** Check commands (which run in their own session) and team workspace copies in the temp folder used to outlive a stopped run. The loop now kills its checks and removes its copies when stopped. Check commands leave pid files beside the agents' ones, and the daemon kills both and sweeps any leftover copies.
- **The lead can no longer raise a run's limits.** With *Size to the problem* on, the lead's estimate could set any budget, despite the docs saying it was capped. It now sizes within the budget and turns the run started with. A bigger estimate is offered when the run stops at its limit.
- **Failing output from every check reaches the agent.** The prompt kept the last 40 lines of all failing checks combined, so a noisy check could push the others, or a reviewer's objections, out of view. Each failing check now keeps its own header and tail.
- **Run again keeps autonomous mode.** It used to restart an autonomous run as one that waits for you to approve checks.
- **Failed agent calls show up in the timeline.** They were recorded but never drawn.
- **Repeated review rejections count as being stuck,** so a run that a reviewer keeps rejecting asks you for a hint instead of spending until its limit.
- Claude's token counts are now reported (they always read 0).
- The "thinks harder" tag no longer appears on Claude turns: Claude's CLI takes no reasoning-effort setting.
- `./install.sh check` works on a fresh clone; it used to fail until the app had been built once.
- `verdict.json` must be under 64 KB before any of it reaches the run's history or a prompt.

### Changed

- The HTML report a run writes when it reaches its goal no longer carries an author credit. It's your deliverable to share; the credit stays in the app.
- The demo data behind the screenshots, the app's built-in examples and the test fixtures now use everyday open-source tasks.
- A run waiting on a question now says it's waiting for your answer, not your approval.
- A shorter, friendlier README; the architecture, data folder, team staffing rules and command-line details moved to `docs/how-it-works.md`.

### Added

- **Usage-limit pauses.** When every agent is out and at least one only hit its usage limit, the run pauses until the limit resets, then continues by itself. It reads the reset time from the agent's message or retries in 30 minutes. An agent CLI installed during the pause takes over within a minute.
- **Network off now covers Claude's Bash.** With network access off, Claude's Bash runs in Claude Code's own sandbox with no hosts allowed. It fails closed if the sandbox can't start. This needs Claude Code 2.1.219 or later, plus `bubblewrap` and `socat` on Linux, which the Ubuntu installer now installs.
- Contract tests that keep the loop's events, the daemon's timeline and the window's drawing code, plus the team roster, in step across Python, Go and JavaScript, and the version number in step between the app and the daemon.
- `scripts/prompt-size-chart.py`, which measures and redraws the README's prompt-size chart.
- Continuous integration on macOS and Ubuntu, a security policy, contributing notes, and updated screenshots.
