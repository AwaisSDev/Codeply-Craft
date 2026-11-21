//! A conversation, as both Chat and an agent's page show it (Codex-style): your messages in
//! bubbles on the right, replies as Markdown on the left (fading in word by word while they
//! stream), tool calls folded into one "Worked on N steps" line you can open, and approvals as
//! cards with their three answers.

use rune::{El, ScrollSpec, col, el, row, text};

use crate::app::{App, EditKey};
use crate::bot;
use crate::icons::ico_s;
use crate::markdown;
use crate::model::{ButtonKind, ThreadItem};
use crate::store::Target;
use crate::theme::{self, Theme, ui};
use crate::ui::{btn, composer, enter, rich_text};

/// The transcript of `chat` (by title) as a column `width` wide at most. `who` names the
/// agent that replies (shown while it's thinking).
pub fn transcript(s: &App, t: &Theme, chat: &str, who: &str, width: f32) -> El {
    let items = s.data.thread(chat);
    let running = s.data.is_running(chat);
    let mut body = col().w_full().max_w(width).px(24.0).pt(24.0).pb(170.0).gap(4.0);
    if items.is_empty() && !running {
        body = body.child(col().w_full().pt(60.0).items_center().gap(8.0)
            .child(text(format!("Nothing here yet. Ask {who} something.")).font(ui(14.0, 400.0)).color(t.faint)));
    }
    // The last reply is the one streaming, while the chat runs.
    let streaming_at = if running { items.iter().rposition(|i| matches!(i, ThreadItem::Them(_))) } else { None };
    let mut i = 0;
    let mut n = 0;
    while i < items.len() {
        // Consecutive tool calls fold into one line, unless Settings says show them.
        if matches!(items[i], ThreadItem::Event { .. }) && !s.prefs.show_tools {
            let start = i;
            while i < items.len() && matches!(items[i], ThreadItem::Event { .. }) {
                i += 1;
            }
            body = body.child(enter(steps(s, t, chat, start, &items[start..i], running && i == items.len()), n));
            n += 1;
            continue;
        }
        let e = match &items[i] {
            // Pictures as thumbnails, other files as chips, above the message they came with.
            ThreadItem::Files(files) => row().w_full().justify_end().mt(10.0).mb(-4.0).gap(8.0).flex_wrap()
                .children(files.iter().map(|f| crate::ui::file_tile(s, t, f, 132.0))),
            ThreadItem::Stamp(x) => row().center().mt(8.0).mb(12.0).child(text(x.clone()).font(ui(12.0, 400.0)).color(t.faint)),
            ThreadItem::You(x) => row().w_full().justify_end().my(10.0)
                .child(el().max_w(560.0).shrink().px(16.0).py(10.0).radius(20.0).fill(t.bubble)
                    .child(text(shown_message(x)).font(ui(15.0, 400.0).lh((15.0 * theme::text_scale() * theme::READ_LH).round())).color(t.text).wrap().shrink().min_w(0.0).selectable(true))),
            ThreadItem::Them(x) => {
                let live = streaming_at == Some(i) && s.prefs.reveal;
                row().w_full().my(6.0).child(markdown::render(x, t, live).max_w(width - 48.0))
            }
            ThreadItem::Team { text: x, agents } => {
                // Wraps in a narrow column (the chat beside the workspace panes); each agent's
                // mascot and name stay together.
                let mut r = row().w_full().min_w(0.0).flex_wrap().gap(6.0).my(10.0).center_y().child(text(x.clone()).font(ui(13.0, 400.0)).color(t.dim));
                for id in agents {
                    if let Some(a) = s.data.agent(id) {
                        r = r.child(row().gap(6.0).center_y()
                            .child(bot::agent(&crate::views::agents::awake(a), 26.0)).child(text(a.name.clone()).font(ui(13.5, 500.0)).color(t.dim)));
                    }
                }
                r
            }
            // One step shown on its own ("Show each tool call"), or a notice: inside the column,
            // a step on one line, a notice wrapped.
            ThreadItem::Event { icon, text: x, .. } if *icon == "help" => row().w_full().min_w(0.0).gap(8.0).my(4.0).items_start()
                .child(ico_s(icon, 15.0, t.faint)).child(rich_text(x, 13.0, t.faint, t.dim).wrap().grow(1.0).min_w(0.0)),
            ThreadItem::Event { icon, text: x, .. } => el().w_full().min_w(0.0).my(2.0).child(step_row(t, icon, x, false)),
            ThreadItem::Approval { id, title, detail, answer } => approval(t, id, title, detail, answer.as_deref()),
        };
        body = body.child(enter(e, n));
        n += 1;
        i += 1;
    }
    // Thinking: the reply hasn't started yet. As the Electron app shows it: a shimmering word
    // that changes every few seconds, three dots, and the seconds so far.
    let stepping = s.data.extra.step_now.iter().any(|(c, _)| c == chat) && matches!(items.last(), Some(ThreadItem::Event { .. }));
    if running && !matches!(items.last(), Some(ThreadItem::Them(_))) && !stepping {
        let _ = who;
        body = body.child(thinking(s, t, chat));
    }
    col().key(format!("thread/{chat}")).w_full().h_full().items_center().scroll(ScrollSpec { stick_bottom: true }).child(body)
}

/// Tool calls folded into one line ("Worked on 4 steps"), opened with a click.
/// What a run of steps did, in one line, as the Electron app sums it up: "Read 4 files, edited
/// index.html, ran 2 commands".
pub fn steps_summary(items: &[ThreadItem]) -> String {
    // (verb, one, many, count, the first one's name)
    let mut kinds: Vec<(&str, &str, &str, usize, String)> = Vec::new();
    let mut other = 0;
    for it in items {
        let ThreadItem::Event { text: x, .. } = it else { continue };
        let x = x.replace('`', "");
        let kind = [("Read ", "read", "file", "files"), ("Edited ", "edited", "file", "files"), ("Wrote ", "wrote", "file", "files"),
            ("Created ", "created", "file", "files"), ("Ran ", "ran", "command", "commands"), ("Searched the web for ", "searched the web", "time", "times"),
            ("Searched for ", "searched", "time", "times"), ("Found ", "looked for", "file", "files"), ("Listed ", "listed", "folder", "folders"),
            ("Opened ", "opened", "page", "pages"), ("Looked at ", "looked at", "image", "images"), ("Checked ", "checked", "page", "pages")]
            .into_iter().find(|(p, ..)| x.starts_with(p));
        match kind {
            Some((p, verb, one, many)) => {
                let name = x[p.len()..].trim().trim_end_matches(" (failed)").to_owned();
                match kinds.iter_mut().find(|k| k.0 == verb) {
                    Some(k) => k.3 += 1,
                    None => kinds.push((verb, one, many, 1, name)),
                }
            }
            None => other += 1,
        }
    }
    let mut parts: Vec<String> = kinds.iter().map(|(verb, one, many, n, name)| {
        let short = name.rsplit(['/', '\\']).next().unwrap_or(name);
        if *n == 1 && !short.is_empty() && short.len() <= 32 && *one == "file" {
            format!("{verb} {short}")
        } else if *n == 1 {
            format!("{verb} {} {one}", if one.starts_with(['a', 'e', 'i', 'o', 'u']) { "an" } else { "a" })
        } else if *one == "time" {
            format!("{verb} {n} {many}")
        } else {
            format!("{verb} {n} {many}")
        }
    }).collect();
    if other > 0 {
        parts.push(if other == 1 { "used a tool".to_owned() } else { format!("used {other} tools") });
    }
    let line = parts.join(", ");
    let mut c = line.chars();
    c.next().map_or_else(|| "Worked on it".to_owned(), |f| f.to_uppercase().collect::<String>() + c.as_str())
}

/// One step: its icon and its words on one line (a long command is cut, whole on hover).
fn step_row(t: &Theme, icon: &'static str, x: &str, live: bool) -> El {
    let plain = x.replace('`', "");
    row().w_full().min_w(0.0).gap(8.0).h(22.0).center_y().help(plain.clone())
        .child(ico_s(icon, 14.0, if live { t.dim } else { t.faint }))
        .child(text(plain).font(ui(12.5, 400.0)).color(if live { t.text } else { t.dim }).single_line().truncate().grow(1.0).min_w(0.0))
}

/// A command inside an open group: its line, which opens on a click to show what it ran
/// ("$ npm test") and the end of what it printed, as Claude's transcript shows a command.
fn command_step(s: &App, t: &Theme, key: &str, icon: &'static str, x: &str, d: &crate::model::StepDetail) -> El {
    let open = s.expanded.contains(key);
    let toggle_key = key.to_owned();
    let plain = x.replace('`', "");
    let head = row().key(key.to_owned()).w_full().min_w(0.0).gap(8.0).h(22.0).center_y().role("button").label(plain.clone()).checked(open).help(plain.clone())
        .child(ico_s(icon, 14.0, t.faint))
        .child(text(plain).font(ui(12.5, 400.0)).color(t.dim).single_line().truncate().shrink().min_w(0.0))
        .child(ico_s(if open { "chevron-down" } else { "chevron-right" }, 12.0, t.faint))
        .on_press(move |s: &mut App| s.toggle_expanded(&toggle_key));
    let mut c = col().w_full().min_w(0.0).child(head);
    if open {
        c = c.child(col().w_full().min_w(0.0).mt(4.0).mb(6.0).padding(12.0).gap(8.0).radius(10.0).fill(t.well).border(1.0, t.border)
            .child(text(format!("$ {}", d.command)).font(theme::mono(12.5, 18.0)).color(t.text).wrap().min_w(0.0).selectable(true))
            .children((!d.output.trim().is_empty()).then(|| {
                text(d.output.clone()).font(theme::mono(12.0, 17.0)).color(t.dim).wrap().min_w(0.0).selectable(true)
            })));
    }
    c
}

/// Steps, as the Electron app shows them: while it works, the step running now heads the
/// group and the steps so far are listed under it; once done, they fold into one line that
/// says what they did, and open on a click.
fn steps(s: &App, t: &Theme, chat: &str, start: usize, items: &[ThreadItem], live: bool) -> El {
    let key = format!("steps/{chat}/{start}");
    // Open while it works (unless you closed it); folded after (unless you opened it).
    let toggled = s.expanded.contains(&key);
    let open = if live { !toggled } else { toggled };
    let now = s.data.extra.step_now.iter().find(|(c, _)| c == chat).map(|(_, l)| l.replace('`', ""));
    let label = if live { now.clone().unwrap_or_else(|| "Working".to_owned()) } else { steps_summary(items) };
    let toggle_key = key.clone();
    let shown = if live { crate::ui::wave(&label, ui(13.0, 500.0), t.text) } else { text(label.clone()).font(ui(13.0, 500.0)).color(t.faint).single_line().truncate().min_w(0.0) };
    let head = row().key(key.clone()).w_full().min_w(0.0).gap(6.0).py(4.0).center_y().role("button").label(label.clone()).checked(open).help(label)
        .child(shown)
        .child(ico_s(if open { "chevron-down" } else { "chevron-right" }, 14.0, t.faint))
        .on_press(move |s: &mut App| s.toggle_expanded(&toggle_key));
    let mut c = col().w_full().min_w(0.0).my(4.0).gap(2.0).child(head);
    if open {
        // The newest few while it works, so the list never pushes the reply off screen.
        let skip = if live { items.len().saturating_sub(8) } else { 0 };
        c = c.child(col().w_full().min_w(0.0).gap(2.0).border_sides([0.0, 0.0, 0.0, 1.0], t.border).ml(6.0).pl(12.0)
            .children((skip > 0).then(|| text(format!("{skip} earlier steps")).font(ui(12.0, 400.0)).color(t.faint)))
            .children(items[skip..].iter().enumerate().map(|(k, it)| match it {
                ThreadItem::Event { icon, text: x, detail: Some(d) } => command_step(s, t, &format!("{key}/{}", skip + k), icon, x, d),
                ThreadItem::Event { icon, text: x, .. } => step_row(t, icon, x, false),
                _ => el(),
            })));
    }
    c
}

/// The engine asks before it acts: what it wants to do, and three answers.
pub fn approval(t: &Theme, id: &str, title: &str, detail: &str, answer: Option<&str>) -> El {
    let button = |label: &str, verdict: &'static str, kind: ButtonKind| {
        let id = id.to_owned();
        btn(t, label, None, kind).key(format!("approve/{id}/{verdict}")).on_press(move |s: &mut App| s.answer(&id, verdict))
    };
    let mut c = col().w_full().my(10.0).padding(14.0).gap(10.0).radius(theme::R_MD).fill(t.card).border(1.0, if answer.is_none() { t.warn.alpha(0.5) } else { t.card_border })
        .child(row().gap(8.0).center_y().child(ico_s("shield-check", 16.0, t.warn)).child(text(title.to_owned()).font(ui(14.0, 600.0)).color(t.text).wrap().grow(1.0).min_w(0.0)))
        .children((!detail.is_empty()).then(|| {
            el().w_full().padding(10.0).radius(8.0).fill(t.well).child(text(detail.to_owned()).font(theme::mono(12.5, 18.0)).color(t.dim).wrap())
        }));
    c = match answer {
        None => c.child(row().gap(8.0)
            .child(button("Allow once", "once", ButtonKind::Blue))
            .child(button("Always allow", "always", ButtonKind::Plain))
            .child(button("Don't allow", "reject", ButtonKind::Plain))),
        Some(v) => c.child(text(match v { "once" => "Allowed once", "always" => "Always allowed", _ => "Not allowed" }).font(ui(12.5, 400.0)).color(t.faint)),
    };
    c
}

/// A transcript with its composer docked at the bottom, as a chat or an agent's page shows it.
pub fn with_composer(s: &App, t: &Theme, chat: &str, who: &str, key: EditKey, target: Target, placeholder: &str, width: f32) -> El {
    // A background run in this chat that is retrying, paused, kept going, moved to the cloud or
    // needs you says so in one quiet line above the composer (agentsync.rs, run_health).
    let health = s.data.extra.agents.chat_health(chat).map(|h| {
        let ink = if matches!(h.state.as_str(), "needs_you" | "failed") { t.warn } else { t.dim };
        row().key(format!("chat-health/{chat}")).w_full().px(12.0).py(7.0).gap(8.0).radius(10.0).center_y().fill(t.hover)
            .child(crate::icons::ico_s(h.icon(), 14.0, ink))
            .child(text(h.line()).font(crate::theme::ui(12.5, 400.0)).color(ink).truncate().grow(1.0).min_w(0.0))
    });
    let room = if health.is_some() { 44.0 } else { 0.0 };
    let dock = col().pin(Some(0.0), None, Some(0.0), Some(0.0)).px(24.0).pt(14.0).pb(18.0).items_center()
        .linear_gradient(std::f32::consts::PI, [(0.0, t.bg.alpha(0.0)), (0.35, t.bg), (1.0, t.bg)])
        .child(col().w_full().max_w(width).gap(8.0).children(health).child(composer(s, t, key, target, placeholder, false, false)));
    let body = transcript(s, t, chat, who, width);
    el().w_full().h_full()
        .child(if room > 0.0 { col().w_full().h_full().pb(room).child(body) } else { body })
        .child(dock)
}

/// A message as its bubble shows it: without the note the code view adds for the agent
/// ("(Open in the editor: index.html)").
pub fn shown_message(text: &str) -> String {
    match text.rfind("\n\n(Open in the editor: ") {
        Some(i) if text.trim_end().ends_with(')') => text[..i].to_owned(),
        _ => text.to_owned(),
    }
}

/// The words the thinking line cycles through, as the Electron app's (app.js THINK_WORDS).
pub const THINK_WORDS: &[&str] = &["Thinking", "Pondering", "Noodling", "Mulling it over", "Connecting the dots", "Brewing an answer", "Untangling it", "Almost there"];
/// How long each word shows (app.js THINK_EVERY_MS).
pub const THINK_EVERY: f64 = 2.3;

/// "Noodling ··· 4s": the line under a message while its reply hasn't started.
fn thinking(s: &App, t: &Theme, chat: &str) -> El {
    let since = s.think_started.get(chat).copied().unwrap_or(s.think_now);
    let elapsed = (s.think_now - since).max(0.0);
    let turn = if s.reduced.get() { 0 } else { (elapsed / THINK_EVERY) as usize };
    // What it's doing right now ("Editing index.html"), as the Electron app shows it; the
    // thinking words only while it's between steps.
    let step = s.data.extra.step_now.iter().find(|(c, _)| c == chat).map(|(_, l)| l.clone());
    let turn = if step.is_some() { usize::MAX - 1 } else { turn };
    let word = step.unwrap_or_else(|| THINK_WORDS[turn % THINK_WORDS.len()].to_owned());
    let dot = |i: usize| el().size(4.0, 4.0).radius(2.0).fill(t.dim)
        .looping(rune::LoopSpec::opacity(1.0, i as f64 * 0.16, 0.2, 1.0));
    row().key(format!("thinking/{chat}")).gap(8.0).my(8.0).center_y().transition(crate::ui::fade_in()).motion(crate::ui::ENTER)
        // A new key per word, so each word fades in as it arrives.
        .child(el().key(format!("think-word/{turn}")).transition(crate::ui::fade_in()).motion(crate::ui::ENTER)
            .child(crate::ui::wave(&word, ui(14.0, 450.0), t.text)))
        .child(row().gap(3.0).center_y().child(dot(0)).child(dot(1)).child(dot(2)))
        .child(text(format!("{}s", elapsed as u64)).font(ui(12.5, 400.0)).color(t.faint))
}
