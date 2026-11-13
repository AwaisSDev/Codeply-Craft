//! The app's interface icons, ported from icons.js (see tools/gen-icons.mjs).
//!
//! Each icon draws at its own grid size by default (24 for the line set and most Codex icons,
//! 20 for the 20-grid OAI icons), so every edge lands on a whole pixel. They are monochrome:
//! they take the colour of the text around them. Colour belongs only to the agents.

#[allow(clippy::all)]
pub mod pack;

use rune::{Color, El, Icon, el, icon};

/// The rail's Office icon, drawn for Codeply in the OAI set's weight (icons.js has no office).
static OAI_OFFICE: Icon = Icon {
    name: "oai-office",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 20.5V6.5A3 3 0 0 1 9 3.5h6a3 3 0 0 1 3 3v14"/><path d="M3.5 20.5h17"/><path d="M10.5 20.5v-3a1.5 1.5 0 0 1 3 0v3"/></g><g fill="currentColor"><rect x="9" y="7" width="2.2" height="2.2" rx="0.6"/><rect x="12.8" y="7" width="2.2" height="2.2" rx="0.6"/><rect x="9" y="11" width="2.2" height="2.2" rx="0.6"/><rect x="12.8" y="11" width="2.2" height="2.2" rx="0.6"/></g>"#,
};

/// The composer's approval chip, drawn for Codeply: a shield that fills the 24 grid (the stock
/// one sits small inside it) with a bold tick ("Approve manually") or a bold "!" ("Full access"),
/// on a 2 unit stroke so it reads at chip size.
static APPROVE_ASK: Icon = Icon {
    name: "approve-ask",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.4 19.6 5.3a1.2 1.2 0 0 1 .78 1.12V11.6c0 5.05-3.42 9.2-8.38 10.4C7.04 20.8 3.62 16.65 3.62 11.6V6.42a1.2 1.2 0 0 1 .78-1.12Z"/><path d="m8.1 12.3 2.75 2.75 5.15-5.4"/></g>"#,
};

static APPROVE_FULL: Icon = Icon {
    name: "approve-full",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.4 19.6 5.3a1.2 1.2 0 0 1 .78 1.12V11.6c0 5.05-3.42 9.2-8.38 10.4C7.04 20.8 3.62 16.65 3.62 11.6V6.42a1.2 1.2 0 0 1 .78-1.12Z"/><path d="M12 7.4v5.4" stroke-width="2.4"/></g><circle cx="12" cy="16.3" r="1.35" fill="currentColor"/>"#,
};

fn find(name: &str) -> &'static Icon {
    match name {
        "oai-office" => return &OAI_OFFICE,
        "approve-ask" => return &APPROVE_ASK,
        "approve-full" => return &APPROVE_FULL,
        _ => {}
    }
    pack::get(name).unwrap_or(&pack::CIRCLE)
}

/// An icon at its grid size.
pub fn ico(name: &str, color: Color) -> El {
    let i = find(name);
    icon(i, i.view).color(color)
}

/// An icon at a smaller size (16 or 12, the prototype's `s16` and `s12`).
pub fn ico_s(name: &str, size: f32, color: Color) -> El {
    icon(find(name), size).color(color)
}

/// An app's logo (simple-icons), on the prototype's rounded tile.
pub fn app_logo(slug: &str, tile: Color, border: Color, ink: Color) -> El {
    let logo = pack::get(&format!("app-{slug}")).map(|i| icon(i, 18.0).color(ink));
    el().size(34.0, 34.0).radius(9.0).fill(tile).border(1.0, border).center().children(logo)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_icon_the_prototype_uses_exists() {
        for n in [
            "oai-users", "oai-chat", "code", "branch", "link", "oai-settings", "oai-search", "bell", "plus", "shield-check", "chevron-down",
            "mic", "arrow-up", "oai-folder", "oai-compose", "oai-desktop", "oai-cloud", "chart", "history", "gauge", "calendar", "refresh",
            "check", "edit", "terminal", "help", "sun", "mail", "folder-open", "file-text", "file", "chevron-right", "folder", "external",
            "sparkle", "users", "menu", "close", "search",
        ] {
            assert!(pack::get(n).is_some(), "missing icon {n}");
        }
        for slug in ["gmail", "googlecalendar", "github", "slack", "notion", "vercel", "linear", "stripe", "figma", "googledrive", "discord", "whatsapp", "hubspot", "zoom"] {
            assert!(pack::get(&format!("app-{slug}")).is_some(), "missing logo {slug}");
        }
    }

    #[test]
    fn grids_are_whole_pixels() {
        for n in pack::NAMES {
            let v = find(n).view;
            assert!(v == 20.0 || v == 24.0, "{n} has a {v} grid");
        }
    }
}
