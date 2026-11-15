//! Subagents: the background agents a chat's main agent started (sidecar/ext-agents.mjs). Each
//! has a name and a mascot of its own and belongs to one chat; Background tasks lists only the
//! open chat's. This module holds what the engine reports about them and folds its events.

use serde_json::Value;

use crate::model::{AgentState, Face, Gear, Look, Shape};

/// One line of an agent's log.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Line {
    pub id: String,
    /// "user" (a message to it), "text" (what it says), "think", "tool", "sys", "done".
    pub kind: String,
    /// For "user": who wrote it ("codeply" or "you").
    pub by: String,
    pub text: String,
    /// For "tool": the step ("Edit") and what it worked on ("index.html").
    pub name: String,
    pub arg: String,
    /// For "tool": "run", "ok" or "fail"; its first lines of output.
    pub status: String,
    pub out: String,
    /// For "done": whether it finished, and the files it changed.
    pub ok: bool,
    pub files: Vec<String>,
    /// For "user": sent while it worked.
    pub live: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Subagent {
    pub id: String,
    /// The chat it belongs to: the engine's id, and its title as last known.
    pub chat_id: String,
    pub chat: String,
    pub name: String,
    pub color: String,
    pub look: Look,
    /// "idle", "working", "done", "failed", "stopped".
    pub status: String,
    /// Its part, or the task it is on.
    pub task: String,
    /// The team it is on (empty when alone).
    pub swarm: String,
    /// It has its own browser tab.
    pub browser: bool,
    pub files: u32,
    pub log: Vec<Line>,
}

impl Subagent {
    pub fn working(&self) -> bool {
        self.status == "working"
    }
    /// How its mascot looks: busy while it works, asleep when stopped, worried when it failed.
    pub fn state(&self) -> AgentState {
        match self.status.as_str() {
            "working" => AgentState::Working,
            "stopped" => AgentState::Sleeping,
            "failed" => AgentState::Waiting,
            _ => AgentState::Idle,
        }
    }
    /// What it is doing right now, in a few words: its latest step or line.
    pub fn now(&self) -> String {
        if !self.working() {
            return match self.status.as_str() {
                "done" => "Done".into(),
                "failed" => "Did not finish".into(),
                "stopped" => "Stopped".into(),
                _ => "Ready".into(),
            };
        }
        for l in self.log.iter().rev() {
            match l.kind.as_str() {
                "tool" => return if l.arg.is_empty() { l.name.clone() } else { format!("{} {}", l.name, l.arg) },
                "text" => return first_sentence(&l.text),
                _ => {}
            }
        }
        "Starting".into()
    }
}

fn first_sentence(s: &str) -> String {
    let one = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let end = one.find(['.', '!', '?']).map_or(one.len(), |i| i + 1);
    one[..end].chars().take(110).collect()
}

/// A message on a team's channel.
#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    pub from: String,
    pub to: String,
    pub text: String,
}

/// A team: agents started together on one goal, sharing a channel.
#[derive(Clone, Debug, PartialEq)]
pub struct Team {
    pub id: String,
    pub chat_id: String,
    pub goal: String,
    pub members: Vec<String>,
    pub messages: Vec<Message>,
}

/// Something an agent asked its browser tab to do; the app does it and answers the engine.
#[derive(Clone, Debug, PartialEq)]
pub struct BrowserAsk {
    pub req: String,
    pub agent: String,
    pub name: String,
    pub color: String,
    pub look: Look,
    pub action: String,
    pub args: Value,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Subagents {
    pub agents: Vec<Subagent>,
    pub teams: Vec<Team>,
    /// Why agents can't start on this PC, if they can't.
    pub why: String,
    /// Browser actions waiting for the app.
    pub asks: Vec<BrowserAsk>,
    /// Agents that just started in a chat (by chat title), so the app can show them.
    pub started: Vec<String>,
}

impl Subagents {
    pub fn in_chat<'a>(&'a self, chat: &'a str) -> impl Iterator<Item = &'a Subagent> + 'a {
        self.agents.iter().filter(move |a| a.chat == chat)
    }
    pub fn team(&self, id: &str) -> Option<&Team> {
        self.teams.iter().find(|t| t.id == id)
    }
    pub fn agent(&self, id: &str) -> Option<&Subagent> {
        self.agents.iter().find(|a| a.id == id)
    }
}

/// What you do with an agent from Background tasks.
#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    Send(String, String),
    Stop(String),
    Remove(String),
    /// You, on a team's channel: (team id, text).
    Team(String, String),
    /// The app's answer to a browser action: (request, ok, text).
    Browser(String, bool, String),
}

// ---------- from the engine ----------

fn shape_of(name: &str) -> Shape {
    Shape::from_name(name).unwrap_or(Shape::Pebble)
}

fn gear_of(name: &str) -> Option<Gear> {
    Some(match name {
        "cap" => Gear::Cap,
        "headphones" => Gear::Headphones,
        "sprout" => Gear::Sprout,
        "antennae" => Gear::Antennae,
        "star" => Gear::Star,
        "flower" => Gear::Flower,
        "glasses" => Gear::Glasses,
        "shades" => Gear::Shades,
        "beret" => Gear::Beret,
        "bow" => Gear::Bow,
        _ => return None,
    })
}

pub fn look_of(shape: &str, gear: &str) -> Look {
    Look::new(shape_of(shape), Face::Pill, &gear_of(gear).into_iter().collect::<Vec<_>>())
}

fn color_of(v: &Value) -> String {
    v.as_str().filter(|c| c.starts_with('#') && c.len() == 7).unwrap_or("#4a78e0").to_owned()
}

fn str_of(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or_default().to_owned()
}

pub fn line_of(e: &Value) -> Line {
    Line {
        id: str_of(e, "id"),
        kind: str_of(e, "t"),
        by: str_of(e, "by"),
        text: str_of(e, "text"),
        name: str_of(e, "name"),
        arg: str_of(e, "arg"),
        status: str_of(e, "status"),
        out: str_of(e, "out"),
        ok: e["ok"].as_bool().unwrap_or(false),
        files: e["files"].as_array().map_or_else(Vec::new, |a| a.iter().filter_map(|f| f.as_str().map(str::to_owned)).collect()),
        live: e["live"].as_bool().unwrap_or(false),
    }
}

fn agent_of(v: &Value, title: &dyn Fn(&str) -> Option<String>, old: Option<&Subagent>) -> Option<Subagent> {
    let id = str_of(v, "id");
    if id.is_empty() {
        return None;
    }
    let chat_id = str_of(v, "chatId");
    let log = match v["log"].as_array() {
        Some(a) => a.iter().map(line_of).collect(),
        None => old.map(|o| o.log.clone()).unwrap_or_default(),
    };
    Some(Subagent {
        chat: title(&chat_id).or_else(|| old.map(|o| o.chat.clone())).unwrap_or_default(),
        chat_id,
        name: str_of(v, "name"),
        color: color_of(&v["color"]),
        look: look_of(v["shape"].as_str().unwrap_or_default(), v["gear"].as_str().unwrap_or_default()),
        status: str_of(v, "status"),
        task: str_of(v, "task"),
        swarm: str_of(v, "swarm"),
        browser: v["browser"].as_bool().unwrap_or(false),
        files: v["files"].as_u64().unwrap_or(0) as u32,
        log,
        id,
    })
}

fn message_of(m: &Value) -> Message {
    Message { from: str_of(m, "from"), to: str_of(m, "to"), text: str_of(m, "text") }
}

/// The whole list (`GET /ext/agents`). `title` turns a chat's engine id into its title.
pub fn apply(s: &mut Subagents, v: &Value, title: &dyn Fn(&str) -> Option<String>) {
    let old = std::mem::take(&mut s.agents);
    s.agents = v["agents"].as_array().map_or_else(Vec::new, |a| {
        a.iter().filter_map(|x| agent_of(x, title, old.iter().find(|o| o.id == str_of(x, "id")))).collect()
    });
    s.teams = v["swarms"].as_array().map_or_else(Vec::new, |a| {
        a.iter().map(|t| Team {
            id: str_of(t, "id"),
            chat_id: str_of(t, "chatId"),
            goal: str_of(t, "goal"),
            members: t["members"].as_array().map_or_else(Vec::new, |m| m.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()),
            messages: t["messages"].as_array().map_or_else(Vec::new, |m| m.iter().map(message_of).collect()),
        }).collect()
    });
    s.why = str_of(v, "why");
}

/// One live event. True when it was one of the agents'.
pub fn fold(s: &mut Subagents, e: &Value, title: &dyn Fn(&str) -> Option<String>) -> bool {
    match e["type"].as_str().unwrap_or_default() {
        "subagent" => {
            let id = str_of(&e["agent"], "id");
            let i = s.agents.iter().position(|a| a.id == id);
            if let Some(a) = agent_of(&e["agent"], title, i.map(|i| &s.agents[i])) {
                let fresh_start = a.working() && i.is_none_or(|i| !s.agents[i].working());
                if fresh_start && !a.chat.is_empty() && !s.started.contains(&a.chat) {
                    s.started.push(a.chat.clone());
                }
                match i {
                    Some(i) => s.agents[i] = a,
                    None => s.agents.push(a),
                }
            }
        }
        "subagent_log" => {
            let id = str_of(e, "agentId");
            if let Some(a) = s.agents.iter_mut().find(|a| a.id == id) {
                a.log.push(line_of(&e["entry"]));
                let over = a.log.len().saturating_sub(600);
                a.log.drain(..over);
            }
        }
        "subagent_patch" => {
            let (id, line) = (str_of(e, "agentId"), str_of(e, "id"));
            if let Some(l) = s.agents.iter_mut().find(|a| a.id == id).and_then(|a| a.log.iter_mut().find(|l| l.id == line)) {
                let p = &e["patch"];
                if let Some(v) = p["status"].as_str() { l.status = v.to_owned(); }
                if let Some(v) = p["out"].as_str() { l.out = v.to_owned(); }
            }
        }
        "subagent_removed" => {
            let id = str_of(e, "agentId");
            s.agents.retain(|a| a.id != id);
        }
        "team_message" => {
            let id = str_of(e, "swarmId");
            let m = message_of(&e["message"]);
            match s.teams.iter_mut().find(|t| t.id == id) {
                Some(t) => t.messages.push(m),
                None => s.teams.push(Team { id, chat_id: str_of(e, "sessionId"), goal: String::new(), members: Vec::new(), messages: vec![m] }),
            }
        }
        "agent_browser" => s.asks.push(BrowserAsk {
            req: str_of(e, "reqId"),
            agent: str_of(e, "agentId"),
            name: str_of(e, "name"),
            color: color_of(&e["color"]),
            look: look_of(e["shape"].as_str().unwrap_or_default(), e["gear"].as_str().unwrap_or_default()),
            action: str_of(e, "action"),
            args: e["args"].clone(),
        }),
        _ => return false,
    }
    // Members join their team as they are announced.
    if e["type"] == "subagent" {
        let (id, team) = (str_of(&e["agent"], "id"), str_of(&e["agent"], "swarm"));
        if !team.is_empty() {
            match s.teams.iter_mut().find(|t| t.id == team) {
                Some(t) => {
                    if !t.members.contains(&id) {
                        t.members.push(id);
                    }
                }
                None => s.teams.push(Team { id: team, chat_id: str_of(&e["agent"], "chatId"), goal: String::new(), members: vec![id], messages: Vec::new() }),
            }
        }
    }
    true
}

// ---------- sample, for the mock store and headless renders ----------

pub fn sample() -> Subagents {
    let line = |kind: &str, text: &str| Line { kind: kind.into(), text: text.into(), ..Default::default() };
    let tool = |name: &str, arg: &str, status: &str| Line { kind: "tool".into(), name: name.into(), arg: arg.into(), status: status.into(), ..Default::default() };
    let chat = "Casual chat".to_owned();
    let mk = |id: &str, name: &str, color: &str, shape: &str, gear: &str, status: &str, task: &str, log: Vec<Line>| Subagent {
        id: id.into(), chat_id: "c-sample".into(), chat: chat.clone(), name: name.into(), color: color.into(), look: look_of(shape, gear),
        status: status.into(), task: task.into(), swarm: "sw1".into(), browser: false, files: 0, log,
    };
    Subagents {
        agents: vec![
            mk("ag1", "Nova", "#ff2fa8", "round", "headphones", "working", "The pricing page: pricing.html and pricing.css", vec![
                Line { kind: "user".into(), by: "codeply".into(), text: "The pricing page: pricing.html and pricing.css".into(), ..Default::default() },
                tool("Team channel", "", "ok"),
                line("text", "I'll build the three plan cards first, then the monthly/yearly switch."),
                tool("Write", "pricing.html", "ok"),
                tool("Edit", "pricing.css", "run"),
            ]),
            mk("ag2", "Pico", "#00c2a8", "cloud", "sprout", "working", "Plan data in plans.json, and the API limits", vec![
                tool("Read", "src/api/limits.ts", "ok"),
                tool("Run", "npm test -- limits", "run"),
            ]),
            mk("ag3", "Maple", "#ffbe0b", "square", "cap", "done", "Copy for the three plans", vec![
                tool("Write", "copy/plans.md", "ok"),
                Line { kind: "done".into(), ok: true, files: vec!["copy/plans.md".into()], ..Default::default() },
            ]),
        ],
        teams: vec![Team {
            id: "sw1".into(), chat_id: "c-sample".into(), goal: "A pricing page with three plans and a monthly or yearly switch.".into(),
            members: vec!["ag1".into(), "ag2".into(), "ag3".into()],
            messages: vec![
                Message { from: "Codeply".into(), to: String::new(), text: "Goal: a pricing page with three plans and a monthly or yearly switch.".into() },
                Message { from: "Maple".into(), to: String::new(), text: "DONE: copy for Free, Plus and Team is in copy/plans.md".into() },
                Message { from: "Nova".into(), to: "Pico".into(), text: "What are the field names in plans.json?".into() },
                Message { from: "Pico".into(), to: "Nova".into(), text: "name, monthly, yearly, limits. Writing it now.".into() },
            ],
        }],
        ..Default::default()
    }
}
