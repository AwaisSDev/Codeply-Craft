//! Integrations > Apps: the whole catalogue (the engine reads the MCP Registry, tens of
//! thousands of apps), browsed a page at a time and searched as you type, with real connecting:
//! the browser for sign-in, a key where an app takes one, an app by its URL, and Manage.
//!
//! The page of apps and the counts come from the store (`extra.catalog`, `extra.apps`); what is
//! open on screen (a dialog and its fields) lives in [`AppsUi`].

use rune::{Align, El, Side, TextEdit, col, el, row, text, text_input};

use crate::app::App;
use crate::icons::{app_tile, ico_s};
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
    /// Where the Connected list's scroll line sits ([x, y, w, h] in its track), set as it scrolls.
    pub thumb: rune::Live<[f32; 4]>,
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
            thumb: rune::Live::new([0.0, 0.0, 3.0, 0.0]),
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

/// Which vendored logo stands in for an app while its own loads: a built-in's id ("gmail"), else
/// its name squeezed ("Google Calendar" -> "googlecalendar").
fn glyph(a: &CatalogApp) -> String {
    a.slug.strip_prefix("builtin:").map_or_else(|| a.name.to_lowercase().chars().filter(char::is_ascii_alphanumeric).collect(), str::to_owned)
}

fn tile(a: &CatalogApp) -> El {
    let (tile, border, ink) = tile_ink();
    app_tile(&glyph(a), &a.name, &a.domain, &a.icon, tile, border, ink)
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
    Some(row().key("apps-banner").gap(12.0).px(14.0).py(10.0).radius(12.0).continuous_corners().center_y().fill(fill).border(1.0, ink.alpha(0.28)).role("status")
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
    let meta = if a.connected {
        // "Connected · ada@example.com": who it is signed in as, at a glance.
        let who = if a.needs_reconnect { "Sign in again".to_owned() } else if a.account.is_empty() { "Connected".to_owned() } else { format!("Connected · {}", a.account) };
        row().gap(5.0).center_y()
            .child(ico_s(if a.needs_reconnect { "alert" } else { "check" }, 13.0, if a.needs_reconnect { t.warn } else { t.green }))
            .child(text(who).font(ui(12.0, 500.0)).color(if a.needs_reconnect { t.warn } else { t.green }).truncate())
    } else {
        let what = if a.builtin { format!("{} · Yune sign-in", a.category) } else if a.verified { a.category.to_owned() } else { format!("{} · not reviewed", a.category) };
        row().gap(5.0).center_y()
            .children(a.verified.then(|| ico_s("shield-check", 13.0, t.green)))
            .child(text(what).font(ui(12.0, 400.0)).color(t.faint).truncate())
    };
    col().gap(10.0).padding(12.0).radius(12.0).continuous_corners().fill(theme::hex("#181818")).border(1.0, t.border)
        .child(row().gap(10.0).center_y()
            .child(tile(a))
            .child(col().grow(1.0).min_w(0.0)
                .child(text(a.name.clone()).font(ui(13.5, 600.0)).color(t.text).truncate())
                .child(meta)))
        .child(text(if a.note.is_empty() { "No description.".to_owned() } else { a.note.clone() }).font(ui(12.5, 400.0)).color(t.dim).wrap().grow(1.0).max_lines(3))
        .child(row().justify_end().child(button.key(format!("app/{}", a.slug)).on_press(move |s: &mut App| press(s, &app))))
}

/// A connected row's height; the list shows `CONNECTED_SHOWN` of them and half of the next.
const CONNECTED_ROW: f32 = 58.0;
const CONNECTED_GAP: f32 = 2.0;
const CONNECTED_SHOWN: usize = 5;

/// The connected apps: five in view and half of the sixth, so it's plain there are more, and
/// the rest a scroll away, with a thin grey line beside them that shows where you are.
fn connected_list(s: &App, t: &Theme, rows: Vec<El>) -> El {
    let n = rows.len();
    let list = col().w_full().gap(CONNECTED_GAP).children(rows);
    if n <= CONNECTED_SHOWN {
        return list;
    }
    let pitch = CONNECTED_ROW + CONNECTED_GAP;
    let height = CONNECTED_SHOWN as f32 * pitch + CONNECTED_ROW / 2.0;
    let thumb = s.apps_ui.thumb.clone();
    let viewport = col().key("apps-connected").w_full().h(height)
        .child(list)
        .scroll(rune::ScrollSpec { stick_bottom: false })
        .on_scroll_offset(move |at: rune::ScrollPos| {
            let (view, max) = (at.viewport[1], at.max[1]);
            let h = (view * view / (view + max).max(1.0)).max(28.0).min(view);
            let y = if max > 0.0 { at.offset[1] / max * (view - h) } else { 0.0 };
            thumb.set([0.0, y, 3.0, h]);
        });
    // The track: a faint line the whole height, and the brighter part where the view is.
    let track = el().pin(None, Some(0.0), Some(0.0), Some(0.0)).w(3.0).radius(1.5).fill(t.border.alpha(0.35)).inert()
        .child(el().absolute(0.0, 0.0).w(3.0).h(28.0).radius(1.5).fill(t.dim.alpha(0.85)).live_rect(&s.apps_ui.thumb));
    el().w_full().child(viewport).child(track)
}

/// An open app's page: who it's signed in as, Disconnect, and every tool it gives the agent, by
/// name, with what it does and whether it asks you first.
fn app_page(s: &App, t: &Theme, id: &str) -> El {
    let back = row().key("apps-back").gap(4.0).h(30.0).pl(4.0).pr(10.0).radius(8.0).continuous_corners().center_y().hover(t.hover).role("button").label("Back to apps")
        .child(ico_s("chevron-left", 16.0, t.dim))
        .child(text("Apps".to_owned()).font(ui(13.0, 500.0)).color(t.dim))
        .on_press(|s: &mut App| s.apps_ui.close());
    let app = s.data.extra.apps.connected.iter().chain(&s.data.extra.catalog).find(|a| a.slug == id);
    let Some(app) = app else {
        return col().gap(16.0).child(row().child(back)).child(text("This app is no longer connected.".to_owned()).font(ui(13.5, 400.0)).color(t.dim));
    };
    let status = if app.needs_reconnect {
        text("Sign in again to keep using it.".to_owned()).font(ui(13.0, 400.0)).color(t.warn)
    } else if !app.account.is_empty() {
        text(format!("Signed in as {}", app.account)).font(ui(13.0, 400.0)).color(t.faint)
    } else {
        text(if app.note.is_empty() { app.domain.clone() } else { app.note.clone() }).font(ui(13.0, 400.0)).color(t.faint).wrap()
    };
    let slug = app.slug;
    let reconnect = app.clone();
    let head = row().gap(14.0).center_y()
        .child(tile(app))
        .child(col().grow(1.0).min_w(0.0).gap(2.0)
            .child(text(app.name.clone()).font(ui(20.0, 650.0).tracking(-0.2)).color(t.text).truncate())
            .child(status))
        .children(app.needs_reconnect.then(|| btn(t, "Sign in again", None, ButtonKind::Blue).key("apps-reconnect").on_press(move |s: &mut App| {
            s.apps_ui.close();
            s.connect_app(reconnect.slug);
        })))
        .child(btn(t, "Disconnect", None, ButtonKind::Plain).key("apps-disconnect").on_press(move |s: &mut App| {
            s.disconnect_app(slug);
            s.apps_ui.close();
        }));
    let note = |words: String, ink| text(words).font(ui(13.0, 400.0)).color(ink).wrap();
    let tools: El = match &s.data.extra.apps.tools {
        Some((tid, Ok(list))) if tid == id && list.is_empty() => note("It offers no tools.".into(), t.faint),
        Some((tid, Ok(list))) if tid == id => {
            let asks = list.iter().filter(|(_, _, read)| !read).count();
            col().gap(10.0)
                .child(row().gap(8.0).items_end()
                    .child(text("Tools".to_owned()).font(ui(15.0, 650.0)).color(t.text))
                    .child(text(format!("{}", list.len())).font(tabular(13.0, 500.0)).color(t.faint)))
                .child(note(if asks > 0 {
                    format!("What the agent can do with {}. The {asks} that send, change or delete something ask you first.", app.name)
                } else {
                    format!("What the agent can do with {}. They only read.", app.name)
                }, t.faint))
                .child(col().radius(14.0).continuous_corners().border(1.0, t.border).clip_rounded(14.0)
                    .children(list.iter().enumerate().map(|(i, (name, desc, read))| {
                        row().key(format!("app-tool/{id}/{name}")).gap(12.0).px(14.0).py(10.0).items_start()
                            .border_sides([if i == 0 { 0.0 } else { 1.0 }, 0.0, 0.0, 0.0], t.border)
                            .child(el().mt(1.0).child(ico_s(if *read { "search" } else { "edit" }, 15.0, if *read { t.faint } else { t.warn })))
                            .child(col().grow(1.0).min_w(0.0).gap(2.0)
                                .child(text(name.clone()).font(ui(13.5, 600.0)).color(t.text).truncate())
                                .children((!desc.trim().is_empty()).then(|| text(desc.trim().to_owned()).font(ui(12.5, 400.0)).color(t.dim).wrap().max_lines(2))))
                            .children((!*read).then(|| el().px(8.0).h(20.0).radius(10.0).center().fill(t.warn.alpha(0.14))
                                .child(text("Asks first".to_owned()).font(ui(11.0, 600.0)).color(t.warn))))
                    })))
        }
        Some((tid, Err(e))) if tid == id => note(format!("Couldn't list its tools: {e}"), t.warn),
        _ => wave("Asking the app for its tools", ui(13.0, 400.0), t.faint),
    };
    col().key(format!("app-page/{id}")).gap(18.0).max_w(860.0)
        .child(row().child(back))
        .child(head)
        .child(tools)
}

pub fn body(s: &App, t: &Theme, q: &str) -> El {
    if let Some(Dialog::Manage(id)) = &s.apps_ui.dialog {
        return app_page(s, t, id);
    }
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
            row().key(format!("app-manage/{}", c.slug)).h(CONNECTED_ROW).gap(12.0).px(12.0).mr(10.0).radius(12.0).continuous_corners().center_y().hover(t.hover)
                .role("button").label(format!("{}: open", c.name))
                .child(tile(c))
                .child(col().grow(1.0).min_w(0.0)
                    .child(text(c.name.clone()).font(ui(14.0, 600.0)).color(t.text).truncate())
                    .child(line))
                .child(ico_s("chevron-right", 16.0, t.faint))
                .on_press(move |s: &mut App| press(s, &app)),
            i,
        )
    }).collect();
    let connected = if connected.is_empty() { empty("Nothing connected yet.") } else { connected_list(s, t, connected) };

    // With no search or category, the page opens on Featured: Codeply's own sign-ins, then the
    // vendors' own servers Codeply checked (the catalogue lists them first).
    let browsing = q.is_empty() && s.app_category.is_none();
    let featured = if browsing { s.data.extra.catalog.iter().take_while(|c| c.verified).count() } else { 0 };
    let featured_tiles: Vec<El> = s.data.extra.catalog.iter().take(featured).map(|c| grid_tile(s, t, c)).collect();
    let tiles: Vec<El> = s.data.extra.catalog.iter().skip(featured).map(|c| grid_tile(s, t, c)).collect();
    let shown = featured + tiles.len();
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
        .child(connected)
        .children((!featured_tiles.is_empty()).then(|| h3("Featured".to_owned())))
        .children((!featured_tiles.is_empty()).then(|| cards(featured_tiles, 3)))
        .child(row().gap(10.0).center_y().items_end()
            .child(h3(title).grow(1.0).min_w(0.0))
            .child(text(counts).font(ui(12.0, 400.0)).color(t.faint).mt(8.0)))
        .children(note)
        .child(if tiles.is_empty() && featured == 0 {
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
        .child(row().h(38.0).px(12.0).radius(10.0).continuous_corners().center_y().fill(theme::hex("#161616")).border(1.0, theme::hex("#2c2c2c")).child(input))
}

/// The open dialog, anchored under the button that opened it.
pub fn dialog(s: &App, t: &Theme) -> Option<El> {
    let d = s.apps_ui.dialog.as_ref().filter(|d| !matches!(d, Dialog::Manage(_)))?;
    let panel = |anchor: String, label: &str| {
        col().key("apps-dialog").w(380.0).padding(16.0).gap(12.0).radius(14.0).continuous_corners()
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
            .child(help(format!("{name} signs in with an API key, not the browser. It stays on this computer, in your Yune folder, and goes only to {name}.")))
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
        Dialog::Manage(_) => return None,
    };
    Some(out)
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
        assert_eq!(s.data.extra.apps.total, 30);
    }

    #[test]
    fn featured_starts_with_codeplys_own_sign_ins_then_twenty_vendors() {
        let mut s = App::with_mock();
        s.browse_apps(false);
        let featured: Vec<&CatalogApp> = s.data.extra.catalog.iter().take_while(|a| a.verified).collect();
        let names: Vec<&str> = featured.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names[..5], ["Gmail", "Slack", "Vercel", "Supabase", "GitHub"]);
        assert!(featured[..5].iter().all(|a| a.builtin && a.slug.starts_with("builtin:")));
        assert_eq!(featured.len(), 25);
        assert!(featured[5..].iter().all(|a| !a.builtin));
        // Vercel and Supabase show once, as the built-ins.
        assert_eq!(s.data.extra.catalog.iter().filter(|a| a.name == "Vercel" || a.name == "Supabase").count(), 2);
        assert_eq!(glyph(featured[3]), "supabase");
        assert_eq!(glyph(featured.iter().find(|a| a.name == "Hugging Face").unwrap()), "huggingface");
    }

    #[test]
    fn a_built_in_connects_shows_who_and_disconnects_from_manage() {
        let mut s = App::with_mock();
        s.browse_apps(false);
        let supabase = s.data.extra.catalog.iter().find(|a| a.slug == "builtin:supabase").cloned().unwrap();
        assert!(!supabase.connected);
        press(&mut s, &supabase);
        assert!(s.data.extra.apps.connected.iter().any(|a| a.slug == "builtin:supabase"));
        assert_eq!(s.data.extra.apps.progress.as_ref().map(|p| p.message.as_str()), Some("Supabase is connected."));
        let github = s.data.extra.catalog.iter().find(|a| a.slug == "builtin:github").cloned().unwrap();
        assert_eq!(github.account, "codeply-dev");
        press(&mut s, &github);
        assert_eq!(s.apps_ui.dialog, Some(Dialog::Manage("builtin:github".into())));
        s.disconnect_app("builtin:github");
        let github = s.data.extra.catalog.iter().find(|a| a.slug == "builtin:github").unwrap();
        assert!(!github.connected && github.account.is_empty());
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
