import { api } from './api.js';
import { state, freshDraft, DEFAULT_SETTINGS } from './store.js';
import { ui, toast, closeMenu, menuOpen } from './ui.js';
import { duration, isLive } from './util.js';
import * as sidebar from './views/sidebar.js';
import * as compose from './views/compose.js';
import * as run from './views/run.js';
import * as settings from './views/settings.js';

const $ = (s) => document.querySelector(s);
const root = document.documentElement;
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

const actions = { ...sidebar.actions, ...compose.actions, ...run.actions, ...settings.actions };
const binds = { ...sidebar.binds, ...compose.binds, ...run.binds, ...settings.binds };

function applyTheme() {
  const t = state.settings.theme;
  root.dataset.theme = t === 'system' ? (darkQuery.matches ? 'dark' : 'light') : t;
  root.dataset.accent = state.settings.accent;
}
darkQuery.addEventListener('change', applyTheme);

function keepScroll(el, sel, paint) {
  const top = el.querySelector(sel)?.scrollTop || 0;
  paint();
  const s = el.querySelector(sel);
  if (s) s.scrollTop = top;
}

ui.renderSidebar = () => {
  const el = $('#sidebar');
  const typing = document.activeElement?.id === 'search';
  keepScroll(el, '.sb-scroll', () => (el.innerHTML = sidebar.sidebarHTML()));
  if (typing) {
    const s = $('#search');
    s.focus();
    s.setSelectionRange(s.value.length, s.value.length);
  }
};

ui.renderMain = () => {
  const el = $('#main');
  const same = el.dataset.view === state.selected;
  el.dataset.view = state.selected;
  keepScroll(el, '.content', () => (el.innerHTML = state.selected === 'new' ? compose.composeHTML() : run.runHTML(state.selected)));
  if (same) el.querySelector('.enter')?.classList.remove('enter');
};

ui.renderOverlay = () => {
  const el = $('#overlay');
  const html = state.overlay === 'settings' ? settings.settingsHTML() : state.overlay === 'onboarding' ? settings.onboardingHTML() : '';
  keepScroll(el, '.d-scroll', () => (el.innerHTML = html));
};

ui.openSettings = (tab) => {
  closeMenu();
  state.overlay = 'settings';
  if (tab) state.settingsTab = tab;
  ui.renderOverlay();
};

ui.closeOverlay = () => {
  state.overlay = null;
  ui.renderOverlay();
};

ui.select = async (id) => {
  state.selected = id;
  state.open.clear();
  if (id === 'new' && !state.draft) state.draft = freshDraft();
  ui.renderSidebar();
  ui.renderMain();
  if (id === 'new') $('#intent')?.focus();
  else loadDetail(id);
};

let saveTimer;
ui.saveSettings = (patch, { quiet = false } = {}) => {
  const themeChanged = 'theme' in patch && patch.theme !== state.settings.theme;
  state.settings = { ...state.settings, ...patch };
  applyTheme();
  if (themeChanged) api.setTheme(state.settings.theme).catch(() => {});
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.setSettings(state.settings).catch((e) => toast(String(e), 'bad')), 250);
  if (quiet) return;
  ui.renderSidebar();
  ui.renderOverlay();
};

async function loadDetail(id) {
  try {
    const d = await api.getRun(id);
    state.details.set(id, d);
    if (d.meta) state.runs.set(id, d.meta);
    if (state.logs.has(id)) state.logs.set(id, await api.runLogs(id).catch(() => state.logs.get(id)));
    if (state.selected === id) ui.renderMain();
  } catch (e) {
    toast(String(e), 'bad');
  }
}

const FINISHED = { passed: ['Goal reached', 'ok'], failed: ['Goal not reached', 'bad'], interrupted: ['Run interrupted', 'bad'], waiting: ['Needs your input', ''] };

function onRun({ run: r, ev }) {
  const prev = state.runs.get(r.id);
  state.runs.set(r.id, r);
  ui.renderSidebar();
  if (state.selected === r.id) {
    if (state.details.has(r.id) && ev && ev.type !== 'running') loadDetail(r.id);
    else ui.renderMain();
  }
  if (prev && isLive(prev) && prev.status !== r.status && FINISHED[r.status]) {
    const [msg, kind] = FINISHED[r.status];
    toast(`${msg}: ${r.intent}`, kind);
  }
}

function tick() {
  document.querySelectorAll('[data-since]').forEach((el) => (el.textContent = duration(Date.now() - +el.dataset.since)));
  document.querySelectorAll('[data-until]').forEach((el) => (el.textContent = duration(Math.max(0, +el.dataset.until - Date.now()))));
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  actions[el.dataset.act]?.(el, e);
});

document.addEventListener('input', (e) => {
  const b = e.target.dataset?.bind;
  if (b) binds[b]?.(e.target, e);
});

document.addEventListener('change', (e) => {
  if (e.target.tagName === 'SELECT' && e.target.dataset.bind) binds[e.target.dataset.bind]?.(e.target, e);
});

document.addEventListener('pointerdown', (e) => !e.target.closest('.menu') && closeMenu(), true);

document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input, textarea, pre, .run-title')) return;
  e.preventDefault();
  const item = e.target.closest('.run-item');
  if (item) sidebar.runMenu(item, item.dataset.id);
});

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape') {
    if (menuOpen()) closeMenu();
    else if (state.overlay === 'settings') ui.closeOverlay();
    return;
  }
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'n') ui.select('new');
  else if (k === ',') ui.openSettings();
  else if (k === 'f') $('#search')?.focus();
  else if (k === 'enter' && state.selected === 'new' && !state.overlay) compose.start();
  else return;
  e.preventDefault();
});

async function boot() {
  const [info, saved, runs] = await Promise.all([api.appInfo(), api.getSettings(), api.listRuns()]);
  state.info = info;
  state.settings = { ...DEFAULT_SETTINGS, ...saved, models: { ...DEFAULT_SETTINGS.models, ...saved?.models }, bins: { ...DEFAULT_SETTINGS.bins, ...saved?.bins } };
  root.dataset.glass = String(!!info.glass);
  root.dataset.platform = info.platform;
  for (const r of runs) state.runs.set(r.id, r);
  applyTheme();
  state.draft = freshDraft();

  const [agents, editors] = await Promise.all([api.agents().catch(() => ({})), api.editors().catch(() => [])]);
  state.agents = agents;
  state.editors = editors;

  api.listen('ixd://run', onRun);
  api.listen('ixd://status', (s) => {
    state.info.daemon = !!s.connected;
    if (s.connected) {
      // Reconcile after a (re)connect: a run that died while we were disconnected is no longer running,
      // so refresh the list and reload the open run instead of leaving its timer ticking forever.
      api.listRuns()
        .then((rs) => {
          rs.forEach((r) => state.runs.set(r.id, r));
          ui.renderSidebar();
          if (state.selected !== 'new' && state.runs.has(state.selected)) loadDetail(state.selected);
        })
        .catch(() => ui.renderSidebar());
    } else {
      ui.renderSidebar();
      if (state.selected !== 'new') ui.renderMain();
    }
  });
  api.listen('editor://install', settings.onEditorInstall);
  // An agent CLI installed while the app is open shows up when you come back to it.
  addEventListener('focus', async () => {
    const agents = await api.agents().catch(() => null);
    if (!agents || JSON.stringify(agents) === JSON.stringify(state.agents)) return;
    state.agents = agents;
    ui.renderMain();
    ui.renderOverlay();
  });

  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  if (!state.settings.onboarded) state.overlay = 'onboarding';
  if (view === 'settings') ui.openSettings(params.get('tab'));
  else if (view === 'onboarding') state.overlay = 'onboarding';
  else if (view === 'none') state.overlay = null;
  const first = view === 'new' || state.runs.has(view) ? view : [...state.runs.values()].find(isLive)?.id || 'new';
  await ui.select(first);
  ui.renderOverlay();
  setInterval(tick, 1000);
}

boot().catch((e) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#c62828">Iteraxa failed to start:\n${String(e?.stack || e)}</pre>`;
});
