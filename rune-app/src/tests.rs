//! The app driven headlessly through Rune's runtime: real layout, real hit testing, real input.

use rune::{Env, Key, KeyEvent, Mods, Runtime};

use crate::app::{App, EditKey, View};
use crate::{SCENES, shell};

fn runtime(state: App) -> Runtime<App> {
    let env = Env { system_dark: true, scale: 1.0 };
    let mut rt = Runtime::new(state, shell::view, (1440.0, 900.0), env);
    rt.poll = Some(|s, now, tx| s.poll(now, tx));
    rt.on_key = Some(|s, e, tx| s.key(e, tx));
    rt.frame(0.0);
    rt
}

fn settle(rt: &mut Runtime<App>) {
    for _ in 0..40 {
        rt.frame(1.0 / 60.0);
    }
}

fn click(rt: &mut Runtime<App>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("no element {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(rt);
}

#[test]
fn every_scene_builds_and_lays_out() {
    for (name, scene) in SCENES {
        let mut s = App::with_mock();
        scene(&mut s);
        let mut rt = runtime(s);
        settle(&mut rt);
        assert!(rt.find("titlebar").is_some(), "{name}: the titlebar is missing");
        let settings = rt.state.view == View::Settings;
        assert_eq!(rt.find("rail").is_some(), !settings, "{name}: the rail shows on every view but Settings");
        assert_eq!(rt.find("settings-page").is_some(), settings, "{name}: Settings is a page of its own");
    }
}

#[test]
fn the_rail_switches_views() {
    let mut rt = runtime(App::with_mock());
    assert_eq!(rt.state.view, View::Chat, "Chat comes first and is the default view");
    assert!(rt.find("rail-Office").is_none(), "the Office is gone");
    for (key, view) in [
        ("rail-Agents", View::Agents), ("rail-Code", View::Code), ("rail-Pull requests", View::Prs),
        ("rail-Integrations", View::Integrations), ("rail-Chat", View::Chat),
    ] {
        click(&mut rt, key);
        assert_eq!(rt.state.view, view, "{key}");
    }
}

#[test]
fn settings_opens_full_window_and_goes_back() {
    let mut rt = runtime(App::with_mock());
    click(&mut rt, "rail-Chat");
    click(&mut rt, "rail-Settings");
    assert_eq!(rt.state.view, View::Settings);
    assert!(rt.find("rail").is_none());
    click(&mut rt, "settings/appearance");
    assert_eq!(rt.state.settings, crate::app::SettingsPage::Appearance);
    click(&mut rt, "settings-back");
    assert_eq!(rt.state.view, View::Chat, "Back to app returns where you were");
    rt.state.open_settings(crate::app::SettingsPage::General);
    rt.key(KeyEvent { key: Key::Escape, mods: Mods::default() });
    settle(&mut rt);
    assert_eq!(rt.state.view, View::Chat, "Escape leaves Settings too");
}

#[test]
fn an_agent_opens_with_its_conversation_and_panel() {
    let mut rt = runtime(App::with_mock());
    settle(&mut rt);
    click(&mut rt, "rail-Agents");
    click(&mut rt, "agent-row/frontend");
    assert_eq!(rt.state.agent.as_deref(), Some("frontend"));
    assert!(rt.find("agent-panel").is_some(), "the right-hand panel shows");
    click(&mut rt, "agent-row/mission");
    assert_eq!(rt.state.agent, None, "Mission control is one click back");
}

#[test]
fn a_message_to_an_agent_lands_in_its_conversation() {
    let mut s = App::with_mock();
    s.open_agent(Some("research"));
    s.edit_mut(EditKey::AgentThread).replace_text("Book it for 7pm");
    s.submit(EditKey::AgentThread, &crate::store::Target::Agent("research".into()));
    assert!(s.edit(EditKey::AgentThread).text.is_empty(), "the composer clears after sending");
    assert!(s.data.thread("Research").iter().any(|i| matches!(i, crate::model::ThreadItem::You(t) if t == "Book it for 7pm")));
}

#[test]
fn a_new_chat_opens_itself() {
    let mut rt = runtime(App::with_mock());
    click(&mut rt, "rail-Chat");
    assert_eq!(rt.state.chat, None, "Chat opens on What should we build?");
    rt.state.edit_mut(EditKey::ChatHome).replace_text("Make the hero section bigger");
    rt.state.submit(EditKey::ChatHome, &crate::store::Target::New);
    settle(&mut rt);
    assert_eq!(rt.state.chat.as_deref(), Some("Make the hero section bigger"));
    assert_eq!(rt.state.data.extra.chats.first().map(|c| c.title.as_str()), Some("Make the hero section bigger"));
}

#[test]
fn the_approval_menu_switches_to_full_access() {
    let mut rt = runtime(App::with_mock());
    click(&mut rt, "rail-Chat");
    click(&mut rt, "approval-chip/chat-home");
    assert_eq!(rt.state.menu.as_deref(), Some("approval:chat-home"));
    click(&mut rt, "approval/auto");
    assert_eq!(rt.state.prefs.approval, crate::prefs::Approval::Auto);
    assert_eq!(rt.state.menu, None, "picking closes the menu");
}

#[test]
fn pinning_and_archiving_a_chat() {
    let mut s = App::with_mock();
    s.toggle_pin("Casual chat");
    assert!(s.prefs.pinned.contains(&"Casual chat".to_owned()));
    s.open_chat("Casual chat");
    s.archive("Casual chat");
    assert!(s.prefs.archived.contains(&"Casual chat".to_owned()) && !s.prefs.pinned.contains(&"Casual chat".to_owned()));
    assert_eq!(s.chat, None, "archiving the open chat goes home");
    s.unarchive("Casual chat");
    assert!(s.prefs.archived.is_empty());
}

#[test]
fn a_link_opens_the_browser_beside_the_chat() {
    let mut s = App::with_mock();
    s.open_chat("Casual chat");
    s.browse("github.com");
    assert!(s.panes.browser && s.view == View::Chat, "the browser is a pane of the chat, not a page");
    assert_eq!(s.browser.current().map(|t| t.url.as_str()), Some("https://github.com"));
    let mut rt = runtime(s);
    settle(&mut rt);
    assert!(rt.find("address").is_some() && rt.find("browser-page").is_some());
}

#[test]
fn the_terminal_runs_and_clears() {
    let mut s = App::with_mock();
    s.open_chat("Casual chat");
    s.toggle_pane(crate::app::Pane::Terminal);
    s.edit_mut(EditKey::Terminal).replace_text("echo hi");
    s.run_command();
    assert!(s.data.extra.terminal.iter().any(|l| l.text == "echo hi"));
    s.edit_mut(EditKey::Terminal).replace_text("clear");
    s.run_command();
    assert!(s.data.extra.terminal.is_empty());
}

#[test]
fn integrations_tabs_and_connecting_an_app() {
    let mut rt = runtime(App::with_mock());
    click(&mut rt, "rail-Integrations");
    click(&mut rt, "int-tab/Apps");
    assert_eq!(rt.state.integrations, crate::app::IntegrationsTab::Apps);
    let before = rt.state.data.extra.catalog.iter().find(|a| a.slug == "linear").map(|a| a.connected);
    rt.state.toggle_app("linear");
    let after = rt.state.data.extra.catalog.iter().find(|a| a.slug == "linear").map(|a| a.connected);
    assert_ne!(before, after);
}

#[test]
fn replies_render_markdown_with_link_names() {
    let mut s = App::with_mock();
    s.data.threads.push(("Links".into(), vec![crate::model::ThreadItem::Them("Open https://www.codeply.app and **check** it.

- one
- two".into())]));
    s.data.extra.chats.insert(0, crate::model::ChatMeta { title: "Links".into(), kind: crate::model::ChatKind::Chat, project: String::new(), ago: "now".into(), preview: String::new(), running: true, unread: false });
    s.open_chat("Links");
    let mut rt = runtime(s);
    settle(&mut rt);
    assert!(rt.find("thread/Links").is_some());
}

#[test]
fn picking_a_shape_and_colour_restyles_a_helper() {
    let mut rt = runtime(App::with_mock());
    settle(&mut rt);
    // The row's "more" button opens Appearance (in Agents).
    click(&mut rt, "rail-Agents");
    click(&mut rt, "more/backend");
    assert_eq!(rt.state.appearance.as_deref(), Some("backend"));
    click(&mut rt, "pick-shape/backend/Pebble");
    click(&mut rt, "pick-color/backend/#12b5a5");
    let backend = rt.state.data.agent("backend").map(|a| (a.look.shape, a.color.clone()));
    assert_eq!(backend, Some((crate::model::Shape::Pebble, "#12b5a5".to_owned())));
    rt.key(KeyEvent { key: Key::Escape, mods: Mods::default() });
    settle(&mut rt);
    assert_eq!(rt.state.appearance, None, "Escape closes Appearance");
}

#[test]
fn every_scene_lays_out_in_light_at_the_largest_size_and_over_a_background() {
    for look in ["light", "light,4,geist", "dots", "light,ascii,3", "picture,bold"] {
        for (name, scene) in SCENES {
            let mut s = App::with_mock();
            s.look_flags(look);
            scene(&mut s);
            let mut rt = runtime(s);
            settle(&mut rt);
            assert!(rt.find("titlebar").is_some(), "{name} ({look}): the titlebar is missing");
            // The background scenes choose one of their own.
            // Flowing dots draw only on the chat home, in its own area, never as the backdrop.
            let flow = *name == "bg-flow" || *name == "settings-flow";
            let background = !flow && (look.contains("dots") || look.contains("ascii") || look.contains("picture") || name.starts_with("bg-") || *name == "settings-background");
            assert_eq!(rt.find("backdrop").is_some(), background, "{name} ({look}): the background layer");
            assert_eq!(rt.find("flow-dots").is_some(), *name == "bg-flow", "{name} ({look}): the flowing dots");
        }
    }
    crate::theme::set_text(1.0, 0);
}

#[test]
fn appearance_settings_change_the_look_at_once_and_are_saved() {
    let mut app = App::with_mock();
    app.open_settings(crate::app::SettingsPage::Appearance);
    let mut rt = runtime(app);
    settle(&mut rt);
    let before = rt.state.prefs.look.clone();
    click(&mut rt, "set-theme/Light");
    assert_eq!(rt.state.prefs.look.mode, crate::look::Mode::Light);
    click(&mut rt, "sw/accent/#f97316");
    assert_eq!(rt.state.prefs.look.accent.as_deref(), Some("#f97316"));
    click(&mut rt, "sw/bg/#0b1220");
    assert_eq!(rt.state.prefs.look.bg.as_deref(), Some("#0b1220"));
    click(&mut rt, "set-size/Large");
    // The weight row sits below the fold of a 900 pt window, so this one is set directly.
    rt.state.set_text_weight(3);
    rt.state.set_text_size(4);
    rt.invalidate();
    settle(&mut rt);
    assert_eq!((rt.state.prefs.look.size, rt.state.prefs.look.weight), (4, 3));
    // Back to the default size, so the font row is inside the window again (reading text has
    // more room between lines, which pushes it below the fold at the largest size).
    rt.state.set_text_size(1);
    rt.invalidate();
    settle(&mut rt);
    // The font menu lists the bundled fonts, and picking one sets the stack Rune uses.
    click(&mut rt, "font-pick");
    click(&mut rt, "font-opt/Geist");
    assert_eq!(rt.state.prefs.look.font, "Geist");
    assert!(rt.state.prefs.look.families().0.starts_with("Geist, "));
    // A background: ASCII needs art, which a picture provides.
    rt.state.set_bg_kind(crate::look::BgKind::Picture);
    rt.invalidate();
    settle(&mut rt);
    assert!(rt.find("backdrop").is_none(), "no picture yet, so nothing to draw");
    rt.state.use_picture_sample();
    rt.invalidate();
    settle(&mut rt);
    assert!(rt.find("backdrop").is_some());
    // The background group is below the fold, so its controls are driven through the app.
    rt.state.set_bg_kind(crate::look::BgKind::Ascii);
    rt.invalidate();
    settle(&mut rt);
    for _ in 0..100 {
        if !rt.state.prefs.look.art.is_empty() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        rt.frame(1.0 / 60.0);
    }
    assert!(!rt.state.prefs.look.art.is_empty(), "the picture was converted to art");
    rt.state.set_dim(3);
    rt.state.set_blur(1);
    // Everything round-trips through the saved preferences.
    let saved = crate::prefs::Prefs::from_json(&rt.state.prefs.to_json());
    assert_eq!(saved.look, rt.state.prefs.look);
    assert_ne!(saved.look, before);
    // Reset puts the stock dark look back.
    click(&mut rt, "theme-reset");
    assert_eq!(rt.state.prefs.look.mode, crate::look::Mode::Dark);
    assert_eq!(rt.state.prefs.look.bg_kind, crate::look::BgKind::None);
    assert!(rt.state.prefs.look.accent.is_none() && rt.state.prefs.look.font.is_empty());
    crate::theme::set_text(1.0, 0);
}

#[test]
fn a_generated_theme_previews_and_applies_only_on_apply() {
    let mut app = App::with_mock();
    app.open_settings(crate::app::SettingsPage::Appearance);
    app.theme_demo();
    let mut rt = runtime(app);
    settle(&mut rt);
    assert!(rt.find("theme-preview").is_some(), "the candidate is shown");
    assert_eq!(rt.state.prefs.look.name, "", "nothing is applied yet");
    click(&mut rt, "theme-apply");
    assert_eq!(rt.state.prefs.look.name, "Rainy Tokyo");
    assert_eq!(rt.state.prefs.look.bg.as_deref(), Some("#0b1220"));
    assert_eq!(rt.state.prefs.look.bg_kind, crate::look::BgKind::Dots);
    assert!(rt.find("theme-preview").is_none());
    // Discard leaves things alone.
    rt.state.theme_demo();
    rt.invalidate();
    settle(&mut rt);
    click(&mut rt, "theme-discard");
    assert!(rt.state.look.candidate.is_none());
    crate::theme::set_text(1.0, 0);
}

#[test]
fn tabs_keep_their_unsaved_text_and_close() {
    let mut app = App::with_mock();
    app.go(View::Code);
    app.poll_code();
    let first = app.data.extra.code.open.clone().expect("a file is open");
    app.edit_mut(EditKey::Code).replace_text("// my change\n".to_owned());
    app.open_file("src/main.js");
    app.poll_code();
    assert_eq!(app.tabs(), [first.clone(), "src/main.js".to_owned()]);
    assert!(app.code_drafts.contains_key(&first), "the tab left keeps what was typed");
    app.open_file(&first);
    app.poll_code();
    assert_eq!(app.edit(EditKey::Code).text, "// my change\n");
    app.close_tab("src/main.js");
    assert_eq!(app.tabs(), [first]);
}

#[test]
fn the_composer_plus_attaches_files_and_sends_them_beside_the_message() {
    let mut s = App::with_mock();
    s.open_chat("Casual chat");
    let mut rt = runtime(s);
    settle(&mut rt);
    click(&mut rt, "attach-chat-thread");
    let kind = rt.file_dialog().map(|(k, _)| k);
    assert_eq!(kind, Some(rune::FileDialogKind::Open), "the + opens a file picker");
    let file = std::path::PathBuf::from("/home/sam/brief.pdf");
    rt.resolve_file_dialog(Some(file)).unwrap_or_else(|e| panic!("{e}"));
    settle(&mut rt);
    assert_eq!(rt.state.attachments.get(&EditKey::ChatThread).cloned(), Some(vec!["/home/sam/brief.pdf".to_owned()]));
    assert!(rt.find("attached//home/sam/brief.pdf").is_some(), "the file shows above the field");
    // A file alone is enough to send; it goes beside the message and shows above it.
    click(&mut rt, "send-chat-thread");
    assert!(rt.state.attachments.get(&EditKey::ChatThread).is_none_or(Vec::is_empty), "sending takes the attachments with it");
    let items = rt.state.data.thread("Casual chat").to_vec();
    let at = items.iter().rposition(|i| matches!(i, crate::model::ThreadItem::Files(f) if f == &vec!["/home/sam/brief.pdf".to_owned()]));
    assert!(at.is_some(), "the file shows with the message: {items:?}");
    assert!(matches!(items.get(at.unwrap_or(0) + 1), Some(crate::model::ThreadItem::You(t)) if !t.contains("brief.pdf")), "and the message itself stays as you wrote it");
}

#[test]
fn pasting_a_picture_attaches_it() {
    let mut s = App::with_mock();
    s.open_chat("Casual chat");
    let mut rt = runtime(s);
    settle(&mut rt);
    click(&mut rt, "composer-chat-thread");
    // A 1x1 PNG, as a browser's "Copy image" puts on the clipboard.
    let png: Vec<u8> = {
        let mut out = Vec::new();
        let mut enc = png::Encoder::new(&mut out, 1, 1);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        if let Ok(mut w) = enc.write_header() { let _ = w.write_image_data(&[200, 120, 40, 255]); }
        out
    };
    let image = rune::ClipboardImage::from_png(png).unwrap_or_else(|| panic!("a valid png"));
    rt.paste_content(rune::ClipboardContent::new("").with_image(image));
    settle(&mut rt);
    let files = rt.state.attachments.get(&EditKey::ChatThread).cloned().unwrap_or_default();
    assert_eq!(files.len(), 1, "the pasted picture is attached");
    assert!(files[0].ends_with(".png") && std::path::Path::new(&files[0]).exists(), "kept as a file the engine can send: {files:?}");
    let _ = std::fs::remove_file(&files[0]);
}

#[test]
fn the_appearance_popover_deletes_an_agent() {
    let mut s = App::with_mock();
    s.go(View::Agents);
    s.toggle_appearance("backend");
    let mut rt = runtime(s);
    settle(&mut rt);
    click(&mut rt, "appearance-delete");
    assert!(rt.state.data.agent("backend").is_none(), "Backend is off the team");
    assert_eq!(rt.state.appearance, None, "the popover closes");
    // Wisp leads and has no Delete.
    rt.update(|s, _| s.toggle_appearance("wisp"));
    settle(&mut rt);
    assert!(rt.find("appearance-delete").is_none());
}

#[test]
fn open_folder_makes_it_the_project() {
    let mut s = App::with_mock();
    s.go(View::Code);
    let mut rt = runtime(s);
    settle(&mut rt);
    click(&mut rt, "code-open-folder");
    assert_eq!(rt.file_dialog().map(|(k, _)| k), Some(rune::FileDialogKind::Folder));
    rt.resolve_file_dialog(Some(std::path::PathBuf::from("/home/sam/code/my-site"))).unwrap_or_else(|e| panic!("{e}"));
    settle(&mut rt);
    assert_eq!(rt.state.data.project, "my-site");
    assert_eq!(rt.state.prefs.project, "/home/sam/code/my-site", "remembered for the next launch");
    assert!(rt.state.code_tabs.is_empty() && rt.state.data.extra.code.open.is_none(), "the old project's files close");
}

#[test]
fn an_empty_pull_requests_page_says_what_to_do() {
    let mut s = App::with_mock();
    s.go(View::Prs);
    s.data.prs.clear();
    s.data.extra.repo = Some(crate::model::RepoState::default());
    let mut rt = runtime(s);
    settle(&mut rt);
    for key in ["prs-init", "prs-empty-open", "clone-url", "prs-clone", "prs-refresh", "prs-open-folder"] {
        assert!(rt.find(key).is_some(), "not a repository: {key}");
    }
    rt.update(|s, _| s.data.extra.repo = Some(crate::model::RepoState { repo: true, remote: true, gh: "auth".into(), ..Default::default() }));
    settle(&mut rt);
    assert!(rt.find("prs-sign-in").is_some());
    rt.update(|s, _| s.data.extra.repo = Some(crate::model::RepoState { repo: true, remote: true, gh: "missing".into(), ..Default::default() }));
    settle(&mut rt);
    assert!(rt.find("prs-install-gh").is_some());
    rt.update(|s, _| s.data.extra.repo = Some(crate::model::RepoState { repo: true, remote: true, branch: "fix".into(), base: "main".into(), gh: String::new(), detail: String::new() }));
    settle(&mut rt);
    assert!(rt.find("prs-create").is_some(), "a branch with nothing open can open a pull request");
}

#[test]
fn a_bigger_update_shows_its_screen_and_later_puts_it_in_the_titlebar() {
    let mut s = App::with_mock();
    s.updater.show(crate::update::Phase::Offer(crate::update::Release { version: "4.0.140".into(), notes: "New engine".into(), setup_url: "https://x/Codeply-Setup.exe".into(), ..Default::default() }));
    let mut rt = runtime(s);
    settle(&mut rt);
    assert!(rt.find("update-sheet").is_some() && rt.find("update-now").is_some(), "the update screen offers Update now");
    click(&mut rt, "update-later");
    assert!(rt.find("update-sheet").is_none(), "Later closes it");
    assert!(rt.find("update-pill").is_some(), "and leaves a note in the titlebar");
    click(&mut rt, "update-pill");
    assert!(rt.find("update-sheet").is_some(), "which opens it again");
}

#[test]
fn the_code_view_agent_talks_in_the_projects_own_chat() {
    let mut s = App::with_mock();
    s.go(View::Code);
    s.poll_code();
    let mut rt = runtime(s);
    settle(&mut rt);
    assert!(rt.find("code-agent").is_some(), "the agent panel sits beside the editor");
    assert!(rt.find("code-edit-with-wisp").is_none(), "no Edit with Wisp button");
    rt.update(|s, _| s.edit_mut(EditKey::CodeAgent).replace_text("Make the cards stack on phones"));
    settle(&mut rt);
    click(&mut rt, "send-code-agent");
    let chat = crate::views::code::agent_chat(&rt.state);
    let thread = rt.state.data.thread(&chat).to_vec();
    assert!(thread.iter().any(|i| matches!(i, crate::model::ThreadItem::You(t) if t.starts_with("Make the cards stack on phones") && t.contains("Open in the editor"))),
        "the message lands in {chat}, with the open file named: {thread:?}");
}

#[test]
fn chats_agents_and_the_code_view_keep_their_own_conversations() {
    let mut rt = runtime(App::with_mock());
    settle(&mut rt);
    // Chat lists your chats only: no agent sessions.
    assert!(rt.find("chat/Casual chat").is_some());
    assert!(rt.find("chat/Frontend").is_none() && rt.find("chat/Frontend: Make the pricing cards responsive").is_none(), "agents' sessions stay out of Chat");
    // The agent's page lists its sessions, newest first, and opens one.
    click(&mut rt, "rail-Agents");
    click(&mut rt, "agent-row/frontend");
    assert!(rt.find("session/Frontend: Make the pricing cards responsive").is_some(), "the agent's sessions are on its page");
    click(&mut rt, "session/Frontend: Make the pricing cards responsive");
    assert_eq!(rt.state.agent_session.get("frontend").map(String::as_str), Some("Frontend: Make the pricing cards responsive"));
    // A new session is named by its first message, and only the agent's page shows it.
    click(&mut rt, "session-new/frontend");
    rt.update(|s, _| s.edit_mut(EditKey::AgentThread).replace_text("Add a dark mode toggle"));
    settle(&mut rt);
    click(&mut rt, "send-agent-thread");
    assert_eq!(rt.state.agent_session.get("frontend").map(String::as_str), Some("Frontend: Add a dark mode toggle"));
    assert!(rt.find("session/Frontend: Add a dark mode toggle").is_some());
    click(&mut rt, "rail-Chat");
    assert!(rt.find("chat/Frontend: Add a dark mode toggle").is_none(), "and Chat doesn't");
}

#[test]
fn search_filters_chats_and_delete_removes_one() {
    let mut rt = runtime(App::with_mock());
    settle(&mut rt);
    click(&mut rt, "search-row");
    assert!(rt.find("chat-search").is_some(), "Search opens a field");
    rt.update(|s, _| s.edit_mut(EditKey::Search).replace_text("checkout"));
    settle(&mut rt);
    assert!(rt.find("chat/Fix the checkout crash").is_some() && rt.find("chat/Casual chat").is_none(), "only matching chats show");
    click(&mut rt, "chat-search-close");
    assert!(rt.find("chat/Casual chat").is_some());
    rt.update(|s, _| s.toggle_menu("chat:Casual chat"));
    settle(&mut rt);
    click(&mut rt, "chat-menu/delete");
    assert!(rt.find("chat/Casual chat").is_none(), "Delete removes the chat");
}

#[test]
fn the_editor_note_is_not_shown_in_your_message() {
    assert_eq!(crate::thread::shown_message("what link?\n\n(Open in the editor: index.html)"), "what link?");
    assert_eq!(crate::thread::shown_message("plain"), "plain");
}

#[test]
fn the_free_limit_card_leads_to_the_upgrade_sheet_and_back() {
    let mut app = App::with_mock();
    app.open_chat("Casual chat");
    app.data.extra.limits.push(("Casual chat".into(), "4:30 PM".into()));
    let mut rt = runtime(app);
    settle(&mut rt);
    assert!(rt.find("limit-card").is_some(), "the chat shows the card");
    // "Your model" opens the composer's model menu.
    click(&mut rt, "limit-model");
    assert_eq!(rt.state.menu.as_deref(), Some("model:chat-thread"));
    rt.key(KeyEvent { key: Key::Escape, mods: Mods::default() });
    settle(&mut rt);
    // Upgrade: the sheet, on Pro; Max changes what the button says.
    click(&mut rt, "limit-upgrade");
    assert!(rt.state.upgrade.open && rt.find("upgrade-sheet").is_some());
    assert_eq!(rt.state.upgrade.pick, "starter");
    click(&mut rt, "upgrade-plan/pro");
    assert_eq!(rt.state.upgrade.pick, "pro");
    // Payment: the store makes the checkout (the sample one opens nothing) and the sheet waits.
    click(&mut rt, "upgrade-go");
    assert!(rt.find("upgrade-waiting").is_some(), "Finish on Whop");
    assert_eq!(rt.state.data.extra.billing.checkout.as_ref().map(|c| c.plan.as_str()), Some("pro"));
    click(&mut rt, "upgrade-cancel");
    assert!(!rt.state.upgrade.open && rt.state.data.extra.billing.checkout.is_none(), "Cancel stops waiting");
    // Paid while waiting: the sheet closes by itself and the plan shows.
    rt.update(|s, _| { s.open_upgrade(); s.start_checkout(); });
    settle(&mut rt);
    rt.update(|s, _| {
        s.data.extra.billing.plan = Some(crate::model::Plan { key: "starter".into(), name: "Pro".into(), models: Vec::new() });
        if let Some(c) = s.data.extra.billing.checkout.as_mut() {
            c.state = crate::model::CheckoutState::Done;
        }
    });
    settle(&mut rt);
    assert!(!rt.state.upgrade.open && rt.find("upgrade-scrim").is_none());
    assert_eq!(rt.state.data.plan, "Pro plan");
    assert!(rt.find("limit-upgrade").is_none(), "on a paid plan the card has no Upgrade");
    // Escape closes the sheet.
    rt.update(|s, _| s.open_upgrade());
    settle(&mut rt);
    rt.key(KeyEvent { key: Key::Escape, mods: Mods::default() });
    settle(&mut rt);
    assert!(!rt.state.upgrade.open);
}

#[test]
fn escape_closes_the_sheet_and_nothing_under_it() {
    let mut app = App::with_mock();
    app.open_settings(crate::app::SettingsPage::Usage);
    let mut rt = runtime(app);
    settle(&mut rt);
    click(&mut rt, "set-upgrade");
    rt.key(KeyEvent { key: Key::Escape, mods: Mods::default() });
    settle(&mut rt);
    assert!(!rt.state.upgrade.open, "Escape closes the sheet");
    assert_eq!(rt.state.view, View::Settings, "and leaves Settings open under it");
    // While it waits on Whop, a click outside does nothing; Escape cancels.
    click(&mut rt, "set-upgrade");
    click(&mut rt, "upgrade-go");
    rt.pointer_down(20.0, 880.0);
    rt.pointer_up(20.0, 880.0);
    settle(&mut rt);
    assert!(rt.state.upgrade.open && rt.state.data.extra.billing.checkout.is_some());
    rt.key(KeyEvent { key: Key::Escape, mods: Mods::default() });
    settle(&mut rt);
    assert!(!rt.state.upgrade.open && rt.state.data.extra.billing.checkout.is_none());
}

#[test]
fn settings_upgrade_opens_the_sheet_and_paid_plans_have_none() {
    let mut app = App::with_mock();
    app.open_settings(crate::app::SettingsPage::Usage);
    let mut rt = runtime(app);
    settle(&mut rt);
    click(&mut rt, "set-upgrade");
    assert!(rt.state.upgrade.open, "Upgrade opens the sheet, not the website");
    assert!(rt.find("set-free-limit").is_some(), "the free amount shows once the account answered");
    rt.update(|s, _| {
        s.close_upgrade();
        s.data.extra.billing.plan = Some(crate::model::Plan { key: "pro".into(), name: "Max".into(), models: Vec::new() });
    });
    settle(&mut rt);
    assert!(rt.find("set-upgrade").is_none() && rt.find("set-free-limit").is_none());
}

fn press(rt: &mut Runtime<App>, key: Key) {
    rt.key(KeyEvent { key, mods: Mods::default() });
    rt.frame(1.0 / 60.0);
}

fn type_text(rt: &mut Runtime<App>, s: &str) {
    for c in s.chars() {
        press(rt, Key::Text(c.to_string()));
    }
}

#[test]
fn the_editor_suggests_as_you_type_closes_brackets_and_keeps_the_indent() {
    let mut s = App::with_mock();
    s.go(View::Code);
    s.poll_code();
    let mut rt = runtime(s);
    settle(&mut rt);
    click(&mut rt, "code-editor");
    // The caret at the end of `  root.innerHTML = cards.join("");`.
    let end = "root.innerHTML = cards.join(\"\");";
    let at = rt.state.edit(EditKey::Code).text.find(end).expect("the sample line") + end.len();
    rt.state.edit_mut(EditKey::Code).set_caret(at);
    press(&mut rt, Key::Enter);
    assert!(rt.state.edit(EditKey::Code).text[at..].starts_with("\n  \n}"), "Enter keeps the line's indent");

    type_text(&mut rt, "re");
    settle(&mut rt);
    let first = rt.state.completion_shown().map(|p| p.items[0].label.clone());
    assert_eq!(first.as_deref(), Some("renderPricing"), "the file's own words come first");
    assert!(rt.find("code-complete").is_some(), "the popup shows under the caret");
    press(&mut rt, Key::Down);
    assert_eq!(rt.state.completion_shown().map(|p| p.pick), Some(1), "Down picks the next one");
    press(&mut rt, Key::Up);
    press(&mut rt, Key::Tab);
    assert!(rt.state.completion_shown().is_none(), "taking one closes the list");
    type_text(&mut rt, "(");
    let text = rt.state.edit(EditKey::Code).text.clone();
    assert!(text.contains("\n  renderPricing()\n}"), "Tab took it and ( closed itself: {text}");
    // The caret sits inside the brackets; typing the closer steps over it.
    type_text(&mut rt, ")");
    assert!(rt.state.edit(EditKey::Code).text.contains("\n  renderPricing()\n}"));

    // Esc closes the list and leaves the text alone.
    type_text(&mut rt, ";");
    press(&mut rt, Key::Enter);
    type_text(&mut rt, "pl");
    assert!(rt.state.completion_shown().is_some());
    press(&mut rt, Key::Escape);
    assert!(rt.state.completion_shown().is_none());
    assert!(rt.state.edit(EditKey::Code).text.contains("renderPricing();\n  pl\n}"));
}

#[test]
fn run_starts_the_projects_dev_script_in_the_terminal() {
    let mut s = App::with_mock();
    s.go(View::Code);
    s.poll_code();
    let mut rt = runtime(s);
    settle(&mut rt);
    // The sample project is a Vite site (its package.json has a dev script).
    let plans = rt.state.run_plans();
    assert_eq!(plans.first().map(|p| p.note()).as_deref(), Some("npm run dev"));
    rt.key(KeyEvent { key: Key::Function(5), mods: Mods { ctrl: true, cmd: !cfg!(target_os = "macos"), ..Mods::default() } });
    settle(&mut rt);
    assert!(rt.state.panes.terminal, "the terminal opens to show the run");
    assert!(rt.state.data.extra.terminal.iter().any(|l| l.text == "npm run dev"));
    assert!(rt.find("terminal-pane").is_some());
    // While it runs (the sample's `npm run dev` task), Run reads Stop.
    click(&mut rt, "code-stop");
    assert!(rt.state.running_run().is_none());
    // Run's menu lists the other ways, and the Ports panel.
    click(&mut rt, "code-run-more");
    assert!(rt.find("code-run/0").is_some() && rt.find("code-run/ports").is_some());
}

#[test]
fn ports_lists_dev_servers_and_shares_them() {
    let mut s = App::with_mock();
    s.go(View::Code);
    s.poll_code();
    s.data.extra.terminal.push(crate::model::TermLine { kind: crate::model::TermKind::Out, text: "Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...".into() });
    s.show_ports(true);
    let mut rt = runtime(s);
    settle(&mut rt);
    assert!(rt.find("ports-pane").is_some());
    // From the sample's running `npm run dev`, and the terminal.
    assert!(rt.find("port/5173").is_some() && rt.find("port/8000").is_some());
    rt.state.edit_mut(EditKey::PortAdd).replace_text("3000");
    click(&mut rt, "port-add-button");
    assert!(rt.find("port/3000").is_some(), "a port added by hand");
    click(&mut rt, "port-share/3000");
    assert_eq!(rt.state.data.extra.ports.forwards.first().map(|f| f.state.as_str()), Some("open"));
    assert!(rt.find("port-unshare/3000").is_some());
    click(&mut rt, "port-remove/8000");
    assert!(rt.find("port/8000").is_none());
    // Live Server opens the page in the browser once it's up.
    rt.state.open_live("index.html");
    settle(&mut rt);
    assert_eq!(rt.state.browser.current().map(|t| t.url.clone()).as_deref(), Some("http://127.0.0.1:5500/index.html"));
}
