import { icon } from './icons.js';
import { esc } from './util.js';

// Views call these; main.js fills them in.
export const ui = { renderSidebar() {}, renderMain() {}, renderOverlay() {}, select() {}, saveSettings() {}, openSettings() {} };

export function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = icon(kind === 'bad' ? 'alert' : 'check', 15, 2.4) + `<span>${esc(msg)}</span>`;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

let menuEl = null;
export const menuOpen = () => !!menuEl;
export function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}

export function menu(anchor, items) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'menu';
  el.setAttribute('role', 'menu');
  el.innerHTML = items
    .map((it, i) =>
      it === 'sep'
        ? '<div class="sep"></div>'
        : `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${it.icon ? icon(it.icon, 15) : ''}<span>${esc(it.label)}</span>${it.hint ? `<span class="faint">${esc(it.hint)}</span>` : ''}</button>`,
    )
    .join('');
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - el.offsetWidth, innerWidth - el.offsetWidth - 8));
  const top = r.bottom + 6 + el.offsetHeight > innerHeight - 8 ? r.top - el.offsetHeight - 6 : r.bottom + 6;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const it = items[+b.dataset.i];
    closeMenu();
    it.action?.();
  });
  menuEl = el;
}

export function confirmDialog(title, body, okLabel = 'Delete') {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.innerHTML = `<div class="scrim"><div class="dialog narrow" role="alertdialog" aria-modal="true"><div class="welcome">
      <h2 style="font-size:17px">${esc(title)}</h2><p>${esc(body)}</p>
      <div class="actions"><button class="btn" data-r="0">Cancel</button><button class="btn danger" data-r="1">${esc(okLabel)}</button></div>
    </div></div></div>`;
    document.body.append(host);
    host.querySelector('[data-r="0"]').focus();
    const done = (v) => {
      host.remove();
      document.removeEventListener('keydown', key, true);
      resolve(v);
    };
    const key = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(false);
      }
    };
    document.addEventListener('keydown', key, true);
    host.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (b) done(b.dataset.r === '1');
      else if (e.target.classList.contains('scrim')) done(false);
    });
  });
}

export function ring(p, size = 18, stroke = 2.4, cls = '') {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(1, Math.max(0, p)));
  const h = size / 2;
  return `<svg class="ring ${cls}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle class="track" cx="${h}" cy="${h}" r="${r}" fill="none" stroke-width="${stroke}"/><circle class="bar" cx="${h}" cy="${h}" r="${r}" fill="none" stroke-width="${stroke}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/></svg>`;
}

const DASHED = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.6 2.4"/></svg>';

export function glyph(status, progress = 0) {
  switch (status) {
    case 'running':
      return `<span class="glyph live" title="Running">${ring(Math.max(0.08, progress))}</span>`;
    case 'queued':
    case 'pending':
      return `<span class="glyph queued" title="Waiting">${DASHED}</span>`;
    case 'waiting':
      return `<span class="glyph wait" title="Needs you">${icon('message', 10, 2.8)}</span>`;
    case 'skipped':
      return `<span class="glyph queued" title="Runs after the checks above pass">${DASHED}</span>`;
    case 'passed':
      return `<span class="glyph ok" title="Passed">${icon('check', 11, 3.2)}</span>`;
    case 'failed':
      return `<span class="glyph bad" title="Failed">${icon('x', 11, 3.2)}</span>`;
    case 'interrupted':
      return `<span class="glyph warn" title="Interrupted">${icon('alert', 10, 2.6)}</span>`;
    default:
      return `<span class="glyph muted" title="Stopped"><svg width="7" height="7" aria-hidden="true"><rect width="7" height="7" rx="1.6" fill="currentColor"/></svg></span>`;
  }
}

export const runGlyph = (r) => glyph(r.status, r.turns_used / (r.max_turns || 1));

export const EDITOR_LOOK = {
  cursor: ['#18181b', 'Cu'],
  vscode: ['#0a7acc', 'VS'],
  vscodium: ['#2f80ed', 'Vc'],
  zed: ['#084ccf', 'Z'],
  sublime: ['#ff9800', 'S'],
  lapce: ['#4c6ef5', 'L'],
  kate: ['#1d99f3', 'K'],
  'gnome-text-editor': ['#3584e4', 'T'],
};

export const mod = () => (document.documentElement.dataset.platform === 'macos' ? '⌘' : 'Ctrl ');
