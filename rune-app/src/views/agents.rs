//! Agents: Mission control (Wisp and its helpers at a glance) and each agent's conversation with
//! a detail panel on the right. A quiet, list-based layout.

use rune::{Color, Cx, El, ScrollSpec, col, el, row, text};

use crate::app::{App, EditKey};
use crate::bot;
use crate::icons::{ico, ico_s};
use crate::model::{Agent, AgentState, ButtonKind, Column, Task, TaskBody};
use crate::store::Target;
use crate::theme::{Theme, ui};
use crate::ui::{btn, card, composer, enter, me, name_and_line, side_head, side_row, sec, toggle};

// ---------- sidebar ----------

pub fn side(s: &App, t: &Theme) -> El {
    let mut list = col().px(8.0).pb(10.0);

    list = list.child(
        side_row(t, s.agent.is_none())
            .key("agent-row/mission")
            .role("button")
            .label("Mission control")
            .child(ico("target", t.dim))
            .child(name_and_line(t, "Mission control", None, 400.0))
            .on_press(|s: &mut App| s.open_agent(None)),
    );

    if let Some(w) = s.data.agent("wisp") {
        let line = s.data.chat(&w.name).map(|c| c.preview.clone()).filter(|p| !p.is_empty()).unwrap_or_else(|| w.status.clone());
        let running = s.data.is_running(&w.name);
        list = list.child(
            side_row(t, s.agent.as_deref() == Some("wisp"))
                .key("agent-row/wisp")
                .mt(4.0)
                .role("button")
                .label(w.name.clone())
                .child(bot::agent(w, 34.0))
                .child(name_and_line(t, &w.name, Some(&line), 500.0))
                .children(running.then(|| el().size(6.0, 6.0).radius(3.0).fill(t.green)))
                .on_press(|s: &mut App| s.open_agent(Some("wisp"))),
        );
    }

    list = list.child(sec(t, None, "Team", false));
    let helpers = s.data.team.iter().filter(|a| a.id != "wisp" && a.state != AgentState::Walking);
    for (i, a) in helpers.enumerate() {
        let (id, more_id) = (a.id.clone(), a.id.clone());
        let open = s.appearance.as_deref() == Some(a.id.as_str());
        let running = s.data.is_running(&a.name);
        let more = el()
            .key(format!("more/{}", a.id))
            .size(26.0, 26.0)
            .radius(7.0)
            .center()
            .role("button")
            .label(format!("More for {}", a.name))
            .help("Appearance")
            .fill(if open { t.active } else { Color::TRANSPARENT })
            .hover(t.hover)
            .child(ico_s("more", 16.0, t.dim))
            .group_opacity(if open { 1.0 } else { 0.0 }, 1.0)
            .on_press(move |s: &mut App| s.toggle_appearance(&more_id));
        let r = side_row(t, s.agent.as_deref() == Some(a.id.as_str()))
            .key(format!("agent-row/{}", a.id))
            .hover_group()
            .role("button")
            .label(a.name.clone())
            .child(bot::agent(a, 30.0))
            .child(name_and_line(t, &a.name, Some(&a.status), 400.0))
            .children(running.then(|| el().size(6.0, 6.0).radius(3.0).fill(t.green)))
            .child(more)
            .on_press(move |s: &mut App| s.open_agent(Some(&id)));
        list = list.child(enter(r, i));
    }

    list = list.child(sec(t, None, "Loops", false));
    for l in &s.data.extra.loops {
        let who = s.data.agent(&l.agent).map(|a| a.name.clone()).unwrap_or_else(|| l.agent.clone());
        let agent = l.agent.clone();
        list = list.child(
            side_row(t, false)
                .key(format!("loop-row/{}/{}", l.agent, l.name))
                .role("button")
                .label(l.name.clone())
                .child(ico("clock", t.dim))
                .child(name_and_line(t, &l.name, Some(&who), 400.0))
                .on_press(move |s: &mut App| s.open_agent(Some(&agent))),
        );
    }

    col().h_full().min_h(0.0)
        .child(side_head(t, "Agents", Some(("plus", "New agent"))))
        .child(col().grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(list))
        .child(me(s, t))
}

/// This view has no menus of its own yet.
pub fn menu(_s: &App, _t: &Theme, _id: &str) -> Option<El> {
    None
}

// ---------- main ----------

pub fn main(s: &App, t: &Theme, _cx: &mut Cx<App>) -> El {
    match s.agent.as_deref().and_then(|id| s.data.agent(id)) {
        Some(a) => agent_page(s, t, a),
        None => mission(s, t),
    }
}

fn greeting() -> &'static str {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    match (secs / 3600) % 24 {
        5..=11 => "Good morning",
        12..=17 => "Good afternoon",
        _ => "Good evening",
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn mission(s: &App, t: &Theme) -> El {
    let count = |c: Column| s.data.tasks.iter().filter(|(k, _)| *k == c).count();
    let (working, needs, done) = (count(Column::Working), count(Column::NeedsYou), count(Column::Done));
    let helpers = s.data.team.iter().filter(|a| a.id != "wisp").count();
    let summary = format!("Wisp and {} · {working} working · {needs} needs you · {done} done today", plural(helpers, "helper", "helpers"));
    let hello = if s.data.user.is_empty() { greeting().to_owned() } else { format!("{}, {}", greeting(), s.data.user) };

    let head = col().w_full().items_center().gap(10.0).pb(26.0)
        .child(bot::wisp(40.0))
        .child(text(hello).font(ui(26.0, 650.0)).color(t.text))
        .child(text(summary).font(ui(13.5, 400.0)).color(t.faint));

    let body = col().w_full().max_w(760.0).px(24.0).pt(64.0).pb(64.0).gap(8.0)
        .child(head)
        .child(el().w_full().pb(12.0).child(composer(s, t, EditKey::Mission, Target::Wisp, "Give Wisp a task, or ask how things are going", false, false)))
        .child(task_section(s, t, "needs", "Needs you", Column::NeedsYou, "Nothing is waiting on you."))
        .child(task_section(s, t, "working", "Working", Column::Working, "No one is working right now."))
        .child(task_section(s, t, "done", "Done today", Column::Done, "Nothing finished yet today."));

    col().key("mission").w_full().h_full().items_center().scroll(ScrollSpec { stick_bottom: false }).child(body)
}

fn task_section(s: &App, t: &Theme, id: &str, title: &str, c: Column, empty: &str) -> El {
    let tasks: Vec<&Task> = s.data.tasks.iter().filter(|(k, _)| *k == c).map(|(_, task)| task).collect();
    let mut sec = col().w_full().pt(14.0)
        .child(row().gap(8.0).px(10.0).pb(6.0).center_y()
            .child(text(title.to_owned()).font(ui(12.5, 600.0)).color(t.faint))
            .child(text(tasks.len().to_string()).font(ui(12.5, 400.0)).color(t.faint)));
    if tasks.is_empty() {
        sec = sec.child(row().px(10.0).py(8.0).child(text(empty.to_owned()).font(ui(13.5, 400.0)).color(t.faint)));
    }
    for (i, task) in tasks.into_iter().enumerate() {
        sec = sec.child(enter(task_row(s, t, id, i, task), i));
    }
    sec
}

fn task_row(s: &App, t: &Theme, section: &str, i: usize, task: &Task) -> El {
    let base = format!("task/{section}/{i}");
    let agent = task.agent.clone();
    let sub = match &task.body {
        TaskBody::Working { now, .. } => if task.sub.is_empty() { now.clone() } else { task.sub.clone() },
        TaskBody::Ask { text, .. } => if task.sub.is_empty() { text.clone() } else { task.sub.clone() },
        TaskBody::Done { proof, .. } => proof.clone(),
    };
    let mut middle = col().grow(1.0).min_w(0.0).gap(2.0)
        .child(text(task.title.clone()).font(ui(14.0, 500.0)).color(t.text).truncate())
        .child(text(sub).font(ui(12.5, 400.0)).color(t.dim).truncate());
    if let TaskBody::Working { progress, .. } = &task.body {
        middle = middle.child(el().mt(6.0).h(3.0).w_full().radius(1.5).fill(t.hover)
            .child(el().h_full().w_frac(progress.clamp(0.0, 1.0)).radius(1.5).fill(t.accent)));
    }

    let mut buttons = row().gap(8.0).center_y();
    if let TaskBody::Ask { buttons: labels, .. } = &task.body {
        if let Some((_, request)) = &task.request {
            let (allow, reject) = (request.clone(), request.clone());
            buttons = buttons
                .child(btn(t, "Allow once", None, ButtonKind::Blue).key(format!("{base}/allow")).on_press(move |s: &mut App| s.answer(&allow, "once")))
                .child(btn(t, "Don't allow", None, ButtonKind::Plain).key(format!("{base}/reject")).on_press(move |s: &mut App| s.answer(&reject, "reject")));
        } else {
            for (j, (label, kind)) in labels.iter().enumerate() {
                buttons = buttons.child(btn(t, label, None, kind.clone()).key(format!("{base}/btn/{j}")));
            }
        }
    }

    row().key(base).w_full().min_h(48.0).px(10.0).py(8.0).gap(12.0).radius(10.0).center_y().hover(t.hover)
        .role("button").label(task.title.clone())
        .children(s.data.agent(&task.agent).map(|a| bot::agent(a, 22.0)))
        .child(middle)
        .child(buttons)
        .on_press(move |s: &mut App| s.open_agent(Some(&agent)))
}

// ---------- an agent ----------

fn agent_page(s: &App, t: &Theme, a: &Agent) -> El {
    let head = row().gap(10.0).px(24.0).h(52.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.border)
        .child(bot::agent(a, 22.0))
        .child(text(a.name.clone()).font(ui(14.5, 600.0)).color(t.text))
        .child(text(a.role.clone()).font(ui(13.0, 400.0)).color(t.dim).truncate().min_w(0.0));
    let thread = crate::thread::with_composer(s, t, &a.name, &a.name, EditKey::AgentThread, Target::Agent(a.id.clone()), &format!("Message {}", a.name), 760.0);
    let centre = col().grow(1.0).min_w(0.0).h_full()
        .child(head)
        .child(el().w_full().grow(1.0).min_h(0.0).child(thread));
    row().key(format!("agent-page/{}", a.id)).w_full().h_full().child(centre).child(panel(s, t, a))
}

fn state_word(state: AgentState) -> &'static str {
    match state {
        AgentState::Working => "Working",
        AgentState::Thinking => "Thinking",
        AgentState::Waiting => "Needs you",
        AgentState::Sleeping => "Asleep",
        AgentState::Idle => "Idle",
        AgentState::Walking => "Walking",
    }
}

fn label(t: &Theme, title: &str) -> El {
    text(title.to_owned()).font(ui(12.5, 600.0)).color(t.faint)
}

fn panel(s: &App, t: &Theme, a: &Agent) -> El {
    let chip = match a.state {
        AgentState::Working => t.green,
        AgentState::Thinking => t.accent,
        AgentState::Waiting => t.warn,
        _ => t.faint,
    };
    let computer = card(t).w_full().px(14.0).py(12.0).child(
        row().gap(12.0).center_y()
            .child(el().size(34.0, 34.0).radius(9.0).fill(t.hover).center().child(ico_s("terminal", 16.0, t.dim)))
            .child(col().grow(1.0).min_w(0.0).gap(2.0)
                .child(text(format!("{}'s computer", a.name)).font(ui(13.5, 500.0)).color(t.text).truncate())
                .child(row().gap(6.0).center_y()
                    .child(el().size(8.0, 8.0).radius(2.0).fill(chip))
                    .child(text(state_word(a.state).to_owned()).font(ui(12.5, 400.0)).color(t.dim)))),
    );

    // Sessions: the agent's own chat, then up to three others in the same project.
    let own = s.data.chat(&a.name);
    let mut sessions: Vec<(String, String)> = Vec::new();
    if let Some(c) = own {
        sessions.push((c.title.clone(), c.ago.clone()));
        sessions.extend(s.data.extra.chats.iter().filter(|o| o.project == c.project && o.title != c.title).take(3).map(|o| (o.title.clone(), o.ago.clone())));
    }
    let mut session_list = col().w_full().gap(2.0);
    if sessions.is_empty() {
        session_list = session_list.child(text("No sessions yet.").font(ui(13.0, 400.0)).color(t.faint).px(8.0).py(6.0));
    }
    for (title, ago) in sessions {
        let open = title.clone();
        session_list = session_list.child(
            row().key(format!("session/{title}")).w_full().min_h(34.0).px(8.0).py(6.0).gap(10.0).radius(8.0).center_y().hover(t.hover)
                .role("button").label(title.clone())
                .child(ico_s("chat", 16.0, t.dim))
                .child(text(title).font(ui(13.5, 400.0)).color(t.text).truncate().grow(1.0).min_w(0.0))
                .child(text(ago).font(ui(12.0, 400.0)).color(t.faint))
                .on_press(move |s: &mut App| s.open_chat(&open)),
        );
    }

    let mut loops = col().w_full().gap(4.0);
    let mine: Vec<_> = s.data.extra.loops.iter().filter(|l| l.agent == a.id).collect();
    if mine.is_empty() {
        loops = loops.child(text("No loops yet.").font(ui(13.0, 400.0)).color(t.faint).px(8.0).py(6.0));
    }
    for l in mine {
        let (agent, name) = (a.id.clone(), l.name.clone());
        let dots = row().gap(3.0).center_y().children(l.runs.iter().map(|&ok| el().size(6.0, 6.0).radius(3.0).fill(if ok { t.green } else { t.red })));
        loops = loops.child(
            row().w_full().px(8.0).py(8.0).gap(10.0).radius(8.0).center_y().hover(t.hover)
                .child(col().grow(1.0).min_w(0.0).gap(4.0)
                    .child(text(l.name.clone()).font(ui(13.5, 400.0)).color(t.text).truncate())
                    .child(row().gap(8.0).center_y()
                        .child(dots)
                        .child(text(l.last.clone()).font(ui(12.0, 400.0)).color(t.faint).truncate().min_w(0.0))))
                .child(toggle(t, format!("loop/{}/{}", a.id, l.name), l.on, &l.name)
                    .on_press(move |s: &mut App| s.toggle_loop(&agent, &name))),
        );
    }
    let create = row().key(format!("loop-new/{}", a.id)).w_full().min_h(34.0).px(8.0).gap(10.0).radius(8.0).center_y().hover(t.hover)
        .role("button").label("Create a loop")
        .child(ico_s("plus", 16.0, t.faint))
        .child(text("Create a loop").font(ui(13.5, 400.0)).color(t.dim));

    let body = col().w_full().padding(20.0).gap(0.0).items_center()
        .child(bot::agent(a, 72.0))
        .child(text(a.name.clone()).font(ui(18.0, 650.0)).color(t.text).mt(12.0))
        .child(text(a.role.clone()).font(ui(13.0, 400.0)).color(t.dim).wrap().mt(2.0))
        .child(el().w_full().mt(20.0).child(computer))
        .child(col().w_full().pt(22.0).pb(8.0).child(label(t, "Sessions")))
        .child(session_list)
        .child(col().w_full().pt(22.0).pb(8.0).child(label(t, "Loops")))
        .child(loops)
        .child(el().w_full().mt(4.0).child(create));

    col().key("agent-panel").w(320.0).h_full().border_sides([0.0, 0.0, 0.0, 1.0], t.border)
        .scroll(ScrollSpec { stick_bottom: false }).child(body)
}
