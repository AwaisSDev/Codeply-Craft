//! The background tasks pane: the open chat's subagents (big mascots and names; one opens into
//! its live log with a typing bar, and a team into its shared channel), then helpers Wisp handed
//! work to and commands left running.

use rune::{El, ScrollSpec, col, el, row, text, text_input};

use crate::app::{App, EditKey, Pane};
use crate::bot;
use crate::icons::ico_s;
use crate::subagents::{Line, Subagent, Team};
use crate::theme::{Theme, mono, ui};
use crate::ui::{ibtn, wave};
use crate::views::agents::awake;

/// Mascot sizes: the list's rows, and the small faces in a team channel.
const BIG: f32 = 40.0;
const SMALL: f32 = 18.0;

pub fn pane(s: &App, t: &Theme) -> El {
    let header = row().w_full().h(38.0).px(12.0).gap(6.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.border)
        .child(text("Background tasks").font(ui(13.0, 600.0)).color(t.text))
        .child(el().grow(1.0).min_w(0.0))
        .child(ibtn(t, "trash", "Clear finished").key("tasks-clear").on_press(|s: &mut App| s.data.extra.bg_tasks.retain(|b| b.running)))
        .child(ibtn(t, "close", "Close tasks").key("tasks-close").on_press(|s: &mut App| s.toggle_pane(Pane::Tasks)));

    let chat = s.chat.clone().unwrap_or_default();
    let mine: Vec<&Subagent> = s.data.extra.subagents.in_chat(&chat).collect();
    let mut body = col().w_full().px(8.0).py(8.0).gap(2.0);
    if !mine.is_empty() {
        body = body.child(subagents(s, t, &mine));
    }

    let mut list = col().w_full().gap(4.0);
    for task in &s.data.extra.bg_tasks {
        // The engine names the agent ("Frontend"); the team knows it by id too.
        let agent = task.agent.as_deref().and_then(|n| s.data.agent(n).or_else(|| s.data.team.iter().find(|a| a.name.eq_ignore_ascii_case(n))));
        let icon = match agent {
            Some(a) if task.kind == "agent" => bot::agent(&awake(a), 26.0),
            _ => el().size(26.0, 26.0).radius(7.0).fill(t.hover).center().child(ico_s("terminal", 14.0, t.dim)),
        };
        let status = if task.running {
            text("Working").font(ui(12.0, 500.0)).color(t.accent)
        } else {
            text("Done").font(ui(12.0, 400.0)).color(t.faint)
        };
        let info = col().grow(1.0).min_w(0.0).gap(2.0)
            .child(text(task.title.clone()).font(ui(13.5, 500.0)).color(t.text).single_line().truncate())
            .children((!task.detail.is_empty()).then(|| text(task.detail.clone()).font(ui(12.0, 400.0)).color(t.dim).single_line().truncate()))
            .child(status);
        let id = task.id.clone();
        let stop = task.running.then(|| el().key(format!("task-stop/{}", task.id)).size(26.0, 26.0).radius(7.0).center().hover(t.active)
            .role("button").label("Stop").help("Stop")
            .child(el().size(9.0, 9.0).radius(2.0).fill(t.dim))
            .on_press(move |s: &mut App| s.kill_task(&id)));
        // An agent's task opens its session on the agent's page.
        let open = agent.map(|a| (a.id.clone(), task.title.clone()));
        list = list.child(row().key(format!("task/{}", task.id)).w_full().px(8.0).py(8.0).gap(10.0).radius(10.0).items_start().hover(t.hover)
            .role("button").label(task.title.clone()).help(task.title.clone())
            .child(icon)
            .child(info)
            .children(stop)
            .on_press(move |s: &mut App| if let Some((id, title)) = &open {
                s.open_agent(Some(id));
                if s.data.extra.chats.iter().any(|c| c.title == *title) {
                    s.open_agent_session(id, title);
                }
            }));
    }
    if !s.data.extra.bg_tasks.is_empty() {
        if !mine.is_empty() {
            body = body.child(section_label(t, "Tasks", None));
        }
        body = body.child(list);
    } else if mine.is_empty() {
        body = body.child(col().w_full().py(40.0).center()
            .child(text("Nothing running in the background.").font(ui(13.0, 400.0)).color(t.faint)));
    }

    // A log or a channel needs room: the column widens while one is open.
    let open = s.sub_open.as_ref().is_some_and(|id| mine.iter().any(|a| a.id == *id)) || s.team_open.is_some();
    col().key("tasks-pane").w(if open { 420.0 } else { 300.0 }).h_full().min_h(0.0).fill(t.bg).border_sides([0.0, 0.0, 0.0, 1.0], t.border)
        .child(header)
        .child(col().grow(1.0).min_h(0.0).w_full().scroll(ScrollSpec { stick_bottom: false }).child(body))
}

fn section_label(t: &Theme, label: &str, count: Option<usize>) -> El {
    row().w_full().h(28.0).px(8.0).gap(6.0).center_y()
        .child(text(label.to_owned()).font(ui(12.0, 600.0)).color(t.dim))
        .children(count.map(|n| text(n.to_string()).font(ui(12.0, 500.0)).color(t.faint)))
}

/// "Subagents": a fold-down list of the chat's agents, and each team's channel.
fn subagents(s: &App, t: &Theme, mine: &[&Subagent]) -> El {
    let working = mine.iter().filter(|a| a.working()).count();
    let head = row().key("subagents-fold").w_full().h(30.0).px(8.0).gap(6.0).radius(8.0).center_y().hover(t.hover)
        .role("button").label(if s.sub_folded { "Show subagents" } else { "Hide subagents" })
        .child(ico_s(if s.sub_folded { "chevron-right" } else { "chevron-down" }, 14.0, t.dim))
        .child(text("Subagents").font(ui(12.5, 600.0)).color(t.text))
        .child(text(if working > 0 { format!("{working} working") } else { mine.len().to_string() }).font(ui(12.0, 500.0)).color(if working > 0 { t.accent } else { t.faint }))
        .on_press(|s: &mut App| s.sub_folded = !s.sub_folded);
    let mut out = col().key("subagents").w_full().gap(2.0).pb(8.0).child(head);
    if s.sub_folded {
        return out;
    }
    // Newest first, so the agents just started are on top.
    for a in mine.iter().rev() {
        out = out.child(agent_row(s, t, a));
        if s.sub_open.as_deref() == Some(a.id.as_str()) {
            out = out.child(agent_log(s, t, a));
        }
    }
    let mut teams: Vec<&Team> = Vec::new();
    for a in mine {
        if let Some(team) = s.data.extra.subagents.team(&a.swarm)
            && !teams.iter().any(|x| x.id == team.id)
        {
            teams.push(team);
        }
    }
    for team in teams {
        out = out.child(team_row(s, t, team));
        if s.team_open.as_deref() == Some(team.id.as_str()) {
            out = out.child(team_channel(s, t, team));
        }
    }
    out
}

/// One agent: its mascot, name and what it's on; Stop while it works, then how it ended.
fn agent_row(s: &App, t: &Theme, a: &Subagent) -> El {
    let open = s.sub_open.as_deref() == Some(a.id.as_str());
    let id = a.id.clone();
    let mut info = col().grow(1.0).min_w(0.0).gap(1.0)
        .child(row().gap(6.0).center_y()
            .child(text(a.name.clone()).font(ui(14.0, 600.0)).color(t.text).truncate().shrink().min_w(0.0))
            .children(a.browser.then(|| ico_s("globe", 12.0, t.faint))))
        .child(text(a.task.clone()).font(ui(12.0, 400.0)).color(t.dim).truncate());
    info = info.child(if a.working() {
        wave(&a.now(), ui(12.0, 500.0), crate::theme::hex(&a.color))
    } else {
        text(a.now()).font(ui(12.0, 500.0)).color(if a.status == "failed" { t.red } else { t.faint }).truncate()
    });
    let end = if a.working() {
        let stop = a.id.clone();
        ibtn(t, "stop", &format!("Stop {}", a.name)).key(format!("subagent-stop/{}", a.id)).on_press(move |s: &mut App| s.agents_op(crate::subagents::Op::Stop(stop.clone())))
    } else {
        let gone = a.id.clone();
        ibtn(t, "close", &format!("Remove {}", a.name)).key(format!("subagent-remove/{}", a.id)).on_press(move |s: &mut App| s.agents_op(crate::subagents::Op::Remove(gone.clone())))
    };
    row().key(format!("subagent/{}", a.id)).w_full().min_h(58.0).px(8.0).py(8.0).gap(12.0).radius(12.0).center_y()
        .fill(if open { t.active } else { rune::Color::TRANSPARENT }).hover(t.hover)
        .role("button").label(format!("{}: {}", a.name, a.now()))
        .child(bot::mascot(&a.color, &a.look, a.state(), BIG))
        .child(info)
        .child(end)
        .on_press(move |s: &mut App| s.toggle_subagent(&id))
}

/// What one log line looks like: its words, its step, or how the round ended.
fn log_line(t: &Theme, a: &Subagent, i: usize, l: &Line) -> El {
    let key = format!("sublog/{}/{i}", a.id);
    let say = |s: String, c| text(s).font(ui(12.5, 400.0)).color(c).wrap().selectable(true).grow(1.0).min_w(0.0);
    match l.kind.as_str() {
        "user" => {
            let who = if l.by == "you" { "You" } else { "Codeply" };
            let tag = if l.live { " · while working" } else { "" };
            col().key(key).w_full().px(10.0).py(6.0).gap(2.0).radius(8.0).fill(t.hover)
                .child(text(format!("{who}{tag}")).font(ui(11.0, 600.0)).color(t.faint))
                .child(say(l.text.clone(), t.text))
        }
        "text" => row().key(key).w_full().gap(8.0).child(el().w(6.0).h(6.0).mt(7.0).radius(3.0).fill(crate::theme::hex(&a.color))).child(say(l.text.clone(), t.text)),
        "think" => row().key(key).w_full().child(text("Thinking…").font(ui(12.0, 400.0)).color(t.faint)),
        "tool" => {
            let (mark, color) = match l.status.as_str() {
                "ok" => ("check", t.green),
                "fail" => ("close", t.red),
                _ => ("dot", t.accent),
            };
            let mut c = col().key(key).w_full().gap(2.0)
                .child(row().w_full().gap(6.0).center_y()
                    .child(if mark == "dot" { el().size(12.0, 12.0).center().child(el().size(6.0, 6.0).radius(3.0).fill(color)) } else { ico_s(mark, 12.0, color) })
                    .child(text(l.name.clone()).font(ui(12.5, 600.0)).color(t.text))
                    .child(text(l.arg.clone()).font(mono(12.0, 17.0)).color(t.dim).truncate().shrink().min_w(0.0)));
            if !l.out.is_empty() && l.status == "fail" {
                c = c.child(text(l.out.clone()).font(mono(11.5, 16.0)).color(t.faint).wrap().pl(18.0));
            }
            c
        }
        "done" => {
            let head = if l.ok { "Done" } else if l.text == "stopped" { "Stopped" } else { "Did not finish" };
            let files = if l.files.is_empty() { String::new() } else { format!(" · {} file{}", l.files.len(), if l.files.len() == 1 { "" } else { "s" }) };
            col().key(key).w_full().px(10.0).py(6.0).gap(2.0).radius(8.0).border(1.0, if l.ok { t.green.alpha(0.5) } else { t.border })
                .child(text(format!("{head}{files}")).font(ui(12.0, 600.0)).color(if l.ok { t.green } else { t.dim }))
                .children((!l.ok && !l.text.is_empty() && l.text != "stopped").then(|| say(l.text.clone(), t.dim)))
        }
        _ => row().key(key).w_full().child(text(l.text.clone()).font(ui(12.0, 400.0)).color(t.faint).wrap()),
    }
}

/// An open agent: its live log, and a bar to message it (while it works, or its next round).
fn agent_log(s: &App, t: &Theme, a: &Subagent) -> El {
    let lines = a.log.iter().enumerate().filter(|(_, l)| !l.kind.is_empty()).map(|(i, l)| log_line(t, a, i, l));
    let screen = col().key(format!("sublog/{}", a.id)).w_full().max_h(380.0).scroll(ScrollSpec { stick_bottom: true })
        .child(col().w_full().px(10.0).py(10.0).gap(8.0).children(lines));
    let placeholder = if a.working() { format!("Message {} while it works", a.name) } else { format!("Send {} another round", a.name) };
    let input = text_input(s.edit(EditKey::Subagent), ui(13.0, 400.0)).key(format!("subagent-input/{}", a.id)).single_line().grow(1.0).min_w(0.0)
        .color(t.text).placeholder(placeholder.clone(), t.faint).caret(t.accent, t.accent.alpha(0.3)).label(placeholder)
        .on_edit(|s: &mut App| s.edit_mut(EditKey::Subagent))
        .on_submit(|s: &mut App, _| s.send_subagent());
    let bar = row().w_full().px(8.0).py(6.0).gap(6.0).center_y().border_sides([1.0, 0.0, 0.0, 0.0], t.border)
        .child(input)
        .child(ibtn(t, "arrow-up", "Send").key(format!("subagent-send/{}", a.id)).on_press(|s: &mut App| s.send_subagent()));
    col().key(format!("subagent-view/{}", a.id)).w_full().mb(6.0).radius(12.0).clip_rounded(12.0).fill(t.pane).border(1.0, t.border)
        .child(screen)
        .child(bar)
}

/// A team: its members' faces and the newest message on its channel.
fn team_row(s: &App, t: &Theme, team: &Team) -> El {
    let open = s.team_open.as_deref() == Some(team.id.as_str());
    let id = team.id.clone();
    let faces = row().gap(-4.0).children(team.members.iter().filter_map(|m| s.data.extra.subagents.agent(m)).map(|a| bot::mascot(&a.color, &a.look, a.state(), 20.0)));
    let last = team.messages.last().map(|m| format!("{}: {}", m.from, m.text)).unwrap_or_else(|| "No messages yet".into());
    row().key(format!("team/{}", team.id)).w_full().min_h(48.0).px(8.0).py(6.0).gap(10.0).radius(12.0).center_y()
        .fill(if open { t.active } else { rune::Color::TRANSPARENT }).hover(t.hover).role("button").label("Team channel")
        .child(el().size(BIG, BIG).radius(BIG / 2.0).center().fill(t.hover).child(ico_s("users", 18.0, t.dim)))
        .child(col().grow(1.0).min_w(0.0).gap(2.0)
            .child(row().gap(8.0).center_y().child(text("Team channel").font(ui(13.5, 600.0)).color(t.text)).child(faces))
            .child(text(last).font(ui(12.0, 400.0)).color(t.dim).truncate()))
        .on_press(move |s: &mut App| s.toggle_team(&id))
}

/// A team's shared channel: who said what (to whom), and a bar for you to post on it.
fn team_channel(s: &App, t: &Theme, team: &Team) -> El {
    let face = |name: &str| -> El {
        match s.data.extra.subagents.agents.iter().find(|a| a.name == name && team.members.contains(&a.id)) {
            Some(a) => bot::mascot(&a.color, &a.look, a.state(), SMALL),
            None if name == "You" => el().size(SMALL, SMALL).radius(SMALL / 2.0).center().fill(t.hover).child(ico_s("users", 11.0, t.dim)),
            None => bot::wisp(SMALL),
        }
    };
    let lines = team.messages.iter().enumerate().map(|(i, m)| {
        row().key(format!("team-msg/{}/{i}", team.id)).w_full().gap(8.0)
            .child(el().pt(1.0).child(face(&m.from)))
            .child(col().grow(1.0).min_w(0.0).gap(1.0)
                .child(text(if m.to.is_empty() { m.from.clone() } else { format!("{} → {}", m.from, m.to) }).font(ui(11.5, 600.0)).color(t.faint))
                .child(text(m.text.clone()).font(ui(12.5, 400.0)).color(t.text).wrap().selectable(true)))
    });
    let screen = col().w_full().max_h(380.0).scroll(ScrollSpec { stick_bottom: true })
        .child(col().w_full().px(10.0).py(10.0).gap(10.0).children(lines));
    let input = text_input(s.edit(EditKey::TeamPost), ui(13.0, 400.0)).key(format!("team-input/{}", team.id)).single_line().grow(1.0).min_w(0.0)
        .color(t.text).placeholder("Message the whole team", t.faint).caret(t.accent, t.accent.alpha(0.3)).label("Message the team")
        .on_edit(|s: &mut App| s.edit_mut(EditKey::TeamPost))
        .on_submit(|s: &mut App, _| s.post_team());
    col().key(format!("team-view/{}", team.id)).w_full().mb(6.0).radius(12.0).clip_rounded(12.0).fill(t.pane).border(1.0, t.border)
        .child(screen)
        .child(row().w_full().px(8.0).py(6.0).gap(6.0).center_y().border_sides([1.0, 0.0, 0.0, 0.0], t.border)
            .child(input)
            .child(ibtn(t, "arrow-up", "Post").key(format!("team-send/{}", team.id)).on_press(|s: &mut App| s.post_team())))
}
