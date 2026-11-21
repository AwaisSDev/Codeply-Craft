//! The composer's "/" and "@" menu (mentions.rs works out what it lists): above the composer,
//! eight rows at a time around the one picked, each with its icon, name and one line about it.

use rune::{Color, El, col, el, row, text};

use crate::app::{App, EditKey};
use crate::icons::{ico_app, ico_s};
use crate::mentions::{Pick, Popup, Trigger};
use crate::theme::{Theme, mono, ui};

/// Rows shown at once.
const ROWS: usize = 8;

/// The open menu, if a composer has one.
pub fn popup(s: &App, t: &Theme) -> Option<El> {
    let key = s.mention.as_ref()?.key;
    let p = s.mention_shown(key)?;
    let n = p.items.len();
    let first = p.pick.saturating_sub(ROWS - 1).min(n.saturating_sub(ROWS));
    let rows = p.items.iter().enumerate().skip(first).take(ROWS).map(|(i, c)| {
        let on = i == p.pick;
        let lead = match &c.pick {
            Pick::Command(cmd) => ico_s(cmd.icon(), 16.0, t.dim),
            Pick::Skill(_) => ico_s("book", 16.0, t.dim),
            Pick::Agent(id, _) => match s.data.agent(id) {
                Some(a) => crate::bot::agent(a, 18.0),
                None => ico_s("users", 16.0, t.dim),
            },
            Pick::App(id, _) => match crate::icons::domain_of(id) {
                Some(_) => ico_app(&format!("app-{id}"), 16.0, t.dim),
                None => ico_s("link", 16.0, t.dim),
            },
            Pick::File(f) => ico_s(if f.ends_with('/') { "folder" } else { "file" }, 16.0, t.dim),
        };
        let name = match &c.pick {
            Pick::Command(_) | Pick::Skill(_) => format!("/{}", c.label),
            _ => c.label.clone(),
        };
        let name_font = if matches!(c.pick, Pick::File(_)) { mono(13.0, 18.0) } else { ui(13.5, 500.0) };
        row().key(format!("mention/{i}")).w_full().h(34.0).px(10.0).gap(10.0).radius(8.0).center_y()
            .fill(if on { t.active } else { Color::TRANSPARENT }).hover(t.hover)
            .role("option").checked(on).label(name.clone())
            .child(el().size(18.0, 18.0).center().child(lead))
            .child(text(name).font(name_font).color(t.text).single_line().shrink().min_w(0.0).truncate())
            .child(text(c.note.clone()).font(ui(12.5, 400.0)).color(t.faint).single_line().truncate().grow(1.0).min_w(0.0))
            .on_press_tx(move |s: &mut App, tx| {
                s.accept_mention(key, i, tx);
            })
    });
    let width = if key == EditKey::CodeAgent { 380.0 } else { 560.0 };
    Some(col().key("mention-menu").w(width).padding(6.0).gap(2.0).radius(12.0)
        .fill(t.popup).border(1.0, t.control_border).shadow(12.0, 32.0, t.shadow)
        .anchored(format!("composer-box/{}", key.name()), rune::Side::Top, rune::Align::Start, 6.0)
        // A click on a row leaves the composer focused, so typing carries on.
        .preserve_focus_on_press(true)
        .role("listbox").label(if p.trigger == Trigger::Slash { "Commands and skills" } else { "Mention" })
        .child(head(t, p))
        .children(rows))
}

/// What the menu holds, and how to use it.
fn head(t: &Theme, p: &Popup) -> El {
    let what = match p.trigger {
        Trigger::Slash => {
            let skills = p.items.iter().filter(|c| matches!(c.pick, Pick::Skill(_))).count();
            let cmds = p.items.len() - skills;
            match (cmds, skills) {
                (0, k) => format!("{k} skill{}", if k == 1 { "" } else { "s" }),
                (c, 0) => format!("{c} command{}", if c == 1 { "" } else { "s" }),
                (c, k) => format!("{c} command{} and {k} skill{}", if c == 1 { "" } else { "s" }, if k == 1 { "" } else { "s" }),
            }
        }
        Trigger::At => "Agents, apps and files".to_owned(),
    };
    row().w_full().px(10.0).pt(4.0).pb(4.0).gap(8.0).center_y()
        .child(text(what).font(ui(12.0, 600.0)).color(t.faint).grow(1.0))
        .child(text("Enter to pick, Esc to close").font(ui(12.0, 400.0)).color(t.faint))
}
