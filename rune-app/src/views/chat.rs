//! Chat, Codex-style: a sidebar of New chat, Search, Pinned, Recents and Projects, and a home
//! that asks "What should we build?". An open chat shows its transcript under a slim header.

use rune::{Cx, El, ScrollSpec, col, el, row, text, text_input};

use crate::app::{App, EditKey, Pane};
use crate::icons::{ico, ico_s};
use crate::model::ChatMeta;
use crate::store::Target;
use crate::theme::{Theme, ui};
use crate::ui::{btn_primary, composer, enter, ibtn, me, name_and_line, sec, side_row, wave};
use crate::views::{browser, tasks, terminal};

/// How many recents show before "Show more".
const RECENTS: usize = 8;

/// One chat in the sidebar: title, project, then a status (unread dot or spinner) and the hover
/// "more" button.
fn chat_row(s: &App, t: &Theme, c: &ChatMeta) -> El {
    let on = s.chat.as_deref() == Some(c.title.as_str());
    let open_title = c.title.clone();
    let menu_id = format!("chat:{}", c.title);
    let menu_open = s.menu.as_deref() == Some(menu_id.as_str());
    let status = if c.running {
        // A still icon: a spinner would redraw the whole window every frame for as long as the
        // chat runs, on the CPU renderer.
        Some(ico_s("history", 14.0, t.dim).help("Working"))
    } else if c.unread {
        Some(el().size(6.0, 6.0).radius(3.0).fill(t.accent))
    } else {
        None
    };
    let more = el().key(format!("chat-more/{}", c.title)).size(26.0, 26.0).radius(7.0).continuous_corners().center().role("button")
        .label(format!("More for {}", c.title)).help("More")
        .fill(if menu_open { t.active } else { rune::Color::TRANSPARENT }).hover(t.hover)
        .child(ico_s("more", 16.0, t.dim))
        .group_opacity(if menu_open { 1.0 } else { 0.0 }, 1.0)
        .on_press(move |s: &mut App| s.toggle_menu(&menu_id));
    side_row(t, on).hover_group().key(format!("chat/{}", c.title)).role("button").label(c.title.clone())
        .child(name_and_line(t, &c.title, Some(&c.project), 400.0))
        .children(status)
        .child(more)
        // Opening a chat lands it whole: a reply that's still streaming doesn't replay its reveal.
        .on_press_tx(move |s: &mut App, tx| { tx.settle(); s.open_chat(&open_title) })
}

pub fn side(s: &App, t: &Theme) -> El {
    // Only your chats: agents' sessions live on their pages in Agents, and the code view's chat
    // beside the editor. Search narrows them by title and last message.
    let query = if s.chat_search { s.edit(EditKey::Search).text.trim().to_lowercase() } else { String::new() };
    let found = |c: &&ChatMeta| query.is_empty() || c.title.to_lowercase().contains(&query) || c.preview.to_lowercase().contains(&query);
    let chats: Vec<&ChatMeta> = s.data.extra.chats.iter().filter(|c| c.kind == crate::model::ChatKind::Chat).filter(found).collect();
    let pinned: Vec<&ChatMeta> = chats.iter().copied().filter(|c| s.prefs.pinned.contains(&c.title)).collect();
    let recents: Vec<&ChatMeta> = chats
        .iter()
        .copied()
        .filter(|c| !s.prefs.archived.contains(&c.title) && !s.prefs.pinned.contains(&c.title))
        .collect();
    let all = s.expanded.contains("recents-more");

    let mut list = col().px(8.0).pb(10.0);
    let mut i = 0;
    if !pinned.is_empty() {
        list = list.child(sec(t, None, "Pinned", false));
        for c in &pinned {
            list = list.child(enter(chat_row(s, t, c), i));
            i += 1;
        }
    }
    list = list.child(sec(t, None, if query.is_empty() { "Recents" } else { "Results" }, false));
    if recents.is_empty() {
        list = list.child(col().px(10.0).py(6.0)
            .child(text(if query.is_empty() { "No chats yet" } else { "No chats match" }).font(ui(13.0, 400.0)).color(t.faint)));
    }
    let shown = if all || !query.is_empty() { recents.len() } else { recents.len().min(RECENTS) };
    for c in recents.iter().take(shown) {
        list = list.child(enter(chat_row(s, t, c), i));
        i += 1;
    }
    if recents.len() > RECENTS && query.is_empty() {
        let label = if all { "Show less" } else { "Show more" };
        list = list.child(side_row(t, false).key("recents-more").role("button").label(label)
            .child(text(label).font(ui(13.5, 400.0)).color(t.faint))
            .on_press(|s: &mut App| s.toggle_expanded("recents-more")));
    }
    if !s.data.extra.projects.is_empty() && query.is_empty() {
        list = list.child(sec(t, None, "Projects", false));
        for p in &s.data.extra.projects {
            // Opens that folder as the project (when it was opened here before) and starts a
            // new chat in it.
            let path = s.prefs.recent_projects.iter().find(|r| crate::project::folder_name(r) == *p).cloned();
            let on = s.data.project == *p;
            list = list.child(side_row(t, false).key(format!("project/{p}")).role("button").label(p.clone())
                .help(path.clone().unwrap_or_else(|| p.clone()))
                .child(ico("oai-folder", if on { t.text } else { t.dim }))
                .child(text(p.clone()).font(ui(14.0, if on { 600.0 } else { 400.0 })).color(t.text).truncate().grow(1.0).min_w(0.0))
                .on_press_tx(move |s: &mut App, tx| {
                    if let Some(path) = &path {
                        s.switch_project(path);
                    }
                    s.new_chat();
                    tx.settle();
                    tx.focus("composer-chat-home", false);
                }));
        }
    }

    let top = col().px(8.0).pt(10.0).pb(2.0)
        .child(side_row(t, false).key("new-chat").role("button").label("New chat")
            .child(ico("oai-compose", t.text))
            .child(text("New chat").font(ui(14.0, 400.0)).color(t.text))
            .on_press(|s: &mut App| s.new_chat()))
        .child(if s.chat_search {
            side_row(t, true).key("search-row")
                .child(ico("oai-search", t.text))
                .child(text_input(s.edit(EditKey::Search), ui(14.0, 400.0)).key("chat-search").single_line().grow(1.0).min_w(0.0)
                    .color(t.text).placeholder("Search chats", t.faint).caret(t.accent, t.accent.alpha(0.3)).label("Search chats")
                    .on_edit(|s: &mut App| s.edit_mut(EditKey::Search)))
                .child(el().key("chat-search-close").size(22.0, 22.0).radius(6.0).continuous_corners().center().hover(t.hover).role("button").label("Close search")
                    .child(ico_s("close", 13.0, t.dim))
                    .on_press(|s: &mut App| { s.chat_search = false; s.edit_mut(EditKey::Search).clear(); }))
        } else {
            side_row(t, false).key("search-row").role("button").label("Search")
                .child(ico("oai-search", t.text))
                .child(text("Search").font(ui(14.0, 400.0)).color(t.text))
                .on_press_tx(|s: &mut App, tx| { s.chat_search = true; tx.focus("chat-search", false); })
        });
    col().h_full().min_h(0.0)
        .child(top)
        .child(col().grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(list))
        .child(me(s, t))
}

pub fn main(s: &App, t: &Theme, _cx: &mut Cx<App>) -> El {
    match &s.chat {
        None => workspace(s, t, home(s, t)),
        Some(chat) => open(s, t, chat),
    }
}

/// Codex has no menu of its own here: the shell draws the chat "more" menu.
pub fn menu(_s: &App, _t: &Theme, _id: &str) -> Option<El> {
    None
}

fn home(s: &App, t: &Theme) -> El {
    let suggestions = col().w_full().pb(20.0).children(s.data.extra.suggestions.iter().enumerate().map(|(i, (icon, label))| {
        let value = label.clone();
        enter(
            row().key(format!("suggestion/{i}")).w_full().min_h(40.0).px(12.0).py(8.0).gap(12.0).radius(10.0).continuous_corners().center_y()
                .hover(t.hover).role("button").label(label.clone())
                .child(crate::icons::ico_app(icon, 18.0, t.dim))
                .child(text(label.clone()).font(ui(14.0, 400.0)).color(t.dim).truncate().grow(1.0).min_w(0.0))
                .on_press(move |s: &mut App| {
                    s.edit_mut(EditKey::ChatHome).replace_text(value.clone());
                }),
            i,
        )
    }));
    let column = col().key("chat-home").w_full().max_w(720.0)
        .child(row().center().pb(16.0).child(crate::logo::mark(44.0)))
        .child(row().center().pb(28.0).child(text("What should we build?").font(ui(28.0, 500.0)).color(t.text)))
        .child(suggestions)
        .child(composer(s, t, EditKey::ChatHome, Target::New, "Ask Yune anything. / for skills, @ to mention", true, false));
    let page = col().w_full().h_full().center().px(24.0).py(40.0).scroll(ScrollSpec { stick_bottom: false }).child(column);
    // Flowing dots, when chosen, live here only: behind the home page, not the sidebar or a chat.
    match crate::views::themes::flow_layer(s, t) {
        Some(dots) => el().w_full().h_full().clip_rounded(0.0).child(dots).child(page),
        None => page,
    }
}

fn open(s: &App, t: &Theme, chat: &str) -> El {
    let project = s.data.chat(chat).map(|c| c.project.clone()).unwrap_or_default();
    let menu_id = format!("chat-head:{chat}");
    let menu_open = s.menu.as_deref() == Some(menu_id.as_str());
    // The sidebar's row for this chat owns the key `chat-more/{title}`, and the chat may not be
    // in the sidebar at all, so the header's button has its own key and menu id (shell.rs).
    let more = ibtn(t, "more", "More").key(format!("chat-head-more/{chat}"))
        .fill(if menu_open { t.active } else { rune::Color::TRANSPARENT })
        .on_press(move |s: &mut App| s.toggle_menu(&menu_id));
    let header = row().w_full().h(48.0).px(20.0).gap(10.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.border)
        .child(crate::bot::wisp(24.0))
        .child(text(chat.to_owned()).font(ui(14.5, 600.0)).color(t.text).truncate().shrink().min_w(0.0))
        .children((!project.is_empty()).then(|| text(project).font(ui(13.0, 400.0)).color(t.faint).truncate().shrink().min_w(0.0)))
        .child(el().grow(1.0))
        .children(publish_bits(s, t))
        .child(pane_toggle(s, t, "globe", "Browser", "pane-browser", Pane::Browser, s.panes.browser))
        .child(pane_toggle(s, t, "list", "Background tasks", "pane-tasks", Pane::Tasks, s.panes.tasks))
        .child(pane_toggle(s, t, "terminal", "Terminal", "pane-terminal", Pane::Terminal, s.panes.terminal))
        .child(more);
    let thread = col().w_full().h_full().min_h(0.0).child(crate::views::upgrade::with_composer(
        s, t, chat, "Wisp", EditKey::ChatThread, Target::Chat(String::new()), "Ask for follow-up changes", 780.0,
    ));
    col().w_full().h_full()
        .child(header)
        .child(col().w_full().grow(1.0).min_h(0.0).child(workspace(s, t, thread)))
}

/// A header toggle for one pane, filled while the pane is open.
fn pane_toggle(s: &App, t: &Theme, icon: &str, label: &str, key: &str, pane: Pane, on: bool) -> El {
    let _ = s;
    ibtn(t, icon, label).key(key.to_owned())
        .fill(if on { t.active } else { rune::Color::TRANSPARENT })
        .on_press(move |s: &mut App| s.toggle_pane(pane))
}

/// The Publish button, its progress, and a chip with the published link.
fn publish_bits(s: &App, t: &Theme) -> Vec<El> {
    let mut bits = Vec::new();
    let state = s.data.extra.publish.as_ref();
    if state.is_some_and(|p| p.running) {
        bits.push(row().h(32.0).px(8.0).center_y().child(wave("Publishing", ui(12.5, 500.0), t.dim)));
    }
    if let Some(url) = state.and_then(|p| p.url.clone()) {
        let u = url.clone();
        bits.push(row().key("publish-link").h(28.0).max_w(200.0).px(10.0).gap(6.0).radius(14.0).center_y().fill(t.hover).hover(t.active)
            .role("link").label(url.clone())
            .child(ico_s("globe", 14.0, t.accent))
            .child(text(url).font(ui(12.5, 400.0)).color(t.text).truncate().shrink().min_w(0.0))
            .on_press(move |s: &mut App| s.browse(&u)));
    }
    bits.push(btn_primary(t, "Publish", "arrow-up-right").key("publish").on_press(|s: &mut App| s.publish()));
    bits
}

/// The chat on the left (at least 45% of the width, 380 pt) and the open panes to its right: the
/// browser over the terminal in one column, background tasks in a narrow column on the far right.
/// With no pane open the chat fills the width.
fn workspace(s: &App, t: &Theme, main: El) -> El {
    let p = s.panes;
    if !(p.browser || p.terminal || p.tasks) {
        return main;
    }
    let both = p.browser && p.terminal;
    let mut cols = row().w_full().h_full().min_h(0.0)
        .child(col().grow(if p.browser || p.terminal { 9.0 } else { 1.0 }).min_w(380.0).h_full().min_h(0.0).child(main));
    if p.browser || p.terminal {
        let mut right = col().grow(11.0).min_w(0.0).h_full().min_h(0.0).border_sides([0.0, 0.0, 0.0, 1.0], t.border);
        if p.browser {
            right = right.child(col().w_full().grow(if both { 62.0 } else { 1.0 }).min_h(0.0).child(browser::pane(s, t)));
        }
        if p.terminal {
            let wrap = col().w_full().grow(if both { 38.0 } else { 1.0 }).min_h(0.0);
            right = right.child(if both { wrap.border_sides([1.0, 0.0, 0.0, 0.0], t.border) } else { wrap }.child(terminal::pane(s, t)));
        }
        cols = cols.child(right);
    }
    if p.tasks {
        cols = cols.child(tasks::pane(s, t));
    }
    cols
}

/// A chat's menu > Rename: its name in a field, Enter or Rename to keep it.
pub fn rename_dialog(s: &App, t: &Theme) -> Option<El> {
    let chat = s.chat_rename.as_ref()?;
    let field = row().w_full().h(38.0).px(12.0).radius(10.0).continuous_corners().clip_rounded(10.0).center_y().fill(t.field).border(1.0, t.field_border)
        .child(text_input(s.edit(EditKey::ChatTitle), ui(14.0, 400.0)).key("chat-title").single_line().grow(1.0).min_w(0.0).color(t.text)
            .placeholder(chat.clone(), t.faint).caret(t.accent, t.accent.alpha(0.3)).label("Name")
            .on_edit(|s: &mut App| s.edit_mut(EditKey::ChatTitle))
            .on_submit(|s: &mut App, _| s.submit_chat_rename()));
    let card = col().key("chat-rename").w(420.0).padding(22.0).gap(14.0).radius(16.0).continuous_corners()
        .fill(t.card).border(1.0, t.card_border).shadow(16.0, 48.0, crate::theme::rgba(0, 0, 0, 0.45))
        .transition(crate::ui::fade_in()).motion(crate::ui::ENTER).role("dialog").label("Rename chat")
        .modal(true, |s: &mut App| s.chat_rename = None)
        .child(text("Rename chat").font(ui(16.0, 600.0)).color(t.text))
        .child(field)
        .child(row().w_full().gap(8.0).justify_end()
            .child(crate::ui::btn(t, "Cancel", None, crate::model::ButtonKind::Plain).key("chat-rename-cancel").on_press(|s: &mut App| s.chat_rename = None))
            .child(row().key("chat-rename-ok").h(32.0).px(14.0).radius(9.0).continuous_corners().center_y().fill(t.accent).role("button").label("Rename")
                .child(text("Rename").font(ui(13.0, 600.0)).color(rune::Color::WHITE))
                .on_press(|s: &mut App| s.submit_chat_rename())));
    Some(col().key("chat-rename-scrim").pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).center().fill(crate::theme::rgba(0, 0, 0, 0.4)).child(card))
}
