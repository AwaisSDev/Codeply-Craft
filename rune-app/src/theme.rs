//! Codeply's dark theme. Names and values follow the shipping app's `styles.css` (`:root`), with the
//! three surface greys the 4.0 workspace prototype deepens (`design/workspace/index.html`).

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
    }
}

/// `--radius-lg` and `--radius-md`.
pub const R_LG: f32 = 18.0;
pub const R_MD: f32 = 12.0;

/// The UI font: Segoe UI Variable, then the system sans, then Rune's bundled Inter.
pub const UI_FAMILIES: &str = "Segoe UI Variable Text, Segoe UI Variable, Segoe UI, SF Pro Text, Inter";
/// Monospace, used only in the editor, the terminal and diffs.
pub const MONO_FAMILIES: &str = "ui-monospace, Cascadia Code, Cascadia Mono, SF Mono, Consolas, JetBrains Mono, DejaVu Sans Mono";

/// UI text, at the prototype's `line-height: 1.45` (Rune's default is 1.25), on whole points.
pub fn ui(size: f32, weight: f32) -> TextStyle {
    TextStyle::new(size, weight).lh((size * 1.45).round())
}

/// Monospace text. Only the code editor, terminal and diff views call this.
pub const fn mono(size: f32, line_height: f32) -> TextStyle {
    TextStyle::new(size, 400.0).family(Family::Mono).lh(line_height)
}

/// Tabular figures for times and counts, so they don't jitter.
pub fn tabular(size: f32, weight: f32) -> TextStyle {
    ui(size, weight).features("'tnum' 1")
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_token_parses() {
        for s in ["#0f0f0f", "#ececec", "#3d8bfd", "#238636"] {
            assert!(rune::color::hex(s).is_some(), "{s}");
        }
    }
}
