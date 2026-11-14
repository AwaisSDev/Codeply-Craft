//! The browser pane: a tab strip, a toolbar with back, forward, reload, the element picker, the
//! phone view and the address bar, and the page. On Windows the page is a WebView2 laid over the
//! element keyed `browser-page` (see `crate::browser`); elsewhere that area offers the system browser.

use rune::{Color, El, InlineIcon, Side, col, el, row, text, text_input};

use crate::app::{App, EditKey, Pane};
use crate::browser::Browser;
use crate::favicon;
use crate::icons::{ico, ico_s};
use crate::theme::{Theme, ui};
use crate::ui::{ibtn, menu as popup_menu, menu_item};

/// A site's icon at `size`, or a globe until it arrives.
fn site_icon(t: &Theme, url: &str, size: f32) -> El {
    match favicon::get(url) {
        Some(px) => text(" ").inline_icon(0, InlineIcon::image(px).size(size).gap(0.0).radius(3.0)).w(size).h(size),
        None => ico_s("globe", size, t.faint),
    }
}

/// One tab in the strip: favicon, title, and a close button on hover.
fn tab_el(s: &App, t: &Theme, i: usize) -> El {
    let tab = &s.browser.tabs[i];
    let on = i == s.browser.active;
    let title = if tab.loading { format!("{} ...", tab.title) } else { tab.title.clone() };
    let close = el().key(format!("tab-close/{}", tab.id)).size(20.0, 20.0).radius(6.0).center().hover(t.hover).role("button").label("Close tab")
        .group_opacity(if on { 1.0 } else { 0.0 }, 1.0)
        .child(ico_s("close", 14.0, t.dim))
        .on_press(move |s: &mut App| s.browser.close_tab(i));
    row().key(format!("tab/{}", tab.id)).h(30.0).max_w(180.0).px(10.0).gap(8.0).radius(8.0).center_y().hover_group().hover(t.hover)
        .fill(if on { t.active } else { Color::TRANSPARENT })
        .role("tab").checked(on).label(tab.title.clone())
        .child(site_icon(t, &tab.url, 16.0))
        .child(text(title).font(ui(13.0, 400.0)).color(if on { t.text } else { t.dim }).truncate().shrink().min_w(0.0))
        .child(close)
        .on_press(move |s: &mut App| s.browser.select(i))
}

/// The browser pane. It fills the space its parent gives it.
pub fn pane(s: &App, t: &Theme) -> El {
    let tab = s.browser.current().cloned();
    let url = tab.as_ref().map(|t| t.url.clone()).unwrap_or_default();
    let bookmarked = s.prefs.bookmarks.iter().any(|(_, u)| *u == url);

    // Tabs.
    let strip = row().key("browser-tabs").w_full().h(38.0).px(8.0).gap(2.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.border)
        .children((0..s.browser.tabs.len()).map(|i| tab_el(s, t, i)))
        .child(ibtn(t, "plus", "New tab").key("browser-new-tab").on_press(|s: &mut App| {
            let home = s.prefs.home.clone();
            s.browser.new_tab(&home);
        }))
        .child(el().grow(1.0).min_w(0.0))
        .child(ibtn(t, "external", "Open in your browser").key("browser-external").on_press_tx(move |s: &mut App, tx| {
            if let Some(u) = s.browser.current().map(|t| t.url.clone()) {
                let _ = tx.open_url(&u);
            }
        }))
        .child(ibtn(t, "close", "Close browser").key("browser-close").on_press(|s: &mut App| s.toggle_pane(Pane::Browser)));

    // Toolbar.
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
    let more_open = s.menu.as_deref() == Some("browser-more");
    let toolbar = row().key("browser-toolbar").w_full().h(42.0).px(8.0).gap(2.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.border)
        .child(ibtn(t, "arrow-left", "Back").key("browser-back").on_press(|s: &mut App| s.browser.back()))
        .child(ibtn(t, "arrow-right", "Forward").key("browser-forward").on_press(|s: &mut App| s.browser.forward()))
        .child(ibtn(t, "refresh", "Reload").key("browser-reload").on_press(|s: &mut App| s.browser.reload()))
        .child(ibtn(t, "target", "Pick an element").key("browser-pick")
            .fill(if s.browser.picking { t.active } else { Color::TRANSPARENT })
            .on_press(|s: &mut App| s.browser.pick()))
        .child(ibtn(t, "phone", "Phone view").key("browser-mobile")
            .fill(if s.panes.mobile { t.active } else { Color::TRANSPARENT })
            .on_press(|s: &mut App| s.panes.mobile = !s.panes.mobile))
        .child(row().grow(1.0).min_w(0.0).h(30.0).mx(6.0).gap(8.0).px(12.0).radius(9.0).clip_rounded(9.0).center_y().fill(t.hover).border(1.0, t.border)
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
        .child(ibtn(t, "more", "More").key("browser-more")
            .fill(if more_open { t.active } else { Color::TRANSPARENT })
            .on_press(|s: &mut App| s.toggle_menu("browser-more")));

    // The page: the native web view sits over this element, so it stays empty (and dark) here.
    let content = if Browser::is_native() {
        col().w_full().h_full().center().gap(10.0).children(s.browser.problem.clone().map(|p| {
            col().center().gap(10.0)
                .child(ico("warning", t.warn))
                .child(text(p).font(ui(14.0, 500.0)).color(t.text))
                .child(text("The browser needs Microsoft Edge WebView2, which Windows 10 and 11 include.").font(ui(13.0, 400.0)).color(t.faint).wrap())
        }))
    } else {
        let u = url.clone();
        col().w_full().h_full().center().gap(12.0)
            .child(site_icon(t, &url, 32.0))
            .child(text(tab.map(|t| t.title).unwrap_or_default()).font(ui(18.0, 600.0)).color(t.text))
            .child(text(url.clone()).font(ui(13.0, 400.0)).color(t.faint))
            .child(row().key("browser-open-system").h(34.0).px(14.0).gap(8.0).radius(9.0).center_y().fill(t.control).border(1.0, t.control_border).hover(t.hover)
                .role("button").label("Open in your browser")
                .child(ico_s("external", 16.0, t.text)).child(text("Open in your browser").font(ui(13.0, 500.0)).color(t.text))
                .on_press_tx(move |_: &mut App, tx| { let _ = tx.open_url(&u); }))
            .child(text("Pages open inside Codeply on Windows.").font(ui(12.5, 400.0)).color(t.faint))
    };
    let page_fill = t.solid;
    let page = if s.panes.mobile {
        let phone = col().key("browser-page").w(390.0).h_full().fill(page_fill)
            .on_layout(|s: &mut App, r| s.browser.rect = Some(r))
            .child(content);
        row().w_full().grow(1.0).min_h(0.0).center().fill(t.stage).child(phone)
    } else {
        col().key("browser-page").w_full().grow(1.0).min_h(0.0).fill(page_fill)
            .on_layout(|s: &mut App, r| s.browser.rect = Some(r))
            .child(content)
    };

    col().key("browser-pane").w_full().h_full().min_h(0.0).min_w(0.0).fill(t.bg)
        .child(strip)
        .child(toolbar)
        .child(page)
}

/// The "⋯" menu: zoom, developer tools, bookmarks, clear data.
pub fn menu(s: &App, t: &Theme, id: &str) -> Option<El> {
    if id != "browser-more" {
        return None;
    }
    let pct = format!("{}%", (s.browser.zoom * 100.0).round());
    let mut items = vec![
        menu_item(t, "bm/zoom-in".to_owned(), None, "Zoom in", None, false)
            .on_press(|s: &mut App| { s.browser.zoom_by(0.1); s.menu = None; }),
        menu_item(t, "bm/zoom-out".to_owned(), None, "Zoom out", None, false)
            .on_press(|s: &mut App| { s.browser.zoom_by(-0.1); s.menu = None; }),
        menu_item(t, "bm/zoom-reset".to_owned(), None, "Reset zoom", Some(pct.as_str()), false)
            .on_press(|s: &mut App| { s.browser.zoom_by(0.0); s.menu = None; }),
        menu_item(t, "bm/devtools".to_owned(), Some("code"), "Developer tools", None, false)
            .on_press(|s: &mut App| { s.browser.devtools(); s.menu = None; }),
    ];
    for (title, url) in &s.prefs.bookmarks {
        let u = url.clone();
        items.push(menu_item(t, format!("bm/bookmark/{url}"), Some("globe"), title, None, false)
            .on_press(move |s: &mut App| { s.browse(&u); s.menu = None; }));
    }
    items.push(menu_item(t, "bm/clear".to_owned(), Some("trash"), "Clear browsing data", None, false)
        .on_press(|s: &mut App| { s.browser.clear_data(); s.menu = None; }));
    Some(popup_menu(t, "browser-more", Side::Bottom, 240.0, items))
}
