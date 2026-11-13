//! The live store: the Node engine's local server, `codeply serve` (codeply-cli/lib/server.mjs).
//!
//! What it covers in phase 1:
//! - Chats: `GET /session` fills the Chat sidebar, grouped by project folder.
//! - A transcript: `GET /session/:id` when a chat opens.
//! - Live updates: `GET /event` (server-sent events) folds `run_started`, `text`, `tool_end`,
//!   `approval_request`, `error`, `run_finished` and `session_sync` into what's on screen, and
//!   reconnects with `Last-Event-ID` so nothing is missed.
//! - Sending: `POST /session/:id/message`, and a "Wisp" chat made with `POST /session` for the
//!   Office and Board composers.
//!
//! What it doesn't yet: the engine has no API for the helper agents, pull requests or apps, so the
//! Office, Board, Pull requests and Apps keep the sample data. Every request runs off the UI
//! thread; answers arrive through a channel and wake the window.

use std::io::{BufRead, BufReader};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use super::{Store, Target, mock};
use crate::model::{ChatGroup, Snapshot, ThreadItem};

/// What the worker threads send back to the UI thread.
enum Msg {
    Sessions(Vec<Session>),
    Transcript { id: String, items: Vec<ThreadItem> },
    Event(Value),
    Wisp(String),
    Status(String),
}

#[derive(Clone, Debug)]
struct Session {
    id: String,
    title: String,
    cwd: String,
}

#[derive(Clone)]
struct Conn {
    base: String,
    token: String,
}

impl Conn {
    fn agent() -> ureq::Agent {
        ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(2)).timeout_read(Duration::from_secs(30)).build()
    }
    fn get(&self, path: &str) -> Result<Value, String> {
        Self::agent().get(&format!("{}{path}", self.base)).set("Authorization", &format!("Bearer {}", self.token))
            .call().map_err(|e| e.to_string())?.into_json().map_err(|e| e.to_string())
    }
    fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        Self::agent().post(&format!("{}{path}", self.base)).set("Authorization", &format!("Bearer {}", self.token))
            .send_json(body).map_err(|e| e.to_string())?.into_json().map_err(|e| e.to_string())
    }
}

pub struct LiveStore {
    conn: Conn,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
    waker: Option<rune::Waker>,
    sessions: Vec<Session>,
    /// The engine chat the Office and Board composers talk to Wisp in.
    wisp: Option<String>,
    /// The chat whose transcript is on screen, by its sidebar title.
    open: Option<String>,
}

impl LiveStore {
    pub fn new(url: &str, token: &str) -> LiveStore {
        let (tx, rx) = channel();
        LiveStore { conn: Conn { base: url.trim_end_matches('/').to_owned(), token: token.to_owned() }, tx, rx, waker: None, sessions: Vec::new(), wisp: None, open: None }
    }

    /// Runs `work` on its own thread; its answer comes back through the channel.
    fn spawn(&self, work: impl FnOnce(&Conn) -> Option<Msg> + Send + 'static) {
        let (conn, tx, waker) = (self.conn.clone(), self.tx.clone(), self.waker.clone());
        thread::spawn(move || {
            if let Some(m) = work(&conn) {
                let _ = tx.send(m);
                if let Some(w) = waker {
                    w();
                }
            }
        });
    }

    fn id_of(&self, title: &str) -> Option<String> {
        self.sessions.iter().find(|s| s.title == title).map(|s| s.id.clone())
    }

    fn title_of(&self, id: &str) -> Option<String> {
        self.sessions.iter().find(|s| s.id == id).map(|s| s.title.clone())
    }
}

fn sessions_from(v: &Value) -> Vec<Session> {
    v["sessions"].as_array().map_or_else(Vec::new, |list| {
        list.iter().map(|s| Session {
            id: s["id"].as_str().unwrap_or_default().to_owned(),
            title: s["title"].as_str().unwrap_or("New chat").to_owned(),
            cwd: s["cwd"].as_str().unwrap_or_default().to_owned(),
        }).collect()
    })
}

/// A stored message as the transcript shows it.
pub fn item_from(m: &Value) -> Option<ThreadItem> {
    let text = m["text"].as_str().unwrap_or_default().to_owned();
    match m["kind"].as_str()? {
        "user" => Some(ThreadItem::You(text)),
        "assistant" if !m["interim"].as_bool().unwrap_or(false) => Some(ThreadItem::Them(text)),
        "tool" => Some(ThreadItem::Event { icon: if m["name"] == "run" { "terminal" } else { "edit" }, text: m["label"].as_str().unwrap_or("Used a tool").to_owned() }),
        "notice" => Some(ThreadItem::Event { icon: "help", text }),
        "checkpoint" => Some(ThreadItem::Event { icon: "history", text: format!("Changed {} files", m["total"].as_u64().unwrap_or(0)) }),
        _ => None,
    }
}

/// A live event as the transcript shows it. `None` for events that only change state.
pub fn item_from_event(e: &Value) -> Option<ThreadItem> {
    match e["type"].as_str()? {
        "run_started" => e.get("message").and_then(item_from),
        "text" if !e["interim"].as_bool().unwrap_or(false) => Some(ThreadItem::Them(e["text"].as_str()?.to_owned())),
        "tool_end" => Some(ThreadItem::Event { icon: "check", text: e["summary"].as_str().or(e["name"].as_str()).unwrap_or("Tool").to_owned() }),
        "approval_request" => Some(ThreadItem::Event { icon: "shield-check", text: format!("Needs your OK: {}", e["title"].as_str().unwrap_or("an action")) }),
        "notice" => Some(ThreadItem::Event { icon: "help", text: e["text"].as_str()?.to_owned() }),
        "error" => Some(ThreadItem::Event { icon: "help", text: e["error"].as_str().unwrap_or("Something went wrong").to_owned() }),
        _ => None,
    }
}

/// Reads the event stream until it ends, sending each event; returns the last id seen.
fn read_events(conn: &Conn, after: u64, tx: &Sender<Msg>, waker: &Option<rune::Waker>) -> Result<u64, String> {
    let resp = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(2)).build()
        .get(&format!("{}/event", conn.base)).set("Authorization", &format!("Bearer {}", conn.token)).set("Last-Event-ID", &after.to_string())
        .call().map_err(|e| e.to_string())?;
    let mut last = after;
    let mut data = String::new();
    for line in BufReader::new(resp.into_reader()).lines() {
        let line = line.map_err(|e| e.to_string())?;
        if let Some(id) = line.strip_prefix("id: ") {
            last = id.trim().parse().unwrap_or(last);
        } else if let Some(d) = line.strip_prefix("data: ") {
            data.push_str(d);
        } else if line.is_empty() && !data.is_empty() {
            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                if tx.send(Msg::Event(v)).is_err() {
                    return Ok(last);
                }
                if let Some(w) = waker {
                    w();
                }
            }
            data.clear();
        }
    }
    Ok(last)
}

impl Store for LiveStore {
    fn load(&mut self) -> Snapshot {
        let mut snap = mock::sample();
        snap.chat_groups.clear();
        snap.threads.clear();
        snap.source = format!("codeply serve at {} (connecting)", self.conn.base);
        snap
    }

    fn set_waker(&mut self, waker: rune::Waker) {
        self.waker = Some(waker.clone());
        // The chat list, once.
        self.spawn(|c| Some(match c.get("/session") {
            Ok(v) => Msg::Sessions(sessions_from(&v)),
            Err(e) => Msg::Status(format!("can't reach codeply serve: {e}")),
        }));
        // The event stream, for the life of the app, reconnecting with a growing pause.
        let (conn, tx) = (self.conn.clone(), self.tx.clone());
        thread::spawn(move || {
            let (mut after, mut pause) = (0u64, 1u64);
            loop {
                match read_events(&conn, after, &tx, &Some(waker.clone())) {
                    Ok(last) => { after = last; pause = 1; }
                    Err(e) => {
                        if tx.send(Msg::Status(format!("event stream: {e}"))).is_err() {
                            return;
                        }
                        waker();
                    }
                }
                thread::sleep(Duration::from_secs(pause));
                pause = (pause * 2).min(30);
            }
        });
    }

    fn poll(&mut self, snap: &mut Snapshot) -> bool {
        let mut changed = false;
        while let Ok(msg) = self.rx.try_recv() {
            changed = true;
            match msg {
                Msg::Sessions(list) => {
                    self.sessions = list;
                    snap.source = format!("codeply serve at {}", self.conn.base);
                    snap.chat_groups = group(&self.sessions);
                }
                Msg::Transcript { id, items } => {
                    if let Some(title) = self.title_of(&id) {
                        snap.threads.retain(|(k, _)| *k != title);
                        snap.threads.push((title, items));
                    }
                }
                Msg::Event(e) => {
                    let id = e["sessionId"].as_str().unwrap_or_default().to_owned();
                    if e["type"] == "session_sync" {
                        if let Some(meta) = e.get("session") {
                            let s = Session { id: id.clone(), title: meta["title"].as_str().unwrap_or("New chat").to_owned(), cwd: meta["cwd"].as_str().unwrap_or_default().to_owned() };
                            match self.sessions.iter_mut().find(|x| x.id == id) {
                                Some(x) => *x = s,
                                None => self.sessions.insert(0, s),
                            }
                            snap.chat_groups = group(&self.sessions);
                        }
                    } else if let (Some(title), Some(item)) = (self.title_of(&id), item_from_event(&e)) {
                        match snap.threads.iter_mut().find(|(k, _)| *k == title) {
                            Some((_, items)) => items.push(item),
                            None => snap.threads.push((title, vec![item])),
                        }
                    }
                }
                Msg::Wisp(id) => self.wisp = Some(id),
                Msg::Status(s) => snap.source = s,
            }
        }
        changed
    }

    fn open(&mut self, chat: &str) {
        self.open = Some(chat.to_owned());
        let Some(id) = self.id_of(chat) else { return };
        self.spawn(move |c| {
            let v = c.get(&format!("/session/{id}")).ok()?;
            let items = v["session"]["messages"].as_array()?.iter().filter_map(item_from).collect();
            Some(Msg::Transcript { id, items })
        });
    }

    fn send(&mut self, to: &Target, text: &str, snap: &mut Snapshot) -> Result<(), String> {
        let shown = text.to_owned();
        let text = text.to_owned();
        match to {
            Target::Chat(title) => {
                let id = self.id_of(title).ok_or("That chat isn't on the engine yet.")?;
                self.spawn(move |c| c.post(&format!("/session/{id}/message"), json!({ "text": text })).err().map(|e| Msg::Status(format!("send failed: {e}"))));
                Ok(())
            }
            Target::Wisp => {
                let known = self.wisp.clone();
                self.spawn(move |c| {
                    let id = match known {
                        Some(id) => id,
                        None => c.post("/session", json!({ "title": "Wisp" })).ok()?["session"]["id"].as_str()?.to_owned(),
                    };
                    match c.post(&format!("/session/{id}/message"), json!({ "text": text })) {
                        Ok(_) => Some(Msg::Wisp(id)),
                        Err(e) => Some(Msg::Status(format!("send failed: {e}"))),
                    }
                });
                mock::echo(snap, to, &shown, "Sent to the engine. The reply shows in Chat, in the Wisp chat.");
                Ok(())
            }
            Target::Agent(_) => Err("Helper agents aren't in the engine's API yet; message Wisp instead.".into()),
        }
    }
}

/// Chats grouped by project folder, as the Chat sidebar shows them.
fn group(sessions: &[Session]) -> Vec<ChatGroup> {
    let mut groups: Vec<ChatGroup> = Vec::new();
    for s in sessions {
        let folder = std::path::Path::new(&s.cwd).file_name().and_then(|n| n.to_str()).unwrap_or("Chats").to_owned();
        match groups.iter_mut().find(|g| g.title == folder) {
            Some(g) => g.chats.push(s.title.clone()),
            None => groups.push(ChatGroup { icon: "oai-folder", title: folder, chats: vec![s.title.clone()] }),
        }
    }
    groups
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_messages_become_transcript_items() {
        assert_eq!(item_from(&json!({ "kind": "user", "text": "hi" })), Some(ThreadItem::You("hi".into())));
        assert_eq!(item_from(&json!({ "kind": "assistant", "text": "hello", "interim": true })), None);
        assert!(matches!(item_from(&json!({ "kind": "tool", "name": "run", "label": "npm test" })), Some(ThreadItem::Event { icon: "terminal", .. })));
    }

    #[test]
    fn events_become_transcript_items() {
        let e = json!({ "type": "approval_request", "title": "Run npm install" });
        assert!(matches!(item_from_event(&e), Some(ThreadItem::Event { text, .. }) if text == "Needs your OK: Run npm install"));
        assert_eq!(item_from_event(&json!({ "type": "run_finished" })), None);
    }

    #[test]
    fn chats_group_by_folder() {
        let s = |id: &str, title: &str, cwd: &str| Session { id: id.into(), title: title.into(), cwd: cwd.into() };
        let g = group(&[s("a", "One", "/w/launch-site"), s("b", "Two", "/w/other"), s("c", "Three", "/w/launch-site")]);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].chats, ["One", "Three"]);
    }

    /// Against a running engine: `codeply serve --port 4777 --password "$CODEPLY_TOKEN"`, then
    /// `CODEPLY_SERVER=http://127.0.0.1:4777 CODEPLY_TOKEN=... cargo test --features live -- --ignored`.
    #[test]
    #[ignore = "needs a running `codeply serve`"]
    fn talks_to_a_running_engine() {
        let url = std::env::var("CODEPLY_SERVER").unwrap_or_else(|_| "http://127.0.0.1:4777".into());
        let token = std::env::var("CODEPLY_TOKEN").unwrap_or_default();
        let name = format!("Made by the test {}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis()));
        let mut store = LiveStore::new(&url, &token);
        let mut snap = store.load();
        store.set_waker(std::sync::Arc::new(|| {}));
        let wait = |store: &mut LiveStore, snap: &mut Snapshot, done: &dyn Fn(&Snapshot) -> bool| {
            for _ in 0..100 {
                store.poll(snap);
                if done(snap) {
                    return true;
                }
                thread::sleep(Duration::from_millis(50));
            }
            false
        };
        assert!(wait(&mut store, &mut snap, &|s| !s.chat_groups.is_empty()), "the chat list arrives: {}", snap.source);
        let before: usize = snap.chat_groups.iter().map(|g| g.chats.len()).sum();

        // A chat made elsewhere shows up through the event stream.
        Conn { base: url.clone(), token: token.clone() }.post("/session", json!({ "title": name })).ok();
        assert!(wait(&mut store, &mut snap, &|s| s.chat_groups.iter().any(|g| g.chats.contains(&name))), "session_sync arrives over SSE");
        assert_eq!(snap.chat_groups.iter().map(|g| g.chats.len()).sum::<usize>(), before + 1);

        // Sending starts a run; whatever the engine says (a reply, or an error with no model set up)
        // comes back over the stream into the open transcript.
        store.open(name.as_str());
        assert!(store.send(&Target::Chat(name.clone()), "hello from the Rune app", &mut snap).is_ok());
        assert!(wait(&mut store, &mut snap, &|s| s.threads.iter().any(|(k, v)| *k == name && !v.is_empty())), "the run's events reach the transcript");
        let items = snap.thread(name.as_str()).to_vec();
        assert!(items.iter().any(|i| matches!(i, ThreadItem::You(t) if t == "hello from the Rune app")), "{items:?}");
        // With no model signed in, the engine says so as a notice; with one, a reply comes. Either
        // way something past the message itself arrives.
        assert!(wait(&mut store, &mut snap, &|s| s.thread(name.as_str()).len() >= 2), "{:?}", snap.thread(name.as_str()));
    }
}

