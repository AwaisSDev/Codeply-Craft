//! The app's interface icons, ported from icons.js (see tools/gen-icons.mjs).
//!
//! Each icon draws at its own grid size by default (24 for the line set and most Codex icons,
//! 20 for the 20-grid OAI icons), so every edge lands on a whole pixel. They are monochrome:
//! they take the colour of the text around them. Colour belongs only to the agents.

#[allow(clippy::all)]
pub mod pack;

use rune::{Color, El, Icon, el, icon};

fn find(name: &str) -> &'static Icon {
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
