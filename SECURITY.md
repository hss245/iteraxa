# Security

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use GitHub's private reporting instead: on the repository's **Security** tab, choose **Report a vulnerability**. Include what you ran, what happened, and the Iteraxa version (Settings → About). You should hear back within a week.

## The trust model

Iteraxa's whole job is to let coding agents run commands in a folder you choose, so it's worth being precise about what is trusted.

**Trusted:** you, the agent CLIs you installed, and the machine they run on.

**Not trusted:** anything a model writes. That covers agent replies, proposed checks, a lead's staffing plan and estimates, reviewer verdicts, reports, and `verdict.json`. It also covers the contents of the workspace, because a repository can carry text written to steer a model.

Here is how that shows up in the code:

- Every structured answer from a model is parsed defensively (`last_json`) and cut down to known fields with bounded sizes (`clean_checks`, `clean_report`, `team.staff`). `verdict.json`, which a hypothesis's analysis writes, must be under 64 KB and have every required field. Report HTML escapes every value.
- A lead's plan can't hire premium models for easy work, can't go past 8 agents at once, and can't raise the run's budget or turn limit. Sizing only ever lowers them.
- Read-only roles (lead, judge, reviewer, proposing checks) run with each CLI's read-only mode: Claude without Edit, Write or Bash; Codex with `--sandbox read-only`; Cursor in ask mode.
- With network access off, Codex and Cursor work in their own sandboxes. Claude's Bash runs in Claude Code's sandbox with no allowed hosts and `failIfUnavailable`, so if the sandbox can't start the call fails instead of running unsandboxed. This needs Claude Code 2.1.219 or later, plus `bubblewrap` and `socat` on Linux. Domains you allowed in your own `~/.claude/settings.json` still apply.
- The daemon listens on a unix socket created under a 0077 umask and set to mode 0600. It never opens a TCP port, and it validates every request (`Goal.Validate`).

## What is not sandboxed

**Check commands run as you, in your folder, with no sandbox.** That includes:

- checks you typed;
- checks an agent proposed and you approved;
- the `reproduce` command a hypothesis writes into `verdict.json`;
- in **autonomous mode**, the checks the scoping agent infers, which run without asking you first.

A model that can be steered by the workspace's contents can therefore get a command run outside any agent sandbox. If you point Iteraxa at code or documents you don't trust, turn autonomous mode off and read the proposed checks before approving them.

Some other limits worth knowing:

- With network access on, Claude's Bash and Cursor run without a sandbox. Agents are told not to change remote data unless the goal asks for it, but that's an instruction to a model, not an enforcement.
- Claude's write mode allows Bash. With network off it's sandboxed as described above; it is not otherwise restricted.
- Iteraxa keeps each run's goal, ledger, agent replies, events and logs in the data folder (`runs/<id>/`); the prompts themselves aren't saved. If a goal involves secrets, they may end up there. Deleting a run removes its folder.
