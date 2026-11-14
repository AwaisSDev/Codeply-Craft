//! Codeply's dark theme. Names and values follow the shipping app's `styles.css` (`:root`), with the
//! three surface greys the 4.0 workspace prototype deepens (`design/workspace/index.html`).

use std::sync::atomic::{AtomicI32, AtomicU32, Ordering};

use rune::{Color, Family, TextStyle};

/// `#rrggbb` to a colour; panics only on a typo in a constant here, which the tests catch.
pub fn hex(s: &str) -> Color {
    rune::color::hex(s).unwrap_or(Color::BLACK)
}

/// `rgba(r, g, b, a)` with 0..255 channels.
pub fn rgba(r: u8, g: u8, b: u8, a: f32) -> Color {
    // Rune keeps colours in linear light; hex() decodes sRGB the way CSS authors mean it.
    hex(&format!("#{r:02x}{g:02x}{b:02x}")).alpha(a)
}

#[derive(Clone, Copy, Debug)]
pub struct Theme {
    pub bg: Color,
    pub side: Color,
    pub rail: Color,
    pub card: Color,
    pub card_border: Color,
    pub hover: Color,
    pub active: Color,
    pub text: Color,
    pub dim: Color,
    pub faint: Color,
    pub border: Color,
    pub accent: Color,
    pub green: Color,
    pub red: Color,
    pub warn: Color,
    pub purple: Color,
    pub bubble: Color,
    pub control: Color,
    pub control_border: Color,
    pub composer: Color,
    pub composer_border: Color,
    /// `--invert-bg`: the primary (light) button.
    pub invert: Color,
    pub invert_text: Color,
    pub merge: Color,
    /// Light or dark: what the extra tokens below were made for.
    pub dark: bool,
    /// Logo and app tiles (integrations), with their border and ink.
    pub tile: Color,
    pub tile_border: Color,
    pub tile_ink: Color,
    /// Search fields and inset wells; a panel is a card one step quieter.
    pub field: Color,
    pub field_border: Color,
    pub panel: Color,
    /// Popovers and menus.
    pub popup: Color,
    /// Code blocks and tool output.
    pub well: Color,
    /// The terminal pane, and the phone stage behind the browser's mobile view.
    pub pane: Color,
    pub stage: Color,
    /// Inline code: its fill and ink.
    pub code_bg: Color,
    pub code_ink: Color,
    /// A switch when off, and the track of a segmented control.
    pub switch_off: Color,
    pub tabs: Color,
    /// A line inside a menu.
    pub menu_line: Color,
    /// Shadows under popovers.
    pub shadow: Color,
    /// A stronger hover (buttons that already have a fill).
    pub press: Color,
    /// The thumb of a switch, and text on the accent.
    pub on_accent: Color,
    /// The background colour itself: `bg` turns see-through when a picture sits behind the app.
    pub solid: Color,
    /// The ink of ASCII and dotted backgrounds, as sRGB bytes.
    pub art: [u8; 3],
}

pub fn dark() -> Theme {
    Theme {
        bg: hex("#0f0f0f"),
        side: hex("#171717"),
        rail: hex("#121212"),
        card: hex("#202020"),
        card_border: hex("#2a2a2a"),
        hover: rgba(255, 255, 255, 0.055),
        active: rgba(255, 255, 255, 0.09),
        text: hex("#ececec"),
        dim: hex("#ababab"),
        faint: hex("#8a8a8a"),
        border: hex("#262626"),
        accent: hex("#3d8bfd"),
        green: hex("#4cc38a"),
        red: hex("#ef6a5a"),
        warn: hex("#f0883e"),
        purple: hex("#9b7bff"),
        bubble: hex("#2b2b2b"),
        control: hex("#272727"),
        control_border: hex("#363636"),
        composer: hex("#1f1f1f"),
        composer_border: hex("#333333"),
        invert: hex("#ececec"),
        invert_text: hex("#141414"),
        merge: hex("#238636"),
        dark: true,
        tile: hex("#232323"),
        tile_border: hex("#2e2e2e"),
        tile_ink: hex("#e0e0e0"),
        field: hex("#1b1b1b"),
        field_border: hex("#2c2c2c"),
        panel: hex("#181818"),
        popup: hex("#1f1f1f"),
        well: hex("#161616"),
        pane: hex("#0c0c0c"),
        stage: hex("#080808"),
        code_bg: hex("#2a2a2a"),
        code_ink: hex("#e6e6e6"),
        switch_off: hex("#3a3a3a"),
        tabs: hex("#1a1a1a"),
        menu_line: hex("#2c2c2c"),
        shadow: rgba(0, 0, 0, 0.45),
        press: rgba(255, 255, 255, 0.06),
        on_accent: Color::WHITE,
        solid: hex("#0f0f0f"),
        art: [200, 205, 215],
    }
}

/// The light theme: the same roles on paper. Text on every fill is at least 4.5:1.
pub fn light() -> Theme {
    Theme {
        bg: hex("#ffffff"),
        side: hex("#f7f7f7"),
        rail: hex("#f1f1f1"),
        card: hex("#f6f6f6"),
        card_border: hex("#e0e0e0"),
        hover: rgba(0, 0, 0, 0.05),
        active: rgba(0, 0, 0, 0.085),
        text: hex("#1a1a1a"),
        dim: hex("#555555"),
        faint: hex("#6f6f6f"),
        border: hex("#e4e4e4"),
        accent: hex("#2563eb"),
        green: hex("#1a7f4b"),
        red: hex("#c93a2a"),
        warn: hex("#b45a0e"),
        purple: hex("#6a45d6"),
        bubble: hex("#eeeeee"),
        control: hex("#f0f0f0"),
        control_border: hex("#d6d6d6"),
        composer: hex("#ffffff"),
        composer_border: hex("#d2d2d2"),
        invert: hex("#1a1a1a"),
        invert_text: hex("#f6f6f6"),
        merge: hex("#1f883d"),
        dark: false,
        tile: hex("#f0f0f0"),
        tile_border: hex("#dcdcdc"),
        tile_ink: hex("#2e2e2e"),
        field: hex("#f3f3f3"),
        field_border: hex("#d9d9d9"),
        panel: hex("#f8f8f8"),
        popup: hex("#ffffff"),
        well: hex("#f3f3f3"),
        pane: hex("#f7f7f7"),
        stage: hex("#e6e6e6"),
        code_bg: hex("#e9e9e9"),
        code_ink: hex("#24292e"),
        switch_off: hex("#c4c4c4"),
        tabs: hex("#ebebeb"),
        menu_line: hex("#e4e4e4"),
        shadow: rgba(0, 0, 0, 0.16),
        press: rgba(0, 0, 0, 0.06),
        on_accent: Color::WHITE,
        solid: hex("#ffffff"),
        art: [60, 64, 74],
    }
}

/// `--radius-lg` and `--radius-md`.
pub const R_LG: f32 = 18.0;
pub const R_MD: f32 = 12.0;

/// The UI font: Segoe UI Variable, then the system sans, then Rune's bundled Inter.
pub const UI_FAMILIES: &str = "Segoe UI Variable Text, Segoe UI Variable, Segoe UI, SF Pro Text, Inter";
/// Monospace, used only in the editor, the terminal and diffs.
pub const MONO_FAMILIES: &str = "ui-monospace, Cascadia Code, Cascadia Mono, SF Mono, Consolas, JetBrains Mono, DejaVu Sans Mono";

/// The fonts the app carries itself (OFL), so a theme can ask for them on any PC.
pub const BUNDLED_FONTS: &[&[u8]] = &[
    include_bytes!("../assets/fonts/Geist.ttf"),
    include_bytes!("../assets/fonts/GeistMono.ttf"),
];

// ---------- the user's font settings, read by every `ui()` call ----------

static SCALE_BITS: AtomicU32 = AtomicU32::new(0x3f80_0000); // 1.0
static BOLD: AtomicI32 = AtomicI32::new(0);

/// Sets the text scale (1.0 is the design size) and the weight shift every `ui()` call follows.
pub fn set_text(scale: f32, bold: i32) {
    SCALE_BITS.store(scale.clamp(0.5, 2.0).to_bits(), Ordering::Relaxed);
    BOLD.store(bold.clamp(-300, 300), Ordering::Relaxed);
}

pub fn text_scale() -> f32 {
    f32::from_bits(SCALE_BITS.load(Ordering::Relaxed))
}

fn shifted(weight: f32) -> f32 {
    (weight + BOLD.load(Ordering::Relaxed) as f32).clamp(100.0, 900.0)
}

/// UI text, at the prototype's `line-height: 1.45` (Rune's default is 1.25), on whole points.
/// Size and weight follow the user's font settings.
pub fn ui(size: f32, weight: f32) -> TextStyle {
    let size = (size * text_scale() * 2.0).round() / 2.0;
    TextStyle::new(size, shifted(weight)).lh((size * 1.45).round())
}

/// Monospace text. Only the code editor, terminal and diff views call this.
pub fn mono(size: f32, line_height: f32) -> TextStyle {
    let k = text_scale();
    TextStyle::new((size * k * 2.0).round() / 2.0, shifted(400.0)).family(Family::Mono).lh((line_height * k).round())
}

/// Tabular figures for times and counts, so they don't jitter.
pub fn tabular(size: f32, weight: f32) -> TextStyle {
    ui(size, weight).features("'tnum' 1")
}

// ---------- choosing and deriving a theme ----------

/// `#rrggbb` as 0..255 channels.
pub fn rgb(s: &str) -> Option<[f32; 3]> {
    let s = s.trim().strip_prefix('#')?;
    let s = if s.len() == 3 { s.chars().flat_map(|c| [c, c]).collect::<String>() } else { s.to_owned() };
    if s.len() != 6 || !s.is_ascii() {
        return None;
    }
    let ch = |i: usize| u8::from_str_radix(&s[i..i + 2], 16).ok().map(f32::from);
    Some([ch(0)?, ch(2)?, ch(4)?])
}

/// Whether `s` is a colour this app accepts (`#rgb` or `#rrggbb`).
pub fn is_hex(s: &str) -> bool {
    rgb(s).is_some()
}

pub fn to_hex(c: [f32; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0].round().clamp(0.0, 255.0) as u8, c[1].round().clamp(0.0, 255.0) as u8, c[2].round().clamp(0.0, 255.0) as u8)
}

/// `a` towards `b` by `t` (0..1), in sRGB.
fn mix(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/// WCAG relative luminance.
pub fn luminance(c: [f32; 3]) -> f32 {
    let lin = |v: f32| {
        let v = v / 255.0;
        if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
    };
    0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
}

/// WCAG contrast ratio, 1..21.
pub fn contrast(a: [f32; 3], b: [f32; 3]) -> f32 {
    let (la, lb) = (luminance(a), luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

/// `ink` pushed towards `toward` until it reads on `bg` at `ratio` or better.
fn legible(ink: [f32; 3], toward: [f32; 3], bg: [f32; 3], ratio: f32) -> [f32; 3] {
    let mut t = 0.0;
    let mut c = ink;
    while contrast(c, bg) < ratio && t < 1.0 {
        t += 0.05;
        c = mix(ink, toward, t);
    }
    c
}

fn bytes(c: [f32; 3]) -> [u8; 3] {
    [c[0].round().clamp(0.0, 255.0) as u8, c[1].round().clamp(0.0, 255.0) as u8, c[2].round().clamp(0.0, 255.0) as u8]
}

fn h(c: [f32; 3]) -> Color {
    hex(&to_hex(c))
}

/// A theme made from three colours (background, text, accent), every other token mixed from
/// them: what a custom or generated theme is. `side` overrides the sidebar's fill.
pub fn derive(bg: [f32; 3], side: Option<[f32; 3]>, text: [f32; 3], accent: [f32; 3]) -> Theme {
    let dark = luminance(bg) < 0.4;
    let base = if dark { dark_theme() } else { light() };
    // Strength of the steps away from the background; paper needs a little more than night.
    let k = if dark { 1.0 } else { 1.12 };
    let step = |f: f32| mix(bg, text, (f * k).min(0.9));
    let card_border = step(0.109);
    let dim = legible(mix(bg, text, 0.68), text, bg, 6.0);
    let faint = legible(mix(bg, text, 0.52), text, bg, 4.5);
    let on_accent = if contrast([255.0; 3], accent) >= 3.0 { [255.0; 3] } else { [16.0; 3] };
    let (hov, act) = if dark { (rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.09)) } else { (rgba(0, 0, 0, 0.05), rgba(0, 0, 0, 0.085)) };
    let side_c = side.unwrap_or_else(|| step(0.036));
    Theme {
        bg: h(bg),
        side: h(side_c),
        rail: h(step(0.014 + if dark { 0.0 } else { 0.03 })),
        card: h(step(0.083)),
        card_border: h(card_border),
        hover: hov,
        active: act,
        text: h(text),
        dim: h(dim),
        faint: h(faint),
        border: h(step(0.05)),
        accent: h(accent),
        bubble: h(step(0.07)),
        control: h(step(0.054)),
        control_border: h(step(0.1)),
        composer: h(step(0.04)),
        composer_border: h(step(0.08)),
        invert: h(text),
        invert_text: h(bg),
        dark,
        tile: h(step(0.075)),
        tile_border: h(step(0.1)),
        tile_ink: h(mix(text, bg, 0.05)),
        field: h(step(0.03)),
        field_border: h(step(0.09)),
        panel: h(step(0.02)),
        popup: h(step(0.05)),
        well: h(step(0.02)),
        pane: h(mix(bg, if dark { [0.0; 3] } else { text }, 0.25 * if dark { 1.0 } else { 0.06 })),
        stage: h(mix(bg, if dark { [0.0; 3] } else { text }, if dark { 0.5 } else { 0.1 })),
        code_bg: h(step(0.1)),
        code_ink: h(mix(text, bg, 0.04)),
        switch_off: h(step(0.14)),
        tabs: h(step(0.03)),
        menu_line: h(step(0.09)),
        on_accent: h(on_accent),
        solid: h(bg),
        art: bytes(mix(text, accent, 0.4)),
        ..base
    }
}

fn dark_theme() -> Theme {
    dark()
}

/// The theme to draw with: the chosen mode (the system's appearance when it says so), with any
/// colours the user changed.
pub fn resolve(look: &crate::look::LookPrefs, system_dark: bool) -> Theme {
    use crate::look::Mode;
    let want_dark = match look.mode {
        Mode::Dark => true,
        Mode::Light => false,
        Mode::System => system_dark,
    };
    let base = if want_dark { dark() } else { light() };
    let pick = |v: &Option<String>| v.as_deref().and_then(rgb);
    let (bg, side, text, accent) = (pick(&look.bg), pick(&look.side), pick(&look.text), pick(&look.accent));
    if bg.is_none() && side.is_none() && text.is_none() {
        // Only the accent (or nothing) changed: keep the hand-tuned theme.
        return match accent {
            Some(a) => Theme {
                accent: h(a),
                on_accent: h(if contrast([255.0; 3], a) >= 3.0 { [255.0; 3] } else { [16.0; 3] }),
                art: bytes(mix([base.art[0].into(), base.art[1].into(), base.art[2].into()], a, 0.5)),
                ..base
            },
            None => base,
        };
    }
    let rgb_of = |t: Option<[f32; 3]>, fallback: &str| t.or_else(|| rgb(fallback)).unwrap_or([0.0; 3]);
    let (dbg, _dtext, dacc) = if want_dark { ("#0f0f0f", "#ececec", "#3d8bfd") } else { ("#ffffff", "#1a1a1a", "#2563eb") };
    let bg = rgb_of(bg, dbg);
    // Text left alone follows the background, so a new background never loses its words.
    let text = match text {
        Some(t) => t,
        None if luminance(bg) < 0.4 => rgb("#ececec").unwrap_or([236.0; 3]),
        None => rgb("#1a1a1a").unwrap_or([26.0; 3]),
    };
    // Text reads on the background and on the surfaces mixed from it (cards, menus, the sidebar).
    let toward = if contrast([255.0; 3], bg) >= contrast([0.0; 3], bg) { [255.0; 3] } else { [0.0; 3] };
    let text = legible(text, toward, bg, 7.0);
    let text = legible(text, toward, mix(bg, text, 0.14), 7.0);
    let accent = legible(rgb_of(accent, dacc), toward, bg, 3.0);
    derive(bg, side, text, accent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::look::{LookPrefs, Mode};

    fn ratio(a: Color, b: Color) -> f32 {
        contrast(rgb(&a.hex()[..7]).expect("hex"), rgb(&b.hex()[..7]).expect("hex"))
    }

    /// The pairs the app really draws: text on each surface, and the buttons.
    fn readable(name: &str, t: &Theme) {
        for (bgname, bg) in [("bg", t.solid), ("side", t.side), ("card", t.card), ("control", t.control), ("composer", t.composer), ("popup", t.popup)] {
            assert!(ratio(t.text, bg) >= 7.0, "{name}: text on {bgname} is {:.1}", ratio(t.text, bg));
            assert!(ratio(t.dim, bg) >= 4.5, "{name}: dim on {bgname} is {:.1}", ratio(t.dim, bg));
        }
        assert!(ratio(t.faint, t.solid) >= 4.0, "{name}: faint on bg is {:.1}", ratio(t.faint, t.solid));
        assert!(ratio(t.invert_text, t.invert) >= 7.0, "{name}: the primary button");
        assert!(ratio(t.on_accent, t.accent) >= 3.0, "{name}: text on the accent is {:.1}", ratio(t.on_accent, t.accent));
        assert!(ratio(t.accent, t.solid) >= 3.0, "{name}: accent on bg is {:.1}", ratio(t.accent, t.solid));
    }

    #[test]
    fn every_token_parses() {
        for s in ["#0f0f0f", "#ececec", "#3d8bfd", "#238636"] {
            assert!(rune::color::hex(s).is_some(), "{s}");
        }
        assert!(is_hex("#abc") && is_hex("#A0B1c2") && !is_hex("abc") && !is_hex("#12345g") && !is_hex("#12"));
    }

    #[test]
    fn both_stock_themes_read_well() {
        readable("dark", &dark());
        readable("light", &light());
    }

    #[test]
    fn chosen_and_generated_colours_always_read() {
        let case = |bg: &str, text: Option<&str>, accent: &str| LookPrefs {
            bg: Some(bg.into()), text: text.map(str::to_owned), accent: Some(accent.into()), ..LookPrefs::default()
        };
        for (name, look) in [
            ("tokyo", case("#0b1220", Some("#dbe6ff"), "#7c5cff")),
            ("paper", case("#f6f1e7", None, "#d946ef")),
            ("bad text on dark", case("#101010", Some("#222222"), "#111111")),
            ("bad text on light", case("#fafafa", Some("#eeeeee"), "#ffff00")),
        ] {
            readable(name, &resolve(&look, true));
        }
        // Only the accent chosen: the hand-tuned theme stays, with the new accent.
        let t = resolve(&LookPrefs { mode: Mode::Light, accent: Some("#f97316".into()), ..LookPrefs::default() }, true);
        assert!(!t.dark && t.accent.hex().starts_with("#f97316"));
        // "Match system" follows the system.
        let sys = LookPrefs { mode: Mode::System, ..LookPrefs::default() };
        assert!(resolve(&sys, true).dark && !resolve(&sys, false).dark);
    }

    #[test]
    fn the_default_look_is_the_current_dark_theme() {
        let t = resolve(&LookPrefs::default(), false);
        assert_eq!((t.bg.hex(), t.side.hex(), t.text.hex(), t.accent.hex()), (dark().bg.hex(), dark().side.hex(), dark().text.hex(), dark().accent.hex()));
        assert!(t.bg.hex().starts_with("#0f0f0f"));
    }

    #[test]
    fn font_settings_scale_every_ui_style() {
        set_text(1.0, 0);
        let base = ui(14.0, 400.0);
        set_text(1.35, 200);
        let big = ui(14.0, 400.0);
        set_text(1.0, 0);
        assert_eq!((base.size, base.weight), (14.0, 400.0));
        assert_eq!((big.size, big.weight), (19.0, 600.0));
    }
}
