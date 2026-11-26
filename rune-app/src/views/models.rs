//! Models: the composer's model menu, and Settings > Models (the list, adding your own, and
//! finding what Ollama has pulled). The words follow the Electron app's: "Add a model", "Base URL",
//! "Model ID", "API key", "Use on my phone", "Test & save".

use rune::{El, Side, col, el, row, text, text_input};

use crate::app::App;
use crate::icons::{ico, ico_s};
use crate::model::{ButtonKind, Pill};
use crate::models::{AUTO, KEY, MODEL, ModelInfo, NAME, PICKS, PRESETS, URL, pick_name, plan_rank};
use crate::theme::{Theme, ui};
use crate::ui::{btn, menu, menu_item, pill, toggle};

// ---------- the composer's menu ----------

/// How hard the picked model thinks: its levels (value, name), the one it's on, and how to set it.
struct Effort {
    levels: Vec<(String, String)>,
    current: String,
    default: String,
    /// The model it belongs to; None for Haze 2, whose effort is the app's own setting.
    model: Option<String>,
}

fn effort_of(s: &App) -> Option<Effort> {
    let models = &s.data.extra.models;
    match models.current() {
        // A Yune model: the router sets how hard it thinks.
        None if pick_name(&models.selected).is_some() => None,
        None => Some(Effort {
            levels: ["Low", "Medium", "High"].iter().map(|e| (e.to_string(), e.to_string())).collect(),
            current: s.prefs.effort.clone(),
            default: "High".into(),
            model: None,
        }),
        Some(m) if m.has_effort() => Some(Effort {
            levels: m.efforts().into_iter().filter(|(v, _)| !v.is_empty()).collect(),
            current: m.effort.clone(),
            default: String::new(),
            model: Some(m.id.clone()),
        }),
        Some(_) => None,
    }
}

/// Sets the effort and keeps the picker open (the slider is for trying levels).
fn set_effort(s: &mut App, model: Option<&str>, value: &str, menu_id: &str) {
    match model {
        Some(id) => s.model_set_effort(id, value),
        None => s.set_effort(value),
    }
    s.menu = Some(menu_id.to_owned());
}

/// The model picker over a composer, as one panel: how hard it thinks, big, with the model's
/// name under it (a click lists the models), and a slider of the effort levels; then, opened,
/// Haze 2, Yune's models and the ones you added.
pub fn composer_menu(s: &App, t: &Theme, key: &str) -> El {
    let models = &s.data.extra.models;
    let menu_id = format!("model:{key}");
    let list_key = format!("model-list/{key}");
    let effort = effort_of(s);
    // The list shows when you open it, or when there's no effort to set.
    let listing = effort.is_none() || s.expanded.contains(&list_key);
    let (name, _) = models.chip(&s.prefs.effort);
    let mut items = Vec::new();

    // The head: the effort, the model's name under it, and a reset.
    let big = match &effort {
        Some(e) => e.levels.iter().find(|(v, _)| *v == e.current).map_or_else(|| crate::models::effort_label(&e.current), |(_, l)| l.clone()),
        None => "Auto effort".into(),
    };
    let toggle_list = list_key.clone();
    let reset = effort.as_ref().filter(|e| e.current != e.default).map(|e| {
        let (model, value, menu_id) = (e.model.clone(), e.default.clone(), menu_id.clone());
        el().key("model-effort-reset").size(30.0, 30.0).radius(15.0).center().hover(t.hover).role("button").label("Reset effort").help("Back to the default")
            .child(ico_s("refresh", 15.0, t.dim))
            .on_press(move |s: &mut App| set_effort(s, model.as_deref(), &value, &menu_id))
    });
    items.push(row().px(8.0).pt(6.0).pb(4.0).gap(8.0).center_y()
        .child(el().size(30.0, 30.0).center().child(ico_s("gauge", 16.0, t.faint)))
        .child(col().grow(1.0).min_w(0.0).items_center().gap(2.0)
            .child(text(big).font(ui(17.0, 650.0).tracking(-0.2)).color(t.accent))
            .child(row().key("model-name").gap(2.0).px(8.0).h(22.0).radius(11.0).center_y().hover(t.hover).role("button")
                .label(format!("{name}: pick another model")).checked(listing)
                .child(text(name.clone()).font(ui(12.5, 500.0)).color(t.dim).truncate())
                .child(ico_s(if listing { "chevron-down" } else { "chevron-right" }, 13.0, t.faint))
                .on_press(move |s: &mut App| s.toggle_expanded(&toggle_list))))
        .child(reset.unwrap_or_else(|| el().size(30.0, 30.0))));

    // The slider: one stop per level, filled up to the one it's on, a white knob there.
    if let Some(e) = &effort {
        if e.levels.is_empty() {
            items.push(text("Checking which levels this model takes").font(ui(12.5, 400.0)).color(t.faint).px(10.0).py(6.0));
        } else {
            let on = e.levels.iter().position(|(v, _)| *v == e.current);
            let cells = e.levels.iter().enumerate().map(|(i, (value, label))| {
                let (model, value, menu_id) = (e.model.clone(), value.clone(), menu_id.clone());
                let filled = on.is_some_and(|k| i < k);
                let here = on == Some(i);
                let mut cell = el().key(format!("effort/{value}")).grow(1.0).h(30.0).center().role("button").label(label.clone()).checked(here).help(label.clone());
                if filled {
                    cell = cell.fill(t.accent);
                }
                if here {
                    // Filled up to the knob's middle, the knob on top.
                    cell = cell.child(el().absolute(0.0, 0.0).w_full().h(30.0).child(row().w_full().h(30.0)
                        .child(el().grow(1.0).h(30.0).fill(t.accent))
                        .child(el().grow(1.0).h(30.0))))
                        .child(el().size(22.0, 22.0).radius(11.0).fill(rune::Color::WHITE).shadow(2.0, 6.0, t.shadow));
                } else {
                    cell = cell.child(el().size(4.0, 4.0).radius(2.0).fill(if filled { rune::Color::WHITE.alpha(0.8) } else { t.faint }));
                }
                cell.on_press(move |s: &mut App| set_effort(s, model.as_deref(), &value, &menu_id))
            });
            items.push(row().key("effort-slider").mx(8.0).mt(2.0).h(30.0).radius(15.0).continuous_corners().clip_rounded(15.0).fill(t.control).children(cells));
            // The levels' names under their stops.
            items.push(row().mx(8.0).pt(4.0).pb(6.0).children(e.levels.iter().map(|(v, l)| {
                text(l.clone()).font(ui(11.0, if *v == e.current { 600.0 } else { 400.0 })).color(if *v == e.current { t.text } else { t.faint }).grow(1.0).align(rune::Align::Center)
            })));
        }
    }

    // The models, when opened.
    if listing {
        let divider = || el().w_full().py(4.0).child(el().w_full().h(1.0).fill(t.border));
        items.push(divider());
        items.push(menu_item(t, "model/auto".into(), Some("sparkle"), "Haze 2", Some("Picks the best model for each task"), models.selected == AUTO)
            .on_press(|s: &mut App| s.model_pick(AUTO)));
        // Yune's own models, by plan: one above your plan names it and opens the upgrade on it.
        let have = s.data.extra.billing.plan.as_ref().map_or(0, |p| plan_rank(&p.key));
        items.push(label(t, "Yune models"));
        for (id, name, needs) in PICKS {
            let open = plan_rank(needs) <= have;
            let note = if open { None } else { Some(if needs == "pro" { "Max" } else { "Pro" }) };
            items.push(menu_item(t, format!("model/{id}"), Some("sparkle"), name, note, models.selected == id)
                .on_press(move |s: &mut App| if open { s.model_pick(id) } else { s.open_upgrade_for(needs) }));
        }
        if !models.list.is_empty() {
            items.push(label(t, "Your models"));
        }
        for m in &models.list {
            let id = m.id.clone();
            items.push(menu_item(t, format!("model/{}", m.id), Some(if m.is_local() { "laptop" } else { "chip" }), &m.name, Some(&m.place()), models.selected == m.id)
                .on_press(move |s: &mut App| s.model_pick(&id)));
        }
        items.push(divider());
        items.push(menu_item(t, "model/add".into(), Some("plus"), "Add a model", None, false).on_press(|s: &mut App| s.model_add_from_menu()));
    }
    menu(t, &format!("model-chip/{key}"), Side::Top, 320.0, items).padding(8.0).radius(18.0).continuous_corners()
}

/// The picked model's effort levels as menu rows (none when the model sets its own).
fn effort_items(s: &App, t: &Theme) -> Vec<El> {
    let models = &s.data.extra.models;
    let mut items = Vec::new();
    match models.current() {
        // A Codeply model: the router sets how hard it thinks.
        None if pick_name(&models.selected).is_some() => {}
        None => {
            for (effort, note) in [("Low", "Fastest replies"), ("Medium", "Balanced"), ("High", "Thinks longest, best for hard tasks")] {
                items.push(menu_item(t, format!("effort/{effort}"), None, effort, Some(note), s.prefs.effort == effort)
                    .on_press(move |s: &mut App| s.set_effort(effort)));
            }
        }
        Some(m) if m.has_effort() => {
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
    items
}

/// `/effort`: how hard the picked model thinks, on its own, over the model chip.
pub fn effort_menu(s: &App, t: &Theme, key: &str) -> El {
    let mut items = vec![label(t, "Effort")];
    let levels = effort_items(s, t);
    if levels.is_empty() {
        items.push(text("This model sets its own effort.").font(ui(12.5, 400.0)).color(t.faint).px(10.0).py(6.0));
    }
    items.extend(levels);
    items.push(el().w_full().py(3.0).child(el().w_full().h(1.0).fill(t.border)));
    let models = format!("model:{key}");
    items.push(menu_item(t, "effort/models".into(), Some("sparkle"), "Pick another model", None, false)
        .on_press(move |s: &mut App| { s.menu = None; s.toggle_menu(&models); }));
    menu(t, &format!("model-chip/{key}"), Side::Top, 280.0, items)
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
        out.push(linked_group(s, t));
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
        .child(col().w_full().fill(t.card).border(1.0, t.card_border).radius(12.0).continuous_corners()
            .children(rows.into_iter().enumerate().map(|(i, r)| r.border_sides([if i == 0 { 0.0 } else { 1.0 }, 0.0, 0.0, 0.0], t.card_border))))
}

/// A square icon button in a model row.
fn tool(t: &Theme, key: String, icon: &str, label: &str, on: bool) -> El {
    el().key(key).size(30.0, 30.0).radius(8.0).continuous_corners().center().hover(t.hover).role("button").label(label.to_owned()).help(label.to_owned())
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
            .child(el().size(30.0, 30.0).radius(8.0).continuous_corners().center().fill(t.accent.alpha(0.14)).child(ico_s("sparkle", 17.0, t.accent)))
            .child(col().grow(1.0).min_w(0.0).gap(2.0)
                .child(text("Haze 2").font(ui(14.0, 500.0)).color(t.text))
                .child(text("Yune's own model. It picks the best model for each task. Included with your account.").font(ui(12.5, 400.0)).color(t.dim).wrap()))
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
        .child(el().size(30.0, 30.0).radius(8.0).continuous_corners().center().fill(t.hover).child(ico_s(icon, 17.0, t.dim)))
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

/// Your Claude and ChatGPT plans (any Codeply plan, Free too): subagents run on them, and the agent keeps
/// going on them once your Codeply limit is used up.
fn linked_group(s: &App, t: &Theme) -> El {
    // On every plan, Free included.
    let linked = &s.data.extra.linked;
    let item = |which: &'static str, name: &str, tile: rune::Color, ink: rune::Color, glyph: &str, l: &crate::model::LinkedPlan| {
        let desc = if l.busy {
            if l.stage.is_empty() { "Starting...".to_owned() } else { l.stage.clone() }
        } else if l.connected {
            [l.plan.as_str(), l.email.as_str()].iter().filter(|x| !x.is_empty()).copied().collect::<Vec<_>>().join(" · ")
        } else if !l.error.is_empty() {
            l.error.clone()
        } else {
            format!("Sign in with your {name} plan")
        };
        let action = if l.busy {
            btn(t, if l.stage.starts_with("Downloading") { "Installing…" } else { "Waiting…" }, None, ButtonKind::Plain).key(format!("linked-{which}-busy"))
        } else if l.connected {
            btn(t, "Sign out", None, ButtonKind::Plain).key(format!("linked-{which}-out")).on_press(move |s: &mut App| s.linked_sign_out(which))
        } else {
            btn(t, "Connect", None, ButtonKind::Plain).key(format!("linked-{which}-in")).on_press(move |s: &mut App| s.linked_sign_in(which))
        };
        row().w_full().min_h(60.0).px(16.0).py(12.0).gap(14.0).center_y()
            .child(el().size(30.0, 30.0).radius(8.0).continuous_corners().center().fill(tile).border(1.0, t.card_border).child(ico_s(glyph, 18.0, ink)))
            .child(col().grow(1.0).min_w(0.0).gap(2.0)
                .child(row().gap(8.0).center_y()
                    .child(text(name.to_owned()).font(ui(14.0, 500.0)).color(t.text))
                    .children(l.connected.then(|| pill(t, "Connected", Pill::Green))))
                .child(text(desc).font(ui(12.5, 400.0)).color(if l.error.is_empty() || l.connected || l.busy { t.dim } else { t.red }).wrap()))
            .child(action)
    };
    col().gap(8.0)
        .child(group(t, "Your plans", vec![
            // Their own marks: Claude's spark in its clay orange, OpenAI's knot in black, on white.
            item("claude", "Claude", rune::Color::WHITE, rune::color::hex("#D97757").unwrap_or(t.accent), "app-claude", &linked.claude),
            item("chatgpt", "ChatGPT", rune::Color::WHITE, rune::Color::BLACK, "app-openai", &linked.chatgpt),
        ]))
        .child(note(t, "Subagents run on a plan you connect, and Yune keeps working on it after your own limit runs out."))
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
        .child(row().w_full().h(36.0).px(12.0).radius(9.0).continuous_corners().center_y().fill(t.hover).border(1.0, t.border).child(input))
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
        "Your API key is saved on this computer and sent once to your Yune account, where it is stored encrypted for your phone. It is never shown again, and is only used to call the base URL above."
    } else {
        "Your API key is saved only on this computer and is never sent to Yune. It is used for exactly one thing: calling the base URL above."
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
            .child(el().size(30.0, 30.0).radius(8.0).continuous_corners().center().fill(t.hover).child(ico("laptop", t.dim)))
            .child(col().grow(1.0).min_w(0.0).gap(2.0)
                .child(text(name.clone()).font(ui(14.0, 500.0)).color(t.text).truncate())
                .child(text(detail.clone()).font(ui(12.5, 400.0)).color(t.dim).truncate()))
            .child(btn(t, if added { "Use" } else { "Add" }, None, ButtonKind::Plain).key(format!("scan-add/{name}")).on_press(move |s: &mut App| s.model_add_local(&n))));
    }
    group(t, "Installed in Ollama", rows)
}
