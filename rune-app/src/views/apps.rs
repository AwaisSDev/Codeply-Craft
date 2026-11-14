//! Integrations > Apps: the whole catalogue (the engine reads the MCP Registry, tens of
//! thousands of apps), browsed a page at a time and searched as you type, with real connecting:
//! the browser for sign-in, a key where an app takes one, an app by its URL, and Manage.
//!
//! The page of apps and the counts come from the store (`extra.catalog`, `extra.apps`); what is
//! open on screen (a dialog and its fields) lives in [`AppsUi`].

use rune::{Align, El, Side, TextEdit, col, el, row, text, text_input};

use crate::app::App;
use crate::icons::{app_logo, ico_s};
use crate::model::{ButtonKind, CatalogApp};
use crate::theme::{self, Theme, tabular, ui};
use crate::ui::{btn, enter, side_row, wave};

/// A dialog over the page.
#[derive(Clone, Debug, PartialEq)]
pub enum Dialog {
    /// An app that takes an API key: (app id, name, header the key goes in).
    Key { id: String, name: String },
    /// Add an app by its server URL.
    Add,
    /// A connected app's tools and Disconnect.
    Manage(String),
}

/// What is open, and the fields in it.
pub struct AppsUi {
    pub dialog: Option<Dialog>,
    pub key: TextEdit,
    pub url: TextEdit,
    pub title: TextEdit,
    pub header: TextEdit,
    pub add_key: TextEdit,
}

impl Default for AppsUi {
    fn default() -> Self {
        AppsUi {
            dialog: None,
            key: TextEdit::new("").secure(),
            url: TextEdit::new(""),
            title: TextEdit::new(""),
            header: TextEdit::new(""),
            add_key: TextEdit::new("").secure(),
        }
    }
}

impl AppsUi {
    fn close(&mut self) {
        self.dialog = None;
        for e in [&mut self.key, &mut self.url, &mut self.title, &mut self.header, &mut self.add_key] {
            e.clear();
        }
    }
}

/// 41330 as "41,330".
pub fn thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

// ---------- actions ----------

/// The Connect button on an app.
pub fn press(s: &mut App, app: &CatalogApp) {
    if s.data.extra.apps.progress.as_ref().is_some_and(|p| p.busy()) {
        return;
    }
    if app.connected {
        s.apps_ui.dialog = Some(Dialog::Manage(app.slug.to_owned()));
        s.app_tools(app.slug);
    } else if !app.key_header.is_empty() {
        s.apps_ui.key.clear();
        s.apps_ui.dialog = Some(Dialog::Key { id: app.slug.to_owned(), name: app.name.clone() });
    } else {
        s.connect_app(app.slug);
    }
}

fn submit(s: &mut App) {
    match s.apps_ui.dialog.clone() {
        Some(Dialog::Key { id, .. }) => {
            let key = s.apps_ui.key.text.trim().to_owned();
            if !key.is_empty() {
                s.connect_app_key(&id, &key);
                s.apps_ui.close();
            }
        }
        Some(Dialog::Add) => {
            let url = s.apps_ui.url.text.trim().to_owned();
            if !url.is_empty() {
                let (title, header, key) = (s.apps_ui.title.text.trim().to_owned(), s.apps_ui.header.text.trim().to_owned(), s.apps_ui.add_key.text.trim().to_owned());
                s.add_app(&url, &title, &header, &key);
                s.apps_ui.close();
            }
        }
        _ => {}
    }
}

fn dismiss_progress(s: &mut App) {
    s.data.extra.apps.progress = None;
}

// ---------- the sidebar's categories ----------

pub fn categories(s: &App, t: &Theme) -> El {
    let a = &s.data.extra.apps;
    let mut items: Vec<(String, Option<String>, usize)> = vec![("All".to_owned(), None, a.total.max(s.data.extra.catalog.len()))];
    items.extend(a.categories.iter().map(|(c, n)| (c.clone(), Some(c.clone()), *n)));
    col().child(crate::ui::sec(t, None, "Categories", false)).children(items.into_iter().map(|(name, cat, n)| {
        let on = s.app_category == cat;
        side_row(t, on).key(format!("int-cat/{name}")).role("button").label(name.clone())
            .child(text(name).font(ui(14.0, 400.0)).color(t.text).grow(1.0).truncate())
            .child(text(thousands(n)).font(tabular(12.0, 400.0)).color(t.faint))
            .on_press(move |s: &mut App| {
                s.app_category = cat.clone();
                s.browse_apps(false);
            })
    }))
}

// ---------- the page ----------

fn tile_ink() -> (rune::Color, rune::Color, rune::Color) {
    (theme::hex("#232323"), theme::hex("#2e2e2e"), theme::hex("#e0e0e0"))
}

fn tile(a: &CatalogApp) -> El {
    let (tile, border, ink) = tile_ink();
    app_logo(&a.name, &a.domain, &a.icon, tile, border, ink)
}

/// The connect in progress, or how the last one ended.
fn banner(s: &App, t: &Theme) -> Option<El> {
    let p = s.data.extra.apps.progress.as_ref()?;
    let (ink, fill) = match p.state.as_str() {
        "done" => (t.green, t.green.alpha(0.10)),
        "error" => (t.red, t.red.alpha(0.10)),
        "warn" => (t.warn, t.warn.alpha(0.10)),
        "cancelled" => (t.dim, t.hover),
        _ => (t.accent, t.accent.alpha(0.10)),
    };
    let message = if p.busy() && p.message.is_empty() { format!("Connecting {}...", p.name) } else { p.message.clone() };
    let line = if p.busy() { wave(&message, ui(13.5, 500.0), ink) } else { text(message).font(ui(13.5, 500.0)).color(ink).wrap() };
    let action = if p.busy() {
        btn(t, "Cancel", None, ButtonKind::Plain).key("apps-cancel").on_press(|s: &mut App| s.cancel_app())
    } else {
        btn(t, "Dismiss", None, ButtonKind::Plain).key("apps-dismiss").on_press(dismiss_progress)
    };
    Some(row().key("apps-banner").gap(12.0).px(14.0).py(10.0).radius(12.0).center_y().fill(fill).border(1.0, ink.alpha(0.28)).role("status")
        .child(line.grow(1.0).min_w(0.0))
        .child(action))
}

fn cards(cards: Vec<El>, cols: usize) -> El {
    let mut rows: Vec<El> = Vec::new();
    let mut it = cards.into_iter().peekable();
    let mut r = 0;
    while it.peek().is_some() {
        let mut cells: Vec<El> = it.by_ref().take(cols).map(|c| c.grow(1.0).w(0.0)).collect();
        while cells.len() < cols {
            cells.push(el().grow(1.0).w(0.0));
        }
        rows.push(enter(row().gap(12.0).items_stretch().children(cells), r.min(4)));
        r += 1;
    }
    col().gap(12.0).children(rows)
}

fn grid_tile(s: &App, t: &Theme, a: &CatalogApp) -> El {
    let busy = s.data.extra.apps.progress.as_ref().is_some_and(|p| p.busy() && p.id == a.slug);
    let button = if busy {
        btn(t, "Connecting...", None, ButtonKind::Plain)
    } else if a.connected {
        btn(t, "Manage", Some("check"), ButtonKind::Plain)
    } else if !a.key_header.is_empty() {
        btn(t, "Add key", Some("lock"), ButtonKind::Blue)
    } else {
        btn(t, "Connect", None, ButtonKind::Blue)
    };
    let app = a.clone();
    let meta = row().gap(5.0).center_y()
        .children(a.verified.then(|| ico_s("shield-check", 13.0, t.green)))
        .child(text(if a.verified { a.category.to_owned() } else { format!("{} · not reviewed", a.category) }).font(ui(12.0, 400.0)).color(t.faint).truncate());
    col().gap(10.0).padding(12.0).radius(12.0).fill(theme::hex("#181818")).border(1.0, t.border)
        .child(row().gap(10.0).center_y()
            .child(tile(a))
            .child(col().grow(1.0).min_w(0.0)
                .child(text(a.name.clone()).font(ui(13.5, 600.0)).color(t.text).truncate())
                .child(meta)))
        .child(text(if a.note.is_empty() { "No description.".to_owned() } else { a.note.clone() }).font(ui(12.5, 400.0)).color(t.dim).wrap().grow(1.0).max_lines(3))
        .child(row().justify_end().child(button.key(format!("app/{}", a.slug)).on_press(move |s: &mut App| press(s, &app))))
}

pub fn body(s: &App, t: &Theme, q: &str) -> El {
    let a = &s.data.extra.apps;
    let h3 = |label: String| text(label).font(ui(13.0, 600.0)).color(t.dim).mt(8.0);
    let empty = |what: &str| text(what.to_owned()).font(ui(13.5, 400.0)).color(t.faint).py(12.0);

    let connected: Vec<El> = a.connected.iter().filter(|c| q.is_empty() || c.name.to_lowercase().contains(q) || c.note.to_lowercase().contains(q)).enumerate().map(|(i, c)| {
        let app = c.clone();
        let line = if c.needs_reconnect {
            text("Sign in again to keep using it".to_owned()).font(ui(12.5, 400.0)).color(t.warn).truncate()
        } else if !c.account.is_empty() {
            text(format!("Signed in as {}", c.account)).font(ui(12.5, 400.0)).color(t.faint).truncate()
        } else {
            text(if c.note.is_empty() { c.category.to_owned() } else { c.note.clone() }).font(ui(12.5, 400.0)).color(t.faint).truncate()
        };
        enter(
            row().gap(12.0).px(12.0).py(10.0).radius(12.0).center_y().hover(t.hover)
                .child(tile(c))
                .child(col().grow(1.0).min_w(0.0)
                    .child(text(c.name.clone()).font(ui(14.0, 600.0)).color(t.text).truncate())
                    .child(line))
                .children((c.tools > 0).then(|| text(format!("{} tools", c.tools)).font(tabular(12.0, 400.0)).color(t.faint)))
                .child(btn(t, "Manage", None, ButtonKind::Plain).key(format!("app-manage/{}", c.slug)).on_press(move |s: &mut App| press(s, &app))),
            i,
        )
    }).collect();

    let tiles: Vec<El> = s.data.extra.catalog.iter().map(|c| grid_tile(s, t, c)).collect();
    let shown = tiles.len();
    let title = match (&s.app_category, q.is_empty()) {
        (Some(c), true) => c.clone(),
        (Some(c), false) => format!("{c} matching \"{q}\""),
        (None, true) => "All apps".to_owned(),
        (None, false) => format!("Apps matching \"{q}\""),
    };
    let counts = if let Some(n) = a.indexing {
        format!("Reading the MCP Registry: {} apps so far", thousands(n.max(a.total)))
    } else if a.matched > 0 || a.total > 0 {
        format!("{} of {} apps · {} in the catalogue", thousands(shown), thousands(a.matched), thousands(a.total))
    } else {
        String::new()
    };
    let more = (shown < a.matched).then(|| {
        let label = if a.loading { "Loading...".to_owned() } else { format!("Show more ({} left)", thousands(a.matched - shown)) };
        row().justify_center().pt(4.0).child(btn(t, &label, None, ButtonKind::Plain).key("apps-more").on_press(|s: &mut App| s.browse_apps(true)))
    });
    let note = (!a.error.is_empty()).then(|| text(a.error.clone()).font(ui(12.5, 400.0)).color(t.warn).wrap());

    col().gap(12.0)
        .children(banner(s, t))
        .child(h3("Connected".to_owned()))
        .child(if connected.is_empty() { empty("Nothing connected yet.") } else { col().gap(2.0).children(connected) })
        .child(row().gap(10.0).center_y().items_end()
            .child(h3(title).grow(1.0).min_w(0.0))
            .child(text(counts).font(ui(12.0, 400.0)).color(t.faint).mt(8.0)))
        .children(note)
        .child(if tiles.is_empty() {
            empty(if a.loading || a.indexing.is_some() { "Loading apps..." } else { "No apps match. Try another name, or add it by its URL." })
        } else {
            cards(tiles, 3)
        })
        .children(more)
}

// ---------- dialogs ----------

fn field(t: &Theme, label: &str, edit: &TextEdit, access: fn(&mut App) -> &mut TextEdit, placeholder: &str, key: &str, secret: bool) -> El {
    let input = text_input(edit, ui(13.5, 400.0)).key(key.to_owned()).single_line().grow(1.0).color(t.text)
        .placeholder(placeholder, t.faint).caret(t.accent, t.accent.alpha(0.3)).label(label.to_owned())
        .on_edit(access);
    let input = if secret { input.on_submit(|s: &mut App, _| submit(s)) } else { input };
    col().gap(5.0)
        .child(text(label.to_owned()).font(ui(12.0, 600.0)).color(t.faint))
        .child(row().h(38.0).px(12.0).radius(10.0).center_y().fill(theme::hex("#161616")).border(1.0, theme::hex("#2c2c2c")).child(input))
}

/// The open dialog, anchored under the button that opened it.
pub fn dialog(s: &App, t: &Theme) -> Option<El> {
    let d = s.apps_ui.dialog.as_ref()?;
    let panel = |anchor: String, label: &str| {
        col().key("apps-dialog").w(380.0).padding(16.0).gap(12.0).radius(14.0)
            .fill(theme::hex("#1f1f1f")).border(1.0, t.control_border).shadow(12.0, 32.0, theme::rgba(0, 0, 0, 0.45))
            .anchored(anchor, Side::Bottom, Align::End, 8.0)
            .role("dialog").label(label.to_owned())
            .modal(true, |s: &mut App| s.apps_ui.close())
    };
    let title = |label: String| text(label).font(ui(15.0, 650.0)).color(t.text);
    let help = |label: String| text(label).font(ui(12.5, 400.0)).color(t.faint).wrap();
    let cancel = btn(t, "Cancel", None, ButtonKind::Plain).key("apps-dialog-cancel").on_press(|s: &mut App| s.apps_ui.close());
    let out = match d {
        Dialog::Key { id, name } => panel(format!("app/{id}"), "Add an API key")
            .child(title(format!("Connect {name}")))
            .child(help(format!("{name} signs in with an API key, not the browser. It stays on this computer, in your Codeply folder, and goes only to {name}.")))
            .child(field(t, "API key", &s.apps_ui.key, |s| &mut s.apps_ui.key, "Paste it here", "apps-key", true))
            .child(row().gap(8.0).justify_end().child(cancel).child(btn(t, "Connect", None, ButtonKind::Blue).key("apps-dialog-go").on_press(submit))),
        Dialog::Add => panel("int-primary".to_owned(), "Add an app")
            .child(title("Add an app by its URL".to_owned()))
            .child(help("Any app with a remote MCP server works. Leave the key empty to sign in in your browser.".to_owned()))
            .child(field(t, "Server URL", &s.apps_ui.url, |s| &mut s.apps_ui.url, "https://mcp.example.com/mcp", "apps-url", true))
            .child(field(t, "Name (optional)", &s.apps_ui.title, |s| &mut s.apps_ui.title, "Example", "apps-title", true))
            .child(row().gap(10.0)
                .child(field(t, "Key header (optional)", &s.apps_ui.header, |s| &mut s.apps_ui.header, "Authorization", "apps-header", true).grow(1.0).w(0.0))
                .child(field(t, "Key (optional)", &s.apps_ui.add_key, |s| &mut s.apps_ui.add_key, "Paste it here", "apps-add-key", true).grow(1.0).w(0.0)))
            .child(row().gap(8.0).justify_end().child(cancel).child(btn(t, "Add app", None, ButtonKind::Blue).key("apps-dialog-go").on_press(submit))),
        Dialog::Manage(id) => manage(s, t, id, panel(format!("app-manage/{id}"), "Manage app")),
    };
    Some(out)
}

fn manage(s: &App, t: &Theme, id: &str, panel: El) -> El {
    let app = s.data.extra.apps.connected.iter().chain(&s.data.extra.catalog).find(|a| a.slug == id);
    let Some(app) = app else {
        return panel.child(text("This app is no longer connected.".to_owned()).font(ui(13.0, 400.0)).color(t.dim));
    };
    let status = if app.needs_reconnect {
        text("Sign in again to keep using it.".to_owned()).font(ui(12.5, 400.0)).color(t.warn)
    } else if !app.account.is_empty() {
        text(format!("Signed in as {}", app.account)).font(ui(12.5, 400.0)).color(t.faint)
    } else {
        text(app.domain.clone()).font(ui(12.5, 400.0)).color(t.faint)
    };
    let tools: El = match &s.data.extra.apps.tools {
        Some((tid, Ok(list))) if tid == id => {
            if list.is_empty() {
                text("It offers no tools.".to_owned()).font(ui(12.5, 400.0)).color(t.faint)
            } else {
                col().gap(2.0)
                    .child(text(format!("{} tools. Anything that sends, changes or deletes asks you first.", list.len())).font(ui(12.5, 400.0)).color(t.faint).wrap().pb(4.0))
                    .children(list.iter().take(10).map(|(name, desc, read)| {
                        row().gap(8.0).center_y().py(3.0)
                            .child(ico_s(if *read { "search" } else { "edit" }, 14.0, if *read { t.faint } else { t.warn }))
                            .child(col().grow(1.0).min_w(0.0)
                                .child(text(name.clone()).font(ui(13.0, 500.0)).color(t.text).truncate())
                                .child(text(desc.lines().next().unwrap_or_default().to_owned()).font(ui(12.0, 400.0)).color(t.faint).truncate()))
                    }))
                    .children((list.len() > 10).then(|| text(format!("and {} more", list.len() - 10)).font(ui(12.0, 400.0)).color(t.faint).pt(4.0)))
            }
        }
        Some((tid, Err(e))) if tid == id => text(format!("Couldn't list its tools: {e}")).font(ui(12.5, 400.0)).color(t.warn).wrap(),
        _ => text("Asking the app for its tools...".to_owned()).font(ui(12.5, 400.0)).color(t.faint),
    };
    let slug = app.slug;
    let reconnect = app.clone();
    panel
        .child(row().gap(12.0).center_y()
            .child(tile(app))
            .child(col().grow(1.0).min_w(0.0)
                .child(text(app.name.clone()).font(ui(15.0, 650.0)).color(t.text).truncate())
                .child(status)))
        .child(tools)
        .child(row().gap(8.0).justify_end()
            .child(btn(t, "Disconnect", None, ButtonKind::Plain).key("apps-disconnect").on_press(move |s: &mut App| {
                s.disconnect_app(slug);
                s.apps_ui.close();
            }))
            .children(app.needs_reconnect.then(|| btn(t, "Sign in again", None, ButtonKind::Blue).key("apps-reconnect").on_press(move |s: &mut App| {
                s.apps_ui.close();
                s.connect_app(reconnect.slug);
            })))
            .child(btn(t, "Done", None, ButtonKind::Plain).key("apps-dialog-cancel").on_press(|s: &mut App| s.apps_ui.close())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::CatalogApp;

    #[test]
    fn counts_get_thousands_separators() {
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(41330), "41,330");
        assert_eq!(thousands(1_000_000), "1,000,000");
    }

    #[test]
    fn browsing_filters_by_category_and_search_and_pages() {
        let mut s = App::with_mock();
        s.app_category = Some("Communication".into());
        s.browse_apps(false);
        assert!(!s.data.extra.catalog.is_empty());
        assert!(s.data.extra.catalog.iter().all(|a| a.category == "Communication"));
        assert_eq!(s.data.extra.apps.matched, s.data.extra.catalog.len());
        s.app_category = None;
        s.edit_mut(crate::app::EditKey::AppSearch).replace_text("linear");
        s.browse_apps(false);
        assert_eq!(s.data.extra.catalog.len(), 1);
        assert_eq!(s.data.extra.apps.total, 14);
    }

    #[test]
    fn a_key_app_asks_for_its_key_and_a_plain_one_connects() {
        let mut s = App::with_mock();
        let key_app = CatalogApp { slug: "acme", name: "Acme".into(), category: "Other", key_header: "X-Api-Key".into(), ..Default::default() };
        press(&mut s, &key_app);
        assert_eq!(s.apps_ui.dialog, Some(Dialog::Key { id: "acme".into(), name: "Acme".into() }));
        s.apps_ui.close();
        let linear = s.data.extra.catalog.iter().find(|a| a.slug == "linear").cloned().unwrap();
        press(&mut s, &linear);
        assert!(s.data.extra.apps.connected.iter().any(|a| a.slug == "linear"));
        // A connected app opens Manage.
        let linear = s.data.extra.apps.connected.iter().find(|a| a.slug == "linear").cloned().unwrap();
        press(&mut s, &linear);
        assert_eq!(s.apps_ui.dialog, Some(Dialog::Manage("linear".into())));
    }
}
