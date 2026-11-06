import { icon, logo } from '../icons.js';
import { state } from '../store.js';
import { ui, runGlyph, menu, confirmDialog, toast, mod } from '../ui.js';
import { api } from '../api.js';
import { esc, money, tokens, relTime, dayGroup, agentName, isLive, shortPath } from '../util.js';

const cost = (r) => (r.spent_usd > 0 || !r.tokens ? money(r.spent_usd) : tokens(r.tokens) + ' tok');

function meta(r) {
  const who = r.team ? 'Team' : agentName(r.current_agent || r.agent);
  if (r.status === 'queued') return `Waiting for a slot · ${who}`;
  if (r.status === 'waiting') return r.ask?.kind === 'checks' ? 'Approve the proposed checks' : 'Needs your answer';
  if (r.status === 'running' && r.phase === 'limit') return `Paused for ${agentName(r.current_agent)}’s usage limit`;
  if (r.status === 'running') return `${cost(r)} · turn ${r.turns_used + 1}/${r.max_turns} · ${who}`;
  const n = r.turns_used;
  return `${cost(r)} · ${n} turn${n === 1 ? '' : 's'} · ${relTime(r.finished_at || r.created_at)}`;
}

const item = (r) => {
  const sel = state.selected === r.id ? ' selected' : '';
  return `<div class="run-row${sel}">
    <button class="run-item${sel}" data-act="select" data-id="${esc(r.id)}" title="${esc(r.intent)}">${runGlyph(r)}<span class="ri-body"><span class="ri-title">${esc(r.intent)}</span><span class="ri-meta">${esc(meta(r))}</span></span></button>
    <button class="run-row-more" data-act="run-menu" data-id="${esc(r.id)}" aria-label="Run options" title="Run options">${icon('more', 15)}</button>
  </div>`;
};

const THEMES = [
  ['light', 'sun', 'Light'],
  ['system', 'monitor', 'Match system'],
  ['dark', 'moon', 'Dark'],
];

export function sidebarHTML() {
  const q = state.filter.trim().toLowerCase();
  const all = [...state.runs.values()].sort((a, b) => b.created_at - a.created_at);
  const runs = q ? all.filter((r) => (r.intent + ' ' + r.workspace).toLowerCase().includes(q)) : all;
  const order = { waiting: 0, running: 1, queued: 2 };
  const live = runs.filter(isLive).sort((a, b) => order[a.status] - order[b.status]);
  const groups = new Map();
  for (const r of runs.filter((r) => !isLive(r))) {
    const g = dayGroup(r.created_at);
    groups.set(g, [...(groups.get(g) || []), r]);
  }
  const history = [...groups].map(([g, rs]) => `<div class="sb-day">${g}</div>${rs.map(item).join('')}`).join('');
  const empty = !all.length
    ? '<div class="sb-empty">Runs you start show up here. They keep going even when this window is closed.</div>'
    : !runs.length
      ? '<div class="sb-empty">No runs match.</div>'
      : '';
  return `
    <div class="sb-head" data-tauri-drag-region></div>
    <div class="sb-brand" data-tauri-drag-region>${logo(22)}<span class="name">Iteraxa</span><span class="ver">${esc(state.info.version)}</span></div>
    <div class="sb-new"><button class="btn primary block" data-act="new">${icon('plus', 15, 2.4)}New goal<kbd>${mod()}N</kbd></button></div>
    <div class="sb-search">${icon('search', 13)}<input id="search" placeholder="Search runs" value="${esc(state.filter)}" data-bind="filter" spellcheck="false" autocomplete="off" aria-label="Search runs"></div>
    <div class="sb-scroll">
      ${live.length ? `<div class="sb-section">Active <span class="count">${live.length}</span></div>${live.map(item).join('')}` : ''}
      ${history ? `<div class="sb-section">History</div>${history}` : ''}
      ${empty}
    </div>
    <div class="sb-foot">
      <span class="daemon" title="${esc(state.info.data_dir)}"><span class="dot ${state.info.daemon ? 'ok' : 'bad'}"></span><span>${state.info.daemon ? 'Service running' : 'Service offline'}</span></span>
      <div class="seg mini" role="group" aria-label="Theme">${THEMES.map(([t, ic, l]) => `<button aria-pressed="${state.settings.theme === t}" data-act="theme" data-v="${t}" title="${l}" aria-label="${l}">${icon(ic, 14)}</button>`).join('')}</div>
      <button class="btn ghost sm icon" data-act="settings" title="Settings (${mod()},)" aria-label="Settings">${icon('settings', 16)}</button>
      <div class="sb-credit">Created by Harpreet Singh</div>
    </div>`;
}

export async function deleteRun(id) {
  const r = state.runs.get(id);
  if (!r || isLive(r)) return;
  const ok = await confirmDialog('Delete this run?', 'Its history and logs are removed. Files in the workspace are not touched.');
  if (!ok) return;
  try {
    await api.deleteRun(id);
    state.runs.delete(id);
    state.details.delete(id);
    if (state.selected === id) ui.select('new');
    else ui.renderSidebar();
  } catch (e) {
    toast(String(e), 'bad');
  }
}

export function runMenu(anchor, id) {
  const r = state.runs.get(id);
  if (!r) return;
  menu(anchor, [
    { label: 'Show workspace', icon: 'folder', action: () => api.reveal(r.workspace) },
    { label: 'Show run files', icon: 'file-text', action: () => api.reveal(r.dir) },
    { label: 'Copy workspace path', icon: 'copy', hint: shortPath(r.workspace), action: () => navigator.clipboard?.writeText(r.workspace) },
    'sep',
    { label: 'Delete run…', icon: 'trash', danger: true, disabled: isLive(r), action: () => deleteRun(id) },
  ]);
}

export const actions = {
  select: (el) => ui.select(el.dataset.id),
  new: () => ui.select('new'),
  theme: (el) => ui.saveSettings({ theme: el.dataset.v }),
  'run-menu': (el) => runMenu(el, el.dataset.id),
};

export const binds = {
  filter: (el) => {
    state.filter = el.value;
    ui.renderSidebar();
  },
};
