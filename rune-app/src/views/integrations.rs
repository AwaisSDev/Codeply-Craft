//! Integrations: plugins, apps, MCP servers and skills, one tab each. The sidebar lists the tabs
//! (with counts) and, on Apps, the categories; the search field filters whichever list is open.

use rune::{El, ScrollSpec, col, el, row, text, text_input};

use crate::app::{App, EditKey, IntegrationsTab};
use crate::icons::{app_logo, ico, ico_s};
use crate::model::ButtonKind;
use crate::theme::{self, Theme, mono, tabular, ui};
use crate::ui::{btn, btn_primary, enter, heading, me, sec, side_head, side_row, toggle};

/// The tab's sidebar icon.
fn tab_icon(tab: IntegrationsTab) -> &'static str {
    match tab {
        IntegrationsTab::Plugins => "sparkle",
        IntegrationsTab::Apps => "link",
        IntegrationsTab::Mcp => "chip",
        IntegrationsTab::Skills => "book",
    }
}

fn tab_count(s: &App, tab: IntegrationsTab) -> usize {
    match tab {
        IntegrationsTab::Plugins => s.data.extra.plugins.len(),
        IntegrationsTab::Apps => s.data.extra.catalog.len(),
        IntegrationsTab::Mcp => s.data.extra.mcp.len(),
        IntegrationsTab::Skills => s.data.extra.skills.len(),
    }
}

pub fn side(s: &App, t: &Theme) -> El {
    let tabs = IntegrationsTab::ALL.iter().enumerate().map(|(i, &tab)| {
        enter(
            side_row(t, s.integrations == tab).key(format!("int-tab/{}", tab.label())).role("button").label(tab.label())
                .child(ico(tab_icon(tab), t.dim))
                .child(text(tab.label()).font(ui(14.0, 400.0)).color(t.text).grow(1.0))
                .child(text(tab_count(s, tab).to_string()).font(tabular(12.0, 400.0)).color(t.faint))
                .on_press(move |s: &mut App| {
                    s.integrations = tab;
                    s.app_category = None;
                }),
            i,
        )
    });
    let mut cats: Vec<&'static str> = Vec::new();
    for a in &s.data.extra.catalog {
        if !cats.contains(&a.category) {
            cats.push(a.category);
        }
    }
    let categories = (s.integrations == IntegrationsTab::Apps).then(|| {
        let mut items: Vec<(String, Option<&'static str>)> = vec![("All".to_owned(), None)];
        items.extend(cats.iter().map(|&c| (c.to_owned(), Some(c))));
        col()
            .child(sec(t, None, "Categories", false))
            .children(items.into_iter().map(|(name, cat)| {
                side_row(t, s.app_category == cat).key(format!("int-cat/{name}")).role("button").label(name.clone())
                    .child(text(name).font(ui(14.0, 400.0)).color(t.text).grow(1.0))
                    .on_press(move |s: &mut App| s.app_category = cat)
            }))
    });
    col().h_full().min_h(0.0)
        .child(side_head(t, "Integrations", None))
        .child(col().grow(1.0).min_h(0.0).px(8.0).children(tabs).children(categories))
        .child(me(s, t))
}

/// The tab's logo tile: an app's logo for `app-<slug>`, otherwise an interface icon.
fn logo(icon: &str) -> El {
    let (tile, border, ink) = (theme::hex("#232323"), theme::hex("#2e2e2e"), theme::hex("#e0e0e0"));
    match icon.strip_prefix("app-") {
        Some(slug) => app_logo(slug, tile, border, ink),
        None => el().size(34.0, 34.0).radius(9.0).fill(tile).border(1.0, border).center().child(ico_s(icon, 18.0, ink)),
    }
}

/// Cards in rows of `cols`, each row padded out so the last card keeps its column width.
fn grid(cards: Vec<El>, cols: usize) -> El {
    let mut rows: Vec<El> = Vec::new();
    let mut it = cards.into_iter().peekable();
    let mut r = 0;
    while it.peek().is_some() {
        let mut cells: Vec<El> = it.by_ref().take(cols).map(|c| c.grow(1.0).w(0.0)).collect();
        while cells.len() < cols {
            cells.push(el().grow(1.0).w(0.0));
        }
        rows.push(enter(row().gap(12.0).items_stretch().children(cells), r));
        r += 1;
    }
    col().gap(12.0).children(rows)
}

fn matches(q: &str, parts: &[&str]) -> bool {
    q.is_empty() || parts.iter().any(|p| p.to_lowercase().contains(q))
}

fn empty(t: &Theme, what: &str) -> El {
    text(what.to_owned()).font(ui(13.5, 400.0)).color(t.faint).py(12.0)
}

fn h3(t: &Theme, label: &str) -> El {
    text(label.to_owned()).font(ui(13.0, 600.0)).color(t.dim).mt(8.0)
}

pub fn main(s: &App, t: &Theme) -> El {
    let tab = s.integrations;
    let (title, sub, action, placeholder) = match tab {
        IntegrationsTab::Plugins => ("Plugins", "Bundles of skills, commands and connectors you can install.", "Browse plugins", "Search plugins"),
        IntegrationsTab::Apps => ("Apps", "Connect the apps your agents work through. They ask before anything goes out.", "Add app", "Search apps"),
        IntegrationsTab::Mcp => ("MCP servers", "Servers that give the engine extra tools.", "Add server", "Search MCP servers"),
        IntegrationsTab::Skills => ("Skills", "Reusable instructions the engine can pick up when a task needs them.", "New skill", "Search skills"),
    };
    let q = s.edit(EditKey::AppSearch).text.trim().to_lowercase();
    let head = row().gap(16.0).center_y()
        .child(heading(t, title, Some(sub.to_owned())).grow(1.0).min_w(0.0))
        .child(btn_primary(t, action, "plus").key("int-primary"));
    let search = row().h(44.0).gap(10.0).px(14.0).radius(12.0).center_y().fill(theme::hex("#1b1b1b")).border(1.0, theme::hex("#2c2c2c"))
        .child(ico("search", t.faint))
        .child(text_input(s.edit(EditKey::AppSearch), ui(14.5, 400.0)).key("app-search").single_line().grow(1.0).color(t.text)
            .placeholder(placeholder, t.faint).caret(t.accent, t.accent.alpha(0.3)).label(placeholder)
            .on_edit(|s: &mut App| s.edit_mut(EditKey::AppSearch)));
    let body = match tab {
        IntegrationsTab::Plugins => plugins(s, t, &q),
        IntegrationsTab::Apps => apps(s, t, &q),
        IntegrationsTab::Mcp => mcp(s, t, &q),
        IntegrationsTab::Skills => skills(s, t, &q),
    };
    let page = col().key("integrations-page").w_full().max_w(900.0).padding(28.0).gap(18.0)
        .child(head)
        .child(search)
        .child(body);
    col().w_full().h_full().items_center().scroll(ScrollSpec { stick_bottom: false }).child(page)
}

fn plugins(s: &App, t: &Theme, q: &str) -> El {
    let cards: Vec<El> = s.data.extra.plugins.iter().filter(|p| matches(q, &[p.name.as_str(), p.note.as_str(), p.by.as_str()])).map(|p| {
        let id = p.id.clone();
        let action = if p.installed {
            btn(t, "Installed ✓", None, ButtonKind::Plain)
        } else {
            btn(t, "Install", None, ButtonKind::Blue)
        };
        col().gap(12.0).padding(16.0).radius(12.0).fill(theme::hex("#181818")).border(1.0, t.border)
            .child(row().gap(12.0).center_y()
                .child(logo(p.icon))
                .child(col().grow(1.0).min_w(0.0)
                    .child(text(p.name.clone()).font(ui(14.0, 600.0)).color(t.text).truncate())
                    .child(text(format!("by {}", p.by)).font(ui(12.0, 400.0)).color(t.faint).truncate())))
            .child(text(p.note.clone()).font(ui(13.0, 400.0)).color(t.dim).wrap().grow(1.0))
            .child(row().justify_end().child(action.key(format!("plugin/{}", p.id)).on_press(move |s: &mut App| s.toggle_plugin(&id))))
    }).collect();
    if cards.is_empty() {
        return empty(t, "No plugins match your search.");
    }
    grid(cards, 2)
}

fn apps(s: &App, t: &Theme, q: &str) -> El {
    let catalog = &s.data.extra.catalog;
    let connected: Vec<El> = catalog.iter().filter(|a| a.connected && matches(q, &[a.name.as_str(), a.note.as_str(), a.category])).enumerate().map(|(i, a)| {
        enter(
            row().gap(12.0).px(12.0).py(10.0).radius(12.0).center_y().hover(t.hover)
                .child(logo(&format!("app-{}", a.slug)))
                .child(col().grow(1.0).min_w(0.0)
                    .child(text(a.name.clone()).font(ui(14.0, 600.0)).color(t.text))
                    .child(text(a.note.clone()).font(ui(12.5, 400.0)).color(t.faint).truncate()))
                .child(btn(t, "Manage", None, ButtonKind::Plain).key(format!("app-manage/{}", a.slug))),
            i,
        )
    }).collect();
    let tiles: Vec<El> = catalog.iter()
        .filter(|a| s.app_category.map_or(true, |c| c == a.category) && matches(q, &[a.name.as_str(), a.note.as_str(), a.category]))
        .map(|a| {
            let slug = a.slug;
            let button = if a.connected {
                btn(t, "Connected", None, ButtonKind::Plain)
            } else {
                btn(t, "Connect", None, ButtonKind::Blue)
            };
            col().gap(10.0).padding(12.0).radius(12.0).fill(theme::hex("#181818")).border(1.0, t.border)
                .child(row().gap(10.0).center_y()
                    .child(logo(&format!("app-{}", a.slug)))
                    .child(col().grow(1.0).min_w(0.0)
                        .child(text(a.name.clone()).font(ui(13.5, 600.0)).color(t.text).truncate())
                        .child(text(a.category).font(ui(12.0, 400.0)).color(t.faint).truncate())))
                .child(text(a.note.clone()).font(ui(12.5, 400.0)).color(t.dim).wrap().grow(1.0))
                .child(row().justify_end().child(button.key(format!("app/{slug}")).on_press(move |s: &mut App| s.toggle_app(slug))))
        }).collect();
    let all_title = s.app_category.map_or_else(|| "All apps".to_owned(), str::to_owned);
    col().gap(12.0)
        .child(h3(t, "Connected"))
        .child(if connected.is_empty() { empty(t, "Nothing connected yet.") } else { col().gap(2.0).children(connected) })
        .child(h3(t, &all_title))
        .child(if tiles.is_empty() { empty(t, "No apps match.") } else { grid(tiles, 3) })
}

fn mcp(s: &App, t: &Theme, q: &str) -> El {
    let rows: Vec<El> = s.data.extra.mcp.iter().filter(|m| matches(q, &[m.name.as_str(), m.note.as_str()])).enumerate().map(|(i, m)| {
        let name = m.name.clone();
        enter(
            row().gap(12.0).px(14.0).py(12.0).radius(12.0).center_y().fill(theme::hex("#181818")).border(1.0, t.border)
                .child(ico("chip", t.dim))
                .child(col().grow(1.0).min_w(0.0)
                    .child(text(m.name.clone()).font(ui(14.0, 600.0)).color(t.text))
                    .child(text(m.note.clone()).font(ui(12.5, 400.0)).color(t.faint).truncate()))
                .child(text(format!("{} tools", m.tools)).font(tabular(12.5, 400.0)).color(t.faint))
                .child(toggle(t, format!("mcp/{}", m.name), m.on, &m.name).on_press(move |s: &mut App| s.toggle_mcp(&name))),
            i,
        )
    }).collect();
    if rows.is_empty() {
        return empty(t, "No MCP servers match.");
    }
    col().gap(8.0).children(rows)
}

fn skills(s: &App, t: &Theme, q: &str) -> El {
    let rows: Vec<El> = s.data.extra.skills.iter().filter(|(n, d)| matches(q, &[n.as_str(), d.as_str()])).enumerate().map(|(i, (name, desc))| {
        enter(
            row().gap(12.0).px(14.0).py(12.0).radius(12.0).center_y().fill(theme::hex("#181818")).border(1.0, t.border)
                .child(ico("book", t.dim))
                .child(col().grow(1.0).min_w(0.0).gap(2.0)
                    .child(text(name.clone()).font(mono(13.0, 18.0)).color(t.text))
                    .child(text(desc.clone()).font(ui(12.5, 400.0)).color(t.faint).wrap()))
                .key(format!("skill/{name}")),
            i,
        )
    }).collect();
    if rows.is_empty() {
        return empty(t, "No skills match.");
    }
    col().gap(8.0).children(rows)
}

/// This view has no dropdown menus of its own.
pub fn menu(_s: &App, _t: &Theme, _id: &str) -> Option<El> {
    None
}
