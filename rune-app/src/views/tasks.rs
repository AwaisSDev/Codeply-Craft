//! The background tasks pane: helpers Wisp handed work to, and commands left running.

use rune::{El, ScrollSpec, col, el, row, text};

use crate::app::{App, Pane};
use crate::bot;
use crate::icons::ico;
use crate::theme::{Theme, ui};
use crate::ui::{ibtn, wave};
use crate::views::agents::awake;

pub fn pane(s: &App, t: &Theme) -> El {
    let header = row().w_full().h(38.0).px(12.0).gap(6.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.border)
        .child(text("Background tasks").font(ui(13.0, 600.0)).color(t.text))
        .child(el().grow(1.0).min_w(0.0))
        .child(ibtn(t, "trash", "Clear finished").key("tasks-clear").on_press(|s: &mut App| s.data.extra.bg_tasks.retain(|b| b.running)))
        .child(ibtn(t, "close", "Close tasks").key("tasks-close").on_press(|s: &mut App| s.toggle_pane(Pane::Tasks)));

    let mut list = col().w_full().px(8.0).py(8.0).gap(2.0);
    for task in &s.data.extra.bg_tasks {
        let icon = match task.agent.as_deref().and_then(|id| s.data.agent(id)) {
            Some(a) if task.kind == "agent" => bot::agent(&awake(a), 24.0),
            _ => el().size(24.0, 24.0).center().child(ico("terminal", t.dim)),
        };
        let id = task.id.clone();
        let mut info = col().grow(1.0).min_w(0.0)
            .child(text(task.title.clone()).font(ui(13.5, 500.0)).color(t.text).truncate())
            .child(text(task.detail.clone()).font(ui(12.0, 400.0)).color(t.dim).truncate());
        if task.running {
            info = info.child(wave("Running", ui(12.0, 500.0), t.accent));
        }
        list = list.child(row().key(format!("task/{}", task.id)).w_full().min_h(48.0).px(8.0).py(6.0).gap(10.0).radius(10.0).center_y().hover(t.hover)
            .child(icon)
            .child(info)
            .children(task.running.then(|| ibtn(t, "stop", "Stop").key(format!("task-stop/{}", task.id))
                .on_press(move |s: &mut App| s.kill_task(&id)))));
    }
    if s.data.extra.bg_tasks.is_empty() {
        list = list.child(col().w_full().py(40.0).center()
            .child(text("Nothing running in the background.").font(ui(13.0, 400.0)).color(t.faint)));
    }

    col().key("tasks-pane").w(300.0).h_full().min_h(0.0).fill(t.bg).border_sides([0.0, 0.0, 0.0, 1.0], t.border)
        .child(header)
        .child(col().grow(1.0).min_h(0.0).w_full().scroll(ScrollSpec { stick_bottom: false }).child(list))
}
