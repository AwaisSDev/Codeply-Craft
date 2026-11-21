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

/// The agent as the lists show it: always awake and looking around. Its mood (working,
/// thinking, needs you, asleep) shows on its own page, in the Computer card.
pub fn awake(a: &Agent) -> Agent {
    let mut a = a.clone();
    a.state = AgentState::Idle;
    a
}

pub fn side(s: &App, t: &Theme) -> El {
    let mut list = col().px(8.0).pb(10.0);

    list = list.child(
        side_row(t, s.agent.is_none() && !s.reminders_open)
            .key("agent-row/mission")
            .role("button")
            .label("Mission control")
            .child(ico("target", t.dim))
            .child(name_and_line(t, "Mission control", None, 400.0))
            .on_press(|s: &mut App| s.open_agent(None)),
    );
    // Reminders, the same list the phone has, with how many are coming up.
    let coming = s.data.extra.agents.upcoming().count();
    list = list.child(
        side_row(t, s.reminders_open)
            .key("agent-row/reminders")
            .role("button")
            .label("Reminders")
            .child(ico("bell", t.dim))
            .child(name_and_line(t, "Reminders", None, 400.0))
            .children((coming > 0).then(|| text(coming.to_string()).font(crate::theme::tabular(12.0, 500.0)).color(t.faint).pr(4.0)))
            .on_press(|s: &mut App| s.open_reminders()),
    );

    if let Some(w) = s.data.agent("wisp") {
        let line = s.data.chat(&w.name).map(|c| c.preview.clone()).filter(|p| !p.is_empty()).unwrap_or_else(|| w.status.clone());
        list = list.child(
            side_row(t, s.agent.as_deref() == Some("wisp"))
                .key("agent-row/wisp")
                .role("button")
                .label(w.name.clone())
                .child(bot::agent(&awake(w), 32.0))
                .child(name_and_line(t, &w.name, Some(&line), 500.0))
                .on_press_tx(|s: &mut App, tx| { tx.settle(); s.open_agent(Some("wisp")) }),
        );
    }

    list = list.child(sec(t, None, "Team", false));
    let helpers = s.data.team.iter().filter(|a| a.id != "wisp" && a.state != AgentState::Walking);
    for (i, a) in helpers.enumerate() {
        let (id, more_id) = (a.id.clone(), a.id.clone());
        let open = s.appearance.as_deref() == Some(a.id.as_str());
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
            .child(bot::agent(&awake(a), 32.0))
            .child(match s.data.extra.agents.health_of(&a.id) {
                Some(h) => col().grow(1.0).min_w(0.0)
                    .child(text(a.name.clone()).font(ui(14.0, 400.0)).color(t.text).truncate())
                    .child(text(h.line()).font(ui(12.0, 400.0)).color(health_ink(t, h)).truncate()),
                None => name_and_line(t, &a.name, Some(&a.status), 400.0),
            })
            // Always on, as the phone marks it: its jobs run with the PC off.
            .children(s.data.extra.agents.spec(&a.id).filter(|x| x.always_on).map(|_| {
                el().key(format!("always-dot/{}", a.id)).size(7.0, 7.0).radius(3.5).fill(t.green).help("Always on: its jobs run even with your PC off")
            }))
            .child(more)
            .on_press_tx(move |s: &mut App, tx| { tx.settle(); s.open_agent(Some(&id)) });
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
                .child(match s.data.extra.agents.job_health(&l.id) {
                    Some(h) => col().grow(1.0).min_w(0.0)
                        .child(text(l.name.clone()).font(ui(14.0, 400.0)).color(t.text).truncate())
                        .child(text(format!("{who} · {}", h.line())).font(ui(12.0, 400.0)).color(health_ink(t, h)).truncate()),
                    None => name_and_line(t, &l.name, Some(&who), 400.0),
                })
                .on_press_tx(move |s: &mut App, tx| { tx.settle(); s.open_agent(Some(&agent)) }),
        );
    }

    col().h_full().min_h(0.0)
        .child(side_head(t, "Agents", None).child(crate::ui::ibtn(t, "plus", "New agent").key("agent-new")
            .on_press(|s: &mut App| s.open_team_dialog(crate::team::TeamDialog::NewAgent))))
        .child(col().grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(list))
        .child(me(s, t))
}

/// This view has no menus of its own yet.
pub fn menu(_s: &App, _t: &Theme, _id: &str) -> Option<El> {
    None
}

// ---------- main ----------

pub fn main(s: &App, t: &Theme, _cx: &mut Cx<App>) -> El {
    if s.reminders_open {
        return crate::views::reminders::page(s, t);
    }
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

fn mission(s: &App, t: &Theme) -> El {
    let hello = if s.data.user.is_empty() { greeting().to_owned() } else { format!("{}, {}", greeting(), s.data.user) };
    let head = col().w_full().items_center().gap(12.0).pb(28.0)
        .child(bot::agent(&awake(s.data.agent("wisp").unwrap_or(&s.data.team[0])), 64.0))
        .child(text(hello).font(ui(28.0, 600.0).tracking(-0.3)).color(t.text));

    let mut body = col().w_full().max_w(720.0).px(24.0).gap(0.0)
        .child(head)
        .child(composer(s, t, EditKey::Mission, Target::Wisp, "Give Wisp a task. It hands work to the right agent.", false, false));

    // Only what needs you, then the last few things that happened: nothing else.
    let needs: Vec<&Task> = s.data.tasks.iter().filter(|(k, _)| *k == Column::NeedsYou).map(|(_, x)| x).collect();
    if !needs.is_empty() {
        body = body.child(row().px(10.0).pt(26.0).pb(6.0).child(text("Needs you").font(ui(12.5, 600.0)).color(t.faint)));
        for (i, task) in needs.iter().enumerate() {
            body = body.child(enter(task_row(s, t, "needs", i, task), i));
        }
    }
    // Background runs that stopped to ask you something (a job's sign-in, a yes it waited for).
    let stuck: Vec<&crate::agentsync::Health> = s.data.extra.agents.health.iter().filter(|h| h.needs_you()).take(4).collect();
    if !stuck.is_empty() {
        if needs.is_empty() {
            body = body.child(row().px(10.0).pt(26.0).pb(6.0).child(text("Needs you").font(ui(12.5, 600.0)).color(t.faint)));
        }
        for (i, h) in stuck.into_iter().enumerate() {
            body = body.child(enter(health_row(s, t, i, h), i));
        }
    }
    let recent: Vec<&Task> = s.data.tasks.iter().filter(|(k, _)| *k != Column::NeedsYou).map(|(_, x)| x).take(3).collect();
    if !recent.is_empty() {
        body = body.child(row().px(10.0).pt(26.0).pb(6.0).child(text("Recent").font(ui(12.5, 600.0)).color(t.faint)));
        for (i, task) in recent.into_iter().enumerate() {
            body = body.child(enter(task_row(s, t, "recent", i, task), i));
        }
    }
    col().key("mission").w_full().h_full().items_center().justify_center().scroll(ScrollSpec { stick_bottom: false }).child(body.py(48.0))
}

/// The colour of a health line: amber while it needs you or didn't finish, else quiet.
pub fn health_ink(t: &Theme, h: &crate::agentsync::Health) -> Color {
    match h.state.as_str() {
        "needs_you" | "failed" => t.warn,
        _ => t.faint,
    }
}

/// A run that needs you, on Mission control: whose, what it says, and its chat.
fn health_row(s: &App, t: &Theme, i: usize, h: &crate::agentsync::Health) -> El {
    let agent = h.agent.clone();
    let name = s.data.agent(&h.agent).map_or_else(|| h.agent.clone(), |a| a.name.clone());
    let job = h.run.strip_prefix("job:").and_then(|id| s.data.extra.loops.iter().find(|l| l.id == id)).map(|l| l.name.clone());
    row().key(format!("health/{i}")).w_full().min_h(48.0).px(10.0).py(8.0).gap(12.0).radius(10.0).center_y().hover(t.hover)
        .role("button").label(format!("{name} needs you"))
        .children(s.data.agent(&h.agent).map(|a| bot::agent(&awake(a), 28.0)))
        .child(col().grow(1.0).min_w(0.0).gap(2.0)
            .child(text(job.unwrap_or_else(|| format!("{name} needs you"))).font(ui(14.0, 500.0)).color(t.text).truncate())
            .child(text(h.line()).font(ui(12.5, 400.0)).color(t.warn).truncate()))
        .child(ico_s(h.icon(), 16.0, t.warn))
        .on_press_tx(move |s: &mut App, tx| { tx.settle(); s.open_agent(Some(&agent)) })
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
        .children(s.data.agent(&task.agent).map(|a| bot::agent(&awake(a), 28.0)))
        .child(middle)
        .child(buttons)
        .on_press_tx(move |s: &mut App, tx| { tx.settle(); s.open_agent(Some(&agent)) })
}

// ---------- an agent ----------

/// An agent's sessions, newest first: its own chat, the tasks Wisp handed it, its loops' runs.
pub fn sessions_of<'a>(s: &'a App, a: &Agent) -> Vec<&'a crate::model::ChatMeta> {
    s.data.extra.chats.iter().filter(|c| c.kind == crate::model::ChatKind::Agent(a.id.clone())).collect()
}

/// The session the agent's page shows: the one you picked, else its newest, else its own chat
/// (made by your first message). Empty: a new session, named by your next message.
pub fn open_session(s: &App, a: &Agent) -> String {
    match s.agent_session.get(&a.id) {
        Some(t) => t.clone(),
        None => sessions_of(s, a).first().map_or_else(|| a.name.clone(), |c| c.title.clone()),
    }
}

/// A session's name without the agent's in front ("Frontend: Restyle the app" reads "Restyle the app").
fn session_label(a: &Agent, title: &str) -> String {
    title.strip_prefix(&format!("{}: ", a.name)).map_or_else(|| title.to_owned(), str::to_owned)
}

fn agent_page(s: &App, t: &Theme, a: &Agent) -> El {
    let open = open_session(s, a);
    let shown = if open.is_empty() { "New session".to_owned() } else if open == a.name { String::new() } else { session_label(a, &open) };
    let head = row().gap(10.0).px(24.0).h(52.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.border)
        .child(bot::agent(&awake(a), 26.0))
        .child(text(a.name.clone()).font(ui(14.5, 600.0)).color(t.text))
        .child(text(if shown.is_empty() { a.role.clone() } else { shown }).font(ui(13.0, 400.0)).color(t.dim).truncate().min_w(0.0));
    // A new session's transcript is empty until you send; its title comes from what you send.
    let chat = if open.is_empty() { format!("\u{0}new/{}", a.id) } else { open.clone() };
    let target = Target::AgentSession { agent: a.id.clone(), title: open };
    let thread = crate::views::upgrade::with_composer(s, t, &chat, &a.name, EditKey::AgentThread, target, &format!("Message {}", a.name), 760.0);
    let centre = col().grow(1.0).min_w(0.0).h_full()
        .child(head)
        .child(el().w_full().grow(1.0).min_h(0.0).child(thread));
    row().key(format!("agent-page/{}", a.id)).w_full().h_full().child(centre).child(panel(s, t, a))
}

/// A loop's small action (Run now, Delete): quiet until the row is hovered.
fn small_btn(t: &Theme, icon: &str, label: &str) -> El {
    el().size(24.0, 24.0).radius(6.0).center().hover(t.active).role("button").label(label.to_owned()).help(label.to_owned())
        .group_opacity(0.35, 1.0)
        .child(ico_s(icon, 14.0, t.dim))
}

/// Where a loop runs: on this PC while Codeply is open, or (Always on) in the cloud too.
fn runs_where(s: &App, a: &Agent, job: &str) -> String {
    let running = s.data.extra.agents.jobs.iter().any(|(id, on, _)| id == job && *on);
    if running {
        return "Running now on this PC".into();
    }
    if a.id == "wisp" {
        return "Only while Codeply is open".into();
    }
    match s.data.extra.agents.spec(&a.id) {
        Some(sp) if sp.always_on => "On your PC, or in the cloud".into(),
        _ => "Only while Codeply is open".into(),
    }
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
    let computer = card(t).w_full().px(14.0).py(12.0).child(
        row().gap(12.0).center_y()
            .child(el().size(44.0, 44.0).radius(11.0).fill(t.hover).center().child(bot::agent(a, 34.0)))
            .child(col().grow(1.0).min_w(0.0).gap(2.0)
                .child(text(format!("{}'s computer", a.name)).font(ui(13.5, 500.0)).color(t.text).truncate())
                .child(match s.data.extra.agents.health_of(&a.id) {
                    Some(h) => row().gap(5.0).center_y().min_w(0.0)
                        .child(ico_s(h.icon(), 13.0, health_ink(t, h)))
                        .child(text(h.line()).font(ui(12.5, 400.0)).color(if h.needs_you() { t.warn } else { t.dim }).truncate().min_w(0.0)),
                    None => row().child(text(state_word(a.state).to_owned()).font(ui(12.5, 400.0)).color(t.dim)),
                })),
    );

    // Sessions: this agent's own, newest first. Five show; the rest scroll.
    let open = open_session(s, a);
    let mine = sessions_of(s, a);
    let mut session_list = col().w_full().gap(2.0);
    if mine.is_empty() {
        session_list = session_list.child(text("No sessions yet. Send a message to start one.").font(ui(13.0, 400.0)).color(t.faint).wrap().px(8.0).py(6.0));
    }
    for c in mine {
        let (pick, gone, agent, agent2) = (c.title.clone(), c.title.clone(), a.id.clone(), a.id.clone());
        let on = c.title == open;
        let status = if c.running {
            Some(ico_s("history", 14.0, t.dim).help("Working"))
        } else if c.unread {
            Some(el().size(6.0, 6.0).radius(3.0).fill(t.accent))
        } else {
            None
        };
        session_list = session_list.child(
            row().key(format!("session/{}", c.title)).hover_group().w_full().h(36.0).px(8.0).gap(10.0).radius(8.0).center_y()
                .fill(if on { t.active } else { rune::Color::TRANSPARENT }).hover(t.hover)
                .role("button").label(c.title.clone()).help(c.title.clone())
                .child(ico_s("chat", 16.0, t.dim))
                .child(text(session_label(a, &c.title)).font(ui(13.5, if on { 500.0 } else { 400.0 })).color(t.text).truncate().grow(1.0).min_w(0.0))
                .children(status)
                .child(text(c.ago.clone()).font(ui(12.0, 400.0)).color(t.faint))
                .child(el().key(format!("session-delete/{}", c.title)).size(22.0, 22.0).radius(6.0).center().hover(t.active).role("button").label("Delete session").help("Delete")
                    .group_opacity(0.0, 1.0)
                    .child(ico_s("trash", 13.0, t.dim))
                    .on_press(move |s: &mut App| {
                        s.delete_chat(&gone);
                        s.agent_session.remove(&agent2);
                    }))
                .on_press_tx(move |s: &mut App, tx| { tx.settle(); s.open_agent_session(&agent, &pick) }),
        );
    }
    let new_session = {
        let id = a.id.clone();
        crate::ui::ibtn(t, "plus", "New session").key(format!("session-new/{}", a.id))
            .on_press_tx(move |s: &mut App, tx| { tx.settle(); s.open_agent_session(&id, ""); tx.focus("composer-agent-thread", false); })
    };
    // Five rows high; more scroll.
    let sessions = col().key(format!("sessions/{}", a.id)).w_full().max_h(5.0 * 38.0).scroll(ScrollSpec { stick_bottom: false }).child(session_list);

    let mut loops = col().w_full().gap(4.0);
    let mine: Vec<_> = s.data.extra.loops.iter().filter(|l| l.agent == a.id).collect();
    if mine.is_empty() {
        loops = loops.child(text("No loops yet.").font(ui(13.0, 400.0)).color(t.faint).px(8.0).py(6.0));
    }
    for l in mine {
        let (agent, name) = (a.id.clone(), l.name.clone());
        loops = loops.child(
            row().w_full().hover_group().px(8.0).py(8.0).gap(4.0).radius(8.0).center_y().hover(t.hover)
                .child(col().grow(1.0).min_w(0.0).gap(4.0).mr(4.0)
                    .child(text(l.name.clone()).font(ui(13.5, 400.0)).color(t.text).truncate())
                    .child(match s.data.extra.agents.job_health(&l.id) {
                        Some(h) => text(h.line()).font(ui(12.0, 400.0)).color(health_ink(t, h)).truncate().min_w(0.0),
                        None => text(l.last.clone()).font(ui(12.0, 400.0)).color(t.faint).truncate().min_w(0.0),
                    })
                    .child(text(runs_where(s, a, &l.id)).font(ui(11.5, 400.0)).color(t.faint).truncate().min_w(0.0)))
                .child({
                    let id = l.id.clone();
                    small_btn(t, "arrow-right", "Run now").key(format!("loop-run/{}", l.id)).on_press_tx(move |s: &mut App, tx| { tx.settle(); s.run_loop(&id) })
                })
                .child({
                    let id = l.id.clone();
                    small_btn(t, "trash", "Delete loop").key(format!("loop-delete/{}", l.id)).on_press(move |s: &mut App| s.cancel_loop(&id))
                })
                .child(toggle(t, format!("loop/{}/{}", a.id, l.name), l.on, &l.name)
                    .on_press(move |s: &mut App| s.toggle_loop(&agent, &name))),
        );
    }
    let create = row().key(format!("loop-new/{}", a.id)).w_full().min_h(34.0).px(8.0).gap(10.0).radius(8.0).center_y().hover(t.hover)
        .role("button").label("Create a loop")
        .child(ico_s("plus", 16.0, t.faint))
        .child(text("Create a loop").font(ui(13.5, 400.0)).color(t.dim))
        .on_press({
            let id = a.id.clone();
            move |s: &mut App| s.open_team_dialog(crate::team::TeamDialog::NewLoop(id.clone()))
        });

    // Always on (the phone's switch): its jobs run on time with the PC off, in the cloud.
    let spec = s.data.extra.agents.spec(&a.id);
    let always = (a.id != "wisp" && spec.is_some()).then(|| {
        let on = spec.is_some_and(|x| x.always_on);
        let id = a.id.clone();
        let copy = if on { "On duty around the clock: its jobs run on time even with your PC off." } else { "Off: its jobs wait until Codeply is open on your PC." };
        card(t).w_full().px(14.0).py(12.0).mt(10.0).child(row().gap(12.0).center_y()
            .child(col().grow(1.0).min_w(0.0).gap(2.0)
                .child(text("Always on").font(ui(13.5, 500.0)).color(t.text))
                .child(text(copy).font(ui(12.0, 400.0)).color(t.faint).wrap()))
            .child(toggle(t, format!("always-on/{}", a.id), on, "Always on")
                .on_press(move |s: &mut App| s.set_always_on(&id, !on))))
    });
    // Edit once the account's record is here (before, a built-in one would look like yours).
    let edit = (a.id != "wisp" && spec.is_some()).then(|| {
        let id = a.id.clone();
        btn(t, "Edit", Some("edit"), ButtonKind::Plain).key(format!("spec-edit/{}", a.id)).mt(12.0)
            .on_press(move |s: &mut App| s.open_team_dialog(crate::team::TeamDialog::Edit(id.clone())))
    });

    // Its standing jobs' reports, newest first (they land in the job's chat too).
    let mine: Vec<&crate::agentsync::Report> = s.data.extra.agents.reports.iter().filter(|r| !r.reminder && (r.who.eq_ignore_ascii_case(&a.name) || r.who == a.id)).take(5).collect();
    let reports = (!mine.is_empty()).then(|| {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        col().w_full().gap(2.0).children(mine.into_iter().enumerate().map(|(i, r)| {
            let chat = r.chat.clone();
            let place = if r.origin.is_empty() { String::new() } else { format!(" · {}", r.origin) };
            row().key(format!("report/{}/{i}", a.id)).w_full().px(8.0).py(7.0).gap(10.0).radius(8.0).center_y().hover(t.hover)
                .role("button").label(r.text.clone())
                .child(ico_s(if r.ok { "check" } else { "alert" }, 15.0, if r.ok { t.green } else { t.warn }))
                .child(col().grow(1.0).min_w(0.0).gap(1.0)
                    .child(text(r.text.lines().find(|l| !l.trim().is_empty() && !l.starts_with("-# ")).unwrap_or_default().to_owned()).font(ui(13.0, 400.0)).color(t.text).truncate())
                    .child(text(format!("{}{place}", crate::agentsync::ago(r.at, now))).font(ui(11.5, 400.0)).color(t.faint)))
                .on_press(move |s: &mut App| if !chat.is_empty() { s.open_chat(&chat) })
        }))
    });

    let has_loops = s.data.extra.loops.iter().any(|l| l.agent == a.id);
    let body = col().w_full().padding(20.0).gap(0.0).items_center()
        .child(bot::agent(&awake(a), 80.0))
        .child(text(a.name.clone()).font(ui(18.0, 650.0)).color(t.text).mt(12.0))
        .child(text(a.role.clone()).font(ui(13.0, 400.0)).color(t.dim).wrap().mt(2.0))
        .children(edit)
        .child(el().w_full().mt(20.0).child(computer))
        .children(always)
        .child(row().w_full().pt(16.0).pb(4.0).center_y().child(label(t, "Sessions")).child(el().grow(1.0)).child(new_session))
        .child(sessions)
        .child(col().w_full().pt(22.0).pb(8.0).child(label(t, "Loops")))
        .child(loops)
        .child(el().w_full().mt(4.0).child(create))
        .children(reports.map(|r| col().w_full().child(col().w_full().pt(22.0).pb(8.0).child(label(t, "Recent reports"))).child(r)))
        .children(if has_loops { crate::views::reminders::notifications_off(s, t, "job reports") } else { None }.map(|n| el().w_full().mt(14.0).child(n)));

    col().key("agent-panel").w(320.0).h_full().border_sides([0.0, 0.0, 0.0, 1.0], t.border)
        .scroll(ScrollSpec { stick_bottom: false }).child(body)
}
