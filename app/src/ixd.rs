use crate::system::path_env;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Client for the ixd daemon: one connection per request, plus one long-lived subscription.
#[derive(Clone)]
pub struct Ixd {
    pub data: PathBuf,
    pub bin: PathBuf,
    pub ixpack: PathBuf,
    pub python_path: PathBuf,
}

impl Ixd {
    fn sock(&self) -> PathBuf {
        self.data.join("ixd.sock")
    }

    pub fn alive(&self) -> bool {
        UnixStream::connect(self.sock()).is_ok()
    }

    fn call(&self, req: &Value) -> Result<Value, String> {
        let mut s = UnixStream::connect(self.sock()).map_err(|e| e.to_string())?;
        s.set_read_timeout(Some(Duration::from_secs(30))).ok();
        writeln!(s, "{req}").map_err(|e| e.to_string())?;
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).map_err(|e| e.to_string())?;
        let resp: Value = serde_json::from_str(&line).map_err(|_| "the background service closed the connection".to_string())?;
        match resp["ok"].as_bool() {
            Some(true) => Ok(resp["data"].clone()),
            _ => Err(resp["error"].as_str().unwrap_or("background service error").to_string()),
        }
    }

    pub fn request(&self, op: &str, mut args: Value) -> Result<Value, String> {
        args["op"] = op.into();
        if !self.alive() {
            self.ensure()?;
        }
        self.call(&args)
    }

    fn spawn(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.data).map_err(|e| e.to_string())?;
        let log = std::fs::File::options().create(true).append(true).open(self.data.join("ixd.log")).map_err(|e| e.to_string())?;
        // ponytail: the daemon stays our child until the app quits (then launchd/init adopts it); no double fork.
        Command::new(&self.bin)
            .arg("serve")
            .arg("--data")
            .arg(&self.data)
            .arg("--ixpack")
            .arg(&self.ixpack)
            .arg("--python-path")
            .arg(&self.python_path)
            .env("PATH", path_env())
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log)
            .process_group(0)
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", self.bin.display()))?;
        for _ in 0..100 {
            if self.alive() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("the background service did not start; see ixd.log in the data folder".into())
    }

    /// Connects to a daemon of this version, starting or replacing it as needed. At launch the subscription
    /// thread and the window's first request both get here; holding the lock means only one of them spawns.
    pub fn ensure(&self) -> Result<(), String> {
        static STARTING: Mutex<()> = Mutex::new(());
        let _one_at_a_time = STARTING.lock().unwrap_or_else(|e| e.into_inner());
        if !self.alive() {
            return self.spawn();
        }
        let hello = self.call(&json!({ "op": "hello" }))?;
        if hello["version"] == env!("CARGO_PKG_VERSION") {
            return Ok(());
        }
        // The daemon refuses to shut down while runs are active; keep using the old one then.
        if self.call(&json!({ "op": "shutdown" })).is_err() {
            return Ok(());
        }
        for _ in 0..60 {
            if !self.alive() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.spawn()
    }

    /// Streams daemon events to the UI forever, reconnecting (and restarting the daemon) when it drops.
    pub fn subscribe(&self, app: AppHandle) {
        loop {
            if let Err(e) = self.ensure().and_then(|_| self.stream(&app)) {
                eprintln!("ixd: {e}");
            }
            let _ = app.emit("ixd://status", json!({ "connected": false }));
            std::thread::sleep(Duration::from_secs(2));
        }
    }

    fn stream(&self, app: &AppHandle) -> Result<(), String> {
        let mut s = UnixStream::connect(self.sock()).map_err(|e| e.to_string())?;
        writeln!(s, "{}", json!({ "op": "subscribe" })).map_err(|e| e.to_string())?;
        let mut lines = BufReader::new(s).lines();
        lines.next(); // the ok reply
        let _ = app.emit("ixd://status", json!({ "connected": true }));
        for line in lines {
            let line = line.map_err(|e| e.to_string())?;
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let _ = app.emit("ixd://run", v);
            }
        }
        Ok(())
    }
}
