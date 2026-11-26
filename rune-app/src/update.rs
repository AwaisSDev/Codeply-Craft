//! Updates, from the release CI publishes (`latest.json` beside Codeply.exe and
//! Codeply-Setup.exe; see .github/workflows/rune-windows.yml).
//!
//! - A small update (only Codeply.exe changed: UI, icons, text; the engine id matches this
//!   build's) downloads on its own: the running exe is renamed to Codeply.old.exe, the new one
//!   takes its name, and "Restart to update" switches to it (or the next launch does).
//! - A bigger one (the engine changed: dsh-runtime or codeply-cli) shows the update screen with
//!   its version and notes; "Update now" downloads Codeply-Setup.exe, checks it and runs it.
//!
//! The version and engine id are baked in at build time (`CODEPLY_VERSION`, `CODEPLY_ENGINE_ID`).

use std::sync::{Arc, Mutex};

use rune::Tx;

use crate::app::App;

/// This build's version, like 4.0.312 (CI sets it from the run number).
pub const VERSION: &str = match option_env!("CODEPLY_VERSION") {
    Some(v) => v,
    None => "4.0.0-dev",
};
/// A hash of the engine this build ships with (codeply-cli and craft-dsh): when the release's
/// differs, the update needs the installer.
pub const ENGINE_ID: &str = match option_env!("CODEPLY_ENGINE_ID") {
    Some(v) => v,
    None => "dev",
};
/// Where the newest release describes itself.
pub const FEED: &str = match option_env!("CODEPLY_UPDATE_FEED") {
    Some(v) => v,
    None => "https://github.com/AwaisSDev/Codeply-Craft/releases/download/rune-v5-windows-latest/latest.json",
};
/// How often a running app looks again.
const EVERY: f64 = 6.0 * 3600.0;

/// A release, as `latest.json` describes it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Release {
    pub version: String,
    pub engine: String,
    pub exe_url: String,
    pub exe_sha256: String,
    pub setup_url: String,
    pub setup_sha256: String,
    pub notes: String,
}

impl Release {
    pub fn from_json(v: &serde_json::Value) -> Option<Release> {
        let s = |x: &serde_json::Value| x.as_str().unwrap_or_default().to_owned();
        let r = Release {
            version: s(&v["version"]),
            engine: s(&v["engine"]),
            exe_url: s(&v["exe"]["url"]),
            exe_sha256: s(&v["exe"]["sha256"]).to_lowercase(),
            setup_url: s(&v["setup"]["url"]),
            setup_sha256: s(&v["setup"]["sha256"]).to_lowercase(),
            notes: s(&v["notes"]),
        };
        (!r.version.is_empty() && !r.setup_url.is_empty()).then_some(r)
    }

    /// Only Codeply.exe changed: the engine this build carries is the release's.
    pub fn is_small(&self) -> bool {
        !self.exe_url.is_empty() && !self.exe_sha256.is_empty() && self.engine == ENGINE_ID && ENGINE_ID != "dev"
    }
}

/// Whether version `a` is newer than `b` (dotted numbers; "4.0.12" > "4.0.9"; a suffix like
/// "-dev" counts as older than the same numbers without one).
pub fn newer(a: &str, b: &str) -> bool {
    let parts = |v: &str| -> (Vec<u64>, bool) {
        let (nums, suffix) = v.split_once('-').map_or((v, false), |(n, _)| (n, true));
        (nums.split('.').map(|p| p.trim().parse().unwrap_or(0)).collect(), suffix)
    };
    let ((mut x, xs), (mut y, ys)) = (parts(a), parts(b));
    let n = x.len().max(y.len());
    x.resize(n, 0);
    y.resize(n, 0);
    match x.cmp(&y) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Equal => ys && !xs,
    }
}

/// Where the updater is.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Phase {
    #[default]
    Idle,
    Checking,
    /// This is the newest.
    Current,
    /// Downloading: the release, bytes so far and in all (0 when unknown), and whether it's the
    /// installer.
    Fetching { version: String, done: u64, total: u64, setup: bool },
    /// A small update is in place: restarting switches to it.
    Ready(Release),
    /// A bigger update waits for "Update now".
    Offer(Release),
    /// The installer is running; the app quits so it can replace it.
    Installing,
    Failed(String),
}

/// The updater's state, shared with its download thread.
#[derive(Default)]
pub struct Updater {
    shared: Arc<Mutex<Phase>>,
    /// What the view shows (copied from `shared` on each poll).
    pub phase: Phase,
    /// "Later" on the update screen: it stays closed until the next release.
    pub dismissed: Option<String>,
    waker: Option<rune::Waker>,
    next_check: f64,
    quit_sent: bool,
}

impl Updater {
    pub fn set_waker(&mut self, w: rune::Waker) {
        self.waker = Some(w);
    }

    fn set(shared: &Arc<Mutex<Phase>>, waker: &Option<rune::Waker>, p: Phase) {
        if let Ok(mut g) = shared.lock() {
            *g = p;
        }
        if let Some(w) = waker {
            w();
        }
    }

    /// The update screen shows: a bigger update you haven't put off, or its download.
    pub fn screen(&self) -> bool {
        match &self.phase {
            Phase::Offer(r) => self.dismissed.as_deref() != Some(r.version.as_str()),
            Phase::Fetching { setup: true, .. } | Phase::Installing => true,
            _ => false,
        }
    }

    /// A test or a scene: show this phase.
    #[allow(dead_code)]
    pub fn show(&mut self, p: Phase) {
        Updater::set(&self.shared, &None, p.clone());
        self.phase = p;
    }
}

/// Where updates can run: the Windows app, not headless renders or tests.
fn enabled() -> bool {
    cfg!(all(windows, feature = "live")) && !rune::is_headless() && !cfg!(test)
}

impl App {
    /// Looks for an update now (Settings' "Check for updates", and at launch).
    pub fn check_updates(&mut self) {
        if !matches!(self.updater.phase, Phase::Idle | Phase::Current | Phase::Failed(_)) {
            return;
        }
        if !enabled() {
            self.updater.show(Phase::Failed("Updates come with the Windows app.".into()));
            return;
        }
        let (shared, waker) = (self.updater.shared.clone(), self.updater.waker.clone());
        Updater::set(&shared, &waker, Phase::Checking);
        std::thread::spawn(move || {
            let next = net::check(&shared, &waker);
            Updater::set(&shared, &waker, next);
        });
    }

    /// "Update now": download the installer, check it, run it, and quit so it can replace us.
    pub fn install_update(&mut self) {
        let Phase::Offer(r) = self.updater.phase.clone() else { return };
        let (shared, waker) = (self.updater.shared.clone(), self.updater.waker.clone());
        Updater::set(&shared, &waker, Phase::Fetching { version: r.version.clone(), done: 0, total: 0, setup: true });
        std::thread::spawn(move || {
            let next = net::run_setup(&r, &shared, &waker);
            Updater::set(&shared, &waker, next);
        });
    }

    /// "Restart to update": open the new Codeply.exe and close this one.
    pub fn restart_to_update(&mut self, tx: &mut Tx) {
        match net::start_again() {
            Ok(()) => tx.quit(),
            Err(e) => self.notice = Some(format!("Couldn't restart: {e}. Close Yune and open it again to update.")),
        }
    }

    /// "Later" on the update screen.
    pub fn later_update(&mut self) {
        if let Phase::Offer(r) = &self.updater.phase {
            self.updater.dismissed = Some(r.version.clone());
        }
    }

    /// From `poll`: the download thread's news, a look at launch and every few hours, and quitting
    /// once the installer runs. True when the view should rebuild.
    pub fn step_updates(&mut self, now: f64, tx: &mut Tx) -> bool {
        if enabled() && now >= self.updater.next_check {
            self.updater.next_check = now + EVERY;
            tx.wake_after(std::time::Duration::from_secs_f64(EVERY));
            self.check_updates();
        }
        let p = self.updater.shared.lock().map(|g| g.clone()).unwrap_or_default();
        if p == self.updater.phase {
            return false;
        }
        if p == Phase::Installing && !self.updater.quit_sent {
            self.updater.quit_sent = true;
            tx.quit();
        }
        self.updater.phase = p;
        true
    }
}

/// Removes what the last small update left (the old exe, a half-done download). At launch.
pub fn clean_up() {
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let _ = std::fs::remove_file(dir.join("Codeply.old.exe"));
        let _ = std::fs::remove_file(dir.join("Codeply.new.exe"));
    }
}

#[cfg(feature = "live")]
mod net {
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use sha2::{Digest, Sha256};

    use super::{ENGINE_ID, FEED, Phase, Release, Updater, VERSION, newer};

    fn agent() -> ureq::Agent {
        ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout_read(Duration::from_secs(60)).redirects(8).build()
    }

    fn release() -> Result<Release, String> {
        let v: serde_json::Value = agent().get(FEED).call().map_err(|e| e.to_string())?.into_json().map_err(|e| e.to_string())?;
        Release::from_json(&v).ok_or_else(|| "The update feed isn't readable.".into())
    }

    /// The folder Codeply.exe runs from, if Codeply may write there.
    fn exe_dir() -> Option<(PathBuf, PathBuf)> {
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?.to_path_buf();
        let probe = dir.join(".codeply-update-probe");
        std::fs::write(&probe, b"").ok()?;
        let _ = std::fs::remove_file(&probe);
        // The running exe's own name: an update keeps the shortcut's target.
        let target = dir.join("Codeply.exe");
        Some((dir, if target.exists() { target } else { exe }))
    }

    /// Downloads `url` to `to`, reporting progress, and checks it against `sha` (hex).
    fn download(url: &str, sha: &str, to: &Path, mut progress: impl FnMut(u64, u64)) -> Result<(), String> {
        let resp = agent().get(url).call().map_err(|e| e.to_string())?;
        let total = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
        let mut body = resp.into_reader();
        let mut file = std::fs::File::create(to).map_err(|e| format!("{}: {e}", to.display()))?;
        let mut hash = Sha256::new();
        let (mut buf, mut done, mut last) = (vec![0u8; 64 * 1024], 0u64, 0u64);
        loop {
            let n = body.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            if done - last > 256 * 1024 {
                last = done;
                progress(done, total);
            }
        }
        file.flush().map_err(|e| e.to_string())?;
        drop(file);
        let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if !sha.is_empty() && got != sha {
            let _ = std::fs::remove_file(to);
            return Err("The download didn't match its checksum.".into());
        }
        Ok(())
    }

    /// Puts `new` in place of the running exe: the running one becomes Codeply.old.exe
    /// (Windows lets a running exe be renamed, not overwritten).
    fn swap(target: &Path, new: &Path) -> Result<(), String> {
        let old = target.with_file_name("Codeply.old.exe");
        let _ = std::fs::remove_file(&old);
        std::fs::rename(target, &old).map_err(|e| format!("couldn't move the running app aside: {e}"))?;
        if let Err(e) = std::fs::rename(new, target) {
            let _ = std::fs::rename(&old, target);
            return Err(format!("couldn't put the update in place: {e}"));
        }
        Ok(())
    }

    pub fn check(shared: &Arc<Mutex<Phase>>, waker: &Option<rune::Waker>) -> Phase {
        let r = match release() {
            Ok(r) => r,
            Err(e) => return Phase::Failed(format!("Couldn't check for updates: {e}")),
        };
        if !newer(&r.version, VERSION) {
            return Phase::Current;
        }
        if !r.is_small() {
            return Phase::Offer(r);
        }
        let Some((dir, target)) = exe_dir() else { return Phase::Offer(r) };
        let new = dir.join("Codeply.new.exe");
        let version = r.version.clone();
        let fetched = download(&r.exe_url, &r.exe_sha256, &new, |done, total| {
            Updater::set(shared, waker, Phase::Fetching { version: version.clone(), done, total, setup: false });
        });
        match fetched.and_then(|()| swap(&target, &new)) {
            Ok(()) => Phase::Ready(r),
            // The installer can still do it.
            Err(_) => {
                let _ = std::fs::remove_file(&new);
                Phase::Offer(r)
            }
        }
    }

    pub fn run_setup(r: &Release, shared: &Arc<Mutex<Phase>>, waker: &Option<rune::Waker>) -> Phase {
        let to = std::env::temp_dir().join(format!("Codeply-Setup-{}.exe", r.version));
        let version = r.version.clone();
        if let Err(e) = download(&r.setup_url, &r.setup_sha256, &to, |done, total| {
            Updater::set(shared, waker, Phase::Fetching { version: version.clone(), done, total, setup: true });
        }) {
            return Phase::Failed(format!("The update didn't download: {e}"));
        }
        // Silent: the installer shows its progress, closes Codeply and its engine, and opens the
        // new one when it's done (codeply.iss).
        match std::process::Command::new(&to).args(["/SP-", "/SILENT", "/NOCANCEL", "/NORESTART"]).spawn() {
            Ok(_) => Phase::Installing,
            Err(e) => Phase::Failed(format!("Couldn't start the installer: {e}")),
        }
    }

    /// Opens Codeply.exe (the updated one) again with this run's arguments.
    pub fn start_again() -> Result<(), String> {
        let (_, target) = exe_dir().ok_or("the app's folder isn't writable")?;
        std::process::Command::new(target).args(std::env::args().skip(1)).spawn().map(|_| ()).map_err(|e| e.to_string())
    }

    #[allow(dead_code)]
    pub fn engine_id() -> &'static str {
        ENGINE_ID
    }
}

#[cfg(not(feature = "live"))]
mod net {
    use std::sync::{Arc, Mutex};

    use super::{Phase, Release};

    pub fn check(_: &Arc<Mutex<Phase>>, _: &Option<rune::Waker>) -> Phase {
        Phase::Failed("This build has no network.".into())
    }
    pub fn run_setup(_: &Release, _: &Arc<Mutex<Phase>>, _: &Option<rune::Waker>) -> Phase {
        Phase::Failed("This build has no network.".into())
    }
    pub fn start_again() -> Result<(), String> {
        Err("this build can't update".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_by_number() {
        assert!(newer("4.0.12", "4.0.9"));
        assert!(newer("4.1.0", "4.0.99"));
        assert!(!newer("4.0.9", "4.0.9"));
        assert!(!newer("4.0.8", "4.0.9"));
        assert!(newer("4.0.1", "4.0.0-dev"), "a dev build updates to the first release");
        assert!(newer("4.0.1", "4.0"));
    }

    #[test]
    fn a_release_reads_from_its_feed() {
        let v = serde_json::json!({
            "version": "4.0.42", "engine": "abc", "notes": "Faster tabs",
            "exe": { "url": "https://x/Codeply.exe", "sha256": "AB12" },
            "setup": { "url": "https://x/Codeply-Setup.exe", "sha256": "cd34" },
        });
        let r = Release::from_json(&v).unwrap_or_default();
        assert_eq!((r.version.as_str(), r.exe_sha256.as_str(), r.setup_url.as_str()), ("4.0.42", "ab12", "https://x/Codeply-Setup.exe"));
        // A dev build never swaps its exe: it can't know its engine.
        assert!(!r.is_small());
        assert!(Release::from_json(&serde_json::json!({ "version": "1" })).is_none());
    }
}
