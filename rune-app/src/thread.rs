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
            ThreadItem::Stamp(x) => row().center().mt(8.0).mb(12.0).child(text(x.clone()).font(ui(12.0, 400.0)).color(t.faint)),
            ThreadItem::You(x) => row().w_full().justify_end().my(10.0)
                .child(el().max_w(560.0).shrink().px(16.0).py(10.0).radius(20.0).fill(t.bubble)
                    .child(text(x.clone()).font(ui(14.5, 400.0).lh(22.0)).color(t.text).wrap().shrink().min_w(0.0).selectable(true))),
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
            ThreadItem::Event { icon, text: x } => row().gap(8.0).my(4.0).center_y()
                .child(ico_s(icon, 15.0, t.faint)).child(rich_text(x, 13.0, t.faint, t.dim)),
            ThreadItem::Approval { id, title, detail, answer } => approval(t, id, title, detail, answer.as_deref()),
        };
        body = body.child(enter(e, n));
        n += 1;
        i += 1;
    }
    // Thinking: the reply hasn't started yet. As the Electron app shows it: a shimmering word
    // that changes every few seconds, three dots, and the seconds so far.
    if running && !matches!(items.last(), Some(ThreadItem::Them(_))) {
        let _ = who;
        body = body.child(thinking(s, t, chat));
    }
    col().key(format!("thread/{chat}")).w_full().h_full().items_center().scroll(ScrollSpec { stick_bottom: true }).child(body)
}

/// Tool calls folded into one line ("Worked on 4 steps"), opened with a click.
fn steps(s: &App, t: &Theme, chat: &str, start: usize, items: &[ThreadItem], live: bool) -> El {
    let key = format!("steps/{chat}/{start}");
    let open = s.expanded.contains(&key);
    let label = if live {
        format!("Working · {} step{}", items.len(), if items.len() == 1 { "" } else { "s" })
    } else {
        format!("Worked on {} step{}", items.len(), if items.len() == 1 { "" } else { "s" })
    };
    let toggle_key = key.clone();
    let shown = if live { crate::ui::wave(&label, ui(13.0, 500.0), t.text) } else { text(label.clone()).font(ui(13.0, 500.0)).color(t.faint) };
    let head = row().key(key.clone()).gap(6.0).py(4.0).center_y().role("button").label(label.clone()).checked(open)
        .child(shown)
        .child(ico_s(if open { "chevron-down" } else { "chevron-right" }, 14.0, t.faint))
        .on_press(move |s: &mut App| s.toggle_expanded(&toggle_key));
    let mut c = col().my(4.0).gap(2.0).child(head);
    if open {
        c = c.child(col().pl(4.0).gap(4.0).border_sides([0.0, 0.0, 0.0, 1.0], t.border).ml(4.0).pl(12.0)
            .children(items.iter().map(|it| match it {
                ThreadItem::Event { icon, text: x } => row().gap(8.0).center_y().child(ico_s(icon, 14.0, t.faint)).child(rich_text(x, 12.5, t.faint, t.dim)),
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
    let dock = col().pin(Some(0.0), None, Some(0.0), Some(0.0)).px(24.0).pt(14.0).pb(18.0).items_center()
        .linear_gradient(std::f32::consts::PI, [(0.0, t.bg.alpha(0.0)), (0.35, t.bg), (1.0, t.bg)])
        .child(el().w_full().max_w(width).child(composer(s, t, key, target, placeholder, false, false)));
    el().w_full().h_full()
        .child(transcript(s, t, chat, who, width))
        .child(dock)
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
    let word = THINK_WORDS[turn % THINK_WORDS.len()];
    let dot = |i: usize| el().size(4.0, 4.0).radius(2.0).fill(t.dim)
        .looping(rune::LoopSpec::opacity(1.0, i as f64 * 0.16, 0.2, 1.0));
    row().key(format!("thinking/{chat}")).gap(8.0).my(8.0).center_y().transition(crate::ui::fade_in()).motion(crate::ui::ENTER)
        // A new key per word, so each word fades in as it arrives.
        .child(el().key(format!("think-word/{turn}")).transition(crate::ui::fade_in()).motion(crate::ui::ENTER)
            .child(crate::ui::wave(word, ui(14.0, 450.0), t.text)))
        .child(row().gap(3.0).center_y().child(dot(0)).child(dot(1)).child(dot(2)))
        .child(text(format!("{}s", elapsed as u64)).font(ui(12.5, 400.0)).color(t.faint))
}
