const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const money = (n) => '$' + (n || 0).toFixed(2);
export const tokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
export const bytes = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : (n || 0) + ' B');

export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function relTime(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  if (s < 86400 * 7) return Math.round(s / 86400) + 'd ago';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// A moment in the coming days as a clock time: "7:30 AM" today, "Thu 7:30 AM" this week, "Nov 12, 7:30 AM" later.
export function when(t) {
  const d = new Date(t);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  const day = d - Date.now() < 6 * 86400000 ? { weekday: 'short' } : { month: 'short', day: 'numeric' };
  return `${d.toLocaleDateString(undefined, day)}, ${time}`;
}

export function dayGroup(t) {
  const d = new Date(t);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = (today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Previous 7 days';
  return 'Earlier';
}

// Cursor first, then Claude, then Codex: mirrors VENDORS in python/iteraxa/team.py (default agent and fallback order).
export const AGENTS = ['cursor', 'claude', 'codex'];
export const agentName = (a) => ({ codex: 'Codex', cursor: 'Cursor' })[a] || 'Claude';

// Mirrors ROSTER in python/iteraxa/team.py: who a team can staff, by tier.
export const TEAM = [
  ['cursor', 'Grok 4.6', 'strong'], ['cursor', 'Grok 4.7', 'premium'],
  ['claude', 'Haiku', 'fast'], ['claude', 'Sonnet', 'strong'], ['claude', 'Opus', 'premium'],
  ['codex', 'Luna', 'fast'], ['codex', 'Sol', 'strong'], ['codex', 'Astra', 'premium'],
].map(([agent, label, tier]) => ({ agent, label, tier }));
export const TIERS = ['fast', 'strong', 'premium'];
export const agentIconName = (a) => ({ codex: 'terminal', cursor: 'pointer' })[a] || 'sparkles';
export const shortPath = (p) => String(p || '').replace(/^\/(Users|home)\/[^/]+/, '~');
export const baseName = (p) => String(p || '').split('/').filter(Boolean).pop() || p;

export const STATUS = {
  queued: { label: 'Queued', cls: '' },
  running: { label: 'Running', cls: 'accent' },
  waiting: { label: 'Needs you', cls: 'warn' },
  passed: { label: 'Goal reached', cls: 'ok' },
  failed: { label: 'Not reached', cls: 'bad' },
  stopped: { label: 'Stopped', cls: '' },
  interrupted: { label: 'Interrupted', cls: 'warn' },
};

export const REASONS = {
  checks_passed: 'Every check exits 0',
  goal_met: 'The agent judged the goal met',
  good_enough: 'Stopped — more work was not worth the cost',
  budget: 'The budget ran out before the checks passed',
  max_turns: 'The turn limit was hit before the checks passed',
  no_progress: 'The same failure kept repeating',
  agent_failed: 'The agent exited with an error',
  loop_failed: 'The goal loop could not read this goal',
  stopped: 'You stopped this run',
  interrupted: 'The background service restarted while this run was active',
  error: 'The run could not start',
};

// Waiting runs count as live: they hold their folder until you answer or stop them.
export const isLive = (r) => r.status === 'running' || r.status === 'queued' || r.status === 'waiting';
