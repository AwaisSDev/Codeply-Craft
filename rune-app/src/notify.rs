//! Desktop notifications: the PC's counterpart of the phone's push, for a job report, a reminder
//! coming due or an agent that needs you, while Codeply is open. Settings > General >
//! Notifications turns them off (the bell still lists them).
//!
//! No extra crates: each OS's own tool shows it. The title and text travel as environment
//! variables or arguments, never inside a script, so nothing in them can run.

use std::process::{Command, Stdio};

/// Shows one notification, off the UI thread. Never fails loudly: a PC without the tool just
/// doesn't show it.
pub fn show(title: &str, body: &str) {
    if rune::is_headless() || std::env::var_os("CODEPLY_NO_NOTIFY").is_some() {
        return;
    }
    let (title, body) = (clip(title, 80), clip(body, 240));
    std::thread::spawn(move || {
        let _ = command(&title, &body).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    });
}

fn clip(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(n.saturating_sub(3)).collect();
    out.push_str("...");
    out
}

#[cfg(windows)]
fn command(title: &str, body: &str) -> Command {
    use std::os::windows::process::CommandExt;
    // A toast through WinRT, as PowerShell's own app id (so it needs no install step).
    const SCRIPT: &str = r#"
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
$t.Item(0).AppendChild($x.CreateTextNode($env:CODEPLY_NOTE_TITLE)) > $null
$t.Item(1).AppendChild($x.CreateTextNode($env:CODEPLY_NOTE_BODY)) > $null
$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))
"#;
    let mut c = Command::new("powershell");
    c.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", SCRIPT])
        .env("CODEPLY_NOTE_TITLE", title)
        .env("CODEPLY_NOTE_BODY", body)
        // CREATE_NO_WINDOW: no console flashes up.
        .creation_flags(0x0800_0000);
    c
}

#[cfg(target_os = "macos")]
fn command(title: &str, body: &str) -> Command {
    let mut c = Command::new("osascript");
    c.args(["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body]);
    c
}

#[cfg(all(unix, not(target_os = "macos")))]
fn command(title: &str, body: &str) -> Command {
    // notify-send reads the text as markup: "&" or "<b>" in a reminder would vanish or break it.
    let plain = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let mut c = Command::new("notify-send");
    c.args(["--app-name=Yune", "--", &plain(title), &plain(body)]);
    c
}
