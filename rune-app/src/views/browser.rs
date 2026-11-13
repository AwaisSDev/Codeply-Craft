//! Browser: tabs down the sidebar, then bookmarks; a toolbar with back, forward, reload and
//! the address bar; and the page. On Windows the page is a WebView2 laid over the element keyed
//! `browser-page` (see `crate::browser`); elsewhere that area offers the system browser.

use rune::{Color, El, InlineIcon, ScrollSpec, col, el, row, text, text_input};

use crate::app::{App, EditKey};
use crate::browser::Browser;
use crate::favicon;
use crate::icons::{ico, ico_s};
use crate::theme::{self, Theme, ui};
use crate::ui::{enter, ibtn, me, sec, side_head, side_row};

/// A site's icon at `size`, or a globe until it arrives.
fn site_icon(t: &Theme, url: &str, size: f32) -> El {
    match favicon::get(url) {
        Some(px) => text(" ").inline_icon(0, InlineIcon::image(px).size(size).gap(0.0).radius(3.0)).w(size).h(size),
        None => ico_s("globe", size, t.faint),
    }
}

pub fn side(s: &App, t: &Theme) -> El {
    let mut list = col().px(8.0).pb(10.0);
    list = list.child(side_row(t, false).key("browser-new-tab").role("button").label("New tab")
        .child(ico("plus", t.dim)).child(text("New tab").font(ui(14.0, 400.0)).color(t.text))
        .on_press(|s: &mut App| {
            let home = s.prefs.home.clone();
            s.browser.new_tab(&home);
        }));
    list = list.child(sec(t, None, "Tabs", false));
    for (i, tab) in s.browser.tabs.iter().enumerate() {
        let on = i == s.browser.active;
        let close = el().key(format!("tab-close/{}", tab.id)).size(22.0, 22.0).radius(6.0).center().hover(t.hover).role("button").label("Close tab")
            .group_opacity(if on { 1.0 } else { 0.0 }, 1.0)
            .child(ico_s("close", 14.0, t.dim))
            .on_press(move |s: &mut App| s.browser.close_tab(i));
        list = list.child(enter(side_row(t, on).key(format!("tab/{}", tab.id)).hover_group().role("tab").checked(on).label(tab.title.clone())
            .child(site_icon(t, &tab.url, 16.0))
            .child(text(if tab.loading { format!("{} ...", tab.title) } else { tab.title.clone() }).font(ui(14.0, 400.0)).color(t.text).truncate().grow(1.0).min_w(0.0))
            .child(close)
            .on_press(move |s: &mut App| s.browser.select(i)), i + 1));
    }
    list = list.child(sec(t, None, "Bookmarks", false));
    for (title, url) in &s.prefs.bookmarks {
        let u = url.clone();
        list = list.child(side_row(t, false).key(format!("bookmark/{url}")).role("link").label(title.clone())
            .child(site_icon(t, url, 16.0))
            .child(text(title.clone()).font(ui(14.0, 400.0)).color(t.text).truncate().grow(1.0).min_w(0.0))
            .on_press(move |s: &mut App| s.browse(&u)));
    }
    col().h_full().min_h(0.0)
        .child(side_head(t, "Browser", None))
        .child(col().grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(list))
        .child(me(s, t))
}

pub fn main(s: &App, t: &Theme) -> El {
    let tab = s.browser.current().cloned();
    let url = tab.as_ref().map(|t| t.url.clone()).unwrap_or_default();
    let bookmarked = s.prefs.bookmarks.iter().any(|(_, u)| *u == url);
    let address = text_input(s.edit(EditKey::Address), ui(13.5, 400.0)).key("address").single_line().grow(1.0).min_w(0.0).color(t.text)
        .placeholder(if url.is_empty() { "Search or type a URL".to_owned() } else { url.clone() }, t.faint).caret(t.accent, t.accent.alpha(0.3)).label("Address")
        .on_edit(|s: &mut App| s.edit_mut(EditKey::Address))
        .on_submit(|s: &mut App, _| {
            let typed = s.edit(EditKey::Address).text.trim().to_owned();
            if !typed.is_empty() {
                s.browse(&typed);
                s.edit_mut(EditKey::Address).clear();
            }
        });
    let star_url = url.clone();
    let star_title = tab.as_ref().map(|t| t.title.clone()).unwrap_or_default();
    let toolbar = row().key("browser-toolbar").h(48.0).px(12.0).gap(4.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.border)
        .child(ibtn(t, "arrow-left", "Back").key("browser-back").on_press(|s: &mut App| s.browser.back()))
        .child(ibtn(t, "arrow-right", "Forward").key("browser-forward").on_press(|s: &mut App| s.browser.forward()))
        .child(ibtn(t, "refresh", "Reload").key("browser-reload").on_press(|s: &mut App| s.browser.reload()))
        .child(row().grow(1.0).min_w(0.0).h(32.0).mx(6.0).gap(8.0).px(12.0).radius(9.0).center_y().fill(t.hover).border(1.0, t.border)
            .child(ico_s(if url.starts_with("https://") { "lock" } else { "globe" }, 14.0, t.faint))
            .child(address))
        .child(el().key("browser-star").size(32.0, 32.0).radius(9.0).center().hover(t.hover).role("button").label(if bookmarked { "Remove bookmark" } else { "Bookmark" })
            .child(ico(if bookmarked { "check" } else { "plus" }, if bookmarked { t.accent } else { t.dim }))
            .on_press(move |s: &mut App| {
                let (u, title) = (star_url.clone(), star_title.clone());
                s.update_prefs(move |p| {
                    if p.bookmarks.iter().any(|(_, x)| *x == u) {
                        p.bookmarks.retain(|(_, x)| *x != u);
                    } else {
                        p.bookmarks.push((title, u));
                    }
                });
            }))
        .child(ibtn(t, "external", "Open in your browser").key("browser-external").on_press_tx(move |s: &mut App, tx| {
            if let Some(u) = s.browser.current().map(|t| t.url.clone()) {
                let _ = tx.open_url(&u);
            }
        }));
    // The page: the native web view sits over this element, so it stays empty (and dark) here.
    let page = col().key("browser-page").w_full().grow(1.0).min_h(0.0).fill(theme::hex("#0f0f0f"))
        .on_layout(|s: &mut App, r| s.browser.rect = Some(r));
    let page = if Browser::is_native() {
        page.children(s.browser.problem.clone().map(|p| {
            col().w_full().h_full().center().gap(10.0)
                .child(ico("warning", t.warn))
                .child(text(p).font(ui(14.0, 500.0)).color(t.text))
                .child(text("The browser needs Microsoft Edge WebView2, which Windows 10 and 11 include.").font(ui(13.0, 400.0)).color(t.faint))
        }))
    } else {
        let u = url.clone();
        page.child(col().w_full().h_full().center().gap(12.0)
            .child(site_icon(t, &url, 32.0))
            .child(text(tab.map(|t| t.title).unwrap_or_default()).font(ui(18.0, 600.0)).color(t.text))
            .child(text(url.clone()).font(ui(13.0, 400.0)).color(t.faint))
            .child(row().key("browser-open-system").h(34.0).px(14.0).gap(8.0).radius(9.0).center_y().fill(t.control).border(1.0, t.control_border).hover(t.hover)
                .role("button").label("Open in your browser")
                .child(ico_s("external", 16.0, t.text)).child(text("Open in your browser").font(ui(13.0, 500.0)).color(t.text))
                .on_press_tx(move |_: &mut App, tx| { let _ = tx.open_url(&u); }))
            .child(text("Pages open inside Codeply on Windows.").font(ui(12.5, 400.0)).color(t.faint)))
    };
    col().key("browser").w_full().h_full().min_h(0.0).fill(Color::TRANSPARENT)
        .child(toolbar)
        .child(page)
}
