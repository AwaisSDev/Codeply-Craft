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
    assert_eq!(rt.state.view, View::Agents, "Agents (Mission control) is the default view");
    assert!(rt.find("rail-Office").is_none(), "the Office is gone");
    for (key, view) in [
        ("rail-Chat", View::Chat), ("rail-Code", View::Code), ("rail-Pull requests", View::Prs),
        ("rail-Integrations", View::Integrations), ("rail-Agents", View::Agents),
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
    // The row's "more" button opens Appearance; Settings has no pickers.
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
fn eyes_glance_and_blink_on_their_own_clock() {
    let mut rt = runtime(App::with_mock());
    let a = rt.state.data.agent("frontend").cloned().unwrap_or_else(|| unreachable!());
    // Building a bot gives its eyes a life; animating moves them without rebuilding the view.
    let _ = crate::bot::agent(&a, 40.0);
    let glances: std::collections::HashSet<String> = (0..40)
        .map(|i| {
            crate::bot::animate(f64::from(i) * 0.5, false);
            format!("{:?}", crate::bot::gaze_of("frontend", 40.0))
        })
        .collect();
    assert!(glances.len() > 1, "the eyes drift between glances");
    assert!(crate::bot::animate(0.0, true).is_none(), "reduced motion holds them still");
    rt.frame(1.0 / 60.0);
}
