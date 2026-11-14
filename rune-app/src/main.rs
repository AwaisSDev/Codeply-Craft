//! Codeply 4.0's native desktop shell, on Rune. See README.md.
// Windows release builds open as a window app, without a console behind them.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
//!
//!   codeply                         the window, with the sample data
//!   codeply --store live            talk to `codeply serve` (build with `--features live`)
//!   codeply --snap chat.png --scene chat --size 1440x900    a headless render (Rune tooling)

mod app;
mod bot;
mod browser;
#[cfg(feature = "live")]
mod engine;
mod favicon;
mod icons;
mod logo;
mod markdown;
mod model;
mod model_actions;
mod models;
mod prefs;
mod shell;
mod store;
mod theme;
mod thread;
mod ui;
mod views;

use rune::{App as RuneApp, AppSpec, Titlebar};

use app::{App, IntegrationsTab, PrTab, SettingsPage, View};

/// Named states for headless renders and tests (`--scene NAME`).
type Scene = (&'static str, fn(&mut App));

const SCENES: &[Scene] = &[
    ("agents", |s| s.go(View::Agents)),
    ("agent", |s| s.open_agent(Some("frontend"))),
    ("agent-wisp", |s| s.open_agent(Some("wisp"))),
    ("appearance", |s| { s.go(View::Agents); s.toggle_appearance("backend"); }),
    ("chat", |s| s.new_chat()),
    ("chat-thread", |s| s.open_chat("Casual chat")),
    ("chat-menu", |s| { s.open_chat("Casual chat"); s.toggle_menu("chat-head:Casual chat"); }),
    ("model-menu", |s| { s.new_chat(); s.toggle_menu("model:chat-home"); }),
    ("code", |s| s.go(View::Code)),
    ("prs", |s| s.go(View::Prs)),
    ("pr-changes", |s| { s.go(View::Prs); s.pr_tab = PrTab::Changes; }),
    ("chat-browser", |s| { s.open_chat("Casual chat"); s.panes.browser = true; }),
    ("chat-workspace", |s| { s.open_chat("Casual chat"); s.panes.browser = true; s.panes.terminal = true; s.panes.tasks = true; }),
    ("chat-terminal", |s| { s.open_chat("Casual chat"); s.panes.terminal = true; }),
    ("integrations", |s| s.go(View::Integrations)),
    ("integrations-apps", |s| { s.go(View::Integrations); s.integrations = IntegrationsTab::Apps; }),
    ("apps-connecting", |s| {
        s.go(View::Integrations);
        s.integrations = IntegrationsTab::Apps;
        s.data.extra.apps.progress = Some(model::AppProgress { id: "discord".into(), name: "Discord".into(), state: "waiting".into(), message: "Finish signing in to Discord in your browser...".into() });
    }),
    ("apps-add", |s| { s.go(View::Integrations); s.integrations = IntegrationsTab::Apps; s.apps_ui.dialog = Some(views::apps::Dialog::Add); }),
    ("apps-manage", |s| {
        s.go(View::Integrations);
        s.integrations = IntegrationsTab::Apps;
        s.apps_ui.dialog = Some(views::apps::Dialog::Manage("slack".into()));
        s.app_tools("slack");
    }),
    ("integrations-mcp", |s| { s.go(View::Integrations); s.integrations = IntegrationsTab::Mcp; }),
    ("settings", |s| s.open_settings(SettingsPage::General)),
    ("settings-appearance", |s| s.open_settings(SettingsPage::Appearance)),
    ("settings-configuration", |s| s.open_settings(SettingsPage::Configuration)),
    ("settings-personalization", |s| s.open_settings(SettingsPage::Personalization)),
    ("settings-browser", |s| s.open_settings(SettingsPage::Browser)),
    ("settings-usage", |s| s.open_settings(SettingsPage::Usage)),
    ("chat-thinking", |s| {
        s.open_chat("Casual chat");
        if let Some(c) = s.data.extra.chats.iter_mut().find(|c| c.title == "Casual chat") {
            c.running = true;
        }
        let mut items = s.data.thread("Casual chat").to_vec();
        items.push(crate::model::ThreadItem::You("Can you check the build before I ship?".into()));
        s.data.threads.push(("Casual chat".into(), items));
    }),
    ("usage", |s| { s.new_chat(); s.toggle_usage(); }),
    ("usage-daily", |s| { s.new_chat(); s.toggle_usage(); s.usage_daily = true; s.usage_pick = Some("d2026-11-12".into()); }),
    ("settings-models", |s| s.open_settings(SettingsPage::Models)),
    ("settings-models-add", |s| { s.open_settings(SettingsPage::Models); s.model_open_form(None); }),
    ("settings-models-edit", |s| { s.open_settings(SettingsPage::Models); s.model_open_form(Some("m1")); }),
    ("settings-models-error", |s| {
        s.open_settings(SettingsPage::Models);
        s.model_open_form(None);
        s.models_ui.preset(0);
        s.data.extra.models.error = Some("api.openai.com answered HTTP 401 Unauthorized.".into());
        s.data.extra.models.test_failed = true;
    }),
    ("settings-models-ollama", |s| { s.open_settings(SettingsPage::Models); s.model_scan(); }),
    ("model-menu-custom", |s| { s.model_pick("m1"); s.new_chat(); s.toggle_menu("model:chat-home"); }),
];

/// The app's own flags (Rune takes its own first): `--store mock|live`, `--server URL`, `--token PW`.
fn flag(name: &str) -> Option<String> {
    let args = rune::extra_args();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn init() -> App {
    match flag("--store").as_deref() {
        Some("mock") => App::with_mock(),
        #[cfg(feature = "live")]
        Some("live") => {
            let url = flag("--server").or_else(|| std::env::var("CODEPLY_SERVER").ok()).unwrap_or_else(|| "http://127.0.0.1:4096".into());
            let token = flag("--token").or_else(|| std::env::var("CODEPLY_TOKEN").ok()).unwrap_or_default();
            App::new(Box::new(store::live::LiveStore::new(&url, &token)))
        }
        // Headless renders and tests keep the sample data, so screenshots are stable
        // (`--store engine` starts the engine there too).
        Some(s) if s != "engine" && rune::is_headless() => App::with_mock(),
        None if rune::is_headless() => App::with_mock(),
        // The default: start the installed Codeply app's engine (DSH) and talk to it.
        #[cfg(feature = "live")]
        _ => match engine::start() {
            Ok(sidecar) => {
                let live = store::live::LiveStore::new(&sidecar.url, &sidecar.token).labelled("Codeply engine (DSH)");
                let mut app = App::new(Box::new(live));
                app.sidecar = Some(sidecar);
                app
            }
            Err(why) => {
                let mut app = App::with_mock();
                app.data.source = format!("Sample data. {why}");
                app.data.extra.engine = "Sample data".into();
                app
            }
        },
        #[cfg(not(feature = "live"))]
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

/// Windows: keep windows on Rune's CPU renderer. Rune opens a window on the CPU and hands it to
/// a GPU swap chain a moment later; on PCs without a working GPU (WARP, the basic display driver,
/// some integrated chips) that hand-over draws a broken frame (text missing, wrong scale, clicks
/// falling through). This UI is light enough for the CPU. `CODEPLY_GPU=1` keeps the GPU path.
fn prefer_cpu_renderer() {
    let wanted = cfg!(windows) && std::env::var_os("RUNE_CPU_FIRST").is_none() && std::env::var_os("CODEPLY_GPU").is_none_or(|v| v != "1");
    if wanted {
        // SAFETY: called first thing in main, before any other thread exists, so nothing can be
        // reading the environment concurrently.
        #[allow(unsafe_code)]
        unsafe {
            std::env::set_var("RUNE_CPU_FIRST", "only");
        }
    }
}

fn main() {
    prefer_cpu_renderer();
    rune::prewarm_gpu();
    RuneApp::new(spec())
        .titlebar(Titlebar::new(shell::TITLEBAR))
        // The built-in browser makes its web views inside this window.
        .on_window(browser::set_window)
        .run();
}

#[cfg(test)]
mod model_tests;
#[cfg(test)]
mod tests;
