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
use crate::model::{AgentState, AppProgress, BgTask, ButtonKind, CatalogApp, ChatGroup, ChatKind, ChatMeta, Column, Memory, Pill, Publish, ReviewNote, Snapshot, Task, TaskBody, TermKind, TermLine, ThreadItem};

/// What the worker threads send back to the UI thread.
enum Msg {
    Sessions(Vec<Session>),
    /// The engine's project folder (its full path), its version, and which engine replies ("dsh").
    Project(String, String, String),
    /// The answer to opening another project folder (`POST /project`).
    ProjectSet(Value),
    /// A clone finished: the folder to open, or why it failed.
    Cloned(Result<String, String>),
    /// A chat `send` made for a new conversation, by engine id: open it once it has a title.
    Created(String),
    Account(Value),
    Usage(Value),
    /// Your plan (`/ext/billing`), and the answer to making a checkout for a plan key.
    Billing(Value),
    Checkout(String, Value),
    /// The team and its loops (`/ext/team`).
    Team(Value),
    /// The background agents (`/ext/agents`).
    Agents(Value),
    /// An inline edit's answer: (file, the instruction, `{ text }` or `{ error }`).
    Proposal(String, String, Value),
    /// After a file change: the file list, the file to open (path, text), or why it failed.
    FileOp(Vec<String>, Option<(String, String)>, String),
    /// Cloud & devices (`/ext/cloud`), or an error to show.
    Cloud(Value),
    /// Pull requests and this branch's changes (`/ext/prs`), and a PR's diff: (number, files).
    Prs(Value),
    PrFiles(u32, Value),
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
    /// A chat's messages, and the free limit its last reply ended on (see `limit_of`).
    Transcript { id: String, items: Vec<ThreadItem>, limit: Option<String> },
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
    /// "agent" or "code" when the engine knows (older chats leave it empty), and the agent's name.
    kind: String,
    agent: String,
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
        self.post_for(path, body, 150)
    }
    /// A POST the engine may take up to `secs` to answer (a clone, a push).
    fn post_for(&self, path: &str, body: Value, secs: u64) -> Result<Value, String> {
        ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(2)).timeout_read(Duration::from_secs(secs)).build()
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

/// `/ext/prs` as pull requests: this branch's own changes first (number 0), then GitHub's.
fn prs_from(v: &Value) -> Vec<crate::model::Pr> {
    use crate::model::{Pr, PrState};
    let s = |x: &Value, k: &str| x[k].as_str().unwrap_or_default().to_owned();
    let n = |x: &Value, k: &str| x[k].as_u64().unwrap_or(0) as u32;
    let mut out = Vec::new();
    let mine = &v["local"];
    let commits = mine["commits"].as_array().map(Vec::as_slice).unwrap_or_default();
    if mine.is_object() && mine["pr"].as_u64().unwrap_or(0) == 0 && (n(mine, "files") > 0 || !commits.is_empty()) {
        let list: Vec<String> = commits.iter().map(|c| format!("- {} `{}` {}", s(c, "subject"), s(c, "sha"), s(c, "when"))).collect();
        out.push(Pr {
            number: 0,
            title: format!("Changes on {}", s(mine, "branch")),
            by: s(mine, "author"),
            state: PrState::Draft,
            age: commits.first().map_or_else(|| "not committed".to_owned(), |c| s(c, "when")),
            added: n(mine, "add"),
            removed: n(mine, "del"),
            branch: s(mine, "branch"),
            summary: if list.is_empty() { format!("Not committed yet: {} changed files against {}.", n(mine, "files"), s(mine, "base")) } else { list.join("\n") },
            points: Vec::new(),
            url: String::new(),
            checks: None,
            reviewers: Vec::new(),
            local: true,
        });
    }
    for p in v["prs"].as_array().map(Vec::as_slice).unwrap_or_default() {
        let c = &p["checks"];
        out.push(Pr {
            number: n(p, "number"),
            title: s(p, "title"),
            by: s(p, "by"),
            state: match p["state"].as_str() { Some("MERGED") => PrState::Merged, Some("DRAFT") => PrState::Draft, _ => PrState::Open },
            age: s(p, "age"),
            added: n(p, "add"),
            removed: n(p, "del"),
            branch: s(p, "branch"),
            summary: s(p, "body"),
            points: Vec::new(),
            url: s(p, "url"),
            checks: (n(c, "total") > 0).then(|| (n(c, "passed"), n(c, "failed"), n(c, "pending"))),
            reviewers: p["reviewers"].as_array().map(Vec::as_slice).unwrap_or_default().iter().filter_map(|r| r.as_str().map(str::to_owned)).collect(),
            local: false,
        });
    }
    // Closed (not merged) ones are left out, as on GitHub's default list.
    out.retain(|p| p.local || v["prs"].as_array().is_some_and(|a| a.iter().any(|x| x["number"].as_u64() == Some(u64::from(p.number)) && x["state"].as_str() != Some("CLOSED"))));
    out
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

/// `/ext/billing`, or its `billing` event, into `extra.billing` (see sidecar/ext-billing.mjs).
pub fn billing_from(b: &mut crate::model::Billing, v: &Value) {
    use crate::model::{Checkout, CheckoutState, FreeLimit, Plan};
    let text = |x: &Value| x.as_str().unwrap_or_default().to_owned();
    b.error = if v["ok"].as_bool() == Some(false) { text(&v["error"]) } else { String::new() };
    match v["signedIn"].as_bool() {
        Some(false) => {
            b.signed_out = true;
            b.plan = None;
        }
        Some(true) => b.signed_out = false,
        None => {}
    }
    if let Some(p) = v["plan"].as_object() {
        let models = p.get("models").and_then(Value::as_array).map_or_else(Vec::new, |a| a.iter().filter_map(|m| m.as_str().map(str::to_owned)).collect());
        b.plan = Some(Plan { key: text(&v["plan"]["key"]), name: text(&v["plan"]["name"]), models });
    }
    if let Some(f) = v.get("free") {
        let n = |x: &Value| x.as_u64().or_else(|| x.as_f64().map(|f| f.max(0.0).round() as u64)).unwrap_or(0);
        b.free = f.is_object().then(|| FreeLimit { used: n(&f["used"]), limit: n(&f["limit"]), resets: text(&f["resets"]) }).filter(|f| f.limit > 0);
    }
    match v.get("checkout") {
        Some(c) if c.is_object() => {
            let state = match c["state"].as_str().unwrap_or_default() {
                "waiting" => Some(CheckoutState::Waiting),
                "done" => Some(CheckoutState::Done),
                "expired" => Some(CheckoutState::Failed(text(&c["error"]))),
                _ => None,
            };
            b.checkout = state.map(|state| Checkout { plan: text(&c["plan"]), url: text(&c["url"]), state });
        }
        // The engine has none: one it was watching is gone (it restarted); one being made stays.
        Some(_) if matches!(&b.checkout, Some(c) if c.state == CheckoutState::Waiting) => b.checkout = None,
        _ => {}
    }
}

/// What the sidebar and Settings call your plan: "Pro plan", once the account said.
fn plan_label(snap: &mut Snapshot) {
    if let Some(p) = &snap.extra.billing.plan
        && !p.name.is_empty()
    {
        snap.plan = format!("{} plan", p.name);
    }
}

impl LiveStore {
    /// A file's text for the editor: CRLF line endings become plain newlines (an editor line
    /// is one line, not a line and a blank one), remembered so a save writes them back.
    fn lf(&mut self, path: &str, text: String) -> String {
        if text.contains("\r\n") {
            self.crlf.insert(path.to_owned());
            text.replace("\r\n", "\n")
        } else {
            self.crlf.remove(path);
            text
        }
    }

    /// Fetches the account, apps, memories and files (at launch, and after they change).
    fn refresh(&self, what: &'static str) {
        self.spawn(move |c| {
            for _ in 0..120 {
                let got = match what {
                    "account" => c.get("/account").map(Msg::Account),
                    "apps" => c.get("/ext/apps?limit=60").map(|v| Msg::Apps(0, 0, Box::new(apps_page(&v)))),
                    "memory" => c.get("/memory").map(|v| Msg::Memories(memories_from(&v))),
                    "models" => c.get("/ext/models").map(Msg::Models),
                    "billing" => c.get("/ext/billing").map(Msg::Billing),
                    "team" => c.get("/ext/team").map(Msg::Team),
                    "agents" => c.get("/ext/agents").map(Msg::Agents),
                    "prs" => c.get("/ext/prs").map(Msg::Prs),
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
        let sessions = &self.sessions;
        let title = |id: &str| sessions.iter().find(|s| s.id == id).map(|s| s.title.clone());
        if crate::subagents::fold(&mut snap.extra.subagents, e, &title) {
            return true;
        }
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
            // A checkout finished (or ran out of time) while the engine watched it.
            "billing" => {
                billing_from(&mut x.billing, e);
                plan_label(snap);
            }
            "models_changed" => self.refresh("models"),
            "team_changed" | "wisp_team" => self.refresh("team"),
            _ => return false,
        }
        true
    }

    /// A chat asked one of your agents, or got its answer: one row per run of them, "4 messages
    /// with Inbox Watch, Emma" with each agent's mascot, as the demo chat shows it.
    fn fold_delegation(&self, e: &Value, snap: &mut Snapshot) {
        let Some(title) = self.title_of(e["sessionId"].as_str().unwrap_or_default()) else { return };
        if e["type"] == "delegate_done" {
            snap.extra.step_now.retain(|(k, _)| *k != title);
        }
        let name = e["agent"].as_str().unwrap_or("an agent").to_owned();
        let id = snap.team.iter().find(|a| a.name.eq_ignore_ascii_case(&name) || a.id == name).map(|a| a.id.clone());
        // A known agent joins the row the last ask or answer started.
        if let Some(id) = &id {
            let items = match snap.threads.iter_mut().find(|(k, _)| *k == title) {
                Some((_, items)) => items,
                None => {
                    snap.threads.push((title.clone(), Vec::new()));
                    &mut snap.threads.last_mut().expect("just pushed").1
                }
            };
            if let Some(ThreadItem::Team { text, agents }) = items.last_mut() {
                let n = text.split_whitespace().next().and_then(|w| w.parse::<usize>().ok()).unwrap_or(1) + 1;
                *text = format!("{n} messages with");
                if !agents.contains(id) {
                    agents.push(id.clone());
                }
            } else if e["type"] == "delegated" {
                items.push(ThreadItem::Team { text: "1 message with".into(), agents: vec![id.clone()] });
            } else {
                items.push(ThreadItem::Team { text: "1 message from".into(), agents: vec![id.clone()] });
            }
            return;
        }
        let item = match e["type"].as_str() {
            Some("delegated") => ThreadItem::Event { icon: "users", text: format!("Asked **{name}**"), detail: None },
            _ => {
                let summary = e["summary"].as_str().unwrap_or_default();
                let short: String = summary.chars().take(160).collect();
                ThreadItem::Event { icon: "check", text: if short.is_empty() { format!("**{name}** is done") } else { format!("**{name}**: {short}") }, detail: None }
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
    /// A folder to open as the project (a clone that finished).
    open_project: Option<String>,
    /// Files that use Windows line endings (CRLF): the editor shows them with plain newlines and
    /// saving puts the CRLFs back.
    crlf: std::collections::HashSet<String>,
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
            open_url: None, open_project: None, crlf: Default::default(), team: Vec::new(), renames: Vec::new(),
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
        if kind == "session_deleted" {
            if let Some(title) = self.title_of(&id) {
                snap.threads.retain(|(k, _)| *k != title);
                snap.extra.step_now.retain(|(k, _)| *k != title);
            }
            self.sessions.retain(|s| s.id != id);
            self.named.retain(|_, v| *v != id);
            return;
        }
        let Some(title) = self.title_of(&id) else { return };
        // Haze 2's free limit ended this reply: the card shows until the chat's next reply starts.
        if kind == "run_started" || kind == "queued" {
            snap.extra.limits.retain(|(k, _)| *k != title);
        }
        if let Some(resets) = limit_of(e) {
            snap.extra.limits.retain(|(k, _)| *k != title);
            snap.extra.limits.push((title.clone(), resets));
        }
        // What it's doing right now: set by a step starting, cleared by what comes after.
        match kind {
            "step" => {
                let label = e["label"].as_str().unwrap_or_default().to_owned();
                snap.extra.step_now.retain(|(k, _)| *k != title);
                if !label.is_empty() {
                    snap.extra.step_now.push((title.clone(), label));
                }
                return;
            }
            "tool_end" | "text_delta" | "text" | "run_finished" | "approval_request" | "error" | "aborted" | "done" | "delegate_done" => {
                snap.extra.step_now.retain(|(k, _)| *k != title);
            }
            _ => {}
        }
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
                if !shown && let Some(m) = e.get("message") {
                    items.extend(items_from(m));
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
fn metas(sessions: &[Session], unread: &std::collections::HashSet<String>, team: &[crate::model::Agent]) -> Vec<ChatMeta> {
    let mut list: Vec<&Session> = sessions.iter().collect();
    list.sort_by_key(|s| std::cmp::Reverse(s.updated));
    list.into_iter().map(|s| ChatMeta {
        title: s.title.clone(),
        kind: kind_of(s, team),
        project: std::path::Path::new(&s.cwd).file_name().and_then(|n| n.to_str()).unwrap_or_default().to_owned(),
        ago: ago(s.updated),
        preview: one_line(&s.preview, 120),
        running: s.running,
        unread: unread.contains(&s.id),
    }).collect()
}

/// The team's states and Mission control's lists, from the engine's chats: an agent works while
/// its chat runs, needs you while one of its approvals waits, and each chat that ran today is
/// done today.
/// Where a chat belongs: what the engine says (an agent's session, the code view's chat), else
/// what its title says (the agent's own chat or a loop of theirs; "Code · project"), else yours.
fn kind_of(s: &Session, team: &[crate::model::Agent]) -> ChatKind {
    if s.kind == "code" || s.title.starts_with("Code · ") {
        return ChatKind::Code;
    }
    let by_name = |name: &str| team.iter().find(|a| a.name.eq_ignore_ascii_case(name.trim()) || a.id == name).map(|a| a.id.clone());
    if s.kind == "agent" {
        return ChatKind::Agent(by_name(&s.agent).or_else(|| agent_match(&s.title, team)).unwrap_or_else(|| "wisp".to_owned()));
    }
    if s.title.eq_ignore_ascii_case("wisp") {
        return ChatKind::Agent("wisp".into());
    }
    agent_match(&s.title, team).map_or(ChatKind::Chat, ChatKind::Agent)
}

/// Whose chat this is: the agent it's named after ("Emma"), a loop of theirs ("Emma: Check my
/// LinkedIn"), or the start of their name ("Inbox" for "Inbox Watch"); Wisp otherwise. The
/// longest name that fits wins.
fn agent_of(title: &str, team: &[crate::model::Agent]) -> String {
    agent_match(title, team).unwrap_or_else(|| "wisp".to_owned())
}

/// `agent_of` without the fallback: None when no agent's name fits.
fn agent_match(title: &str, team: &[crate::model::Agent]) -> Option<String> {
    let t = title.trim().to_lowercase();
    let head = t.split(':').next().unwrap_or("").trim().to_owned();
    // (exact name, name length): a whole name beats the start of a longer one.
    team.iter()
        .filter(|a| a.id != "wisp")
        .filter_map(|a| {
            let n = a.name.trim().to_lowercase();
            let exact = !n.is_empty() && (t == n || head == n);
            let start = head.len() >= 3 && n.starts_with(&head) && n[head.len()..].starts_with(' ');
            (exact || start).then_some(((exact, n.len()), a))
        })
        .max_by_key(|(rank, _)| *rank)
        .map(|(_, a)| a.id.clone())
}

/// A message's start as one plain line: no Markdown marks, no line breaks, at most `max` chars.
fn one_line(text: &str, max: usize) -> String {
    let text = crate::thread::shown_message(text);
    let mut out = String::new();
    for line in text.lines() {
        let l = line.trim().trim_start_matches(['#', '>', '-', '*', '+']).trim();
        if l.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(l);
        if out.len() >= max {
            break;
        }
    }
    let out = out.replace("**", "").replace("__", "").replace('`', "");
    let out: String = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.chars().count() > max { format!("{}…", out.chars().take(max).collect::<String>().trim_end()) } else { out }
}

fn derive(snap: &mut Snapshot, sessions: &[Session]) {
    // Mission control and the team's states come from the agents' sessions only: never your
    // chats or the code view's.
    let team = snap.team.clone();
    let sessions: Vec<Session> = sessions.iter().filter(|s| matches!(kind_of(s, &team), ChatKind::Agent(_))).cloned().collect();
    let sessions = &sessions[..];
    let agent_of_session = |title: &str| sessions.iter().find(|s| s.title == title).map(|s| kind_of(s, &team));
    let waiting: Vec<_> = snap.waiting().into_iter().filter(|(c, _, _)| matches!(agent_of_session(c), Some(ChatKind::Agent(_)))).collect();
    let agent_for = |title: &str, team: &[crate::model::Agent]| match sessions.iter().find(|s| s.title == title).map(|s| kind_of(s, team)) {
        Some(ChatKind::Agent(id)) => id,
        _ => agent_of(title, team),
    };
    for a in &mut snap.team {
        if a.state == AgentState::Walking {
            continue;
        }
        // The agent's latest session, and whether any of them is running or asking.
        let mine: Vec<&Session> = sessions.iter().filter(|s| kind_of(s, &team) == ChatKind::Agent(a.id.clone())).collect();
        let chat = mine.iter().find(|s| s.running).or_else(|| mine.iter().max_by_key(|s| s.updated)).copied();
        let asks = waiting.iter().any(|(c, _, _)| mine.iter().any(|s| s.title == *c));
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
            a.status = one_line(&c.preview, 80);
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
            sub: format!("{} · {}", ago(s.updated), if s.preview.is_empty() { "working".to_owned() } else { one_line(&s.preview, 90) }),
            pill: Some(("Running".into(), Pill::Blue)),
            body: TaskBody::Working { icon: "terminal", now: one_line(&s.preview, 90), progress: 0.5, screen: false },
        }));
    }
    for s in list.iter().filter(|s| !s.running && s.updated >= today).take(6) {
        tasks.push((Column::Done, Task {
            request: None,
            agent: agent_for(&s.title, &snap.team),
            title: s.title.clone(),
            sub: String::new(),
            pill: None,
            body: TaskBody::Done { proof: one_line(&s.preview, 90), checked: true },
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
            kind: s["kind"].as_str().unwrap_or_default().to_owned(),
            agent: s["agent"].as_str().unwrap_or_default().to_owned(),
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
        kind: meta["kind"].as_str().unwrap_or_default().to_owned(),
        agent: meta["agent"].as_str().unwrap_or_default().to_owned(),
    }
}

/// The app's icon for a step's icon name (the engine's stepOf in engine.mjs).
fn step_icon(name: &str) -> &'static str {
    match name {
        "file-text" => "file-text",
        "edit" => "edit",
        "terminal" => "terminal",
        "search" => "search",
        "folder" => "folder",
        "globe" => "globe",
        "users" => "users",
        "link" => "link",
        "bulb" => "bulb",
        "list" => "list",
        "image" => "image",
        "check" => "check",
        _ => "sparkle",
    }
}

/// A step saved without words (by an older version, which kept only the tool's name): what
/// that kind of tool does, in words.
fn tool_words(name: &str) -> String {
    let n = name.trim_start_matches("dsh:");
    let known = match n {
        "read" | "read_file" => "Read a file",
        "read_image" | "view_images" => "Looked at an image",
        "write" | "write_file" | "create" => "Wrote a file",
        "edit" | "edit_file" | "multi_edit" | "str_replace_editor" => "Edited a file",
        "grep" | "search" => "Searched the code",
        "glob" | "ls" | "list_dir" => "Looked through the files",
        "web_search" => "Searched the web",
        "web_fetch" | "fetch" => "Opened a page",
        "browser_check" => "Checked the page in a browser",
        "ask_bot" => "Asked a teammate",
        "hand_off" => "Handed work to a teammate",
        "use_app" | "mcp" => "Used an app",
        "todo_write" => "Updated the plan",
        "remember" => "Remembered something",
        "recall" => "Looked through memories",
        n if n.is_empty() => "Used a tool",
        n if n.contains("pwsh") || n.contains("bash") || n.contains("shell") || n == "run" || n == "run_command" || n == "exec" || n == "cmd" || n == "powershell" => "Ran a command",
        _ => "",
    };
    if known.is_empty() { format!("Used {}", n.replace(['_', '-'], " ").trim()) } else { known.to_owned() }
}

/// A stored message as the transcript shows it.
/// A stored message as transcript items: a message sent with files shows them above it.
pub fn items_from(m: &Value) -> Vec<ThreadItem> {
    let files: Vec<String> = m["files"].as_array().map_or_else(Vec::new, |a| a.iter().filter_map(|f| f.as_str().map(str::to_owned)).collect());
    let mut out = Vec::new();
    if m["kind"] == "user" && !files.is_empty() {
        out.push(ThreadItem::Files(files));
    }
    out.extend(item_from(m));
    out
}

/// A command step's command and output, when the engine sent them (engine.mjs commandDetail).
fn step_detail(v: &Value) -> Option<Box<crate::model::StepDetail>> {
    let command = v["command"].as_str().filter(|c| !c.trim().is_empty())?;
    Some(Box::new(crate::model::StepDetail { command: command.to_owned(), output: v["output"].as_str().unwrap_or_default().to_owned() }))
}

/// Haze 2's free limit ended a reply: a stored notice, or a live `notice` or `error`, that
/// carries `limited` (engine.mjs startRun). Its local reset time ("4:30 PM", or empty). The chat
/// shows the upgrade card for it instead of the notice.
pub fn limit_of(v: &Value) -> Option<String> {
    let notice = v["kind"] == "notice" || v["type"] == "notice" || v["type"] == "error";
    (notice && v["limited"].as_bool() == Some(true)).then(|| v["resets"].as_str().unwrap_or_default().to_owned())
}

pub fn item_from(m: &Value) -> Option<ThreadItem> {
    let text = m["text"].as_str().unwrap_or_default().to_owned();
    if limit_of(m).is_some() {
        return None;
    }
    match m["kind"].as_str()? {
        "user" => Some(ThreadItem::You(text)),
        "assistant" if !m["interim"].as_bool().unwrap_or(false) => Some(ThreadItem::Them(text)),
        "tool" => Some(ThreadItem::Event {
            icon: step_icon(m["icon"].as_str().unwrap_or(if m["name"] == "run" { "terminal" } else { "edit" })),
            text: m["label"].as_str().filter(|l| !l.is_empty()).map_or_else(|| tool_words(m["name"].as_str().unwrap_or_default()), str::to_owned),
            detail: step_detail(m),
        }),
        "notice" => Some(ThreadItem::Event { icon: "help", text, detail: None }),
        "checkpoint" => Some(ThreadItem::Event { icon: "history", text: format!("Changed {} files", m["total"].as_u64().unwrap_or(0)), detail: None }),
        _ => None,
    }
}

/// A live event as the transcript shows it. `None` for events that only change state.
pub fn item_from_event(e: &Value) -> Option<ThreadItem> {
    if limit_of(e).is_some() {
        return None;
    }
    match e["type"].as_str()? {
        "run_started" => e.get("message").and_then(item_from),
        "text" if !e["interim"].as_bool().unwrap_or(false) => Some(ThreadItem::Them(e["text"].as_str()?.to_owned())),
        "tool_end" => Some(ThreadItem::Event {
            icon: step_icon(e["icon"].as_str().unwrap_or("check")),
            text: e["summary"].as_str().filter(|l| !l.is_empty()).map_or_else(|| tool_words(e["name"].as_str().unwrap_or_default()), str::to_owned),
            detail: step_detail(e),
        }),
        "approval_request" => Some(ThreadItem::Approval {
            id: e["requestId"].as_str()?.to_owned(),
            title: e["title"].as_str().unwrap_or("Run a tool").to_owned(),
            detail: e["detail"].as_str().unwrap_or_default().to_owned(),
            answer: None,
        }),
        "notice" => Some(ThreadItem::Event { icon: "help", text: e["text"].as_str()?.to_owned(), detail: None }),
        "error" => Some(ThreadItem::Event { icon: "help", text: e["error"].as_str().unwrap_or("Something went wrong").to_owned(), detail: None }),
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
        snap.extra.subagents = Default::default();
        // Pull requests come from the engine (ext-prs.mjs), and the team too (ext-team.mjs).
        snap.prs.clear();
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
                    let cwd = cfg["cwd"].as_str()?.to_owned();
                    let version = cfg["version"].as_str().unwrap_or_default().to_owned();
                    let engine = if cfg["dsh"].as_str().is_some_and(|d| d.starts_with("unavailable")) { "classic" } else { cfg["engine"].as_str().unwrap_or("dsh") };
                    return Some(Msg::Project(cwd, version, engine.to_owned()));
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
        for what in ["account", "apps", "memory", "files", "jobs", "models-sync", "team", "prs", "agents"] {
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
                    // Agents listed before their chat was known find it now.
                    for a in snap.extra.subagents.agents.iter_mut().filter(|a| a.chat.is_empty()) {
                        if let Some(s) = self.sessions.iter().find(|s| s.id == a.chat_id) {
                            a.chat = s.title.clone();
                        }
                    }
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
                Msg::Project(cwd, version, engine) => {
                    snap.project = crate::project::folder_name(&cwd);
                    snap.extra.project_path = cwd;
                    if !version.is_empty() {
                        snap.extra.version = format!("{} · engine {version}", crate::update::VERSION);
                    }
                    snap.extra.engine = if engine == "classic" { "Classic".into() } else { "DSH".into() };
                    snap.extra.engine_ok = true;
                }
                Msg::Created(id) => match self.title_of(&id) {
                    Some(title) => self.focus = Some(title),
                    None => self.want_focus = Some(id),
                },
                Msg::Transcript { id, items, limit } => {
                    if let Some(title) = self.title_of(&id) {
                        snap.extra.limits.retain(|(k, _)| *k != title);
                        if let Some(resets) = limit {
                            snap.extra.limits.push((title.clone(), resets));
                        }
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
                Msg::FileOp(files, open, error) => {
                    if !error.is_empty() {
                        snap.extra.team_note = Some(error);
                    }
                    if !files.is_empty() {
                        snap.extra.code.files = files;
                    }
                    if let Some((path, text)) = open {
                        let text = self.lf(&path, text);
                        snap.extra.code.open = Some(path);
                        snap.extra.code.saved = text;
                        snap.extra.code.review.clear();
                        snap.extra.code.suggestion = None;
                    }
                }
                Msg::Cloud(v) => {
                    if let Some(e) = v["error"].as_str().filter(|e| !e.is_empty()) {
                        snap.extra.team_note = Some(e.to_owned());
                    }
                    if v.get("projects").is_some() {
                        snap.extra.cloud = v;
                    }
                }
                Msg::ProjectSet(v) => match v["cwd"].as_str() {
                    Some(cwd) => {
                        snap.project = crate::project::folder_name(cwd);
                        snap.extra.project_path = cwd.to_owned();
                        self.refresh("files");
                        self.refresh("prs");
                    }
                    None => snap.extra.team_note = Some(v["error"].as_str().unwrap_or("Couldn't open that folder.").to_owned()),
                },
                Msg::Cloned(r) => {
                    snap.extra.prs_busy = false;
                    match r {
                        Ok(path) => self.open_project = Some(path),
                        Err(e) => snap.extra.team_note = Some(e),
                    }
                }
                Msg::Prs(v) => {
                    snap.extra.prs_busy = false;
                    if v.get("repo").is_some() {
                        snap.extra.repo = Some(crate::model::RepoState {
                            repo: v["repo"].as_bool().unwrap_or(false),
                            remote: v["remote"].as_bool().unwrap_or(false),
                            branch: v["branch"].as_str().unwrap_or_default().to_owned(),
                            base: v["base"].as_str().unwrap_or_default().to_owned(),
                            gh: v["gh"]["code"].as_str().unwrap_or_default().to_owned(),
                            detail: v["gh"]["detail"].as_str().unwrap_or_default().to_owned(),
                        });
                    }
                    snap.prs = prs_from(&v);
                    snap.extra.prs_note = v["gh"]["error"].as_str().unwrap_or_default().to_owned();
                    if let Some(e) = v["error"].as_str().filter(|e| !e.is_empty()) {
                        snap.extra.team_note = Some(e.to_owned());
                    }
                    if let Some(u) = v["url"].as_str().filter(|u| !u.is_empty()) {
                        self.open_url = Some(u.to_owned());
                    }
                }
                Msg::PrFiles(n, v) => {
                    let files = v["files"].as_array().map(Vec::as_slice).unwrap_or_default().iter().map(|f| {
                        let lines = f["lines"].as_array().map(Vec::as_slice).unwrap_or_default().iter().map(|l| {
                            (l[0].as_str().and_then(|k| k.chars().next()).unwrap_or(' '), l[1].as_str().unwrap_or_default().to_owned())
                        }).collect();
                        (f["path"].as_str().unwrap_or_default().to_owned(), lines)
                    }).collect();
                    snap.extra.pr_files = Some((n, files));
                }
                Msg::Proposal(file, instruction, v) => {
                    if let Some(p) = snap.extra.code.proposal.as_mut().filter(|p| p.file == file && p.instruction == instruction) {
                        match v["text"].as_str() {
                            Some(t) => p.after = Some(t.to_owned()),
                            None => p.error = v["error"].as_str().unwrap_or("The edit failed.").to_owned(),
                        }
                        snap.extra.code.wisp = "idle".into();
                    }
                }
                Msg::Agents(v) => {
                    let sessions = &self.sessions;
                    let title = |id: &str| sessions.iter().find(|s| s.id == id).map(|s| s.title.clone());
                    crate::subagents::apply(&mut snap.extra.subagents, &v, &title);
                }
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
                    // The plan itself, from the account (signing in or out changes it).
                    plan_label(snap);
                    self.refresh("billing");
                }
                Msg::Billing(v) => {
                    billing_from(&mut snap.extra.billing, &v);
                    plan_label(snap);
                }
                Msg::Checkout(plan, v) => {
                    let b = &mut snap.extra.billing;
                    // Cancelled while the checkout was being made: let it go.
                    if !matches!(&b.checkout, Some(c) if c.plan == plan && c.state == crate::model::CheckoutState::Opening) {
                        if v["ok"].as_bool() == Some(true) {
                            self.spawn(|c| c.post("/ext/billing/cancel", json!({})).err().map(Msg::Status));
                        }
                        continue;
                    }
                    let url = v["checkout"]["url"].as_str().unwrap_or_default().to_owned();
                    let state = if v["ok"].as_bool() == Some(true) && !url.is_empty() {
                        self.open_url = Some(url.clone());
                        crate::model::CheckoutState::Waiting
                    } else if v["signedIn"].as_bool() == Some(false) {
                        b.signed_out = true;
                        crate::model::CheckoutState::SignIn
                    } else {
                        crate::model::CheckoutState::Failed(v["error"].as_str().unwrap_or("Checkout didn't open. Try again.").to_owned())
                    };
                    b.checkout = Some(crate::model::Checkout { plan, url, state });
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
                    let text = self.lf(&path, text);
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
            // Chat's sidebar, its groups and the home screen's recents hold only your chats.
            let mine: Vec<Session> = self.sessions.iter().filter(|s| kind_of(s, &snap.team) == ChatKind::Chat).cloned().collect();
            snap.chat_groups = group(&mine);
            snap.recent = recent(&mine);
            snap.extra.chats = metas(&self.sessions, &self.unread, &snap.team);
            let mut projects: Vec<String> = Vec::new();
            for c in snap.extra.chats.iter().filter(|c| c.kind == ChatKind::Chat) {
                if !c.project.is_empty() && !projects.contains(&c.project) {
                    projects.push(c.project.clone());
                }
            }
            snap.extra.projects = projects;
            derive(snap, &self.sessions);
        }
        changed
    }

    fn file_op(&mut self, op: crate::model::FileOp, snap: &mut Snapshot) {
        use crate::model::FileOp;
        let open = snap.extra.code.open.clone();
        self.spawn(move |c| {
            let list = |c: &Conn| c.get("/files").map(|v| v["files"].as_array().map_or_else(Vec::new, |a| a.iter().filter_map(|f| f.as_str().map(str::to_owned)).collect())).unwrap_or_default();
            let (res, then_open) = match &op {
                FileOp::New(p) => (c.put("/file", json!({ "path": p, "text": "" })), Some(p.clone())),
                FileOp::Rename(from, to) => (c.post("/ext/code/rename", json!({ "from": from, "to": to })), (open.as_deref() == Some(from.as_str())).then(|| to.clone())),
                FileOp::Delete(p) => (c.post("/ext/code/delete", json!({ "path": p })), None),
            };
            let error = match res {
                Ok(v) => v["error"].as_str().unwrap_or_default().to_owned(),
                Err(e) => e.to_string(),
            };
            let opened = if error.is_empty() {
                then_open.map(|p| {
                    let text = c.get(&format!("/file?path={}", encode(&p))).ok().and_then(|v| v["text"].as_str().map(str::to_owned)).unwrap_or_default();
                    (p, text)
                })
            } else {
                None
            };
            Some(Msg::FileOp(list(c), opened, error))
        });
    }

    fn cloud_op(&mut self, op: crate::model::CloudOp, _snap: &mut Snapshot) {
        use crate::model::CloudOp;
        let post = match op {
            CloudOp::Load => None,
            CloudOp::Sync => Some(("/ext/cloud/sync", json!({}))),
            CloudOp::Setup(cwd) => Some(("/ext/cloud/setup", json!({ "cwd": cwd }))),
            CloudOp::Options(cwd, key, on) => Some(("/ext/cloud/options", json!({ "cwd": cwd, key: on }))),
        };
        self.spawn(move |c| {
            // A change first (its error shows as a notice), then the page as it now stands.
            if let Some((path, body)) = post {
                match c.post(path, body) {
                    Ok(v) if v["error"].as_str().is_some_and(|e| !e.is_empty()) => return Some(Msg::Cloud(json!({ "error": v["error"] }))),
                    Err(e) => return Some(Msg::Cloud(json!({ "error": format!("The engine didn't answer: {e}") }))),
                    _ => {}
                }
            }
            for _ in 0..40 {
                if let Ok(v) = c.get("/ext/cloud") {
                    return Some(Msg::Cloud(v));
                }
                thread::sleep(Duration::from_millis(250));
            }
            None
        });
    }

    fn prs_op(&mut self, op: crate::model::PrOp, snap: &mut Snapshot) {
        use crate::model::PrOp;
        // Init, clone, publish, create and merge take a while: the page shows it's working.
        let busy = !matches!(op, PrOp::Refresh | PrOp::Diff(_));
        match op {
            PrOp::Refresh => self.refresh("prs"),
            // Retried while the engine starts (the Changes tab may open before it answers).
            PrOp::Diff(n) => self.spawn(move |c| {
                for _ in 0..120 {
                    if let Ok(v) = c.get(&format!("/ext/prs/diff?n={n}")) {
                        return Some(Msg::PrFiles(n, v));
                    }
                    thread::sleep(Duration::from_millis(250));
                }
                Some(Msg::PrFiles(n, json!({ "files": [] })))
            }),
            PrOp::Merge(n) => self.spawn(move |c| Some(Msg::Prs(c.post_for("/ext/prs/merge", json!({ "n": n }), 90).unwrap_or_else(|e| json!({ "error": e }))))),
            PrOp::Create => self.spawn(|c| Some(Msg::Prs(c.post_for("/ext/prs/create", json!({}), 90).unwrap_or_else(|e| json!({ "error": e }))))),
            PrOp::Init => self.spawn(|c| Some(Msg::Prs(c.post_for("/ext/prs/init", json!({}), 90).unwrap_or_else(|e| json!({ "error": e }))))),
            PrOp::Publish => self.spawn(|c| Some(Msg::Prs(c.post_for("/ext/prs/publish", json!({}), 150).unwrap_or_else(|e| json!({ "error": e }))))),
            PrOp::Clone(url) => self.spawn(move |c| Some(Msg::Cloned(match c.post_for("/ext/prs/clone", json!({ "url": url }), 320) {
                Ok(v) => v["path"].as_str().map(str::to_owned).ok_or_else(|| v["error"].as_str().unwrap_or("The clone failed.").to_owned()),
                Err(e) => Err(e),
            }))),
        }
        if busy {
            snap.extra.prs_busy = true;
        }
    }

    fn set_project(&mut self, path: &str, snap: &mut Snapshot) {
        snap.project = crate::project::folder_name(path);
        snap.extra.project_path = path.to_owned();
        snap.extra.code.files.clear();
        snap.extra.repo = None;
        snap.prs.clear();
        let path = path.to_owned();
        self.spawn(move |c| Some(Msg::ProjectSet(c.post("/project", json!({ "path": path })).unwrap_or_else(|e| json!({ "error": e })))));
    }

    fn refresh_files(&mut self) {
        self.refresh("files");
    }

    fn delete_chat(&mut self, title: &str, snap: &mut Snapshot) {
        snap.threads.retain(|(k, _)| k != title);
        snap.extra.chats.retain(|c| c.title != title);
        if let Some(id) = self.id_of(title) {
            self.sessions.retain(|s| s.id != id);
            self.named.retain(|_, v| *v != id);
            self.spawn(move |c| c.delete(&format!("/session/{id}")).err().map(|e| Msg::Status(format!("delete failed: {e}"))));
        }
    }

    fn take_project(&mut self) -> Option<String> {
        self.open_project.take()
    }

    fn agents_op(&mut self, op: crate::subagents::Op, _snap: &mut Snapshot) {
        use crate::subagents::Op;
        let agent = match &op { Op::Send(id, _) | Op::Stop(id) | Op::Remove(id) => id.clone(), _ => String::new() };
        let (path, body) = match op {
            Op::Send(id, text) => ("/ext/agents/send", json!({ "id": id, "text": text })),
            Op::Stop(id) => ("/ext/agents/stop", json!({ "id": id })),
            Op::Remove(id) => ("/ext/agents/remove", json!({ "id": id })),
            Op::Team(team, text) => ("/ext/agents/team", json!({ "swarmId": team, "text": text })),
            Op::Browser(req, ok, text) => ("/ext/agents/browser", json!({ "reqId": req, "ok": ok, "text": text })),
        };
        // What the engine turned down shows in that agent's log; the rest comes back as events.
        self.spawn(move |c| {
            let why = match c.post(path, body) {
                Ok(v) if v["ok"].as_bool() == Some(false) => v["error"].as_str().unwrap_or("It didn't go through.").to_owned(),
                Ok(_) => return None,
                Err(e) => e,
            };
            (!agent.is_empty()).then(|| Msg::Event(json!({ "type": "subagent_log", "agentId": agent, "entry": { "t": "sys", "text": why } })))
        });
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

    fn billing(&mut self, op: crate::model::BillingOp, snap: &mut Snapshot) {
        use crate::model::{BillingOp, Checkout, CheckoutState};
        match op {
            BillingOp::Load => self.refresh("billing"),
            BillingOp::Checkout(plan) => {
                snap.extra.billing.checkout = Some(Checkout { plan: plan.clone(), url: String::new(), state: CheckoutState::Opening });
                self.spawn(move |c| {
                    let v = c.post_for("/ext/billing/checkout", json!({ "plan": plan }), 45).unwrap_or_else(|e| json!({ "ok": false, "error": format!("The engine didn't answer: {e}") }));
                    Some(Msg::Checkout(plan, v))
                });
            }
            BillingOp::Reopen => {
                if let Some(c) = snap.extra.billing.checkout.as_ref().filter(|c| !c.url.is_empty()) {
                    self.open_url = Some(c.url.clone());
                }
            }
            BillingOp::Cancel => {
                snap.extra.billing.checkout = None;
                self.spawn(|c| c.post("/ext/billing/cancel", json!({})).err().map(|e| Msg::Status(format!("cancel failed: {e}"))));
            }
        }
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
        let text = if self.crlf.contains(path) { text.replace("\r\n", "\n").replace('\n', "\r\n") } else { text.to_owned() };
        let path = path.to_owned();
        self.spawn(move |c| c.put("/file", json!({ "path": path, "text": text })).err().map(|e| Msg::Status(format!("save failed: {e}"))));
    }

    fn edit_code(&mut self, file: &str, text: &str, instruction: &str, _snap: &mut Snapshot) {
        let (file, text, instruction) = (file.to_owned(), text.to_owned(), instruction.to_owned());
        self.spawn(move |c| {
            let v = c.post("/ext/code/edit", json!({ "path": file, "text": text, "instruction": instruction }))
                .unwrap_or_else(|e| json!({ "error": format!("The engine didn't answer: {e}") }));
            Some(Msg::Proposal(file, instruction, v))
        });
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
        let body = json!({ "approval": prefs.approval.name(), "effort": prefs.effort, "team": team, "coauthor": prefs.coauthor });
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
            let messages = v["session"]["messages"].as_array()?;
            let items = messages.iter().flat_map(items_from).collect();
            let limit = messages.last().and_then(limit_of);
            Some(Msg::Transcript { id, items, limit })
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
        self.send_files(to, text, &[], snap)
    }

    fn send_files(&mut self, to: &Target, text: &str, files: &[String], snap: &mut Snapshot) -> Result<(), String> {
        let text = text.to_owned();
        let files: Vec<String> = files.to_vec();
        match to {
            Target::Chat(title) => {
                let id = self.id_of(title).ok_or("That chat isn't on the engine yet.")?;
                self.spawn(move |c| c.post(&format!("/session/{id}/message"), json!({ "text": text, "files": files })).err().map(|e| Msg::Status(format!("send failed: {e}"))));
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
                    match c.post(&format!("/session/{id}/message"), json!({ "text": text, "files": files })) {
                        Ok(_) => Some(Msg::Created(id)),
                        Err(e) => Some(Msg::Status(format!("send failed: {e}"))),
                    }
                });
                Ok(())
            }
            // Wisp and each helper talk in a chat of their own, named after them, made on first use;
            // the code view's agent in one named after the project, made in its folder.
            Target::Wisp | Target::Agent(_) | Target::Project(_) | Target::AgentSession { .. } => {
                let name = match to {
                    Target::Agent(id) => snap.agent(id).map_or_else(|| id.clone(), |a| a.name.clone()),
                    Target::Project(title) | Target::AgentSession { title, .. } => title.clone(),
                    _ => "Wisp".to_owned(),
                };
                // Made in the project folder; the engine knows whose it is.
                let cwd = matches!(to, Target::Project(_)).then(|| snap.extra.project_path.clone()).filter(|p| !p.is_empty());
                let (kind, agent) = match to {
                    Target::Project(_) => ("code", String::new()),
                    Target::AgentSession { agent, .. } | Target::Agent(agent) => ("agent", snap.agent(agent).map_or_else(|| agent.clone(), |a| a.name.clone())),
                    _ => ("agent", "Wisp".to_owned()),
                };
                let known = self.named.get(&name).cloned().or_else(|| self.id_of(&name));
                let title = name.clone();
                self.spawn(move |c| {
                    let id = match known {
                        Some(id) => id,
                        None => {
                            let mut body = json!({ "title": title, "kind": kind, "agent": agent });
                            if let Some(cwd) = &cwd {
                                body["cwd"] = json!(cwd);
                            }
                            c.post("/session", body).ok()?["session"]["id"].as_str()?.to_owned()
                        }
                    };
                    match c.post(&format!("/session/{id}/message"), json!({ "text": text, "files": files })) {
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
mod mission_tests {
    use super::{agent_of, one_line, tool_words, item_from};

    #[test]
    fn old_steps_without_words_still_say_what_they_did() {
        assert_eq!(tool_words("edit"), "Edited a file");
        assert_eq!(tool_words("pwsh"), "Ran a command");
        assert_eq!(tool_words("dsh:read"), "Read a file");
        let old = serde_json::json!({ "kind": "tool", "name": "edit", "label": "", "ok": true });
        assert_eq!(item_from(&old), Some(crate::model::ThreadItem::Event { icon: "edit", text: "Edited a file".into(), detail: None }));
    }

    #[test]
    fn chats_belong_to_the_agent_they_name() {
        let team = crate::store::mock::sample().team;
        let mut t = team.clone();
        t.push(crate::model::Agent { id: "emma".into(), name: "Emma".into(), ..team[1].clone() });
        t.push(crate::model::Agent { id: "inbox-watch".into(), name: "Inbox Watch".into(), ..team[1].clone() });
        assert_eq!(agent_of("Emma: Check my LinkedIn (messages, connection requests", &t), "emma");
        assert_eq!(agent_of("Emma", &t), "emma");
        // "Inbox" is a whole agent of its own in the sample team, so it wins over "Inbox Watch".
        assert_eq!(agent_of("Inbox", &t), "inbox");
        assert_eq!(agent_of("Inbox Watch: morning check", &t), "inbox-watch");
        assert_eq!(agent_of("Fix the checkout crash", &t), "wisp");
    }

    #[test]
    fn previews_are_one_plain_line() {
        assert_eq!(one_line("I couldn't run today's check.\n\n- **Not connected:** Gmail", 90), "I couldn't run today's check. Not connected: Gmail");
    }
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
    fn the_free_limit_becomes_a_card_live_and_after_a_reload() {
        // As engine.mjs emits it (DSH turn, or Classic), and as it keeps it in the chat: a card
        // (extra.limits), not a notice in the transcript.
        let live = json!({ "type": "error", "error": "You've used...", "limited": true, "resetsAt": "2026-11-16T16:30:00Z", "resets": "4:30 PM" });
        assert_eq!(limit_of(&live).as_deref(), Some("4:30 PM"));
        assert_eq!(item_from_event(&live), None);
        let late = json!({ "type": "notice", "kind": "notice", "text": "x", "limited": true, "resets": "" });
        assert_eq!(limit_of(&late).as_deref(), Some(""));
        let stored = json!({ "kind": "notice", "level": "error", "text": "x", "limited": true, "resets": "4:30 PM" });
        assert_eq!(limit_of(&stored).as_deref(), Some("4:30 PM"));
        assert_eq!(item_from(&stored), None);
        assert_eq!(limit_of(&json!({ "kind": "assistant", "text": "hi", "limited": true })), None);
        // Any other error stays a plain notice.
        assert!(matches!(item_from_event(&json!({ "type": "error", "error": "Haze 2 took too long to answer." })), Some(ThreadItem::Event { icon: "help", .. })));
        assert!(matches!(item_from(&json!({ "kind": "notice", "text": "Stopped" })), Some(ThreadItem::Event { icon: "help", .. })));
    }

    #[test]
    fn billing_follows_the_account_and_the_checkout() {
        use crate::model::{Billing, CheckoutState};
        let mut b = Billing::default();
        billing_from(&mut b, &json!({ "ok": true, "signedIn": true, "plan": { "key": "free", "name": "Free", "models": [] },
            "free": { "used": 82, "limit": 100, "resets": "4:30 PM" }, "checkout": null }));
        assert_eq!(b.plan.as_ref().map(|p| (p.key.as_str(), p.paid())), Some(("free", false)));
        assert_eq!(b.free.as_ref().map(|f| (f.used, f.limit, f.resets.as_str())), Some((82, 100, "4:30 PM")));
        // A checkout being made isn't wiped by a load that doesn't know it yet.
        b.checkout = Some(crate::model::Checkout { plan: "starter".into(), url: String::new(), state: CheckoutState::Opening });
        billing_from(&mut b, &json!({ "ok": true, "signedIn": true, "checkout": null }));
        assert!(b.checkout.is_some());
        // The engine's event when it's paid.
        billing_from(&mut b, &json!({ "type": "billing", "ok": true, "signedIn": true, "plan": { "key": "starter", "name": "Pro", "models": ["Claude Opus 5.5"] },
            "checkout": { "plan": "starter", "url": "https://whop.com/checkout/x", "state": "done", "error": "" } }));
        assert_eq!(b.checkout.as_ref().map(|c| c.state.clone()), Some(CheckoutState::Done));
        assert!(b.plan.as_ref().is_some_and(|p| p.paid() && p.name == "Pro"));
        let mut snap = Snapshot::default();
        snap.extra.billing = b.clone();
        plan_label(&mut snap);
        assert_eq!(snap.plan, "Pro plan");
        // Ran out of time, and signed out.
        billing_from(&mut b, &json!({ "ok": true, "checkout": { "plan": "pro", "url": "u", "state": "expired", "error": "We didn't hear back" } }));
        assert!(matches!(&b.checkout, Some(c) if matches!(&c.state, CheckoutState::Failed(e) if e.starts_with("We didn't"))));
        billing_from(&mut b, &json!({ "ok": true, "signedIn": false, "plan": null }));
        assert!(b.signed_out && b.plan.is_none());
        billing_from(&mut b, &json!({ "ok": false, "error": "Couldn't reach Codeply" }));
        assert_eq!(b.error, "Couldn't reach Codeply");
    }

    #[test]
    fn pull_requests_and_this_branch_come_from_the_engine() {
        let v = json!({
            "repo": true, "gh": { "ok": true, "error": "" },
            "local": { "branch": "feature", "base": "main", "files": 2, "add": 3, "del": 1, "author": "Sam", "pr": 0,
                "commits": [{ "sha": "2ab41db", "subject": "change f", "when": "1 hour ago", "author": "Sam" }] },
            "prs": [
                { "number": 12, "title": "Fix login", "state": "OPEN", "by": "ana", "branch": "fix", "age": "2h", "add": 10, "del": 2,
                  "url": "https://github.com/o/r/pull/12", "body": "Fixes it.", "checks": { "total": 3, "passed": 2, "failed": 1, "pending": 0 }, "reviewers": ["sam"] },
                { "number": 11, "title": "Old", "state": "CLOSED", "by": "ana", "branch": "old", "age": "9d", "checks": { "total": 0 } },
                { "number": 10, "title": "Shipped", "state": "MERGED", "by": "sam", "branch": "ship", "age": "3d", "checks": { "total": 0 } }
            ]
        });
        let prs = prs_from(&v);
        assert_eq!(prs.iter().map(|p| p.number).collect::<Vec<_>>(), [0, 12, 10]);
        assert!(prs[0].local && prs[0].title == "Changes on feature" && prs[0].summary.contains("change f"));
        assert_eq!(prs[1].checks, Some((2, 1, 0)));
        assert_eq!(prs[1].url, "https://github.com/o/r/pull/12");
        assert_eq!(prs[2].state, crate::model::PrState::Merged);
        assert_eq!(prs[2].checks, None);
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
        let s = |id: &str, title: &str, cwd: &str| Session { id: id.into(), title: title.into(), cwd: cwd.into(), updated: 0, preview: String::new(), running: false, kind: String::new(), agent: String::new() };
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
