//! Starts Codeply's engine beside the app: the sidecar in `sidecar/engine.mjs` (built into this
//! binary), run with the Node and the codeply-cli of the installed Codeply app, so chats run on
//! the DSH engine with nothing else installed. The app talks to it through the live store.
//!
//! Where the engine comes from, first match wins:
//! 1. `CODEPLY_CLI_PATH` (a codeply-cli folder), as the Codeply app itself honours it;
//! 2. the installed Codeply app's `resources/` (Windows: %LOCALAPPDATA%\Programs\Codeply Craft);
//! 3. a source checkout above this binary (running from `rune-app/target/...`).
//!
//! The Node is the app's own `resources/dsh-runtime/node(.exe)` (Node 24, which DSH needs), else
//! `CODEPLY_DSH_NODE`, else `node` on PATH. The sidecar listens on 127.0.0.1 only, on a port
//! picked here, and every request needs the secret made for this launch.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

const SCRIPT: &str = include_str!("../sidecar/engine.mjs");

/// The engine a launch found.
#[derive(Debug, Clone)]
pub struct Install {
    pub cli: PathBuf,
    pub node: PathBuf,
}

/// A running sidecar. Dropping it stops the engine.
pub struct Sidecar {
    child: Child,
    pub url: String,
    pub token: String,
    /// Which engine was found (for diagnostics and tests).
    #[allow(dead_code)]
    pub install: Install,
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map_or_else(|| PathBuf::from("."), PathBuf::from)
}

fn is_cli(dir: &Path) -> bool {
    dir.join("lib").join("dsh-acp.mjs").is_file() || dir.join("lib").join("agent.mjs").is_file()
}

/// Windows: where the installer says Codeply went (its uninstall entry's InstallLocation), for
/// installs outside the usual folders.
#[cfg(windows)]
fn registry_installs() -> Vec<PathBuf> {
    use std::os::windows::process::CommandExt;
    let mut out = Vec::new();
    for hive in ["HKCU", "HKLM"] {
        let Ok(o) = Command::new("reg")
            .args(["query", &format!("{hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"), "/s"])
            .creation_flags(0x0800_0000)
            .output()
        else {
            continue;
        };
        out.extend(parse_uninstall(&String::from_utf8_lossy(&o.stdout)));
    }
    out
}

#[cfg(not(windows))]
fn registry_installs() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg_attr(not(windows), allow(dead_code))]
/// The `resources` folders of Codeply's entries in a `reg query ... /s` dump of the uninstall keys:
/// blocks of `HKEY_...` lines, each followed by `    Name    REG_SZ    Data` lines.
fn parse_uninstall(dump: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let (mut codeply, mut location) = (false, None::<String>);
    for line in dump.lines().chain(std::iter::once("HKEY_END")) {
        if line.starts_with("HKEY_") {
            if let (true, Some(l)) = (codeply, location.take()) {
                out.push(PathBuf::from(l).join("resources"));
            }
            codeply = false;
            location = None;
            continue;
        }
        let parts: Vec<&str> = line.trim().splitn(3, "    ").collect();
        if let [name, _, data] = parts[..] {
            if name == "DisplayName" && data.starts_with("Codeply") && !data.contains("Rune") {
                codeply = true;
            }
            if name == "InstallLocation" {
                location = Some(data.trim().to_owned());
            }
        }
    }
    out
}

/// Where installed Codeply apps keep their `resources` folder.
fn resource_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(r) = std::env::var_os("CODEPLY_APP_RESOURCES") {
        out.push(PathBuf::from(r));
    }
    for name in ["Codeply Craft", "codeply-craft", "Codeply"] {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            out.push(PathBuf::from(&local).join("Programs").join(name).join("resources"));
        }
        for var in ["ProgramFiles", "ProgramW6432"] {
            if let Some(pf) = std::env::var_os(var) {
                out.push(PathBuf::from(pf).join(name).join("resources"));
            }
        }
        out.push(PathBuf::from(format!("/Applications/{name}.app/Contents/Resources")));
        out.push(home().join("Applications").join(format!("{name}.app")).join("Contents").join("Resources"));
        out.push(PathBuf::from(format!("/opt/{name}/resources")));
    }
    out.extend(registry_installs());
    out
}

/// Finds an installed Codeply engine.
pub fn find() -> Result<Install, String> {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    let mut cli = std::env::var_os("CODEPLY_CLI_PATH").map(PathBuf::from).filter(|p| is_cli(p));
    let mut runtime = None;
    if cli.is_none() {
        for res in resource_dirs() {
            if is_cli(&res.join("codeply-cli")) {
                cli = Some(res.join("codeply-cli"));
                runtime = Some(res.join("dsh-runtime"));
                break;
            }
        }
    }
    if cli.is_none() {
        // A source checkout: this binary under rune-app/target/..., the CLI at the repo root.
        if let Ok(me) = std::env::current_exe() {
            cli = me.ancestors().map(|a| a.join("codeply-cli")).find(|p| is_cli(p));
        }
    }
    let cli = cli.ok_or("Codeply isn't installed on this PC. Install Codeply and sign in, then open this app again.")?;
    let node = runtime.map(|r| r.join(exe)).filter(|p| p.is_file())
        .or_else(|| std::env::var_os("CODEPLY_DSH_NODE").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from(exe));
    Ok(Install { cli, node })
}

fn secret() -> String {
    // RandomState is seeded from the OS's randomness; two of them make 128 bits.
    let mut out = String::new();
    for _ in 0..2 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(std::process::id().into());
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

/// Where the app keeps its engine data: chats, the sidecar script, its log.
pub fn data_dir() -> PathBuf {
    home().join(".codeply").join("rune")
}

/// The folder new chats work in.
pub fn project_dir() -> PathBuf {
    std::env::var_os("CODEPLY_PROJECT").map_or_else(|| home().join("Codeply"), PathBuf::from)
}

/// Starts the sidecar and returns once it is spawned (it is listening a moment later; the live
/// store retries until it answers).
pub fn start() -> Result<Sidecar, String> {
    let install = find()?;
    let data = data_dir();
    std::fs::create_dir_all(&data).map_err(|e| format!("can't make {}: {e}", data.display()))?;
    let project = project_dir();
    let _ = std::fs::create_dir_all(&project);
    let script = data.join("engine.mjs");
    if std::fs::read_to_string(&script).ok().as_deref() != Some(SCRIPT) {
        std::fs::write(&script, SCRIPT).map_err(|e| format!("can't write the engine script: {e}"))?;
    }
    let (port, token) = (free_port()?, secret());
    let log = std::fs::File::create(data.join("engine.log")).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&install.node);
    cmd.arg(&script)
        .arg("--cli").arg(&install.cli)
        .arg("--port").arg(port.to_string())
        .arg("--data").arg(&data)
        .arg("--cwd").arg(&project)
        .env("CODEPLY_SIDECAR_TOKEN", &token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window for the engine.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("can't start the engine with {}: {e}", install.node.display()))?;
    // Keep reading its stdout so it never blocks on a full pipe.
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || for _ in BufReader::new(out).lines() {});
    }
    Ok(Sidecar { child, url: format!("http://127.0.0.1:{port}"), token, install })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_long_and_differ() {
        let (a, b) = (secret(), secret());
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }

    #[test]
    fn the_uninstall_entry_names_the_install() {
        let dump = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other\r\n    DisplayName    REG_SZ    Something else\r\n    InstallLocation    REG_SZ    C:\\Other\r\n\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\0b5e-guid\r\n    DisplayName    REG_SZ    Codeply 3.0.0\r\n    InstallLocation    REG_SZ    C:\\Users\\sam\\AppData\\Local\\Programs\\Codeply Craft\r\n";
        let found = parse_uninstall(dump);
        assert_eq!(found, vec![PathBuf::from("C:\\Users\\sam\\AppData\\Local\\Programs\\Codeply Craft").join("resources")]);
    }

    #[test]
    fn a_source_checkout_is_found() {
        // Tests run from rune-app/target/...; the repo's codeply-cli is above.
        let found = find();
        assert!(found.is_ok(), "{found:?}");
    }
}
