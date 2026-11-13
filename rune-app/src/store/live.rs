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
use crate::model::{AgentState, BgTask, ButtonKind, CatalogApp, ChatGroup, ChatMeta, Column, Memory, Pill, Publish, ReviewNote, Snapshot, Task, TaskBody, TermKind, TermLine, ThreadItem};

/// What the worker threads send back to the UI thread.
enum Msg {
    Sessions(Vec<Session>),
    /// The engine's project folder's name, its version, and which engine replies ("dsh").
    Project(String, String, String),
    /// A chat `send` made for a new conversation, by engine id: open it once it has a title.
    Created(String),
    Account(Value),
    Apps(Vec<CatalogApp>),
    Memories(Vec<Memory>),
    Files(Vec<String>),
    Tasks(Vec<BgTask>),
    /// A file's text: (path, text).
    File(String, String),
    /// A completion for (file, offset).
    Suggestion(String, usize, String),
    Review(Vec<ReviewNote>),
    SignIn(Option<String>),
    Transcript { id: String, items: Vec<ThreadItem> },
    Event(Value),
    /// A chat made for Wisp or a helper: its name and engine id.
    Named(String, String),
    Status(String),
}

#[derive(Clone, Debug)]
struct Session {
    id: String,
    title: String,
    cwd: String,
    /// Last activity, ms since the epoch.
    updated: u64,
    preview: String,
    running: bool,
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
            .send_json(body).map_err(why)?.into_json().map_err(|e| e.to_string())
    }
    fn put(&self, path: &str, body: Value) -> Result<Value, String> {
        Self::agent().put(&format!("{}{path}", self.base)).set("Authorization", &format!("Bearer {}", self.token))
            .send_json(body).map_err(why)?.into_json().map_err(|e| e.to_string())
    }
    fn delete(&self, path: &str) -> Result<Value, String> {
        Self::agent().delete(&format!("{}{path}", self.base)).set("Authorization", &format!("Bearer {}", self.token))
            .call().map_err(why)?.into_json().map_err(|e| e.to_string())
    }
}

/// An engine error as a person reads it: its `{"error": ...}` message when it sent one.
fn why(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => resp.into_json::<Value>().ok().and_then(|v| v["error"].as_str().map(str::to_owned)).unwrap_or_else(|| format!("status {code}")),
        other => other.to_string(),
    }
}

/// `text` made safe for a URL's query.
fn encode(text: &str) -> String {
    text.bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
        _ => format!("%{b:02X}"),
    }).collect()
}

// ---------- the engine's other features: account, apps, memory, files, terminal ----------

/// App ids and categories as the views keep them (`&'static str`): each distinct one is kept
/// once for the life of the app.
fn intern(s: &str) -> &'static str {
    use std::sync::{Mutex, OnceLock};
    static SEEN: OnceLock<Mutex<std::collections::HashSet<&'static str>>> = OnceLock::new();
    let mut seen = SEEN.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    if let Some(k) = seen.get(s) {
        return k;
    }
    let k: &'static str = Box::leak(s.to_owned().into_boxed_str());
    seen.insert(k);
    k
}

fn apps_from(v: &Value) -> Vec<CatalogApp> {
    v["apps"].as_array().map_or_else(Vec::new, |list| {
        list.iter().filter_map(|a| {
            let id = a["id"].as_str()?;
            Some(CatalogApp {
                slug: intern(id),
                name: a["name"].as_str().unwrap_or(id).to_owned(),
                note: a["note"].as_str().or(a["description"].as_str()).unwrap_or_default().chars().take(140).collect(),
                category: intern(a["category"].as_str().filter(|c| !c.is_empty()).unwrap_or("Apps")),
                connected: a["connected"].as_bool().unwrap_or(false),
                domain: a["domain"].as_str().unwrap_or_default().to_owned(),
                icon: a["icon"].as_str().unwrap_or_default().to_owned(),
            })
        }).collect()
    })
}

fn memories_from(v: &Value) -> Vec<Memory> {
    v["memories"].as_array().map_or_else(Vec::new, |list| {
        list.iter().map(|m| Memory {
            id: m["id"].as_str().map(str::to_owned).unwrap_or_else(|| m["id"].to_string()),
            kind: m["kind"].as_str().unwrap_or("note").to_owned(),
            text: m["text"].as_str().unwrap_or_default().to_owned(),
            scope: m["scope"].as_str().unwrap_or("me").to_owned(),
        }).collect()
    })
}

fn task_from(t: &Value) -> Option<BgTask> {
    Some(BgTask {
        id: t["id"].as_str()?.to_owned(),
        kind: if t["kind"] == "agent" { "agent" } else { "command" },
        title: t["title"].as_str().unwrap_or("Task").to_owned(),
        agent: t["agent"].as_str().map(str::to_owned),
        detail: t["detail"].as_str().unwrap_or_default().to_owned(),
        running: t["running"].as_bool().unwrap_or(false),
    })
}

impl LiveStore {
    /// Fetches the account, apps, memories and files (at launch, and after they change).
    fn refresh(&self, what: &'static str) {
        self.spawn(move |c| {
            for _ in 0..120 {
                let got = match what {
                    "account" => c.get("/account").map(Msg::Account),
                    "apps" => c.get("/apps").map(|v| Msg::Apps(apps_from(&v))),
                    "memory" => c.get("/memory").map(|v| Msg::Memories(memories_from(&v))),
                    "files" => c.get("/files").map(|v| Msg::Files(v["files"].as_array().map_or_else(Vec::new, |a| a.iter().filter_map(|f| f.as_str().map(str::to_owned)).collect()))),
                    _ => c.get("/jobs").map(|v| Msg::Tasks(v["tasks"].as_array().map_or_else(Vec::new, |a| a.iter().filter_map(task_from).collect()))),
                };
                match got {
                    Ok(m) => return Some(m),
                    Err(_) => thread::sleep(Duration::from_millis(250)),
                }
            }
            None
        });
    }

    /// Folds the events of the engine's other features. True when it took the event.
    fn fold_extra(&mut self, e: &Value, snap: &mut Snapshot) -> bool {
        let x = &mut snap.extra;
        match e["type"].as_str().unwrap_or_default() {
            "term_agent" => x.terminal.push(TermLine { kind: TermKind::Agent, text: e["command"].as_str().unwrap_or_default().to_owned() }),
            "term_output" => {
                let kind = if e["stream"] == "err" { TermKind::Err } else { TermKind::Out };
                for line in e["text"].as_str().unwrap_or_default().lines() {
                    x.terminal.push(TermLine { kind, text: line.to_owned() });
                }
                // Keep the pane light: the last 2000 lines.
                let over = x.terminal.len().saturating_sub(2000);
                x.terminal.drain(..over);
            }
            "term_exit" => x.terminal.push(TermLine { kind: TermKind::Exit, text: format!("exited with {}", e["code"].as_i64().unwrap_or(0)) }),
            "task_update" => {
                if let Some(t) = task_from(&e["task"]) {
                    match x.bg_tasks.iter_mut().find(|k| k.id == t.id) {
                        Some(k) => *k = t,
                        None => x.bg_tasks.insert(0, t),
                    }
                }
            }
            "publish" => {
                x.publish = Some(Publish {
                    running: e["running"].as_bool().unwrap_or(false),
                    url: e["url"].as_str().filter(|u| !u.is_empty()).map(str::to_owned),
                    message: e["message"].as_str().unwrap_or(if e["running"].as_bool().unwrap_or(false) { "Publishing" } else { "Published" }).to_owned(),
                });
            }
            "open_url" => self.open_url = e["url"].as_str().map(str::to_owned),
            "apps_changed" => self.refresh("apps"),
            "memory_changed" => self.refresh("memory"),
            "account_changed" => self.refresh("account"),
            _ => return false,
        }
        true
    }

    /// Wisp handed work to an agent, or got it back: shown in Wisp's chat.
    fn fold_delegation(&self, e: &Value, snap: &mut Snapshot) {
        let Some(title) = self.title_of(e["sessionId"].as_str().unwrap_or_default()) else { return };
        let name = e["agent"].as_str().unwrap_or("an agent").to_owned();
        let id = snap.team.iter().find(|a| a.name.eq_ignore_ascii_case(&name) || a.id == name).map(|a| a.id.clone());
        let item = match (e["type"].as_str(), id) {
            (Some("delegated"), Some(id)) => ThreadItem::Team { text: "Wisp asked".into(), agents: vec![id] },
            (Some("delegated"), None) => ThreadItem::Event { icon: "users", text: format!("Wisp asked **{name}**") },
            _ => {
                let summary = e["summary"].as_str().unwrap_or_default();
                let short: String = summary.chars().take(160).collect();
                ThreadItem::Event { icon: "check", text: if short.is_empty() { format!("**{name}** is done") } else { format!("**{name}**: {short}") } }
            }
        };
        match snap.threads.iter_mut().find(|(k, _)| *k == title) {
            Some((_, items)) => items.push(item),
            None => snap.threads.push((title, vec![item])),
        }
    }
}

pub struct LiveStore {
    conn: Conn,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
    waker: Option<rune::Waker>,
    sessions: Vec<Session>,
    /// The engine chats Wisp and the helpers talk in, by name.
    named: std::collections::HashMap<String, String>,
    /// The chat whose transcript is on screen, by its sidebar title.
    open: Option<String>,
    /// Chats whose reply is streaming in (DSH `text_delta`s), by engine id.
    streaming: std::collections::HashSet<String>,
    /// What the store talks to, for the status line ("Codeply engine (DSH)").
    label: String,
    /// Chats with a reply finished since you last looked, by engine id.
    unread: std::collections::HashSet<String>,
    /// Messages shown when sent to a busy chat, waiting their turn: their `run_started` mustn't
    /// show them twice. By engine id.
    queued: std::collections::HashMap<String, Vec<String>>,
    /// A new chat to open once the engine has titled it, and the title to open now.
    want_focus: Option<String>,
    focus: Option<String>,
    /// A page the engine asked to open (an app's sign-in).
    open_url: Option<String>,
    /// The team, as the engine is told about it: (id, name, role).
    team: Vec<(String, String, String)>,
}

impl LiveStore {
    pub fn new(url: &str, token: &str) -> LiveStore {
        let (tx, rx) = channel();
        LiveStore {
            conn: Conn { base: url.trim_end_matches('/').to_owned(), token: token.to_owned() },
            tx, rx, waker: None, sessions: Vec::new(), named: Default::default(), open: None, streaming: Default::default(),
            label: format!("codeply serve at {url}"), unread: Default::default(), queued: Default::default(), want_focus: None, focus: None,
            open_url: None, team: Vec::new(),
        }
    }

    /// Runs `work` on its own thread; its answer comes back through the channel.
    /// Names what this store talks to, for the status line.
    pub fn labelled(mut self, label: &str) -> LiveStore {
        self.label = label.to_owned();
        self
    }

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

    /// Folds one live event into what's on screen.
    fn fold(&mut self, e: &Value, snap: &mut Snapshot) {
        let id = e["sessionId"].as_str().unwrap_or_default().to_owned();
        let kind = e["type"].as_str().unwrap_or_default();
        if kind == "server_connected" {
            snap.extra.engine_ok = true;
            return;
        }
        if let Some(m) = e.get("session").filter(|m| m.is_object()) {
            let s = session_from(&id, m);
            match self.sessions.iter_mut().find(|x| x.id == id) {
                Some(x) => *x = s,
                None => self.sessions.insert(0, s),
            }
            if self.want_focus.as_deref() == Some(id.as_str()) {
                self.want_focus = None;
                self.focus = self.title_of(&id);
            }
        }
        match kind {
            "run_started" => self.set_running(&id, true),
            "run_finished" => {
                self.set_running(&id, false);
                self.streaming.remove(&id);
                if self.open.as_deref() != self.title_of(&id).as_deref() {
                    self.unread.insert(id.clone());
                }
            }
            _ => {}
        }
        if kind == "session_sync" {
            return;
        }
        let Some(title) = self.title_of(&id) else { return };
        let items = match snap.threads.iter().position(|(k, _)| *k == title) {
            Some(i) => &mut snap.threads[i].1,
            None => {
                snap.threads.push((title.clone(), Vec::new()));
                let last = snap.threads.len() - 1;
                &mut snap.threads[last].1
            }
        };
        match kind {
            // DSH streams its reply: grow the one it's writing.
            "text_delta" => {
                let piece = e["text"].as_str().unwrap_or_default();
                match (self.streaming.contains(&id), items.last_mut()) {
                    (true, Some(ThreadItem::Them(t))) => t.push_str(piece),
                    _ => items.push(ThreadItem::Them(piece.to_owned())),
                }
                self.streaming.insert(id.clone());
            }
            // Sent while a reply was running: show it now; it runs next.
            "queued" => {
                let text = e["text"].as_str().unwrap_or_default().to_owned();
                self.queued.entry(id.clone()).or_default().push(text.clone());
                items.push(ThreadItem::You(text));
                self.streaming.remove(&id);
            }
            "run_started" => {
                self.streaming.remove(&id);
                let text = e["message"]["text"].as_str().unwrap_or_default();
                let shown = match self.queued.get_mut(&id) {
                    Some(q) if q.first().map(String::as_str) == Some(text) => {
                        q.remove(0);
                        true
                    }
                    _ => false,
                };
                if !shown && let Some(item) = item_from_event(e) {
                    items.push(item);
                }
            }
            "approval_resolved" => {
                self.streaming.remove(&id);
                let rid = e["requestId"].as_str().unwrap_or_default();
                for it in items.iter_mut() {
                    if let ThreadItem::Approval { id: a, answer, .. } = it && a == rid {
                        *answer = Some(e["verdict"].as_str().unwrap_or("reject").to_owned());
                    }
                }
            }
            _ => {
                self.streaming.remove(&id);
                if let Some(item) = item_from_event(e) {
                    items.push(item);
                }
            }
        }
    }

    fn set_running(&mut self, id: &str, running: bool) {
        if let Some(s) = self.sessions.iter_mut().find(|s| s.id == id) {
            s.running = running;
            s.updated = now_ms();
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn ago(updated: u64) -> String {
    let mins = now_ms().saturating_sub(updated) / 60_000;
    match mins {
        0 => "now".to_owned(),
        1..=59 => format!("{mins} min"),
        60..=1439 => format!("{} h", mins / 60),
        _ => format!("{} d", mins / 1440),
    }
}

/// Every chat as the sidebars list it, newest first.
fn metas(sessions: &[Session], unread: &std::collections::HashSet<String>) -> Vec<ChatMeta> {
    let mut list: Vec<&Session> = sessions.iter().collect();
    list.sort_by_key(|s| std::cmp::Reverse(s.updated));
    list.into_iter().map(|s| ChatMeta {
        title: s.title.clone(),
        project: std::path::Path::new(&s.cwd).file_name().and_then(|n| n.to_str()).unwrap_or_default().to_owned(),
        ago: ago(s.updated),
        preview: s.preview.chars().take(120).collect(),
        running: s.running,
        unread: unread.contains(&s.id),
    }).collect()
}

/// The team's states and Mission control's lists, from the engine's chats: an agent works while
/// its chat runs, needs you while one of its approvals waits, and each chat that ran today is
/// done today.
fn derive(snap: &mut Snapshot, sessions: &[Session]) {
    let waiting = snap.waiting();
    let agent_for = |title: &str, team: &[crate::model::Agent]| team.iter().find(|a| a.name == title).map_or_else(|| "wisp".to_owned(), |a| a.id.clone());
    for a in &mut snap.team {
        if a.state == AgentState::Walking {
            continue;
        }
        let chat = sessions.iter().find(|s| s.title == a.name);
        let asks = waiting.iter().any(|(c, _, _)| *c == a.name);
        a.state = if asks {
            AgentState::Waiting
        } else if chat.is_some_and(|c| c.running) {
            AgentState::Working
        } else if chat.is_some() {
            AgentState::Idle
        } else {
            AgentState::Sleeping
        };
        if let Some(c) = chat && !c.preview.is_empty() {
            a.status = c.preview.chars().take(80).collect();
        }
    }
    let mut tasks = Vec::new();
    for (chat, request, title) in &waiting {
        tasks.push((Column::NeedsYou, Task {
            request: Some((chat.clone(), request.clone())),
            agent: agent_for(chat, &snap.team),
            title: title.clone(),
            sub: format!("{chat} · waiting for your OK"),
            pill: Some(("Approve".into(), Pill::Warn)),
            body: TaskBody::Ask { text: String::new(), buttons: vec![("Allow once".into(), ButtonKind::Blue), ("Don't allow".into(), ButtonKind::Plain)] },
        }));
    }
    let today = now_ms() - now_ms() % 86_400_000;
    let mut list: Vec<&Session> = sessions.iter().collect();
    list.sort_by_key(|s| std::cmp::Reverse(s.updated));
    for s in list.iter().filter(|s| s.running) {
        tasks.push((Column::Working, Task {
            request: None,
            agent: agent_for(&s.title, &snap.team),
            title: s.title.clone(),
            sub: format!("{} · {}", ago(s.updated), if s.preview.is_empty() { "working" } else { s.preview.as_str() }),
            pill: Some(("Running".into(), Pill::Blue)),
            body: TaskBody::Working { icon: "terminal", now: s.preview.chars().take(80).collect(), progress: 0.5, screen: false },
        }));
    }
    for s in list.iter().filter(|s| !s.running && s.updated >= today).take(6) {
        tasks.push((Column::Done, Task {
            request: None,
            agent: agent_for(&s.title, &snap.team),
            title: s.title.clone(),
            sub: String::new(),
            pill: None,
            body: TaskBody::Done { proof: s.preview.chars().take(80).collect(), checked: true },
        }));
    }
    snap.tasks = tasks;
}

fn sessions_from(v: &Value) -> Vec<Session> {
    v["sessions"].as_array().map_or_else(Vec::new, |list| {
        list.iter().map(|s| Session {
            id: s["id"].as_str().unwrap_or_default().to_owned(),
            title: s["title"].as_str().unwrap_or("New chat").to_owned(),
            cwd: s["cwd"].as_str().unwrap_or_default().to_owned(),
            updated: s["updatedAt"].as_u64().unwrap_or(0),
            preview: s["preview"].as_str().unwrap_or_default().to_owned(),
            running: s["running"].as_bool().unwrap_or(false),
        }).collect()
    })
}

fn session_from(id: &str, meta: &Value) -> Session {
    Session {
        id: id.to_owned(),
        title: meta["title"].as_str().unwrap_or("New chat").to_owned(),
        cwd: meta["cwd"].as_str().unwrap_or_default().to_owned(),
        updated: meta["updatedAt"].as_u64().unwrap_or(0),
        preview: meta["preview"].as_str().unwrap_or_default().to_owned(),
        running: meta["running"].as_bool().unwrap_or(false),
    }
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
        "approval_request" => Some(ThreadItem::Approval {
            id: e["requestId"].as_str()?.to_owned(),
            title: e["title"].as_str().unwrap_or("Run a tool").to_owned(),
            detail: e["detail"].as_str().unwrap_or_default().to_owned(),
            answer: None,
        }),
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
        snap.recent.clear();
        snap.tasks.clear();
        snap.extra.chats.clear();
        snap.extra.projects.clear();
        snap.extra.engine = "Starting".into();
        snap.extra.terminal.clear();
        snap.extra.bg_tasks.clear();
        snap.extra.memories.clear();
        snap.extra.code = Default::default();
        snap.extra.code.wisp = "idle".into();
        self.team = snap.team.iter().filter(|a| a.id != "wisp").map(|a| (a.id.clone(), a.name.clone(), a.role.clone())).collect();
        snap.extra.engine_ok = false;
        snap.source = format!("{} (connecting)", self.label);
        derive(&mut snap, &[]);
        snap
    }

    fn set_waker(&mut self, waker: rune::Waker) {
        self.waker = Some(waker.clone());
        // The chat list, once.
        // The project folder the engine works in, for "What should we build in ...?".
        self.spawn(|c| {
            for _ in 0..120 {
                if let Ok(cfg) = c.get("/config") {
                    let name = cfg["cwd"].as_str().and_then(|p| std::path::Path::new(p).file_name()).and_then(|n| n.to_str())?;
                    let version = cfg["version"].as_str().unwrap_or_default().to_owned();
                    let engine = if cfg["dsh"].as_str().is_some_and(|d| d.starts_with("unavailable")) { "classic" } else { cfg["engine"].as_str().unwrap_or("dsh") };
                    return Some(Msg::Project(name.to_owned(), version, engine.to_owned()));
                }
                thread::sleep(Duration::from_millis(250));
            }
            None
        });
        // The chat list, once the engine answers (a sidecar the app just started takes a moment).
        self.spawn(|c| {
            let mut last = String::new();
            for _ in 0..120 {
                match c.get("/session") {
                    Ok(v) => return Some(Msg::Sessions(sessions_from(&v))),
                    Err(e) => last = e,
                }
                thread::sleep(Duration::from_millis(250));
            }
            Some(Msg::Status(format!("can't reach the engine: {last}")))
        });
        for what in ["account", "apps", "memory", "files", "jobs"] {
            self.refresh(what);
        }
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
                    snap.source = self.label.clone();
                    snap.extra.engine_ok = true;
                    if snap.extra.engine == "Starting" {
                        snap.extra.engine = "DSH".into();
                    }
                }
                Msg::Project(name, version, engine) => {
                    snap.project = name;
                    if !version.is_empty() {
                        snap.extra.version = format!("4.0.0-beta.1 · engine {version}");
                    }
                    snap.extra.engine = if engine == "classic" { "Classic".into() } else { "DSH".into() };
                    snap.extra.engine_ok = true;
                }
                Msg::Created(id) => match self.title_of(&id) {
                    Some(title) => self.focus = Some(title),
                    None => self.want_focus = Some(id),
                },
                Msg::Transcript { id, items } => {
                    if let Some(title) = self.title_of(&id) {
                        snap.threads.retain(|(k, _)| *k != title);
                        snap.threads.push((title, items));
                    }
                }
                Msg::Event(e) => {
                    if matches!(e["type"].as_str(), Some("delegated" | "delegate_done")) {
                        self.fold_delegation(&e, snap);
                    } else if !self.fold_extra(&e, snap) {
                        self.fold(&e, snap);
                    }
                }
                Msg::Account(v) => {
                    snap.extra.signed_in = v["signedIn"].as_bool().unwrap_or(false);
                    snap.extra.email = v["email"].as_str().unwrap_or_default().to_owned();
                    if let Some(name) = v["name"].as_str().filter(|n| !n.is_empty()) {
                        snap.user = name.split_whitespace().next().unwrap_or(name).to_owned();
                    }
                    snap.plan = if snap.extra.signed_in { "Signed in".into() } else { "Not signed in".into() };
                }
                Msg::Apps(list) => {
                    snap.connected.retain(|_| false);
                    snap.extra.catalog = list;
                }
                Msg::Memories(list) => snap.extra.memories = list,
                Msg::Files(list) => snap.extra.code.files = list,
                Msg::Tasks(list) => snap.extra.bg_tasks = list,
                Msg::File(path, text) => {
                    snap.extra.code.open = Some(path);
                    snap.extra.code.saved = text;
                    snap.extra.code.review.clear();
                    snap.extra.code.suggestion = None;
                }
                Msg::Suggestion(file, at, text) => {
                    snap.extra.code.wisp = "idle".into();
                    snap.extra.code.suggestion = (!text.is_empty()).then_some((file, at, text));
                }
                Msg::Review(notes) => {
                    snap.extra.code.reviewing = false;
                    snap.extra.code.wisp = if notes.iter().any(|n| n.fix.is_some()) { "fixing".into() } else { "idle".into() };
                    snap.extra.code.review = notes;
                }
                Msg::SignIn(state) => {
                    let done = state.is_none();
                    snap.extra.sign_in = state;
                    if done {
                        self.refresh("account");
                    }
                }
                Msg::Named(name, id) => {
                    self.named.insert(name, id);
                }
                Msg::Status(s) => {
                    if s.starts_with("can't reach") || s.starts_with("event stream") {
                        snap.extra.engine_ok = false;
                    }
                    snap.source = s;
                }
            }
        }
        if changed {
            snap.chat_groups = group(&self.sessions);
            snap.recent = recent(&self.sessions);
            snap.extra.chats = metas(&self.sessions, &self.unread);
            let mut projects: Vec<String> = Vec::new();
            for c in &snap.extra.chats {
                if !c.project.is_empty() && !projects.contains(&c.project) {
                    projects.push(c.project.clone());
                }
            }
            snap.extra.projects = projects;
            derive(snap, &self.sessions);
        }
        changed
    }

    fn take_focus(&mut self) -> Option<String> {
        self.focus.take()
    }

    fn take_open_url(&mut self) -> Option<String> {
        self.open_url.take()
    }

    fn run_command(&mut self, cmd: &str, snap: &mut Snapshot) {
        snap.extra.terminal.push(TermLine { kind: TermKind::Input, text: cmd.to_owned() });
        let cmd = cmd.to_owned();
        self.spawn(move |c| c.post("/exec", json!({ "cmd": cmd })).err().map(|e| Msg::Event(json!({ "type": "term_output", "stream": "err", "text": format!("couldn't run it: {e}") }))));
    }

    fn kill(&mut self, id: &str, snap: &mut Snapshot) {
        if let Some(t) = snap.extra.bg_tasks.iter_mut().find(|t| t.id == id) {
            t.running = false;
        }
        let id = encode(id);
        self.spawn(move |c| c.delete(&format!("/jobs/{id}")).err().map(|e| Msg::Status(format!("stop failed: {e}"))));
    }

    fn publish(&mut self, chat: Option<&str>, snap: &mut Snapshot) {
        let session = chat.and_then(|c| self.id_of(c));
        snap.extra.publish = Some(Publish { running: true, url: None, message: "Publishing".into() });
        self.spawn(move |c| c.post("/publish", json!({ "sessionId": session })).err().map(|e| Msg::Event(json!({ "type": "publish", "running": false, "message": format!("Publish failed: {e}") }))));
    }

    fn send_code(&mut self, email: &str, snap: &mut Snapshot) {
        snap.extra.sign_in = Some("sending".into());
        let email = email.to_owned();
        self.spawn(move |c| Some(Msg::SignIn(Some(match c.post("/account/otp/send", json!({ "email": email })) {
            Ok(v) if v["error"].is_string() => format!("error: {}", v["error"].as_str().unwrap_or_default()),
            Ok(_) => "sent".to_owned(),
            Err(e) => format!("error: {e}"),
        }))));
    }

    fn verify_code(&mut self, email: &str, code: &str, snap: &mut Snapshot) {
        snap.extra.sign_in = Some("verifying".into());
        let (email, code) = (email.to_owned(), code.to_owned());
        self.spawn(move |c| Some(Msg::SignIn(match c.post("/account/otp/verify", json!({ "email": email, "code": code })) {
            Ok(v) if v["error"].is_string() => Some(format!("error: {}", v["error"].as_str().unwrap_or_default())),
            Ok(_) => None,
            Err(e) => Some(format!("error: {e}")),
        })));
    }

    fn sign_out(&mut self, snap: &mut Snapshot) {
        snap.extra.signed_in = false;
        self.spawn(|c| {
            let _ = c.post("/account/signout", json!({}));
            c.get("/account").ok().map(Msg::Account)
        });
    }

    fn search_apps(&mut self, query: &str, _snap: &mut Snapshot) {
        let q = encode(query);
        self.spawn(move |c| c.get(&format!("/apps?q={q}")).ok().map(|v| Msg::Apps(apps_from(&v))));
    }

    fn connect_app(&mut self, slug: &str, _snap: &mut Snapshot) {
        let id = slug.to_owned();
        self.spawn(move |c| c.post("/apps/connect", json!({ "id": id })).err().map(|e| Msg::Status(format!("connect failed: {e}"))));
    }

    fn disconnect_app(&mut self, slug: &str, snap: &mut Snapshot) {
        if let Some(a) = snap.extra.catalog.iter_mut().find(|a| a.slug == slug) {
            a.connected = false;
        }
        let id = encode(slug);
        self.spawn(move |c| {
            let _ = c.delete(&format!("/apps/{id}"));
            c.get("/apps").ok().map(|v| Msg::Apps(apps_from(&v)))
        });
    }

    fn remember(&mut self, text: &str, snap: &mut Snapshot) {
        snap.extra.memories.insert(0, Memory { id: String::new(), kind: "note".into(), text: text.to_owned(), scope: "me".into() });
        let text = text.to_owned();
        self.spawn(move |c| {
            let _ = c.post("/memory", json!({ "text": text }));
            c.get("/memory").ok().map(|v| Msg::Memories(memories_from(&v)))
        });
    }

    fn forget(&mut self, id: &str, snap: &mut Snapshot) {
        snap.extra.memories.retain(|m| m.id != id);
        let id = encode(id);
        self.spawn(move |c| c.delete(&format!("/memory/{id}")).err().map(|e| Msg::Status(format!("forget failed: {e}"))));
    }

    fn open_file(&mut self, path: &str, _snap: &mut Snapshot) {
        let path = path.to_owned();
        self.spawn(move |c| match c.get(&format!("/file?path={}", encode(&path))) {
            Ok(v) => Some(Msg::File(path, v["text"].as_str().unwrap_or_default().to_owned())),
            Err(e) => Some(Msg::Status(format!("can't open {path}: {e}"))),
        });
    }

    fn save_file(&mut self, path: &str, text: &str, _snap: &mut Snapshot) {
        let (path, text) = (path.to_owned(), text.to_owned());
        self.spawn(move |c| c.put("/file", json!({ "path": path, "text": text })).err().map(|e| Msg::Status(format!("save failed: {e}"))));
    }

    fn complete(&mut self, file: &str, prefix: &str, suffix: &str, _snap: &mut Snapshot) {
        let (file, at) = (file.to_owned(), prefix.len());
        // Enough context for the model, not the whole file.
        let head: String = { let n = prefix.chars().count(); prefix.chars().skip(n.saturating_sub(3000)).collect() };
        let tail: String = suffix.chars().take(1000).collect();
        self.spawn(move |c| {
            let v = c.post("/complete", json!({ "path": file, "prefix": head, "suffix": tail })).ok()?;
            Some(Msg::Suggestion(file, at, v["text"].as_str().unwrap_or_default().to_owned()))
        });
    }

    fn review(&mut self, file: &str, text: &str, _snap: &mut Snapshot) {
        let (file, text) = (file.to_owned(), text.to_owned());
        self.spawn(move |c| {
            let notes = c.post("/review", json!({ "path": file, "text": text })).ok().and_then(|v| v["notes"].as_array().cloned()).unwrap_or_default();
            Some(Msg::Review(notes.iter().filter_map(|n| Some(ReviewNote {
                line: n["line"].as_u64()? as u32,
                severity: n["severity"].as_str().unwrap_or("info").to_owned(),
                message: n["message"].as_str().unwrap_or_default().to_owned(),
                fix: n["fix"].as_str().map(str::to_owned),
            })).collect()))
        });
    }

    fn abort(&mut self, chat: &str) {
        let Some(id) = self.id_of(chat).or_else(|| self.named.get(chat).cloned()) else { return };
        self.queued.remove(&id);
        self.spawn(move |c| c.post(&format!("/session/{id}/abort"), json!({})).err().map(|e| Msg::Status(format!("stop failed: {e}"))));
    }

    fn configure(&mut self, prefs: &crate::prefs::Prefs) {
        let team: Vec<Value> = self.team.iter().map(|(id, name, role)| json!({ "id": id, "name": name, "role": role })).collect();
        let body = json!({ "approval": prefs.approval.name(), "effort": prefs.effort, "team": team });
        // The engine may still be starting: keep trying for half a minute.
        self.spawn(move |c| {
            for _ in 0..120 {
                if c.post("/config", body.clone()).is_ok() {
                    return None;
                }
                thread::sleep(Duration::from_millis(250));
            }
            None
        });
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

    fn is_live(&self) -> bool {
        true
    }

    fn answer(&mut self, request: &str, verdict: &str, snap: &mut Snapshot) {
        for (_, items) in &mut snap.threads {
            for it in items.iter_mut() {
                if let ThreadItem::Approval { id, answer, .. } = it && id == request {
                    *answer = Some(verdict.to_owned());
                }
            }
        }
        let (request, verdict) = (request.to_owned(), verdict.to_owned());
        self.spawn(move |c| c.post(&format!("/permission/{request}"), json!({ "verdict": verdict })).err().map(|e| Msg::Status(format!("answer failed: {e}"))));
    }

    fn send(&mut self, to: &Target, text: &str, snap: &mut Snapshot) -> Result<(), String> {
        let text = text.to_owned();
        match to {
            Target::Chat(title) => {
                let id = self.id_of(title).ok_or("That chat isn't on the engine yet.")?;
                self.spawn(move |c| c.post(&format!("/session/{id}/message"), json!({ "text": text })).err().map(|e| Msg::Status(format!("send failed: {e}"))));
                Ok(())
            }
            // A new chat from "What should we build?": the engine titles it from the message,
            // and it opens once it has its title.
            Target::New => {
                self.spawn(move |c| {
                    let made = match c.post("/session", json!({ "title": "New chat" })) {
                        Ok(v) => v,
                        Err(e) => return Some(Msg::Status(format!("can't start a chat: {e}"))),
                    };
                    let id = made["session"]["id"].as_str()?.to_owned();
                    match c.post(&format!("/session/{id}/message"), json!({ "text": text })) {
                        Ok(_) => Some(Msg::Created(id)),
                        Err(e) => Some(Msg::Status(format!("send failed: {e}"))),
                    }
                });
                Ok(())
            }
            // Wisp and each helper talk in a chat of their own, named after them, made on first use.
            Target::Wisp | Target::Agent(_) => {
                let name = match to {
                    Target::Agent(id) => snap.agent(id).map_or_else(|| id.clone(), |a| a.name.clone()),
                    _ => "Wisp".to_owned(),
                };
                let known = self.named.get(&name).cloned().or_else(|| self.id_of(&name));
                let title = name.clone();
                self.spawn(move |c| {
                    let id = match known {
                        Some(id) => id,
                        None => c.post("/session", json!({ "title": title })).ok()?["session"]["id"].as_str()?.to_owned(),
                    };
                    match c.post(&format!("/session/{id}/message"), json!({ "text": text })) {
                        Ok(_) => Some(Msg::Named(title, id)),
                        Err(e) => Some(Msg::Status(format!("send failed: {e}"))),
                    }
                });
                // The reply streams into the agent's own page (its chat), so nothing to fake here.
                Ok(())
            }
        }
    }
}

/// The three latest chats for the home screen, with how long ago each was active.
fn recent(sessions: &[Session]) -> Vec<(String, String)> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let mut list: Vec<&Session> = sessions.iter().collect();
    list.sort_by_key(|s| std::cmp::Reverse(s.updated));
    list.into_iter().take(3).map(|s| {
        let mins = now.saturating_sub(s.updated) / 60_000;
        let ago = match mins {
            0 => "just now".to_owned(),
            1..=59 => format!("{mins} min ago"),
            60..=1439 => format!("{} h ago", mins / 60),
            _ => format!("{} days ago", mins / 1440),
        };
        (s.title.clone(), ago)
    }).collect()
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
        let e = json!({ "type": "approval_request", "requestId": "p_1", "title": "Run npm install", "detail": "npm install" });
        assert!(matches!(item_from_event(&e), Some(ThreadItem::Approval { id, title, answer: None, .. }) if id == "p_1" && title == "Run npm install"));
        assert_eq!(item_from_event(&json!({ "type": "run_finished" })), None);
    }

    #[test]
    fn chats_group_by_folder() {
        let s = |id: &str, title: &str, cwd: &str| Session { id: id.into(), title: title.into(), cwd: cwd.into(), updated: 0, preview: String::new(), running: false };
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

