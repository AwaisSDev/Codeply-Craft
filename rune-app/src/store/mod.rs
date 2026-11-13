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
    /// An open chat.
    Chat(String),
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
}
