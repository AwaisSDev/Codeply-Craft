//! Board: the Office as a list ("Mission control"). Working, Needs you, Done today.

use rune::{El, ScrollSpec, col, el, row, text};

use crate::app::{App, EditKey, View};
use crate::bot;
use crate::icons::ico_s;
use crate::model::{AgentState, Column, Task, TaskBody};
use crate::store::Target;
use crate::theme::{self, Theme, ui};
use crate::ui::{btn, btn_primary, card, composer, enter, heading, me, name_and_line, pill, sec, seg, side_head, side_row};

pub fn side(s: &App, t: &Theme) -> El {
    let mut list = col().px(8.0).pb(10.0);
    if let Some(w) = s.data.agent("wisp") {
        list = list.child(side_row(t, true).child(bot::agent(w, 36.0)).child(name_and_line(t, &w.name, Some(&w.status), 400.0))
            .child(text("now").font(ui(12.0, 400.0)).color(t.faint)));
    }
    list = list.child(sec(t, None, "Wisp's team", false));
    let helpers = s.data.team.iter().filter(|a| a.id != "wisp" && a.state != AgentState::Walking);
    for (i, a) in helpers.enumerate() {
        let id = a.id.clone();
        list = list.child(enter(side_row(t, false).role("button").label(a.name.clone()).child(bot::agent(a, 32.0)).child(name_and_line(t, &a.name, Some(&a.status), 400.0))
            .on_press(move |s: &mut App| { s.go(View::Office); s.open_drawer(&id); }), i + 1));
    }
    list = list.child(sec(t, None, "Routines", false));
    for (icon, name, when) in &s.data.routines {
        list = list.child(side_row(t, false).child(crate::icons::ico(icon, t.dim)).child(name_and_line(t, name, Some(when), 400.0)));
    }
    col().h_full().min_h(0.0)
        .child(side_head(t, "Agents", Some(("plus", "New agent"))))
        .child(col().grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(list))
        .child(me(s, t))
}

pub fn main(s: &App, t: &Theme) -> El {
    let working = s.data.tasks.iter().filter(|(c, _)| *c == Column::Working).count();
    let needs = s.data.tasks.iter().filter(|(c, _)| *c == Column::NeedsYou).count();
    let done = s.data.tasks.iter().filter(|(c, _)| *c == Column::Done).count();
    let helpers = s.data.team.len().saturating_sub(2);
    let head = row().gap(12.0).px(24.0).pt(16.0).pb(12.0).center_y()
        .child(heading(t, "Mission control", Some(format!("Wisp and {helpers} helpers. {working} working, {} needs you, {done} done today.", s.data.count(AgentState::Waiting)))))
        .child(el().grow(1.0))
        .child(seg(t, &[("Office", false, |s: &mut App| s.go(View::Office)), ("Board", true, |_: &mut App| {})]))
        .child(btn_primary(t, "New task", "plus"));
    let column = |c: Column, icon: &str, title: &str, n: usize| {
        let tasks = s.data.tasks.iter().filter(|(k, _)| *k == c).enumerate().map(|(i, (_, task))| enter(task_card(s, t, task), i));
        col().grow(1.0).w(0.0)
            .child(row().gap(8.0).pb(10.0).center_y().child(ico_s(icon, 16.0, t.dim))
                .child(text(title.to_owned()).font(ui(13.0, 600.0)).color(t.dim))
                .child(text(n.to_string()).font(ui(13.0, 400.0)).color(t.faint)))
            .child(col().gap(12.0).children(tasks))
    };
    let board = row().key("board").gap(16.0).px(24.0).pt(4.0).pb(24.0).items_start()
        .child(column(Column::Working, "refresh", "Working", working))
        .child(column(Column::NeedsYou, "bell", "Needs you", needs))
        .child(column(Column::Done, "check", "Done today", done));
    let dock = col().pin(Some(0.0), None, Some(0.0), Some(0.0)).px(24.0).pt(18.0).pb(20.0).items_center()
        .linear_gradient(std::f32::consts::PI, [(0.0, t.bg.alpha(0.0)), (0.28, t.bg), (1.0, t.bg)])
        .child(el().w_full().max_w(980.0).child(composer(s, t, EditKey::Board, Target::Wisp, "Give Wisp a task, or ask how things are going", true, false)));
    el().w_full().h_full()
        .child(col().w_full().h_full().scroll(ScrollSpec { stick_bottom: false }).child(col().pb(190.0).child(head).child(board)))
        .child(dock)
}

fn task_card(s: &App, t: &Theme, task: &Task) -> El {
    let Some(a) = s.data.agent(&task.agent) else { return el() };
    let size = if matches!(task.body, TaskBody::Done { .. }) { 26.0 } else { 30.0 };
    let top = row().gap(10.0).center_y()
        .child(bot::agent(a, size))
        .child(col().grow(1.0).min_w(0.0)
            .child(text(task.title.clone()).font(ui(14.0, 600.0)).color(t.text).truncate())
            .child(text(if task.sub.is_empty() { a.name.clone() } else { task.sub.clone() }).font(ui(12.0, 400.0)).color(t.faint).truncate()))
        .children(task.pill.as_ref().map(|(label, kind)| pill(t, label, *kind)));
    let mut c = card(t).padding(14.0).hover(theme::rgba(255, 255, 255, 0.02)).child(top);
    match &task.body {
        TaskBody::Working { icon, now, progress, screen } => {
            c = c.child(row().gap(8.0).mt(10.0).center_y().child(ico_s(icon, 16.0, t.faint)).child(text(now.clone()).font(ui(12.5, 400.0)).color(t.dim)))
                .child(el().mt(10.0).h(4.0).w_full().radius(2.0).fill(t.hover).child(el().h_full().w_frac(*progress).radius(2.0).fill(t.accent)));
            if *screen {
                c = c.child(screen_thumb(t, &a.color, 92.0, None).mt(10.0));
            }
        }
        TaskBody::Ask { text: body, buttons } => {
            c = c.child(text(body.clone()).font(ui(13.0, 400.0).lh(19.0)).color(t.dim).wrap().mt(10.0))
                .child(row().gap(8.0).mt(12.0).children(buttons.iter().map(|(l, k)| btn(t, l, None, k.clone()))));
        }
        TaskBody::Done { proof, checked } => {
            let ink = if *checked { t.green } else { t.warn };
            c = c.child(row().gap(6.0).mt(8.0).center_y().child(ico_s(if *checked { "check" } else { "help" }, 16.0, ink))
                .child(text(proof.clone()).font(ui(12.5, 400.0)).color(ink)));
        }
    }
    c
}

/// `.thumb`: a tiny live view of the page an agent is working on, with its pointer. `roam`, when
/// given, moves the pointer (points, driven by the Office's clock); without it the pointer rests.
pub fn screen_thumb(t: &Theme, cursor: &str, h: f32, roam: Option<&rune::Live<[f32; 2]>>) -> El {
    let line = |top: f32, w: f32| el().pin(Some(10.0), Some(top), None, None).h(6.0).w_frac(w).radius(3.0).fill(theme::hex("#2a2a2a"));
    el().w_full().h(h).radius(8.0).border(1.0, t.card_border).fill(theme::hex("#0c0c0c")).clip_rounded(8.0)
        .child(el().pin(Some(0.0), Some(0.0), Some(0.0), None).h(16.0).fill(theme::hex("#1a1a1a")).border_sides([0.0, 0.0, 1.0, 0.0], t.border))
        .child(el().pin(Some(10.0), Some(26.0), Some(10.0), None).h(22.0).radius(5.0)
            .linear_gradient(std::f32::consts::FRAC_PI_2, [(0.0, theme::hex("#2f6bff")), (1.0, theme::hex("#6aa6ff"))]))
        .child(line(56.0, 0.6)).child(line(66.0, 0.44)).child(line(76.0, 0.52))
        .child(match roam {
            Some(live) => el().pin(Some(0.0), Some(0.0), None, None).size(10.0, 10.0).live_offset(live).inert().child(rune::icon(cursor_icon(cursor), 10.0)),
            None => el().pin(Some(140.0), Some(40.0), None, None).size(10.0, 10.0).inert().child(rune::icon(cursor_icon(cursor), 10.0)),
        })
}

/// The roaming pointer in a live view, in the agent's colour with a white edge. The body names
/// its colours, so it draws as full SVG: one icon per colour, kept for the life of the app.
fn cursor_icon(color: &str) -> &'static rune::Icon {
    thread_local! {
        static MADE: std::cell::RefCell<Vec<(String, &'static rune::Icon)>> = const { std::cell::RefCell::new(Vec::new()) };
    }
    MADE.with_borrow_mut(|made| {
        if let Some((_, i)) = made.iter().find(|(c, _)| c == color) {
            return *i;
        }
        let body: &'static str = Box::leak(format!(r##"<path d="M4 2l16 9-7 2-3 7z" fill="{color}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>"##).into_boxed_str());
        let icon: &'static rune::Icon = Box::leak(Box::new(rune::Icon { name: "cursor", view: 24.0, body }));
        made.push((color.to_owned(), icon));
        icon
    })
}
