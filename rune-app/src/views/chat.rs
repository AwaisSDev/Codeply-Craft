//! Chat, Codex-style: a sidebar of New chat, Search, Pinned, Recents and Projects, and a home
//! that asks "What should we build?". An open chat shows its transcript under a slim header.

use rune::{Cx, El, ScrollSpec, col, el, row, text};

use crate::app::{App, EditKey};
use crate::bot;
use crate::icons::{ico, ico_s};
use crate::model::ChatMeta;
use crate::store::Target;
use crate::theme::{Theme, ui};
use crate::ui::{composer, enter, fade_in, ibtn, me, name_and_line, sec, side_row, ENTER};

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
    let chats = &s.data.extra.chats;
    let pinned: Vec<&ChatMeta> = chats.iter().filter(|c| s.prefs.pinned.contains(&c.title)).collect();
    let recents: Vec<&ChatMeta> = chats
        .iter()
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
        None => home(s, t),
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
                .child(ico_s(icon, 16.0, t.dim))
                .child(text(label.clone()).font(ui(14.0, 400.0)).color(t.dim).truncate().grow(1.0).min_w(0.0))
                .on_press(move |s: &mut App| {
                    s.edit_mut(EditKey::ChatHome).replace_text(value.clone());
                }),
            i,
        )
    }));
    let column = col().key("chat-home").w_full().max_w(720.0).transition(fade_in()).motion(ENTER)
        .child(row().center().pb(16.0).child(bot::wisp(40.0)))
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
        .child(text(chat.to_owned()).font(ui(14.5, 600.0)).color(t.text).truncate().shrink().min_w(0.0))
        .children((!project.is_empty()).then(|| text(project).font(ui(13.0, 400.0)).color(t.faint).truncate().shrink().min_w(0.0)))
        .child(el().grow(1.0))
        .child(ibtn(t, "external", "Share").key("chat-share"))
        .child(more);
    col().w_full().h_full()
        .child(header)
        .child(el().w_full().grow(1.0).min_h(0.0).child(crate::thread::with_composer(
            s, t, chat, "Wisp", EditKey::ChatThread, Target::Chat(String::new()), "Ask for follow-up changes", 780.0,
        )))
}
