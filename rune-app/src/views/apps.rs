//! Apps: the integrations agents act through. Search across 34,000 apps, the connected ones and
//! which agents use them, popular apps, and recent actions taken through them.

use rune::{El, ScrollSpec, col, row, text, text_input};

use crate::app::{App, EditKey};
use crate::bot;
use crate::icons::{app_logo, ico};
use crate::model::ButtonKind;
use crate::theme::{self, Theme, tabular, ui};
use crate::ui::{btn, enter, fade_in, heading, me, rich_text, side_head, side_row, ENTER};

pub fn side(s: &App, t: &Theme) -> El {
    let cats = [("link", "Connected", "6"), ("mail", "Communication", "1.2k"), ("code", "Developer", "3.4k"), ("calendar", "Productivity", "5.1k"), ("chart", "Finance", "2.2k"), ("users", "CRM and sales", "2.8k")];
    col().h_full().min_h(0.0)
        .child(side_head(t, "Apps", None))
        .child(col().grow(1.0).min_h(0.0).px(8.0).children(cats.iter().enumerate().map(|(i, (icon, name, n))| {
            enter(side_row(t, i == 0).child(ico(icon, t.dim)).child(text(*name).font(ui(14.0, 400.0)).color(t.text).grow(1.0))
                .child(text(*n).font(tabular(12.0, 400.0)).color(t.faint)), i)
        })))
        .child(me(s, t))
}

pub fn main(s: &App, t: &Theme) -> El {
    let (tile, tile_border, ink) = (theme::hex("#232323"), theme::hex("#2e2e2e"), theme::hex("#e0e0e0"));
    let h3 = |label: &str, link: Option<&str>| row().pb(10.0).center_y()
        .child(text(label.to_owned()).font(ui(13.0, 600.0)).color(t.dim).grow(1.0))
        .children(link.map(|l| text(l.to_owned()).font(ui(13.0, 400.0)).color(t.faint)));
    let search = row().h(44.0).gap(10.0).px(14.0).mb(28.0).radius(12.0).center_y().fill(theme::hex("#1b1b1b")).border(1.0, theme::hex("#2c2c2c"))
        .child(ico("search", t.faint))
        .child(text_input(s.edit(EditKey::AppSearch), ui(14.5, 400.0)).key("app-search").single_line().grow(1.0).color(t.text)
            .placeholder("Search 34,000 apps", t.faint).caret(t.accent, t.accent.alpha(0.3)).label("Search apps")
            .on_edit(|s: &mut App| s.edit_mut(EditKey::AppSearch)));
    let connected = col().gap(2.0).mb(28.0).children(s.data.connected.iter().enumerate().map(|(i, a)| {
        let who = row().children(a.agents.iter().enumerate().filter_map(|(k, id)| s.data.agent(id).map(|g| bot::agent(g, 22.0).ml(if k == 0 { 0.0 } else { -6.0 }))));
        enter(row().gap(12.0).px(12.0).py(10.0).radius(12.0).center_y().hover(t.hover)
            .child(app_logo(a.slug, tile, tile_border, ink))
            .child(col().grow(1.0).min_w(0.0)
                .child(text(a.name.clone()).font(ui(14.0, 600.0)).color(t.text))
                .child(text(a.note.clone()).font(ui(12.5, 400.0)).color(t.faint).truncate()))
            .child(who)
            .child(btn(t, "Manage", None, ButtonKind::Plain)), i)
    }));
    let tile_app = |slug: &'static str, name: &str, sub: &str| {
        row().gap(10.0).padding(12.0).radius(12.0).center_y().fill(theme::hex("#181818")).border(1.0, t.border).grow(1.0).w(0.0)
            .child(app_logo(slug, tile, tile_border, ink))
            .child(col().grow(1.0).min_w(0.0)
                .child(text(name.to_owned()).font(ui(13.5, 600.0)).color(t.text).wrap())
                .child(text(sub.to_owned()).font(ui(12.0, 400.0)).color(t.faint)))
            .child(btn(t, "Connect", None, ButtonKind::Plain))
    };
    let popular = col().gap(10.0).mb(28.0).children(s.data.popular.chunks(4).enumerate().map(|(r, chunk)| {
        enter(row().gap(10.0).items_stretch().children(chunk.iter().map(|(slug, name, sub)| tile_app(slug, name, sub))), r)
    }));
    let log = col().children(s.data.actions.iter().enumerate().map(|(i, a)| {
        row().gap(12.0).py(10.0).center_y().border_sides([if i == 0 { 0.0 } else { 1.0 }, 0.0, 0.0, 0.0], theme::hex("#222222"))
            .child(app_logo(a.slug, tile, tile_border, ink))
            .child(row().grow(1.0).gap(6.0).center_y().child(rich_text(&a.text, 13.5, t.text, t.text)).child(text(format!("· {}", a.note)).font(ui(13.5, 400.0)).color(t.faint)))
            .child(text(a.time.clone()).font(tabular(12.0, 400.0)).color(t.faint))
    }));
    let page = col().key("apps-page").w_full().max_w(1040.0).px(32.0).pt(8.0).pb(48.0).transition(fade_in()).motion(ENTER)
        .child(row().pt(16.0).pb(12.0).child(heading(t, "Apps", None)))
        .child(text("Connect any of 34,000 apps. Your agents work through them and ask before anything goes out.").font(ui(14.0, 400.0)).color(t.faint).mt(2.0).mb(18.0))
        .child(search)
        .child(h3("Connected", Some("Manage"))).child(connected)
        .child(h3("Popular", Some("Browse all"))).child(popular)
        .child(h3("Recent actions through apps", None)).child(log);
    col().w_full().h_full().items_center().scroll(ScrollSpec { stick_bottom: false }).child(page)
}
