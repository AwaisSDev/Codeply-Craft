//! Chat, the app's home: the dithered warp art, Wisp, "What should we build in launch-site?",
//! the composer and the bento cards. An open chat shows its transcript instead.

use rune::{Color, Cx, El, ScrollSpec, col, el, row, text};

use crate::app::{App, EditKey};
use crate::bot;
use crate::icons::ico_s;
use crate::model::ThreadItem;
use crate::store::Target;
use crate::theme::{self, Theme, tabular, ui};
use crate::ui::{composer, enter, fade_in, me, rich_text, sec, side_head, side_row, ENTER};

pub fn side(s: &App, t: &Theme) -> El {
    let mut list = col().px(8.0).pb(10.0);
    let mut i = 0;
    for g in &s.data.chat_groups {
        list = list.child(sec(t, Some(g.icon), &g.title, true));
        for c in &g.chats {
            let on = s.chat.as_deref() == Some(c.as_str());
            let name = c.clone();
            list = list.child(enter(
                side_row(t, on).key(format!("chat/{c}")).role("button").label(c.clone())
                    .child(text(c.clone()).font(ui(14.0, 400.0)).color(t.text).truncate())
                    .on_press(move |s: &mut App| s.open_chat(&name)),
                i,
            ));
            i += 1;
        }
    }
    col().h_full().min_h(0.0)
        .child(side_head(t, "Chats", Some(("oai-compose", "New chat"))))
        .child(col().grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(list))
        .child(me(s, t))
}

pub fn main(s: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    match &s.chat {
        None => home(s, t, cx),
        Some(chat) => thread(s, t, chat),
    }
}

fn home(s: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let art = s.warp.element(cx);
    let title = row().center().child(rich_title(t, &s.data.project));
    let column = col().key("chat-home").w_full().max_w(800.0).gap(0.0).transition(fade_in()).motion(ENTER)
        .child(row().center().pb(18.0).child(bot::wisp(104.0)))
        .child(title.pb(30.0))
        .child(composer(s, t, EditKey::ChatHome, Target::Wisp, "Ask Codeply anything, or type / for commands", true, false))
        .child(bento(s, t).mt(14.0));
    el().w_full().h_full()
        .child(art)
        .child(col().w_full().h_full().center().px(24.0).py(40.0).scroll(ScrollSpec { stick_bottom: false }).child(column))
}

/// "What should we build in launch-site?", the project underlined with dots.
fn rich_title(t: &Theme, project: &str) -> El {
    let big = ui(30.0, 500.0).tracking(-0.3);
    row().items_end()
        .child(text("What should we build in ").font(big).color(t.text))
        .child(col().child(text(project.to_owned()).font(big).color(t.text))
            .child(el().w_full().h(2.0).border_sides([2.0, 0.0, 0.0, 0.0], Color::WHITE.alpha(0.5)).border_dash(2.0, 2.0)))
        .child(text("?").font(big).color(t.text))
}

fn bento(s: &App, t: &Theme) -> El {
    let glass = theme::rgba(24, 24, 24, 0.92);
    let card = |icon: &str, title: &str| {
        col().padding(0.0).pt(12.0).pb(12.0).px(14.0).fill(glass).border(1.0, t.card_border).radius(theme::R_MD).backdrop_blur(14.0)
            .child(row().gap(8.0).pb(8.0).center_y().child(ico_s(icon, 16.0, t.faint)).child(text(title.to_owned()).font(ui(13.0, 500.0)).color(t.dim)))
    };
    let list = |items: &[(String, String)]| {
        col().gap(6.0).children(items.iter().map(|(a, b)| {
            row().gap(8.0).center_y()
                .child(text(a.clone()).font(ui(13.5, 400.0)).color(t.text).truncate().grow(1.0).min_w(0.0))
                .child(text(b.clone()).font(tabular(12.0, 400.0)).color(t.faint))
        }))
    };
    let big = |n: &str, unit: &str| {
        row().gap(6.0).items_end()
            .child(text(n.to_owned()).font(tabular(28.0, 600.0)).color(t.text))
            .child(text(unit.to_owned()).font(ui(13.0, 400.0)).color(t.faint).pb(4.0))
    };
    // A year of activity: 52 weeks by 7 days of round cells, greener where busier.
    let dot = |lvl: u8| match lvl {
        3 => theme::hex("#4cc38a"),
        2 => theme::hex("#2f8f5b"),
        1 => theme::hex("#1f5c3d"),
        _ => theme::hex("#2a2a2a"),
    };
    // Cells as the prototype's 52-column grid draws them at this width: about 6.6 pt with 3 pt gaps.
    let grid = col().gap(3.0).w_full().children((0..7).map(|r| {
        row().w_full().justify_between().children((0..52).map(|c| {
            let lvl = s.data.activity.get(r * 52 + c).copied().unwrap_or(0);
            el().size(6.6, 6.6).radius(3.3).fill(dot(lvl))
        }))
    }));
    let activity = card("chart", "Activity").child(grid)
        .child(row().pt(8.0).justify_between()
            .child(text("38 active days · 77.8m tokens").font(ui(12.0, 400.0)).color(t.faint))
            .child(text("Last 12 months").font(ui(12.0, 400.0)).color(t.faint)));
    let prs: Vec<(String, String)> = vec![("Pricing page for launch-site".into(), "2 h".into()), ("Admin dashboard: progress".into(), "7 d".into())];
    let third = |e: El| e.grow(1.0).w(0.0);
    col().gap(10.0).w_full()
        .child(row().gap(10.0).items_stretch()
            .child(activity.grow(2.0).w(0.0))
            .child(third(card("history", "Recent chats").child(list(&s.data.recent)))))
        .child(row().gap(10.0).items_stretch()
            .child(third(card("gauge", "Total").child(big("77.8m", "tokens"))))
            .child(third(card("branch", "Pull requests").child(list(&prs))))
            .child(third(card("calendar", "This month").child(big("23", "chats")))))
}

fn thread(s: &App, t: &Theme, chat: &str) -> El {
    let items = s.data.thread(chat);
    let mut body = col().w_full().max_w(820.0).px(24.0).pt(24.0).pb(160.0);
    for (i, item) in items.iter().enumerate() {
        let e = match item {
            ThreadItem::Stamp(x) => row().center().mt(8.0).mb(16.0).child(text(x.clone()).font(ui(12.0, 400.0)).color(t.faint)),
            // `.msg .b { max-width: 74% }`: bubbles shrink and wrap inside the thread's column.
            ThreadItem::You(x) => row().w_full().justify_end().my(8.0)
                .child(el().max_w(570.0).shrink().px(15.0).py(10.0).radius(20.0).fill(t.bubble).child(text(x.clone()).font(ui(14.0, 400.0).lh(21.0)).color(t.text).wrap().shrink().min_w(0.0))),
            ThreadItem::Them(x) => row().w_full().my(8.0)
                .child(text(x.clone()).font(ui(14.0, 400.0).lh(21.0)).color(t.text).wrap().max_w(570.0).shrink().min_w(0.0).pl(2.0).py(10.0)),
            ThreadItem::Team { text: x, agents } => {
                let mut r = row().center().gap(6.0).my(14.0).child(text(x.clone()).font(ui(13.0, 400.0)).color(t.dim));
                for (k, id) in agents.iter().enumerate() {
                    if let Some(a) = s.data.agent(id) {
                        if k + 1 == agents.len() {
                            r = r.child(text("and").font(ui(13.0, 400.0)).color(t.dim));
                        }
                        r = r.child(bot::agent(a, 18.0)).child(text(a.name.clone()).font(ui(13.0, 400.0)).color(t.dim));
                    }
                }
                r
            }
            ThreadItem::Event { icon, text: x } => row().center().gap(6.0).my(14.0)
                .child(ico_s(icon, 16.0, t.dim)).child(rich_text(x, 13.0, t.dim, t.text)),
        };
        body = body.child(enter(e, i));
    }
    let dock = col().pin(Some(0.0), None, Some(0.0), Some(0.0)).px(24.0).pt(12.0).pb(20.0).items_center()
        .linear_gradient(std::f32::consts::PI, [(0.0, t.bg.alpha(0.0)), (0.3, t.bg), (1.0, t.bg)])
        .child(el().w_full().max_w(820.0).child(composer(s, t, EditKey::ChatThread, Target::Chat(chat.to_owned()), "Message Wisp", false, false)));
    el().w_full().h_full()
        .child(col().key("thread").w_full().h_full().items_center().scroll(ScrollSpec { stick_bottom: true }).child(body))
        .child(dock)
}
