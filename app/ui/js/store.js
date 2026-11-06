export const DEFAULT_SETTINGS = {
  theme: 'system',
  accent: 'indigo',
  editor: '',
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
  onboarded: false,
};

export const state = {
  runs: new Map(),
  details: new Map(),
  selected: 'new',
  settings: { ...DEFAULT_SETTINGS },
  info: { version: '', platform: 'macos', glass: false, data_dir: '', daemon: false },
  agents: {},
  editors: [],
  filter: '',
  open: new Set(),
  replies: new Map(), // run id -> draft answer while a run waits
  approvals: new Map(), // run id -> editable copy of the proposed checks
  extends: new Map(), // run id -> raised { budget, turns } for a run stopped by a limit
  logs: new Map(), // run id -> { calls, loop_log } while its Logs panel is open
  overlay: null,
  settingsTab: 'appearance',
  draft: null,
};

export function freshDraft() {
  return {
    intent: '',
    workspace: '',
    kind: 'code',
    hypothesis: '',
    agent: 'cursor',
    team: state.settings.team,
    auto: state.settings.auto_limits,
    budget: state.settings.default_budget,
    turns: state.settings.default_turns,
    switch_agent: state.settings.switch_agent,
    allow_network: false,
    autonomous: true, // no checks given: scope the goal and decide when to stop, instead of asking you to approve checks
    checks: [{ id: '', cmd: '' }],
    suggestions: [],
  };
}
