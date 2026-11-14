//! The views, one per rail icon. Each returns its sidebar, if it has one, and its main area.
//! Settings is a page of its own (`settings::page`), drawn by the shell over the whole window.

pub mod agents;
pub mod appearance;
pub mod apps;
pub mod browser;
pub mod chat;
pub mod code;
pub mod integrations;
pub mod prs;
pub mod settings;
pub mod tasks;
pub mod terminal;

use rune::{Cx, El};

use crate::app::{App, View};
use crate::theme::Theme;

pub fn build(s: &App, t: &Theme, cx: &mut Cx<App>) -> (Option<El>, El) {
    match s.view {
        View::Agents => (Some(agents::side(s, t)), agents::main(s, t, cx)),
        View::Chat => (Some(chat::side(s, t)), chat::main(s, t, cx)),
        View::Code => (Some(code::side(s, t)), code::main(s, t)),
        View::Prs => (Some(prs::side(s, t)), prs::main(s, t)),
        View::Integrations => (Some(integrations::side(s, t)), integrations::main(s, t)),
        // The shell draws Settings itself, over the whole window; this is never reached.
        View::Settings => (None, rune::el()),
    }
}

/// A view's own dropdown menus, by the id `App::toggle_menu` was given ("agent:<id>", ...).
/// The shell draws the composer's and chats' menus itself.
pub fn menu(s: &App, t: &Theme, id: &str) -> Option<El> {
    agents::menu(s, t, id).or_else(|| browser::menu(s, t, id)).or_else(|| chat::menu(s, t, id)).or_else(|| integrations::menu(s, t, id))
}
