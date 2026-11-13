//! The app's state, and the handlers that change it.

use std::collections::HashMap;

use rune::{Chord, Key, KeyEvent, TextEdit, Tx};

use crate::model::Snapshot;
use crate::store::{Store, Target, mock::MockStore};
use crate::views::{office_art::OfficeArt, warp::Warp};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    /// The agents as a pixel-art office.
    Office,
    /// The agents as a list ("Mission control"), the default view.
    Board,
    Chat,
    Code,
    Prs,
    Apps,
    Settings,
}

/// Each composer keeps its own draft.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EditKey {
    Search,
    OfficeDock,
    Board,
    ChatHome,
    ChatThread,
    Drawer,
    AgentPane,
    AppSearch,
}

impl EditKey {
    pub const ALL: [EditKey; 8] = [
        EditKey::Search, EditKey::OfficeDock, EditKey::Board, EditKey::ChatHome,
        EditKey::ChatThread, EditKey::Drawer, EditKey::AgentPane, EditKey::AppSearch,
    ];
    pub fn name(self) -> &'static str {
        match self {
            EditKey::Search => "search",
            EditKey::OfficeDock => "office",
            EditKey::Board => "board",
            EditKey::ChatHome => "chat-home",
            EditKey::ChatThread => "chat-thread",
            EditKey::Drawer => "drawer",
            EditKey::AgentPane => "agent-pane",
            EditKey::AppSearch => "app-search",
        }
    }
}

pub struct App {
    pub view: View,
    pub data: Snapshot,
    store: Box<dyn Store>,
    edits: HashMap<EditKey, TextEdit>,
    /// The agent whose Appearance popover is open (from its "more" button in the Agents list).
    pub appearance: Option<String>,
    /// The agent whose drawer is open in the Office.
    pub drawer: Option<String>,
    /// The open chat, or the Chat home.
    pub chat: Option<String>,
    pub pr: u32,
    /// The last send that failed, shown under the composer.
    pub notice: Option<String>,
    pub office: OfficeArt,
    /// Whether the system asks for reduced motion, as the view last saw it.
    pub reduced: std::cell::Cell<bool>,
    pub warp: Warp,
}

impl App {
    pub fn new(mut store: Box<dyn Store>) -> App {
        let data = store.load();
        App {
            view: View::Board,
            data,
            store,
            edits: EditKey::ALL.iter().map(|&k| (k, TextEdit::new(""))).collect(),
            drawer: None,
            appearance: None,
            chat: None,
            pr: 44,
            notice: None,
            office: OfficeArt::default(),
            reduced: std::cell::Cell::new(false),
            warp: Warp::default(),
        }
    }

    pub fn with_mock() -> App {
        App::new(Box::new(MockStore))
    }

    pub fn go(&mut self, view: View) {
        self.view = view;
        self.drawer = None;
        self.appearance = None;
        if view == View::Chat {
            self.chat = None;
        }
    }

    pub fn open_chat(&mut self, chat: &str) {
        self.chat = Some(chat.to_owned());
        self.store.open(chat);
    }

    /// Repaints a helper (the colour picker in Settings).
    pub fn set_color(&mut self, id: &str, color: &str) {
        if let Some(a) = self.data.team.iter_mut().find(|a| a.id == id) {
            a.color = color.to_owned();
        }
    }

    /// Reshapes a helper (the shape picker in Settings).
    pub fn set_shape(&mut self, id: &str, shape: crate::model::Shape) {
        if let Some(a) = self.data.team.iter_mut().find(|a| a.id == id) {
            a.look.shape = shape;
        }
    }

    pub fn toggle_appearance(&mut self, id: &str) {
        self.appearance = if self.appearance.as_deref() == Some(id) { None } else { Some(id.to_owned()) };
    }

    pub fn open_drawer(&mut self, id: &str) {
        self.drawer = if self.drawer.as_deref() == Some(id) { None } else { Some(id.to_owned()) };
    }

    pub fn edit(&self, key: EditKey) -> &TextEdit {
        // Every key gets its edit in `new`, so this always finds one.
        &self.edits[&key]
    }

    pub fn edit_mut(&mut self, key: EditKey) -> &mut TextEdit {
        self.edits.entry(key).or_insert_with(|| TextEdit::new(""))
    }

    /// Sends a composer's text to whoever it talks to, then clears it.
    pub fn submit(&mut self, key: EditKey, to: &Target) {
        let text = self.edit(key).text.trim().to_owned();
        if text.is_empty() {
            return;
        }
        let to = match to {
            Target::Chat(_) => Target::Chat(self.chat.clone().unwrap_or_default()),
            other => other.clone(),
        };
        match self.store.send(&to, &text, &mut self.data) {
            Ok(()) => {
                self.notice = None;
                self.edit_mut(key).clear();
            }
            Err(e) => self.notice = Some(e),
        }
    }

    pub fn set_waker(&mut self, waker: rune::Waker) {
        self.store.set_waker(waker);
    }

    /// Before every frame: fold in the store's news and step the Office. True when the view
    /// must be rebuilt.
    pub fn poll(&mut self, now: f64, tx: &mut Tx) -> bool {
        let changed = self.store.poll(&mut self.data);
        // Living eyes: glances and blinks move `Live` values, so they never rebuild the view.
        if let Some(wait) = crate::bot::animate(now, self.reduced.get()) {
            tx.wake_after(wait);
        }
        if self.view == View::Office {
            self.office.step(&self.data, now, tx);
        }
        changed
    }

    pub fn key(&mut self, e: &KeyEvent, tx: &mut Tx) -> bool {
        if matches!(e.key, Key::Escape) && (self.drawer.is_some() || self.appearance.is_some()) {
            self.drawer = None;
            self.appearance = None;
            return true;
        }
        if Chord::parse("mod+k").is_ok_and(|c| c.matches_tx(e, tx)) {
            tx.focus("cmdk", true);
            return true;
        }
        false
    }
}
