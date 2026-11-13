//! Shared pieces, each matching a class in the prototype's stylesheet (named in its doc).

use rune::{Color, El, Span, Spring, Transition, col, el, rich, row, text, text_input};

use crate::app::{App, EditKey};
use crate::icons::{ico, ico_s};
use crate::model::{ButtonKind, Pill};
use crate::store::Target;
use crate::theme::{self, Theme, ui};

/// The prototype's `ease-out` for things entering: 0.28 s, no bounce.
pub const ENTER: Spring = Spring::new(0.28, 0.0);
/// List stagger, inside the 30 to 40 ms the motion rules ask for.
pub const STAGGER: f32 = 0.035;

/// `.fade`: views and rows rise 6 pt and fade in, on the ease-out spring.
pub fn fade_in() -> Transition {
    Transition::offset(0.0, 6.0).combined(Transition::opacity())
}

/// A row entering a list, `i` rows down: staggered so the list cascades top to bottom.
pub fn enter(e: El, i: usize) -> El {
    e.transition(fade_in()).motion(ENTER).enter_delay(i as f32 * STAGGER)
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
        ButtonKind::Blue => (t.accent, Color::WHITE, Color::TRANSPARENT, 500.0),
        ButtonKind::Green => (t.merge, Color::WHITE, Color::TRANSPARENT, 600.0),
    };
    row().h(32.0).px(12.0).gap(7.0).radius(9.0).center_y().fill(fill).border(1.0, border).hover(theme::rgba(255, 255, 255, 0.06))
        .role("button").label(label.to_owned())
        .children(icon.map(|i| ico_s(i, 16.0, ink)))
        .child(text(label.to_owned()).font(ui(13.0, weight)).color(ink))
}

/// `.btn.primary`: the light button ("New task").
pub fn btn_primary(t: &Theme, label: &str, icon: &str) -> El {
    row().h(32.0).px(12.0).gap(7.0).radius(9.0).center_y().fill(t.invert).hover(Color::WHITE).role("button").label(label.to_owned())
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

/// `.composer`: the app's composer, with the project tab, approvals, model, voice and send.
/// `compact` drops the approvals and model chips (drawers and the agent pane).
pub fn composer(s: &App, t: &Theme, key: EditKey, target: Target, placeholder: &str, project: bool, compact: bool) -> El {
    let chip = |icon: Option<&str>, label: &str, dim: Option<&str>, chevron: bool| {
        row().h(30.0).px(10.0).gap(7.0).radius(9.0).center_y().hover(t.hover).role("button").label(label.to_owned())
            .children(icon.map(|i| ico_s(i, 16.0, t.text)))
            .child(text(label.to_owned()).font(ui(13.5, 500.0)).color(t.text))
            .children(dim.map(|d| text(d.to_owned()).font(ui(13.5, 400.0)).color(t.faint)))
            .children(chevron.then(|| ico_s("chevron-down", 16.0, t.text)))
    };
    let send_target = target.clone();
    let field = text_input(s.edit(key), ui(15.0, 400.0)).key(format!("composer-{}", key.name())).w_full().px(16.0).pt(14.0).pb(4.0).min_h(50.0)
        .color(t.text).placeholder(placeholder.to_owned(), t.faint).caret(t.accent, t.accent.alpha(0.3)).label(placeholder.to_owned())
        .on_edit(move |s: &mut App| s.edit_mut(key))
        .on_submit(move |s: &mut App, _| s.submit(key, &target));
    let send = el().size(34.0, 34.0).radius(17.0).fill(t.accent).center().role("button").label("Send").hover(theme::rgba(255, 255, 255, 0.12))
        .child(ico_s("arrow-up", 16.0, Color::WHITE))
        .on_press(move |s: &mut App| s.submit(key, &send_target));
    let bar = row().gap(6.0).pt(6.0).px(10.0).pb(10.0).center_y()
        .child(ibtn(t, "plus", "Attach"))
        .children((!compact).then(|| chip(Some("shield-check"), "Approve manually", None, false)))
        .child(el().grow(1.0))
        .children((!compact).then(|| chip(None, "Haze 2", Some("High"), true)))
        .child(ibtn(t, "mic", "Voice"))
        .child(send);
    col().w_full().fill(t.composer).border(1.0, t.composer_border).radius(theme::R_LG)
        .shadow(8.0, 24.0, theme::rgba(0, 0, 0, 0.4))
        .children(project.then(|| {
            row().gap(8.0).px(14.0).py(9.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], theme::hex("#2c2c2c"))
                .child(ico("oai-folder", t.text)).child(text(s.data.project.clone()).font(ui(13.0, 600.0)).color(t.text))
        }))
        .child(field)
        .child(bar)
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
            .child(text(s.data.user.chars().next().unwrap_or('S').to_string()).font(ui(12.0, 700.0)).color(Color::WHITE)))
        .child(col().grow(1.0)
            .child(text(s.data.user.clone()).font(ui(13.5, 400.0)).color(t.text))
            .child(text(s.data.plan.clone()).font(ui(12.0, 400.0)).color(t.faint)))
        .child(ibtn(t, "oai-settings", "Settings"))
}

/// A view's heading: `.head h1` and its `.sub`.
pub fn heading(t: &Theme, title: &str, sub: Option<String>) -> El {
    col().gap(2.0)
        .child(text(title.to_owned()).font(ui(20.0, 650.0).tracking(-0.2)).color(t.text))
        .children(sub.map(|s| text(s).font(ui(13.0, 400.0)).color(t.faint)))
}
