//! Settings: not designed for 4.0 yet. A quiet page that says so, and where the browser surfaces
//! (Wisp's browser, agent tabs and the Design tab) will open once Codeply can show a Chromium view
//! on demand; Rune has no webview of its own.

use rune::{El, col, row, text};

use crate::app::App;
use crate::icons::ico;
use crate::theme::{Theme, ui};
use crate::ui::{card, heading, me, side_head, side_row};

pub fn side(s: &App, t: &Theme) -> El {
    col().h_full().min_h(0.0)
        .child(side_head(t, "Settings", None))
        .child(col().grow(1.0).px(8.0)
            .child(side_row(t, true).child(ico("oai-settings", t.dim)).child(text("General").font(ui(14.0, 400.0)).color(t.text)))
            .child(side_row(t, false).child(ico("globe", t.dim)).child(text("Browser").font(ui(14.0, 400.0)).color(t.text))))
        .child(me(s, t))
}

pub fn main(s: &App, t: &Theme) -> El {
    col().w_full().h_full().items_center().child(col().w_full().max_w(720.0).px(32.0).pt(16.0).gap(16.0)
        .child(heading(t, "Settings", Some(format!("Data: {}", s.data.source))))
        .child(browser_placeholder(t, "Browser views", "Wisp's browser, agent tabs and the Design tab open a Chromium view here, only when you ask for one. Not in this build yet.")))
}

/// Where a browser surface will go: a calm card, not a fake page.
pub fn browser_placeholder(t: &Theme, title: &str, note: &str) -> El {
    card(t).padding(16.0).gap(8.0)
        .child(row().gap(8.0).center_y().child(ico("globe", t.dim)).child(text(title.to_owned()).font(ui(14.0, 600.0)).color(t.text)))
        .child(text(note.to_owned()).font(ui(13.0, 400.0).lh(19.0)).color(t.faint).wrap())
}
