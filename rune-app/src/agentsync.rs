//! The agent features the phone has, on the PC, from the same account data:
//!
//! - each specialist's full record (`GET /ext/agentsync/specialists`): instructions, house rules,
//!   voice, Always on, its face (shape, colour, gear) and its standing jobs;
//! - job reports (`job_report`), which also land in the job's chat, and reminders coming due
//!   (`reminder_due`), shown in the bell and as desktop notifications;
//! - the reminders list (`GET /ext/reminders`, `sidecar/ext-reminders.mjs`);
//! - each run's health (`run_health`, CONTRACTS.md): running, retrying, parked, continued, resumed
//!   in the cloud, needs you.
//!
//! The views read `Snapshot.extra.agents`; the stores fill it.

use serde_json::Value;

use crate::model::{Gear, Shape, Snapshot};

/// One specialist as the account keeps it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Spec {
    pub id: String,
    pub name: String,
    pub focus: String,
    /// Its system prompt (made ones), or empty.
    pub instructions: String,
    /// House rules on top of a built-in one's guide.
    pub notes: String,
    pub voice: String,
    pub model: String,
    /// Runs its jobs on time even with the PC off (the server's timer takes them).
    pub always_on: bool,
    pub builtin: bool,
    pub shape: String,
    pub color: String,
    pub gear: Vec<String>,
}

impl Spec {
    /// Whether the account gave it a face: the engine sends blob and Codeply blue when none was set.
    pub fn has_face(&self) -> bool {
        let unset = (self.shape.is_empty() || self.shape == "blob") && (self.color.is_empty() || self.color.eq_ignore_ascii_case("#4a78e0"));
        !unset || !self.gear.is_empty()
    }
}

/// A reminder, the same ones the phone sets.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Reminder {
    pub id: String,
    pub text: String,
    /// ISO time.
    pub due_at: String,
    /// call, remind or task.
    pub kind: String,
    /// daily, weekdays, weekly or empty.
    pub repeat: String,
    /// pending, snoozed, sent, done.
    pub status: String,
    pub bot: String,
    pub upcoming: bool,
    pub sent_at: String,
}

/// A job report or a reminder that came due, for the bell (newest first).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Report {
    /// The chat it landed in (engine id) and its title when known.
    pub chat_id: String,
    pub chat: String,
    pub who: String,
    pub ok: bool,
    pub text: String,
    /// Where it ran: "PC", "Cloud" or "Phone" (empty when unknown).
    pub origin: String,
    /// ms since the epoch.
    pub at: u64,
    /// A reminder rather than a job report.
    pub reminder: bool,
}

/// What a run is doing (CONTRACTS.md "Run health").
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Health {
    pub run: String,
    pub agent: String,
    pub chat_id: String,
    /// The chat's title, when the store knows it (the chat shows the line above its composer).
    pub chat: String,
    /// running, retrying, parked, continued, cloud, needs_you, done, failed.
    pub state: String,
    pub attempt: u32,
    pub part: u32,
    /// ISO time it waits until (retrying, parked).
    pub until: String,
    pub reason: String,
    /// "pc" or "cloud".
    pub place: String,
    /// When it arrived (ms since the epoch); 0 when it was read from a job's record.
    pub at: u64,
}

impl Health {
    /// Whether it still says something worth showing (done and plain running say nothing).
    pub fn notable(&self) -> bool {
        matches!(self.state.as_str(), "retrying" | "parked" | "continued" | "cloud" | "needs_you" | "failed")
    }
    pub fn needs_you(&self) -> bool {
        self.state == "needs_you"
    }
    /// One short line: "Retrying (attempt 2) at 10:20", "Paused until 23:00", "Needs you: ...".
    pub fn line(&self) -> String {
        let until = clock(&self.until);
        let at = |w: &str| if until.is_empty() { String::new() } else { format!(" {w} {until}") };
        match self.state.as_str() {
            "running" => if self.place == "cloud" { "Working in the cloud".into() } else { "Working".into() },
            // Short enough for a sidebar row: "Retrying, try 2 at 9:25 PM".
            "retrying" => match (self.attempt > 1, until.is_empty()) {
                (true, false) => format!("Retrying, try {} at {until}", self.attempt),
                (true, true) => format!("Retrying (attempt {})", self.attempt),
                (false, _) => format!("Retrying{}", at("at")),
            },
            "parked" => format!("Paused{}", if until.is_empty() { ", waiting for the limit to reset".into() } else { at("until") }),
            "continued" => format!("Kept going (part {})", self.part.max(2)),
            "cloud" => "Resumed in the cloud".into(),
            "needs_you" => if self.reason.is_empty() { "Needs you".into() } else { format!("Needs you: {}", self.reason) },
            "failed" => if self.reason.is_empty() { "Didn't finish".into() } else { format!("Didn't finish: {}", self.reason) },
            "done" => "Done".into(),
            other => other.to_owned(),
        }
    }
    /// The icon beside the line.
    pub fn icon(&self) -> &'static str {
        match self.state.as_str() {
            "retrying" | "continued" => "refresh",
            "parked" => "clock",
            "cloud" => "oai-cloud",
            "needs_you" => "approve-ask",
            "failed" => "alert",
            _ => "history",
        }
    }
}

/// Everything above, as `Snapshot.extra.agents` holds it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AgentsData {
    pub specs: Vec<Spec>,
    pub reminders: Vec<Reminder>,
    /// Why reminders can't be listed ("Sign in to Codeply to use reminders."), or empty.
    pub reminders_note: String,
    pub reminders_loaded: bool,
    pub reports: Vec<Report>,
    /// Latest health per run id ("job:<id>", a chat's run id), newest first.
    pub health: Vec<Health>,
    /// Desktop notifications waiting to be shown: (title, body). The app takes them.
    pub notify: Vec<(String, String)>,
    /// Each job's live state from `/ext/team`: (job id, running, needs you).
    pub jobs: Vec<(String, bool, String)>,
    /// Each job's whole task (the loop's name is its first line): (job id, task).
    pub tasks: Vec<(String, String)>,
    /// Chat sync with the phone: on, off, setup, error, waiting (empty until known).
    pub sync_state: String,
    /// A specialist just made, whose editor should open for a look at what Codeply wrote.
    pub created: Option<String>,
    /// A reminder the engine turned down (what, when): the form gets it back to fix.
    pub add_failed: Option<(String, String)>,
}

impl AgentsData {
    pub fn spec(&self, id: &str) -> Option<&Spec> {
        self.specs.iter().find(|s| s.id == id)
    }
    /// The newest health of an agent's runs that says something.
    pub fn health_of(&self, agent: &str) -> Option<&Health> {
        self.health.iter().find(|h| h.agent == agent && h.notable())
    }
    /// The health of the run in a chat (by title) that says something.
    pub fn chat_health(&self, chat: &str) -> Option<&Health> {
        self.health.iter().find(|h| !h.chat.is_empty() && h.chat == chat && h.notable())
    }
    /// A job's health, by job id.
    pub fn job_health(&self, job: &str) -> Option<&Health> {
        let run = format!("job:{job}");
        self.health.iter().find(|h| h.run == run && h.notable())
    }
    /// A job's whole task.
    pub fn jobs_task(&self, job: &str) -> Option<String> {
        self.tasks.iter().find(|(id, _)| id == job).map(|(_, t)| t.clone()).filter(|t| !t.trim().is_empty())
    }
    /// Upcoming reminders, soonest first.
    pub fn upcoming(&self) -> impl Iterator<Item = &Reminder> {
        self.reminders.iter().filter(|r| r.upcoming)
    }
}

fn s(v: &Value, k: &str) -> String {
    match &v[k] {
        Value::String(x) => x.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// The engine's shape names (wisp.js SHAPES) as the mascots this app draws.
pub fn shape_of(name: &str) -> Shape {
    match name {
        "circle" => Shape::Round,
        "square" => Shape::Square,
        "hexagon" => Shape::Hex,
        "triangle" | "spiky" => Shape::Triangle,
        "cloud" => Shape::Cloud,
        "star" => Shape::Drop,
        _ => Shape::Pebble,
    }
}

/// A mascot's shape as the account stores it (the phone draws the same family).
pub fn account_shape(shape: Shape) -> &'static str {
    match shape {
        Shape::Round => "circle",
        Shape::Square => "square",
        Shape::Hex => "hexagon",
        Shape::Triangle => "triangle",
        Shape::Cloud => "cloud",
        Shape::Drop => "star",
        Shape::Pebble => "blob",
    }
}

/// The account's gear names (wisp.js) as the accessories this app draws. Unknown ones are skipped.
pub fn gear_of(name: &str) -> Option<Gear> {
    Some(match name {
        "beret" => Gear::Beret,
        "bow" => Gear::Bow,
        "headphones" => Gear::Headphones,
        "glasses" => Gear::Glasses,
        "shades" => Gear::Shades,
        "sprout" => Gear::Sprout,
        "flower" => Gear::Flower,
        "star" | "crown" => Gear::Star,
        "cap" => Gear::Cap,
        "antennae" => Gear::Antennae,
        _ => return None,
    })
}

/// `gear` is a name, a list of names, `{ head, face }` or null.
fn gear_list(v: &Value) -> Vec<String> {
    match v {
        Value::String(x) if !x.is_empty() => vec![x.clone()],
        Value::Array(a) => a.iter().filter_map(|g| g.as_str().map(str::to_owned)).collect(),
        Value::Object(o) => o.values().filter_map(|g| g.as_str().filter(|g| !g.is_empty()).map(str::to_owned)).collect(),
        _ => Vec::new(),
    }
}

/// Reads `GET /ext/agentsync/specialists`, and gives each agent on screen its account face.
pub fn apply_specs(snap: &mut Snapshot, v: &Value) {
    let Some(list) = v["specialists"].as_array() else { return };
    snap.extra.agents.specs = list.iter().map(spec_from).filter(|x| !x.id.is_empty()).collect();
    dress(snap);
}

/// A specialist just made (`/ext/team/create`'s `specialist`): kept at once, so its editor opens
/// with what Codeply wrote for it, and marked to open.
pub fn created(snap: &mut Snapshot, m: &Value) {
    let spec = spec_from(m);
    if spec.id.is_empty() {
        return;
    }
    let x = &mut snap.extra.agents;
    x.specs.retain(|o| o.id != spec.id);
    x.created = Some(spec.id.clone());
    x.specs.push(spec);
    dress(snap);
}

fn spec_from(m: &Value) -> Spec {
    Spec {
        id: s(m, "id"),
        name: s(m, "name"),
        focus: s(m, "focus"),
        instructions: s(m, "instructions"),
        notes: s(m, "notes"),
        voice: s(m, "voice"),
        model: s(m, "model"),
        always_on: m["alwaysOn"].as_bool().unwrap_or(false),
        builtin: m["builtin"].as_bool().unwrap_or(false),
        shape: s(m, "shape"),
        color: s(m, "color"),
        gear: gear_list(&m["gear"]),
    }
}

/// Puts each specialist's account face (shape, colour, gear) on its agent, so the PC shows the
/// faces the phone shows.
pub fn dress(snap: &mut Snapshot) {
    for spec in &snap.extra.agents.specs {
        let Some(a) = snap.team.iter_mut().find(|a| a.id == spec.id) else { continue };
        if a.id == "wisp" {
            continue;
        }
        if !spec.has_face() {
            continue;
        }
        if !spec.shape.is_empty() {
            a.look.shape = shape_of(&spec.shape);
        }
        if spec.color.starts_with('#') && spec.color.len() == 7 {
            a.color = spec.color.clone();
        }
        let gear: Vec<Gear> = spec.gear.iter().filter_map(|g| gear_of(g)).take(2).collect();
        if !gear.is_empty() || !spec.gear.is_empty() {
            a.look.gear = gear;
        }
    }
}

/// Reads `/ext/team`'s jobs' live fields.
pub fn apply_jobs(snap: &mut Snapshot, v: &Value) {
    snap.extra.agents.jobs = v["jobs"].as_array().map(Vec::as_slice).unwrap_or_default().iter()
        .map(|j| (s(j, "id"), j["running"].as_bool().unwrap_or(false), s(j, "needsYou")))
        .filter(|(id, ..)| !id.is_empty()).collect();
    snap.extra.agents.tasks = v["jobs"].as_array().map(Vec::as_slice).unwrap_or_default().iter()
        .map(|j| (s(j, "id"), s(j, "task"))).filter(|(id, _)| !id.is_empty()).collect();
    // Health survives a restart: a job that failed or waits for you says so from its own record
    // (failures, needsYou, nextAt), until a live run_health event says more. A record that is fine
    // again drops what was read from it before.
    if let Some(jobs) = v["jobs"].as_array() {
        let x = &mut snap.extra.agents;
        for j in jobs {
            let run = format!("job:{}", s(j, "id"));
            let live = x.health.iter().any(|h| h.run == run && h.at > 0);
            if live {
                continue;
            }
            x.health.retain(|h| h.run != run);
            let (needs, failures, error) = (s(j, "needsYou"), j["failures"].as_u64().unwrap_or(0), s(j, "lastError"));
            let until = j["nextAt"].as_u64().filter(|_| failures > 0).map(|ms| iso_of(ms)).unwrap_or_default();
            let state = if !needs.is_empty() { "needs_you" } else if failures > 0 && !error.is_empty() { "retrying" } else { continue };
            x.health.push(Health {
                run, agent: s(j, "specialist"), chat_id: s(j, "sessionId"), state: state.into(), attempt: failures as u32, until,
                reason: if needs.is_empty() { error } else { needs }, place: "pc".into(), at: 0, ..Default::default()
            });
        }
    }
    // A job that was cancelled, or an agent taken off the team, no longer needs you.
    if v["jobs"].is_array() {
        let x = &mut snap.extra.agents;
        let jobs: Vec<String> = x.tasks.iter().map(|(id, _)| format!("job:{id}")).collect();
        let team: Vec<&str> = snap.team.iter().map(|a| a.id.as_str()).collect();
        x.health.retain(|h| (!h.run.starts_with("job:") || jobs.contains(&h.run)) && (h.agent.is_empty() || team.contains(&h.agent.as_str())));
    }
}

/// Reads `GET /ext/reminders`.
pub fn apply_reminders(snap: &mut Snapshot, v: &Value) {
    let x = &mut snap.extra.agents;
    x.reminders_loaded = true;
    x.reminders_note = s(v, "error");
    if v["ok"] == false && v["retry"].is_object() {
        x.add_failed = Some((s(&v["retry"], "text"), s(&v["retry"], "when")));
    }
    if x.reminders_note.is_empty() && v["signedIn"] == false {
        x.reminders_note = "Sign in to Codeply to see your reminders. They are the same ones your phone has.".into();
    }
    if let Some(list) = v["reminders"].as_array() {
        x.reminders = list.iter().map(reminder_from).filter(|r| !r.id.is_empty()).collect();
    }
}

fn reminder_from(r: &Value) -> Reminder {
    Reminder {
        id: s(r, "id"),
        text: s(r, "text"),
        due_at: s(r, "dueAt"),
        kind: s(r, "kind"),
        repeat: s(r, "repeat"),
        status: s(r, "status"),
        bot: s(r, "botName"),
        upcoming: r["upcoming"].as_bool().unwrap_or(false),
        sent_at: s(r, "sentAt"),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn origin_word(o: &str) -> String {
    match o.to_ascii_lowercase().as_str() {
        "pc" | "desktop" => "PC".into(),
        "cloud" | "server" | "tick" => "Cloud".into(),
        "phone" | "mobile" => "Phone".into(),
        _ => String::new(),
    }
}

/// Folds `job_report`, `reminder_due` and `run_health`. `title` names a chat by its engine id.
/// True when it took the event.
pub fn fold(x: &mut AgentsData, e: &Value, title: &dyn Fn(&str) -> Option<String>) -> bool {
    match e["type"].as_str().unwrap_or_default() {
        "job_report" => {
            let chat_id = s(e, "chatId");
            let ok = e["ok"].as_bool().unwrap_or(true);
            let who = s(e, "specialist");
            let text = s(e, "text");
            let at = e["at"].as_u64().or_else(|| e["at"].as_str().and_then(parse_iso)).unwrap_or_else(now_ms);
            let report = Report { chat: title(&chat_id).unwrap_or_default(), chat_id, who: who.clone(), ok, text: text.clone(), origin: origin_word(&s(e, "origin")), at, reminder: false };
            if x.reports.iter().any(|r| r.chat_id == report.chat_id && r.at == report.at && r.who == report.who) {
                return true;
            }
            x.reports.insert(0, report);
            x.reports.truncate(30);
            let head = if ok { format!("{who}: standing job done") } else { format!("{who}: the job did not finish") };
            x.notify.push((head, first_line(&text)));
            true
        }
        "reminder_due" => {
            let r = reminder_from(&e["reminder"]);
            if r.id.is_empty() {
                return true;
            }
            let who = if r.bot.is_empty() { "Codeply".to_owned() } else { r.bot.clone() };
            x.reports.insert(0, Report { who: who.clone(), ok: true, text: r.text.clone(), at: now_ms(), reminder: true, ..Default::default() });
            x.reports.truncate(30);
            x.notify.push((format!("Reminder from {who}"), r.text.clone()));
            if let Some(m) = x.reminders.iter_mut().find(|m| m.id == r.id) {
                *m = r;
            }
            true
        }
        "run_health" => {
            let h = Health {
                run: s(e, "runId"),
                agent: s(e, "agent"),
                chat_id: s(e, "chatId"),
                chat: title(&s(e, "chatId")).unwrap_or_default(),
                state: s(e, "state"),
                attempt: e["attempt"].as_u64().unwrap_or(0) as u32,
                part: e["part"].as_u64().unwrap_or(0) as u32,
                until: s(e, "until"),
                reason: s(e, "reason"),
                place: s(e, "where"),
                at: now_ms(),
            };
            if h.run.is_empty() && h.agent.is_empty() {
                return true;
            }
            let key = if h.run.is_empty() { format!("agent:{}", h.agent) } else { h.run.clone() };
            x.health.retain(|o| (if o.run.is_empty() { format!("agent:{}", o.agent) } else { o.run.clone() }) != key);
            if h.needs_you() {
                let who = if h.agent.is_empty() { "An agent".to_owned() } else { h.agent.clone() };
                x.notify.push((format!("{who} needs you"), h.reason.clone()));
            }
            x.health.insert(0, h);
            x.health.truncate(40);
            true
        }
        _ => false,
    }
}

fn first_line(t: &str) -> String {
    let line = t.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with("-# ")).unwrap_or_default();
    let mut out: String = line.chars().take(140).collect();
    if line.chars().count() > 140 {
        out.push_str("...");
    }
    out
}

// ---------- time ----------

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// An ISO 8601 time ("2026-11-21T23:00:00Z", "...+05:00", "....123Z") as ms since the epoch.
pub fn parse_iso(t: &str) -> Option<u64> {
    let t = t.trim();
    if t.len() < 16 {
        return None;
    }
    let n = |a: usize, b: usize| t.get(a..b).and_then(|x| x.parse::<i64>().ok());
    let (y, mo, d, h, mi) = (n(0, 4)?, n(5, 7)?, n(8, 10)?, n(11, 13)?, n(14, 16)?);
    // Seconds and a fraction are optional ("T23:05Z", "T23:05:09.123+05:30").
    let mut rest = t.get(16..).unwrap_or("");
    let mut sec = 0;
    if let Some(r) = rest.strip_prefix(':') {
        sec = r.get(..2).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
        rest = r.get(2..).unwrap_or("").trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    }
    // The offset: "+05", "+0530" or "+05:30" (or Z, or none: UTC).
    let offset = match rest.chars().next() {
        Some(c @ ('+' | '-')) => {
            let digits: String = rest[1..].chars().filter(char::is_ascii_digit).take(4).collect();
            let hh = digits.get(..2).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
            let mm = digits.get(2..4).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
            (hh * 60 + mm) * if c == '-' { -1 } else { 1 }
        }
        _ => 0,
    };
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + sec - offset * 60;
    u64::try_from(secs).ok().map(|s| s * 1000)
}

/// The local offset from UTC in minutes, as the engine reports it at launch, else UTC.
static OFFSET: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(i64::MIN);

pub fn set_utc_offset(minutes: i64) {
    OFFSET.store(minutes, std::sync::atomic::Ordering::Relaxed);
}

fn offset_min() -> i64 {
    match OFFSET.load(std::sync::atomic::Ordering::Relaxed) {
        i64::MIN => 0,
        m => m,
    }
}

/// (days since epoch, minutes into the day) in local time.
fn local(ms: u64) -> (i64, i64) {
    let mins = (ms / 60_000) as i64 + offset_min();
    (mins.div_euclid(1440), mins.rem_euclid(1440))
}

fn hm(mins: i64) -> String {
    let (h, m) = (mins / 60, mins % 60);
    let h12 = if h % 12 == 0 { 12 } else { h % 12 };
    format!("{h12}:{m:02} {}", if h < 12 { "AM" } else { "PM" })
}

/// A time as a clock ("10:20 PM"), or with its day when it isn't today ("Tomorrow 9:00 AM").
pub fn clock(iso: &str) -> String {
    parse_iso(iso).map(|ms| when_label(ms, now_ms())).unwrap_or_default()
}

const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// The phone's "When": "Today 5:00 PM", "Tomorrow 9:00 AM", "Wed 9:00 AM" within 6 days, else
/// "Mar 14, 9:00 AM". Today's times read just "5:00 PM".
pub fn when_label(ms: u64, now: u64) -> String {
    let (day, mins) = local(ms);
    let (today, _) = local(now);
    match day - today {
        0 => hm(mins),
        1 => format!("Tomorrow {}", hm(mins)),
        -1 => format!("Yesterday {}", hm(mins)),
        2..=6 => format!("{} {}", DAYS[day.rem_euclid(7) as usize], hm(mins)),
        _ => {
            let (_, m, d) = civil_from_days(day);
            format!("{} {d}, {}", MONTHS[(m - 1) as usize], hm(mins))
        }
    }
}

/// "just now", "4 min ago", "3 h ago", "2 d ago".
pub fn ago(ms: u64, now: u64) -> String {
    let secs = now.saturating_sub(ms) / 1000;
    match secs {
        0..=59 => "just now".into(),
        60..=3599 => format!("{} min ago", secs / 60),
        3600..=86_399 => format!("{} h ago", secs / 3600),
        _ => format!("{} d ago", secs / 86_400),
    }
}

/// The small line under a reminder: "Wisp · Today 5:00 PM · Call · Every day · Snoozed".
pub fn reminder_line(r: &Reminder, now: u64) -> String {
    let mut parts = vec![if r.bot.is_empty() { "Codeply".to_owned() } else { r.bot.clone() }];
    if let Some(ms) = parse_iso(&r.due_at) {
        parts.push(when_label(ms, now));
    }
    parts.push(match r.kind.as_str() { "call" => "Call", "task" => "Task", _ => "Reminder" }.to_owned());
    match r.repeat.as_str() {
        "daily" => parts.push("Every day".into()),
        "weekdays" => parts.push("Weekdays".into()),
        "weekly" => parts.push("Every week".into()),
        _ => {}
    }
    if r.status == "snoozed" {
        parts.push("Snoozed".into());
    }
    parts.join(" · ")
}

/// What happened to a reminder that's past: "Called you", "Texted you", "Started your task".
pub fn done_word(r: &Reminder) -> &'static str {
    match r.kind.as_str() {
        "call" => "Called you",
        "task" => "Started your task",
        _ => "Texted you",
    }
}

/// ms since the epoch as an ISO time (UTC).
pub fn iso_of(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let r = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", r / 3600, (r % 3600) / 60, r % 60)
}

/// The sample data: a few reminders and reports, so the sample store and the snapshots show them.
pub fn sample() -> AgentsData {
    let now = now_ms();
    let iso = iso_of;
    let rem = |id: &str, text: &str, due: u64, kind: &str, repeat: &str, bot: &str, status: &str| Reminder {
        id: id.into(), text: text.into(), due_at: iso(due), kind: kind.into(), repeat: repeat.into(), status: status.into(), bot: bot.into(),
        upcoming: status == "pending" || status == "snoozed", sent_at: String::new(),
    };
    AgentsData {
        specs: vec![
            Spec { id: "inbox".into(), name: "Inbox".into(), focus: "Keeps your inbox at zero".into(), instructions: "You look after the user's email. Sort, archive and draft replies; never send without a yes.".into(), always_on: true, ..Default::default() },
            Spec { id: "frontend".into(), name: "Frontend".into(), focus: "Frontend".into(), builtin: true, notes: "Keep it short. Never touch the payments folder.".into(), ..Default::default() },
            Spec { id: "backend".into(), name: "Backend".into(), focus: "Backend & API".into(), builtin: true, ..Default::default() },
            Spec { id: "docs".into(), name: "Docs".into(), focus: "Docs".into(), builtin: true, ..Default::default() },
            Spec { id: "research".into(), name: "Research".into(), focus: "Finds places, prices and facts".into(), instructions: "You research what the user asks: venues, prices, facts. Cite where each fact came from.".into(), ..Default::default() },
        ],
        reminders: vec![
            rem("r1", "Call mom", now + 95 * 60_000, "call", "", "Wisp", "pending"),
            rem("r2", "Stand-up notes for the launch", now + 26 * 3_600_000, "remind", "weekdays", "Inbox", "pending"),
            rem("r3", "Water the plants", now + 3 * 86_400_000, "remind", "weekly", "Codeply", "snoozed"),
            rem("r0", "Check the deploy", now - 2 * 3_600_000, "remind", "", "Backend", "sent"),
        ],
        reports: vec![
            Report { chat: "Inbox cleanup".into(), who: "Inbox".into(), ok: true, text: "Archived 41 newsletters, 2 drafts wait for your yes.".into(), origin: "Cloud".into(), at: now - 50 * 60_000, ..Default::default() },
        ],
        health: vec![
            Health { run: "job:sample-Review new pull requests".into(), agent: "backend".into(), chat: "Backend".into(), state: "retrying".into(), attempt: 2, until: iso(now + 20 * 60_000), reason: "The model was busy.".into(), place: "pc".into(), at: now, ..Default::default() },
            Health { run: "job:sample-Triage production errors".into(), agent: "research".into(), state: "needs_you".into(), reason: "Sentry asks you to sign in again".into(), place: "pc".into(), at: now, ..Default::default() },
        ],
        reminders_loaded: true,
        sync_state: "on".into(),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn iso_times_parse_and_read_like_the_phone() {
        let ms = parse_iso("2026-11-21T23:05:00Z").unwrap();
        assert_eq!(ms, parse_iso("2026-11-22T04:05:00+05:00").unwrap());
        assert_eq!(parse_iso("2026-11-21T23:05:00.123Z").unwrap(), ms);
        assert_eq!(parse_iso("2026-11-21T23:05Z").unwrap(), ms);
        assert_eq!(parse_iso("2026-11-22T04:05+05").unwrap(), ms);
        assert_eq!(parse_iso("2026-11-22T04:35:00+0530").unwrap(), ms);
        assert_eq!(parse_iso("2026-11-21T20:05:00-03:00").unwrap(), ms);
        set_utc_offset(0);
        assert_eq!(when_label(ms, ms - 3_600_000), "11:05 PM");
        assert_eq!(when_label(ms + 86_400_000, ms), "Tomorrow 11:05 PM");
        assert_eq!(when_label(ms + 3 * 86_400_000, ms), "Tue 11:05 PM");
        assert_eq!(when_label(ms + 30 * 86_400_000, ms), "Dec 21, 11:05 PM");
        assert_eq!(ago(ms - 5 * 60_000, ms), "5 min ago");
    }

    #[test]
    fn health_events_keep_the_latest_per_run_and_ask_to_notify() {
        let mut x = AgentsData::default();
        let none = |_: &str| None;
        assert!(fold(&mut x, &json!({ "type": "run_health", "runId": "job:j1", "agent": "inbox", "state": "retrying", "attempt": 2, "reason": "busy" }), &none));
        assert_eq!(x.job_health("j1").unwrap().line(), "Retrying (attempt 2)");
        fold(&mut x, &json!({ "type": "run_health", "runId": "job:j1", "agent": "inbox", "state": "needs_you", "reason": "Gmail wants a new sign-in" }), &none);
        assert_eq!(x.health.len(), 1);
        assert_eq!(x.health_of("inbox").unwrap().line(), "Needs you: Gmail wants a new sign-in");
        assert_eq!(x.notify.len(), 1);
        fold(&mut x, &json!({ "type": "run_health", "runId": "job:j1", "agent": "inbox", "state": "done" }), &none);
        assert!(x.health_of("inbox").is_none());
    }

    #[test]
    fn a_jobs_record_gives_its_health_after_a_restart() {
        let mut snap = crate::store::mock::sample();
        snap.extra.agents = AgentsData::default();
        let v = json!({ "jobs": [
            { "id": "j1", "specialist": "backend", "task": "Check PRs", "failures": 2, "lastError": "The model is overloaded.", "nextAt": 1_795_298_057_000u64, "needsYou": "" },
            { "id": "j2", "specialist": "inbox", "task": "Sort mail", "failures": 5, "lastError": "x", "needsYou": "Gmail wants a new sign-in" },
            { "id": "j3", "specialist": "docs", "task": "Changelog", "failures": 0, "lastError": "", "needsYou": "" }
        ] });
        apply_jobs(&mut snap, &v);
        let x = &snap.extra.agents;
        assert_eq!(x.job_health("j1").unwrap().state, "retrying");
        assert_eq!(x.job_health("j1").unwrap().attempt, 2);
        assert!(x.job_health("j1").unwrap().until.starts_with("2026-11-21T"));
        assert_eq!(x.job_health("j2").unwrap().line(), "Needs you: Gmail wants a new sign-in");
        assert!(x.job_health("j3").is_none());
        // Fine again: what was read before goes.
        apply_jobs(&mut snap, &json!({ "jobs": [{ "id": "j1", "specialist": "backend", "task": "Check PRs", "failures": 0 }] }));
        assert!(snap.extra.agents.job_health("j1").is_none());
    }

    #[test]
    fn reports_and_due_reminders_reach_the_bell_once() {
        let mut x = AgentsData::default();
        let title = |id: &str| (id == "c1").then(|| "Inbox cleanup".to_owned());
        let e = json!({ "type": "job_report", "chatId": "c1", "jobId": "j1", "specialist": "Inbox", "ok": true, "text": "-# Inbox · standing job\nArchived 41 newsletters.", "at": 1000, "origin": "cloud" });
        fold(&mut x, &e, &title);
        fold(&mut x, &e, &title);
        assert_eq!(x.reports.len(), 1);
        assert_eq!(x.reports[0].chat, "Inbox cleanup");
        assert_eq!(x.reports[0].origin, "Cloud");
        assert_eq!(x.notify, [("Inbox: standing job done".to_owned(), "Archived 41 newsletters.".to_owned())]);
        fold(&mut x, &json!({ "type": "reminder_due", "reminder": { "id": "r1", "text": "Call mom", "botName": "Wisp" } }), &title);
        assert_eq!(x.notify[1].0, "Reminder from Wisp");
    }

    #[test]
    fn account_faces_dress_the_team() {
        let mut snap = crate::store::mock::sample();
        apply_specs(&mut snap, &json!({ "specialists": [
            { "id": "frontend", "name": "Frontend", "shape": "cloud", "color": "#ff2fa8", "gear": { "head": "beret", "face": "glasses" }, "alwaysOn": true, "builtin": true }
        ] }));
        let a = snap.agent("frontend").unwrap();
        assert_eq!(a.look.shape, Shape::Cloud);
        assert_eq!(a.color, "#ff2fa8");
        assert_eq!(a.look.gear.len(), 2);
        assert!(snap.extra.agents.spec("frontend").unwrap().always_on);
    }

    #[test]
    fn reminders_list_reads_like_the_phone() {
        let mut snap = crate::store::mock::sample();
        apply_reminders(&mut snap, &json!({ "reminders": [
            { "id": "a", "text": "Call mom", "dueAt": "2026-11-21T17:00:00Z", "kind": "call", "repeat": "daily", "status": "snoozed", "botName": "Wisp", "upcoming": true }
        ], "signedIn": true, "error": "" }));
        set_utc_offset(0);
        let r = &snap.extra.agents.reminders[0];
        let now = parse_iso("2026-11-21T09:00:00Z").unwrap();
        assert_eq!(reminder_line(r, now), "Wisp · 5:00 PM · Call · Every day · Snoozed");
    }
}

/// A change to reminders or a specialist, as the store sends it to the engine.
#[derive(Clone, Debug, PartialEq)]
pub enum SyncOp {
    /// Reads reminders, specialists and sync again.
    Refresh,
    /// A new reminder: what, and when in plain words ("in 10 minutes", "at 5pm", "tomorrow at 9").
    AddReminder { text: String, when: String },
    CancelReminder(String),
    /// Snoozes a reminder by minutes.
    Snooze(String, u32),
    /// Changes a specialist: its id and the fields to change (`/ext/agentsync/specialists/update`).
    UpdateSpec(String, Value),
}

/// The sample store's version of a change.
pub fn apply_sample(op: &SyncOp, snap: &mut Snapshot) {
    let x = &mut snap.extra.agents;
    match op {
        SyncOp::Refresh => {}
        SyncOp::AddReminder { text, when } => {
            let n = x.reminders.len() + 1;
            x.reminders.insert(0, Reminder { id: format!("r-new-{n}"), text: text.clone(), due_at: String::new(), kind: "remind".into(), status: "pending".into(), bot: "Codeply".into(), upcoming: true, repeat: String::new(), sent_at: when.clone() });
        }
        SyncOp::CancelReminder(id) => x.reminders.retain(|r| r.id != *id),
        SyncOp::Snooze(id, _) => {
            if let Some(r) = x.reminders.iter_mut().find(|r| r.id == *id) {
                r.status = "snoozed".into();
            }
        }
        SyncOp::UpdateSpec(id, patch) => {
            let spec = match x.specs.iter().position(|s| s.id == *id) {
                Some(i) => &mut x.specs[i],
                None => {
                    x.specs.push(Spec { id: id.clone(), ..Default::default() });
                    x.specs.last_mut().expect("just pushed")
                }
            };
            patch_spec(spec, patch);
            let (name, focus) = (spec.name.clone(), spec.focus.clone());
            if let Some(a) = snap.team.iter_mut().find(|a| a.id == *id) {
                if !name.is_empty() {
                    a.name = name;
                }
                if !focus.is_empty() {
                    a.role = focus;
                }
            }
            dress(snap);
        }
    }
}

/// Applies an update's fields to a record (what the engine answers with, done ahead of it).
pub fn patch_spec(spec: &mut Spec, patch: &Value) {
    let str_of = |k: &str| patch[k].as_str().map(str::to_owned);
    if let Some(v) = str_of("name") { spec.name = v; }
    if let Some(v) = str_of("focus") { spec.focus = v; }
    if let Some(v) = str_of("instructions") { spec.instructions = v; }
    if let Some(v) = str_of("notes") { spec.notes = v; }
    if let Some(v) = str_of("voice") { spec.voice = v; }
    if let Some(v) = str_of("shape") { spec.shape = v; }
    if let Some(v) = str_of("color") { spec.color = v; }
    if let Some(v) = patch["alwaysOn"].as_bool() { spec.always_on = v; }
    if !patch["gear"].is_null() { spec.gear = gear_list(&patch["gear"]); }
}

/// A message that starts with `@Name` hands the chat to that agent, as on the phone: the agent's
/// id and the rest of the message. The longest name wins ("@Inbox Watch" over "@Inbox"), and
/// `@Codeply` or `@Wisp` goes back to Wisp.
pub fn lead_mention(team: &[crate::model::Agent], text: &str) -> Option<(String, String)> {
    let rest = text.strip_prefix('@')?;
    let lower = rest.to_lowercase();
    let mut names: Vec<(String, String)> = team.iter().map(|a| (a.id.clone(), a.name.to_lowercase())).collect();
    names.push(("wisp".into(), "codeply".into()));
    names.push(("wisp".into(), "wisp".into()));
    let (id, len) = names.into_iter()
        .filter(|(_, n)| !n.is_empty() && lower.starts_with(n.as_str()))
        .filter(|(_, n)| lower[n.len()..].chars().next().is_none_or(|c| !c.is_alphanumeric() && c != '-' && c != '_'))
        .max_by_key(|(_, n)| n.len())
        .map(|(id, n)| (id, n.len()))?;
    // Lowercasing can change byte lengths only outside ASCII; fall back to the char count then.
    let cut = if rest.is_char_boundary(len) && rest[..len].to_lowercase().len() == len { len } else { rest.char_indices().nth(len).map_or(rest.len(), |(i, _)| i) };
    let after = rest[cut..].trim_start_matches([',', ':']).trim().to_owned();
    Some((id, after))
}

#[cfg(test)]
mod mention_tests {
    use super::*;

    #[test]
    fn a_leading_at_name_hands_the_chat_over() {
        let snap = crate::store::mock::sample();
        assert_eq!(lead_mention(&snap.team, "@Inbox clear the newsletters"), Some(("inbox".into(), "clear the newsletters".into())));
        assert_eq!(lead_mention(&snap.team, "@frontend: fix the header"), Some(("frontend".into(), "fix the header".into())));
        assert_eq!(lead_mention(&snap.team, "@Codeply what's next"), Some(("wisp".into(), "what's next".into())));
        assert_eq!(lead_mention(&snap.team, "@Inbox"), Some(("inbox".into(), String::new())));
        assert_eq!(lead_mention(&snap.team, "@Inboxer hi"), None);
        assert_eq!(lead_mention(&snap.team, "ask @Inbox"), None);
    }
}
