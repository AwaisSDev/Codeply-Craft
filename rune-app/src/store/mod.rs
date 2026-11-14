//! Where the app's data comes from.
//!
//! `MockStore` returns the 4.0 prototype's sample data. `LiveStore` (feature `live`, flag
//! `--store live`) talks to the Node engine's local server, `codeply serve`
//! (codeply-cli/lib/server.mjs), over HTTP and its `/event` SSE stream.

pub mod mock;
#[cfg(feature = "live")]
pub mod live;

use crate::model::Snapshot;

/// Who a composer is talking to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// Wisp, from the Office dock, the Board or a new chat.
    Wisp,
    /// One helper agent, from its drawer or the Code agent pane.
    Agent(String),
    /// An open chat (empty: the one on screen).
    Chat(String),
    /// A new chat, from "What should we build?". It opens once the engine has made it.
    New,
}

pub trait Store {
    /// Everything the views show, read once at launch.
    fn load(&mut self) -> Snapshot;
    /// Folds in whatever arrived since the last call (SSE events, finished requests). True when
    /// `snap` changed. Called from the app's `poll`, so it must not block.
    fn poll(&mut self, snap: &mut Snapshot) -> bool;
    /// Sends a message. The reply arrives later through `poll`.
    fn send(&mut self, to: &Target, text: &str, snap: &mut Snapshot) -> Result<(), String>;
    /// A chat was opened: fetch its transcript if the store doesn't have it.
    fn open(&mut self, _chat: &str) {}
    /// Answers an approval: "once", "always" or "reject".
    fn answer(&mut self, _request: &str, _verdict: &str, _snap: &mut Snapshot) {}
    /// Whether messages go to a real engine (so a sent message opens its chat).
    fn is_live(&self) -> bool {
        false
    }
    /// Gives the store a way to wake the UI thread when data arrives off it.
    fn set_waker(&mut self, _waker: rune::Waker) {}
    /// Stops the reply being written in a chat (by title).
    fn abort(&mut self, _chat: &str) {}
    /// Settings that change how the engine works (when it asks before acting, the effort).
    fn configure(&mut self, _prefs: &crate::prefs::Prefs) {}
    /// A chat the store made that should open now (a new chat's title, once it has one).
    fn take_focus(&mut self) -> Option<String> {
        None
    }
    /// Fetches your token use into `extra.usage` (the usage sheet).
    fn load_usage(&mut self, _snap: &mut Snapshot) {}
    /// Chats renamed since the last call, as (old title, new title): the engine titles a new
    /// chat from its first message, so the app follows a chat it has open.
    fn take_renames(&mut self) -> Vec<(String, String)> {
        Vec::new()
    }
    /// Runs a shell command in the project folder; its output streams into `extra.terminal`.
    fn run_command(&mut self, _cmd: &str, _snap: &mut Snapshot) {}
    /// Stops a background task (an agent's run or a command), by id.
    fn kill(&mut self, _id: &str, _snap: &mut Snapshot) {}
    /// Publishes the project (the chat's, or the default one); progress lands in `extra.publish`.
    fn publish(&mut self, _chat: Option<&str>, _snap: &mut Snapshot) {}

    // ---------- account ----------
    /// Emails a sign-in code; `extra.sign_in` becomes "sent" or "error: ...".
    fn send_code(&mut self, _email: &str, _snap: &mut Snapshot) {}
    /// Signs in with the emailed code; `extra.signed_in` and `user` follow.
    fn verify_code(&mut self, _email: &str, _code: &str, _snap: &mut Snapshot) {}
    fn sign_out(&mut self, _snap: &mut Snapshot) {}

    // ---------- apps (MCP connections) ----------
    /// Fills `extra.catalog` with apps matching `query` (the featured ones when empty).
    fn search_apps(&mut self, _query: &str, _snap: &mut Snapshot) {}
    /// Connects an app: the engine opens its sign-in page in the browser, then it shows as connected.
    fn connect_app(&mut self, _slug: &str, _snap: &mut Snapshot) {}
    fn disconnect_app(&mut self, _slug: &str, _snap: &mut Snapshot) {}

    // ---------- memory ----------
    fn remember(&mut self, _text: &str, _snap: &mut Snapshot) {}
    fn forget(&mut self, _id: &str, _snap: &mut Snapshot) {}

    // ---------- code ----------
    /// Opens a project file; its text lands in `extra.code.saved` (and the app's editor).
    fn open_file(&mut self, _path: &str, _snap: &mut Snapshot) {}
    fn save_file(&mut self, _path: &str, _text: &str, _snap: &mut Snapshot) {}
    /// Asks for a completion at the caret; it lands in `extra.code.suggestion`.
    fn complete(&mut self, _file: &str, _prefix: &str, _suffix: &str, _snap: &mut Snapshot) {}
    /// Asks Wisp to review the file; notes land in `extra.code.review`.
    fn review(&mut self, _file: &str, _text: &str, _snap: &mut Snapshot) {}
    // ---------- models ----------
    /// Reads or changes the model list (see `models::ModelOp`); the answer lands in `extra.models`.
    fn models(&mut self, _op: crate::models::ModelOp, _snap: &mut Snapshot) {}
    /// A page the engine wants opened in the system browser (an app's sign-in), if any.
    fn take_open_url(&mut self) -> Option<String> {
        None
    }
}
