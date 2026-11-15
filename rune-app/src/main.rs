//! Codeply 4.0's native desktop shell, on Rune. See README.md.
// Windows release builds open as a window app, without a console behind them.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
//!
//!   codeply                         the window, with the sample data
//!   codeply --store live            talk to `codeply serve` (build with `--features live`)
//!   codeply --snap chat.png --scene chat --size 1440x900    a headless render (Rune tooling)

mod app;
mod art;
mod bot;
mod browser;
#[cfg(feature = "live")]
mod engine;
mod favicon;
mod icons;
mod logo;
mod look;
mod markdown;
mod model;
mod model_actions;
mod models;
mod prefs;
mod project;
mod shell;
mod store;
mod team;
mod theme;
mod thread;
mod ui;
mod update;
mod views;

use rune::{App as RuneApp, AppSpec, Titlebar};

use app::{App, EditKey, IntegrationsTab, PrTab, SettingsPage, View};

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
    ("code-tabs", |s| { s.go(View::Code); s.poll_code(); s.open_file("src/pricing/plans.json"); s.open_file("src/main.js"); s.open_file("src/pricing/pricing.js"); }),
    ("code-file-menu", |s| { s.go(View::Code); s.poll_code(); s.toggle_menu("code-file"); }),
    ("code-new-file", |s| { s.go(View::Code); s.poll_code(); s.open_code_dialog(crate::app::CodeDialog::New); s.edit_mut(EditKey::FilePath).replace_text("src/pricing/escape.js"); }),
    ("code-delete", |s| { s.go(View::Code); s.poll_code(); s.open_code_dialog(crate::app::CodeDialog::Delete("src/pricing/pricing.css".into())); }),
    ("chat-code", |s| {
        s.open_chat("Casual chat");
        let mut items = s.data.thread("Casual chat").to_vec();
        items.push(crate::model::ThreadItem::You("How do I escape the plan names?".into()));
        items.push(crate::model::ThreadItem::Them("Add a small helper and use it where the card is built:\n\n```js\nconst escape = (s) => String(s).replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);\n\nreturn `<article class=\"plan\">${escape(p.name)} ${escape(price)}</article>`;\n```\n\nPress **Apply** to put it in pricing.js.".into()));
        s.data.threads.push(("Casual chat".into(), items));
    }),
    ("code-ask", |s| { s.go(View::Code); s.poll_code(); s.code_ask = true; s.edit_mut(EditKey::CodeAsk).replace_text("Escape names and prices before they go into innerHTML"); }),
    ("code-edit", |s| { s.go(View::Code); s.poll_code(); s.edit_mut(EditKey::CodeAsk).replace_text("Escape names and prices before they go into innerHTML"); s.submit_code_ask(); }),
    ("code-ghost", |s| {
        s.go(View::Code);
        s.poll_code();
        let text = s.edit(EditKey::Code).text.clone();
        // The caret at the end of the line that starts "  const cards", and Wisp's suggestion there.
        if let Some(at) = text.find("const cards = plans.map((p) => {").map(|i| i + "const cards = plans.map((p) => {".len()) {
            s.edit_mut(EditKey::Code).set_caret(at);
            let file = s.data.extra.code.open.clone().unwrap_or_default();
            s.data.extra.code.suggestion = Some((file, at, " // one card per plan".into()));
        }
    }),
    ("prs", |s| s.go(View::Prs)),
    ("pr-changes", |s| { s.go(View::Prs); let n = s.data.prs.first().map_or(0, |p| p.number); s.open_pr(n, PrTab::Changes); }),
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
    ("settings-theme-preview", |s| { s.open_settings(SettingsPage::Appearance); s.theme_demo(); }),
    ("light-chat", |s| { s.prefs.look.mode = crate::look::Mode::Light; s.open_chat("Casual chat"); }),
    ("light-apps", |s| { s.prefs.look.mode = crate::look::Mode::Light; s.go(View::Integrations); s.integrations = IntegrationsTab::Apps; }),
    ("light-settings", |s| { s.prefs.look.mode = crate::look::Mode::Light; s.open_settings(SettingsPage::Appearance); }),
    ("settings-font-menu", |s| { s.open_settings(SettingsPage::Appearance); s.toggle_menu("font:ui"); }),
    ("settings-configuration", |s| s.open_settings(SettingsPage::Configuration)),
    ("settings-personalization", |s| s.open_settings(SettingsPage::Personalization)),
    ("settings-browser", |s| s.open_settings(SettingsPage::Browser)),
    ("settings-usage", |s| s.open_settings(SettingsPage::Usage)),
    ("settings-cloud", |s| s.open_settings(SettingsPage::Cloud)),
    ("settings-git", |s| s.open_settings(SettingsPage::Git)),
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
    ("agent-new", |s| { s.go(View::Agents); s.open_team_dialog(crate::team::TeamDialog::NewAgent); }),
    ("loop-new", |s| { s.open_agent(Some("frontend")); s.open_team_dialog(crate::team::TeamDialog::NewLoop("frontend".into())); }),
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
    ("prs-empty-norepo", |s| prs_empty(s, model::RepoState::default())),
    ("prs-empty-gh", |s| prs_empty(s, model::RepoState { repo: true, remote: true, branch: "main".into(), base: "main".into(), gh: "missing".into(), detail: String::new() })),
    ("prs-empty-auth", |s| { prs_empty(s, model::RepoState { repo: true, remote: true, branch: "main".into(), base: "main".into(), gh: "auth".into(), detail: String::new() }); s.panes.terminal = true; }),
    ("prs-empty-remote", |s| prs_empty(s, model::RepoState { repo: true, remote: false, branch: "main".into(), base: String::new(), gh: "remote".into(), detail: "origin  https://gitlab.com/sam/my-app.git (fetch)".into() })),
    ("prs-empty-branch", |s| prs_empty(s, model::RepoState { repo: true, remote: true, branch: "pricing-page".into(), base: "main".into(), gh: String::new(), detail: String::new() })),
    ("code-empty", |s| { s.go(View::Code); s.data.project = "my-app".into(); s.data.extra.code.files.clear(); s.data.extra.code.open = None; }),
    ("usage-week", |s| { s.new_chat(); s.toggle_usage(); s.usage_pick = Some("w20".into()); }),
    ("composer-attached", |s| {
        s.new_chat();
        s.attachments.insert(EditKey::ChatHome, vec!["C:\\Users\\sam\\Desktop\\brief.pdf".into(), "C:\\Users\\sam\\Pictures\\pricing-mock.png".into()]);
        s.edit_mut(EditKey::ChatHome).replace_text("Build the pricing page from these");
    }),
    ("code-agent", |s| {
        s.go(View::Code);
        s.poll_code();
        let chat = views::code::agent_chat(s);
        s.data.threads.push((chat, vec![
            model::ThreadItem::You("Make the pricing cards stack on phones, and give the featured one a blue border.".into()),
            model::ThreadItem::Event { icon: "file-text", text: "Read src/pricing/pricing.css".into() },
            model::ThreadItem::Event { icon: "edit", text: "Edited src/pricing/pricing.css, +14 lines".into() },
            model::ThreadItem::Them("Done. Under 640 px the cards now stack in one column, and `.plan.featured` has a 2 px blue border.\n\nSay **undo that** if you'd rather keep the old layout.".into()),
        ]));
    }),
    ("chat-search", |s| { s.new_chat(); s.chat_search = true; s.edit_mut(EditKey::Search).replace_text("pricing"); }),
    ("chat-steps", |s| {
        s.open_chat("Casual chat");
        if let Some(c) = s.data.extra.chats.iter_mut().find(|c| c.title == "Casual chat") {
            c.running = true;
        }
        let mut items = s.data.thread("Casual chat").to_vec();
        items.push(model::ThreadItem::You("Can you start a server to run this?".into()));
        items.push(model::ThreadItem::Event { icon: "file-text", text: "Read index.html".into() });
        items.push(model::ThreadItem::Event { icon: "terminal", text: "Ran `python -m http.server 8080`".into() });
        items.push(model::ThreadItem::Them("It's running at http://127.0.0.1:8080/ and http://localhost:8080/.".into()));
        items.push(model::ThreadItem::You("ok can u make it like iMessage?".into()));
        items.push(model::ThreadItem::Event { icon: "file-text", text: "Read style.css".into() });
        s.data.threads.push(("Casual chat".into(), items));
        s.data.extra.step_now.push(("Casual chat".into(), "Editing style.css".into()));
    }),
    ("agent-sessions", |s| s.open_agent(Some("frontend"))),
    ("update-offer", |s| { s.new_chat(); s.updater.show(update::Phase::Offer(sample_release())); }),
    ("update-downloading", |s| { s.new_chat(); s.updater.show(update::Phase::Fetching { version: "4.0.140".into(), done: 31_000_000, total: 74_000_000, setup: true }); }),
    ("update-ready", |s| { s.new_chat(); s.updater.show(update::Phase::Ready(sample_release())); }),
    ("settings-update", |s| { s.open_settings(SettingsPage::General); s.updater.show(update::Phase::Ready(sample_release())); }),
];

/// A release for the update scenes.
fn sample_release() -> update::Release {
    update::Release {
        version: "4.0.140".into(),
        engine: "8f3a2c1d9e7b6a50".into(),
        notes: "- Open any folder as your project, from Code or Pull requests\n- Pull requests says what's missing and fixes it: git, the GitHub CLI, signing in\n- New file works in folders that don't exist yet\n- A newer engine (codeply-cli 4.2)".into(),
        setup_url: "https://example.invalid/Codeply-Setup.exe".into(),
        ..Default::default()
    }
}

/// The Pull requests page with nothing to list, as the engine would describe the project.
fn prs_empty(s: &mut App, repo: model::RepoState) {
    s.go(View::Prs);
    s.data.project = "my-app".into();
    s.data.prs.clear();
    s.data.extra.prs_note = match repo.gh.as_str() {
        "missing" => "The GitHub CLI (gh) isn't installed.".into(),
        "auth" => "Sign in to GitHub to see pull requests.".into(),
        "remote" => "This project has no GitHub remote yet.".into(),
        _ => String::new(),
    };
    s.data.extra.repo = Some(repo);
}

/// The app's own flags (Rune takes its own first): `--store mock|live`, `--server URL`, `--token PW`.
fn flag(name: &str) -> Option<String> {
    let args = rune::extra_args();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn init() -> App {
    let mut app = init_store();
    if let Some(spec) = flag("--look") {
        app.look_flags(&spec);
    }
    app
}

fn init_store() -> App {
    match flag("--store").as_deref() {
        Some("mock") => App::with_mock(),
        #[cfg(feature = "live")]
        Some("live") => {
            let url = flag("--server").or_else(|| std::env::var("CODEPLY_SERVER").ok()).unwrap_or_else(|| "http://127.0.0.1:4096".into());
            let token = flag("--token").or_else(|| std::env::var("CODEPLY_TOKEN").ok()).unwrap_or_default();
            let mut app = App::new(Box::new(store::live::LiveStore::new(&url, &token)));
            app.look.set_remote(&url, &token);
            app
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
                app.look.set_remote(&sidecar.url, &sidecar.token);
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
        fonts: theme::BUNDLED_FONTS,
        setup: Some(|s, waker| s.set_waker(waker)),
        poll: Some(|s, now, tx| s.poll(now, tx)),
        on_key: Some(|s, e, tx| s.key(e, tx)),
        ..AppSpec::new("Codeply", (1440.0, 900.0), init, shell::view)
    }
}

/// Windows: draw on the GPU when this PC has a real one, else on Rune's CPU renderer. Rune opens
/// a window on the CPU and hands it to a GPU swap chain a moment later; on PCs without a working
/// GPU (WARP, the basic display driver) that hand-over draws a broken frame (text missing, wrong
/// scale, clicks falling through), so those stay on the CPU. `CODEPLY_GPU=1` or `=0` forces it.
fn prefer_cpu_renderer() {
    if !cfg!(windows) || std::env::var_os("RUNE_CPU_FIRST").is_some() {
        return;
    }
    let cpu = match std::env::var("CODEPLY_GPU").as_deref() {
        Ok("1") => false,
        Ok("0") => true,
        _ => !has_real_gpu(),
    };
    if cpu {
        // SAFETY: called first thing in main, before any other thread exists, so nothing can be
        // reading the environment concurrently.
        #[allow(unsafe_code)]
        unsafe {
            std::env::set_var("RUNE_CPU_FIRST", "only");
        }
    }
}

/// A Direct3D 12 adapter that's a real graphics chip (integrated or discrete), not Microsoft's
/// software one (vendor 0x1414: WARP, the Basic Render Driver).
#[cfg(windows)]
fn has_real_gpu() -> bool {
    let mut d = wgpu::InstanceDescriptor::new_without_display_handle();
    d.backends = wgpu::Backends::DX12;
    let instance = wgpu::Instance::new(d);
    pollster::block_on(instance.enumerate_adapters(wgpu::Backends::DX12)).iter().any(|a| {
        let info = a.get_info();
        matches!(info.device_type, wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu)
            && info.vendor != 0x1414
            && !info.name.contains("Basic Render")
    })
}

#[cfg(not(windows))]
fn has_real_gpu() -> bool {
    true
}

fn main() {
    prefer_cpu_renderer();
    if !rune::is_headless() {
        update::clean_up();
    }
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
