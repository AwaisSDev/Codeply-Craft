//! The frame: a Windows-style titlebar with the Ctrl K search, the 60 pt activity rail, the
//! contextual sidebar and the main area. Settings takes the whole window below the titlebar,
//! Codex-style, with its own list of pages and "Back to app".

use rune::{Color, Cx, El, Side, Tx, col, el, row, text};

use crate::app::{App, View};
use crate::icons::ico;
use crate::prefs::Approval;
use crate::theme::{self, Theme, ui};
use crate::ui::{ibtn, menu, menu_item};
use crate::views;

pub const TITLEBAR: f32 = 44.0;
pub const RAIL: f32 = 60.0;
pub const SIDE: f32 = 268.0;

pub fn view(s: &App, cx: &mut Cx<App>) -> El {
    let look = &s.prefs.look;
    theme::set_text(look.scale(), look.bold());
    let mut t = theme::resolve(look, cx.system_dark());
    // A background shows through the frame: the plain fills turn see-through (cards, menus and the
    // composer stay solid, so text on them reads as before) and a dimming layer sits behind.
    let backdrop = views::themes::backdrop(s, &t);
    if backdrop.is_some() {
        t.bg = Color::TRANSPARENT;
        t.side = t.side.alpha(0.78);
        t.rail = t.rail.alpha(0.78);
    }
    cx.caption_color(t.dim);
    s.reduced.set(cx.is_reduced_motion());
    let body = if s.view == View::Settings {
        row().key("settings-page").w_full().grow(1.0).min_h(0.0).child(views::settings::page(s, &t, cx))
    } else {
        let (side, main) = views::build(s, &t, cx);
        row().w_full().grow(1.0).min_h(0.0)
            .child(rail(s, &t))
            .children(side.map(|sd| {
                col().key("side").w(SIDE).h_full().min_h(0.0).fill(t.side).border_sides([0.0, 1.0, 0.0, 0.0], t.border).child(sd)
            }))
            .child(col().key("main").grow(1.0).h_full().min_w(0.0).min_h(0.0).fill(t.bg).clip_rounded(0.0).child(main))
    };
    // Popovers attach at the root so they draw above everything and escape clipping.
    let appearance = s.appearance.as_ref().and_then(|id| s.data.agent(id)).map(|a| views::appearance::popover(s, &t, a));
    col().key("root").w_full().h_full().fill(t.solid)
        .children(backdrop)
        .child(titlebar(s, &t, cx))
        .child(body)
        .children(appearance)
        .children(views::usage::sheet(s, &t))
        .children(views::apps::dialog(s, &t))
        .children(menus(s, &t))
}

/// The open dropdown, if any: the composer's approval and model menus, and each chat's
/// "more" menu (pin, archive). Views add their own through `views::menu`.
fn menus(s: &App, t: &Theme) -> Option<El> {
    let id = s.menu.as_deref()?;
    if let Some(key) = id.strip_prefix("approval:") {
        let item = |a: Approval, icon: &str, note: &str| {
            menu_item(t, format!("approval/{}", a.name()), Some(icon), a.label(), Some(note), s.prefs.approval == a)
                .on_press(move |s: &mut App| s.set_approval(a))
        };
        return Some(menu(t, &format!("approval-chip/{key}"), Side::Top, 280.0, vec![
            item(Approval::Ask, "approve-ask", "Asks before every write, edit or command"),
            item(Approval::Auto, "approve-full", "Runs commands and edits files without asking"),
        ]));
    }
    if let Some(key) = id.strip_prefix("model:") {
        return Some(views::models::composer_menu(s, t, key));
    }
    // `chat:` is opened from the chat's sidebar row, `chat-head:` from the open chat's header
    // (the chat may not be in the sidebar's recents, so each opens under its own button).
    let chat_menu = id.strip_prefix("chat:").map(|c| (c, format!("chat-more/{c}"), Side::Right, rune::Align::Start))
        .or_else(|| id.strip_prefix("chat-head:").map(|c| (c, format!("chat-head-more/{c}"), Side::Bottom, rune::Align::End)));
    if let Some((chat, anchor, side, align)) = chat_menu {
        let pinned = s.prefs.pinned.iter().any(|c| c == chat);
        let (a, b) = (chat.to_owned(), chat.to_owned());
        return Some(menu(t, &anchor, side, 200.0, vec![
            menu_item(t, "chat-menu/pin".into(), Some("pick"), if pinned { "Unpin" } else { "Pin" }, None, false).on_press(move |s: &mut App| s.toggle_pin(&a)),
            menu_item(t, "chat-menu/archive".into(), Some("download"), "Archive", None, false).on_press(move |s: &mut App| s.archive(&b)),
        ]).anchored(anchor.clone(), side, align, 6.0));
    }
    views::menu(s, t, id)
}

fn titlebar(_s: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let insets = cx.chrome_insets();
    // On Windows Rune draws the real caption buttons in `insets.trailing`; macOS keeps its traffic
    // lights and Linux its native frame. Headless renders have neither, so they get Windows-style
    // stand-ins (that still minimize, maximize and close).
    let own_caption = insets.trailing == 0.0 && rune::is_headless();
    let brand = row().w(300.0).gap(9.0).center_y().pl(14.0 + insets.leading)
        .child(crate::logo::mark(22.0))
        .child(text("Codeply").font(ui(14.5, 700.0)).color(t.text))
        .child(el().px(6.0).h(18.0).radius(5.0).center().fill(t.accent.alpha(0.16)).child(text("Beta").font(ui(10.5, 700.0)).color(t.accent)));
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
    let right = row().w(300.0).gap(4.0).center_y().justify_end().pr(insets.trailing)
        .child(ibtn(t, "bell", "Notifications").no_window_drag().mr(if own_caption { 4.0 } else { 8.0 }))
        .children(caption);
    row().key("titlebar").w_full().h(TITLEBAR).center_y().gap(4.0).fill(t.rail).border_sides([0.0, 0.0, 1.0, 0.0], t.border).window_drag()
        .child(brand)
        .child(el().grow(1.0))
        .child(right)
}

fn rail(s: &App, t: &Theme) -> El {
    let open_prs = s.data.prs.iter().filter(|p| p.state != crate::model::PrState::Merged).count();
    let waiting = s.data.waiting().len();
    let tab = |v: View, icon: &str, label: &'static str, badge: Option<String>| {
        let on = s.view == v;
        el().key(format!("rail-{label}")).size(44.0, 44.0).radius(12.0).center().role("tab").label(label).checked(on).help(label).help_side(Side::Right)
            .fill(if on { t.active } else { Color::TRANSPARENT }).hover(t.hover)
            .child(ico(icon, if on { t.text } else { t.faint }))
            .children(on.then(|| el().absolute(-8.0, 12.0).size(3.0, 20.0).corners([0.0, 3.0, 3.0, 0.0]).fill(t.text)))
            .children(badge.map(|n| {
                el().absolute(26.0, 5.0).min_w(16.0).h(16.0).px(4.0).radius(8.0).fill(t.accent).center()
                    .child(text(n).font(theme::tabular(10.5, 700.0)).color(t.on_accent))
            }))
            .on_press(move |s: &mut App| s.go(v))
    };
    col().key("rail").w(RAIL).h_full().py(10.0).gap(4.0).items_center().fill(t.rail).border_sides([0.0, 1.0, 0.0, 0.0], t.border).role("tablist")
        .child(tab(View::Chat, "chat", "Chat", None))
        .child(tab(View::Agents, "oai-users", "Agents", (waiting > 0).then(|| waiting.to_string())))
        .child(tab(View::Code, "code", "Code", None))
        .child(tab(View::Prs, "branch", "Pull requests", (open_prs > 0).then(|| open_prs.to_string())))
        .child(tab(View::Integrations, "link", "Integrations", None))
        .child(el().grow(1.0))
        .child(tab(View::Settings, "oai-settings", "Settings", None))
}
