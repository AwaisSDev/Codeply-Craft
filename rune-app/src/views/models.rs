//! Models: the composer's model menu, and Settings > Models (the list, adding your own, and
//! finding what Ollama has pulled). The words follow the Electron app's: "Add a model", "Base URL",
//! "Model ID", "API key", "Use on my phone", "Test & save".

use rune::{El, Side, col, el, row, text, text_input};

use crate::app::App;
use crate::icons::{ico, ico_s};
use crate::model::{ButtonKind, Pill};
use crate::models::{AUTO, KEY, MODEL, ModelInfo, NAME, PRESETS, URL};
use crate::theme::{Theme, ui};
use crate::ui::{btn, menu, menu_item, pill, toggle};

// ---------- the composer's menu ----------

/// The model menu over a composer: Haze 2, the models you added, the picked one's effort, and a
/// way to add another.
pub fn composer_menu(s: &App, t: &Theme, key: &str) -> El {
    let models = &s.data.extra.models;
    let divider = || el().w_full().py(3.0).child(el().w_full().h(1.0).fill(t.border));
    let mut items = vec![
        menu_item(t, "model/auto".into(), None, "Haze 2", Some("Picks the best model for each task"), models.selected == AUTO)
            .on_press(|s: &mut App| s.model_pick(AUTO)),
    ];
    for m in &models.list {
        let id = m.id.clone();
        items.push(menu_item(t, format!("model/{}", m.id), Some(if m.is_local() { "laptop" } else { "chip" }), &m.name, Some(&m.place()), models.selected == m.id)
            .on_press(move |s: &mut App| s.model_pick(&id)));
    }
    // How hard it thinks. Haze 2 keeps the app's own setting; a model you added has what its provider offers.
    match models.current() {
        None => {
            items.push(divider());
            items.push(label(t, "Effort"));
            for (effort, note) in [("Low", "Fastest replies"), ("Medium", "Balanced"), ("High", "Thinks longest, best for hard tasks")] {
                items.push(menu_item(t, format!("effort/{effort}"), None, effort, Some(note), s.prefs.effort == effort)
                    .on_press(move |s: &mut App| s.set_effort(effort)));
            }
        }
        Some(m) if m.has_effort() => {
            items.push(divider());
            items.push(label(t, "Effort"));
            if m.effort_levels.is_none() {
                items.push(text("Checking which levels this model takes").font(ui(12.5, 400.0)).color(t.faint).px(10.0).py(6.0));
            }
            for (effort, name) in m.efforts() {
                let id = m.id.clone();
                let on = m.effort == effort;
                items.push(menu_item(t, format!("effort/{}", if effort.is_empty() { "default" } else { &effort }), None, &name, None, on)
                    .on_press(move |s: &mut App| s.model_set_effort(&id, &effort)));
            }
        }
        Some(_) => {}
    }
    items.push(divider());
    items.push(menu_item(t, "model/add".into(), Some("plus"), "Add a model", None, false).on_press(|s: &mut App| s.model_add_from_menu()));
    menu(t, &format!("model-chip/{key}"), Side::Top, 300.0, items)
}

fn label(t: &Theme, name: &str) -> El {
    text(name.to_owned()).font(ui(12.0, 600.0)).color(t.faint).px(10.0).pt(4.0).pb(2.0)
}

// ---------- Settings > Models ----------

/// The page's groups (the Settings page puts its own title above them).
pub fn groups(s: &App, t: &Theme) -> Vec<El> {
    let models = &s.data.extra.models;
    // The form goes first when it is open, so it never sits below the fold.
    let mut out = Vec::new();
    let scanning = models.scan.busy || models.scan.error.is_some() || !models.scan.found.is_empty();
    if s.models_ui.open(models) {
        out.push(form(s, t));
        out.push(list(s, t));
    } else {
        out.push(list(s, t));
        if scanning {
            out.push(scan_group(s, t));
        }
        out.push(add_group(s, t));
    }
    if s.models_ui.open(models) && scanning {
        out.push(scan_group(s, t));
    }
    out.push(note(t, "Models you add are saved on this computer, in the same file the Codeply desktop app reads, so both show the same list. A key is only ever sent to the base URL you entered for it."));
    out
}

fn note(t: &Theme, msg: &str) -> El {
    text(msg.to_owned()).font(ui(12.5, 400.0)).color(t.faint).wrap().px(4.0)
}

fn group(t: &Theme, title: &str, rows: Vec<El>) -> El {
    col().gap(8.0)
        .child(text(title.to_owned()).font(ui(13.0, 600.0)).color(t.dim).pl(4.0))
        .child(col().w_full().fill(t.card).border(1.0, t.card_border).radius(12.0)
            .children(rows.into_iter().enumerate().map(|(i, r)| r.border_sides([if i == 0 { 0.0 } else { 1.0 }, 0.0, 0.0, 0.0], t.card_border))))
}

/// A square icon button in a model row.
fn tool(t: &Theme, key: String, icon: &str, label: &str, on: bool) -> El {
    el().key(key).size(30.0, 30.0).radius(8.0).center().hover(t.hover).role("button").label(label.to_owned()).help(label.to_owned())
        .child(ico_s(icon, 16.0, if on { t.accent } else { t.dim }))
}

fn phone_pill(t: &Theme, m: &ModelInfo) -> Option<El> {
    let p = &m.phone;
    if !p.on {
        return None;
    }
    Some(if p.synced {
        pill(t, "On phone", Pill::Green)
    } else if p.reason.is_empty() {
        pill(t, "Syncing", Pill::Gray)
    } else {
        pill(t, "Not synced", Pill::Warn)
    })
}

fn list(s: &App, t: &Theme) -> El {
    let models = &s.data.extra.models;
    let mut rows = vec![
        row().key("models/auto").w_full().min_h(60.0).px(16.0).py(12.0).gap(14.0).center_y().hover(t.hover).role("radio").checked(models.selected == AUTO).label("Haze 2")
            .child(el().size(30.0, 30.0).radius(8.0).center().fill(t.accent.alpha(0.14)).child(ico_s("sparkle", 17.0, t.accent)))
            .child(col().grow(1.0).min_w(0.0).gap(2.0)
                .child(text("Haze 2").font(ui(14.0, 500.0)).color(t.text))
                .child(text("Codeply's own model. It picks the best model for each task. Included with your account.").font(ui(12.5, 400.0)).color(t.dim).wrap()))
            .child(pill(t, "Default", Pill::Blue))
            .children((models.selected == AUTO).then(|| ico_s("check", 18.0, t.text)))
            .on_press(|s: &mut App| s.model_pick(AUTO)),
    ];
    for m in &models.list {
        rows.push(model_row(s, t, m));
    }
    if models.list.is_empty() {
        rows.push(row().w_full().px(16.0).py(14.0).child(text("No models of your own yet. Add one below to use it instead of Haze 2.").font(ui(13.0, 400.0)).color(t.faint).wrap()));
    }
    group(t, "Models", rows)
}

fn model_row(s: &App, t: &Theme, m: &ModelInfo) -> El {
    let models = &s.data.extra.models;
    let selected = models.selected == m.id;
    let armed = s.models_ui.confirm.as_deref() == Some(m.id.as_str());
    let id = m.id.clone();
    let mut sub = format!("{} · {}", m.model, m.place());
    if m.has_key {
        sub.push_str(&format!(" · key {}", m.key_preview));
    }
    let icon = if m.is_local() { "laptop" } else { "chip" };
    let tools = if armed {
        let (a, b) = (m.id.clone(), m.id.clone());
        row().gap(6.0).center_y()
            .child(btn(t, "Remove", None, ButtonKind::Plain).key(format!("model-remove-yes/{}", m.id)).on_press(move |s: &mut App| s.model_delete(&a)))
            .child(btn(t, "Keep", None, ButtonKind::Plain).key(format!("model-remove-no/{}", b)).on_press(|s: &mut App| s.model_keep()))
    } else {
        let (e, d, p) = (m.id.clone(), m.id.clone(), m.id.clone());
        let on = m.phone.on;
        row().gap(2.0).center_y()
            .children(m.phone.eligible.then(|| {
                tool(t, format!("model-phone/{}", m.id), "phone", if on { "On your phone. Stop syncing it" } else { "Use on my phone" }, on)
                    .on_press(move |s: &mut App| s.model_phone(&p, !on))
            }))
            .child(tool(t, format!("model-edit/{}", m.id), "edit", "Edit", false).on_press(move |s: &mut App| s.model_open_form(Some(&e))))
            .child(tool(t, format!("model-delete/{}", m.id), "trash", "Remove", false).on_press(move |s: &mut App| s.model_delete(&d)))
    };
    row().key(format!("models/{}", m.id)).w_full().min_h(60.0).px(16.0).py(12.0).gap(14.0).center_y().hover(t.hover).role("radio").checked(selected).label(m.name.clone())
        .child(el().size(30.0, 30.0).radius(8.0).center().fill(t.hover).child(ico_s(icon, 17.0, t.dim)))
        .child(col().grow(1.0).min_w(0.0).gap(2.0)
            .child(row().gap(8.0).center_y()
                .child(text(m.name.clone()).font(ui(14.0, 500.0)).color(t.text).truncate())
                .children(phone_pill(t, m)))
            .child(text(sub).font(ui(12.5, 400.0)).color(t.dim).truncate())
            .children((!m.phone.reason.is_empty() && m.phone.on).then(|| text(m.phone.reason.clone()).font(ui(12.0, 400.0)).color(t.warn).wrap())))
        .child(tools)
        .children(selected.then(|| ico_s("check", 18.0, t.text)))
        .on_press(move |s: &mut App| s.model_pick(&id))
}

fn add_group(s: &App, t: &Theme) -> El {
    let _ = s;
    let item = |key: &str, title: &str, desc: &str, action: &str, f: fn(&mut App)| {
        row().w_full().min_h(56.0).px(16.0).py(12.0).gap(16.0).center_y()
            .child(col().grow(1.0).min_w(0.0).gap(2.0)
                .child(text(title.to_owned()).font(ui(14.0, 500.0)).color(t.text))
                .child(text(desc.to_owned()).font(ui(12.5, 400.0)).color(t.dim).wrap()))
            .child(btn(t, action, None, ButtonKind::Plain).key(key.to_owned()).on_press(f))
    };
    group(t, "Add a model", vec![
        item("model-add-api", "API model", "Any OpenAI-compatible API: OpenAI, Claude, Gemini, OpenRouter, Groq, DeepSeek or a server of your own.", "Add a model", |s: &mut App| s.model_open_form(None)),
        item("model-add-ollama-online", "Ollama online", "Big open models on your own ollama.com account: Kimi, GLM, DeepSeek, gpt-oss. Needs your key from ollama.com.", "Connect", |s: &mut App| {
            s.model_open_form(None);
            s.models_ui.preset(PRESETS.len() - 1);
        }),
        item("model-add-ollama-local", "Ollama on this computer", "Models you pulled with Ollama run right here: free and private, no internet needed.", "Find models", |s: &mut App| s.model_scan()),
    ])
}

/// One labelled single-line field.
fn field(s: &App, t: &Theme, i: usize, name: &str, placeholder: &str, secure: bool) -> El {
    let input = text_input(s.model_edit(i), ui(14.0, 400.0)).key(format!("model-field-{i}")).single_line().grow(1.0).color(t.text)
        .placeholder(placeholder.to_owned(), t.faint).caret(t.accent, t.accent.alpha(0.3)).label(name.to_owned())
        .on_edit(move |s: &mut App| s.model_edit_mut(i))
        .on_submit(|s: &mut App, _| s.model_submit(false));
    let input = if secure { input.secure() } else { input };
    col().w_full().gap(6.0)
        .child(text(name.to_owned()).font(ui(12.5, 500.0)).color(t.dim))
        .child(row().w_full().h(36.0).px(12.0).radius(9.0).center_y().fill(t.hover).border(1.0, t.border).child(input))
}

fn form(s: &App, t: &Theme) -> El {
    let models = &s.data.extra.models;
    let editing = s.models_ui.form.clone().flatten().and_then(|id| models.list.iter().find(|m| m.id == id));
    let title = if editing.is_some() { "Edit model" } else { "Add a model" };
    let key_hint = match editing {
        Some(m) if m.has_key => format!("Saved ({}). Leave blank to keep it.", m.key_preview),
        _ => "sk-...  (leave blank if the server needs no key)".to_owned(),
    };
    let presets = row().w_full().gap(6.0).flex_wrap().center_y()
        .child(text("Quick fill").font(ui(12.5, 500.0)).color(t.faint).mr(4.0))
        .children(PRESETS.iter().enumerate().map(|(i, (label, ..))| {
            row().key(format!("model-preset/{i}")).h(26.0).px(10.0).radius(13.0).center_y().fill(t.control).border(1.0, t.control_border).hover(t.hover)
                .role("button").label((*label).to_owned())
                .child(text((*label).to_owned()).font(ui(12.5, 500.0)).color(t.text))
                .on_press(move |s: &mut App| s.models_ui.preset(i))
        }));
    let blocker = s.models_ui.phone_blocker(models);
    let phone_on = s.models_ui.phone && blocker.is_none();
    let phone = row().w_full().gap(16.0).center_y()
        .child(col().grow(1.0).min_w(0.0).gap(2.0)
            .child(text("Use on my phone").font(ui(14.0, 500.0)).color(t.text))
            .child(text(blocker.unwrap_or(if phone_on { "Works on your phone even when this PC is off." } else { "Your phone can use it only while this PC is on." }).to_owned())
                .font(ui(12.5, 400.0)).color(t.dim).wrap()))
        .child(if blocker.is_some() { el().opacity(0.4).child(toggle(t, "model-phone-switch".into(), false, "Use on my phone")) }
            else { toggle(t, "model-phone-switch".into(), phone_on, "Use on my phone").on_press(|s: &mut App| s.models_ui.phone = !s.models_ui.phone) });
    let privacy = if phone_on {
        "Your API key is saved on this computer and sent once to your Codeply account, where it is stored encrypted for your phone. It is never shown again, and is only used to call the base URL above."
    } else {
        "Your API key is saved only on this computer and is never sent to Codeply. It is used for exactly one thing: calling the base URL above."
    };
    let busy = models.busy;
    let actions = row().w_full().gap(8.0).center_y().justify_end()
        .children(models.test_failed.then(|| btn(t, "Save without testing", None, ButtonKind::Plain).key("model-save-anyway").on_press(|s: &mut App| s.model_submit(true))))
        .child(btn(t, "Cancel", None, ButtonKind::Plain).key("model-cancel").on_press(|s: &mut App| s.model_close_form()))
        .child(btn(t, if busy { "Testing..." } else if editing.is_some() { "Test & update" } else { "Test & save" }, None, ButtonKind::Blue).key("model-save")
            .opacity(if busy { 0.6 } else { 1.0 })
            .on_press(|s: &mut App| s.model_submit(false)));
    let body = col().w_full().px(16.0).py(16.0).gap(14.0)
        .children(editing.is_none().then_some(presets))
        .child(field(s, t, NAME, "Name", "e.g. GPT-4o mini", false))
        .child(field(s, t, URL, "Base URL", "https://api.openai.com/v1", false))
        .child(field(s, t, MODEL, "Model ID", "gpt-4o-mini", false))
        .child(field(s, t, KEY, "API key", &key_hint, true))
        .child(phone)
        .child(row().w_full().gap(8.0).child(ico_s("lock", 14.0, t.faint)).child(text(privacy.to_owned()).font(ui(12.0, 400.0)).color(t.faint).wrap().grow(1.0).min_w(0.0)))
        .children(models.error.clone().map(|e| {
            let shown = if models.test_failed { format!("The test request failed: {e}") } else { e };
            text(shown).font(ui(13.0, 400.0)).color(t.red).wrap()
        }))
        .child(actions);
    group(t, title, vec![body])
}

fn scan_group(s: &App, t: &Theme) -> El {
    let scan = &s.data.extra.models.scan;
    let mut rows = Vec::new();
    if scan.busy {
        rows.push(row().w_full().px(16.0).py(14.0).child(text("Looking for Ollama...").font(ui(13.5, 400.0)).color(t.dim)));
    } else if let Some(e) = &scan.error {
        rows.push(col().w_full().px(16.0).py(14.0).gap(4.0)
            .child(text(e.clone()).font(ui(13.5, 400.0)).color(t.red).wrap())
            .child(text("Install it from ollama.com, open it, then press Find models again.").font(ui(12.5, 400.0)).color(t.faint).wrap()));
    } else if scan.found.is_empty() {
        rows.push(row().w_full().px(16.0).py(14.0).child(text("Ollama is running but has no models yet. In a terminal run: ollama pull qwen2.5-coder").font(ui(13.0, 400.0)).color(t.dim).wrap()));
    }
    for (name, detail) in &scan.found {
        let added = s.data.extra.models.list.iter().any(|m| m.kind == "ollama" && m.model == *name);
        let n = name.clone();
        rows.push(row().key(format!("scan/{name}")).w_full().min_h(56.0).px(16.0).py(10.0).gap(14.0).center_y()
            .child(el().size(30.0, 30.0).radius(8.0).center().fill(t.hover).child(ico("laptop", t.dim)))
            .child(col().grow(1.0).min_w(0.0).gap(2.0)
                .child(text(name.clone()).font(ui(14.0, 500.0)).color(t.text).truncate())
                .child(text(detail.clone()).font(ui(12.5, 400.0)).color(t.dim).truncate()))
            .child(btn(t, if added { "Use" } else { "Add" }, None, ButtonKind::Plain).key(format!("scan-add/{name}")).on_press(move |s: &mut App| s.model_add_local(&n))));
    }
    group(t, "Installed in Ollama", rows)
}
