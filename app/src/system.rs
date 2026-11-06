use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| "/".into())
}

/// Must match `DataDir` in `internal/daemon/store.go`.
pub fn data_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("ITERAXA_DATA") {
        return d.into();
    }
    if cfg!(target_os = "macos") {
        return home().join("Library/Application Support/Iteraxa");
    }
    match std::env::var_os("XDG_DATA_HOME") {
        Some(x) if !x.is_empty() => PathBuf::from(x).join("iteraxa"),
        _ => home().join(".local/share/iteraxa"),
    }
}

/// GUI apps on macOS start with a bare PATH, so agents installed by npm, brew or cargo are invisible.
/// Merge the login shell's PATH with the usual install folders.
pub fn path_env() -> &'static str {
    static P: OnceLock<String> = OnceLock::new();
    P.get_or_init(|| {
        let mut dirs: Vec<String> = Vec::new();
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        if let Some(out) = run_timeout(Command::new(shell).args(["-lc", "printf %s \"$PATH\""]), Duration::from_secs(3)) {
            dirs.extend(out.split(':').map(String::from));
        }
        dirs.extend(std::env::var("PATH").unwrap_or_default().split(':').map(String::from));
        let h = home();
        for d in [".local/bin", ".cargo/bin", "go/bin", ".bun/bin", ".npm-global/bin", ".volta/bin", ".deno/bin"] {
            dirs.push(h.join(d).to_string_lossy().into());
        }
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/snap/bin"].map(String::from));
        let mut seen = std::collections::HashSet::new();
        dirs.retain(|d| !d.is_empty() && seen.insert(d.clone()));
        dirs.join(":")
    })
}

pub fn which(name: &str) -> Option<PathBuf> {
    if name.contains('/') {
        let p = PathBuf::from(name);
        return p.is_file().then_some(p);
    }
    path_env().split(':').map(|d| Path::new(d).join(name)).find(|p| p.is_file())
}

/// Runs a command and returns trimmed stdout, or None on failure or timeout.
pub fn run_timeout(cmd: &mut Command, limit: Duration) -> Option<String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait().ok()? {
            Some(st) if st.success() => break,
            Some(_) => return None,
            None if start.elapsed() > limit => {
                let _ = child.kill();
                return None;
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    }
    let mut s = String::new();
    std::io::Read::read_to_string(child.stdout.as_mut()?, &mut s).ok()?;
    Some(s.trim().to_string())
}

#[derive(Serialize)]
pub struct Tool {
    found: bool,
    path: String,
    version: String,
}

fn probe(bin: Option<PathBuf>) -> Tool {
    match bin {
        Some(p) => {
            let version = run_timeout(Command::new(&p).arg("--version").env("PATH", path_env()), Duration::from_secs(5))
                .and_then(|v| v.lines().next().map(String::from))
                .unwrap_or_default();
            Tool { found: true, path: p.to_string_lossy().into(), version }
        }
        None => Tool { found: false, path: String::new(), version: String::new() },
    }
}

pub fn agents(settings: &Value) -> Value {
    let custom = |name: &str| settings["bins"][name].as_str().unwrap_or("").trim().to_string();
    let pick = |name: &str| {
        let c = custom(name);
        if c.is_empty() { which(name) } else { which(&c) }
    };
    // `cursor` on PATH is the editor, not the agent. Same order as agent.Bin in Go.
    let cursor = match custom("cursor") {
        c if !c.is_empty() => which(&c),
        _ => which("cursor-agent").or_else(|| which("agent")),
    };
    json!({
        "claude": probe(pick("claude")),
        "codex": probe(pick("codex")),
        "cursor": probe(cursor),
        "python": probe(pick("python").or_else(|| which("python3"))),
    })
}

fn check(id: &str, cmd: &str) -> Value {
    json!({ "id": id, "cmd": cmd })
}

/// Suggests check commands from the files a project has.
pub fn guess_checks(dir: &Path) -> Vec<Value> {
    let has = |f: &str| dir.join(f).exists();
    let read = |f: &str| std::fs::read_to_string(dir.join(f)).unwrap_or_default();
    let mut out = Vec::new();
    if has("package.json") {
        let pkg: Value = serde_json::from_str(&read("package.json")).unwrap_or_default();
        let pm = if has("pnpm-lock.yaml") { "pnpm" } else if has("yarn.lock") { "yarn" } else if has("bun.lockb") || has("bun.lock") { "bun" } else { "npm" };
        let scripts = &pkg["scripts"];
        if scripts["test"].is_string() {
            out.push(check("tests", &format!("{pm} test")));
        }
        for s in ["lint", "build", "typecheck"] {
            if scripts[s].is_string() {
                out.push(check(s, &format!("{pm} run {s}")));
            }
        }
        if has("tsconfig.json") && !scripts["typecheck"].is_string() {
            out.push(check("types", "npx tsc --noEmit"));
        }
    }
    if has("Cargo.toml") {
        out.push(check("tests", "cargo test"));
        out.push(check("clippy", "cargo clippy -- -D warnings"));
    }
    if has("go.mod") {
        out.push(check("tests", "go test ./..."));
        out.push(check("vet", "go vet ./..."));
    }
    if has("pyproject.toml") || has("pytest.ini") || has("setup.py") || dir.join("tests").is_dir() && !has("package.json") {
        out.push(check("tests", "python3 -m pytest -q"));
        if read("pyproject.toml").contains("ruff") {
            out.push(check("lint", "ruff check ."));
        }
    }
    if read("Makefile").lines().any(|l| l.starts_with("test:")) {
        out.push(check("make", "make test"));
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|c| seen.insert(c["cmd"].as_str().unwrap_or("").to_string()));
    out
}

pub fn open_path(path: &str) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    Command::new(opener).arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guesses_node_and_rust_checks() {
        let d = std::env::temp_dir().join(format!("ixguess{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("package.json"), r#"{"scripts":{"test":"vitest","lint":"eslint ."}}"#).unwrap();
        std::fs::write(d.join("pnpm-lock.yaml"), "").unwrap();
        std::fs::write(d.join("Cargo.toml"), "").unwrap();
        let cmds: Vec<String> = guess_checks(&d).iter().map(|c| c["cmd"].as_str().unwrap().to_string()).collect();
        std::fs::remove_dir_all(&d).unwrap();
        assert_eq!(&cmds[..3], ["pnpm test", "pnpm run lint", "cargo test"]);
    }
}
