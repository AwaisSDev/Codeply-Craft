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
    // The steps still running (the group at the very end while the chat runs): they go inside
    // the activity row's dropdown, not a header of their own.
    let mut live_steps: Option<(usize, usize)> = None;
    while i < items.len() {
        // Consecutive tool calls fold into one line, unless Settings says show them.
        if matches!(items[i], ThreadItem::Event { .. }) && !s.prefs.show_tools {
            let start = i;
            while i < items.len() && matches!(items[i], ThreadItem::Event { .. }) {
                i += 1;
            }
            if running && i == items.len() {
                live_steps = Some((start, i));
            } else {
                body = body.child(enter(steps(s, t, chat, start, &items[start..i]), n));
                n += 1;
            }
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
            ThreadItem::Sources(list) => sources(t, list),
        };
        body = body.child(enter(e, n));
        n += 1;
        i += 1;
    }
    // While the reply hasn't started: one activity row (orb, the step or a thinking word, a
    // chevron), with the time so far and the steps inside.
    if running && !matches!(items.last(), Some(ThreadItem::Them(_))) {
        let turn = items.iter().rposition(|i| matches!(i, ThreadItem::You(_))).unwrap_or(0);
        let live = live_steps.map(|(a, b)| (a, &items[a..b]));
        body = body.child(activity(s, t, chat, turn, live));
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

/// The steps a run took, folded into one line that says what they did ("Read 4 files, edited
/// index.html"); a click opens the list, each command with what it ran and printed. (While
/// the run is going, its steps live in the activity row instead.)
fn steps(s: &App, t: &Theme, chat: &str, start: usize, items: &[ThreadItem]) -> El {
    let key = format!("steps/{chat}/{start}");
    let open = s.expanded.contains(&key);
    let label = steps_summary(items);
    let toggle_key = key.clone();
    let head = row().key(key.clone()).w_full().min_w(0.0).gap(6.0).py(4.0).center_y().role("button").label(label.clone()).checked(open).help(label.clone())
        .child(text(label).font(ui(13.0, 500.0)).color(t.faint).single_line().truncate().min_w(0.0))
        .child(ico_s(if open { "chevron-down" } else { "chevron-right" }, 14.0, t.faint))
        .on_press(move |s: &mut App| s.toggle_expanded(&toggle_key));
    let mut c = col().w_full().min_w(0.0).my(4.0).gap(2.0).child(head);
    if open {
        c = c.child(step_list(s, t, &key, items, 0));
    }
    c
}

/// The steps under an open group, from `skip` on, with a line for the ones left out.
fn step_list(s: &App, t: &Theme, key: &str, items: &[ThreadItem], skip: usize) -> El {
    col().w_full().min_w(0.0).gap(2.0).border_sides([0.0, 0.0, 0.0, 1.0], t.border).ml(6.0).pl(12.0)
        .children((skip > 0).then(|| text(format!("{skip} earlier steps")).font(ui(12.0, 400.0)).color(t.faint)))
        .children(items[skip..].iter().enumerate().map(|(k, it)| match it {
            ThreadItem::Event { icon, text: x, detail: Some(d) } => command_step(s, t, &format!("{key}/{}", skip + k), icon, x, d),
            ThreadItem::Event { icon, text: x, .. } => step_row(t, icon, x, false),
            _ => el(),
        }))
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

/// "Searched the web" and the pages it used, as chips (the site's icon and name) that open in the
/// browser, as the phone shows them under a reply.
fn sources(t: &Theme, list: &[(String, String)]) -> El {
    let chips = list.iter().enumerate().map(|(i, (url, title))| {
        let host = crate::favicon::host(url).unwrap_or_default().trim_start_matches("www.").to_owned();
        let open = url.clone();
        let icon = crate::favicon::get(url).filter(|px| px.size().0 > 0);
        row().key(format!("source/{i}/{url}")).h(26.0).px(9.0).gap(6.0).radius(13.0).center_y().fill(t.hover).border(1.0, t.border).hover(t.active)
            .role("link").label(if title.is_empty() { host.clone() } else { title.clone() }).help(if title.is_empty() { url.clone() } else { format!("{title}\n{url}") })
            .child(match icon {
                Some(px) => el().size(14.0, 14.0).radius(3.0).clip_rounded(3.0).pixels_fit(&px, rune::SurfaceFit::Fill).inert(),
                None => ico_s("globe", 13.0, t.faint),
            })
            .child(text(host).font(ui(12.0, 500.0)).color(t.dim))
            .on_press(move |s: &mut App| s.browse(&open))
    });
    col().w_full().gap(6.0).mt(2.0).mb(8.0)
        .child(row().gap(6.0).center_y().child(ico_s("globe", 13.0, t.faint)).child(text("Searched the web").font(ui(12.0, 500.0)).color(t.faint)))
        .child(row().w_full().gap(6.0).flex_wrap().children(chips))
}

/// A message as its bubble shows it: without the note the code view adds for the agent
/// ("(Open in the editor: index.html)").
pub fn shown_message(text: &str) -> String {
    let text = match text.rfind("\n\n(Open in the editor: ") {
        Some(i) if text.trim_end().ends_with(')') => &text[..i],
        _ => text,
    };
    // A scheduled job's message carries the engine's note for running with nobody at the PC
    // (ext-team.mjs fire): the agent reads it, the chat shows the job.
    match text.find("\n\n(Nobody may be at the PC") {
        Some(i) if text.trim_end().ends_with(')') => text[..i].to_owned(),
        _ => text.to_owned(),
    }
}

/// The words the thinking line cycles through, as the Electron app's (app.js THINK_WORDS).
pub const THINK_WORDS: &[&str] = &["Thinking", "Pondering", "Noodling", "Mulling it over", "Connecting the dots", "Brewing an answer", "Untangling it", "Almost there"];
/// How long each word shows (app.js THINK_EVERY_MS).
pub const THINK_EVERY: f64 = 2.3;

/// "4s", "1m 05s": how long a run has been going.
fn elapsed_label(secs: u64) -> String {
    if secs < 60 { format!("{secs}s") } else { format!("{}m {:02}s", secs / 60, secs % 60) }
}

/// The one row a chat shows while its reply hasn't started: an orb, what it's doing in a
/// shimmering word ("Editing index.html", or a thinking word that changes every few seconds:
/// "Noodling…"), and a chevron. Opened, it shows the time so far and the steps run so far, each
/// command with what it ran and printed. Folded by default; `turn` keys it to this message.
fn activity(s: &App, t: &Theme, chat: &str, turn: usize, live: Option<(usize, &[ThreadItem])>) -> El {
    let still = s.reduced.get();
    let since = s.think_started.get(chat).copied().unwrap_or(s.think_now);
    let elapsed = (s.think_now - since).max(0.0);
    // What it's doing right now, as the Electron app shows it; a thinking word between steps.
    let step = s.data.extra.step_now.iter().find(|(c, _)| c == chat).map(|(_, l)| l.replace('`', ""));
    let (word_key, word) = match step {
        Some(l) => (format!("step/{l}"), l),
        None => {
            let n = if still { 0 } else { (elapsed / THINK_EVERY) as usize };
            (format!("think/{n}"), format!("{}…", THINK_WORDS[n % THINK_WORDS.len()]))
        }
    };
    let key = format!("activity/{chat}/{turn}");
    let open = s.expanded.contains(&key);
    let toggle_key = key.clone();
    let head = row().key(key.clone()).w_full().min_w(0.0).gap(10.0).py(4.0).center_y().role("button").label(word.clone()).checked(open).help(word.clone())
        .child(crate::ui::orb(t, 14.0, still))
        // A new key per word, so each word fades in as it arrives.
        .child(el().key(format!("activity-word/{chat}/{word_key}")).shrink().min_w(0.0).clip_rounded(0.0)
            .transition(crate::ui::fade_in()).motion(crate::ui::ENTER)
            .child(crate::ui::shimmer(&word, ui(14.0, 450.0), t.text, 40, still)))
        .child(ico_s(if open { "chevron-up" } else { "chevron-down" }, 14.0, t.faint))
        .on_press(move |s: &mut App| s.toggle_expanded(&toggle_key));
    let mut c = col().key(format!("activity/{chat}")).w_full().min_w(0.0).my(6.0).gap(4.0)
        .transition(crate::ui::fade_in()).motion(crate::ui::ENTER)
        .child(head);
    if open {
        c = c.child(row().ml(2.0).gap(6.0).center_y()
            .child(ico_s("clock", 13.0, t.faint))
            .child(text(format!("{} so far", elapsed_label(elapsed as u64))).font(ui(12.5, 400.0)).color(t.faint)));
        if let Some((start, items)) = live {
            // The newest few, so the list never pushes the reply off screen.
            c = c.child(step_list(s, t, &format!("steps/{chat}/{start}"), items, items.len().saturating_sub(8)));
        }
    }
    c
}
