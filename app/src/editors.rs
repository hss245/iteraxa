use crate::system::{path_env, which};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub struct Editor {
    id: &'static str,
    name: &'static str,
    mac_app: &'static str,
    cli: &'static str,
    cask: &'static str,
    apt: &'static str,
    snap: &'static str,
}

const fn e(id: &'static str, name: &'static str, mac_app: &'static str, cli: &'static str, cask: &'static str, apt: &'static str, snap: &'static str) -> Editor {
    Editor { id, name, mac_app, cli, cask, apt, snap }
}

pub const CATALOG: &[Editor] = &[
    e("cursor", "Cursor", "Cursor", "cursor", "cursor", "", ""),
    e("vscode", "Visual Studio Code", "Visual Studio Code", "code", "visual-studio-code", "", "code"),
    e("vscodium", "VSCodium", "VSCodium", "codium", "vscodium", "", "codium"),
    e("zed", "Zed", "Zed", "zed", "zed", "", ""),
    e("sublime", "Sublime Text", "Sublime Text", "subl", "sublime-text", "", "sublime-text"),
    e("lapce", "Lapce", "Lapce", "lapce", "lapce", "", ""),
    e("kate", "Kate", "", "kate", "", "kate", ""),
    e("gnome-text-editor", "GNOME Text Editor", "", "gnome-text-editor", "", "gnome-text-editor", ""),
];

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Os {
    Mac,
    Linux,
}

pub const OS: Os = if cfg!(target_os = "macos") { Os::Mac } else { Os::Linux };

fn find(id: &str) -> Result<&'static Editor, String> {
    CATALOG.iter().find(|x| x.id == id).ok_or_else(|| format!("unknown editor {id}"))
}

fn mac_bundle(ed: &Editor) -> Option<PathBuf> {
    if ed.mac_app.is_empty() {
        return None;
    }
    let app = format!("{}.app", ed.mac_app);
    [PathBuf::from("/Applications"), crate::system::home().join("Applications")]
        .into_iter()
        .map(|d| d.join(&app))
        .find(|p| p.exists())
}

fn installed(ed: &Editor) -> bool {
    (OS == Os::Mac && mac_bundle(ed).is_some()) || which(ed.cli).is_some()
}

/// The command that installs an editor on the given OS, if there is one.
pub fn install_command(ed: &Editor, os: Os) -> Option<Vec<String>> {
    let v = |a: &[&str]| Some(a.iter().map(|s| s.to_string()).collect());
    match os {
        Os::Mac if !ed.cask.is_empty() => v(&["brew", "install", "--cask", ed.cask]),
        Os::Linux if !ed.apt.is_empty() => v(&["pkexec", "apt-get", "install", "-y", ed.apt]),
        Os::Linux if !ed.snap.is_empty() => v(&["pkexec", "snap", "install", "--classic", ed.snap]),
        _ => None,
    }
}

pub fn list() -> Vec<Value> {
    CATALOG
        .iter()
        .filter(|ed| installed(ed) || install_command(ed, OS).is_some())
        .map(|ed| json!({ "id": ed.id, "name": ed.name, "found": installed(ed), "can_install": install_command(ed, OS).is_some() }))
        .collect()
}

pub fn open(id: &str, path: &str) -> Result<(), String> {
    let ed = find(id)?;
    let mut cmd = match (OS, mac_bundle(ed)) {
        (Os::Mac, Some(app)) => {
            let mut c = Command::new("open");
            c.arg("-a").arg(app).arg(path);
            c
        }
        _ => {
            let mut c = Command::new(which(ed.cli).ok_or_else(|| format!("{} is not installed", ed.name))?);
            c.arg(path);
            c
        }
    };
    cmd.env("PATH", path_env()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Runs the install command, calling `progress` with each output line, then returns the outcome.
pub fn install(id: &str, mut progress: impl FnMut(&str)) -> Result<(), String> {
    let ed = find(id)?;
    let argv = install_command(ed, OS).ok_or_else(|| format!("{} cannot be installed automatically here", ed.name))?;
    let bin = which(&argv[0]).ok_or_else(|| if OS == Os::Mac { "Homebrew is required: https://brew.sh".to_string() } else { format!("{} not found", argv[0]) })?;
    let mut child = Command::new(bin)
        .args(&argv[1..])
        .env("PATH", path_env())
        .env("HOMEBREW_NO_AUTO_UPDATE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let err = child.stderr.take().map(|s| std::thread::spawn(move || BufReader::new(s).lines().map_while(Result::ok).collect::<Vec<_>>()));
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
        progress(&line);
    }
    let errs = err.and_then(|h| h.join().ok()).unwrap_or_default();
    match child.wait().map_err(|e| e.to_string())?.success() {
        true => Ok(()),
        false => Err(errs.last().cloned().unwrap_or_else(|| format!("installing {} failed", ed.name))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_commands_per_os() {
        let cmd = |id, os| install_command(find(id).unwrap(), os).map(|v| v.join(" "));
        assert_eq!(cmd("cursor", Os::Mac).as_deref(), Some("brew install --cask cursor"));
        assert_eq!(cmd("cursor", Os::Linux), None);
        assert_eq!(cmd("vscode", Os::Linux).as_deref(), Some("pkexec snap install --classic code"));
        assert_eq!(cmd("kate", Os::Linux).as_deref(), Some("pkexec apt-get install -y kate"));
        assert_eq!(cmd("kate", Os::Mac), None);
    }
}
