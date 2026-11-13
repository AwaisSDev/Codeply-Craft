//! The five views (plus Board, the Office as a list). Each returns its sidebar, if it has one,
//! and its main area.

pub mod appearance;
pub mod apps;
pub mod board;
pub mod chat;
pub mod code;
pub mod office;
pub mod office_art;
pub mod prs;
pub mod settings;
pub mod warp;

use rune::{Cx, El};

use crate::app::{App, View};
use crate::theme::Theme;

pub fn build(s: &App, t: &Theme, cx: &mut Cx<App>) -> (Option<El>, El) {
    match s.view {
        View::Office => (None, office::main(s, t, cx)),
        View::Board => (Some(board::side(s, t)), board::main(s, t)),
        View::Chat => (Some(chat::side(s, t)), chat::main(s, t, cx)),
        View::Code => (Some(code::side(s, t)), code::main(s, t)),
        View::Prs => (Some(prs::side(s, t)), prs::main(s, t)),
        View::Apps => (Some(apps::side(s, t)), apps::main(s, t)),
        View::Settings => (Some(settings::side(s, t)), settings::main(s, t)),
    }
}
