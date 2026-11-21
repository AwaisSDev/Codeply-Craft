//! Shared pieces, each matching a class in the prototype's stylesheet (named in its doc).

use rune::{Color, El, Span, Spring, Transition, col, el, rich, row, text, text_input};

use crate::app::{App, EditKey};
use crate::icons::{ico, ico_s};
use crate::model::{ButtonKind, Pill};
use crate::store::Target;
use crate::theme::{self, Theme, ui};

/// Dialogs and sheets settle fast: 0.14 s, no bounce. Views, tabs and rows don't animate at all:
/// a switch is drawn in one frame, and the window rests the frame after (on the CPU renderer
/// every frame of motion costs the whole window).
pub const ENTER: Spring = Spring::new(0.14, 0.0);

/// `.fade`, for dialogs and sheets only: a brief fade in, without moving. On the way out they're
/// gone the frame they leave.
pub fn fade_in() -> Transition {
    let mut t = Transition::opacity();
    t.removal = rune::Effect::opacity(0.0);
    t.springs = rune::SpringPair::new(ENTER, Spring::NONE);
    t
}

/// A row in a list: it's simply there (no fade, no cascade), so switching views is instant.
pub fn enter(e: El, _i: usize) -> El {
    e
}

/// Text with `**bold**` runs. Bold takes `strong` (the prototype's `b { color: var(--text) }`).
pub fn rich_text(src: &str, size: f32, color: Color, strong: Color) -> El {
    let mut plain = String::with_capacity(src.len());
    let mut spans = Vec::new();
    for (i, part) in src.split("**").enumerate() {
        let start = plain.len();
        plain.push_str(part);
        if i % 2 == 1 && !part.is_empty() {
            let mut s = Span::new(start, plain.len()).weight(600.0);
            s.color = Some(strong);
            spans.push(s);
        }
    }
    rich(plain, spans).font(ui(size, 400.0)).color(color)
}

/// `.btn`, `.btn.primary`, `.btn.blue`, `.btn.green`.
pub fn btn(t: &Theme, label: &str, icon: Option<&str>, kind: ButtonKind) -> El {
    let (fill, ink, border, weight) = match kind {
        ButtonKind::Plain => (t.control, t.text, t.control_border, 400.0),
        ButtonKind::Blue => (t.accent, t.on_accent, Color::TRANSPARENT, 500.0),
        ButtonKind::Green => (t.merge, Color::WHITE, Color::TRANSPARENT, 600.0),
    };
    row().h(32.0).px(12.0).gap(7.0).radius(9.0).center_y().fill(fill).border(1.0, border).hover(t.press)
        .role("button").label(label.to_owned())
        .children(icon.map(|i| ico_s(i, 16.0, ink)))
        .child(text(label.to_owned()).font(ui(13.0, weight)).color(ink))
}

/// `.btn.primary`: the light button ("New task").
pub fn btn_primary(t: &Theme, label: &str, icon: &str) -> El {
    row().h(32.0).px(12.0).gap(7.0).radius(9.0).center_y().fill(t.invert).hover(if t.dark { Color::WHITE } else { Color::BLACK }).role("button").label(label.to_owned())
        .child(ico_s(icon, 16.0, t.invert_text))
        .child(text(label.to_owned()).font(ui(13.0, 600.0)).color(t.invert_text))
}

/// `.ibtn`: a 32 pt square icon button.
pub fn ibtn(t: &Theme, icon: &str, label: &str) -> El {
    el().size(32.0, 32.0).radius(9.0).center().hover(t.hover).role("button").label(label.to_owned()).help(label.to_owned())
        .child(ico(icon, t.dim))
}

/// `.pill`: a small coloured label. No status dots.
pub fn pill(t: &Theme, label: &str, kind: Pill) -> El {
    let (ink, bg) = match kind {
        Pill::Green => (t.green, t.green.alpha(0.12)),
        Pill::Warn => (t.warn, t.warn.alpha(0.12)),
        Pill::Blue => (t.accent, t.accent.alpha(0.12)),
        Pill::Purple => (t.purple, t.purple.alpha(0.14)),
        Pill::Gray => (t.dim, t.hover),
    };
    row().h(22.0).px(8.0).radius(11.0).center_y().fill(bg).child(text(label.to_owned()).font(ui(12.0, 600.0)).color(ink))
}

/// `.card`.
pub fn card(t: &Theme) -> El {
    col().fill(t.card).border(1.0, t.card_border).radius(theme::R_MD)
}

/// The composer: the text field, then attach, when the engine asks before it acts (a menu:
/// "Approve manually" or "Full access"), the model and its effort (a menu), voice, and send. While
/// the chat it talks in is writing a reply, send turns into Stop. `project` adds the project row
/// on top; `compact` drops the approval and model chips (side panels).
pub fn composer(s: &App, t: &Theme, key: EditKey, target: Target, placeholder: &str, project: bool, compact: bool) -> El {
    let chat = s.chat_of(&target);
    let running = chat.as_deref().is_some_and(|c| s.data.is_running(c));
    let chip = |id: String, icon: Option<&str>, label: &str, dim: Option<&str>, chevron: bool, menu: String| {
        row().key(id).h(30.0).px(10.0).gap(7.0).radius(9.0).center_y().hover(t.hover).role("button").label(label.to_owned())
            .fill(if s.menu.as_deref() == Some(menu.as_str()) { t.active } else { Color::TRANSPARENT })
            .children(icon.map(|i| ico_s(i, 19.0, t.text)))
            .children((!label.is_empty()).then(|| text(label.to_owned()).font(ui(13.5, 500.0)).color(t.text).truncate()))
            .children(dim.map(|d| text(d.to_owned()).font(ui(13.5, 400.0)).color(t.faint)))
            .children(chevron.then(|| ico_s("chevron-down", 16.0, t.text)))
            .on_press(move |s: &mut App| s.toggle_menu(&menu))
    };
    let send_target = target.clone();
    let menu_target = target.clone();
    let field = text_input(s.edit(key), ui(15.0, 400.0)).key(format!("composer-{}", key.name())).w_full().px(16.0).pt(14.0).pb(4.0).min_h(50.0).max_h(240.0)
        .color(t.text).placeholder(placeholder.to_owned(), t.faint).caret(t.accent, t.accent.alpha(0.3)).label(placeholder.to_owned())
        .on_edit(move |s: &mut App| s.edit_mut(key))
        // Pasting a picture (from a web page, a screenshot) or files attaches them.
        .on_input_paste(move |s: &mut App, content, _| s.paste_into(key, content))
        // "/" for commands and skills, "@" for agents, apps and files (mentions.rs).
        .on_input_key(move |s: &mut App, e, tx| s.mention_key(key, e, tx))
        .on_input_change(move |s: &mut App, _| s.mention_typed(key, &menu_target))
        .on_submit(move |s: &mut App, _| s.submit(key, &target));
    let action = if running {
        let chat = chat.clone().unwrap_or_default();
        el().key(format!("stop-{}", key.name())).size(34.0, 34.0).radius(17.0).fill(t.invert).center().role("button").label("Stop").help("Stop")
            .child(el().size(11.0, 11.0).radius(2.5).fill(t.invert_text))
            .on_press(move |s: &mut App| s.stop(&chat))
    } else {
        let empty = s.edit(key).text.trim().is_empty() && s.attachments.get(&key).is_none_or(Vec::is_empty);
        el().key(format!("send-{}", key.name())).size(34.0, 34.0).radius(17.0).fill(if empty { t.control } else { t.accent }).center().role("button").label("Send")
            .hover(t.press)
            .child(ico_s("arrow-up", 16.0, if empty { t.faint } else { t.on_accent }))
            .on_press(move |s: &mut App| s.submit(key, &send_target))
    };
    let approval = s.prefs.approval;
    // The chat at its narrowest (background tasks open beside the browser or terminal): the
    // approval chip shows its icon only, so voice and send keep their room. Elsewhere the chip
    // still gives way (its label truncates) before they do.
    let narrow = (key == EditKey::ChatThread && s.panes.tasks && (s.panes.browser || s.panes.terminal)) || key == EditKey::CodeAgent;
    let approval_chip = |label: &str| chip(format!("approval-chip/{}", key.name()), Some(if approval == crate::prefs::Approval::Auto { "approve-full" } else { "approve-ask" }), label, None, false, format!("approval:{}", key.name()));
    let bar = row().gap(6.0).pt(6.0).px(10.0).pb(10.0).center_y()
        .child(ibtn(t, "plus", "Attach files").key(format!("attach-{}", key.name())).on_press_tx(move |s: &mut App, tx| s.pick_attachments(key, tx)))
        .children((!compact).then(|| if narrow {
            approval_chip("").label(approval.label().to_owned()).help(approval.label())
        } else {
            approval_chip(approval.label()).shrink().min_w(0.0)
        }))
        .child(el().grow(1.0))
        .children((!compact).then(|| {
            let (name, effort) = s.data.extra.models.chip(&s.prefs.effort);
            chip(format!("model-chip/{}", key.name()), None, &name, effort.as_deref(), true, format!("model:{}", key.name()))
        }))
        .child(mic(s, t, key))
        .child(action);
    let notice = s.notice.clone().map(|n| row().px(16.0).pt(8.0).gap(6.0).center_y()
        .child(ico_s("help", 14.0, t.red)).child(text(n).font(ui(12.5, 400.0)).color(t.red).wrap().grow(1.0).min_w(0.0)));
    col().key(format!("composer-box/{}", key.name())).w_full().fill(t.composer).border(1.0, t.composer_border).radius(theme::R_LG)
        .shadow(8.0, 24.0, t.shadow)
        .children(project.then(|| {
            // The project folder: a menu of the folders opened before, and "Open folder...".
            let menu_id = format!("project:{}", key.name());
            let open = s.menu.as_deref() == Some(menu_id.as_str());
            row().px(8.0).py(5.0).border_sides([0.0, 0.0, 1.0, 0.0], t.menu_line)
                .child(row().key(format!("project-chip/{}", key.name())).gap(8.0).px(6.0).h(30.0).radius(8.0).center_y().shrink().min_w(0.0)
                    .hover(t.hover).fill(if open { t.active } else { Color::TRANSPARENT })
                    .role("button").label(format!("Project folder: {}", s.data.project)).help(if s.data.extra.project_path.is_empty() { s.data.project.clone() } else { s.data.extra.project_path.clone() })
                    .child(ico("oai-folder", t.text)).child(text(s.data.project.clone()).font(ui(13.0, 600.0)).color(t.text).truncate())
                    .child(ico_s("chevron-down", 14.0, t.faint))
                    .on_press(move |s: &mut App| s.toggle_menu(&menu_id)))
        }))
        .children(notice)
        .children(attached(s, t, key))
        .child(field)
        .child(bar)
}

/// The composer's mic: dictation through Whisper on Groq (voice.rs). Red while it records
/// (press again to stop and transcribe), pulsing while Whisper works.
fn mic(s: &App, t: &Theme, key: EditKey) -> El {
    let recording = s.voice.recording(key);
    let transcribing = s.voice.transcribing(key);
    let label = if recording { "Stop and transcribe" } else if transcribing { "Transcribing..." } else { "Voice" };
    let b = el().key(format!("mic-{}", key.name())).size(32.0, 32.0).radius(16.0).center().role("button").label(label).help(label)
        .on_press(move |s: &mut App| s.toggle_voice(key));
    if recording {
        b.fill(t.red).hover(t.red.alpha(0.85)).child(ico("mic", Color::WHITE).looping(rune::LoopSpec::opacity(1.2, 0.0, 0.55, 1.0)))
    } else if transcribing {
        b.fill(t.active).child(ico("mic", t.text).looping(rune::LoopSpec::opacity(0.9, 0.0, 0.3, 1.0)))
    } else {
        b.hover(t.hover).child(ico("mic", t.dim))
    }
}

/// One row of a dropdown menu: an icon, a label, an optional note under it, and a check when
/// it's the current choice.
pub fn menu_item(t: &Theme, key: String, icon: Option<&str>, label: &str, note: Option<&str>, on: bool) -> El {
    row().key(key).w_full().min_h(34.0).px(10.0).py(6.0).gap(10.0).radius(8.0).center_y().hover(t.hover).role("menuitem").label(label.to_owned())
        .children(icon.map(|i| ico_s(i, 16.0, t.dim)))
        .child(col().grow(1.0).min_w(0.0)
            .child(text(label.to_owned()).font(ui(13.5, 500.0)).color(t.text))
            .children(note.map(|n| text(n.to_owned()).font(ui(12.0, 400.0)).color(t.faint).wrap())))
        .children(on.then(|| ico_s("check", 16.0, t.text)))
}

/// A dropdown menu anchored to the element keyed `anchor`, closed by Escape or a click outside.
pub fn menu(t: &Theme, anchor: &str, side: rune::Side, width: f32, items: Vec<El>) -> El {
    col().key(format!("menu/{anchor}")).w(width).padding(6.0).gap(2.0).radius(12.0)
        .fill(t.popup).border(1.0, t.control_border).shadow(12.0, 32.0, t.shadow)
        .anchored(anchor.to_owned(), side, rune::Align::Start, 6.0)
        .role("menu")
        .modal(true, |s: &mut App| s.menu = None)
        .children(items)
}

/// An on/off switch (Settings, loops, plugins).
pub fn toggle(t: &Theme, key: String, on: bool, label: &str) -> El {
    el().key(key).w(36.0).h(20.0).radius(10.0).fill(if on { t.accent } else { t.switch_off }).role("switch").checked(on).label(label.to_owned())
        .child(el().size(16.0, 16.0).radius(8.0).fill(Color::WHITE).absolute(if on { 18.0 } else { 2.0 }, 2.0).animate_layout().motion(ENTER))
}

/// A row of tabs as a segmented control ("Summary | Changes", Integrations' tabs).
pub fn tabs<T: Copy + PartialEq + 'static>(t: &Theme, key: &str, items: &[(T, &str)], current: T, pick: fn(&mut App, T)) -> El {
    row().key(key.to_owned()).gap(2.0).padding(3.0).radius(10.0).fill(t.tabs).border(1.0, t.border).role("tablist")
        .children(items.iter().map(|&(v, label)| {
            let on = v == current;
            row().key(format!("{key}/{label}")).h(28.0).px(12.0).radius(7.0).center_y().role("tab").checked(on).label(label.to_owned())
                .fill(if on { t.active } else { Color::TRANSPARENT }).hover(t.hover)
                .child(text(label.to_owned()).font(ui(13.0, if on { 600.0 } else { 500.0 })).color(if on { t.text } else { t.dim }))
                .on_press(move |s: &mut App| pick(s, v))
        }))
}

/// `.side-head`: the sidebar's title and its one action.
pub fn side_head(t: &Theme, title: &str, action: Option<(&str, &str)>) -> El {
    row().pt(14.0).pr(12.0).pb(8.0).pl(16.0).center_y().justify_between()
        .child(text(title.to_owned()).font(ui(15.0, 650.0)).color(t.text))
        .children(action.map(|(i, l)| ibtn(t, i, l)))
}

/// `.sec`: a quiet section title in the sidebar.
pub fn sec(t: &Theme, icon: Option<&str>, title: &str, add: bool) -> El {
    row().gap(8.0).px(8.0).pt(14.0).pb(6.0).center_y()
        .children(icon.map(|i| ico(i, t.faint)))
        .child(text(title.to_owned()).font(ui(12.5, 600.0)).color(t.faint).grow(1.0))
        .children(add.then(|| ico_s("plus", 16.0, t.faint)))
}

/// `.row`: a sidebar row. `on` is the selected one.
pub fn side_row(t: &Theme, on: bool) -> El {
    row().min_h(36.0).px(10.0).py(6.0).gap(10.0).radius(10.0).center_y().hover(t.hover).fill(if on { t.active } else { Color::TRANSPARENT })
}

/// `.nm` with an optional `small` line under it.
pub fn name_and_line(t: &Theme, name: &str, line: Option<&str>, weight: f32) -> El {
    col().grow(1.0).min_w(0.0)
        .child(text(name.to_owned()).font(ui(14.0, weight)).color(t.text).truncate())
        .children(line.map(|l| text(l.to_owned()).font(ui(12.0, 400.0)).color(t.faint).truncate()))
}

/// `.me`: you, at the foot of the sidebar.
pub fn me(s: &App, t: &Theme) -> El {
    row().gap(10.0).px(14.0).py(12.0).center_y().border_sides([1.0, 0.0, 0.0, 0.0], t.border)
        .child(el().size(30.0, 30.0).radius(15.0).fill(theme::hex("#2f8f5b")).center()
            .child(text(s.data.who().chars().next().unwrap_or('Y').to_string()).font(ui(12.0, 700.0)).color(Color::WHITE)))
        .child(col().grow(1.0)
            .child(text(s.data.who()).font(ui(13.5, 400.0)).color(t.text))
            .child(text(s.data.plan.clone()).font(ui(12.0, 400.0)).color(t.faint)))
        // Your usage (Settings has its own place in the rail).
        .child(ibtn(t, "chart", "Usage").key("me-usage")
            .fill(if s.usage_open { t.active } else { Color::TRANSPARENT })
            .on_press(|s: &mut App| s.toggle_usage()))
}

/// A view's heading: `.head h1` and its `.sub`.
pub fn heading(t: &Theme, title: &str, sub: Option<String>) -> El {
    col().gap(2.0)
        .child(text(title.to_owned()).font(ui(20.0, 650.0).tracking(-0.2)).color(t.text))
        .children(sub.map(|s| text(s).font(ui(13.0, 400.0)).color(t.faint)))
}

/// Text with a light sweeping across it, word by word, grey to white and back: "Wisp is
/// thinking", "Working · 3 steps". Each word loops its own opacity a little after the one before,
/// so the brightness travels like a wave. Nothing rebuilds while it runs.
pub fn wave(src: &str, style: rune::TextStyle, color: Color) -> El {
    const PERIOD: f64 = 1.6;
    const STEP: f64 = 0.12;
    row().gap(0.0).center_y().children(src.split(' ').enumerate().map(|(i, w)| {
        let word = if i == 0 { w.to_owned() } else { format!(" {w}") };
        text(word).font(style).color(color).looping(rune::LoopSpec::opacity(PERIOD, i as f64 * STEP, 0.35, 1.0))
    }))
}

/// Whether a path is a picture the app can show.
pub fn is_picture(path: &str) -> bool {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp")
}

/// A file as the chat shows one: a picture as a rounded thumbnail `size` tall, anything else
/// as a chip with its name.
pub fn file_tile(s: &App, t: &Theme, f: &str, size: f32) -> El {
    let name = f.rsplit(['/', '\\']).next().unwrap_or(f).to_owned();
    if is_picture(f) {
        let px = s.look.picture(f, 0.0, 480);
        let (w, h) = px.size();
        // The picture's own shape, within reason, at the given height.
        let width = if w > 0 && h > 0 { (size * w as f32 / h as f32).clamp(size * 0.6, size * 1.8) } else { size };
        return el().w(width).h(size).radius(12.0).clip_rounded(12.0).fill(t.well).border(1.0, t.border).help(f.to_owned())
            .pixels_fit(&px, rune::SurfaceFit::Fill);
    }
    row().h(32.0).px(10.0).gap(7.0).radius(9.0).center_y().fill(t.hover).help(f.to_owned())
        .child(ico_s("file", 14.0, t.dim))
        .child(text(name).font(ui(12.5, 500.0)).color(t.text).single_line())
}

/// The files attached to a composer's next message: pictures as thumbnails, other files as
/// chips, each with a remove button.
fn attached(s: &App, t: &Theme, key: EditKey) -> Option<El> {
    let files = s.attachments.get(&key).filter(|f| !f.is_empty())?;
    Some(row().px(14.0).pt(12.0).gap(8.0).flex_wrap().items_end().children(files.iter().map(|f| {
        let gone = f.clone();
        let remove = el().size(20.0, 20.0).radius(10.0).center().fill(t.solid).border(1.0, t.border).hover(t.active).role("button").label("Remove").help("Remove")
            .child(ico_s("close", 11.0, t.dim))
            .on_press(move |s: &mut App| {
                if let Some(l) = s.attachments.get_mut(&key) {
                    l.retain(|x| *x != gone);
                }
            });
        if is_picture(f) {
            el().key(format!("attached/{f}")).child(file_tile(s, t, f, 64.0)).child(remove.pin(None, Some(-6.0), Some(-6.0), None))
        } else {
            let name = f.rsplit(['/', '\\']).next().unwrap_or(f).to_owned();
            row().key(format!("attached/{f}")).h(28.0).pl(8.0).pr(4.0).gap(6.0).radius(8.0).center_y().fill(t.hover).help(f.clone())
                .child(ico_s("file", 13.0, t.dim))
                .child(text(name).font(ui(12.5, 500.0)).color(t.text).single_line())
                .child(remove)
        }
    })))
}
