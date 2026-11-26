//! "Start with Windows" (Settings > General): Codeply opens minimized when you sign in to the
//! computer, so loops and reminders run on time on this PC, as the Electron app's login item
//! does. Each OS's own place, no extra crates:
//! - Windows: the `Run` key under HKCU (through `reg.exe`);
//! - Linux: `~/.config/autostart/codeply.desktop`;
//! - macOS: `~/Library/LaunchAgents/app.codeply.rune.plist`.
//!
//! The entry starts this same executable with `--hidden`, which opens the window minimized.

use std::path::PathBuf;

/// The switch's label on this OS.
pub fn label() -> &'static str {
    if cfg!(windows) {
        "Start with Windows"
    } else if cfg!(target_os = "macos") {
        "Open at login"
    } else {
        "Start when you sign in"
    }
}

/// Whether this launch came from the login entry (open minimized).
pub fn launched_hidden() -> bool {
    rune::extra_args().iter().any(|a| a == "--hidden")
}

fn exe() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(windows)]
fn reg(args: &[&str]) -> bool {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("reg").args(args).creation_flags(0x0800_0000)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .status().is_ok_and(|s| s.success())
}

/// Whether the login entry is there (false in headless runs and tests).
pub fn is_on() -> bool {
    if rune::is_headless() {
        return false;
    }
    #[cfg(windows)]
    {
        reg(&["query", RUN_KEY, "/v", "Codeply"])
    }
    #[cfg(not(windows))]
    {
        entry_file().is_some_and(|f| f.exists())
    }
}

/// Adds or removes the login entry. Err says why in plain words.
pub fn set(on: bool) -> Result<(), String> {
    let exe = exe().ok_or("Couldn't find where Yune is installed.")?;
    #[cfg(windows)]
    {
        let ok = if on {
            let cmd = format!("\"{}\" --hidden", exe.display());
            reg(&["add", RUN_KEY, "/v", "Codeply", "/t", "REG_SZ", "/d", &cmd, "/f"])
        } else {
            reg(&["delete", RUN_KEY, "/v", "Codeply", "/f"]) || !is_on()
        };
        if ok { Ok(()) } else { Err("Windows didn't let Yune change its startup setting.".into()) }
    }
    #[cfg(not(windows))]
    {
        let file = entry_file().ok_or("Couldn't find your home folder.")?;
        if !on {
            return match std::fs::remove_file(&file) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("Couldn't remove {}: {e}", file.display())),
            };
        }
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
        }
        std::fs::write(&file, entry_text(&exe.display().to_string())).map_err(|e| format!("Couldn't write {}: {e}", file.display()))
    }
}

#[cfg(not(windows))]
fn entry_file() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    if cfg!(target_os = "macos") {
        Some(home.join("Library/LaunchAgents/app.codeply.rune.plist"))
    } else {
        let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config"));
        Some(config.join("autostart/codeply.desktop"))
    }
}

/// The entry's text for this OS (the executable's path quoted for the format).
#[cfg(not(windows))]
fn entry_text(exe: &str) -> String {
    if cfg!(target_os = "macos") {
        let esc = exe.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n  <key>Label</key><string>app.codeply.rune</string>\n  <key>ProgramArguments</key><array><string>{esc}</string><string>--hidden</string></array>\n  <key>RunAtLoad</key><true/>\n</dict></plist>\n"
        )
    } else {
        // Desktop Entry Exec quoting: the path in double quotes, with \ " ` $ escaped.
        let q: String = exe.chars().flat_map(|c| if matches!(c, '\\' | '"' | '`' | '$') { vec!['\\', c] } else { vec![c] }).collect();
        format!("[Desktop Entry]\nType=Application\nName=Yune\nComment=Runs your agents' loops and reminders\nExec=\"{q}\" --hidden\nX-GNOME-Autostart-enabled=true\nTerminal=false\n")
    }
}

#[cfg(test)]
mod tests {
    #[cfg(not(windows))]
    #[test]
    fn the_login_entry_quotes_the_path() {
        let t = super::entry_text("/opt/Codeply App/codeply");
        if cfg!(target_os = "macos") {
            assert!(t.contains("<string>/opt/Codeply App/codeply</string><string>--hidden</string>"));
        } else {
            assert!(t.contains("Exec=\"/opt/Codeply App/codeply\" --hidden"));
        }
    }
}
