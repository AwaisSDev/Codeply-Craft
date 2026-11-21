//! Codeply 4.0's native desktop shell, on Rune. See README.md.
// Windows release builds open as a window app, without a console behind them.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
//!
//!   codeply                         the window, with the sample data
//!   codeply --store live            talk to `codeply serve` (build with `--features live`)
//!   codeply --snap chat.png --scene chat --size 1440x900    a headless render (Rune tooling)

mod agentsync;
mod app;
mod art;
mod bot;
mod browser;
mod complete;
mod editor;
#[cfg(feature = "live")]
mod engine;
mod favicon;
mod flow;
mod icons;
mod logo;
mod look;
mod markdown;
mod mentions;
mod model;
mod model_actions;
mod notify;
mod models;
mod prefs;
mod project;
mod run;
mod shell;
mod store;
mod subagents;
mod team;
mod theme;
mod thread;
mod ui;
mod update;
mod voice;
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
    // The phone's agent features on the PC: reminders, a specialist's editor, Always on and
    // runs' health (retrying, needs you), job reports.
    ("reminders", |s| s.open_reminders()),
    ("bell-reports", |s| { s.go(View::Agents); s.toggle_menu("notifications"); }),
    ("reminders-notifications-off", |s| { s.prefs.notifications = false; s.open_reminders(); }),
    ("agent-inbox", |s| s.open_agent(Some("inbox"))),
    ("agent-health", |s| s.open_agent(Some("backend"))),
    ("spec-edit", |s| { s.open_agent(Some("inbox")); s.open_team_dialog(crate::team::TeamDialog::Edit("inbox".into())); }),
    ("spec-edit-builtin", |s| { s.open_agent(Some("frontend")); s.open_team_dialog(crate::team::TeamDialog::Edit("frontend".into())); }),
    ("chat", |s| s.new_chat()),
    // The composer's folder menu: eight folders opened before, five showing.
    ("chat-folders", |s| {
        s.new_chat();
        for name in ["old-blog", "dotfiles", "api-server", "mobile-app", "landing-page", "docs-site", "design-system", "Codeply"] {
            s.prefs.note_project(&format!("/home/sam/code/{name}"));
        }
        s.toggle_menu("project:chat-home");
    }),
    // Dictation: the mic recording into the home composer.
    ("chat-recording", |s| { s.new_chat(); s.voice.phase = crate::voice::Phase::Recording(EditKey::ChatHome); }),
    ("chat-thread", |s| s.open_chat("Casual chat")),
    ("subagents", |s| { s.open_chat("Casual chat"); s.panes.tasks = true; }),
    ("subagent-open", |s| { s.open_chat("Casual chat"); s.panes.tasks = true; s.toggle_subagent("ag1"); }),
    ("team-open", |s| { s.open_chat("Casual chat"); s.panes.tasks = true; s.toggle_team("sw1"); }),
    ("agent-tabs", |s| {
        s.open_chat("Casual chat");
        s.panes.browser = true;
        s.panes.tasks = true;
        for a in s.data.extra.subagents.agents.clone().iter().take(2) {
            let id = s.browser.tabs.len() as u64 + 10;
            s.browser.tabs.push(crate::browser::Tab { id, url: "http://localhost:5173/pricing".into(), title: a.name.clone(), loading: false, agent: Some(crate::browser::TabAgent { id: a.id.clone(), name: a.name.clone(), color: a.color.clone(), look: a.look.clone() }) });
        }
    }),
    ("chat-menu", |s| { s.open_chat("Casual chat"); s.toggle_menu("chat-head:Casual chat"); }),
    ("chat-row-menu", |s| { s.open_chat("Casual chat"); s.toggle_menu("chat:Pricing page"); }),
    ("chat-rename", |s| { s.open_chat("Casual chat"); s.open_chat_rename("Pricing page"); }),
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
    // Suggestions as you type: "re" on a new line in pricing.js.
    ("code-complete", |s| {
        s.go(View::Code);
        s.poll_code();
        let mut text = s.edit(EditKey::Code).text.clone();
        if let Some(at) = text.find("  root.innerHTML") {
            text.insert_str(at, "  re\n");
            s.edit_mut(EditKey::Code).replace_text(text);
            s.edit_mut(EditKey::Code).set_caret(at + 4);
            s.update_completion();
        }
    }),
    ("code-run-menu", |s| { s.go(View::Code); s.poll_code(); s.toggle_menu("code-run"); }),
    // The Ports panel: Vite's port from the terminal, Live Server's, one you added, one shared.
    ("code-ports", |s| {
        s.go(View::Code);
        s.poll_code();
        s.data.extra.terminal.extend([
            model::TermLine { kind: model::TermKind::Input, text: "npm run dev".into() },
            model::TermLine { kind: model::TermKind::Out, text: "  VITE v5.4.2  ready in 312 ms".into() },
            model::TermLine { kind: model::TermKind::Out, text: "  ➜  Local:   http://localhost:5173/".into() },
        ]);
        s.data.extra.ports.live = Some(5500);
        s.ports_added.push(3000);
        s.show_ports(true);
        s.share_port(5173);
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
        s.apps_ui.dialog = Some(views::apps::Dialog::Manage("builtin:slack".into()));
        s.app_tools("builtin:slack");
    }),
    ("apps-featured", |s| { s.go(View::Integrations); s.integrations = IntegrationsTab::Apps; s.browse_apps(false); }),
    ("apps-builtin-connected", |s| {
        s.go(View::Integrations);
        s.integrations = IntegrationsTab::Apps;
        s.browse_apps(false);
        s.data.extra.apps.progress = Some(model::AppProgress { id: "builtin:github".into(), name: "GitHub".into(), state: "done".into(), message: "GitHub is connected as codeply-dev.".into() });
        s.apps_ui.dialog = Some(views::apps::Dialog::Manage("builtin:github".into()));
        s.app_tools("builtin:github");
    }),
    ("apps-builtin-waiting", |s| {
        s.go(View::Integrations);
        s.integrations = IntegrationsTab::Apps;
        s.browse_apps(false);
        s.data.extra.apps.progress = Some(model::AppProgress { id: "builtin:supabase".into(), name: "Supabase".into(), state: "waiting".into(), message: "Finish signing in to Supabase in your browser...".into() });
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
    // Upgrading: the free-limit card, the sheet, paying on Whop, and Settings' plan.
    ("limit-card", |s| { s.open_chat("Casual chat"); s.data.extra.limits.push(("Casual chat".into(), "4:30 PM".into())); }),
    ("limit-card-pane", |s| { s.open_chat("Casual chat"); s.panes.browser = true; s.data.extra.limits.push(("Casual chat".into(), "4:30 PM".into())); }),
    ("limit-card-code", |s| { s.go(View::Code); s.poll_code(); let c = views::code::agent_chat(s); s.data.extra.limits.push((c, "4:30 PM".into())); }),
    ("upgrade", |s| { s.open_chat("Casual chat"); s.open_upgrade(); }),
    ("upgrade-max", |s| { s.open_chat("Casual chat"); s.open_upgrade(); s.pick_plan("pro"); }),
    ("upgrade-waiting", |s| { s.open_chat("Casual chat"); s.open_upgrade(); s.start_checkout(); }),
    ("upgrade-sign-in", |s| { s.open_chat("Casual chat"); s.open_upgrade(); s.data.extra.billing.signed_out = true; }),
    ("upgrade-error", |s| {
        s.open_chat("Casual chat");
        s.open_upgrade();
        s.data.extra.billing.checkout = Some(model::Checkout { plan: "starter".into(), url: String::new(), state: model::CheckoutState::Failed("Couldn't reach Codeply (getaddrinfo ENOTFOUND codeply.app). Check your connection and try again.".into()) });
    }),
    ("settings-billing", |s| { s.open_settings(SettingsPage::Usage); s.store.billing(model::BillingOp::Load, &mut s.data); }),
    ("settings-billing-pro", |s| {
        s.open_settings(SettingsPage::Usage);
        s.data.extra.billing.plan = Some(model::Plan { key: "starter".into(), name: "Pro".into(), models: vec!["Claude Opus 5.5".into(), "Claude Sonnet".into(), "Claude Haiku".into()] });
        s.data.plan = "Pro plan".into();
    }),
    ("settings-cloud", |s| s.open_settings(SettingsPage::Cloud)),
    ("settings-git", |s| s.open_settings(SettingsPage::Git)),
    // The composer's menus: "/" for commands and skills, "@" for agents, apps and files.
    ("composer-slash", |s| {
        s.open_chat("Casual chat");
        s.edit_mut(EditKey::ChatThread).replace_text("/s");
        s.mention_typed(EditKey::ChatThread, &store::Target::Chat(String::new()));
    }),
    ("composer-mention", |s| {
        s.new_chat();
        s.edit_mut(EditKey::ChatHome).replace_text("Ask @");
        s.mention_typed(EditKey::ChatHome, &store::Target::New);
    }),
    ("settings-skills", |s| s.open_settings(SettingsPage::Skills)),
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
    ("settings-models-plans", |s| {
        s.open_settings(SettingsPage::Models);
        s.data.extra.billing.plan = Some(model::Plan { key: "starter".into(), name: "Pro".into(), models: Vec::new() });
        s.data.extra.linked.claude = model::LinkedPlan { connected: true, plan: "Claude Max".into(), email: "sam@example.com".into(), ..Default::default() };
    }),
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
            model::ThreadItem::Event { icon: "file-text", text: "Read src/pricing/pricing.css".into(), detail: None },
            model::ThreadItem::Event { icon: "edit", text: "Edited src/pricing/pricing.css, +14 lines".into(), detail: None },
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
        items.push(model::ThreadItem::Event { icon: "file-text", text: "Read index.html".into(), detail: None });
        items.push(model::ThreadItem::Event { icon: "terminal", text: "Ran `python -m http.server 8080`".into(), detail: None });
        items.push(model::ThreadItem::Them("It's running at http://127.0.0.1:8080/ and http://localhost:8080/.".into()));
        items.push(model::ThreadItem::You("ok can u make it like iMessage?".into()));
        items.push(model::ThreadItem::Event { icon: "file-text", text: "Read style.css".into(), detail: None });
        s.data.threads.push(("Casual chat".into(), items));
        s.data.extra.step_now.push(("Casual chat".into(), "Editing style.css".into()));
    }),
    // The agent talking while it works, Claude-style: a line before each group of steps, and
    // a command opened to show what it ran and what it printed.
    ("chat-work", |s| {
        s.open_chat("Casual chat");
        let mut items = vec![model::ThreadItem::You("Make me a bookstore like this website".into())];
        items.push(model::ThreadItem::Them("I'll look at your picture and the project first, then build the page.".into()));
        items.push(model::ThreadItem::Event { icon: "image", text: "Looked at bookstore.png".into(), detail: None });
        items.push(model::ThreadItem::Event { icon: "file-text", text: "Read index.html".into(), detail: None });
        items.push(model::ThreadItem::Them("It's a warm, paper-toned store with a serif headline and a grid of covers. The project is empty, so I'm starting from a clean page and checking the tools I'll need.".into()));
        let start = items.len();
        items.push(model::ThreadItem::Event { icon: "terminal", text: "Ran `python3 --version && node --version`".into(),
            detail: Some(Box::new(model::StepDetail { command: "python3 --version && node --version".into(), output: "Python 3.12.4\nv24.9.0".into() })) });
        items.push(model::ThreadItem::Event { icon: "edit", text: "Wrote index.html".into(), detail: None });
        items.push(model::ThreadItem::Event { icon: "edit", text: "Wrote assets/base.css".into(), detail: None });
        items.push(model::ThreadItem::Them("The page is written. Starting a local server to check it in the browser.".into()));
        items.push(model::ThreadItem::Event { icon: "terminal", text: "Ran `python -m http.server 8770`".into(),
            detail: Some(Box::new(model::StepDetail { command: "python -m http.server 8770".into(), output: "Serving HTTP on 0.0.0.0 port 8770 (http://0.0.0.0:8770/) ...".into() })) });
        items.push(model::ThreadItem::Event { icon: "globe", text: "Checked http://localhost:8770".into(), detail: None });
        items.push(model::ThreadItem::Them("Done. The bookstore is at http://localhost:8770: hero, a grid of 12 covers and a footer, in your picture's colours.".into()));
        s.data.threads.push(("Casual chat".into(), items));
        s.expanded.insert(format!("steps/Casual chat/{start}"));
        s.expanded.insert(format!("steps/Casual chat/{start}/0"));
    }),
    ("agent-sessions", |s| s.open_agent(Some("frontend"))),
    ("bg-ascii-colour", |s| { bg(s, look::BgKind::Ascii); s.new_chat(); }),
    ("bg-dots-colour", |s| { bg(s, look::BgKind::Dots); s.new_chat(); }),
    ("bg-picture", |s| { bg(s, look::BgKind::Picture); s.new_chat(); }),
    // Flowing dots behind the chat home.
    ("bg-flow", |s| { bg(s, look::BgKind::Flow); s.new_chat(); }),
    ("settings-flow", |s| { bg(s, look::BgKind::Flow); s.open_settings(SettingsPage::Appearance); }),
    ("bg-picture-chat", |s| { bg(s, look::BgKind::Picture); s.open_chat("Casual chat"); }),
    ("settings-background", |s| { bg(s, look::BgKind::Dots); s.open_settings(SettingsPage::Appearance); }),
    ("settings-memories", |s| {
        s.open_settings(SettingsPage::Personalization);
        s.data.extra.memories.insert(0, model::Memory { id: "m-long".into(), kind: "decision".into(), scope: "project:codeply-copy".into(),
            text: "All non-app pages of Codeply - Copy get light backgrounds, dark text, a light nav and footer, and pastel mockup panels, while the chat and admin screens stay unchanged.".into() });
    }),
    ("chat-pictures", |s| {
        let pic = sample_png();
        s.open_chat("Casual chat");
        let mut items = s.data.thread("Casual chat").to_vec();
        items.push(model::ThreadItem::Files(vec![pic.clone(), "C:\\Users\\sam\\Desktop\\brief.pdf".into()]));
        items.push(model::ThreadItem::You("Make me a bookstore website and use this image as the reference".into()));
        items.push(model::ThreadItem::Event { icon: "image", text: "Looked at bookstore.png".into(), detail: None });
        items.push(model::ThreadItem::Event { icon: "file-text", text: "Read index.html".into(), detail: None });
        items.push(model::ThreadItem::Event { icon: "edit", text: "Edited index.html".into(), detail: None });
        items.push(model::ThreadItem::Event { icon: "edit", text: "Edited style.css".into(), detail: None });
        items.push(model::ThreadItem::Event { icon: "terminal", text: "Ran `npx --yes http-server . -p 8080 -c-1 --cors --silent --gzip --brotli --log-ip --proxy http://localhost:8080?`".into(), detail: None });
        items.push(model::ThreadItem::Them("Done: warm paper tones and a serif headline, from your picture. It's at http://127.0.0.1:8080/.".into()));
        s.data.threads.push(("Casual chat".into(), items));
        s.attachments.insert(EditKey::ChatThread, vec![pic]);
    }),
    ("update-offer", |s| { s.new_chat(); s.updater.show(update::Phase::Offer(sample_release())); }),
    ("update-downloading", |s| { s.new_chat(); s.updater.show(update::Phase::Fetching { version: "4.0.140".into(), done: 31_000_000, total: 74_000_000, setup: true }); }),
    ("update-ready", |s| { s.new_chat(); s.updater.show(update::Phase::Ready(sample_release())); }),
    ("settings-update", |s| { s.open_settings(SettingsPage::General); s.updater.show(update::Phase::Ready(sample_release())); }),
];

/// The sample picture as the background, drawn as `kind`.
fn bg(s: &mut App, kind: look::BgKind) {
    s.prefs.look.picture = look::SAMPLE.into();
    s.prefs.look.bg_kind = kind;
    s.prefs.look.dim = 1;
    s.convert_picture();
}

/// The sample picture as a PNG file, for scenes that attach one.
fn sample_png() -> String {
    let path = std::env::temp_dir().join("codeply-sample-bookstore.png");
    if !path.exists() {
        let (w, h, rgba) = art::sample_picture();
        let _ = image::save_buffer(&path, &rgba, w, h, image::ColorType::Rgba8);
    }
    path.to_string_lossy().into_owned()
}

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
