//! The model menu and Settings > Models, driven through Rune's headless runtime on the sample data.

use rune::{Env, Runtime};

use crate::app::{App, SettingsPage};
use crate::models::{AUTO, KEY, MODEL, NAME, URL};
use crate::shell;

fn runtime(state: App) -> Runtime<App> {
    let env = Env { system_dark: true, scale: 1.0 };
    let mut rt = Runtime::new(state, shell::view, (1440.0, 1000.0), env);
    rt.frame(0.0);
    rt
}

/// A runtime on the sample data, after `setup` changed the app (the view is built from the state it starts with).
fn start(setup: impl FnOnce(&mut App)) -> Runtime<App> {
    let mut s = App::with_mock();
    setup(&mut s);
    runtime(s)
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
fn the_composer_menu_picks_a_model_and_its_effort() {
    let mut rt = runtime(App::with_mock());
    assert_eq!(rt.state.data.extra.models.chip("High").0, "Haze 2");
    click(&mut rt, "model-chip/chat-home");
    click(&mut rt, "model/m1");
    assert_eq!(rt.state.data.extra.models.selected, "m1");
    assert!(rt.state.menu.is_none(), "picking closes the menu");
    assert_eq!(rt.state.data.extra.models.chip("High"), ("GPT-4o mini".into(), Some("Medium".into())));
    click(&mut rt, "model-chip/chat-home");
    click(&mut rt, "effort/high");
    assert_eq!(rt.state.data.extra.models.current().map(|m| m.effort.as_str()), Some("high"));
    // Back to Haze 2, whose effort is the app's own.
    click(&mut rt, "model-chip/chat-home");
    click(&mut rt, "model/auto");
    assert_eq!(rt.state.data.extra.models.selected, AUTO);
}

#[test]
fn a_model_without_effort_shows_none() {
    let mut rt = start(|s| s.model_pick("m3")); // Ollama: no effort
    click(&mut rt, "model-chip/chat-home");
    assert!(rt.find("effort/low").is_none() && rt.find("effort/default").is_none());
    assert!(rt.find("model/add").is_some());
}

#[test]
fn adding_a_model_tests_it_saves_it_and_picks_it() {
    let mut rt = runtime(App::with_mock());
    click(&mut rt, "model-chip/chat-home");
    click(&mut rt, "model/add");
    assert_eq!(rt.state.settings, SettingsPage::Models);
    settle(&mut rt);
    assert!(rt.find("model-save").is_some(), "the form is open");
    // A refusing provider: the reason shows and "Save without testing" is offered.
    for (i, v) in [(NAME, "Mine"), (URL, "https://fail.example.com/v1"), (MODEL, "m-1"), (KEY, "sk-secret")] {
        rt.state.model_edit_mut(i).replace_text(v);
    }
    settle(&mut rt);
    click(&mut rt, "model-save");
    assert!(rt.state.data.extra.models.test_failed);
    assert_eq!(rt.state.data.extra.models.list.len(), 4);
    assert!(rt.find("model-save-anyway").is_some());
    click(&mut rt, "model-save-anyway");
    let m = &rt.state.data.extra.models;
    assert_eq!((m.list.len(), m.selected.as_str(), m.error.is_none()), (5, "m104", true));
    assert!(!rt.state.models_ui.open(m), "the form closes");
    assert_eq!(rt.state.models_ui.edits[KEY].text, "", "the key is forgotten");
    settle(&mut rt);
    assert!(rt.find("model-save").is_none());
}

#[test]
fn the_form_says_what_is_missing_without_asking_the_engine() {
    let mut rt = start(|s| { s.open_settings(SettingsPage::Models); s.model_open_form(None); });
    click(&mut rt, "model-save");
    let m = &rt.state.data.extra.models;
    assert!(m.error.as_deref().is_some_and(|e| e.contains("model id")), "{:?}", m.error);
    assert_eq!(m.list.len(), 4);
}

#[test]
fn removing_a_model_takes_two_presses() {
    let mut rt = start(|s| { s.open_settings(SettingsPage::Models); s.model_pick("m2"); });
    click(&mut rt, "model-delete/m2");
    assert_eq!(rt.state.data.extra.models.list.len(), 4, "the first press only asks");
    click(&mut rt, "model-remove-no/m2");
    assert!(rt.state.models_ui.confirm.is_none());
    click(&mut rt, "model-delete/m2");
    click(&mut rt, "model-remove-yes/m2");
    let m = &rt.state.data.extra.models;
    assert_eq!((m.list.len(), m.selected.as_str()), (3, AUTO), "removing the picked model falls back to Haze 2");
}

#[test]
fn ollama_models_are_found_and_added_without_a_key() {
    let mut rt = start(|s| s.open_settings(SettingsPage::Models));
    click(&mut rt, "model-add-ollama-local");
    click(&mut rt, "scan-add/llama3.2:3b");
    let m = &rt.state.data.extra.models;
    let added = m.list.last().unwrap();
    assert_eq!((added.kind.as_str(), added.model.as_str(), added.has_key), ("ollama", "llama3.2:3b", false));
    assert_eq!(m.selected, added.id);
}

#[test]
fn editing_keeps_the_saved_key() {
    let mut rt = start(|s| s.open_settings(SettingsPage::Models));
    click(&mut rt, "model-edit/m1");
    assert_eq!(rt.state.models_ui.edits[NAME].text, "GPT-4o mini");
    rt.state.model_edit_mut(NAME).replace_text("Renamed");
    settle(&mut rt);
    click(&mut rt, "model-save");
    let m = rt.state.data.extra.models.list.iter().find(|m| m.id == "m1").unwrap();
    assert_eq!((m.name.as_str(), m.has_key), ("Renamed", true));
}
