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
    // Every change lands in the frame it's made: switching views, tabs and chats, rows coming and
    // going, hover colours. Nothing springs or fades behind it, so the window draws once and rests
    // (on the CPU renderer each frame of motion costs the whole window). Busy indicators keep
    // their own loops while something is running.
    col().key("root").w_full().h_full().fill(t.solid).instant_changes().motion(rune::Spring::NONE)
        .children(backdrop)
        .child(titlebar(s, &t, cx))
        .child(body)
        .children(appearance)
        .children(views::usage::sheet(s, &t))
        .children(views::update::sheet(s, &t))
        .children(views::upgrade::sheet(s, &t))
        .children(crate::team::dialog(s, &t))
        .children(views::code::dialog(s, &t))
        .children(views::chat::rename_dialog(s, &t))
        .children(views::code::completion(s, &t))
        .children(views::mention::popup(s, &t))
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
    if let Some(key) = id.strip_prefix("project:") {
        return Some(project_menu(s, t, key));
    }
    if id == "notifications" {
        return Some(notifications_menu(s, t));
    }
    if let Some(key) = id.strip_prefix("model:") {
        return Some(views::models::composer_menu(s, t, key));
    }
    if let Some(key) = id.strip_prefix("effort:") {
        return Some(views::models::effort_menu(s, t, key));
    }
    // `chat:` is opened from the chat's sidebar row, `chat-head:` from the open chat's header
    // (the chat may not be in the sidebar's recents, so each opens under its own button).
    let chat_menu = id.strip_prefix("chat:").map(|c| (c, format!("chat-more/{c}"), Side::Right, rune::Align::Start))
        .or_else(|| id.strip_prefix("chat-head:").map(|c| (c, format!("chat-head-more/{c}"), Side::Bottom, rune::Align::End)));
    if let Some((chat, anchor, side, align)) = chat_menu {
        let pinned = s.prefs.pinned.iter().any(|c| c == chat);
        let (r, a, b, c) = (chat.to_owned(), chat.to_owned(), chat.to_owned(), chat.to_owned());
        let divider = || rune::el().w_full().py(4.0).child(rune::el().w_full().h(1.0).fill(t.border));
        // Delete in red, as the destructive one.
        let delete = rune::row().key("chat-menu/delete").w_full().min_h(34.0).px(10.0).py(6.0).gap(10.0).radius(8.0).continuous_corners().center_y().hover(t.red.alpha(0.1))
            .role("menuitem").label("Delete")
            .child(crate::icons::ico_s("trash", 16.0, t.red))
            .child(rune::text("Delete").font(crate::theme::ui(13.5, 500.0)).color(t.red))
            .on_press(move |s: &mut App| s.delete_chat(&c));
        return Some(menu(t, &anchor, side, 200.0, vec![
            menu_item(t, "chat-menu/rename".into(), Some("edit"), "Rename", None, false).on_press_tx(move |s: &mut App, tx| { s.open_chat_rename(&r); tx.settle(); tx.focus("chat-title", true); }),
            menu_item(t, "chat-menu/pin".into(), Some("pick"), if pinned { "Unpin" } else { "Pin" }, None, false).on_press(move |s: &mut App| s.toggle_pin(&a)),
            divider(),
            menu_item(t, "chat-menu/archive".into(), Some("download"), "Archive", None, false).on_press(move |s: &mut App| s.archive(&b)),
            delete,
        ]).anchored(anchor.clone(), side, align, 6.0));
    }
    views::menu(s, t, id)
}

/// How tall one folder is in the folder menu; five show, the rest scroll (no scroll bar).
const FOLDER_ROW: f32 = 46.0;
const FOLDERS_SHOWN: usize = 5;

/// The composer's folder menu: the folders opened before (the open one checked), five at a
/// time with the rest a scroll away, then "Open folder...".
fn project_menu(s: &App, t: &Theme, key: &str) -> El {
    let here = s.data.extra.project_path.clone();
    let folders = s.recent_projects();
    let rows: Vec<El> = folders.iter().map(|path| {
        let on = path.trim_end_matches(['/', '\\']) == here.trim_end_matches(['/', '\\']);
        let p = path.clone();
        rune::row().key(format!("project-menu/{path}")).w_full().h(FOLDER_ROW).px(10.0).gap(10.0).radius(8.0).continuous_corners().center_y().hover(t.hover)
            .role("menuitem").label(crate::project::folder_name(path)).help(path.clone())
            .child(crate::icons::ico_s("oai-folder", 16.0, t.dim))
            .child(col().grow(1.0).min_w(0.0)
                .child(text(crate::project::folder_name(path)).font(ui(13.5, 500.0)).color(t.text).truncate())
                .child(text(path.clone()).font(ui(11.5, 400.0)).color(t.faint).truncate()))
            .children(on.then(|| crate::icons::ico_s("check", 16.0, t.text)))
            .on_press(move |s: &mut App| s.switch_project(&p))
    }).collect();
    let mut items = Vec::new();
    if rows.is_empty() {
        items.push(text("No folders yet").font(ui(12.5, 400.0)).color(t.faint).px(10.0).py(8.0));
    } else {
        let height = FOLDER_ROW * rows.len().min(FOLDERS_SHOWN) as f32 + 2.0 * (rows.len().min(FOLDERS_SHOWN).saturating_sub(1)) as f32;
        items.push(text("Recent folders").font(ui(12.0, 600.0)).color(t.faint).px(10.0).pt(4.0).pb(2.0));
        items.push(col().key(format!("project-menu-list/{key}")).w_full().h(height).gap(2.0).scroll(rune::ScrollSpec { stick_bottom: false }).children(rows));
    }
    items.push(el().w_full().py(4.0).child(el().w_full().h(1.0).fill(t.border)));
    items.push(menu_item(t, "project-menu/open".into(), Some("folder-open"), "Open folder...", None, false)
        .on_press_tx(|s: &mut App, tx| { s.menu = None; s.open_project(tx); }));
    menu(t, &format!("project-chip/{key}"), Side::Bottom, 320.0, items)
}

/// The bell: what needs you (approvals waiting) and chats with something new.
fn notifications_menu(s: &App, t: &Theme) -> El {
    let mut items: Vec<El> = Vec::new();
    for (chat, id, title) in s.data.waiting().into_iter().take(8) {
        let c = chat.clone();
        items.push(menu_item(t, format!("note/ask/{id}"), Some("approve-ask"), &title, Some(&format!("Waiting for you in {chat}")), false)
            .on_press(move |s: &mut App| s.open_chat(&c)));
    }
    for c in s.data.extra.chats.iter().filter(|c| c.unread).take(8) {
        let title = c.title.clone();
        items.push(menu_item(t, format!("note/unread/{}", c.title), Some("chat"), &c.title, Some("New reply"), false)
            .on_press(move |s: &mut App| s.open_chat(&title)));
    }
    // Background runs that stopped to ask you something, then the latest reports and reminders.
    let x = &s.data.extra.agents;
    for (i, h) in x.health.iter().filter(|h| h.needs_you()).take(4).enumerate() {
        let agent = h.agent.clone();
        let name = s.data.agent(&h.agent).map_or_else(|| h.agent.clone(), |a| a.name.clone());
        items.push(menu_item(t, format!("note/health/{i}"), Some("approve-ask"), &format!("{name} needs you"), Some(&h.reason), false)
            .on_press(move |s: &mut App| s.open_agent(Some(&agent))));
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    for (i, r) in x.reports.iter().take(5).enumerate() {
        let when = crate::agentsync::ago(r.at, now);
        let (icon, title) = if r.reminder {
            ("bell", format!("Reminder from {}", r.who))
        } else if r.ok {
            ("check", format!("{}: standing job done", r.who))
        } else {
            ("alert", format!("{}: the job did not finish", r.who))
        };
        let line = r.text.lines().find(|l| !l.trim().is_empty() && !l.starts_with("-# ")).unwrap_or_default();
        let (chat, reminder) = (r.chat.clone(), r.reminder);
        items.push(menu_item(t, format!("note/report/{i}"), Some(icon), &title, Some(&format!("{line} · {when}")), false)
            .on_press(move |s: &mut App| {
                s.menu = None;
                // A chat that isn't on this PC (yet) opens the agents' list instead.
                if reminder {
                    s.open_reminders();
                } else if !chat.is_empty() {
                    s.open_chat(&chat);
                } else {
                    s.open_agent(None);
                }
            }));
    }
    if items.is_empty() {
        items.push(menu_item(t, "note/none".into(), Some("check"), "You're all caught up", Some("Approvals, new replies, job reports and reminders show here."), false));
    }
    if !s.prefs.notifications {
        items.push(menu_item(t, "note/off".into(), Some("bell"), "Notifications are off", Some("Turn them on in Settings > General to see these outside the app."), false));
    }
    menu(t, "titlebar-bell", Side::Bottom, 300.0, items).anchored("titlebar-bell".to_owned(), Side::Bottom, rune::Align::End, 6.0)
}

fn titlebar(s: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let insets = cx.chrome_insets();
    // On Windows Rune draws the real caption buttons in `insets.trailing`; macOS keeps its traffic
    // lights and Linux its native frame. Headless renders have neither, so they get Windows-style
    // stand-ins (that still minimize, maximize and close).
    let own_caption = insets.trailing == 0.0 && rune::is_headless();
    let brand = row().w(300.0).gap(9.0).center_y().pl(14.0 + insets.leading)
        .child(crate::logo::mark(22.0))
        .child(text("Yune").font(ui(14.5, 700.0)).color(t.text))
        .child(el().px(6.0).h(18.0).radius(5.0).continuous_corners().center().fill(t.accent.alpha(0.16)).child(text("Beta").font(ui(10.5, 700.0)).color(t.accent)));
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
        .children(views::update::pill(s, t))
        .child(bell(s, t).no_window_drag().mr(if own_caption { 4.0 } else { 8.0 }))
        .children(caption);
    row().key("titlebar").w_full().h(TITLEBAR).center_y().gap(4.0).fill(t.rail).border_sides([0.0, 0.0, 1.0, 0.0], t.border).window_drag()
        .child(brand)
        .child(el().grow(1.0))
        .child(right)
}

/// The titlebar's bell, with a dot while something needs you or a chat has news.
fn bell(s: &App, t: &Theme) -> El {
    let news = !s.data.waiting().is_empty() || s.data.extra.chats.iter().any(|c| c.unread) || s.data.extra.agents.health.iter().any(|h| h.needs_you());
    let open = s.menu.as_deref() == Some("notifications");
    ibtn(t, "bell", "Notifications").key("titlebar-bell")
        .fill(if open { t.active } else { Color::TRANSPARENT })
        .children(news.then(|| el().absolute(19.0, 6.0).size(7.0, 7.0).radius(3.5).fill(t.accent)))
        .on_press(|s: &mut App| s.toggle_menu("notifications"))
}

fn rail(s: &App, t: &Theme) -> El {
    let open_prs = s.data.prs.iter().filter(|p| p.state != crate::model::PrState::Merged).count();
    let waiting = s.data.waiting().len();
    let tab = |v: View, icon: &str, label: &'static str, badge: Option<String>| {
        let on = s.view == v;
        el().key(format!("rail-{label}")).size(44.0, 44.0).radius(12.0).continuous_corners().center().role("tab").label(label).checked(on).help(label).help_side(Side::Right)
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
