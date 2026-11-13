//! Office, the default view: a small pixel-art office where each agent's place and motion say what
//! it is doing. At a desk, hopping (working); at the coffee machine with a mug (thinking); at the
//! Needs you counter, swaying, with a bubble (waiting); on the sofa with z's (sleeping); or
//! walking the corridor. Hover an agent for its current action; click it for its live session or
//! latest chat in a drawer. Escape closes the drawer.

use rune::{Color, Cx, Easing, Edge, El, LoopSpec, Spring, Transition, col, el, row, text};

use crate::app::{App, EditKey, View};
use crate::bot;
use crate::icons::ico_s;
use crate::model::{Agent, AgentState, Block, ButtonKind};
use crate::store::Target;
use crate::theme::{self, Theme, ui};
use crate::ui::{btn, btn_primary, composer, enter, fade_in, heading, ibtn, rich_text, ENTER};
use crate::views::board::screen_thumb;
use crate::views::office_art::{ACTOR_H, ACTOR_W, BOT_CENTRE, H, ROOMS, UNIT, W, label_at, screens};

const HEADER: f32 = 74.0;
const DOCK: f32 = 134.0;

pub fn main(s: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let d = &s.data;
    let sub = format!(
        "{} working, {} thinking, {} needs you, {} asleep",
        d.count(AgentState::Working), d.count(AgentState::Thinking), d.count(AgentState::Waiting), d.count(AgentState::Sleeping)
    );
    let head = row().h(HEADER).gap(12.0).px(24.0).pt(8.0).center_y()
        .child(heading(t, "Office", Some(sub)))
        .child(el().grow(1.0))
        .child(btn_primary(t, "New task", "plus"));

    // The office scales by whole device pixels per art pixel, so the pixel art stays crisp.
    let main = cx.layout_size("main").unwrap_or([1380.0, 856.0]);
    let scale = cx.env().scale.max(1.0);
    let room = ((main[0] - 48.0) / W as f32).min((main[1] - HEADER - DOCK - 4.0) / H as f32);
    let k = ((room * scale).floor() as u32).max(1);
    let pt = k as f32 / scale;
    let art = &s.office;
    art.px.set(k);
    art.scale.set(scale);
    art.reduced.set(cx.is_reduced_motion());
    art.ensure_scene(k, d.count(AgentState::Waiting) as u32);

    let mut office = el().key("office").size(W as f32 * pt, H as f32 * pt).pixels(&art.scene).radius(4.0)
        .on_press(|s: &mut App| s.drawer = None);
    for r in &ROOMS {
        let (x, y) = label_at(r);
        office = office.child(el().pin(Some(x * pt), Some(y * pt), None, None).px(5.0).radius(4.0).fill(Color::BLACK.alpha(0.42))
            .child(text(r.name).font(ui(11.5, 600.0)).color(theme::hex("#e9e2d6"))).inert());
    }
    for (i, ([x, y, w, h], code)) in screens().into_iter().enumerate() {
        let rect = |x: i32, y: i32, w: i32, h: i32| el().pin(Some(x as f32 * pt), Some(y as f32 * pt), None, None).size(w as f32 * pt, h as f32 * pt);
        office = office.child(rect(x, y, w, h).fill(theme::hex("#1d3c86")).looping(LoopSpec::opacity(2.4, i as f64 * 0.3, 0.0, 0.55)).inert());
        if code {
            for (j, (lw, ink)) in [(5, "#4f86ff"), (7, "#9aa7ff"), (3, "#6fd3a0")].into_iter().enumerate() {
                office = office.child(rect(x + 1, y + 1 + j as i32 * 2 - (j as i32 / 2), lw, 1).fill(theme::hex(ink))
                    .looping(LoopSpec::opacity(1.6, j as f64 * 0.5, 0.15, 0.7)).inert());
            }
        }
    }
    // The coffee machine's ready lamp.
    office = office.child(el().pin(Some(277.0 * pt), Some(13.0 * pt), None, None).size(pt, pt).fill(theme::hex("#ff5d5d"))
        .looping(LoopSpec::opacity(1.2, 0.0, 0.15, 1.0).easing(Easing::LINEAR)).inert());
    for a in &d.team {
        office = office.child(agent(s, t, a, pt));
    }

    let stage = col().key("stage").grow(1.0).min_h(0.0).items_center().pt(4.0).px(24.0).pb(DOCK).child(office);
    let dock = col().pin(Some(0.0), None, Some(0.0), Some(0.0)).px(24.0).pt(12.0).pb(20.0).items_center()
        .child(el().w_full().max_w(760.0).child(composer(s, t, EditKey::OfficeDock, Target::Wisp, "Give Wisp a task, or ask how things are going", false, false)));
    let drawer = s.drawer.as_ref().and_then(|id| d.agent(id)).map(|a| drawer(s, t, a));
    el().key("office-wrap").w_full().h_full().transition(fade_in()).motion(ENTER)
        .child(col().w_full().h_full().child(head).child(stage))
        .child(dock)
        .children(drawer)
}

fn agent(s: &App, t: &Theme, a: &Agent, pt: f32) -> El {
    let (pixels, offset) = s.office.actor(&a.id, |x| (x.pixels.clone(), x.offset.clone()));
    let selected = s.drawer.as_deref() == Some(a.id.as_str());
    let (left, top) = ((a.pos.0 / UNIT - BOT_CENTRE.0) * pt, (a.pos.1 / UNIT - BOT_CENTRE.1) * pt);
    let (w, h) = (ACTOR_W as f32 * pt, ACTOR_H as f32 * pt);
    let id = a.id.clone();
    let tag = row().pin(Some(-40.0), Some((BOT_CENTRE.1 + 8.0) * pt + 2.0), Some(-40.0), None).justify_center().child(
        el().px(7.0).radius(6.0).fill(theme::rgba(15, 15, 15, 0.85)).border(1.0, if selected { theme::hex("#3a3a3a") } else { t.border })
            .child(text(a.name.clone()).font(ui(12.0, 600.0)).color(if selected { t.text } else { t.dim })),
    );
    let bubble = (a.state == AgentState::Waiting).then(|| {
        // Just above the bot's head (its top is row 13 of the actor canvas).
        col().pin(Some(-60.0), Some(12.0 * pt - 34.0), Some(-60.0), None).items_center()
            .live_offset(&s.office.nudge)
            .child(el().px(9.0).py(4.0).radius(10.0).fill(theme::hex("#ececec")).shadow(8.0, 24.0, theme::rgba(0, 0, 0, 0.4))
                .child(text("Needs your OK").font(ui(12.0, 600.0)).color(theme::hex("#141414"))))
            // The tail: a vector triangle (a turned square would draw through an offscreen layer).
            .child(rune::canvas(rune::Shape::new().fill(vec![[0.0, 0.0], [10.0, 0.0], [5.0, 5.0]], theme::hex("#ececec"))).size(10.0, 5.0))
    });
    el().key(format!("agent/{}", a.id)).pin(Some(left), Some(top), None, None).size(w, h)
        .live_offset(&offset)
        .role("button").label(format!("{}, {}", a.name, a.state.word())).cursor(rune::Cursor::Pointer)
        .help(format!("{}: {}", a.name, a.action))
        .child(el().size(w, h).pixels(&pixels))
        .child(tag)
        .children(bubble)
        .on_press(move |s: &mut App| s.open_drawer(&id))
}

/// The right-hand drawer: the agent's live session or latest chat, and a compact composer.
fn drawer(s: &App, t: &Theme, a: &Agent) -> El {
    let head = row().gap(12.0).padding(16.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.border)
        .child(bot::agent(a, 40.0))
        .child(col().grow(1.0).min_w(0.0)
            .child(text(a.name.clone()).font(ui(15.0, 600.0)).color(t.text))
            .child(text(format!("{} · {}", a.role, a.place)).font(ui(12.5, 400.0)).color(t.faint)))
        .child(ibtn(t, "close", "Close").key("drawer-close").on_press(|s: &mut App| s.drawer = None));
    let blocks = s.data.session(&a.id).iter().enumerate().map(|(i, b)| enter(block(s, t, a, b), i));
    col().key("drawer").pin(None, Some(12.0), Some(12.0), Some(12.0)).w(420.0)
        .fill(theme::hex("#181818")).border(1.0, theme::hex("#2c2c2c")).radius(16.0).shadow(24.0, 64.0, theme::rgba(0, 0, 0, 0.55))
        .transition(Transition::move_edge(Edge::Trailing).combined(Transition::opacity())).motion(Spring::new(0.32, 0.0))
        .role("dialog").label(format!("{}'s session", a.name))
        .on_press(|_: &mut App| {})
        .child(head)
        .child(col().key(format!("drawer-body/{}", a.id)).grow(1.0).min_h(0.0).px(16.0).py(14.0).gap(12.0).clip_rounded(0.0).children(blocks))
        .child(col().padding(12.0).border_sides([1.0, 0.0, 0.0, 0.0], t.border)
            .child(composer(s, t, EditKey::Drawer, Target::Agent(a.id.clone()), &format!("Message {}", a.name), false, true)))
}

fn block(s: &App, t: &Theme, a: &Agent, b: &Block) -> El {
    let draft_box = |e: El| e.padding(12.0).radius(12.0).fill(theme::hex("#1f1f1f")).border(1.0, theme::hex("#2c2c2c"));
    match b {
        Block::Label(x) => text(x.clone()).font(ui(12.0, 600.0)).color(t.faint),
        Block::Step { text: x, now } => {
            let line = rich_text(x, 13.5, t.dim, t.text).wrap().grow(1.0).min_w(0.0);
            row().gap(9.0).items_start()
                .child(ico_s(if *now { "refresh" } else { "check" }, 16.0, if *now { t.dim } else { t.green }).mt(1.0))
                .child(if *now { line.looping(LoopSpec::opacity(2.2, 0.0, 0.55, 1.0)) } else { line })
        }
        Block::LiveScreen => screen_thumb(t, &a.color, 150.0, Some(&s.office.cursor)),
        Block::Bubble(x) => row().justify_end()
            .child(el().max_w(320.0).px(13.0).py(9.0).radius(16.0).fill(t.bubble).child(text(x.clone()).font(ui(13.5, 400.0).lh(20.0)).color(t.text).wrap())),
        Block::Reply(x) => el().max_w(360.0).child(text(x.clone()).font(ui(13.5, 400.0).lh(20.0)).color(t.text).wrap()),
        Block::Draft { title, to, via, body } => col().gap(12.0)
            .child(col()
                .child(text(title.clone()).font(ui(13.5, 600.0)).color(t.text))
                .child(row().gap(6.0).center_y().child(text(format!("{to} ·")).font(ui(12.5, 400.0)).color(t.faint))
                    .children(via.as_ref().map(|v| row().gap(6.0).center_y()
                        .child(ico_s(&format!("app-{v}"), 14.0, t.faint))
                        .child(text("via Gmail").font(ui(12.0, 400.0)).color(t.faint))))))
            .child(draft_box(col()).child(text(body.clone()).font(ui(13.5, 400.0).lh(21.6)).color(t.text).wrap())),
        Block::Quote(x) => draft_box(col()).child(text(x.clone()).font(ui(13.0, 400.0).lh(20.8)).color(t.dim).wrap()),
        Block::Via { icon, text: x } => row().gap(6.0).center_y().child(ico_s(icon, 16.0, t.faint)).child(text(x.clone()).font(ui(12.0, 400.0)).color(t.faint)),
        Block::Buttons(list) => row().gap(8.0).children(list.iter().map(|(label, kind, icon)| {
            let b = btn(t, label, *icon, kind.clone());
            match (*icon, kind) {
                (Some("code"), ButtonKind::Plain) => b.on_press(|s: &mut App| s.go(View::Code)),
                (Some("branch"), ButtonKind::Plain) => b.on_press(|s: &mut App| { s.pr = 44; s.go(View::Prs) }),
                _ => b,
            }
        })),
    }
}
