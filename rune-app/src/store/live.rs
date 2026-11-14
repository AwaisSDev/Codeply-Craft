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

use super::{APPS_PAGE, AppsQuery, Store, Target, mock};
use crate::model::{AgentState, AppProgress, BgTask, ButtonKind, CatalogApp, ChatGroup, ChatMeta, Column, Memory, Pill, Publish, ReviewNote, Snapshot, Task, TaskBody, TermKind, TermLine, ThreadItem};

/// What the worker threads send back to the UI thread.
enum Msg {
    Sessions(Vec<Session>),
    /// The engine's project folder's name, its version, and which engine replies ("dsh").
    Project(String, String, String),
    /// A chat `send` made for a new conversation, by engine id: open it once it has a title.
    Created(String),
    Account(Value),
    Usage(Value),
    /// The team and its loops (`/ext/team`).
    Team(Value),
    /// A page of the catalogue: (request number, offset it starts at, the page). Only the newest request counts.
    Apps(u64, usize, Box<AppsPage>),
    /// A connected app's tools (app id, tools or why not).
    AppTools(String, Result<Vec<(String, String, bool)>, String>),
    Memories(Vec<Memory>),
    /// The model list, or the answer to a change (`models::Models::apply`).
    Models(Value),
    /// What the Ollama scan found.
    Ollama(Value),
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
    /// A POST that may take a while: adding a model tests it with a real request first.
    fn post_slow(&self, path: &str, body: Value) -> Result<Value, String> {
        ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(2)).timeout_read(Duration::from_secs(150)).build()
            .post(&format!("{}{path}", self.base)).set("Authorization", &format!("Bearer {}", self.token))
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

fn app_from(a: &Value) -> Option<CatalogApp> {
    let id = a["id"].as_str()?;
    Some(CatalogApp {
        slug: intern(id),
        name: a["name"].as_str().unwrap_or(id).to_owned(),
        note: a["note"].as_str().or(a["description"].as_str()).unwrap_or_default().chars().take(140).collect(),
        category: intern(a["category"].as_str().filter(|c| !c.is_empty()).unwrap_or("Apps")),
        connected: a["connected"].as_bool().unwrap_or(false),
        domain: a["domain"].as_str().unwrap_or_default().to_owned(),
        icon: a["icon"].as_str().unwrap_or_default().to_owned(),
        verified: a["verified"].as_bool().unwrap_or(false),
        key_header: a["keyHeader"].as_str().unwrap_or_default().to_owned(),
        needs_reconnect: a["needsReconnect"].as_bool().unwrap_or(false),
        tools: a["tools"].as_u64().unwrap_or(0) as u32,
        account: a["account"].as_str().unwrap_or_default().to_owned(),
    })
}

fn apps_from(v: &Value) -> Vec<CatalogApp> {
    v["apps"].as_array().map_or_else(Vec::new, |list| list.iter().filter_map(app_from).collect())
}

/// One answer from the engine's catalogue (`GET /ext/apps`).
struct AppsPage {
    apps: Vec<CatalogApp>,
    matched: usize,
    total: usize,
    categories: Vec<(String, usize)>,
    connected: Vec<CatalogApp>,
    indexing: Option<usize>,
    error: String,
}

fn apps_page(v: &Value) -> AppsPage {
    AppsPage {
        apps: apps_from(v),
        matched: v["total"].as_u64().unwrap_or(0) as usize,
        total: v["catalog"].as_u64().unwrap_or(0) as usize,
        categories: v["categories"].as_array().map_or_else(Vec::new, |l| l.iter().filter_map(|c| Some((c["name"].as_str()?.to_owned(), c["count"].as_u64()? as usize))).collect()),
        connected: v["connected"].as_array().map_or_else(Vec::new, |l| l.iter().filter_map(app_from).collect()),
        indexing: (v["indexing"]["phase"] == "crawling").then(|| v["indexing"]["loaded"].as_u64().unwrap_or(0) as usize),
        error: v["error"].as_str().unwrap_or_default().to_owned(),
    }
}

/// The list of tools from `GET /ext/apps/tools`.
fn tools_from(v: &Value) -> Result<Vec<(String, String, bool)>, String> {
    if let Some(e) = v["error"].as_str().filter(|e| !e.is_empty()) {
        return Err(e.to_owned());
    }
    Ok(v["tools"].as_array().map_or_else(Vec::new, |l| l.iter().map(|t| {
        let name = t["name"].as_str().unwrap_or_default();
        let title = t["title"].as_str().filter(|x| !x.is_empty()).unwrap_or(name);
        (title.to_owned(), t["description"].as_str().unwrap_or_default().to_owned(), t["readOnly"].as_bool().unwrap_or(false))
    }).collect()))
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

/// my_usage() as the engine passes it on: totals, and per day `{d, t, n, m: {model: [t, n]}}`.
fn usage_from(v: &Value) -> crate::model::Usage {
    let num = |x: &Value| x.as_u64().or_else(|| x.as_f64().map(|f| f.max(0.0) as u64)).or_else(|| x.as_str().and_then(|s| s.parse().ok())).unwrap_or(0);
    let days = v["days"].as_array().map_or_else(Vec::new, |a| a.iter().filter_map(|d| {
        let date = d["d"].as_str()?.to_owned();
        let models = d["m"].as_object().map_or_else(Vec::new, |m| m.iter().map(|(k, tn)| (k.clone(), num(&tn[0]), num(&tn[1]))).collect());
        Some(crate::model::UsageDay { date, tokens: num(&d["t"]), calls: num(&d["n"]), models })
    }).collect());
    crate::model::Usage {
        error: v["error"].as_str().unwrap_or_default().to_owned(),
        tokens: num(&v["tokens"]),
        calls: num(&v["calls"]),
        favorite: v["favorite"].as_str().unwrap_or_default().to_owned(),
        today: v["today"].as_str().unwrap_or_default().to_owned(),
        days,
    }
}

impl LiveStore {
    /// Fetches the account, apps, memories and files (at launch, and after they change).
    fn refresh(&self, what: &'static str) {
        self.spawn(move |c| {
            for _ in 0..120 {
                let got = match what {
                    "account" => c.get("/account").map(Msg::Account),
                    "apps" => c.get("/ext/apps?limit=60").map(|v| Msg::Apps(0, 0, Box::new(apps_page(&v)))),
                    "memory" => c.get("/memory").map(|v| Msg::Memories(memories_from(&v))),
                    "models" => c.get("/ext/models").map(Msg::Models),
                    "team" => c.get("/ext/team").map(Msg::Team),
                    // At launch and after a sign-in: also catches the phone up with the account.
                    "models-sync" => c.get("/ext/models?sync=1").map(Msg::Models),
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

    /// One page of the catalogue for `q`, `limit` apps from its offset. Answers carry the request's
    /// number, and only the newest one is used, so typing fast never shows an old search.
    fn fetch_apps(&self, q: AppsQuery, limit: usize) {
        let seq = self.apps_seq.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;
        self.spawn(move |c| {
            let cat = q.category.as_deref().map(encode).unwrap_or_default();
            let path = format!("/ext/apps?q={}&cat={cat}&offset={}&limit={limit}", encode(&q.text), q.offset);
            for _ in 0..120 {
                match c.get(&path) {
                    Ok(v) => return Some(Msg::Apps(seq, q.offset, Box::new(apps_page(&v)))),
                    Err(_) => thread::sleep(Duration::from_millis(250)),
                }
            }
            None
        });
    }

    /// Something changed (an app connected, the catalogue grew): read what's on screen again.
    fn reload_apps(&mut self) {
        let q = AppsQuery { offset: 0, ..self.apps_q.clone() };
        self.fetch_apps(q, self.apps_shown.clamp(APPS_PAGE, 600));
    }

    fn connect(&mut self, slug: &str, key: &str, snap: &mut Snapshot) {
        let id = slug.to_owned();
        let name = snap.extra.catalog.iter().chain(&snap.extra.apps.connected).find(|a| a.slug == slug).map(|a| a.name.clone()).unwrap_or_else(|| id.clone());
        snap.extra.apps.progress = Some(AppProgress { id: id.clone(), name: name.clone(), state: "start".into(), message: format!("Connecting {name}...") });
        let key = key.to_owned();
        self.spawn(move |c| c.post("/ext/apps/connect", json!({ "id": id, "apiKey": key })).err()
            .map(|e| Msg::Event(json!({ "type": "apps_progress", "id": id, "name": name, "state": "error", "message": e }))));
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
            "apps_changed" | "apps_catalog" => self.reload_apps(),
            "apps_progress" => {
                let g = |k: &str| e[k].as_str().unwrap_or_default().to_owned();
                x.apps.progress = Some(AppProgress { id: g("id"), name: g("name"), state: g("state"), message: g("message") });
            }
            "memory_changed" => self.refresh("memory"),
            "account_changed" => self.refresh("account"),
            "models_changed" => self.refresh("models"),
            "team_changed" | "wisp_team" => self.refresh("team"),
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
    /// Chats renamed since the app last asked: (old title, new title).
    renames: Vec<(String, String)>,
    /// The Apps page's last query, how many apps it shows, and the number of the newest request.
    apps_q: AppsQuery,
    apps_shown: usize,
    apps_seq: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl LiveStore {
    pub fn new(url: &str, token: &str) -> LiveStore {
        let (tx, rx) = channel();
        LiveStore {
            conn: Conn { base: url.trim_end_matches('/').to_owned(), token: token.to_owned() },
            tx, rx, waker: None, sessions: Vec::new(), named: Default::default(), open: None, streaming: Default::default(),
            label: format!("codeply serve at {url}"), unread: Default::default(), queued: Default::default(), want_focus: None, focus: None,
            open_url: None, team: Vec::new(), renames: Vec::new(),
            apps_q: AppsQuery::default(), apps_shown: 0, apps_seq: Default::default(),
        }
    }

    /// Notes a chat's new title: the app follows it, and so do the title-keyed bits here.
    fn renamed(&mut self, old: &str, new: &str) {
        if old == new {
            return;
        }
        for t in [&mut self.focus, &mut self.open] {
            if t.as_deref() == Some(old) {
                *t = Some(new.to_owned());
            }
        }
        self.renames.push((old.to_owned(), new.to_owned()));
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
            let new_title = s.title.clone();
            match self.sessions.iter_mut().find(|x| x.id == id) {
                Some(x) => {
                    let old = std::mem::replace(x, s).title;
                    self.renamed(&old, &new_title);
                }
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
        for what in ["account", "apps", "memory", "files", "jobs", "models-sync", "team"] {
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
                    let moved: Vec<(String, String)> = list.iter()
                        .filter_map(|n| self.sessions.iter().find(|o| o.id == n.id && o.title != n.title).map(|o| (o.title.clone(), n.title.clone())))
                        .collect();
                    self.sessions = list;
                    for (old, new) in moved {
                        self.renamed(&old, &new);
                    }
                    // A new chat that showed up in the list rather than through an event.
                    if let Some(id) = self.want_focus.clone()
                        && let Some(title) = self.title_of(&id)
                    {
                        self.want_focus = None;
                        self.focus = Some(title);
                    }
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
                Msg::Usage(v) => snap.extra.usage = Some(usage_from(&v)),
                Msg::Team(v) => {
                    self.team = crate::team::apply(snap, &v);
                    derive(snap, &self.sessions);
                }
                Msg::Account(v) => {
                    snap.extra.signed_in = v["signedIn"].as_bool().unwrap_or(false);
                    snap.extra.email = v["email"].as_str().unwrap_or_default().to_owned();
                    if let Some(name) = v["name"].as_str().filter(|n| !n.is_empty()) {
                        snap.user = name.split_whitespace().next().unwrap_or(name).to_owned();
                    }
                    snap.plan = if snap.extra.signed_in { "Signed in".into() } else { "Not signed in".into() };
                }
                Msg::Apps(seq, offset, page) => {
                    if seq != 0 && seq != self.apps_seq.load(std::sync::atomic::Ordering::Acquire) {
                        continue; // an older request, answered after a newer one went out
                    }
                    snap.connected.retain(|_| false);
                    let a = &mut snap.extra.apps;
                    a.loading = false;
                    a.matched = page.matched;
                    a.total = page.total;
                    a.categories = page.categories;
                    a.connected = page.connected;
                    a.indexing = page.indexing;
                    a.error = page.error;
                    if offset == 0 {
                        snap.extra.catalog = page.apps;
                    } else {
                        for app in page.apps {
                            if !snap.extra.catalog.iter().any(|k| k.slug == app.slug) {
                                snap.extra.catalog.push(app);
                            }
                        }
                    }
                    self.apps_shown = snap.extra.catalog.len();
                }
                Msg::AppTools(id, tools) => snap.extra.apps.tools = Some((id, tools)),
                Msg::Memories(list) => snap.extra.memories = list,
                Msg::Models(v) => snap.extra.models.apply(&v),
                Msg::Ollama(v) => snap.extra.models.apply_scan(&v),
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
                        self.refresh("models-sync");
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

    fn team_op(&mut self, op: crate::team::TeamOp, _snap: &mut Snapshot) {
        use crate::team::TeamOp;
        let (path, body) = match op {
            TeamOp::Create { name, focus } => ("/ext/team/create", json!({ "name": name, "focus": focus })),
            TeamOp::Remove(id) => ("/ext/team/remove", json!({ "id": id })),
            TeamOp::AddJob { agent, task, when } => ("/ext/team/jobs", json!({ "specialist": agent, "task": task, "when": when })),
            TeamOp::ToggleJob(id, on) => ("/ext/team/jobs/toggle", json!({ "id": id, "enabled": on })),
            TeamOp::CancelJob(id) => ("/ext/team/jobs/cancel", json!({ "id": id })),
        };
        self.spawn(move |c| Some(match c.post(path, body) {
            Ok(mut v) => {
                // What the engine said no to comes back as a notice; the lists come back either way.
                if v["ok"].as_bool() == Some(false) {
                    let why = v["error"].as_str().unwrap_or("That didn't work.").to_owned();
                    v["error"] = json!(why);
                } else {
                    v["error"] = json!("");
                }
                Msg::Team(v)
            }
            Err(e) => Msg::Team(json!({ "error": format!("The engine didn't answer: {e}") })),
        }));
    }

    fn load_usage(&mut self, snap: &mut Snapshot) {
        snap.extra.usage = None;
        self.spawn(|c| Some(match c.get("/usage") {
            Ok(v) => Msg::Usage(v),
            Err(e) => Msg::Usage(json!({ "error": format!("Couldn't load your usage: {e}") })),
        }));
    }

    fn take_renames(&mut self) -> Vec<(String, String)> {
        std::mem::take(&mut self.renames)
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

    fn search_apps(&mut self, query: &str, snap: &mut Snapshot) {
        self.browse_apps(&AppsQuery { text: query.to_owned(), ..Default::default() }, snap);
    }

    fn browse_apps(&mut self, q: &AppsQuery, snap: &mut Snapshot) {
        self.apps_q = q.clone();
        snap.extra.apps.loading = true;
        self.fetch_apps(q.clone(), APPS_PAGE);
    }

    fn connect_app(&mut self, slug: &str, snap: &mut Snapshot) {
        self.connect(slug, "", snap);
    }

    fn connect_app_key(&mut self, slug: &str, key: &str, snap: &mut Snapshot) {
        self.connect(slug, key, snap);
    }

    fn add_app(&mut self, url: &str, title: &str, header: &str, key: &str, snap: &mut Snapshot) {
        let (url, title, header, key) = (url.to_owned(), title.to_owned(), header.to_owned(), key.to_owned());
        snap.extra.apps.progress = Some(AppProgress { id: url.clone(), name: title.clone(), state: "start".into(), message: "Connecting...".into() });
        self.spawn(move |c| c.post("/ext/apps/add", json!({ "url": url, "title": title, "headerName": header, "apiKey": key })).err()
            .map(|e| Msg::Event(json!({ "type": "apps_progress", "id": url, "name": title, "state": "error", "message": e }))));
    }

    fn cancel_app(&mut self, _snap: &mut Snapshot) {
        self.spawn(|c| c.post("/ext/apps/cancel", json!({})).err().map(|e| Msg::Status(format!("cancel failed: {e}"))));
    }

    fn app_tools(&mut self, slug: &str, snap: &mut Snapshot) {
        snap.extra.apps.tools = None;
        let id = slug.to_owned();
        self.spawn(move |c| Some(Msg::AppTools(id.clone(), c.get(&format!("/ext/apps/tools?id={}", encode(&id))).map_err(|e| e.to_string()).and_then(|v| tools_from(&v)))));
    }

    fn disconnect_app(&mut self, slug: &str, snap: &mut Snapshot) {
        for list in [&mut snap.extra.catalog, &mut snap.extra.apps.connected] {
            if let Some(a) = list.iter_mut().find(|a| a.slug == slug) {
                a.connected = false;
            }
        }
        snap.extra.apps.connected.retain(|a| a.slug != slug);
        snap.extra.apps.progress = None;
        let id = slug.to_owned();
        self.spawn(move |c| c.post("/ext/apps/disconnect", json!({ "id": id })).err().map(|e| Msg::Status(format!("disconnect failed: {e}"))));
    }

    fn models(&mut self, op: crate::models::ModelOp, snap: &mut Snapshot) {
        use crate::models::ModelOp;
        let m = &mut snap.extra.models;
        // An answer: the engine's, or why it couldn't be had.
        let answer = |r: Result<Value, String>| Msg::Models(r.unwrap_or_else(|e| json!({ "ok": false, "error": e })));
        match op {
            ModelOp::Select(id) => {
                if id == crate::models::AUTO || m.list.iter().any(|x| x.id == id) {
                    m.selected = id.clone();
                }
                self.spawn(move |c| Some(answer(c.post("/ext/models/select", json!({ "id": id })))));
            }
            ModelOp::Save(d) => {
                m.busy = true;
                m.error = None;
                m.test_failed = false;
                let body = d.to_json();
                self.spawn(move |c| Some(answer(c.post_slow("/ext/models/save", body))));
            }
            ModelOp::Delete(id) => {
                m.list.retain(|x| x.id != id);
                if m.selected == id {
                    m.selected = crate::models::AUTO.into();
                }
                self.spawn(move |c| Some(answer(c.delete(&format!("/ext/models/{}", encode(&id))))));
            }
            ModelOp::Effort(id, effort) => {
                if let Some(x) = m.list.iter_mut().find(|x| x.id == id) {
                    x.effort = effort.clone();
                }
                self.spawn(move |c| Some(answer(c.post("/ext/models/effort", json!({ "id": id, "effort": effort })))));
            }
            ModelOp::Levels(id) => self.spawn(move |c| Some(answer(c.post_slow("/ext/models/effort-levels", json!({ "id": id }))))),
            ModelOp::Phone(id, on) => {
                m.busy = true;
                self.spawn(move |c| Some(answer(c.post_slow("/ext/models/phone", json!({ "id": id, "on": on })))));
            }
            ModelOp::ScanOllama => {
                m.scan.busy = true;
                m.scan.error = None;
                self.spawn(|c| Some(Msg::Ollama(c.get("/ext/models/ollama").unwrap_or_else(|e| json!({ "ok": false, "error": e })))));
            }
        }
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
    fn a_new_chat_stays_open_when_the_engine_renames_it() {
        let mut store = LiveStore::new("http://127.0.0.1:1", "t");
        let mut snap = Snapshot::default();
        let meta = |title: &str| json!({ "sessionId": "c_1", "type": "session_updated", "session": { "id": "c_1", "title": title, "cwd": "/w" } });
        store.fold(&meta("New chat"), &mut snap);
        // The app asked for it to open, and its first message then becomes its title.
        store.focus = Some("New chat".into());
        store.fold(&meta("Fix the checkout crash"), &mut snap);
        assert_eq!(store.take_focus().as_deref(), Some("Fix the checkout crash"));
        assert_eq!(store.take_renames(), [("New chat".to_owned(), "Fix the checkout crash".to_owned())]);
        assert!(store.take_renames().is_empty());
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

    /// Against a sidecar with a fake OpenAI-compatible server at CODEPLY_FAKE_MODEL (a base URL):
    /// adds a model through the engine, picks it, sets its effort, and removes it.
    #[test]
    #[ignore = "needs a running sidecar and a fake model server"]
    fn models_round_trip_through_the_engine() {
        use crate::models::{ModelDraft, ModelOp};
        let url = std::env::var("CODEPLY_SERVER").unwrap_or_else(|_| "http://127.0.0.1:47811".into());
        let token = std::env::var("CODEPLY_TOKEN").unwrap_or_else(|_| "t".into());
        let fake = std::env::var("CODEPLY_FAKE_MODEL").unwrap_or_else(|_| "http://127.0.0.1:47899/v1".into());
        let mut store = LiveStore::new(&url, &token);
        let mut snap = store.load();
        store.set_waker(std::sync::Arc::new(|| {}));
        let wait = |store: &mut LiveStore, snap: &mut Snapshot, done: &dyn Fn(&Snapshot) -> bool| {
            for _ in 0..200 {
                store.poll(snap);
                if done(snap) {
                    return true;
                }
                thread::sleep(Duration::from_millis(50));
            }
            false
        };
        assert!(wait(&mut store, &mut snap, &|s| s.extra.models.loaded), "the list arrives");
        let draft = ModelDraft { kind: "openai".into(), name: "Live test".into(), base_url: fake, model: "fake-1".into(), api_key: Some("sk-live-test-1234".into()), phone: false, ..ModelDraft::default() };
        store.models(ModelOp::Save(draft), &mut snap);
        assert!(snap.extra.models.busy);
        assert!(wait(&mut store, &mut snap, &|s| s.extra.models.saved == 1), "saved: {:?}", snap.extra.models.error);
        let m = snap.extra.models.current().cloned().expect("the new model is picked");
        assert_eq!((m.name.as_str(), m.has_key), ("Live test", true));
        assert!(!m.key_preview.contains("live-test"), "the key is never shown in full: {}", m.key_preview);
        store.models(ModelOp::Levels(m.id.clone()), &mut snap);
        assert!(wait(&mut store, &mut snap, &|s| s.extra.models.current().is_some_and(|m| m.effort_levels.is_some())), "levels arrive");
        store.models(ModelOp::Effort(m.id.clone(), "high".into()), &mut snap);
        assert!(wait(&mut store, &mut snap, &|s| s.extra.models.current().is_some_and(|m| m.effort == "high")));
        store.models(ModelOp::Delete(m.id.clone()), &mut snap);
        assert!(wait(&mut store, &mut snap, &|s| s.extra.models.selected == "auto" && !s.extra.models.list.iter().any(|x| x.id == m.id)));
    }

    /// The Apps page against a running sidecar (`sidecar/engine.mjs --port 47823` with
    /// `CODEPLY_SIDECAR_TOKEN=t`, HOME pointing somewhere disposable): the whole catalogue is
    /// searched, an open app really connects, lists its tools and disconnects.
    #[test]
    #[ignore = "needs a running sidecar and the network"]
    fn drives_the_apps_catalogue() {
        let url = std::env::var("CODEPLY_SERVER").unwrap_or_else(|_| "http://127.0.0.1:47823".into());
        let token = std::env::var("CODEPLY_TOKEN").unwrap_or_else(|_| "t".into());
        let mut store = LiveStore::new(&url, &token);
        let mut snap = store.load();
        store.set_waker(std::sync::Arc::new(|| {}));
        let wait = |store: &mut LiveStore, snap: &mut Snapshot, done: &dyn Fn(&Snapshot) -> bool| {
            for _ in 0..400 {
                store.poll(snap);
                if done(snap) {
                    return true;
                }
                thread::sleep(Duration::from_millis(50));
            }
            false
        };
        let q = |text: &str, offset| AppsQuery { text: text.into(), category: None, offset };
        // The whole catalogue, not just the featured few.
        store.browse_apps(&q("", 0), &mut snap);
        assert!(wait(&mut store, &mut snap, &|s| s.extra.apps.total > 10_000 && s.extra.apps.indexing.is_none()), "total {}", snap.extra.apps.total);
        assert_eq!(snap.extra.catalog.len(), APPS_PAGE);
        assert!(snap.extra.apps.categories.len() > 8);
        // The next page adds to the first.
        store.browse_apps(&q("", APPS_PAGE), &mut snap);
        assert!(wait(&mut store, &mut snap, &|s| s.extra.catalog.len() == 2 * APPS_PAGE), "{}", snap.extra.catalog.len());
        // A search reaches apps that are nowhere near the first page.
        store.browse_apps(&q("cloudflare", 0), &mut snap);
        assert!(wait(&mut store, &mut snap, &|s| s.extra.apps.matched > 50 && s.extra.catalog.iter().any(|a| a.slug == "cloudflare")), "{}", snap.extra.apps.matched);
        // Connecting an app that needs no sign-in really connects.
        store.connect_app("cloudflare", &mut snap);
        assert!(wait(&mut store, &mut snap, &|s| s.extra.apps.progress.as_ref().is_some_and(|p| p.state == "done")), "{:?}", snap.extra.apps.progress);
        assert!(wait(&mut store, &mut snap, &|s| s.extra.apps.connected.iter().any(|a| a.slug == "cloudflare" && a.tools > 0)), "{:?}", snap.extra.apps.connected);
        store.app_tools("cloudflare", &mut snap);
        assert!(wait(&mut store, &mut snap, &|s| matches!(&s.extra.apps.tools, Some((id, Ok(t))) if id == "cloudflare" && !t.is_empty())), "{:?}", snap.extra.apps.tools);
        store.disconnect_app("cloudflare", &mut snap);
        assert!(wait(&mut store, &mut snap, &|s| s.extra.apps.connected.is_empty() && s.extra.catalog.iter().any(|a| a.slug == "cloudflare" && !a.connected)), "{:?}", snap.extra.apps.connected);
    }
}
