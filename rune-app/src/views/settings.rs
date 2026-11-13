//! Settings. Phase 1 has the team sheet (every helper's look, its states and its Office sprite)
//! and a placeholder for the browser surfaces (Wisp's browser, agent tabs, the Design tab), which
//! need a Chromium view opened on demand; Rune has no webview of its own.

use std::cell::RefCell;
use std::collections::HashMap;

use rune::{El, Pixels, ScrollSpec, col, el, row, text};

use crate::app::App;
use crate::bot;
use crate::icons::ico;
use crate::model::{Agent, AgentState, Face, Gear, Shape};
use crate::theme::{self, Theme, ui};
use crate::ui::{card, enter, heading, me, side_head, side_row};
use crate::views::office_art::{ACTOR_H, ACTOR_W, Pose, render_actor};
use crate::views::warp::upscale;

pub fn side(s: &App, t: &Theme) -> El {
    col().h_full().min_h(0.0)
        .child(side_head(t, "Settings", None))
        .child(col().grow(1.0).px(8.0)
            .child(side_row(t, true).child(ico("users", t.dim)).child(text("Your team").font(ui(14.0, 400.0)).color(t.text)))
            .child(side_row(t, false).child(ico("oai-settings", t.dim)).child(text("General").font(ui(14.0, 400.0)).color(t.text)))
            .child(side_row(t, false).child(ico("globe", t.dim)).child(text("Browser").font(ui(14.0, 400.0)).color(t.text))))
        .child(me(s, t))
}

pub fn main(s: &App, t: &Theme) -> El {
    let cards = s.data.team.chunks(3).enumerate().map(|(r, chunk)| {
        enter(row().gap(16.0).items_stretch().children(chunk.iter().map(|a| member(t, a).grow(1.0).w(0.0))), r)
    });
    let page = col().w_full().max_w(1040.0).px(32.0).pt(16.0).pb(48.0).gap(16.0)
        .child(heading(t, "Your team", Some(format!("Wisp and {} helpers. Data: {}", s.data.team.len().saturating_sub(1), s.data.source))))
        .children(cards)
        .child(browser_placeholder(t, "Browser views", "Wisp's browser, agent tabs and the Design tab open a Chromium view here, only when you ask for one. Not in this build yet."));
    col().key("settings-page").w_full().h_full().items_center().scroll(ScrollSpec { stick_bottom: false }).child(page)
}

fn describe(a: &Agent) -> String {
    let shape = match a.look.shape {
        Shape::Hex => "Hexagon",
        Shape::Round => "Round",
        Shape::Square => "Squircle",
        Shape::Cloud => "Cloud",
        Shape::Triangle => "Triangle",
        Shape::Drop => "Drop",
        Shape::Pebble => "Pebble",
    };
    let face = match a.look.face {
        Face::Pill => "pill eyes",
        Face::Glossy => "glossy eyes",
        Face::Googly => "googly eyes",
        Face::Content => "content eyes",
        Face::Capsule => "capsule eyes",
    };
    let gear: Vec<&str> = a.look.gear.iter().map(|g| match g {
        Gear::Beret => "beret",
        Gear::Bow => "bow tie",
        Gear::Headphones => "headphones",
        Gear::Glasses => "glasses",
        Gear::Shades => "shades",
        Gear::Sprout => "sprout",
        Gear::Flower => "flower",
        Gear::Star => "star",
        Gear::Cap => "cap",
        Gear::Antennae => "antennae",
    }).collect();
    if gear.is_empty() { format!("{shape}, {face}") } else { format!("{shape}, {face}, {}", gear.join(" and ")) }
}

/// One helper: large, then in each state, then as the Office draws it.
fn member(t: &Theme, a: &Agent) -> El {
    let states = [(AgentState::Working, "Working"), (AgentState::Thinking, "Thinking"), (AgentState::Waiting, "Needs you"), (AgentState::Sleeping, "Asleep")];
    let mut idle = a.clone();
    idle.state = AgentState::Idle;
    let variants = row().gap(6.0).justify_between().children(states.iter().map(|(st, label)| {
        let mut v = a.clone();
        v.state = *st;
        col().gap(4.0).items_center()
            .child(bot::agent(&v, 40.0))
            .child(text(*label).font(ui(11.0, 400.0)).color(t.faint))
    }));
    card(t).padding(16.0).gap(12.0)
        .child(row().gap(14.0).center_y()
            .child(el().size(96.0, 96.0).radius(20.0).fill(theme::hex("#161616")).center().child(bot::agent(&idle, 84.0)))
            .child(col().grow(1.0).min_w(0.0).gap(2.0)
                .child(text(a.name.clone()).font(ui(16.0, 650.0)).color(t.text))
                .child(text(a.role.clone()).font(ui(12.5, 400.0)).color(t.faint))
                .child(text(describe(a)).font(ui(12.5, 400.0)).color(t.dim).wrap()))
            .child(el().size(ACTOR_W as f32 * 2.0, ACTOR_H as f32 * 2.0).radius(10.0).fill(theme::hex("#1d1712")).pixels(&sprite(a))))
        .child(el().h(1.0).w_full().fill(t.card_border))
        .child(variants)
        .children((a.id != "wisp").then(|| pickers(t, a)))
}

/// The colours to pick from: the twelve of the reference set.
pub const COLORS: [&str; 12] = ["#111111", "#12b5a5", "#8b5cf6", "#1e88ff", "#ff6a13", "#ff9f1a", "#ff2d95", "#8b5a3c", "#7a7a7a", "#22c55e", "#ef4444", "#4fb3ff"];
const SHAPES: [Shape; 7] = [Shape::Round, Shape::Square, Shape::Cloud, Shape::Triangle, Shape::Drop, Shape::Pebble, Shape::Hex];

/// Shape and colour pickers. Wisp keeps its hexagon and Codeply blue, so only helpers get them.
fn pickers(t: &Theme, a: &Agent) -> El {
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

/// The helper's Office sprite at 2 device pixels per art pixel, made once per look.
fn sprite(a: &Agent) -> Pixels {
    thread_local! {
        static MADE: RefCell<HashMap<String, Pixels>> = RefCell::new(HashMap::new());
    }
    MADE.with_borrow_mut(|made| {
        made.entry(format!("{}{:?}", a.color, a.look)).or_insert_with(|| {
            let cv = render_actor(&a.color, &a.look, Pose { state: AgentState::Idle, frame: 0, left: false });
            let px = Pixels::new();
            px.set(ACTOR_W * 2, ACTOR_H * 2, upscale(&cv.px, ACTOR_W, ACTOR_H, 2));
            px
        }).clone()
    })
}

/// Where a browser surface will go: a calm card, not a fake page.
pub fn browser_placeholder(t: &Theme, title: &str, note: &str) -> El {
    card(t).padding(16.0).gap(8.0)
        .child(row().gap(8.0).center_y().child(ico("globe", t.dim)).child(text(title.to_owned()).font(ui(14.0, 600.0)).color(t.text)))
        .child(text(note.to_owned()).font(ui(13.0, 400.0).lh(19.0)).color(t.faint).wrap())
}
