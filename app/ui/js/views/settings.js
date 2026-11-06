import { icon, logo } from '../icons.js';
import { state } from '../store.js';
import { ui, toast, EDITOR_LOOK } from '../ui.js';
import { api } from '../api.js';
import { esc, shortPath, agentName, agentIconName, AGENTS } from '../util.js';

const TABS = [
  ['appearance', 'palette', 'Appearance'],
  ['agents', 'bot', 'Agents'],
  ['editor', 'code', 'Editor'],
  ['runs', 'sliders', 'Runs'],
  ['about', 'info', 'About'],
];

const ACCENTS = { indigo: '#5b5bd6', teal: '#0d8f84', violet: '#7c4ddb', rose: '#d6336c', amber: '#c76a05' };
const INSTALL = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  cursor: 'curl https://cursor.com/install -fsS | bash',
};
const MODEL = {
  claude: ['When Claude works alone. Empty uses the CLI default; a team picks Haiku, Sonnet or Opus per role', 'e.g. sonnet'],
  codex: ['When Codex works alone. Empty uses the CLI default; a team picks Luna, Sol or Astra per role', 'e.g. gpt-6.1-sol'],
  cursor: ['When Cursor works alone. Empty picks Grok 4.6 high; Grok 4.7 extra-high when stuck, testing a hypothesis or reviewing', 'auto'],
};
const installing = new Set();

const toggle = (key, on) => `<button class="switch" role="switch" aria-checked="${on}" data-act="set-toggle" data-k="${key}" aria-label="${key}"></button>`;
const row = (title, sub, control) => `<div class="set-row"><span class="txt"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</span>${control}</div>`;
const stepper = (key, v) =>
  `<div class="stepper"><button data-act="set-step" data-k="${key}" data-v="-1" aria-label="Less">${icon('minus', 14)}</button><input value="${v}" data-bind="set-num" data-k="${key}" inputmode="numeric" aria-label="${key}"><button data-act="set-step" data-k="${key}" data-v="1" aria-label="More">${icon('plus', 14)}</button></div>`;

function agentRows(a) {
  const s = state.agents[a] || {};
  const status = s.found
    ? `<span class="found">${icon('check', 13, 2.6)}Ready</span>`
    : `<button class="btn sm" data-act="copy" data-v="${esc(INSTALL[a])}">${icon('copy', 13)}Copy install command</button>`;
  const sub = s.found ? esc([s.version, shortPath(s.path)].filter(Boolean).join(' · ')) : `Not found. Install with <span class="mono">${esc(INSTALL[a])}</span>`;
  return `<div class="set-group">
    <div class="set-row"><span class="agent-badge ${a}" style="width:32px;height:32px;border-radius:9px">${icon(agentIconName(a), 15, 2.2)}</span><span class="txt"><b>${agentName(a)}</b><span>${sub}</span></span>${status}</div>
    ${row('Model', MODEL[a][0], `<input class="field" data-bind="set-text" data-k="models.${a}" placeholder="${MODEL[a][1]}" value="${esc(state.settings.models[a])}" spellcheck="false">`)}
    ${a === 'cursor' ? row('Cost', 'Cursor does not report cost, so Iteraxa estimates it from tokens at Cursor’s listed prices and shows it with ≈', '') : ''}
    ${a === 'codex' ? row('Cost', 'Codex reports tokens, so Iteraxa estimates dollars at OpenAI’s API prices and shows them with ≈. With a ChatGPT sign-in your plan pays instead', '') : ''}
    ${row('Binary path', 'Only if it is not found automatically', `<input class="field mono" data-bind="set-text" data-k="bins.${a}" placeholder="auto" value="${esc(state.settings.bins[a])}" spellcheck="false">`)}
  </div>`;
}

function editorRow(e) {
  const [bg, letter] = EDITOR_LOOK[e.id] || ['#64748b', e.name[0]];
  const isDef = state.settings.editor === e.id;
  let control;
  if (e.found) control = isDef ? `<span class="pill accent">Default</span>` : `<button class="btn sm" data-act="set-editor" data-v="${e.id}">Make default</button>`;
  else if (installing.has(e.id))
    control = `<button class="btn sm" disabled><svg width="14" height="14" class="spinning" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="20 40" stroke-linecap="round"/></svg>Installing…</button>`;
  else if (e.can_install) control = `<button class="btn sm soft" data-act="install-editor" data-v="${e.id}">${icon('download', 13)}Install</button>`;
  else control = `<span class="missing">Not available here</span>`;
  const status = e.found
    ? `<span class="found">${icon('check', 12, 2.6)}Installed</span>`
    : installing.has(e.id)
      ? `<span class="missing mono" data-install-line="${e.id}">Starting…</span>`
      : '<span class="missing">Not installed</span>';
  return `<div class="set-row editor-row"><span class="logo" style="background:${bg}">${letter}</span><span class="txt"><b>${esc(e.name)}</b><span>${status}</span></span>${control}</div>`;
}

const BODY = {
  appearance: () => `
    <div class="theme-cards">${[
      ['light', 'Light', ''],
      ['dark', 'Dark', 'dark'],
      ['system', 'Match system', 'sys'],
    ]
      .map(([t, l, c]) => `<button class="theme-card" data-act="theme" data-v="${t}" aria-pressed="${state.settings.theme === t}"><div class="prev ${c}"><div class="pl"></div><div class="pr"><i></i><i></i><i></i></div></div>${l}</button>`)
      .join('')}</div>
    <div class="set-group">
      ${row('Accent color', 'Buttons, progress and focus rings', `<div class="swatches">${Object.entries(ACCENTS).map(([k, c]) => `<button class="swatch" style="background:${c}" data-act="accent" data-v="${k}" aria-pressed="${state.settings.accent === k}" title="${k}" aria-label="${k}"></button>`).join('')}</div>`)}
      ${row('Window material', state.info.glass ? 'Native macOS glass behind the sidebar' : 'Frosted. This desktop does not offer window blur to apps.', '')}
    </div>`,
  agents: () => `
    ${AGENTS.map(agentRows).join('')}
    <div class="set-group">
      ${row('Lean mode', 'Skip hooks, plugins and CLAUDE.md discovery for Claude to cut tokens per turn. Needs ANTHROPIC_API_KEY; with a Claude.ai sign-in Claude runs normally', toggle('lean', state.settings.lean))}
      ${row('Python', 'Runs the goal loop. Leave empty to use python3 on your PATH', `<input class="field mono" data-bind="set-text" data-k="bins.python" placeholder="python3" value="${esc(state.settings.bins.python)}" spellcheck="false">`)}
    </div>`,
  editor: () => `
    <div class="set-title">Open workspaces with</div>
    <div class="set-group">${state.editors.map(editorRow).join('') || row('No editors detected', '', '')}</div>`,
  runs: () => `
    <div class="set-group">
      ${row('Runs at the same time', 'Others wait in a queue. One run per folder at a time.', stepper('max_parallel', state.settings.max_parallel))}
      ${row('Size limits to the problem', "Default for team goals: the lead sizes the budget and rounds to the problem, never above the defaults below, and the run stops for you before going past them", toggle('auto_limits', state.settings.auto_limits))}
      ${row('Default budget', state.settings.auto_limits ? 'Dollars per run, and the most a run sized by its lead may spend' : 'Dollars per run, for new goals', `<input class="field num" style="width:90px;text-align:right" data-bind="set-num" data-k="default_budget" value="${state.settings.default_budget}" inputmode="decimal">`)}
      ${row('Default max turns', '', stepper('default_turns', state.settings.default_turns))}
      ${row('Check timeout', 'Seconds before a check command is killed', `<input class="field num" style="width:90px;text-align:right" data-bind="set-num" data-k="check_timeout_sec" value="${state.settings.check_timeout_sec}" inputmode="numeric">`)}
      ${row('Work as a team', 'Default for new goals: a lead staffs every installed model by role', toggle('team', state.settings.team))}
      ${row('Switch agent when stuck', 'Default for new goals that use one agent', toggle('switch_agent', state.settings.switch_agent))}
    </div>`,
  about: () => `
    <div style="display:flex;align-items:center;gap:14px;margin:6px 0 18px">${logo(48)}<div><div style="font:650 18px var(--font-display)">Iteraxa</div><div class="faint">Version ${esc(state.info.version)} · Goal runner for Claude Code, Codex and Cursor</div></div></div>
    <div class="set-group">
      ${row('Background service', state.info.daemon ? 'Running. Runs continue when this window is closed.' : 'Not connected', `<span class="dot ${state.info.daemon ? 'ok' : 'bad'}"></span>`)}
      ${row('Data folder', `<span class="mono">${esc(shortPath(state.info.data_dir))}</span>`, `<button class="btn sm" data-act="reveal" data-path="${esc(state.info.data_dir)}">${icon('folder', 13)}Show</button>`)}
    </div>
    <div class="faint" style="font-size:12px">Built with Tauri, Go, Rust and Python. Goals and ledgers use TOON to keep prompts small.</div>
    <div class="faint" style="font-size:10px">Initiative by Harpreet Singh</div>`,
};

export function settingsHTML() {
  const t = state.settingsTab;
  const label = TABS.find((x) => x[0] === t)[2];
  return `<div class="scrim" data-act="scrim"><div class="dialog" role="dialog" aria-modal="true" aria-label="Settings">
    <nav class="d-nav"><h2>Settings</h2>${TABS.map(([id, ic, l]) => `<button data-act="tab" data-v="${id}" ${t === id ? 'aria-current="true"' : ''}>${icon(ic, 15)}${l}</button>`).join('')}</nav>
    <section class="d-body"><div class="d-head"><h3>${label}</h3><button class="btn ghost sm icon" data-act="close" aria-label="Close">${icon('x', 15)}</button></div><div class="d-scroll">${BODY[t]()}</div></section>
  </div></div>`;
}

export function onboardingHTML() {
  const a = (k) => {
    const s = state.agents[k] || {};
    return row(
      `<span style="display:inline-flex;align-items:center;gap:8px"><span class="agent-dot ${k}"></span>${agentName(k)}</span>`,
      s.found ? esc(s.version || shortPath(s.path)) : `Install: <span class="mono">${esc(INSTALL[k])}</span>`,
      s.found ? `<span class="found">${icon('check', 13, 2.6)}Found</span>` : `<button class="btn sm" data-act="copy" data-v="${esc(INSTALL[k])}">${icon('copy', 13)}Copy</button>`,
    );
  };
  const editors = state.editors.filter((e) => e.found);
  return `<div class="scrim"><div class="dialog narrow" role="dialog" aria-modal="true" aria-label="Welcome"><div class="welcome">
    <div class="mark">${logo(52)}</div>
    <h2>Welcome to Iteraxa</h2>
    <p>Give it a goal. A team of models from Claude Code, Codex and Cursor, or just one of them, works in your folder the way you would: reproduce, find the cause, test it, fix, check again. When it is stuck or needs something only you know, it asks.</p>
    <div class="set-title">Agents on this machine</div>
    <div class="set-group">${AGENTS.map(a).join('')}</div>
    <div class="set-group">
      ${row('Look', '', `<div class="seg">${[['light', 'sun', 'Light'], ['system', 'monitor', 'Auto'], ['dark', 'moon', 'Dark']].map(([t, ic, l]) => `<button data-act="theme" data-v="${t}" aria-pressed="${state.settings.theme === t}">${icon(ic, 14)}${l}</button>`).join('')}</div>`)}
      ${editors.length ? row('Code editor', '', `<select class="field" style="width:180px" data-bind="set-select" data-k="editor">${editors.map((e) => `<option value="${e.id}" ${e.id === state.settings.editor ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>`) : ''}
    </div>
    <div class="actions"><button class="btn primary lg" data-act="onboarded">Get started</button></div>
  </div></div></div>`;
}

function setPath(key, value) {
  const [a, b] = key.split('.');
  ui.saveSettings(b ? { [a]: { ...state.settings[a], [b]: value } } : { [a]: value }, { quiet: true });
}

const LIMITS = { max_parallel: [1, 8], default_turns: [1, Infinity] };

export const actions = {
  settings: (el) => ui.openSettings(el.dataset.tab),
  tab(el) {
    state.settingsTab = el.dataset.v;
    ui.renderOverlay();
  },
  close: () => ui.closeOverlay(),
  scrim: (el, e) => e.target === el && ui.closeOverlay(),
  accent: (el) => ui.saveSettings({ accent: el.dataset.v }),
  'set-toggle'(el) {
    const k = el.dataset.k;
    ui.saveSettings({ [k]: !state.settings[k] });
  },
  'set-step'(el) {
    const k = el.dataset.k;
    const [lo, hi] = LIMITS[k];
    ui.saveSettings({ [k]: Math.min(hi, Math.max(lo, state.settings[k] + +el.dataset.v)) });
  },
  'set-editor': (el) => ui.saveSettings({ editor: el.dataset.v }),
  async 'install-editor'(el) {
    const id = el.dataset.v;
    installing.add(id);
    ui.renderOverlay();
    try {
      await api.installEditor(id);
    } catch (e) {
      installing.delete(id);
      toast(String(e), 'bad');
      ui.renderOverlay();
    }
  },
  copy(el) {
    navigator.clipboard?.writeText(el.dataset.v);
    toast('Copied to clipboard');
  },
  onboarded() {
    ui.saveSettings({ onboarded: true, editor: state.settings.editor || state.editors.find((e) => e.found)?.id || '' });
    ui.closeOverlay();
  },
};

export const binds = {
  'set-text': (el) => setPath(el.dataset.k, el.value.trim()),
  'set-select': (el) => setPath(el.dataset.k, el.value),
  'set-num'(el) {
    const n = parseFloat(el.value);
    if (!(n > 0)) return;
    const lim = LIMITS[el.dataset.k];
    setPath(el.dataset.k, lim ? Math.min(lim[1], Math.max(lim[0], Math.round(n))) : n);
  },
};

export async function onEditorInstall(p) {
  if (!p.done) {
    const el = document.querySelector(`[data-install-line="${CSS.escape(p.name)}"]`);
    if (el && p.line) el.textContent = p.line;
    return;
  }
  installing.delete(p.name);
  const name = state.editors.find((e) => e.id === p.name)?.name || p.name;
  if (p.ok) toast(`${name} installed`);
  else toast(p.error || `Could not install ${name}`, 'bad');
  state.editors = await api.editors();
  ui.renderOverlay();
}
