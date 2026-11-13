//! Codeply 4.0's native desktop shell, on Rune. See README.md.
// Windows release builds open as a window app, without a console behind them.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
//!
//!   codeply                         the window, with the sample data
//!   codeply --store live            talk to `codeply serve` (build with `--features live`)
//!   codeply --snap office.png --scene office --size 1440x900    a headless render (Rune tooling)

mod app;
mod bot;
mod icons;
mod model;
mod shell;
mod store;
mod theme;
mod ui;
mod views;

use rune::{App as RuneApp, AppSpec, Titlebar};

use app::{App, View};

/// Named states for headless renders and tests (`--scene NAME`).
type Scene = (&'static str, fn(&mut App));

const SCENES: &[Scene] = &[
    ("office", |s| s.go(View::Office)),
    ("office-drawer", |s| { s.go(View::Office); s.open_drawer("frontend"); }),
    ("office-inbox", |s| { s.go(View::Office); s.open_drawer("inbox"); }),
    ("board", |s| s.go(View::Board)),
    ("appearance", |s| { s.go(View::Board); s.toggle_appearance("backend"); }),
    ("chat", |s| s.go(View::Chat)),
    ("chat-thread", |s| { s.go(View::Chat); s.chat = Some("Casual chat".into()); }),
    ("code", |s| s.go(View::Code)),
    ("prs", |s| s.go(View::Prs)),
    ("apps", |s| s.go(View::Apps)),
    ("settings", |s| s.go(View::Settings)),
];

/// The app's own flags (Rune takes its own first): `--store mock|live`, `--server URL`, `--token PW`.
fn flag(name: &str) -> Option<String> {
    let args = rune::extra_args();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn init() -> App {
    match flag("--store").as_deref() {
        #[cfg(feature = "live")]
        Some("live") => {
            let url = flag("--server").or_else(|| std::env::var("CODEPLY_SERVER").ok()).unwrap_or_else(|| "http://127.0.0.1:4096".into());
            let token = flag("--token").or_else(|| std::env::var("CODEPLY_TOKEN").ok()).unwrap_or_default();
            App::new(Box::new(store::live::LiveStore::new(&url, &token)))
        }
        #[cfg(not(feature = "live"))]
        Some("live") => {
            eprintln!("codeply: this build has no live store; rebuild with `--features live`. Using the sample data.");
            App::with_mock()
        }
        _ => App::with_mock(),
    }
}

fn spec() -> AppSpec<App> {
    AppSpec {
        min_size: Some((960.0, 640.0)),
        scenes: SCENES,
        families: (theme::UI_FAMILIES, theme::MONO_FAMILIES),
        setup: Some(|s, waker| s.set_waker(waker)),
        poll: Some(|s, now, tx| s.poll(now, tx)),
        on_key: Some(|s, e, tx| s.key(e, tx)),
        ..AppSpec::new("Codeply", (1440.0, 900.0), init, shell::view)
    }
}

fn main() {
    rune::prewarm_gpu();
    RuneApp::new(spec()).titlebar(Titlebar::new(shell::TITLEBAR)).run();
}

#[cfg(test)]
mod tests;
