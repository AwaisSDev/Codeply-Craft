//! The composer's "/" and "@" menus, as the Electron app had them.
//!
//! "/" at the start of the text or after a space lists the app's commands (New chat, Model,
//! Effort, ...) and every skill; "@" lists your agents, connected apps and the project's files.
//! Both filter as you type. Up and Down pick, Enter or Tab take it, Esc closes; a click takes one.
//!
//! A command runs at once. A skill goes in the message as `/name`, an agent, app or file as
//! `@name`. On send, `refs_of` finds those tokens again and `body` hands the engine both the text as
//! you wrote it and what each token means (`refs`); the engine (sidecar/ext-skills.mjs) puts the
//! skill's SKILL.md, the file, the agent to ask and the app to use in front of the prompt.

use rune::{Key, KeyEvent, Mods, Tx};
use serde_json::{Value, json};

use crate::app::{App, EditKey, SettingsPage};
use crate::model::{Agent, Skill, Snapshot};

/// What opened the menu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    Slash,
    At,
}

/// The app's own commands in the "/" menu: the Electron app's that make sense here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    NewChat,
    Model,
    Effort,
    Approval,
    Review,
    Security,
    Skills,
    Usage,
    Settings,
}

/// (command, name, other names, icon, what it does).
pub const COMMANDS: &[(Command, &str, &[&str], &str, &str)] = &[
    (Command::NewChat, "new", &["clear"], "oai-compose", "Start a new chat"),
    (Command::Model, "model", &["models"], "sparkle", "Pick the model"),
    (Command::Effort, "effort", &["think"], "bulb", "How hard the model thinks"),
    (Command::Approval, "approval", &["permissions", "access"], "shield-check", "Ask before acting, or full access"),
    (Command::Review, "review", &[], "code", "Review the changes not yet committed"),
    (Command::Security, "security", &["sec"], "shield-alert", "Find the holes in this project"),
    (Command::Skills, "skills", &["skill"], "book", "See every skill"),
    (Command::Usage, "usage", &["limits"], "gauge", "See how much you have used"),
    (Command::Settings, "settings", &["preferences"], "settings", "Open Settings"),
];

impl Command {
    pub fn name(self) -> &'static str {
        COMMANDS.iter().find(|c| c.0 == self).map_or("", |c| c.1)
    }
    pub fn icon(self) -> &'static str {
        COMMANDS.iter().find(|c| c.0 == self).map_or("prompt", |c| c.3)
    }
}

/// What a row of the menu stands for.
#[derive(Clone, Debug, PartialEq)]
pub enum Pick {
    Command(Command),
    Skill(String),
    /// An agent on your team: (id, name).
    Agent(String, String),
    /// A connected app: (id, name).
    App(String, String),
    /// A project file or folder (folders end in `/`).
    File(String),
}

/// One row: what it stands for, its name and a line about it.
#[derive(Clone, Debug, PartialEq)]
pub struct Choice {
    pub pick: Pick,
    pub label: String,
    pub note: String,
}

impl Choice {
    /// What goes in the message for it (nothing for a command, which runs instead).
    pub fn insert(&self) -> Option<String> {
        match &self.pick {
            Pick::Command(_) => None,
            Pick::Skill(n) => Some(format!("/{n}")),
            Pick::Agent(_, n) | Pick::App(_, n) | Pick::File(n) => Some(format!("@{n}")),
        }
    }
}

/// The menu while it's open: the composer it belongs to, where its "/" or "@" is, the caret it
/// was worked out for, its rows and the one picked.
#[derive(Clone, Debug, PartialEq)]
pub struct Popup {
    pub key: EditKey,
    /// Who the composer talks to (a command like Review sends there).
    pub target: crate::store::Target,
    pub trigger: Trigger,
    pub start: usize,
    pub caret: usize,
    pub query: String,
    pub items: Vec<Choice>,
    pub pick: usize,
    /// The composer had focus while it was open: losing it closes the menu.
    pub focused: bool,
}

/// The most rows a menu works out (it draws a window of them around the one picked).
pub const MAX: usize = 400;
/// The most files among them.
pub const MAX_FILES: usize = 200;

/// What the menus can offer, from what the app has.
pub struct Sources<'a> {
    pub skills: &'a [Skill],
    /// Your agents (not Wisp, who leads them).
    pub team: Vec<&'a Agent>,
    /// Connected apps: (id, name).
    pub apps: Vec<(String, String)>,
    pub files: &'a [String],
}

impl<'a> Sources<'a> {
    pub fn of(snap: &'a Snapshot) -> Sources<'a> {
        let mut apps: Vec<(String, String)> = snap.extra.apps.connected.iter().map(|a| (a.slug.to_owned(), a.name.clone())).collect();
        // Until the engine lists them, the catalogue's page says which are connected.
        for a in snap.extra.catalog.iter().filter(|a| a.connected) {
            if !apps.iter().any(|(id, _)| id == a.slug) {
                apps.push((a.slug.to_owned(), a.name.clone()));
            }
        }
        Sources {
            skills: &snap.extra.skills,
            team: snap.team.iter().filter(|a| !a.id.eq_ignore_ascii_case("wisp")).collect(),
            apps,
            files: &snap.extra.code.files,
        }
    }
}

/// The "/" or "@" being typed before `caret`: what it is, where it starts, and what follows it.
/// It must start the text or follow a space, and run up to the caret without a space.
pub fn token_at(text: &str, caret: usize) -> Option<(Trigger, usize, &str)> {
    let caret = caret.min(text.len());
    if !text.is_char_boundary(caret) {
        return None;
    }
    let before = &text[..caret];
    let start = before.char_indices().rev().take_while(|(_, c)| !c.is_whitespace()).last().map(|(i, _)| i)?;
    let run = &before[start..];
    let trigger = match run.chars().next()? {
        '/' => Trigger::Slash,
        '@' => Trigger::At,
        _ => return None,
    };
    Some((trigger, start, &run[1..]))
}

/// How well `name` answers `q` (lower case): 0 the same, 1 starts with it, 2 a word in it does,
/// 3 has it somewhere. None: not at all. An empty `q` answers everything with 1.
fn rank(name: &str, q: &str) -> Option<u8> {
    if q.is_empty() {
        return Some(1);
    }
    let n = name.to_lowercase();
    if n == q {
        Some(0)
    } else if n.starts_with(q) {
        Some(1)
    } else if n.match_indices(q).any(|(i, _)| i > 0 && n[..i].ends_with(['-', ' ', '_', '/', '.'])) {
        Some(2)
    } else if n.contains(q) {
        Some(3)
    } else {
        None
    }
}

/// The rows for what's typed after the "/" or "@", best first: names that are or start with it,
/// then names with a word that does, then names (or, for skills, descriptions) with it anywhere.
pub fn choices(trigger: Trigger, query: &str, src: &Sources) -> Vec<Choice> {
    let q = query.trim().to_lowercase();
    // (rank, group, order, row)
    let mut found: Vec<(u8, u8, usize, Choice)> = Vec::new();
    match trigger {
        Trigger::Slash => {
            for (i, (cmd, name, aliases, _, note)) in COMMANDS.iter().enumerate() {
                let best = std::iter::once(*name).chain(aliases.iter().copied()).filter_map(|n| rank(n, &q)).min();
                if let Some(r) = best {
                    found.push((r, 0, i, Choice { pick: Pick::Command(*cmd), label: (*name).to_owned(), note: (*note).to_owned() }));
                }
            }
            for (i, sk) in src.skills.iter().enumerate() {
                let r = rank(&sk.name, &q).or_else(|| (q.len() >= 2 && sk.description.to_lowercase().contains(&q)).then_some(4));
                if let Some(r) = r {
                    found.push((r, 1, i, Choice { pick: Pick::Skill(sk.name.clone()), label: sk.name.clone(), note: sk.description.clone() }));
                }
            }
        }
        Trigger::At => {
            for (i, a) in src.team.iter().enumerate() {
                if let Some(r) = rank(&a.name, &q).or_else(|| rank(&a.id, &q)) {
                    let note = if a.role.is_empty() { "Agent".to_owned() } else { format!("Agent · {}", a.role) };
                    found.push((r, 0, i, Choice { pick: Pick::Agent(a.id.clone(), a.name.clone()), label: a.name.clone(), note }));
                }
            }
            for (i, (id, name)) in src.apps.iter().enumerate() {
                if let Some(r) = rank(name, &q).or_else(|| rank(id, &q)) {
                    found.push((r, 1, i, Choice { pick: Pick::App(id.clone(), name.clone()), label: name.clone(), note: "Connected app".to_owned() }));
                }
            }
            let mut files = 0;
            for (i, f) in src.files.iter().enumerate() {
                if files >= MAX_FILES {
                    break;
                }
                let base = f.trim_end_matches('/').rsplit('/').next().unwrap_or(f);
                // A file's own name counts most; its folders only as "somewhere in it".
                let r = rank(base, &q).or_else(|| (!q.is_empty() && f.to_lowercase().contains(&q)).then_some(3));
                if let Some(r) = r {
                    files += 1;
                    let note = if f.ends_with('/') { "Folder" } else { "File" };
                    found.push((r, 2, i, Choice { pick: Pick::File(f.clone()), label: f.clone(), note: note.to_owned() }));
                }
            }
        }
    }
    found.sort_by_key(|(r, g, i, _)| (*r, *g, *i));
    found.into_iter().take(MAX).map(|(_, _, _, c)| c).collect()
}

// ---------- what a sent message means ----------

/// What a `/skill` or `@mention` token in a sent message stands for.
#[derive(Clone, Debug, PartialEq)]
pub enum Ref {
    Skill(String),
    File(String),
    Agent(String),
    /// (id, name)
    App(String, String),
}

impl Ref {
    pub fn json(&self) -> Value {
        match self {
            Ref::Skill(n) => json!({ "kind": "skill", "name": n }),
            Ref::File(p) => json!({ "kind": "file", "path": p }),
            Ref::Agent(n) => json!({ "kind": "agent", "name": n }),
            Ref::App(id, n) => json!({ "kind": "app", "id": id, "name": n }),
        }
    }
}

/// Whether `rest` starts with `name` (any case) followed by the end, a space or punctuation.
fn starts_name(rest: &str, name: &str) -> bool {
    if name.is_empty() || rest.len() < name.len() || !rest.is_char_boundary(name.len()) || !rest[..name.len()].eq_ignore_ascii_case(name) {
        return false;
    }
    rest[name.len()..].chars().next().is_none_or(|c| c.is_whitespace() || ",.;:!?)'\"".contains(c))
}

/// The skills, agents, apps and files a message's `/name` and `@name` tokens name, in order,
/// each once. A token must start the text or follow a space; an `@` takes the longest name it
/// fits (an agent before an app before a file of the same name).
pub fn refs_of(text: &str, src: &Sources) -> Vec<Ref> {
    let mut out: Vec<Ref> = Vec::new();
    let mut push = |r: Ref| {
        if !out.contains(&r) {
            out.push(r);
        }
    };
    let mut prev: Option<char> = None;
    for (i, c) in text.char_indices() {
        let starts = prev.is_none_or(char::is_whitespace);
        prev = Some(c);
        if !starts || (c != '/' && c != '@') {
            continue;
        }
        let rest = &text[i + 1..];
        if c == '/' {
            if let Some(sk) = src.skills.iter().filter(|s| starts_name(rest, &s.name)).max_by_key(|s| s.name.len()) {
                push(Ref::Skill(sk.name.clone()));
            }
            continue;
        }
        let mut best: Option<(usize, u8, Ref)> = None;
        let mut offer = |len: usize, group: u8, r: Ref| {
            if best.as_ref().is_none_or(|(l, g, _)| len > *l || (len == *l && group < *g)) {
                best = Some((len, group, r));
            }
        };
        for a in &src.team {
            if starts_name(rest, &a.name) {
                offer(a.name.len(), 0, Ref::Agent(a.name.clone()));
            }
        }
        for (id, name) in &src.apps {
            if starts_name(rest, name) {
                offer(name.len(), 1, Ref::App(id.clone(), name.clone()));
            }
        }
        for f in src.files {
            if starts_name(rest, f) {
                offer(f.len(), 2, Ref::File(f.clone()));
            } else if f.ends_with('/') && starts_name(rest, f.trim_end_matches('/')) {
                offer(f.len() - 1, 2, Ref::File(f.clone()));
            }
        }
        if let Some((_, _, r)) = best {
            push(r);
        }
    }
    out
}

/// What the engine gets for a message: the text as you wrote it, the attached files, and what
/// its tokens mean (left out when there are none, so an engine without them sees what it did).
pub fn body(text: &str, files: &[String], refs: &[Ref]) -> Value {
    let mut b = json!({ "text": text, "files": files });
    if !refs.is_empty() {
        b["refs"] = Value::Array(refs.iter().map(Ref::json).collect());
    }
    b
}

/// `GET /ext/skills` (sidecar/ext-skills.mjs) as the app keeps skills.
pub fn skills_from(v: &Value) -> Vec<Skill> {
    let s = |x: &Value, k: &str| x[k].as_str().unwrap_or_default().to_owned();
    v["skills"].as_array().map_or_else(Vec::new, |a| {
        a.iter().filter(|x| x["name"].as_str().is_some_and(|n| !n.is_empty()))
            .map(|x| Skill { name: s(x, "name"), description: s(x, "description"), source: s(x, "source"), plugin: s(x, "plugin"), path: s(x, "path") })
            .collect()
    })
}

const REVIEW: &str = "Review the uncommitted changes in this project like a strict senior reviewer. Read the real diff (git diff and git status) and the code around it. Find real bugs first: wrong logic, missed edge cases, broken error handling, race conditions, security problems, things that break other callers. Then simpler or clearer ways to do the same. For each finding: file:line, what goes wrong and when, and the fix. Skip style nits. Do not change any code unless I ask. If the changes look right, say so plainly.";
const SECURITY: &str = "Do a security review of this project. Think like an attacker looking for loopholes, not like a checklist, and read the real code. Look for: auth and permission gaps, injection (SQL, shell, path, prompt), secrets or keys in code, config or logs, unsafe defaults, missing input checks, insecure storage, SSRF and open redirects, risky dependencies, and anything a user could abuse to reach data or access they should not have. For each finding give the severity (critical, high, medium, low), where it is (file:line), how someone would exploit it, and the fix. Rank them, worst first. Do not change any code unless I ask. If something looks risky but you cannot confirm it, say so.";

/// `/review` and `/security` at the start of a message become the Electron app's prompts for
/// them, with anything after them as what to focus on. Other text is left alone.
pub fn expand(text: &str) -> String {
    let t = text.trim_start();
    for (name, prompt) in [("/review", REVIEW), ("/security", SECURITY), ("/sec", SECURITY)] {
        if starts_name(t, name) && t.get(..name.len()).is_some_and(|h| h == name) {
            let focus = t[name.len()..].trim();
            return if focus.is_empty() { prompt.to_owned() } else { format!("{prompt}\n\nFocus on: {focus}") };
        }
    }
    text.to_owned()
}

// ---------- the composer's handlers ----------

impl App {
    /// The menu over composer `key`, while the caret is where it was worked out for.
    pub fn mention_shown(&self, key: EditKey) -> Option<&Popup> {
        let p = self.mention.as_ref().filter(|p| p.key == key)?;
        let (a, b) = self.edit(key).range();
        (a == b && b == p.caret && !p.items.is_empty() && p.pick < p.items.len()).then_some(p)
    }

    /// The text of composer `key` changed: a "/" or "@" being typed opens (or narrows) its menu,
    /// anything else closes it.
    pub fn mention_typed(&mut self, key: EditKey, target: &crate::store::Target) {
        let e = self.edit(key);
        let (a, b) = e.range();
        let found = if a == b { token_at(&e.text, b).map(|(tr, start, q)| (tr, start, q.to_owned())) } else { None };
        let Some((trigger, start, query)) = found else {
            if self.mention.as_ref().is_some_and(|p| p.key == key) {
                self.mention = None;
            }
            return;
        };
        let items = choices(trigger, &query, &Sources::of(&self.data));
        if items.is_empty() {
            self.mention = None;
            return;
        }
        // The same row stays picked while it's still there.
        let was = self.mention.as_ref().filter(|p| p.key == key && p.start == start).and_then(|p| p.items.get(p.pick).cloned());
        let pick = was.and_then(|w| items.iter().position(|c| *c == w)).unwrap_or(0);
        let focused = self.mention.as_ref().is_some_and(|p| p.key == key && p.focused);
        self.mention = Some(Popup { key, target: target.clone(), trigger, start, caret: b, query, items, pick, focused });
    }

    /// The composer's keys while its menu is open: Up and Down pick, Enter or Tab take it, Esc
    /// closes it. True when taken.
    pub fn mention_key(&mut self, key: EditKey, e: &KeyEvent, tx: &mut Tx) -> bool {
        if self.edit(key).preedit().is_some() {
            return false;
        }
        let Some(n) = self.mention_shown(key).map(|p| p.items.len()) else { return false };
        let plain = e.mods == Mods::default();
        let pick = self.mention.as_ref().map_or(0, |p| p.pick);
        match e.key {
            Key::Up if plain => {
                if let Some(p) = &mut self.mention {
                    p.pick = (pick + n - 1) % n;
                }
                true
            }
            Key::Down if plain => {
                if let Some(p) = &mut self.mention {
                    p.pick = (pick + 1) % n;
                }
                true
            }
            Key::Tab | Key::Enter if plain => self.accept_mention(key, pick, tx),
            Key::Escape => {
                self.mention = None;
                true
            }
            _ => false,
        }
    }

    /// Takes row `i` of composer `key`'s menu: a command runs (its "/word" goes), anything else
    /// goes in the text in place of what was typed, with a space after it.
    pub fn accept_mention(&mut self, key: EditKey, i: usize, tx: &mut Tx) -> bool {
        let Some(p) = self.mention_shown(key).cloned() else { return false };
        let Some(choice) = p.items.get(i).cloned() else { return false };
        self.mention = None;
        let edit = self.edit_mut(key);
        if !edit.text.is_char_boundary(p.start) || !edit.text.is_char_boundary(p.caret) || p.start > p.caret {
            return false;
        }
        // The "/" or "@" and what was typed after it make way for the pick.
        edit.set_selection(p.start, p.caret);
        match choice.insert() {
            Some(word) => {
                let next_is_space = edit.text[p.caret..].starts_with(char::is_whitespace);
                edit.insert(&if next_is_space { word } else { format!("{word} ") });
            }
            None => edit.insert(""),
        }
        if let Pick::Command(c) = choice.pick {
            self.run_command_pick(key, &p.target, c, tx);
        } else {
            tx.focus(format!("composer-{}", key.name()), false);
        }
        true
    }

    /// A "/" command, on the composer it was typed in.
    fn run_command_pick(&mut self, key: EditKey, to: &crate::store::Target, c: Command, tx: &mut Tx) {
        let field = format!("composer-{}", key.name());
        match c {
            Command::NewChat => {
                self.edit_mut(key).clear();
                self.new_chat();
                tx.focus("composer-chat-home", false);
            }
            Command::Model | Command::Effort => {
                self.menu = None;
                let id = if c == Command::Model { "model" } else { "effort" };
                self.toggle_menu(&format!("{id}:{}", key.name()));
            }
            Command::Approval => {
                self.menu = None;
                self.toggle_menu(&format!("approval:{}", key.name()));
            }
            Command::Review | Command::Security => {
                // Runs at once, as in the Electron app; anything else typed is what to focus on.
                let rest = self.edit(key).text.trim().to_owned();
                let word = format!("/{}", c.name());
                self.edit_mut(key).replace_text(if rest.is_empty() { word } else { format!("{word} {rest}") });
                self.submit(key, to);
                tx.focus(field, false);
            }
            Command::Skills => self.open_settings(SettingsPage::Skills),
            Command::Usage => {
                if !self.usage_open {
                    self.toggle_usage();
                }
            }
            Command::Settings => self.open_settings(SettingsPage::General),
        }
    }

    /// Before each frame: the menu closes once its composer has lost focus (a click elsewhere).
    pub fn mention_focus(&mut self, focused: Option<&str>) -> bool {
        let Some(p) = &mut self.mention else { return false };
        let field = format!("composer-{}", p.key.name());
        let here = focused.is_some_and(|f| f == field || f.starts_with("mention/"));
        if here {
            p.focused = true;
            return false;
        }
        if p.focused {
            self.mention = None;
            return true;
        }
        false
    }

    /// What composer `key`'s text sends: `/review` and the like turned into their prompts, and
    /// what its `/skill` and `@mention` tokens mean.
    pub fn outgoing(&self, text: &str) -> (String, Vec<Ref>) {
        (expand(text), refs_of(text, &Sources::of(&self.data)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Look, Shape, Face, AgentState};

    fn skill(name: &str, description: &str) -> Skill {
        Skill { name: name.into(), description: description.into(), source: "built-in".into(), ..Default::default() }
    }

    fn agent(id: &str, name: &str, role: &str) -> Agent {
        Agent { id: id.into(), name: name.into(), color: "#ff5c9d".into(), look: Look::new(Shape::Round, Face::Pill, &[]), role: role.into(), state: AgentState::Idle, place: String::new(), action: String::new(), status: String::new(), pos: (0.0, 0.0) }
    }

    struct Data {
        skills: Vec<Skill>,
        team: Vec<Agent>,
        files: Vec<String>,
    }

    fn data() -> Data {
        Data {
            skills: vec![
                skill("api-design", "REST API design patterns"),
                skill("frontend-patterns", "Frontend patterns for React and state management"),
                skill("security-review", "Checklist for auth, input and secrets"),
                skill("tdd-workflow", "Test-driven development"),
                skill("e2e-testing", "Playwright end-to-end testing"),
            ],
            team: vec![agent("joseph", "Joseph", "Ops"), agent("inbox", "Inbox Watch", "Mail"), agent("docs", "Docs", "Writing")],
            files: vec!["README.md".into(), "src/".into(), "src/main.rs".into(), "src/store/".into(), "src/store/live.rs".into(), "docs/review.md".into()],
        }
    }

    fn sources(d: &Data) -> Sources<'_> {
        Sources { skills: &d.skills, team: d.team.iter().collect(), apps: vec![("slack".into(), "Slack".into()), ("gdrive".into(), "Google Drive".into())], files: &d.files }
    }

    fn labels(c: &[Choice]) -> Vec<&str> {
        c.iter().map(|c| c.label.as_str()).collect()
    }

    #[test]
    fn a_slash_or_at_opens_only_at_the_start_or_after_a_space() {
        assert_eq!(token_at("/", 1), Some((Trigger::Slash, 0, "")));
        assert_eq!(token_at("fix it /tdd", 11), Some((Trigger::Slash, 7, "tdd")));
        assert_eq!(token_at("ask @jo", 7), Some((Trigger::At, 4, "jo")));
        assert_eq!(token_at("a/b", 3), None, "a slash inside a word is not a command");
        assert_eq!(token_at("mail sam@example.com", 20), None, "nor is an email address");
        assert_eq!(token_at("/tdd now", 8), None, "a space ends it");
        assert_eq!(token_at("/tdd now", 4), Some((Trigger::Slash, 0, "tdd")), "the caret decides");
        assert_eq!(token_at("héllo @é", "héllo @é".len()), Some((Trigger::At, 7, "é")));
    }

    #[test]
    fn the_slash_menu_lists_commands_then_every_skill_and_filters_as_you_type() {
        let d = data();
        let src = sources(&d);
        let all = choices(Trigger::Slash, "", &src);
        assert_eq!(all.len(), COMMANDS.len() + d.skills.len(), "every command and every skill");
        assert!(matches!(all[0].pick, Pick::Command(Command::NewChat)), "commands come first");
        assert!(matches!(all[COMMANDS.len()].pick, Pick::Skill(_)));
        // Names that start with it, then a word in the name, then the description.
        let sec = choices(Trigger::Slash, "sec", &src);
        assert_eq!(labels(&sec), ["security", "security-review"]);
        let rev = choices(Trigger::Slash, "rev", &src);
        assert_eq!(labels(&rev), ["review", "security-review"], "a word inside a name counts");
        let react = choices(Trigger::Slash, "react", &src);
        assert_eq!(labels(&react), ["frontend-patterns"], "the description counts too");
        assert_eq!(labels(&choices(Trigger::Slash, "CLEAR", &src)), ["new"], "other names and any case find a command");
        assert!(choices(Trigger::Slash, "zzz", &src).is_empty());
    }

    #[test]
    fn the_at_menu_lists_agents_apps_then_files() {
        let d = data();
        let src = sources(&d);
        let all = choices(Trigger::At, "", &src);
        assert_eq!(labels(&all)[..6], ["Joseph", "Inbox Watch", "Docs", "Slack", "Google Drive", "README.md"]);
        assert_eq!(all.len(), 3 + 2 + d.files.len());
        let docs = choices(Trigger::At, "doc", &src);
        assert_eq!(labels(&docs), ["Docs", "docs/review.md"], "an agent before a file of the same name");
        let live = choices(Trigger::At, "live", &src);
        assert_eq!(labels(&live), ["src/store/live.rs"]);
        assert_eq!(labels(&choices(Trigger::At, "watch", &src)), ["Inbox Watch"], "any word of a name");
        assert_eq!(choices(Trigger::At, "drive", &src)[0].pick, Pick::App("gdrive".into(), "Google Drive".into()));
        let store = choices(Trigger::At, "store", &src);
        assert_eq!(labels(&store), ["src/store/", "src/store/live.rs"], "a file's own name before its folders");
        assert_eq!(all[0].insert().as_deref(), Some("@Joseph"));
        assert_eq!(store[1].insert().as_deref(), Some("@src/store/live.rs"));
    }

    #[test]
    fn many_files_are_capped() {
        let d = data();
        let files: Vec<String> = (0..1000).map(|i| format!("src/f{i}.rs")).collect();
        let src = Sources { skills: &d.skills, team: Vec::new(), apps: Vec::new(), files: &files };
        assert_eq!(choices(Trigger::At, "", &src).len(), MAX_FILES);
        assert_eq!(choices(Trigger::At, "f99", &src).len(), 11);
    }

    #[test]
    fn a_sent_message_names_its_skills_agents_apps_and_files() {
        let d = data();
        let src = sources(&d);
        let text = "/tdd-workflow @Joseph check the logs in @src/store/live.rs and post in @Slack, then ask @Inbox Watch.";
        let refs = refs_of(text, &src);
        assert_eq!(refs, [
            Ref::Skill("tdd-workflow".into()),
            Ref::Agent("Joseph".into()),
            Ref::File("src/store/live.rs".into()),
            Ref::App("slack".into(), "Slack".into()),
            Ref::Agent("Inbox Watch".into()),
        ]);
        // Not a token: a skill name inside a path, an unknown name, an email, a repeat.
        assert!(refs_of("see a/tdd-workflow and @nobody, sam@Joseph.com", &src).is_empty());
        assert_eq!(refs_of("@joseph and @Joseph", &src), [Ref::Agent("Joseph".into())], "any case, once");
        assert_eq!(refs_of("look at @src/store", &src), [Ref::File("src/store/".into())], "a folder without its slash");
        assert_eq!(refs_of("@Docs", &src), [Ref::Agent("Docs".into())]);
        assert_eq!(refs_of("@docs/review.md", &src), [Ref::File("docs/review.md".into())], "the longest name it fits");

        // What the engine gets: the text as written, the files, and the refs.
        let b = body(text, &["/home/sam/shot.png".into()], &refs);
        assert_eq!(b["text"], text);
        assert_eq!(b["files"][0], "/home/sam/shot.png");
        assert_eq!(b["refs"][0], json!({ "kind": "skill", "name": "tdd-workflow" }));
        assert_eq!(b["refs"][1], json!({ "kind": "agent", "name": "Joseph" }));
        assert_eq!(b["refs"][2], json!({ "kind": "file", "path": "src/store/live.rs" }));
        assert_eq!(b["refs"][3], json!({ "kind": "app", "id": "slack", "name": "Slack" }));
        assert!(body("hi", &[], &[]).get("refs").is_none(), "a plain message is as before");
    }

    #[test]
    fn review_and_security_become_their_prompts() {
        assert!(expand("/review").starts_with("Review the uncommitted changes"));
        assert!(expand("/review the auth code").ends_with("Focus on: the auth code"));
        assert!(expand("  /security").starts_with("Do a security review"));
        assert_eq!(expand("/reviewing"), "/reviewing");
        assert_eq!(expand("/security-review the login"), "/security-review the login", "a skill stays a skill");
        assert_eq!(expand("please /review"), "please /review");
    }
}
