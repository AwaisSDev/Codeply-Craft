//! Chat, Codex-style: a sidebar of New chat, Search, Pinned, Recents and Projects, and a home
//! that asks "What should we build?". An open chat shows its transcript under a slim header.

use rune::{Cx, El, ScrollSpec, col, el, row, text};

use crate::app::{App, EditKey, Pane};
use crate::bot;
use crate::icons::{ico, ico_s};
use crate::model::ChatMeta;
use crate::store::Target;
use crate::theme::{Theme, ui};
use crate::ui::{btn_primary, composer, enter, fade_in, ibtn, me, name_and_line, sec, side_row, wave, ENTER};
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
        Some(ico_s("refresh", 14.0, t.dim).looping(rune::LoopSpec::rotation(1.0)))
    } else if c.unread {
        Some(el().size(6.0, 6.0).radius(3.0).fill(t.accent))
    } else {
        None
    };
    let more = el().key(format!("chat-more/{}", c.title)).size(26.0, 26.0).radius(7.0).center().role("button")
        .label(format!("More for {}", c.title)).help("More")
        .fill(if menu_open { t.active } else { rune::Color::TRANSPARENT }).hover(t.hover)
        .child(ico_s("more", 16.0, t.dim))
        .group_opacity(if menu_open { 1.0 } else { 0.0 }, 1.0)
        .on_press(move |s: &mut App| s.toggle_menu(&menu_id));
    side_row(t, on).hover_group().key(format!("chat/{}", c.title)).role("button").label(c.title.clone())
        .child(name_and_line(t, &c.title, Some(&c.project), 400.0))
        .children(status)
        .child(more)
        .on_press(move |s: &mut App| s.open_chat(&open_title))
}

pub fn side(s: &App, t: &Theme) -> El {
    // Agents' own chats live on their pages in Agents; Chat lists the chats Wisp leads.
    let is_agent = |c: &&ChatMeta| s.data.team.iter().any(|a| a.name == c.title);
    let chats: Vec<&ChatMeta> = s.data.extra.chats.iter().filter(|c| !is_agent(c)).collect();
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
    list = list.child(sec(t, None, "Recents", false));
    if recents.is_empty() {
        list = list.child(col().px(10.0).py(6.0)
            .child(text("No chats yet").font(ui(13.0, 400.0)).color(t.faint)));
    }
    let shown = if all { recents.len() } else { recents.len().min(RECENTS) };
    for c in recents.iter().take(shown) {
        list = list.child(enter(chat_row(s, t, c), i));
        i += 1;
    }
    if recents.len() > RECENTS {
        let label = if all { "Show less" } else { "Show more" };
        list = list.child(side_row(t, false).key("recents-more").role("button").label(label)
            .child(text(label).font(ui(13.5, 400.0)).color(t.faint))
            .on_press(|s: &mut App| s.toggle_expanded("recents-more")));
    }
    if !s.data.extra.projects.is_empty() {
        list = list.child(sec(t, None, "Projects", false));
        for p in &s.data.extra.projects {
            list = list.child(side_row(t, false).key(format!("project/{p}")).role("button").label(p.clone())
                .child(ico("oai-folder", t.dim))
                .child(text(p.clone()).font(ui(14.0, 400.0)).color(t.text).truncate().grow(1.0).min_w(0.0)));
        }
    }

    let top = col().px(8.0).pt(10.0).pb(2.0)
        .child(side_row(t, false).key("new-chat").role("button").label("New chat")
            .child(ico("oai-compose", t.text))
            .child(text("New chat").font(ui(14.0, 400.0)).color(t.text))
            .on_press(|s: &mut App| s.new_chat()))
        .child(side_row(t, false).key("search-row").role("button").label("Search")
            .child(ico("oai-search", t.text))
            .child(text("Search").font(ui(14.0, 400.0)).color(t.text)));
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
            row().key(format!("suggestion/{i}")).w_full().min_h(40.0).px(12.0).py(8.0).gap(12.0).radius(10.0).center_y()
                .hover(t.hover).role("button").label(label.clone())
                .child(crate::icons::ico_app(icon, 18.0, t.dim))
                .child(text(label.clone()).font(ui(14.0, 400.0)).color(t.dim).truncate().grow(1.0).min_w(0.0))
                .on_press(move |s: &mut App| {
                    s.edit_mut(EditKey::ChatHome).replace_text(value.clone());
                }),
            i,
        )
    }));
    let column = col().key("chat-home").w_full().max_w(720.0).transition(fade_in()).motion(ENTER)
        .child(row().center().pb(16.0).child(crate::logo::mark(44.0)))
        .child(row().center().pb(28.0).child(text("What should we build?").font(ui(28.0, 500.0)).color(t.text)))
        .child(suggestions)
        .child(composer(s, t, EditKey::ChatHome, Target::New, "Ask Codeply anything. @ to use plugins", true, false))
        .child(row().center().pt(12.0)
            .child(text(format!("Runs on {}", s.data.extra.engine)).font(ui(12.5, 400.0)).color(t.faint)));
    col().w_full().h_full().center().px(24.0).py(40.0).scroll(ScrollSpec { stick_bottom: false }).child(column)
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
        .child(ibtn(t, "external", "Share").key("chat-share"))
        .child(more);
    let thread = col().w_full().h_full().min_h(0.0).child(crate::thread::with_composer(
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
