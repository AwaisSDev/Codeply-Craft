//! The frame: a Windows-style titlebar with the Ctrl K search, the 60 pt activity rail, the
//! contextual sidebar (none on Office) and the main area.

use rune::{Color, Cx, El, Side, Tx, col, el, row, text, text_input};

use crate::app::{App, EditKey, View};
use crate::bot;
use crate::icons::ico;
use crate::theme::{self, Theme, ui};
use crate::ui::ibtn;
use crate::views;

pub const TITLEBAR: f32 = 44.0;
pub const RAIL: f32 = 60.0;
pub const SIDE: f32 = 268.0;

pub fn view(s: &App, cx: &mut Cx<App>) -> El {
    let t = theme::dark();
    cx.caption_color(t.dim);
    s.reduced.set(cx.is_reduced_motion());
    let (side, main) = views::build(s, &t, cx);
    let body = row().w_full().grow(1.0).min_h(0.0)
        .child(rail(s, &t))
        .children(side.map(|sd| {
            col().key("side").w(SIDE).h_full().min_h(0.0).fill(t.side).border_sides([0.0, 1.0, 0.0, 0.0], t.border).child(sd)
        }))
        .child(col().key("main").grow(1.0).h_full().min_w(0.0).min_h(0.0).fill(t.bg).clip_rounded(0.0).child(main));
    // Popovers attach at the root so they draw above everything and escape clipping.
    let popover = s.appearance.as_ref().and_then(|id| s.data.agent(id)).map(|a| views::appearance::popover(s, &t, a));
    col().key("root").w_full().h_full().fill(t.bg).child(titlebar(s, &t, cx)).child(body).children(popover)
}

fn titlebar(s: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let insets = cx.chrome_insets();
    // On Windows Rune draws the real caption buttons in `insets.trailing`; macOS keeps its traffic
    // lights and Linux its native frame. Headless renders have neither, so they get Windows-style
    // stand-ins (that still minimize, maximize and close), to match the prototype's titlebar.
    let own_caption = insets.trailing == 0.0 && rune::is_headless();
    let brand = row().w(300.0).gap(9.0).center_y().pl(14.0 + insets.leading)
        .child(bot::wisp(24.0))
        .child(text("Codeply").font(ui(15.0, 700.0)).color(t.text));
    let search = text_input(s.edit(EditKey::Search), ui(13.0, 400.0)).key("cmdk").single_line().grow(1.0).color(t.text)
        .placeholder("Search chats, files, PRs and mail, or ask Wisp", t.faint).caret(t.accent, t.accent.alpha(0.3))
        .label("Search").on_edit(|s: &mut App| s.edit_mut(EditKey::Search));
    let cmdk = row().w_full().max_w(560.0).h(30.0).gap(8.0).px(12.0).radius(9.0).center_y().fill(t.hover).border(1.0, t.border).no_window_drag()
        .child(ico("oai-search", t.faint))
        .child(search)
        .child(el().px(5.0).radius(5.0).border(1.0, t.border).child(text("Ctrl K").font(ui(12.0, 400.0)).color(t.faint)));
    let win = |label: &'static str, glyph: El, close: bool, act: fn(&mut App, &mut Tx)| {
        el().w(46.0).h(TITLEBAR).center().role("button").label(label).no_window_drag()
            .hover(if close { theme::hex("#e81123") } else { t.hover })
            .child(glyph)
            .on_press_tx(act)
    };
    let caption = own_caption.then(|| {
        row()
            .child(win("Minimize", el().size(10.0, 1.0).fill(t.dim), false, |_, tx| tx.minimize()))
            .child(win("Maximize", el().size(10.0, 10.0).border(1.0, t.dim), false, |_, tx| tx.toggle_maximized()))
            .child(win("Close", crate::icons::ico_s("close", 14.0, t.dim), true, |_, tx| tx.close_window()))
    });
    let right = row().w(300.0).center_y().justify_end().pr(insets.trailing)
        .child(ibtn(t, "bell", "Notifications").no_window_drag().mr(if own_caption { 4.0 } else { 8.0 }))
        .children(caption);
    row().key("titlebar").w_full().h(TITLEBAR).center_y().gap(4.0).fill(t.rail).border_sides([0.0, 0.0, 1.0, 0.0], t.border).window_drag()
        .child(brand)
        .child(row().grow(1.0).min_w(0.0).center().child(cmdk))
        .child(right)
}

fn rail(s: &App, t: &Theme) -> El {
    let tab = |v: View, icon: &str, label: &'static str, badge: Option<&'static str>| {
        let on = s.view == v;
        el().key(format!("rail-{label}")).size(44.0, 44.0).radius(12.0).center().role("tab").label(label).checked(on).help(label).help_side(Side::Right)
            .fill(if on { t.active } else { Color::TRANSPARENT }).hover(t.hover)
            .child(ico(icon, if on { t.text } else { t.faint }))
            .children(on.then(|| el().absolute(-8.0, 12.0).size(3.0, 20.0).corners([0.0, 3.0, 3.0, 0.0]).fill(t.text)))
            .children(badge.map(|n| {
                el().absolute(26.0, 5.0).min_w(16.0).h(16.0).px(4.0).radius(8.0).fill(t.accent).center()
                    .child(text(n).font(theme::tabular(10.5, 700.0)).color(Color::WHITE))
            }))
            .on_press(move |s: &mut App| s.go(v))
    };
    col().key("rail").w(RAIL).h_full().py(10.0).gap(4.0).items_center().fill(t.rail).border_sides([0.0, 1.0, 0.0, 0.0], t.border).role("tablist")
        .child(tab(View::Board, "oai-users", "Agents", None))
        .child(tab(View::Office, "oai-office", "Office", None))
        .child(tab(View::Chat, "oai-chat", "Chat", None))
        .child(tab(View::Code, "code", "Code", None))
        .child(tab(View::Prs, "branch", "Pull requests", Some("3")))
        .child(tab(View::Apps, "link", "Apps", None))
        .child(el().grow(1.0))
        .child(tab(View::Settings, "oai-settings", "Settings", None))
}
