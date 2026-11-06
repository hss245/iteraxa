import { icon } from '../icons.js';
import { state, freshDraft } from '../store.js';
import { ui, menu, toast, mod } from '../ui.js';
import { api } from '../api.js';
import { esc, money, agentName, shortPath, AGENTS, TEAM, TIERS } from '../util.js';

const RESEARCH = [
  { id: 'findings', cmd: 'test -s findings.md' },
  { id: 'length', cmd: 'test $(wc -w < findings.md) -ge 400' },
  { id: 'sources', cmd: 'test $(grep -c "https\\?://" findings.md) -ge 5' },
];

const CODE = [
  { id: 'metric', cmd: `python3 -c "import json,sys; sys.exit(json.load(open('metrics.json'))['score'] < 0.9)"` },
  { id: 'file', cmd: 'test -s RESULTS.md' },
];

const EXAMPLES = [
  {
    label: 'Make the test suite pass',
    icon: 'code',
    draft: { kind: 'code', intent: 'Make the test suite pass without changing the public API', checks: [{ id: 'tests', cmd: 'npm test' }] },
  },
  {
    label: 'Hit a performance target',
    icon: 'zap',
    draft: { kind: 'code', intent: 'Make the benchmark finish in under 200 ms', checks: [{ id: 'perf', cmd: 'python3 bench.py --max-ms 200' }] },
  },
  {
    label: 'Research brief with sources',
    icon: 'file-text',
    draft: {
      kind: 'research',
      intent: 'Survey how open-source projects evaluate retrieval-augmented generation and write findings.md with at least five cited sources',
      checks: RESEARCH.map((c) => ({ ...c })),
    },
  },
  {
    label: 'Fix a broken API call',
    icon: 'globe',
    draft: {
      kind: 'code',
      intent: 'The weather CLI fails with 401 from the forecast API. Find out why (key, header or endpoint) and fix it so it prints a forecast',
      checks: [{ id: 'forecast', cmd: 'python -m weather --city Lisbon | grep -q "°C"' }],
      allow_network: true,
    },
  },
  {
    label: 'Test a hypothesis on data',
    icon: 'flask',
    draft: {
      kind: 'hypothesis',
      intent: 'Use data/rides.csv to compare daily bike rentals on rainy and dry days',
      hypothesis: 'Days with rain have fewer bike rentals than dry days',
      checks: [{ id: '', cmd: '' }],
    },
  },
];

const KINDS = [
  ['code', 'code', 'Code'],
  ['research', 'file-text', 'Research'],
  ['hypothesis', 'flask', 'Hypothesis'],
];

const PLACEHOLDER = {
  code: 'e.g. Make the auth tests pass without changing the public API',
  research: 'e.g. Compare the three fastest JSON parsers and write findings.md with numbers',
  hypothesis: 'e.g. Use data/rides.csv to compare daily bike rentals on rainy and dry days',
};

const filled = (d) => d.checks.filter((c) => c.cmd.trim());
const ready = (d) => d.intent.trim() && d.workspace && (d.kind !== 'hypothesis' || d.hypothesis.trim());
// Agents are "found" until the status check says otherwise, so the preview is not empty while it loads.
const found = (a) => state.agents[a]?.found !== false;
const roster = () => TEAM.filter((m) => found(m.agent));

function rosterHTML() {
  const team = roster();
  if (!team.length) return `<div class="roster-empty">${icon('alert', 13)}Install Claude Code, Codex or Cursor first.</div>`;
  const rows = TIERS.map((t) => [t, team.filter((m) => m.tier === t)])
    .filter(([, ms]) => ms.length)
    .map(([t, ms]) => `<div class="tier"><span class="tier-name">${t}</span><span class="tier-members">${ms.map((m) => `<span><i class="agent-dot ${m.agent}"></i>${esc(m.label)}</span>`).join('')}</span></div>`)
    .join('');
  return `<div class="roster">${rows}</div>
    <span class="faint roster-note">A cheap lead staffs each round: investigators, an implementer, a reviewer from another vendor. Premium only when hard or stuck.</span>`;
}

function summary(d) {
  if (!d.workspace) return 'Choose the folder the agent may change.';
  if (!d.intent.trim()) return 'Describe what should be true when it is done.';
  if (d.kind === 'hypothesis' && !d.hypothesis.trim()) return 'State the hypothesis to test.';
  const n = filled(d).length;
  const proof =
    d.kind === 'hypothesis'
      ? `verdict, re-run and review${n ? ` + ${n} check${n === 1 ? '' : 's'}` : ''}`
      : n
        ? `${n} check${n === 1 ? '' : 's'}`
        : d.autonomous
          ? 'scopes the goal and stops when it is done'
          : 'proposes checks for you to approve';
  const who = d.team ? `Team of ${roster().length} models` : agentName(d.agent);
  if (d.team && d.auto) return `${who} · the lead sizes the budget and rounds · ${proof}`;
  return `${who} · up to ${d.turns} ${d.team ? 'rounds' : 'turns'} · stops at ${money(d.budget)} · ${proof}`;
}

function doneWhen(d, sugg) {
  const rows = d.checks
    .map(
      (c, i) => `<div class="check-edit">
        <span class="num-badge">${i + 1}</span>
        <input class="field" placeholder="name" value="${esc(c.id)}" data-bind="check-id" data-i="${i}" spellcheck="false" aria-label="Check ${i + 1} name">
        <input class="field mono" placeholder="${d.kind === 'research' ? 'test -s findings.md' : 'npm test'}" value="${esc(c.cmd)}" data-bind="check-cmd" data-i="${i}" spellcheck="false" aria-label="Check ${i + 1} command">
        <button class="btn ghost sm icon" data-act="rm-check" data-i="${i}" aria-label="Remove check ${i + 1}">${icon('x', 14)}</button>
      </div>`,
    )
    .join('');
  const builtIn =
    d.kind === 'hypothesis'
      ? `<div class="built-in">
          <div>${icon('file-text', 14)}<span><b>Verdict</b> verdict.json says supported or rejected, with the method, threshold and numbers</span></div>
          <div>${icon('repeat', 14)}<span><b>Reproduces</b> Iteraxa re-runs the analysis and the numbers must match</span></div>
          <div>${icon('eye', 14)}<span><b>Reviewed</b> a different agent checks the reasoning, read-only</span></div>
        </div>`
      : '';
  const autonomous = d.autonomous && d.kind !== 'hypothesis';
  const optional =
    d.kind === 'hypothesis'
      ? 'Extra checks are optional'
      : autonomous
        ? 'Leave empty and the agent scopes the goal itself, works, and stops when it is good enough — it asks you only if the goal is unclear'
        : 'Leave empty and the agent proposes checks first; you approve them';
  const autoToggle =
    d.kind === 'hypothesis'
      ? ''
      : `<div class="toggle-row">
          <span class="txt"><b>Work autonomously</b><span>With no checks, the agent figures out the goal and what “done” looks like, works on it, and stops when more effort is not worth the cost. Any check commands it writes run in this folder without asking you first</span></span>
          <button class="switch" role="switch" aria-label="Work autonomously" aria-checked="${autonomous}" data-act="autonomous"></button>
        </div>`;
  return `<div class="card">
    <div class="card-head">${icon('list-checks', 16)}<h3>Done when</h3><span class="hint">${d.kind === 'hypothesis' ? 'a verdict survives a re-run and a review' : autonomous ? 'the agent decides, or your checks' : 'every command exits 0'}</span>
      <div class="right"><button class="btn ghost sm" data-act="add-check">${icon('plus', 14)}Add check</button></div>
    </div>
    ${autoToggle}
    ${builtIn}
    <div class="check-rows">${rows}</div>
    ${
      sugg.length
        ? `<div class="chips">${sugg.map((s) => `<button class="chip" data-act="use-sugg" data-id="${esc(s.id)}" data-cmd="${esc(s.cmd)}">${icon('plus', 13, 2.4)}${esc(s.id)}<span class="sub">${esc(s.cmd)}</span></button>`).join('')}</div>`
        : ''
    }
    <div class="optional-note">${icon('info', 13)}${optional}</div>
  </div>`;
}

export function composeHTML() {
  const d = state.draft;
  const taken = new Set(d.checks.map((c) => c.cmd.trim()));
  const presets = d.kind === 'research' ? RESEARCH : d.kind === 'code' ? CODE : [];
  const sugg = [...d.suggestions, ...presets].filter((s) => !taken.has(s.cmd));
  const auto = d.team && d.auto;
  const missing = (a) => state.agents[a] && !state.agents[a].found;
  return `
    <header class="topbar" data-tauri-drag-region>
      <span class="tb-title">New goal</span>
      <span class="spacer" data-tauri-drag-region></span>
      <button class="btn ghost sm" data-act="examples">${icon('sparkles', 14)}Examples</button>
    </header>
    <div class="content"><div class="content-inner enter">
      <div class="hero">
        <h1>What should be true when it's done?</h1>
        <p>Describe the goal and choose a folder. An agent works the way you would: reproduce, find the cause, test it, fix, check again, until the goal is proven or the budget runs out.</p>
      </div>
      <div class="stack">
        <div class="card intent-card">
          <textarea class="intent" id="intent" data-bind="intent" rows="3" aria-label="Goal" placeholder="${PLACEHOLDER[d.kind]}">${esc(d.intent)}</textarea>
          ${
            d.kind === 'hypothesis'
              ? `<div class="hyp-field">${icon('flask', 15)}<input id="hypothesis" data-bind="hypothesis" value="${esc(d.hypothesis)}" placeholder="Hypothesis, e.g. Rainy days have fewer bike rentals" aria-label="Hypothesis" spellcheck="true"></div>`
              : ''
          }
          <div class="intent-foot">
            <button class="ws-pick ${d.workspace ? '' : 'empty'}" data-act="pick" title="${esc(d.workspace)}">${icon(d.workspace ? 'folder' : 'folder-open', 15)}<span>${d.workspace ? esc(shortPath(d.workspace)) : 'Choose a folder…'}</span></button>
            <div class="seg kind" role="group" aria-label="Goal type">${KINDS.map(([k, ic, l]) => `<button data-act="kind" data-v="${k}" aria-pressed="${d.kind === k}">${icon(ic, 14)}${l}</button>`).join('')}</div>
          </div>
        </div>

        <div class="grid-3">
          <div class="card opt-card">
            <span class="label">Who works on it</span>
            <div class="seg full" role="group" aria-label="Agent"><button data-act="team" aria-pressed="${d.team}" title="A team of every installed model">${icon('users', 13)}Team</button>${AGENTS.map(
              (a) => `<button data-act="agent" data-v="${a}" aria-pressed="${!d.team && d.agent === a}" title="${missing(a) ? `${agentName(a)} is not installed` : agentName(a)}" class="${missing(a) ? 'missing' : ''}"><span class="agent-dot ${a}"></span>${agentName(a)}</button>`,
            ).join('')}</div>
            ${
              d.team
                ? rosterHTML()
                : `<div class="toggle-row">
              <span class="txt"><b>Switch when stuck</b><span>Hand off to another installed agent and think harder when a failure repeats</span></span>
              <button class="switch" role="switch" aria-label="Switch when stuck" aria-checked="${d.switch_agent}" data-act="switch-agent"></button>
            </div>`
            }
            <div class="toggle-row">
              <span class="txt"><b>Network and services</b><span>Let it reach databases, APIs and the internet</span></span>
              <button class="switch" role="switch" aria-label="Allow network and services" aria-checked="${d.allow_network}" data-act="allow-network"></button>
            </div>
          </div>
          <div class="card opt-card">
            <div class="money-row"><span class="label">Budget</span>${
              auto
                ? '<span class="big-num">Auto</span>'
                : `<label class="money-input"><span>$</span><input data-bind="budget" value="${d.budget}" inputmode="decimal" aria-label="Budget in dollars"></label>`
            }</div>
            ${
              d.team
                ? `<div class="toggle-row">
              <span class="txt"><b>Size to the problem</b><span>${auto ? `The lead sizes the budget and rounds to the problem after a first look, up to ${money(d.budget)} and ${d.turns} rounds` : 'Off: the run uses the budget and turns you set'}</span></span>
              <button class="switch" role="switch" aria-label="Size the budget and rounds to the problem" aria-checked="${auto}" data-act="auto"></button>
            </div>`
                : ''
            }
            <span class="faint" style="font-size:12px">${auto ? 'If the lead thinks it needs more, the run stops at your limit and offers its estimate.' : 'Checked before every turn. Claude turns are also capped to what is left.'}</span>
          </div>
          <div class="card opt-card">
            <span class="label">Max ${d.team ? 'rounds' : 'turns'}</span>
            ${
              auto
                ? '<span class="big-num">Auto</span>'
                : `<div class="stepper">
              <button data-act="turns" data-v="-1" aria-label="Fewer turns">${icon('minus', 14)}</button>
              <input id="turns" data-bind="turns" value="${d.turns}" inputmode="numeric" aria-label="Max turns">
              <button data-act="turns" data-v="1" aria-label="More turns">${icon('plus', 14)}</button>
            </div>`
            }
            <span class="faint" style="font-size:12px">${auto ? 'Sized by the lead with the budget.' : d.team ? 'One round per turn: the lead, then the roles it staffs.' : 'One fresh agent call per turn.'}</span>
          </div>
        </div>

        ${doneWhen(d, sugg)}
      </div>
      <div class="compose-foot">
        <span class="summary">${icon('info', 15)}<span id="compose-summary">${esc(summary(d))}</span></span>
        <button class="btn primary lg" id="start-btn" data-act="start" ${ready(d) ? '' : 'disabled'}>${icon('play', 13)}Start<kbd>${mod()}↵</kbd></button>
      </div>
    </div></div>`;
}

// Typing must not re-render (focus and caret would be lost), so only patch the bits that depend on it.
function refresh() {
  const d = state.draft;
  const s = document.getElementById('compose-summary');
  if (s) s.textContent = summary(d);
  const b = document.getElementById('start-btn');
  if (b) b.disabled = !ready(d);
}

async function suggest(path) {
  try {
    state.draft.suggestions = (await api.guessChecks(path)) || [];
  } catch {
    state.draft.suggestions = [];
  }
  const d = state.draft;
  if (d.checks.length === 1 && !d.checks[0].cmd && d.suggestions[0]) d.checks = [{ ...d.suggestions[0] }];
  if (state.selected === 'new') ui.renderMain();
}

function slug(cmd, i) {
  const w = cmd.trim().split(/\s+/);
  const word = w[0] === 'test' || w[0] === 'python3' || w[0] === 'npm' ? w[1] || w[0] : w[0];
  return (word || `check${i + 1}`).replace(/[^\w.-]/g, '').slice(0, 24) || `check${i + 1}`;
}

export async function start() {
  const d = state.draft;
  if (!ready(d)) return;
  const goal = {
    intent: d.intent.trim(),
    workspace: d.workspace,
    kind: d.kind,
    hypothesis: d.kind === 'hypothesis' ? d.hypothesis.trim() : '',
    // A team still names one agent: the vendor its lead and defaults prefer.
    agent: d.team ? (found(d.agent) ? d.agent : AGENTS.find(found) || d.agent) : d.agent,
    team: d.team,
    auto_limits: d.team && d.auto,
    budget_usd: d.budget,
    max_turns: d.turns,
    switch_agent: d.switch_agent,
    allow_network: d.allow_network,
    // Autonomous only when no checks are given; providing checks means manual (they decide "done").
    autonomous: d.autonomous && d.kind !== 'hypothesis' && filled(d).length === 0,
    checks: filled(d).map((c, i) => ({ id: c.id.trim() || slug(c.cmd, i), cmd: c.cmd.trim() })),
  };
  try {
    const run = await api.startRun(goal);
    state.runs.set(run.id, run);
    state.draft = freshDraft();
    ui.select(run.id);
  } catch (e) {
    toast(String(e), 'bad');
  }
}

export const actions = {
  start,
  async pick() {
    const path = await api.pickFolder();
    if (!path) return;
    state.draft.workspace = path;
    ui.renderMain();
    suggest(path);
  },
  kind(el) {
    state.draft.kind = el.dataset.v;
    ui.renderMain();
  },
  agent(el) {
    Object.assign(state.draft, { agent: el.dataset.v, team: false });
    ui.renderMain();
  },
  team() {
    state.draft.team = true;
    ui.renderMain();
  },
  'switch-agent'(el) {
    state.draft.switch_agent = !state.draft.switch_agent;
    el.setAttribute('aria-checked', state.draft.switch_agent);
  },
  'allow-network'(el) {
    state.draft.allow_network = !state.draft.allow_network;
    el.setAttribute('aria-checked', state.draft.allow_network);
  },
  autonomous() {
    state.draft.autonomous = !state.draft.autonomous;
    ui.renderMain();
  },
  turns(el) {
    const d = state.draft;
    d.turns = Math.max(1, d.turns + +el.dataset.v);
    document.getElementById('turns').value = d.turns;
    refresh();
  },
  auto() {
    state.draft.auto = !state.draft.auto;
    ui.renderMain();
  },
  'add-check'() {
    state.draft.checks.push({ id: '', cmd: '' });
    ui.renderMain();
    document.querySelectorAll('[data-bind="check-cmd"]').forEach((el, i, all) => i === all.length - 1 && el.focus());
  },
  'rm-check'(el) {
    state.draft.checks.splice(+el.dataset.i, 1);
    ui.renderMain();
  },
  'use-sugg'(el) {
    const d = state.draft;
    const c = { id: el.dataset.id, cmd: el.dataset.cmd };
    const blank = d.checks.findIndex((x) => !x.cmd.trim());
    if (blank >= 0) d.checks[blank] = c;
    else d.checks.push(c);
    ui.renderMain();
  },
  examples(el) {
    menu(
      el,
      EXAMPLES.map((ex) => ({
        label: ex.label,
        icon: ex.icon,
        action() {
          Object.assign(state.draft, { hypothesis: '', allow_network: false }, ex.draft, { checks: ex.draft.checks.map((c) => ({ ...c })) });
          ui.renderMain();
        },
      })),
    );
  },
};

export const binds = {
  intent(el) {
    state.draft.intent = el.value;
    refresh();
  },
  hypothesis(el) {
    state.draft.hypothesis = el.value;
    refresh();
  },
  budget(el) {
    const v = parseFloat(el.value);
    if (v > 0 && Number.isFinite(v)) state.draft.budget = Math.round(v * 100) / 100;
    refresh();
  },
  turns(el) {
    const n = parseInt(el.value, 10);
    if (n > 0) state.draft.turns = n;
    refresh();
  },
  'check-id'(el) {
    state.draft.checks[+el.dataset.i].id = el.value;
  },
  'check-cmd'(el) {
    state.draft.checks[+el.dataset.i].cmd = el.value;
    refresh();
  },
};
