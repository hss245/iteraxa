#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod editors;
mod ixd;
mod system;

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State, Theme, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

type Res<T> = Result<T, String>;

fn settings_path() -> PathBuf {
    system::data_dir().join("settings.json")
}

fn read_settings() -> Value {
    std::fs::read(settings_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({}))
}

fn parse_theme(name: &str) -> Option<Theme> {
    match name {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    }
}

#[tauri::command(async)]
fn app_info(ixd: State<ixd::Ixd>) -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": if cfg!(target_os = "macos") { "macos" } else { "linux" },
        "glass": cfg!(target_os = "macos"),
        "data_dir": system::data_dir(),
        "daemon": ixd.alive(),
    })
}

#[tauri::command(async)]
fn runs_list(ixd: State<ixd::Ixd>) -> Res<Value> {
    ixd.request("list", json!({}))
}

#[tauri::command(async)]
fn run_get(ixd: State<ixd::Ixd>, id: String) -> Res<Value> {
    ixd.request("get", json!({ "id": id }))
}

#[tauri::command(async)]
fn run_start(ixd: State<ixd::Ixd>, goal: Value) -> Res<Value> {
    ixd.request("start", json!({ "goal": goal }))
}

#[tauri::command(async)]
fn run_reply(ixd: State<ixd::Ixd>, id: String, checks: Option<Value>, hint: Option<String>) -> Res<Value> {
    ixd.request("reply", json!({ "id": id, "checks": checks, "hint": hint.unwrap_or_default() }))
}

#[tauri::command(async)]
fn run_extend(ixd: State<ixd::Ixd>, id: String, budget_usd: f64, max_turns: u32) -> Res<Value> {
    ixd.request("extend", json!({ "id": id, "budget_usd": budget_usd, "max_turns": max_turns }))
}

/// What the Logs panel shows: every agent call of a run and the tail of the loop's own stderr.
/// Runs from before calls.jsonl existed fall back to their last result file per call slot.
#[tauri::command(async)]
fn run_logs(id: String) -> Res<Value> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("unknown run".into());
    }
    let dir = system::data_dir().join("runs").join(&id);
    let read = |p: PathBuf| std::fs::read_to_string(p).unwrap_or_default();
    let mut calls: Vec<Value> = read(dir.join("calls.jsonl")).lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    if calls.is_empty() {
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if let (true, Ok(mut v)) = (name.starts_with("result") && name.ends_with(".json"), serde_json::from_str::<Value>(&read(e.path()))) {
                let at = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
                v["at"] = json!(at.map_or(0, |d| d.as_millis() as u64));
                calls.push(v);
            }
        }
        calls.sort_by_key(|v| v["at"].as_u64());
    }
    let log = std::fs::read(dir.join("loop.log")).unwrap_or_default();
    let tail = String::from_utf8_lossy(&log[log.len().saturating_sub(20_000)..]).into_owned();
    Ok(json!({ "calls": calls, "loop_log": tail, "dir": dir }))
}

#[tauri::command(async)]
fn run_stop(ixd: State<ixd::Ixd>, id: String) -> Res<Value> {
    ixd.request("stop", json!({ "id": id }))
}

#[tauri::command(async)]
fn run_delete(ixd: State<ixd::Ixd>, id: String) -> Res<Value> {
    ixd.request("delete", json!({ "id": id }))
}

#[tauri::command(async)]
fn settings_get() -> Value {
    read_settings()
}

#[tauri::command(async)]
fn settings_set(settings: Value) -> Res<()> {
    let path = settings_path();
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&settings).unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn editors_list() -> Vec<Value> {
    editors::list()
}

#[tauri::command(async)]
fn editor_open(editor: String, path: String) -> Res<()> {
    editors::open(&editor, &path)
}

#[tauri::command]
fn editor_install(app: AppHandle, name: String) {
    std::thread::spawn(move || {
        let r = editors::install(&name, |line| {
            let _ = app.emit("editor://install", json!({ "name": name, "line": line }));
        });
        let _ = app.emit("editor://install", json!({ "name": name, "done": true, "ok": r.is_ok(), "error": r.err() }));
    });
}

#[tauri::command(async)]
fn agents_status() -> Value {
    system::agents(&read_settings())
}

#[tauri::command(async)]
fn guess_checks(path: String) -> Vec<Value> {
    system::guess_checks(Path::new(&path))
}

#[tauri::command(async)]
fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog().file().blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into())
}

#[tauri::command(async)]
fn reveal_path(path: String) -> Res<()> {
    system::open_path(&path)
}

#[tauri::command]
fn set_theme(window: WebviewWindow, theme: String) -> Res<()> {
    window.set_theme(parse_theme(&theme)).map_err(|e| e.to_string())
}

/// Sidecars sit next to the app binary, both in bundles and in `target/<profile>`.
fn sidecar(name: &str) -> PathBuf {
    let dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
    let p = dir.join(name);
    if p.exists() { p } else { system::which(name).unwrap_or(p) }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let python_path = app
                .path()
                .resource_dir()
                .map(|d| d.join("python"))
                .ok()
                .filter(|d| d.join("iteraxa/loop.py").exists())
                .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../python")));
            let ixd = ixd::Ixd { data: system::data_dir(), bin: sidecar("ixd"), ixpack: sidecar("ixpack"), python_path };
            let sub = ixd.clone();
            app.manage(ixd);
            let handle = app.handle().clone();
            std::thread::spawn(move || sub.subscribe(handle));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_theme(parse_theme(read_settings()["theme"].as_str().unwrap_or("")));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            runs_list,
            run_get,
            run_start,
            run_reply,
            run_extend,
            run_logs,
            run_stop,
            run_delete,
            settings_get,
            settings_set,
            editors_list,
            editor_open,
            editor_install,
            agents_status,
            guess_checks,
            pick_folder,
            reveal_path,
            set_theme
        ])
        .run(tauri::generate_context!())
        .expect("error while running Iteraxa");
}
