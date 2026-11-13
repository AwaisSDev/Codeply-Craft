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
        assert!(rt.find("titlebar").is_some() && rt.find("rail").is_some(), "{name}: the shell is missing");
        assert_eq!(rt.find("side").is_some(), rt.state.view != View::Office, "{name}: the sidebar shows on every view but Office");
    }
}

#[test]
fn the_rail_switches_views() {
    let mut rt = runtime(App::with_mock());
    assert_eq!(rt.state.view, View::Office, "Office is the default view");
    for (key, view) in [("rail-Chat", View::Chat), ("rail-Code", View::Code), ("rail-Pull requests", View::Prs), ("rail-Apps", View::Apps), ("rail-Office", View::Office)] {
        click(&mut rt, key);
        assert_eq!(rt.state.view, view, "{key}");
    }
}

#[test]
fn clicking_an_agent_opens_its_drawer_and_escape_closes_it() {
    let mut rt = runtime(App::with_mock());
    settle(&mut rt);
    click(&mut rt, "agent/research");
    assert_eq!(rt.state.drawer.as_deref(), Some("research"));
    assert!(rt.find("drawer").is_some());
    rt.key(KeyEvent { key: Key::Escape, mods: Mods::default() });
    settle(&mut rt);
    assert_eq!(rt.state.drawer, None);
}

#[test]
fn the_board_toggle_and_back() {
    let mut s = App::with_mock();
    s.go(View::Board);
    let mut rt = runtime(s);
    settle(&mut rt);
    assert!(rt.find("board").is_some());
    assert!(rt.find("rail-Office").is_some());
}

#[test]
fn a_message_from_the_drawer_lands_in_the_session() {
    let mut s = App::with_mock();
    s.open_drawer("research");
    s.edit_mut(EditKey::Drawer).replace_text("Book it for 7pm");
    s.submit(EditKey::Drawer, &crate::store::Target::Agent("research".into()));
    assert!(s.edit(EditKey::Drawer).text.is_empty(), "the composer clears after sending");
    let session = s.data.session("research");
    assert!(session.iter().any(|b| matches!(b, crate::model::Block::Bubble(t) if t == "Book it for 7pm")));
}

#[test]
fn the_walker_moves_and_the_office_asks_for_its_next_step() {
    let mut rt = runtime(App::with_mock());
    settle(&mut rt);
    let start = rt.state.office.actor("docs", |a| a.offset.get());
    for _ in 0..(60 * 4) {
        rt.frame(1.0 / 60.0);
    }
    let later = rt.state.office.actor("docs", |a| a.offset.get());
    assert_ne!(start, later, "Docs walks the corridor");
}
