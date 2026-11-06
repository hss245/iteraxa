const T = window.__TAURI__;

function tauri() {
  const inv = T.core.invoke;
  return {
    appInfo: () => inv('app_info'),
    listRuns: () => inv('runs_list'),
    getRun: (id) => inv('run_get', { id }),
    startRun: (goal) => inv('run_start', { goal }),
    replyRun: (id, checks, hint) => inv('run_reply', { id, checks, hint }),
    extendRun: (id, budget, turns) => inv('run_extend', { id, budgetUsd: budget, maxTurns: turns }),
    runLogs: (id) => inv('run_logs', { id }),
    stopRun: (id) => inv('run_stop', { id }),
    deleteRun: (id) => inv('run_delete', { id }),
    getSettings: () => inv('settings_get'),
    setSettings: (settings) => inv('settings_set', { settings }),
    editors: () => inv('editors_list'),
    openEditor: (editor, path) => inv('editor_open', { editor, path }),
    installEditor: (name) => inv('editor_install', { name }),
    agents: () => inv('agents_status'),
    guessChecks: (path) => inv('guess_checks', { path }),
    pickFolder: () => inv('pick_folder'),
    reveal: (path) => inv('reveal_path', { path }),
    setTheme: (theme) => inv('set_theme', { theme }),
    listen: (event, fn) => T.event.listen(event, (e) => fn(e.payload)),
  };
}

export const api = T ? tauri() : (await import('./mock.js')).api;
