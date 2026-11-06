// Browser-only stand-in for the Tauri backend, so the UI can be previewed and screenshotted
// with `python3 -m http.server -d app/ui`. Query params: theme, accent, view, tab.
const q = new URLSearchParams(location.search);
const now = Date.now();
const M = 60e3;
const H = 60 * M;
const D = 24 * H;
const home = '/Users/you';

const meta = (o) => ({
  kind: 'code',
  hypothesis: '',
  switch_agent: true,
  allow_network: false,
  reason: '',
  error: '',
  tokens: 0,
  check_state: [],
  current_agent: o.agent,
  started_at: o.created_at,
  finished_at: 0,
  dir: `${home}/Library/Application Support/Iteraxa/runs/${o.id}`,
  ...o,
});

const ok = (...ids) => ids.map((id) => ({ id, code: 0, ok: true }));
const weekly = 'You’ve hit your weekly limit · resets 7:30am (Europe/Lisbon)';
const resets = (() => {
  const d = new Date();
  d.setHours(7, 31, 0, 0);
  if (d < new Date()) d.setDate(d.getDate() + 1);
  return d.getTime();
})();

const runs = [
  meta({
    id: 'r13', kind: 'research', intent: 'Compare three static site generators for the blog and recommend one.', workspace: `${home}/research/blog-tools`,
    agent: 'claude', team: true, auto_limits: true, allow_network: true, budget_usd: 2, max_turns: 8, status: 'running', spent_usd: 0, turns_used: 0,
    created_at: now - 4 * M, turn_started_at: now - 3 * M, checks: [], current_agent: 'claude', phase: 'limit', resume_at: resets, error: weekly,
  }),
  meta({
    id: 'r11', intent: 'The thumbnail tests fail since the Pillow upgrade. Make transparent PNGs resize correctly again.', workspace: `${home}/code/thumbnailer`, agent: 'claude', team: true,
    auto_limits: true, budget_usd: 3, max_turns: 6, status: 'running', spent_usd: 0.41, turns_used: 2, created_at: now - 12 * M, turn_started_at: now - 23e3,
    current_agent: 'cursor', phase: 'review', members: ['Grok 4.6 high'],
    checks: [{ id: 'thumbs', cmd: 'python -m thumbnailer samples/ --check' }, { id: 'tests', cmd: 'pytest -q tests/test_resize.py' }],
    check_state: ok('thumbs', 'tests'),
  }),
  meta({
    id: 'r14', kind: 'research', intent: 'Figure out why the test suite got three times slower this month and suggest fixes.', workspace: `${home}/code/notes-app`,
    agent: 'claude', autonomous: true, budget_usd: 3, max_turns: 8, status: 'passed', reason: 'goal_met', spent_usd: 0.46, tokens: 31200, turns_used: 2,
    created_at: now - 22 * M, started_at: now - 22 * M, finished_at: now - 13 * M, turn_started_at: now - 18 * M, checks: [],
    success: 'A short write-up names what made the suite slower, with timings, and two or three concrete fixes.',
  }),
  meta({
    id: 'r15', kind: 'code', intent: 'Clean up the logging in this service so it is consistent and useful.', workspace: `${home}/code/photo-sync`,
    agent: 'cursor', team: true, autonomous: true, budget_usd: 2, max_turns: 8, status: 'passed', reason: 'good_enough',
    stop_reason: 'The logs are consistent and structured; further passes would only reword messages.',
    spent_usd: 0.58, tokens: 40100, turns_used: 2, created_at: now - 40 * M, started_at: now - 40 * M, finished_at: now - 28 * M, turn_started_at: now - 31 * M, checks: [],
    success: 'All modules use the structured logger at sensible levels, with no stray prints.',
  }),
  meta({
    id: 'r9', intent: 'The weather CLI fails with 401 from the forecast API. Make it print a forecast again.', workspace: `${home}/code/weather-cli`, agent: 'cursor', current_agent: 'claude',
    allow_network: true, budget_usd: 2, max_turns: 10, status: 'waiting', spent_usd: 0.27, turns_used: 3, created_at: now - 9 * M,
    checks: [{ id: 'forecast', cmd: 'python -m weather --city Lisbon | grep -q "°C"' }, { id: 'tests', cmd: 'pytest -q' }],
    check_state: [
      { id: 'forecast', code: 1, ok: false, tail: 'Error: the forecast API answered 401 Unauthorized\n{"error": "key expired"}' },
      { id: 'tests', code: 0, ok: true },
    ],
    ask: { kind: 'hint', question: 'The forecast API says the key in .env expired. Is there a new key I should use, or should I switch to the free tier, which needs no key?', checks: [] },
  }),
  meta({
    id: 'r8', intent: 'Make the nightly photo backup skip photos that have not changed', workspace: `${home}/code/photo-backup`, agent: 'claude',
    budget_usd: 2, max_turns: 8, status: 'waiting', spent_usd: 0.06, turns_used: 0, created_at: now - 3 * M, checks: [],
    ask: {
      kind: 'checks',
      question: 'No checks were given, so Claude looked around the folder and proposed these. Edit them, then approve.',
      checks: [
        { id: 'dry-run', cmd: 'python backup.py --dry-run --since yesterday', why: 'The backup finishes without an error' },
        { id: 'skips-unchanged', cmd: "python3 - <<'PY'\nfrom backup import plan\nassert plan('samples/unchanged') == [], 'unchanged photos would be copied again'\nPY", why: 'Nothing is copied when no photo changed' },
        { id: 'tests', cmd: 'pytest -q tests/backup', why: 'Existing backup tests keep passing' },
      ],
    },
  }),
  meta({
    id: 'r7', intent: 'Fix the flaky auth tests in the session middleware', workspace: `${home}/code/notes-app`, agent: 'claude',
    budget_usd: 2, max_turns: 8, status: 'running', spent_usd: 0.38, turns_used: 2, created_at: now - 7 * M, turn_started_at: now - 74e3,
    checks: [{ id: 'tests', cmd: 'pytest -q tests/auth' }, { id: 'lint', cmd: 'ruff check .' }, { id: 'types', cmd: 'mypy src/session' }],
    check_state: [{ id: 'tests', code: 1, ok: false, tail: 'FAILED tests/auth/test_refresh.py::test_concurrent_refresh - AssertionError: 401 != 200' }, ...ok('lint', 'types')],
  }),
  meta({
    id: 'r6', intent: 'Raise parser test coverage to 90%', workspace: `${home}/code/toon-rs`, agent: 'codex',
    budget_usd: 1.5, max_turns: 6, status: 'running', spent_usd: 0, tokens: 18400, turns_used: 0, created_at: now - 2 * M, turn_started_at: now - 41e3,
    checks: [{ id: 'coverage', cmd: 'cargo llvm-cov --fail-under-lines 90' }],
  }),
  meta({
    id: 'r10', kind: 'hypothesis', intent: 'Do rainy days really have fewer bike rentals?', workspace: `${home}/research/bike-rides`, agent: 'cursor',
    hypothesis: 'Days with rain have fewer bike rentals than dry days',
    budget_usd: 2, max_turns: 8, status: 'passed', reason: 'checks_passed', spent_usd: 0.17, turns_used: 2,
    created_at: now - 50 * M, finished_at: now - 41 * M, checks: [], check_state: ok('verdict', 'reproduce', 'review'),
    verdict: {
      hypothesis: 'Days with rain have fewer bike rentals than dry days',
      method: 'One-sided Welch t-test on daily rentals, rainy days against clear days',
      threshold: 'p < 0.05 and at least 10% fewer rentals',
      results: { mean_clear: 4877, mean_rainy: 1803, drop_pct: 63.0, t: 11.2, p_value: 0.000002, n_days: 731 },
      verdict: 'supported',
      evidence: 'Rainy days averaged 1,803 rentals against 4,877 on clear days, 63% fewer. Misty days are reported separately, and the drop holds in both years of data.',
      reproduce: 'python analysis.py --seed 7',
    },
  }),
  meta({
    id: 'r5', intent: 'Add OpenAPI docs for the bookmarks endpoints', workspace: `${home}/code/bookmarks-api`, agent: 'claude',
    budget_usd: 1, max_turns: 6, status: 'queued', spent_usd: 0, turns_used: 0, created_at: now - 1 * M, started_at: 0,
    checks: [{ id: 'spec', cmd: 'npx @redocly/cli lint openapi.yaml' }],
  }),
  meta({
    id: 'r4', intent: 'Benchmark the TOON parser against serde_json and report throughput', workspace: `${home}/code/toon-bench`, agent: 'codex', kind: 'research',
    budget_usd: 1.5, max_turns: 6, status: 'passed', reason: 'checks_passed', spent_usd: 0, tokens: 48210, turns_used: 2,
    created_at: now - 2 * H, finished_at: now - 2 * H + 7 * M + 12e3,
    checks: [{ id: 'report', cmd: 'test -s results.md' }, { id: 'bench', cmd: 'cargo bench --no-run' }], check_state: ok('report', 'bench'),
    report_path: `${home}/code/toon-bench/.iteraxa/report.html`,
    report: {
      title: 'TOON decodes uniform tables about 1.8× faster than JSON',
      outcome: 'For uniform tabular data, TOON is both faster to decode and smaller on the wire than serde_json.',
      summary: 'Across 1k, 10k and 100k row tables the TOON decoder beat serde_json at every size, and the gap widened as rows grew. The encoded payloads were consistently smaller too.',
      sections: [
        { heading: 'Key findings', items: [
          { title: '1.8× faster decode at 10k rows', detail: 'TOON decoded a 10,000-row table in 0.41 ms against 0.74 ms for serde_json.' },
          { title: '41% smaller payload', detail: 'The same table serialised to 58 KB in TOON versus 98 KB as JSON.' },
        ] },
      ],
      next_steps: ['Benchmark nested and non-uniform data, where the advantage is expected to shrink.'],
    },
  }),
  meta({
    id: 'r3', intent: 'Port the config loader CLI to Go', workspace: `${home}/code/cfgtool`, agent: 'claude', current_agent: 'codex',
    budget_usd: 1.5, max_turns: 10, status: 'failed', reason: 'budget', spent_usd: 1.5, tokens: 9300, turns_used: 4,
    created_at: now - D - 3 * H, finished_at: now - D - 2 * H,
    checks: [{ id: 'build', cmd: 'go build ./...' }, { id: 'tests', cmd: 'go test ./...' }],
    check_state: [...ok('build'), { id: 'tests', code: 1, ok: false, tail: '--- FAIL: TestMergeOrder (0.00s)\n    merge_test.go:41: got [b a c], want [a b c]' }],
  }),
  meta({
    id: 'r12', intent: 'Get the recipe search endpoint under 150 ms at p95', workspace: `${home}/code/recipes`, agent: 'claude', team: true,
    budget_usd: 3, max_turns: 8, status: 'passed', reason: 'checks_passed', spent_usd: 0.83, turns_used: 3,
    created_at: now - D - 6 * H, finished_at: now - D - 6 * H + 19 * M,
    checks: [{ id: 'p95', cmd: 'node bench/search.js --p95-under 150' }, { id: 'tests', cmd: 'npm test -- search' }], check_state: ok('p95', 'tests'),
    report_path: `${home}/code/recipes/.iteraxa/report.html`,
    report: {
      title: 'Search p95 cut from 410 ms to 128 ms',
      outcome: 'The recipe search endpoint now responds in 128 ms at p95, under the 150 ms target.',
      summary: 'The endpoint was running one database query per result to load its tags, so a page of results meant dozens of round-trips. Batching those into a single query, plus an index on the lookup column, brought p95 from 410 ms to 128 ms with no change to the response.',
      sections: [
        { heading: 'What was slow', items: [
          { title: 'N+1 query on tag lookup', severity: 'high', detail: 'Each search result triggered its own tag query, so a 40-result page issued 41 queries.',
            steps: ['Call GET /search?q=pasta', 'Watch the query log: one search query followed by one tag query per row'] },
          { title: 'Missing index on recipe_tags.recipe_id', severity: 'medium', detail: 'The tag join did a full scan because the foreign key had no index.' },
        ] },
        { heading: 'What changed', body: 'Tags are now loaded for the whole page in one batched query, and an index was added on recipe_tags.recipe_id.' },
      ],
      next_steps: ['Add a p95 budget to CI so a regression is caught before release.'],
    },
  }),
  meta({
    id: 'r2', kind: 'research', intent: 'Literature review: how teams evaluate retrieval-augmented generation', workspace: `${home}/research/rag-eval`, agent: 'claude',
    budget_usd: 2, max_turns: 6, status: 'passed', reason: 'checks_passed', spent_usd: 0.64, turns_used: 3,
    created_at: now - 3 * D, finished_at: now - 3 * D + 11 * M,
    checks: [{ id: 'findings', cmd: 'test -s findings.md' }, { id: 'sources', cmd: 'test $(grep -c "https\\?://" findings.md) -ge 5' }], check_state: ok('findings', 'sources'),
  }),
  meta({
    id: 'r1', intent: 'Upgrade the dashboard to React 19', workspace: `${home}/code/dashboard`, agent: 'claude',
    budget_usd: 4, max_turns: 12, status: 'stopped', reason: 'stopped', spent_usd: 0.21, turns_used: 1,
    created_at: now - 9 * D, finished_at: now - 9 * D + 4 * M,
    checks: [{ id: 'build', cmd: 'npm run build' }], check_state: [{ id: 'build', code: 1, ok: false }],
  }),
];

const turn = (n, agent, check, cost, secs, note, extra = {}) => ({
  type: 'turn', n, agent, check, cost_usd: cost, tokens: 0, has_usd: true, estimated: agent !== 'claude', effort: '',
  model: agent === 'cursor' ? 'grok-4.6-high' : '', hash: (n * 2654435761).toString(16).slice(0, 12), duration_ms: secs * 1000,
  cause: '', probe: '', fix: '', ruled_out: [], summary: '', ...note,
  prompt_bytes: 1180 + n * 96, ledger_toon_bytes: 60 + n * 70, ledger_json_bytes: 120 + n * 150, ...extra,
  ...(extra.has_usd === false ? { estimated: false } : {}),
});

const ledger = (events) => {
  const turns = events.filter((t) => t.type === 'turn');
  const cell = (s) => (s || '').replace(/[|\n]/g, ' ').slice(0, 60);
  const ruled = [...new Set(turns.flatMap((t) => t.ruled_out))];
  return (
    `turns[${turns.length}|]{n|agent|check|cause|fix}:\n` +
    turns.map((t) => `  ${t.n}|${t.agent}|${t.check}|${cell(t.cause)}|${cell(t.fix)}`).join('\n') +
    (ruled.length ? `\nruled_out[${ruled.length}|]: ${ruled.join('|')}` : '')
  );
};

const byId = (id) => runs.find((r) => r.id === id);
const member = (id, label, agent, tier) => ({ id, label, agent, tier });
const T = {
  haiku: member('claude-haiku', 'Claude Haiku', 'claude', 'fast'),
  sonnet: member('claude-sonnet', 'Claude Sonnet', 'claude', 'strong'),
  opus: member('claude-opus', 'Claude Opus', 'claude', 'premium'),
  luna: member('codex-luna', 'Codex Luna', 'codex', 'fast'),
  sol: member('codex-sol', 'Codex Sol', 'codex', 'strong'),
  grok: member('grok-high', 'Grok 4.6 high', 'cursor', 'strong'),
};
const plan = (n, o) => ({ type: 'plan', n, lead: T.haiku, difficulty: 'medium', why: '', stuck: 0, investigate: [], cost_usd: 0.01, ...o });
const teamTurn = (n, m, check, own, round, secs, note, extra = {}) =>
  turn(n, m.agent, check, round, secs, note, { member: m, role: 'work', own_usd: own, estimated: m.agent !== 'claude', model: m.agent === 'cursor' ? 'grok-4.6-high' : '', ...extra });

const details = {
  r11: [
    plan(1, {
      why: 'Tests broke right after a Pillow upgrade: the image mode, the resampling filter or the save options could each explain it.',
      investigate: [
        { theory: 'Pillow 11 opens palette PNGs in a mode resize() rejects', member: T.haiku },
        { theory: 'The LANCZOS constant moved and the old name now fails', member: T.luna },
        { theory: 'save() drops the alpha channel unless optimize is off', member: T.grok },
      ],
      implement: [T.sonnet], review: T.grok, estimate: { budget_usd: 3, max_turns: 6 },
    }),
    { type: 'sized', budget_usd: 3, max_turns: 6, lead: T.haiku, why: 'Likely one or two causes behind the upgrade; a few rounds of mostly fast and strong models.' },
    { type: 'findings', n: 1, items: [
      { theory: 'Pillow 11 opens palette PNGs in a mode resize() rejects', member: T.haiku, verdict: 'confirmed', ok: true, evidence: 'Image.open("samples/logo.png").mode → PA; resize() → ValueError: image has wrong mode', fix: 'Convert PA and P images to RGBA before resizing', cost_usd: 0.01 },
      { theory: 'The LANCZOS constant moved and the old name now fails', member: T.luna, verdict: 'refuted', ok: true, evidence: 'Image.Resampling.LANCZOS exists and resize() accepts it', fix: '', cost_usd: 0.004, estimated: true },
      { theory: 'save() drops the alpha channel unless optimize is off', member: T.grok, verdict: 'refuted', ok: true, evidence: 'Saved an RGBA test image with optimize on and off: alpha survives both', fix: '', cost_usd: 0.03, estimated: true },
    ] },
    teamTurn(1, T.sonnet, 'thumbs', 0.12, 0.17, 63, {
      cause: 'Pillow 11 opens palette PNGs in mode PA, and resize() raises “image has wrong mode”.',
      probe: 'Investigator reproduced the error on samples/logo.png.',
      fix: 'Convert PA and P images to RGBA before resizing.',
      ruled_out: ['The LANCZOS constant moved (refuted by Codex Luna)', 'save() drops the alpha channel (refuted by Grok 4.6 high)'],
    }),
    plan(2, { difficulty: 'easy', why: 'Resizing works now; one test still compares against thumbnails made with the old resampling.', implement: [T.sol], review: T.grok, cost_usd: 0.004 }),
    teamTurn(2, T.sol, 'tests', 0.19, 0.2, 88, {
      cause: 'The expected thumbnails were made with the old resampling, so a few pixels differ by one or two levels.',
      probe: 'ImageChops.difference on the failing pair → max delta 2.',
      fix: 'Regenerated the expected thumbnails with the new resampling and added a test for transparent PNGs.',
    }, { estimated: true }),
  ],
  r12: [
    plan(1, { why: 'Profile first; the slow part is probably the query, not the handler.', implement: [T.sonnet], review: T.sol }),
    teamTurn(1, T.sonnet, 'p95', 0.18, 0.19, 94, {
      cause: 'Search runs a wildcard LIKE over every recipe title.', probe: 'EXPLAIN shows a full scan over 120k rows.', fix: 'Added a trigram index on the title.',
    }),
    plan(2, { difficulty: 'medium', why: 'The index helped but p95 is still 210 ms; try competing approaches.', stuck: 1, implement: [T.sonnet, T.sol, T.grok], review: T.opus, cost_usd: 0.01 }),
    { type: 'attempts', n: 2, merged: true, changed: ['src/search/query.js', 'src/search/cache.js'], items: [
      { member: T.sonnet, ok: true, winner: false, passed: 1, total: 2, fix: 'Selected only the fields the list shows', cost_usd: 0.11 },
      { member: T.sol, ok: true, winner: true, passed: 2, total: 2, fix: 'Cached tag counts for 60 s and selected fewer fields', cost_usd: 0.14, estimated: true },
      { member: T.grok, ok: true, winner: false, passed: 1, total: 2, fix: 'Paginated with a cursor instead of OFFSET', cost_usd: 0.09, estimated: true },
    ] },
    teamTurn(2, T.sol, 'p95', 0, 0.35, 141, {
      cause: 'Tag counts are recomputed on every request.', probe: 'Timing per stage: tag counts 120 ms of 210 ms.', fix: 'Cached tag counts for 60 s and selected only the listed fields. p95 now 118 ms.',
    }, { role: 'attempts', own_usd: 0 }),
    { type: 'review', agent: 'claude', member: T.opus, accept: false, cost_usd: 0.06, issues: ['The tag-count cache never invalidates when a recipe is added; counts can be a minute stale.'] },
    plan(3, { difficulty: 'easy', implement: [T.sol], review: T.opus, cost_usd: 0.003 }),
    teamTurn(3, T.sol, 'review', 0.05, 0.06, 47, { cause: 'Reviewer: stale tag counts after writes.', fix: 'Invalidate the tag-count cache on recipe create, update and delete.' }, { estimated: true }),
    { type: 'review', agent: 'claude', member: T.opus, accept: true, cost_usd: 0.05, issues: [] },
  ],
  r14: [
    { type: 'scoped', agent: 'claude', goal: 'Explain why the test suite slowed down and recommend fixes', success: 'A short write-up names what made the suite slower, with timings, and two or three concrete fixes.', checks: [], confidence: 'high', cost_usd: 0.02, duration_ms: 18e3, at: now - 22 * M + 25e3 },
    turn(1, 'claude', 'none', 0.2, 95, { cause: 'The slowdown starts with the commit that gave every test a fresh database.', probe: 'git bisect with pytest --durations=10: 3.1× slower from that commit on.', fix: 'Drafted findings.md with per-test timings before and after.' }, { at: now - 20 * M }),
    turn(2, 'claude', 'none', 0.22, 110, { cause: 'Most of the extra time is migrations running again for every test.', probe: 'Profiled one test: migrations take 82% of its setup.', fix: 'Recommended three fixes: a session-wide template database, a rollback per test instead of a rebuild, and running the slowest files in parallel.' }, { at: now - 18 * M }),
    { type: 'judged', agent: 'claude', done: true, worth_continuing: true, progress: 'improved', reason: 'The write-up names the cause with timings and gives three concrete fixes.', cost_usd: 0.02, duration_ms: 12e3, at: now - 14 * M },
  ],
  r15: [
    { type: 'scoped', agent: 'cursor', member: T.grok, goal: 'Make logging consistent and useful across the service', success: 'All modules use the structured logger at sensible levels, with no stray prints.', checks: [], confidence: 'medium', cost_usd: 0.03, duration_ms: 20e3, at: now - 40 * M + 30e3 },
    teamTurn(1, T.sonnet, 'none', 0.18, 0.2, 90, { cause: '12 files use print() or the stdlib logger directly.', probe: 'grep -rn "print(" src | wc -l → 23.', fix: 'Routed the three biggest modules through the structured logger.' }),
    teamTurn(2, T.sol, 'none', 0.16, 0.18, 85, { cause: 'Levels were inconsistent — some errors logged as info.', probe: 'Audited the remaining call sites.', fix: 'Set sensible levels and removed the stray prints across the rest.' }),
    { type: 'judged', agent: 'cursor', member: T.grok, done: false, worth_continuing: false, progress: 'same', reason: 'The logs are consistent and structured; further passes would only reword messages.', cost_usd: 0.02, duration_ms: 11e3, at: now - 29 * M },
  ],
  r9: [
    turn(1, 'cursor', 'forecast', 0.06, 48, {
      cause: 'The CLI reads WEATHER_KEY but .env defines WEATHER_API_KEY, so requests go out with no key at all.',
      probe: 'python -m weather --city Lisbon --debug → key: None',
      fix: 'Read WEATHER_API_KEY first, keep WEATHER_KEY as a fallback.',
    }),
    turn(2, 'cursor', 'forecast', 0.07, 55, {
      cause: 'The key is sent now, but as a query parameter; version 3 of the API wants it in a header.',
      probe: 'curl with the key as a parameter → 401 “missing key”; as an X-Api-Key header → 401 “key expired”',
      fix: 'Send the key in the X-Api-Key header.',
      ruled_out: ['wrong variable name', 'network or proxy'],
    }),
    turn(3, 'claude', 'forecast', 0.14, 71, {
      cause: 'The request is right now, but the key itself has expired.',
      probe: 'curl -H "X-Api-Key: $WEATHER_API_KEY" …/v3/keys/me → {"status": "expired"}',
      fix: 'None yet: there is no valid key in the repo.',
      ruled_out: ['header format'],
    }),
    { type: 'ask', kind: 'hint', question: byId('r9').ask.question },
  ],
  r13: [
    { type: 'proposed', agent: 'claude', member: T.sonnet, ok: false, error: weekly, checks: [], cost_usd: 0, duration_ms: 5766 },
    { type: 'limited', agent: 'claude', resume_at: resets, error: weekly },
  ],
  r8: [
    { type: 'proposed', agent: 'claude', cost_usd: 0.06, checks: byId('r8').ask.checks },
    { type: 'ask', kind: 'checks', question: byId('r8').ask.question },
  ],
  r7: [
    { type: 'proposed', agent: 'claude', cost_usd: 0.03, at: now - 7 * M + 55e3,
      checks: [{ id: 'tests', cmd: 'pytest -q tests/auth', why: 'The flaky auth tests pass' }, { id: 'lint', cmd: 'ruff check .' }, { id: 'types', cmd: 'mypy src/session' }] },
    { type: 'ask', kind: 'checks', question: 'No checks were given, so Claude looked around and proposed these.', at: now - 7 * M + 58e3 },
    { type: 'replied', checks: [], at: now - 4 * M },
    turn(1, 'claude', 'tests', 0.17, 52, {
      cause: 'Tokens are issued with one wall-clock read and validated with another, so tokens minted on a second boundary expire early.',
      probe: 'pytest tests/auth -x --count 20 → 6 of 20 fail, always around a second boundary',
      fix: 'Use one monotonic read and inject the clock so tests control it.',
    }),
    turn(2, 'claude', 'tests', 0.21, 61, {
      cause: 'Two refreshes for the same user race and both rotate the refresh token.',
      probe: 'Added a 5 ms sleep inside rotate(); test_concurrent_refresh now fails every time.',
      fix: 'Take a per-user lock around rotation.',
      ruled_out: ['clock skew'],
    }),
  ],
  r6: [],
  r5: [],
  r10: [
    turn(1, 'cursor', 'verdict', 0.05, 64, {
      cause: 'No analysis yet. Some days appear twice in rides.csv, which would count them double.',
      probe: 'pandas: rides.date.duplicated().sum() → 14 duplicate days',
      fix: 'Keep one row per day, then compare rainy and clear days in analysis.py and write verdict.json.',
    }, { effort: 'xhigh', model: 'grok-4.7-xhigh' }),
    { type: 'review', agent: 'claude', accept: false, cost_usd: 0.04, issues: ['Misty days are counted as clear, which blurs the weather effect; report them separately.'] },
    turn(2, 'cursor', 'review', 0.05, 58, {
      cause: 'The reviewer is right: misty days were lumped in with clear ones.',
      probe: 'Misty days: 247 of 731, averaging 4,036 rentals.',
      fix: 'Report misty days separately and compare rainy with clear days only. Re-ran with seed 7.',
    }, { effort: 'xhigh', model: 'grok-4.7-xhigh' }),
    { type: 'review', agent: 'claude', accept: true, cost_usd: 0.03, issues: [] },
  ],
  r4: [
    turn(1, 'codex', 'report', 0, 188, { fix: 'Added a criterion benchmark comparing TOON decode with serde_json on 1k, 10k and 100k row tables.' }, { tokens: 26110, has_usd: false }),
    turn(2, 'codex', 'report', 0, 209, { fix: 'Wrote results.md: TOON decodes uniform tables 1.8x faster than JSON at 10k rows and is 41% smaller.' }, { tokens: 22100, has_usd: false }),
  ],
  r3: [
    turn(1, 'claude', 'build', 0.31, 95, { cause: 'The env-override package was not ported yet.', fix: 'Scaffolded cmd/cfgtool and ported the YAML loader.' }),
    turn(2, 'claude', 'tests', 0.36, 120, { cause: 'Go maps iterate in random order, so merged keys come out shuffled.', probe: 'go test -count 5 -run TestMergeOrder → a different order each run', fix: 'Ported env overrides.' }),
    turn(3, 'claude', 'tests', 0.45, 131, { cause: 'The fixture expects Python dict insertion order.', fix: 'Sorted keys before merging.', ruled_out: ['map iteration order alone'] }),
    turn(4, 'codex', 'tests', 0, 144, { cause: 'Same failure: the fixture order is insertion order from the YAML file.', fix: 'Kept keys in file order with an ordered map.', ruled_out: ['sorted keys'] }, { tokens: 9300, has_usd: false, effort: 'xhigh' }),
  ],
  r2: [
    turn(1, 'claude', 'findings', 0.19, 140, { fix: 'Drafted findings.md covering RAGAS, ARES and TruLens with a comparison table.' }),
    turn(2, 'claude', 'sources', 0.22, 118, { cause: 'Only four linked sources; the check needs five.', fix: 'Added three more cited papers.' }),
    turn(3, 'claude', 'sources', 0.23, 97, { fix: 'Added the BEIR and KILT benchmarks with links. Seven sources now.' }),
  ],
  r1: [turn(1, 'claude', 'build', 0.21, 210, { cause: 'Three legacy class components use removed lifecycle methods.', fix: 'Bumped react and react-dom to 19 and switched to createRoot.' })],
};

let settings = {
  theme: q.get('theme') || 'system',
  accent: q.get('accent') || 'indigo',
  editor: 'cursor',
  max_parallel: 2,
  default_budget: 2,
  default_turns: 8,
  check_timeout_sec: 120,
  lean: true,
  switch_agent: true,
  team: true,
  auto_limits: true,
  models: { claude: '', codex: '', cursor: '' },
  bins: { claude: '', codex: '', cursor: '', python: '' },
  onboarded: q.get('view') !== 'onboarding',
};

// The Logs panel's agent calls, rebuilt from each mock run's timeline.
function mockLogs(id) {
  const out = [];
  let at = find(id).created_at;
  const add = (m, role, e, output) =>
    out.push({ at: (at += 40e3), role, agent: m?.agent || e.agent, label: m?.label || '', model: e.model || '', effort: e.effort || '', ok: e.ok !== false,
      cost_usd: e.own_usd ?? e.cost_usd ?? 0, estimated: !!e.estimated, duration_ms: e.duration_ms || 30e3, error: e.error || '', output });
  for (const e of details[id] || []) {
    if (e.type === 'plan' && e.lead) add(e.lead, 'lead', e, `${e.why} ${JSON.stringify({ difficulty: e.difficulty, implement: e.implement.map((m) => m.id), ...e.estimate })}`);
    else if (e.type === 'findings') e.items.forEach((f) => add(f.member, 'investigate', f, JSON.stringify({ theory: f.theory, verdict: f.verdict, evidence: f.evidence })));
    else if (e.type === 'turn') add(e.member, 'work', e, [e.cause, e.probe, e.fix].filter(Boolean).join('\n'));
    else if (e.type === 'review') add(e.member, 'review', e, JSON.stringify({ accept: e.accept, issues: e.issues }));
    else if (e.type === 'proposed') add(e.member, 'propose', e, e.ok === false ? e.error : JSON.stringify({ checks: e.checks }));
  }
  return out;
}

const editors = [
  { id: 'cursor', name: 'Cursor', found: true, can_install: true },
  { id: 'vscode', name: 'Visual Studio Code', found: true, can_install: true },
  { id: 'zed', name: 'Zed', found: false, can_install: true },
  { id: 'sublime', name: 'Sublime Text', found: false, can_install: true },
  { id: 'vscodium', name: 'VSCodium', found: false, can_install: true },
];

const listeners = {};
const emit = (ev, payload) => (listeners[ev] || []).forEach((fn) => fn(payload));
const clone = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const find = (id) => runs.find((x) => x.id === id);
const push = (r, ev) => emit('ixd://run', { run: clone(r), ev });

function simulate(r) {
  const ids = r.kind === 'hypothesis' ? [...r.checks.map((c) => c.id), 'verdict', 'reproduce', 'review'] : r.checks.map((c) => c.id);
  const step = async () => {
    for (let k = 1; k <= 2 && r.status === 'running'; k++) {
      const n = r.turns_used + 1;
      r.turn_started_at = Date.now();
      push(r, { type: 'running', n, agent: r.agent });
      await sleep(3500);
      if (r.status !== 'running') return;
      const t = turn(n, r.agent, ids[0], 0.12, 3, k === 1
        ? { cause: 'Reproduced the failure; the first check fails at startup.', probe: 'Ran the check and read the stack trace.', fix: 'Fixed the first cause.' }
        : { cause: 'One edge case left.', fix: 'Handled it; every check passes locally.', ruled_out: ['configuration'] });
      details[r.id].push(t);
      r.turns_used = n;
      r.spent_usd += 0.12;
      r.check_state = ids.map((id) => ({ id, code: k === 2 ? 0 : 1, ok: k === 2 }));
      push(r, t);
    }
    if (r.status !== 'running') return;
    Object.assign(r, { status: 'passed', reason: 'checks_passed', finished_at: Date.now() });
    push(r, { type: 'finished', ok: true });
  };
  step();
}

async function propose(r) {
  await sleep(2500);
  const checks = [{ id: 'tests', cmd: 'npm test', why: 'The existing suite passes' }, { id: 'build', cmd: 'npm run build', why: 'The app still builds' }];
  const question = 'No checks were given, so the agent proposed these. Edit them, then approve.';
  details[r.id].push({ type: 'proposed', agent: r.agent, cost_usd: 0.04, checks }, { type: 'ask', kind: 'checks', question });
  Object.assign(r, { status: 'waiting', spent_usd: 0.04, ask: { kind: 'checks', question, checks } });
  push(r, { type: 'ask', kind: 'checks', question, checks });
}

export const api = {
  appInfo: async () => ({ version: '0.4.0', platform: q.get('platform') || 'macos', glass: q.get('glass') === '1', data_dir: `${home}/Library/Application Support/Iteraxa`, daemon: true }),
  listRuns: async () => clone(runs),
  getRun: async (id) => {
    const r = find(id);
    if (!r) throw new Error('run not found');
    return { meta: clone(r), turns: clone(details[id] || []), ledger_toon: details[id]?.some((t) => t.type === 'turn') ? ledger(details[id]) : '' };
  },
  async startRun(goal) {
    const id = 'm' + Date.now().toString(36);
    const r = meta({ ...goal, id, status: 'running', spent_usd: 0, turns_used: 0, created_at: Date.now(), turn_started_at: Date.now() });
    runs.unshift(r);
    details[id] = [];
    setTimeout(() => (r.checks.length || r.kind === 'hypothesis' ? simulate(r) : propose(r)), 300);
    return clone(r);
  },
  async replyRun(id, checks, hint) {
    const r = find(id);
    if (r.status !== 'waiting') throw new Error('run is not waiting for a reply');
    const ev = { type: 'replied', hint: hint || '', checks: checks || [] };
    details[id].push(ev);
    if (checks) r.checks = checks;
    Object.assign(r, { status: 'running', ask: null, turn_started_at: Date.now() });
    push(r, ev);
    setTimeout(() => simulate(r), 300);
    return clone(r);
  },
  async extendRun(id, budget, turns) {
    const r = find(id);
    if (r.status !== 'failed' || !['budget', 'max_turns'].includes(r.reason)) throw new Error('only a run stopped by its budget or turn limit can continue');
    if (budget < r.budget_usd || turns < r.max_turns || (budget === r.budget_usd && turns === r.max_turns)) throw new Error('raise the budget or max turns to continue');
    const ev = { type: 'extended', budget_usd: budget, max_turns: turns };
    details[id].push(ev);
    Object.assign(r, { status: 'running', reason: '', error: '', budget_usd: budget, max_turns: turns, finished_at: 0, turn_started_at: Date.now() });
    push(r, ev);
    setTimeout(() => simulate(r), 300);
    return clone(r);
  },
  runLogs: async (id) => ({ calls: mockLogs(id), loop_log: '', dir: find(id).dir }),
  async stopRun(id) {
    const r = find(id);
    Object.assign(r, { status: 'stopped', reason: 'stopped', finished_at: Date.now() });
    push(r, { type: 'finished', ok: false, reason: 'stopped' });
  },
  async deleteRun(id) {
    runs.splice(runs.findIndex((x) => x.id === id), 1);
  },
  getSettings: async () => clone(settings),
  setSettings: async (s) => void (settings = clone(s)),
  editors: async () => clone(editors),
  openEditor: async () => {},
  async installEditor(name) {
    setTimeout(() => {
      editors.find((e) => e.id === name).found = true;
      emit('editor://install', { name, done: true, ok: true });
    }, 2500);
  },
  agents: async () => {
    const has = (a) => !q.get('agents') || q.get('agents').split(',').includes(a); // ?agents=claude previews a Mac with only Claude
    return {
      claude: { found: has('claude'), path: '/opt/homebrew/bin/claude', version: '2.4.1 (Claude Code)' },
      codex: { found: has('codex'), path: `${home}/.local/bin/codex`, version: 'codex-cli 0.98.0' },
      cursor: { found: has('cursor'), path: `${home}/.local/bin/cursor-agent`, version: '2026.10.21' },
    };
  },
  guessChecks: async () => [
    { id: 'tests', cmd: 'npm test' },
    { id: 'lint', cmd: 'npm run lint' },
    { id: 'types', cmd: 'npx tsc --noEmit' },
  ],
  pickFolder: async () => `${home}/code/notes-app`,
  reveal: async () => {},
  setTheme: async () => {},
  listen: async (ev, fn) => {
    (listeners[ev] ||= []).push(fn);
    return () => {};
  },
};
