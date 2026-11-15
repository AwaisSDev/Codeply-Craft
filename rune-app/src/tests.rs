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
    s.data.extra.chats.insert(0, crate::model::ChatMeta { title: "Links".into(), project: String::new(), ago: "now".into(), preview: String::new(), running: true, unread: false });
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
            let background = look.contains("dots") || look.contains("ascii") || look.contains("picture");
            assert_eq!(rt.find("backdrop").is_some(), background, "{name} ({look}): the background layer");
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
fn the_composer_plus_attaches_files_and_sends_their_paths() {
    let mut rt = runtime(App::with_mock());
    click(&mut rt, "attach-chat-home");
    let kind = rt.file_dialog().map(|(k, _)| k);
    assert_eq!(kind, Some(rune::FileDialogKind::Open), "the + opens a file picker");
    let file = std::path::PathBuf::from("/home/sam/brief.pdf");
    rt.resolve_file_dialog(Some(file)).unwrap_or_else(|e| panic!("{e}"));
    settle(&mut rt);
    assert_eq!(rt.state.attachments.get(&EditKey::ChatHome).cloned(), Some(vec!["/home/sam/brief.pdf".to_owned()]));
    assert!(rt.find("attached//home/sam/brief.pdf").is_some(), "the file shows as a chip above the field");
    // A file alone is enough to send.
    click(&mut rt, "send-chat-home");
    assert!(rt.state.attachments.get(&EditKey::ChatHome).is_none_or(Vec::is_empty), "sending takes the attachments with it");
    let sent = rt.state.data.threads.iter().flat_map(|(_, items)| items.iter()).any(|i| matches!(i, crate::model::ThreadItem::You(t) if t.contains("Attached files:") && t.contains("/home/sam/brief.pdf")));
    assert!(sent, "the message carries the file's path");
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
    rt.update(|s, _| s.data.extra.repo = Some(crate::model::RepoState { repo: true, remote: true, branch: "fix".into(), base: "main".into(), gh: String::new() }));
    settle(&mut rt);
    assert!(rt.find("prs-create").is_some(), "a branch with nothing open can open a pull request");
}
