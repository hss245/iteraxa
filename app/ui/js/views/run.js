import { icon } from '../icons.js';
import { state } from '../store.js';
import { ui, menu, toast, ring, glyph, runGlyph } from '../ui.js';
import { api } from '../api.js';
import { runMenu } from './sidebar.js';
import { esc, money, tokens, bytes, duration, relTime, when, agentName, agentIconName, shortPath, baseName, STATUS, REASONS, isLive, AGENTS } from '../util.js';

const agentIcon = (a) => icon(agentIconName(a), 18, 2.2);
const turnsOf = (d) => (d?.turns || []).filter((t) => !t.type || t.type === 'turn');
const estimated = (d) => (d?.turns || []).some((t) => t.estimated || t.items?.some((x) => x.estimated));
const who = (e) => e.member?.label || agentName(e.agent);
const usd = (x) => (x.cost_usd > 0 && x.cost_usd < 0.005 ? '<$0.01' : (x.estimated ? '≈' : '') + money(x.cost_usd));
const mem = (m, badge = true) => `<span class="mem"><i class="agent-dot ${m.agent}"></i>${esc(m.label)}${badge && m.tier === 'premium' ? '<b class="prem">premium</b>' : ''}</span>`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const lastEstimate = (d) => (d?.turns || []).findLast((e) => e.estimate)?.estimate;

// What a team is doing right now, from the loop's latest "running" event: [live text, short label].
const PHASE = {
  staff: ['Staffing the round…', 'Staffing'],
  investigate: ['Testing theories in throwaway copies…', 'Investigating'],
  attempts: ['Competing, each in its own copy…', 'Competing attempts'],
  work: ['Reproducing, probing, fixing…', 'Fixing'],
  review: ['Reviewing the work…', 'Reviewing'],
  propose: ['Looking around to propose checks…', 'Proposing checks'],
  scope: ['Figuring out the goal and what “done” looks like…', 'Scoping the goal'],
  judge: ['Checking if the result is good enough…', 'Judging'],
  report: ['Writing up the results…', 'Writing the report'],
};
const phase = (r) => (r.team && r.members?.length ? PHASE[r.phase] : null);

const BUILT_IN = {
  verdict: ['verdict.json', 'supported or rejected, with method, threshold and numbers'],
  reproduce: ['Reproduces', 'Iteraxa re-runs the analysis; the numbers must match'],
  review: ['Reviewed', 'a different agent checks the reasoning, read-only'],
};

function banner(r, d) {
  const took = r.finished_at && r.started_at ? ' · ' + duration(r.finished_at - r.started_at) : '';
  const n = `${r.turns_used} turn${r.turns_used === 1 ? '' : 's'}`;
  const spend = r.spent_usd > 0 || !r.tokens ? (estimated(d) ? '≈' : '') + money(r.spent_usd) : tokens(r.tokens) + ' tokens';
  switch (r.status) {
    case 'passed': {
      if (r.verdict) return '';
      const good = r.reason === 'good_enough';
      const why = REASONS[r.reason] || 'every check exits 0';
      return `<div class="banner ${good ? 'muted' : 'ok'}">${icon(good ? 'stop' : 'check', good ? 15 : 18, 2.6)}<span>${good ? 'Good enough' : 'Goal reached'} <span class="sub">· ${esc(r.stop_reason || why)} · ${n} · ${spend}${took}</span></span></div>`;
    }
    case 'failed':
      return `<div class="banner bad">${icon('alert', 17)}<span>Goal not reached <span class="sub">· ${esc(REASONS[r.reason] || r.reason)}${r.error ? ': ' + esc(r.error) : ''}</span></span></div>${extendCard(r, n, spend, d)}`;
    case 'stopped':
      return `<div class="banner muted">${icon('stop', 15)}<span>Stopped <span class="sub">· after ${n} · ${spend}</span></span></div>`;
    case 'interrupted':
      return `<div class="banner warn">${icon('alert', 17)}<span>Interrupted <span class="sub">· ${esc(REASONS.interrupted)}</span></span></div>`;
    case 'queued':
      return `<div class="banner muted">${icon('clock', 16)}<span>Waiting for a free slot <span class="sub">· ${state.settings.max_parallel} runs go at once; change this in Settings</span></span></div>`;
    case 'waiting':
      return askCard(r);
    default:
      return '';
  }
}

// Stopped by a limit: raise it and the same run carries on with its turns, notes and spend.
// A team's lead re-estimates every round, so its latest estimate pre-fills the new limits when it is higher.
function extendCard(r, n, spend, d) {
  if (r.reason !== 'budget' && r.reason !== 'max_turns') return '';
  const est = lastEstimate(d);
  if (!state.extends.has(r.id)) {
    const broke = r.reason === 'budget' || r.spent_usd >= r.budget_usd;
    const out = r.reason === 'max_turns' || r.turns_used >= r.max_turns;
    state.extends.set(r.id, {
      budget: broke ? Math.max(est?.budget_usd > r.budget_usd ? est.budget_usd : r.budget_usd * 2, r.spent_usd + 0.5) : r.budget_usd,
      turns: out ? (est?.max_turns > r.max_turns ? est.max_turns : Math.max(r.max_turns + 1, Math.ceil(r.max_turns * 1.5))) : r.max_turns,
    });
  }
  const x = state.extends.get(r.id);
  const id = esc(r.id);
  const lead = est && (est.budget_usd > r.budget_usd || est.max_turns > r.max_turns) ? ' Pre-filled with the lead’s latest estimate.' : '';
  return `<div class="card extend-card">
    <div class="ext-text"><b>Raise the limit and continue</b><span>It picks up at turn ${r.turns_used + 1} with everything it learned. Used so far: ${n}, ${spend}.${lead}</span></div>
    <label class="ext-field"><span>Budget</span><span class="ext-input"><i>$</i><input class="field num" data-bind="ext-budget" data-id="${id}" value="${x.budget.toFixed(2)}" inputmode="decimal" aria-label="New budget in dollars"></span></label>
    <label class="ext-field"><span>Max turns</span><input class="field num" data-bind="ext-turns" data-id="${id}" value="${x.turns}" inputmode="numeric" aria-label="New max turns"></label>
    <button class="btn primary sm" data-act="extend" data-id="${id}">${icon('play', 12)}Continue</button>
  </div>`;
}

function askCard(r) {
  const ask = r.ask || { kind: 'hint', question: '', checks: [] };
  const id = esc(r.id);
  if (ask.kind === 'checks') {
    if (!state.approvals.has(r.id)) state.approvals.set(r.id, ask.checks.map((c) => ({ ...c })));
    const rows = state.approvals
      .get(r.id)
      .map(
        (c, i) => `<div class="approve-row">
          <input class="field" value="${esc(c.id)}" data-bind="appr-id" data-id="${id}" data-i="${i}" spellcheck="false" aria-label="Check name">
          <div class="approve-cmd"><textarea class="field mono" rows="${Math.min(c.cmd.split('\n').length, 12)}" data-bind="appr-cmd" data-id="${id}" data-i="${i}" spellcheck="false" aria-label="Check command">${esc(c.cmd)}</textarea>${c.why ? `<span class="why">${esc(c.why)}</span>` : ''}</div>
          <button class="btn ghost sm icon" data-act="appr-rm" data-id="${id}" data-i="${i}" aria-label="Remove check">${icon('x', 14)}</button>
        </div>`,
      )
      .join('');
    return `<div class="card ask-card">
      <div class="ask-head"><span class="ask-icon">${icon('list-checks', 17)}</span><div><h3>Approve how it will prove this is done</h3><p>${esc(ask.question || 'The agent looked around and proposed these checks. Edit them if needed.')}</p></div></div>
      <div class="approve-list">${rows}</div>
      <div class="ask-actions">
        <button class="btn ghost sm" data-act="appr-add" data-id="${id}">${icon('plus', 14)}Add check</button>
        <span class="spacer"></span>
        <button class="btn sm" data-act="stop" data-id="${id}">Stop run</button>
        <button class="btn primary sm" data-act="approve" data-id="${id}">${icon('check', 14, 2.4)}Approve and start</button>
      </div>
    </div>`;
  }
  return `<div class="card ask-card">
    <div class="ask-head"><span class="ask-icon">${icon('message', 17)}</span><div><h3>The agent needs you</h3><p class="ask-q">${esc(ask.question)}</p></div></div>
    <textarea class="field reply" rows="3" data-bind="reply" data-id="${id}" placeholder="e.g. The config file is settings.local.toml, and the test server runs on port 8080">${esc(state.replies.get(r.id) || '')}</textarea>
    <div class="ask-actions">
      <span class="faint" style="font-size:12px">It keeps everything it has learned so far and carries on with your answer.</span>
      <span class="spacer"></span>
      <button class="btn sm" data-act="stop" data-id="${id}">Stop run</button>
      <button class="btn primary sm" data-act="send-reply" data-id="${id}">${icon('send', 13)}Send and continue</button>
    </div>
  </div>`;
}

function verdictCard(r) {
  const v = r.verdict;
  if (!v) return '';
  const supported = v.verdict === 'supported';
  const results = Object.entries(v.results || {})
    .map(([k, x]) => `<div class="kv"><span>${esc(k)}</span><b class="mono">${esc(typeof x === 'number' ? +x.toPrecision(6) : JSON.stringify(x))}</b></div>`)
    .join('');
  return `<div class="card verdict-card ${supported ? 'ok' : 'bad'}">
    <div class="verdict-top">
      <span class="verdict-badge">${icon(supported ? 'check' : 'x', 16, 2.8)}${supported ? 'Supported' : 'Rejected'}</span>
      <span class="faint">Hypothesis tested · reproduced on a re-run · accepted by a reviewer</span>
    </div>
    <p class="hyp">${esc(r.hypothesis)}</p>
    <p class="evidence">${esc(v.evidence)}</p>
    <div class="verdict-grid">
      <div class="kv wide"><span>Method</span><b>${esc(v.method)}</b></div>
      <div class="kv"><span>Threshold</span><b class="mono">${esc(v.threshold)}</b></div>
      ${results}
    </div>
  </div>`;
}

// The human-readable results report: outcome, plain-language summary and sections (findings carry a severity and
// numbered reproduction steps). Written by a final read-only agent call; the full HTML opens in a browser.
function reportCard(r) {
  const rep = r.report;
  if (!rep || !(rep.outcome || rep.summary || rep.sections?.length)) return '';
  const sev = (s) => (s ? `<span class="rp-sev ${esc(s)}">${esc(s)}</span>` : '');
  const steps = (xs) => (xs?.length ? `<ol class="rp-steps">${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : '');
  const item = (it) =>
    `<div class="rp-item">${it.title || it.severity ? `<div class="rp-ititle">${sev(it.severity)}<b>${esc(it.title)}</b></div>` : ''}${it.detail ? `<p>${esc(it.detail)}</p>` : ''}${steps(it.steps)}</div>`;
  const section = (s) =>
    `<section class="rp-section">${s.heading ? `<h4>${esc(s.heading)}</h4>` : ''}${s.body ? `<p>${esc(s.body)}</p>` : ''}${(s.items || []).map(item).join('')}</section>`;
  const next = rep.next_steps?.length ? `<section class="rp-section"><h4>Next steps</h4>${steps(rep.next_steps)}</section>` : '';
  const open = r.report_path ? `<button class="btn ghost sm" data-act="reveal" data-path="${esc(r.report_path)}">${icon('external-link', 13)}Open report</button>` : '';
  return `<div class="card report-card"><div class="card-head">${icon('file-text', 16)}<h3>Results</h3><span class="hint">${esc(rep.title || '')}</span><div class="right">${open}</div></div>
    ${rep.outcome ? `<p class="rp-outcome">${esc(rep.outcome)}</p>` : ''}
    ${rep.summary ? `<p class="rp-summary">${esc(rep.summary)}</p>` : ''}
    ${(rep.sections || []).map(section).join('')}${next}</div>`;
}

function stats(r, d) {
  const usd = r.spent_usd > 0 || !r.tokens;
  const p = r.budget_usd ? r.spent_usd / r.budget_usd : 0;
  const cs = r.check_state || [];
  const pass = cs.filter((c) => c.ok).length;
  const total = cs.length || r.checks.length + (r.kind === 'hypothesis' ? 3 : 0);
  const now = r.status === 'running' ? r.turns_used + 1 : 0;
  // ponytail: one segment per turn reads well up to about 24; beyond that the turns tile shows a plain bar.
  const segs =
    r.max_turns <= 24
      ? `<div class="segments">${Array.from({ length: r.max_turns }, (_, i) => `<i class="${i < r.turns_used ? 'on' : i + 1 === now ? 'now' : ''}"></i>`).join('')}</div>`
      : `<div class="track turns-bar"><div class="fill" style="width:${Math.min(100, (r.turns_used / r.max_turns) * 100)}%"></div></div>`;
  const cur = r.current_agent || r.agent;
  const est = estimated(d);
  const sized = (d?.turns || []).some((e) => e.type === 'sized');
  const limits = r.auto_limits ? (sized ? ' · sized by the lead' : ' · for a first look') : '';
  const spendTile = usd
    ? `<div class="ring-wrap">${ring(p, 44, 4, p >= 0.85 ? 'warn' : '')}<span class="ring-label">${Math.round(p * 100)}%</span></div>
       <div class="s-body"><div class="s-label">Spend</div><div class="s-value">${est ? '≈' : ''}${money(r.spent_usd)}</div><div class="s-sub" title="${est ? 'Cursor does not report cost; estimated from tokens at its listed prices' : ''}">of ${money(r.budget_usd)}${limits || (est ? ' · estimated' : r.tokens ? ' · ' + tokens(r.tokens) + ' tok' : '')}</div></div>`
    : `<span class="agent-badge codex" style="background:var(--sunken);color:var(--text-2);box-shadow:none">${icon('coins', 18)}</span>
       <div class="s-body"><div class="s-label">Tokens</div><div class="s-value">${tokens(r.tokens)}</div><div class="s-sub">Codex reports tokens, not dollars</div></div>`;
  const checkValue = cs.length ? (pass === total ? 'All pass' : `${total - pass} to go`) : r.ask?.kind === 'checks' ? 'To approve' : total ? 'Not run' : isLive(r) ? 'Proposing' : 'None';
  return `<div class="stats">
    <div class="card stat">${spendTile}</div>
    <div class="card stat"><div class="s-body" style="flex:1"><div class="s-label">Turns</div><div class="s-value">${r.turns_used}<span class="faint" style="font-size:14px;font-weight:500"> / ${r.max_turns}</span></div>${segs}</div></div>
    <div class="card stat"><div class="ring-wrap">${ring(total ? pass / total : 0, 44, 4, total && pass === total ? 'ok' : '')}<span class="ring-label">${cs.length ? `${pass}/${total}` : '–'}</span></div>
      <div class="s-body"><div class="s-label">${r.kind === 'hypothesis' ? 'Proof' : 'Checks'}</div><div class="s-value">${checkValue}</div><div class="s-sub">${r.kind === 'hypothesis' ? 'verdict, re-run, review' : r.autonomous && !r.checks.length ? 'the agent judges done' : 'exit 0 means done'}</div></div></div>
    ${r.team ? teamTile(r) : `<div class="card stat"><span class="agent-badge ${cur}">${agentIcon(cur)}</span>
      <div class="s-body"><div class="s-label">Agent</div><div class="s-value">${agentName(cur)}</div><div class="s-sub">${r.switch_agent ? 'Switches when stuck' : 'Never switches'}</div></div></div>`}
  </div>`;
}

function teamTile(r) {
  const p = r.status === 'running' ? phase(r) : null;
  const m = r.members || [];
  const value = r.phase === 'limit' && p ? 'Paused' : p ? (m.length > 1 ? `${m.length} at work` : m[0]) : 'Lead + roles';
  return `<div class="card stat"><span class="agent-badge team">${icon('users', 18, 2.2)}</span>
    <div class="s-body"><div class="s-label">Team</div><div class="s-value">${esc(value)}</div><div class="s-sub">${p ? p[1] : 'Staffed per round by a lead'}</div></div></div>`;
}

// Spend per team member, summed over the lead, investigators, implementers, attempts and reviews.
function teamCard(r, d) {
  if (!r.team) return '';
  const by = new Map();
  const add = (m, cost, est) => {
    if (!m) return;
    const x = by.get(m.id) || { ...m, usd: 0, calls: 0, est: false };
    Object.assign(x, { usd: x.usd + (cost || 0), calls: x.calls + 1, est: x.est || !!est });
    by.set(m.id, x);
  };
  for (const e of d?.turns || []) {
    if (e.type === 'plan') add(e.lead, e.cost_usd, e.estimated);
    else if (e.type === 'findings' || e.type === 'attempts') e.items.forEach((x) => add(x.member, x.cost_usd, x.estimated));
    else if (e.type === 'turn' && e.role === 'work') add(e.member, e.own_usd, e.estimated);
    else if (e.type === 'review' || e.type === 'proposed') add(e.member, e.cost_usd, e.estimated);
  }
  if (!by.size) return '';
  const rows = [...by.values()].sort((a, b) => b.usd - a.usd);
  const max = Math.max(...rows.map((x) => x.usd), 1e-9);
  return `<div class="card"><div class="card-head">${icon('users', 16)}<h3>Team</h3><span class="hint">${plural(rows.length, 'model')} so far · spend by member</span></div>
    <div class="team-rows">${rows
      .map(
        (x) => `<div class="team-row">${mem(x, false)}<span class="tier-pill ${x.tier}">${x.tier}</span><div class="track"><div class="fill" style="width:${(x.usd / max) * 100}%"></div></div><span class="v">${usd({ cost_usd: x.usd, estimated: x.est })}</span><span class="calls">${plural(x.calls, 'call')}</span></div>`,
      )
      .join('')}</div></div>`;
}

function checksCard(r) {
  const st = new Map((r.check_state || []).map((c) => [c.id, c]));
  const row = (id, label, cmd, title) => {
    const s = st.get(id);
    const status = !s ? 'pending' : s.skipped ? 'skipped' : s.ok ? 'passed' : 'failed';
    const code = !s || s.skipped ? '–' : s.code;
    return `<div class="check-row">${glyph(status)}<span class="cid">${esc(label)}</span><span class="cmd ${title ? '' : 'mono'}" title="${esc(cmd)}">${esc(cmd)}</span><span class="exit ${s && !s.skipped ? (s.ok ? 'ok' : 'bad') : ''}" title="Exit code">${code}</span></div>
      ${s && !s.ok && !s.skipped && s.tail ? `<pre class="check-tail">${esc(s.tail.trim().split('\n').slice(-4).join('\n'))}</pre>` : ''}`;
  };
  let rows = r.checks.map((c) => row(c.id, c.id, c.cmd)).join('');
  if (r.kind === 'hypothesis') rows += Object.entries(BUILT_IN).map(([id, [label, sub]]) => row(id, label, sub, true)).join('');
  if (!rows)
    rows = `<div class="empty-turns">${
      r.status === 'waiting'
        ? 'Waiting for you to approve the proposed checks.'
        : r.autonomous
          ? 'No preset checks — the agent scoped the goal itself and a judge decides when it is done.'
          : isLive(r)
            ? 'The agent is looking around to propose checks.'
            : 'No checks were agreed before the run ended.'
    }</div>`;
  const hint = r.kind === 'hypothesis' ? 'Done when the verdict holds up' : r.autonomous && !r.checks.length ? 'Done when the agent judges the goal met' : 'Done when every command exits 0';
  return `<div class="card"><div class="card-head">${icon('list-checks', 16)}<h3>Checks</h3><span class="hint">${hint}</span></div><div class="check-list">${rows}</div></div>`;
}

function turnCost(t) {
  if (!t.has_usd) return tokens(t.tokens) + ' tok';
  return (t.estimated ? '≈' : '') + money(t.cost_usd);
}

function notes(t) {
  const line = (label, v) => (v ? `<div class="note"><span>${label}</span><p>${esc(v)}</p></div>` : '');
  const ruled = (t.ruled_out || []).length ? `<div class="note"><span>Ruled out</span><p class="ruled">${t.ruled_out.map((x) => `<s>${esc(x)}</s>`).join('')}</p></div>` : '';
  const body = line('Cause', t.cause) + line('Probe', t.probe) + line('Fix', t.fix) + ruled;
  return body ? `<div class="notes">${body}</div>` : '';
}

function turnItem(t, prev) {
  const switched = !t.member && prev && prev.agent !== t.agent;
  const open = state.open.has(t.n);
  const premium = t.member?.tier === 'premium';
  return `<div class="turn"><span class="turn-node">${t.n}</span><div class="turn-card ${t.summary ? 'clickable' : ''} ${open ? 'open' : ''}" ${t.summary ? `data-act="toggle-turn" data-n="${t.n}"` : ''}>
    <div class="turn-top">
      <span class="agent"><span class="agent-dot ${t.agent}"></span>${esc(who(t))}</span>
      ${switched ? `<span class="tag">${icon('repeat', 11)}switched</span>` : ''}
      ${t.role === 'attempts' ? `<span class="tag" title="Won among competing attempts">${icon('git-branch', 11)}best attempt</span>` : ''}
      ${(t.effort === 'xhigh' && t.agent !== 'claude') || premium ? `<span class="tag" title="Stuck or hard work: ${premium ? 'a premium model' : 'more reasoning effort'}${t.model ? ' · ' + esc(t.model) : ''}">${icon('zap', 11)}${premium ? 'premium' : 'thinks harder'}</span>` : ''}
      ${t.check && t.check !== 'none' ? `<span class="tag" title="Failing check this turn worked on">${icon('target', 11)}${esc(t.check)}</span>` : ''}
      <span class="right"><span>${turnCost(t)}</span>${t.duration_ms ? `<span>${icon('clock', 12)}${duration(t.duration_ms)}</span>` : ''}</span>
    </div>
    ${t.ok === false && t.error ? `<div class="turn-error">${icon('alert', 13)}<span>${esc(t.error)}</span></div>` : ''}
    ${notes(t)}
    ${t.summary ? `<div class="turn-summary">${esc(t.summary)}</div>` : ''}
  </div></div>`;
}

function eventItem(e, r) {
  const card = (cls, ic, title, body = '', right = '', tags = '') =>
    `<div class="turn event ${cls}"><span class="turn-node">${icon(ic, 12)}</span><div class="turn-card"><div class="turn-top"><span class="agent">${title}</span>${tags}${right ? `<span class="right"><span>${right}</span></span>` : ''}</div>${body}</div></div>`;
  switch (e.type) {
    case 'proposed':
      if (e.ok === false)
        return card('bad', 'alert', `<span class="agent-dot ${e.agent}"></span>${esc(who(e))} could not propose checks`, `<div class="ev-body">${esc(e.error || 'No reason given; see Logs')}</div>`, usd(e));
      return card('', 'list-checks', `<span class="agent-dot ${e.agent}"></span>${esc(who(e))} proposed ${plural(e.checks.length, 'check')}`,
        `<div class="ev-body mono">${e.checks.map((c) => esc(c.cmd)).join('<br>')}</div>`, usd(e));
    case 'scoped':
      if (e.ok === false)
        return card('bad', 'alert', `<span class="agent-dot ${e.agent}"></span>${esc(who(e))} could not scope the goal`, `<div class="ev-body">${esc(e.error || 'No reason given; see Logs')}</div>`, usd(e));
      return card('', 'target', `<span class="agent-dot ${e.agent}"></span>${esc(who(e))} scoped the goal`,
        `<div class="ev-body">${esc(e.success || e.goal || '')}</div>${e.checks?.length ? `<div class="ev-body mono">${e.checks.map((c) => esc(c.cmd)).join('<br>')}</div>` : ''}`, usd(e));
    case 'judged':
      return card(e.done ? 'ok' : e.worth_continuing === false ? 'muted' : '', e.done ? 'check' : 'eye',
        `<span class="agent-dot ${e.agent}"></span>${esc(who(e))} ${e.done ? 'judged the goal met' : e.worth_continuing === false ? 'judged more work not worth it' : 'checked progress'}`,
        e.reason ? `<div class="ev-body">${esc(e.reason)}</div>` : '', usd(e));
    case 'sized':
      return card('team', 'coins', `${e.lead ? esc(e.lead.label) : 'The lead'} sized this goal at ${money(e.budget_usd)} and ${plural(e.max_turns, 'round')}`,
        (e.estimate && e.estimate.budget_usd > e.budget_usd
          ? `<div class="ev-body">It estimated ${money(e.estimate.budget_usd)}; the run keeps to your limit and offers more if it runs out.</div>`
          : '') + (e.why ? `<div class="ev-body">${esc(e.why)}</div>` : ''));
    case 'limited':
      return card('warn', 'clock', `${esc(agentName(e.agent))} hit its usage limit · carries on at ${esc(when(e.resume_at))}`, e.error ? `<div class="ev-body">${esc(e.error)}</div>` : '');
    case 'failed':
      // A call that errored is not a turn: say why, and the next agent in line takes over.
      return card('bad', 'alert', `<span class="agent-dot ${e.agent}"></span>${esc(who(e))} could not finish its turn`,
        `<div class="ev-body">${esc(e.error || 'No reason given; see Logs')}</div>`, usd(e));
    case 'review':
      return card(e.accept ? 'ok' : 'bad', 'eye',
        `<span class="agent-dot ${e.agent}"></span>${esc(who(e))} ${e.accept ? `accepted the ${r.kind === 'hypothesis' ? 'verdict' : 'change'}` : 'pushed back'}`,
        e.issues?.length ? `<ul class="ev-list">${e.issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '', usd(e));
    case 'plan': {
      const row = (label, html) => `<div class="plan-row"><span>${label}</span><div>${html}</div></div>`;
      const body =
        (e.why ? `<div class="ev-body">${esc(e.why)}</div>` : '') +
        `<div class="plan">${e.investigate?.length ? row('Investigate', e.investigate.map((x) => `<div class="theory">${mem(x.member)}<span>${esc(x.theory)}</span></div>`).join('')) : ''}${row(e.implement.length > 1 ? 'Compete' : 'Implement', `<div class="mems">${e.implement.map(mem).join('')}</div>`)}${row('Review', mem(e.review))}</div>`;
      const tags = `<span class="tag">${esc(e.difficulty)}</span>${e.stuck ? `<span class="tag warn-tag">${icon('repeat', 11)}stuck ×${e.stuck}</span>` : ''}`;
      return card('team', 'users', e.lead ? `${esc(e.lead.label)} staffed round ${e.n}` : `Round ${e.n}`, body, e.lead ? usd(e) : '', tags);
    }
    case 'findings': {
      const body = `<div class="findings">${e.items
        .map((f) => `<div class="finding ${f.verdict}"><span class="verdict-pill">${f.verdict}</span><div class="f-main"><div class="f-top">${mem(f.member)}<span class="f-theory">${esc(f.theory)}</span></div>${f.evidence ? `<p>${esc(f.evidence)}</p>` : ''}</div><span class="f-cost">${usd(f)}</span></div>`)
        .join('')}</div>`;
      return card('team', 'search', `${plural(e.items.length, 'investigator')} reported`, body);
    }
    case 'attempts': {
      const win = e.items.find((x) => x.winner);
      const body = `<div class="attempts">${e.items
        .map((a) => `<div class="attempt ${a.winner ? 'won' : ''}">${a.winner ? icon('check', 13, 2.6) : icon('x', 13, 2.2)}${mem(a.member)}<span class="a-score">${a.ok ? `${a.passed}/${a.total} checks` : 'failed'}</span><span class="a-fix">${esc(a.fix)}</span><span class="f-cost">${usd(a)}</span></div>`)
        .join('')}</div>${e.changed?.length ? `<div class="ev-body faint">Applied to your folder: <span class="mono">${e.changed.map(esc).join(', ')}</span></div>` : ''}`;
      return card(win ? 'ok' : 'team', 'git-branch', win ? `${esc(win.member.label)}’s attempt won and was applied` : `${e.items.length} attempts, none beat the current state`, body);
    }
    case 'extended':
      return card('you', 'coins', `You raised the limits to ${money(e.budget_usd)} and ${plural(e.max_turns, 'turn')}`);
    case 'ask':
      return `<div class="turn event warn"><span class="turn-node">${icon('message', 12)}</span><div class="turn-card"><div class="turn-top"><span class="agent">${e.kind === 'checks' ? 'Asked you to approve checks' : 'Asked you'}</span></div>${e.kind === 'checks' ? '' : `<div class="ev-body">${esc(e.question)}</div>`}</div></div>`;
    case 'replied':
      return `<div class="turn event you"><span class="turn-node">${icon('send', 11)}</span><div class="turn-card"><div class="turn-top"><span class="agent">You ${e.hint ? 'replied' : `approved ${e.checks?.length || 0} check${e.checks?.length === 1 ? '' : 's'}`}</span></div>${e.hint ? `<div class="ev-body">${esc(e.hint)}</div>` : ''}</div></div>`;
    default:
      return '';
  }
}

// A live elapsed counter the global ticker refreshes each second — but only while the daemon is connected, so a
// disconnected app shows "reconnecting…" instead of a timer that runs away on a run that has actually ended.
const liveSince = (start) =>
  state.info.daemon ? `<span data-since="${start}">${duration(Date.now() - start)}</span>` : '<span class="faint">reconnecting…</span>';

// The run's time split into plain-language phases, oldest first. Every loop event now carries an "at" clock, so we
// can show how long proposing checks, your approval, the analysis and the report each took.
function phases(r, d) {
  const evs = d?.turns || [];
  const at = (t) => evs.find((e) => e.type === t)?.at;
  const live = isLive(r);
  const ph = r.phase;
  const waiting = r.status === 'waiting' && r.ask?.kind === 'checks';
  const t0 = r.started_at || r.created_at;
  const end = r.finished_at || Date.now();
  const tAsk = at('ask');
  const tReplied = at('replied');
  const tScoped = at('scoped');
  // The opening phase is either scoping the goal (autonomous) or proposing checks (manual).
  const openEnd = tScoped || tAsk || at('proposed');
  const reportStart = ph === 'report' || r.report ? r.turn_started_at : null;
  const hasWork = turnsOf(d).length > 0;
  const rows = [];
  const add = (label, who, start, stop, current) => start && rows.push({ label, who, start, stop, current });

  if (openEnd && openEnd > t0) add(tScoped ? 'Scoping the goal' : 'Proposing checks', 'agent', t0, openEnd, live && (ph === 'propose' || ph === 'scope'));
  if (tAsk) add('Waiting for you', 'you', tAsk, waiting ? null : tReplied, waiting);
  const workStart = tReplied || openEnd || t0;
  const analyzeCurrent = live && !waiting && ph !== 'propose' && ph !== 'scope' && ph !== 'report';
  if (hasWork || analyzeCurrent || reportStart) {
    const stop = reportStart && reportStart > workStart ? reportStart : analyzeCurrent ? null : end;
    add('Analysing', 'agent', workStart, stop, analyzeCurrent);
  }
  if (reportStart) add('Writing the report', 'agent', reportStart, live && ph === 'report' ? null : end, live && ph === 'report');
  return rows;
}

// A rough, clearly-hedged guess at the time left, from the average turn so far and the turns and budget still free.
function etaLine(r, d) {
  if (r.status === 'queued') return 'Waiting for a free slot';
  if (r.status === 'waiting') return r.ask?.kind === 'checks' ? 'Paused — waiting for your approval' : 'Paused — waiting for your answer';
  if (r.phase === 'limit') return 'Paused for a usage limit';
  if (r.phase === 'scope') return 'Figuring out the goal…';
  if (r.phase === 'report') return 'Finishing the report';
  const done = turnsOf(d).filter((t) => t.duration_ms);
  if (!done.length) return 'Estimating…';
  const avg = done.reduce((s, t) => s + t.duration_ms, 0) / done.length;
  const perCost = r.spent_usd > 0 ? r.spent_usd / Math.max(1, r.turns_used) : 0;
  const byBudget = perCost ? Math.floor((r.budget_usd - r.spent_usd) / perCost) : Infinity;
  const remaining = Math.max(0, Math.min(r.max_turns - r.turns_used, byBudget));
  return remaining ? `Est. up to ${duration(avg * remaining)} left · usually sooner` : 'Wrapping up';
}

// Where the time has gone, and roughly what is left: the fix for a run that merely looks stuck.
function progress(r, d) {
  const rows = phases(r, d);
  if (!rows.length) return '';
  const chip = (p) =>
    `<div class="ph ${p.current ? 'now' : 'done'}${p.who === 'you' ? ' you' : ''}">
      <span class="ph-ic">${p.current ? '<i class="ph-pulse"></i>' : icon('check', 11, 3)}</span>
      <span class="ph-text"><span class="ph-label">${esc(p.label)}</span><span class="ph-time">${p.current ? liveSince(p.start) : duration((p.stop || Date.now()) - p.start)}</span></span>
    </div>`;
  const head = isLive(r) ? etaLine(r, d) : `took ${duration((r.finished_at || Date.now()) - (r.started_at || r.created_at))} in total`;
  return `<div class="card progress">
    <div class="card-head">${icon('clock', 16)}<h3>Timeline</h3><span class="hint">${esc(head)}</span></div>
    <div class="ph-strip">${rows.map(chip).join('')}</div>
  </div>`;
}

function timeline(r, d) {
  const events = d?.turns || [];
  const cur = r.current_agent || r.agent;
  const p = phase(r);
  const limit = r.phase === 'limit';
  const m = r.members || [];
  const label = limit || !p ? agentName(cur) : m.length > 3 ? plural(m.length, 'agent') : m.join(' · ');
  const doing = limit
    ? 'Waiting for its usage limit to lift…'
    : p
    ? p[0]
    : r.phase === 'report'
      ? 'Writing up the results…'
      : r.phase === 'scope'
        ? 'Figuring out the goal and what “done” looks like…'
        : r.phase === 'judge'
          ? 'Checking if the result is good enough…'
          : r.check_state?.length
            ? 'Reproducing, probing, fixing…'
            : 'Looking around…';
  const clock = limit
    ? `resumes in <span data-until="${r.resume_at}">${duration(r.resume_at - Date.now())}</span>`
    : liveSince(r.turn_started_at || r.started_at);
  const working =
    r.status === 'running'
      ? `<div class="turn now"><span class="turn-node">${r.turns_used + 1}</span><div class="turn-card"><div class="turn-top">
          <span class="agent"><span class="agent-dot ${cur}"></span>${esc(label)}</span>
          <span class="turn-working"><span class="shimmer">${esc(doing)}</span></span>
          <span class="right"><span>${icon('clock', 12)}${clock}</span></span>
        </div></div></div>`
      : '';
  let prev = null;
  const items = events
    .map((e) => {
      if (e.type && e.type !== 'turn') return eventItem(e, r);
      const html = turnItem(e, prev);
      prev = e;
      return html;
    })
    .reverse()
    .join('');
  const n = turnsOf(d).length;
  const body = working || items ? `<div class="timeline">${working}${items}</div>` : `<div class="empty-turns">${r.status === 'queued' ? 'Starts when a slot frees up.' : 'No turns yet.'}</div>`;
  return `<div class="card"><div class="card-head">${icon('repeat', 16)}<h3>Turns</h3><span class="hint">${n ? `${n} done · newest first` : ''}</span></div>${body}</div>`;
}

function ledgerCard(d) {
  const last = turnsOf(d).at(-1);
  if (!last?.ledger_json_bytes) return '';
  const toon = last.ledger_toon_bytes;
  const json = last.ledger_json_bytes;
  const max = Math.max(toon, json, 1);
  const saved = Math.max(0, Math.round((1 - toon / json) * 100));
  return `<div class="card"><div class="card-head">${icon('layers', 16)}<h3>Context per turn</h3><span class="hint">Each turn is a fresh agent; this is everything it is sent</span>
      <div class="right"><span class="pill accent">${saved}% smaller with TOON</span></div></div>
    <div class="ledger">
      <div class="bars">
        <span class="muted">TOON</span><div class="track"><div class="fill toon" style="width:${(toon / max) * 100}%"></div></div><span class="v">${bytes(toon)}</span>
        <span class="muted">JSON</span><div class="track"><div class="fill" style="width:${(json / max) * 100}%"></div></div><span class="v">${bytes(json)}</span>
      </div>
      <div class="faint" style="font-size:12px;margin-top:10px">Last prompt was ${bytes(last.prompt_bytes)}: the goal, what each turn tried and ruled out, your notes, and the tail of the failing output.</div>
      ${d.ledger_toon ? `<details><summary>${icon('chevron-right', 13)}Ledger as sent</summary><pre class="raw">${esc(d.ledger_toon)}</pre></details>` : ''}
    </div></div>`;
}

// Every agent call with its raw output and error, plus the loop's own stderr. Loaded only while open.
function logsCard(r) {
  const logs = state.logs.get(r.id);
  const id = esc(r.id);
  const head = `<div class="card-head">${icon('file-text', 16)}<h3>Logs</h3><span class="hint">${logs ? `${plural(logs.calls.length, 'agent call')} · newest first` : 'every agent call, its output and errors'}</span>
    <div class="right">${logs ? `<button class="btn ghost sm" data-act="reveal" data-path="${esc(logs.dir)}">${icon('folder', 13)}Run folder</button>` : ''}<button class="btn ghost sm" data-act="logs" data-id="${id}">${icon(logs ? 'chevron-down' : 'chevron-right', 13)}${logs ? 'Hide' : 'Show'}</button></div></div>`;
  if (!logs) return `<div class="card">${head}</div>`;
  const calls = [...logs.calls]
    .reverse()
    .map((c) => {
      const name = c.label || [agentName(c.agent), c.model].filter(Boolean).join(' ');
      const meta = [c.role, c.model && c.label ? c.model : '', c.effort].filter(Boolean).join(' · ');
      return `<div class="log-call ${c.ok ? '' : 'bad'}">
        <div class="log-top">${glyph(c.ok ? 'passed' : 'failed')}<span class="agent"><span class="agent-dot ${esc(c.agent)}"></span>${esc(name)}</span><span class="faint">${esc(meta)}</span>
          <span class="right"><span>${c.at ? new Date(c.at).toLocaleTimeString() : ''}</span><span>${usd(c)}</span>${c.duration_ms ? `<span>${duration(c.duration_ms)}</span>` : ''}</span></div>
        ${c.error ? `<pre class="log-out err">${esc(c.error)}</pre>` : ''}
        ${c.output && c.output !== c.error ? `<pre class="log-out">${esc(c.output)}</pre>` : ''}
      </div>`;
    })
    .join('');
  const loop = logs.loop_log.trim() ? `<details class="log-loop"><summary>${icon('chevron-right', 13)}Loop log</summary><pre class="log-out">${esc(logs.loop_log)}</pre></details>` : '';
  return `<div class="card">${head}<div class="logs">${calls || '<div class="empty-turns">No agent calls yet.</div>'}${loop}</div></div>`;
}

function editorButton(r) {
  const installed = state.editors.filter((e) => e.found);
  const def = installed.find((e) => e.id === state.settings.editor) || installed[0];
  if (!def) return `<button class="btn sm" data-act="settings" data-tab="editor">${icon('code', 14)}Get an editor</button>`;
  return `<div class="split"><button class="btn sm" data-act="open-editor" data-editor="${esc(def.id)}" data-path="${esc(r.workspace)}">${icon('external-link', 13)}Open in ${esc(def.name.replace('Visual Studio Code', 'VS Code'))}</button><button class="btn sm" data-act="editor-menu" data-path="${esc(r.workspace)}" aria-label="Choose editor">${icon('chevron-down', 13)}</button></div>`;
}

export function runHTML(id) {
  const r = state.runs.get(id);
  if (!r) return `<header class="topbar" data-tauri-drag-region></header><div class="content"><div class="empty-turns">This run no longer exists.</div></div>`;
  const d = state.details.get(id);
  const st = STATUS[r.status] || STATUS.stopped;
  const live = isLive(r);
  return `
    <header class="topbar" data-tauri-drag-region>
      <span class="tb-crumb">${runGlyph(r)}<span>${esc(baseName(r.workspace))}</span></span>
      <span class="spacer" data-tauri-drag-region></span>
      ${editorButton(r)}
      ${live ? `<button class="btn sm danger" data-act="stop" data-id="${esc(r.id)}">${icon('stop', 13)}Stop</button>` : `<button class="btn sm soft" data-act="rerun" data-id="${esc(r.id)}">${icon('rotate-ccw', 13)}Run again</button>`}
      <button class="btn sm icon ghost" data-act="run-more" data-id="${esc(r.id)}" aria-label="More">${icon('more', 16)}</button>
    </header>
    <div class="content"><div class="content-inner enter">
      ${banner(r, d)}
      <h1 class="run-title">${esc(r.intent)}</h1>
      <div class="run-meta">
        <span class="pill ${st.cls}"><span class="dot"></span>${st.label}</span>
        ${r.kind === 'hypothesis' ? `<span class="pill">${icon('flask', 12)}Hypothesis</span>` : r.kind === 'research' ? `<span class="pill">${icon('file-text', 12)}Research</span>` : ''}
        ${r.allow_network ? `<span class="pill" title="The agent may reach databases, APIs and the internet">${icon('globe', 12)}Network on</span>` : ''}
        ${r.autonomous ? `<span class="pill" title="The agent scoped the goal itself and decides when to stop">${icon('sparkles', 12)}Autonomous</span>` : ''}
        <button class="path-chip" data-act="reveal" data-path="${esc(r.workspace)}" title="Show in file manager">${icon('folder', 12)}<span>${esc(shortPath(r.workspace))}</span></button>
        <span class="faint">Started ${relTime(r.started_at || r.created_at)}</span>
      </div>
      ${r.kind === 'hypothesis' && !r.verdict ? `<div class="hyp-line">${icon('flask', 14)}<span>${esc(r.hypothesis)}</span></div>` : ''}
      ${r.success ? `<div class="hyp-line">${icon('target', 14)}<span><b>Done when:</b> ${esc(r.success)}</span></div>` : ''}
      ${verdictCard(r)}
      ${stats(r, d)}
      ${progress(r, d)}
      ${reportCard(r)}
      <div class="two-col">${checksCard(r)}${timeline(r, d)}${teamCard(r, d)}${ledgerCard(d)}${logsCard(r)}</div>
    </div></div>`;
}

async function reply(id, checks, hint) {
  try {
    const run = await api.replyRun(id, checks, hint);
    state.approvals.delete(id);
    state.replies.delete(id);
    if (run) state.runs.set(id, run);
    ui.renderSidebar();
    ui.renderMain();
  } catch (e) {
    toast(String(e), 'bad');
  }
}

export const actions = {
  async stop(el) {
    try {
      await api.stopRun(el.dataset.id);
    } catch (e) {
      toast(String(e), 'bad');
    }
  },
  async rerun(el) {
    const r = state.runs.get(el.dataset.id);
    if (!r) return;
    const { intent, workspace, kind, hypothesis, agent, team, auto_limits, autonomous, switch_agent, allow_network } = r;
    // A sized run starts again with the default limits as its ceiling, and its lead sizes it afresh.
    const budget_usd = auto_limits ? state.settings.default_budget : r.budget_usd;
    const max_turns = auto_limits ? state.settings.default_turns : r.max_turns;
    // An autonomous run had no checks of its own (the ones shown were inferred), so it scopes the goal afresh.
    const checks = autonomous ? [] : r.checks;
    try {
      const run = await api.startRun({ intent, workspace, kind, hypothesis, agent, team, auto_limits, autonomous, budget_usd, max_turns, switch_agent, allow_network, checks });
      state.runs.set(run.id, run);
      ui.select(run.id);
    } catch (e) {
      toast(String(e), 'bad');
    }
  },
  approve(el) {
    const checks = (state.approvals.get(el.dataset.id) || []).filter((c) => c.cmd.trim()).map(({ id, cmd, why }) => ({ id: id.trim(), cmd: cmd.trim(), why }));
    if (!checks.length) return toast('Keep at least one check', 'bad');
    reply(el.dataset.id, checks, '');
  },
  'send-reply'(el) {
    const text = (state.replies.get(el.dataset.id) || '').trim();
    if (!text) return toast('Write a reply for the agent', 'bad');
    reply(el.dataset.id, null, text);
  },
  async extend(el) {
    const id = el.dataset.id;
    const x = state.extends.get(id);
    if (!x || !(x.budget > 0) || !(x.turns > 0)) return toast('Enter a budget and max turns', 'bad');
    try {
      const run = await api.extendRun(id, x.budget, x.turns);
      state.extends.delete(id);
      if (run) state.runs.set(id, run);
      ui.renderSidebar();
      ui.renderMain();
    } catch (e) {
      toast(String(e), 'bad');
    }
  },
  'appr-add'(el) {
    state.approvals.get(el.dataset.id)?.push({ id: `check-${state.approvals.get(el.dataset.id).length + 1}`, cmd: '' });
    ui.renderMain();
  },
  'appr-rm'(el) {
    state.approvals.get(el.dataset.id)?.splice(+el.dataset.i, 1);
    ui.renderMain();
  },
  'run-more': (el) => runMenu(el, el.dataset.id),
  async logs(el) {
    const id = el.dataset.id;
    if (state.logs.has(id)) state.logs.delete(id);
    else {
      try {
        state.logs.set(id, await api.runLogs(id));
      } catch (e) {
        return toast(String(e), 'bad');
      }
    }
    ui.renderMain();
  },
  'toggle-turn'(el, e) {
    if (e?.target.closest('.notes')) return;
    const n = +el.dataset.n;
    state.open.has(n) ? state.open.delete(n) : state.open.add(n);
    el.classList.toggle('open');
  },
  reveal: (el) => api.reveal(el.dataset.path),
  async 'open-editor'(el) {
    try {
      await api.openEditor(el.dataset.editor, el.dataset.path);
    } catch (e) {
      toast(String(e), 'bad');
    }
  },
  'editor-menu'(el) {
    const path = el.dataset.path;
    const items = state.editors
      .filter((e) => e.found)
      .map((e) => ({ label: e.name, hint: e.id === state.settings.editor ? 'Default' : '', action: () => api.openEditor(e.id, path).catch((x) => toast(String(x), 'bad')) }));
    menu(el, [...items, 'sep', { label: 'Install another editor…', icon: 'download', action: () => ui.openSettings('editor') }]);
  },
};

export const binds = {
  reply: (el) => state.replies.set(el.dataset.id, el.value),
  'ext-budget'(el) {
    const x = state.extends.get(el.dataset.id);
    if (x) x.budget = parseFloat(el.value);
  },
  'ext-turns'(el) {
    const x = state.extends.get(el.dataset.id);
    if (x) x.turns = parseInt(el.value, 10);
  },
  'appr-id'(el) {
    const c = state.approvals.get(el.dataset.id)?.[+el.dataset.i];
    if (c) c.id = el.value;
  },
  'appr-cmd'(el) {
    const c = state.approvals.get(el.dataset.id)?.[+el.dataset.i];
    if (c) c.cmd = el.value;
  },
};
