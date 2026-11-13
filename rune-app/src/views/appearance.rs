//! An agent's Appearance: its shape and colour, opened from the "more" button on its row in the
//! Agents list. Changes show at once everywhere the agent appears, the Office included.

use rune::{Align, El, Side, col, el, row, text};

use crate::app::App;
use crate::bot;
use crate::model::{Agent, ButtonKind, Shape};
use crate::theme::{self, Theme, ui};
use crate::ui::btn;

/// The popover, anchored beside the row's "more" button. Escape or a click outside closes it.
pub fn popover(s: &App, t: &Theme, a: &Agent) -> El {
    let _ = s;
    let mut idle = a.clone();
    idle.state = crate::model::AgentState::Idle;
    col().key("appearance").w(300.0).padding(14.0).gap(12.0).radius(14.0)
        .fill(theme::hex("#1f1f1f")).border(1.0, t.control_border).shadow(12.0, 32.0, theme::rgba(0, 0, 0, 0.45))
        .anchored(format!("more/{}", a.id), Side::Right, Align::Start, 8.0)
        .role("dialog").label(format!("{}'s appearance", a.name))
        .modal(true, |s: &mut App| s.appearance = None)
        .child(row().gap(12.0).center_y()
            .child(el().size(56.0, 56.0).radius(14.0).fill(theme::hex("#161616")).center().child(bot::agent(&idle, 46.0)))
            .child(col().grow(1.0)
                .child(text("Appearance").font(ui(14.0, 650.0)).color(t.text))
                .child(text(a.name.clone()).font(ui(12.5, 400.0)).color(t.faint))))
        .child(pickers(t, a))
        .child(row().justify_end().child(btn(t, "Done", None, ButtonKind::Plain).key("appearance-done").on_press(|s: &mut App| s.appearance = None)))
}

/// The colours to pick from: the twelve of the reference set.
pub const COLORS: [&str; 12] = ["#111111", "#12b5a5", "#8b5cf6", "#1e88ff", "#ff6a13", "#ff9f1a", "#ff2d95", "#8b5a3c", "#7a7a7a", "#22c55e", "#ef4444", "#4fb3ff"];
const SHAPES: [Shape; 7] = [Shape::Round, Shape::Square, Shape::Cloud, Shape::Triangle, Shape::Drop, Shape::Pebble, Shape::Hex];

/// Shape and colour pickers. Wisp keeps its hexagon and Codeply blue, so only helpers get them.
pub fn pickers(t: &Theme, a: &Agent) -> El {
    let shapes = row().gap(3.0).children(SHAPES.iter().map(|&shape| {
        let on = a.look.shape == shape;
        let mut look = a.look.clone();
        look.shape = shape;
        let id = a.id.clone();
        el().key(format!("pick-shape/{}/{shape:?}", a.id)).size(28.0, 28.0).radius(7.0).center().role("radio").checked(on).label(format!("{shape:?}"))
            .fill(if on { t.active } else { rune::Color::TRANSPARENT }).hover(t.hover).border(1.0, if on { t.control_border } else { rune::Color::TRANSPARENT })
            .child(rune::icon(bot::icon_for(&a.color, &look, bot::Eyes::Open), 21.0))
            .on_press(move |s: &mut App| s.set_shape(&id, shape))
    }));
    let colors = row().gap(3.5).children(COLORS.iter().map(|&c| {
        let on = a.color.eq_ignore_ascii_case(c);
        let id = a.id.clone();
        el().key(format!("pick-color/{}/{c}", a.id)).size(15.0, 15.0).radius(7.5).fill(theme::hex(c)).role("radio").checked(on).label(c)
            .border(if on { 2.0 } else { 1.0 }, if on { t.text } else { rune::Color::WHITE.alpha(0.12) }).outline(if on { 1.5 } else { 0.0 }, 1.5, t.text.alpha(if on { 0.5 } else { 0.0 }))
            .on_press(move |s: &mut App| s.set_color(&id, c))
    }));
    col().gap(8.0)
        .child(row().gap(10.0).center_y().child(text("Shape").font(ui(12.0, 600.0)).color(t.faint).w(44.0)).child(shapes))
        .child(row().gap(10.0).center_y().child(text("Colour").font(ui(12.0, 600.0)).color(t.faint).w(44.0)).child(colors))
}

