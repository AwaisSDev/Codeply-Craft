//! Settings > Appearance, the theme half: describe a theme in words, light or dark, colours, the
//! font, and a background; plus the background layer the shell draws behind the app.

use rune::{Color, El, ScrollSpec, Side, SurfaceFit, col, el, row, text, text_input};

use crate::app::App;
use crate::icons::ico_s;
use crate::look::{BLURS, BgKind, Candidate, DIMS, LookEdit, Mode, SIZES, Slot, WEIGHTS};
use crate::model::ButtonKind;
use crate::theme::{self, Theme, ui};
use crate::ui::{btn, menu_item, tabs};
use rune::FileDialogOptions;

use super::settings::{group, item};

// ---------- the background layer ----------

/// The picture, ASCII or dotted art behind the app, with its dimming layer, or None when no
/// background is chosen. The shell makes its own fills see-through when this is Some.
pub fn backdrop(s: &App, t: &Theme) -> Option<El> {
    let look = &s.prefs.look;
    if !look.has_background() {
        return None;
    }
    let dim = DIMS[look.dim].1;
    let (px, layer_opacity, scrim) = match look.bg_kind {
        BgKind::Picture => (s.look.picture(&look.picture, BLURS[look.blur].1, 1600), 1.0, dim),
        kind => (s.look.art(kind, &look.art, t)?, 1.0 - dim * 0.8, 0.0),
    };
    let image = el().absolute(0.0, 0.0).w_full().h_full().opacity(layer_opacity).pixels_fit(&px, SurfaceFit::Fill);
    let mut layer = el().key("backdrop").absolute(0.0, 0.0).w_full().h_full().child(image);
    if scrim > 0.0 {
        layer = layer.child(el().absolute(0.0, 0.0).w_full().h_full().fill(t.solid.alpha(scrim)));
    }
    Some(layer)
}

// ---------- the page ----------

/// The theme groups of the Appearance page.
pub fn groups(s: &App, t: &Theme) -> Vec<El> {
    vec![describe(s, t), mode_group(s, t), colours(s, t), font_group(s, t), background(s, t)]
}

fn label(t: &Theme, msg: &str) -> El {
    text(msg.to_owned()).font(ui(12.5, 500.0)).color(t.dim)
}

fn line_field(s: &App, t: &Theme, k: LookEdit, w: f32, placeholder: &str, on_enter: impl Fn(&mut App) + 'static) -> El {
    row().w(w).h(30.0).px(10.0).radius(8.0).center_y().fill(t.field).border(1.0, t.field_border)
        .child(text_input(s.look.edit(k), ui(13.0, 400.0)).key(k.name()).single_line().grow(1.0).min_w(0.0).color(t.text)
            .placeholder(placeholder.to_owned(), t.faint).caret(t.accent, t.accent.alpha(0.3)).label(placeholder.to_owned())
            .on_edit(move |s: &mut App| s.look.edit_mut(k))
            .on_submit(move |s: &mut App, _| on_enter(s)))
}

/// "Tell the app what you want": a box, a button, and the model's theme as a preview.
fn describe(s: &App, t: &Theme) -> El {
    let l = &s.look;
    let field = text_input(l.edit(LookEdit::Prompt), ui(14.0, 400.0)).key("theme-prompt-field").w_full().min_h(52.0).color(t.text)
        .placeholder("Make it feel like a rainy Tokyo night".to_owned(), t.faint).caret(t.accent, t.accent.alpha(0.3)).label("Describe your theme")
        .on_edit(|s: &mut App| s.look.edit_mut(LookEdit::Prompt));
    let busy = l.generating;
    let go = btn(t, if busy { "Thinking..." } else { "Create theme" }, Some("sparkle"), ButtonKind::Blue).key("theme-generate")
        .on_press(|s: &mut App| s.generate_theme());
    let mut rows = vec![
        col().w_full().px(16.0).py(14.0).gap(10.0)
            .child(field)
            .child(row().w_full().gap(12.0).center_y()
                .child(text("Colours, a font, and maybe a background. You see it before it applies.".to_owned()).font(ui(12.5, 400.0)).color(t.faint).wrap().grow(1.0).min_w(0.0))
                .child(go)),
    ];
    if let Some(e) = &l.gen_error {
        rows.push(row().w_full().px(16.0).py(10.0).child(text(e.clone()).font(ui(13.0, 400.0)).color(t.red).wrap()));
    }
    if let Some(c) = &l.candidate {
        rows.push(preview(s, t, c));
    }
    group(t, "Describe your theme", rows)
}

/// A generated theme shown as a small window in its own colours, with what else it sets.
fn preview(s: &App, t: &Theme, c: &Candidate) -> El {
    let ct = theme::resolve(&c.look, false);
    let bar = |w: f32, color: Color| el().w(w).h(6.0).radius(3.0).fill(color);
    let art = (c.background && matches!(c.look.bg_kind, BgKind::Ascii | BgKind::Dots)).then(|| s.look.art(c.look.bg_kind, &c.look.art, &ct)).flatten();
    let mut main = col().key("preview-main").grow(1.0).h_full().fill(ct.bg).clip_rounded(0.0);
    if let Some(px) = art {
        main = main.child(el().absolute(0.0, 0.0).w_full().h_full().opacity(0.5).pixels_fit(&px, SurfaceFit::Fill));
    }
    let window = row().key("theme-preview").w(300.0).h(150.0).radius(10.0).clip_rounded(10.0).border(1.0, ct.border).fill(ct.solid)
        .child(col().w(84.0).h_full().padding(10.0).gap(8.0).fill(ct.side).border_sides([0.0, 1.0, 0.0, 0.0], ct.border)
            .child(bar(40.0, ct.text)).child(bar(54.0, ct.dim)).child(bar(46.0, ct.dim)).child(bar(34.0, ct.faint)))
        .child(main.padding(12.0).gap(8.0)
            .child(row().w_full().padding(8.0).radius(8.0).fill(ct.bubble).child(text("What should we build?".to_owned()).font(ui(11.5, 500.0)).color(ct.text)))
            .child(text("Secondary words read like this.".to_owned()).font(ui(11.0, 400.0)).color(ct.dim))
            .child(el().grow(1.0))
            .child(row().gap(6.0).center_y()
                .child(row().h(24.0).px(10.0).radius(7.0).center_y().fill(ct.accent).child(text("Run".to_owned()).font(ui(11.0, 600.0)).color(ct.on_accent)))
                .child(row().h(24.0).px(10.0).radius(7.0).center_y().fill(ct.control).border(1.0, ct.control_border).child(text("Cancel".to_owned()).font(ui(11.0, 500.0)).color(ct.text)))));
    let dot = |c: Color| el().size(14.0, 14.0).radius(7.0).fill(c).border(1.0, t.text.alpha(0.2));
    let mut facts = vec![format!("{} mode", if ct.dark { "Dark" } else { "Light" })];
    if c.font {
        let f = if c.look.font.is_empty() { "Default font".to_owned() } else { c.look.font.clone() };
        facts.push(format!("{f}, {}, {}", SIZES[c.look.size].0.to_lowercase(), WEIGHTS[c.look.weight].0.to_lowercase()));
    }
    if c.background {
        facts.push(match (c.look.bg_kind, &c.query) {
            (BgKind::Picture, Some(q)) => format!("Picture of \"{q}\""),
            (BgKind::None, _) => "No background".to_owned(),
            (k, _) => format!("{} background", k.label()),
        });
    }
    row().key("candidate").w_full().px(16.0).py(14.0).gap(18.0)
        .child(window)
        .child(col().grow(1.0).min_w(0.0).gap(8.0)
            .child(text(c.name.clone()).font(ui(15.0, 650.0)).color(t.text))
            .child(row().gap(5.0).children([ct.bg, ct.side, ct.text, ct.accent].map(dot)))
            .children(facts.into_iter().map(|f| text(f).font(ui(12.5, 400.0)).color(t.dim).wrap()))
            .child(el().grow(1.0))
            .child(row().gap(8.0)
                .child(btn(t, "Apply", Some("check"), ButtonKind::Blue).key("theme-apply").on_press(|s: &mut App| s.apply_candidate()))
                .child(btn(t, "Discard", None, ButtonKind::Plain).key("theme-discard").on_press(|s: &mut App| s.discard_candidate()))))
}

fn mode_group(s: &App, t: &Theme) -> El {
    let l = &s.prefs.look;
    let name = (!l.name.is_empty()).then(|| format!("Theme: {}", l.name));
    let modes: Vec<(Mode, &str)> = Mode::ALL.iter().map(|&m| (m, m.label())).collect();
    group(t, "Theme", vec![
        item(t, "Appearance", Some(name.as_deref().unwrap_or("Light, dark, or whatever your system uses.")),
            tabs(t, "set-theme", &modes, l.mode, |s: &mut App, m: Mode| s.set_mode(m))),
    ])
}

fn colours(s: &App, t: &Theme) -> El {
    let l = &s.prefs.look;
    let rows = Slot::ALL.iter().map(|&slot| {
        let current = l.colour(slot);
        let swatches = row().gap(6.0).center_y().children(slot.swatches().iter().map(|&c| {
            let on = current.is_some_and(|v| v.eq_ignore_ascii_case(c));
            el().key(format!("sw/{}/{c}", slot.key())).size(18.0, 18.0).radius(9.0).fill(theme::hex(c)).role("radio").checked(on).label(c.to_owned())
                .border(if on { 2.0 } else { 1.0 }, if on { t.text } else { t.text.alpha(0.22) })
                .on_press(move |s: &mut App| s.set_theme_colour(slot, Some(c)))
        }));
        let auto = row().key(format!("sw/{}/auto", slot.key())).h(24.0).px(8.0).radius(7.0).center_y().role("button").label(format!("{} automatic", slot.label()))
            .fill(if current.is_none() { t.active } else { Color::TRANSPARENT }).hover(t.hover)
            .child(text("Auto".to_owned()).font(ui(12.0, 500.0)).color(if current.is_none() { t.text } else { t.dim }))
            .on_press(move |s: &mut App| s.set_theme_colour(slot, None));
        row().w_full().px(16.0).py(10.0).gap(12.0).center_y()
            .child(el().w(86.0).child(label(t, slot.label())))
            .child(col().grow(1.0).min_w(0.0).gap(8.0).child(swatches))
            .child(auto)
            .child(line_field(s, t, slot.edit(), 92.0, "#rrggbb", move |s| s.apply_hex(slot)))
    }).collect::<Vec<_>>();
    let mut all = rows;
    all.push(row().w_full().px(16.0).py(10.0).gap(10.0).center_y()
        .child(text("Text and surfaces follow the background; accents are kept readable.".to_owned()).font(ui(12.5, 400.0)).color(t.faint).wrap().grow(1.0).min_w(0.0))
        .child(btn(t, "Reset all", None, ButtonKind::Plain).key("theme-reset").on_press(|s: &mut App| s.reset_look())));
    group(t, "Colours", all)
}

fn picker(t: &Theme, key: &str, value: &str, menu: &str) -> El {
    let menu = menu.to_owned();
    row().key(key.to_owned()).h(32.0).px(12.0).gap(8.0).radius(9.0).center_y().fill(t.control).border(1.0, t.control_border).hover(t.press).role("button").label(value.to_owned())
        .child(text(value.to_owned()).font(ui(13.0, 500.0)).color(t.text).truncate().max_w(220.0))
        .child(ico_s("chevron-down", 16.0, t.dim))
        .on_press(move |s: &mut App| s.toggle_menu(&menu))
}

fn steps(t: &Theme, key: &str, names: &[&str], current: usize, pick: fn(&mut App, usize)) -> El {
    let items: Vec<(usize, &str)> = names.iter().copied().enumerate().collect();
    tabs(t, key, &items, current, pick)
}

fn font_group(s: &App, t: &Theme) -> El {
    let l = &s.prefs.look;
    let show = |v: &str| if v.is_empty() { "Default".to_owned() } else { v.to_owned() };
    let sizes: Vec<&str> = SIZES.iter().map(|x| x.0).collect();
    let weights: Vec<&str> = WEIGHTS.iter().map(|x| x.0).collect();
    group(t, "Font", vec![
        item(t, "Interface font", Some("Installed fonts, plus Geist and Inter, which come with the app."), picker(t, "font-pick", &show(&l.font), "font:ui")),
        item(t, "Text size", Some("Everything follows it, from the sidebar to chat."), steps(t, "set-size", &sizes, l.size, |s, i| s.set_text_size(i))),
        item(t, "Weight", Some("How heavy text looks."), steps(t, "set-weight", &weights, l.weight, |s, i| s.set_text_weight(i))),
        item(t, "Code font", Some("The editor, terminal and diffs."), picker(t, "mono-pick", &show(&l.mono), "font:mono")),
    ])
}

fn background(s: &App, t: &Theme) -> El {
    let l = &s.prefs.look;
    let kinds: Vec<(BgKind, &str)> = BgKind::ALL.iter().map(|&k| (k, k.label())).collect();
    let dims: Vec<&str> = DIMS.iter().map(|x| x.0).collect();
    let blurs: Vec<&str> = BLURS.iter().map(|x| x.0).collect();
    let mut rows = vec![
        item(t, "Background", Some("Behind the app's content. A picture, ASCII art, or dots."),
            tabs(t, "set-bg", &kinds, l.bg_kind, |s: &mut App, k: BgKind| s.set_bg_kind(k))),
    ];
    // Where the picture comes from: a file, or an online search (ASCII and dots draw from it too).
    let picture = if l.picture.is_empty() { "No picture yet".to_owned() } else if l.picture == crate::look::SAMPLE { "Sample picture".to_owned() } else {
        std::path::Path::new(&l.picture).file_name().map_or_else(|| l.picture.clone(), |n| n.to_string_lossy().into_owned())
    };
    let choose = btn(t, "Choose file", Some("file"), ButtonKind::Plain).key("bg-file").on_press_tx(|_: &mut App, tx| {
        tx.open_file(FileDialogOptions::default().filter("Pictures", &["png", "jpg", "jpeg", "webp", "gif", "bmp"]), |s: &mut App, res, _| {
            if let Ok(Some(path)) = res {
                s.use_picture_file(&path);
            }
        });
    });
    rows.push(item(t, "Picture", Some(&picture), choose));
    let search_btn = btn(t, if s.look.searching { "Searching..." } else { "Search" }, Some("search"), ButtonKind::Plain).key("bg-search-go").on_press(|s: &mut App| s.search_images());
    let mut search = col().w_full().px(16.0).py(12.0).gap(10.0)
        .child(row().w_full().gap(8.0).center_y()
            .child(text("Find online".to_owned()).font(ui(14.0, 500.0)).color(t.text).w(86.0))
            .child(line_field(s, t, LookEdit::Search, 280.0, "foggy mountains, city at night...", |s| s.search_images()).grow(1.0))
            .child(search_btn));
    if let Some(e) = &s.look.search_error {
        search = search.child(text(e.clone()).font(ui(12.5, 400.0)).color(t.red).wrap());
    }
    if !s.look.hits.is_empty() {
        let tile = |i: usize, h: &crate::look::Hit| {
            let px = s.look.picture(&h.thumb, 0.0, 320);
            el().key(format!("hit/{i}")).w(150.0).h(94.0).radius(8.0).clip_rounded(8.0).border(1.0, t.border).fill(t.well).role("button").label(h.title.clone()).help(h.title.clone())
                .pixels_fit(&px, SurfaceFit::Fill).hover(t.hover)
                .on_press(move |s: &mut App| s.use_hit(i))
        };
        let tiles: Vec<El> = s.look.hits.iter().enumerate().map(|(i, h)| tile(i, h)).collect();
        for (r, chunk) in tiles.chunks(4).enumerate() {
            let _ = r;
            search = search.child(row().gap(10.0).children(chunk.iter().cloned()));
        }
        search = search.child(text("Pictures from Openverse and Wikimedia Commons, under open licences. Click one to use it.".to_owned()).font(ui(12.0, 400.0)).color(t.faint).wrap());
    }
    if s.look.working {
        search = search.child(text("Getting the picture...".to_owned()).font(ui(12.5, 400.0)).color(t.dim));
    }
    rows.push(search);
    rows.push(item(t, "Dim", Some("How much the background steps back so text stays readable."), steps(t, "set-dim", &dims, l.dim, |s, i| s.set_dim(i))));
    rows.push(item(t, "Blur", Some("Softens a picture."), steps(t, "set-blur", &blurs, l.blur, |s, i| s.set_blur(i))));
    group(t, "Background", rows)
}

// ---------- the font menus ----------

/// The font pickers' dropdowns ("font:ui", "font:mono").
pub fn menu(s: &App, t: &Theme, id: &str) -> Option<El> {
    let (anchor, mono) = match id {
        "font:ui" => ("font-pick", false),
        "font:mono" => ("mono-pick", true),
        _ => return None,
    };
    let current = if mono { &s.prefs.look.mono } else { &s.prefs.look.font };
    let mut names: Vec<String> = if mono {
        ["Geist Mono", "Cascadia Code", "Cascadia Mono", "Consolas", "JetBrains Mono", "Fira Code", "SF Mono", "Menlo", "DejaVu Sans Mono"].map(str::to_owned).to_vec()
    } else {
        s.look.font_choices()
    };
    names.retain(|n| !n.is_empty());
    let entry = |name: &str, value: &str| {
        let on = current == value;
        let v = value.to_owned();
        menu_item(t, format!("font-opt/{name}"), None, name, None, on).on_press(move |s: &mut App| if mono { s.set_mono(&v) } else { s.set_font(&v) })
    };
    let mut items = vec![entry("Default", "")];
    items.extend(names.iter().map(|n| entry(n, n)));
    Some(col().key(format!("menu/{anchor}")).w(260.0).padding(6.0).radius(12.0)
        .fill(t.popup).border(1.0, t.control_border).shadow(12.0, 32.0, t.shadow)
        .anchored(anchor.to_owned(), Side::Bottom, rune::Align::Start, 6.0)
        .role("menu")
        .modal(true, |s: &mut App| s.menu = None)
        .child(col().w_full().max_h(340.0).gap(2.0).scroll(ScrollSpec { stick_bottom: false }).children(items)))
}
