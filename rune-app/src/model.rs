//! What the views show. A `Store` fills a `Snapshot`; views only read it.
//!
//! Inline emphasis uses `**bold**` markers in plain strings, which `ui::rich_text` draws.

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AgentState {
    Idle,
    Working,
    Thinking,
    Waiting,
    Sleeping,
    Walking,
}

impl AgentState {
    pub fn word(self) -> &'static str {
        match self {
            AgentState::Idle => "idle",
            AgentState::Working => "working",
            AgentState::Thinking => "thinking",
            AgentState::Waiting => "needs you",
            AgentState::Sleeping => "asleep",
            AgentState::Walking => "walking",
        }
    }
}

/// A helper's silhouette. Wisp is the hexagon; helpers are a hexagon, a soft round blob or a
/// squircle, so the team reads as one family with Wisp at its head.
/// Not every shape is worn by a sample agent; all are drawn and tested.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Shape {
    Hex,
    Round,
    Square,
    Cloud,
    Triangle,
    Drop,
    Pebble,
}

/// The eyes a helper has at rest. Its state still changes them (looking up while thinking, shut asleep).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Face {
    /// Wisp's white pill eyes.
    Pill,
    /// Glossy black capsules with a glint, drawn as if on a sphere (the Grok bot's eyes): they
    /// lean like `\\` and the far one is narrower.
    Glossy,
    /// White eyeballs with a shaded pupil and a glint.
    Googly,
    /// Closed, content arcs.
    Content,
    /// The Grok bot's eyes: two white capsules on a sphere. They sit where the bot is looking,
    /// lean with its gaze, and the far one is narrower.
    Capsule,
}

/// Accessories, drawn as finished objects: glossy black for the dark ones, with a soft shadow and
/// a sheen, so each helper is recognisable at sidebar size.
/// Not every accessory is worn by a sample agent; all are drawn and tested.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Gear {
    Beret,
    Bow,
    Headphones,
    Glasses,
    Shades,
    Sprout,
    Flower,
    Star,
    Cap,
    Antennae,
}

/// How a helper looks: its silhouette, eyes and accessories (up to two, like a bow with glasses).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Look {
    pub shape: Shape,
    pub face: Face,
    pub gear: Vec<Gear>,
    /// Where it looks at rest, each axis -2 to 2 (left or up is negative). Eyes sit toward it.
    pub gaze: (i8, i8),
}

impl Look {
    pub fn new(shape: Shape, face: Face, gear: &[Gear]) -> Look {
        Look { shape, face, gear: gear.to_vec(), gaze: (0, 0) }
    }
    /// Looks toward `x`, `y` at rest.
    pub fn looking(mut self, x: i8, y: i8) -> Look {
        self.gaze = (x, y);
        self
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Agent {
    pub id: String,
    pub name: String,
    /// `#rrggbb`. Colour belongs to agents only; interface icons stay monochrome.
    pub color: String,
    pub look: Look,
    pub role: String,
    pub state: AgentState,
    /// Where in the office: "Studio", "Kitchen", ...
    pub place: String,
    /// What it is doing now, shown on hover.
    pub action: String,
    /// One line for lists (Board sidebar).
    pub status: String,
    /// Position in the 1200 x 720 office, as in the prototype's PLACES.
    pub pos: (f32, f32),
}

#[derive(Clone, Debug, PartialEq)]
pub enum ButtonKind {
    Plain,
    Blue,
    Green,
}

/// One piece of an agent's latest chat or live session, for the Office drawer.
#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    Label(String),
    /// A finished step, or the one in progress (`now`).
    Step { text: String, now: bool },
    /// A live view of the agent's screen. Phase 1 draws a placeholder page.
    LiveScreen,
    /// Something you said.
    Bubble(String),
    /// What the agent said back.
    Reply(String),
    /// A draft waiting for your OK.
    Draft { title: String, to: String, via: Option<String>, body: String },
    /// A quoted note.
    Quote(String),
    /// A quiet line with an icon, such as a routine that was created.
    Via { icon: &'static str, text: String },
    Buttons(Vec<(String, ButtonKind, Option<&'static str>)>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChatGroup {
    pub icon: &'static str,
    pub title: String,
    pub chats: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ThreadItem {
    Stamp(String),
    You(String),
    Them(String),
    /// "6 messages with Frontend, Backend and Inbox".
    Team { text: String, agents: Vec<String> },
    Event { icon: &'static str, text: String },
    /// The engine asks before it acts. `answer` is set once you (or a timeout) answered.
    Approval { id: String, title: String, detail: String, answer: Option<String> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrState {
    Open,
    Draft,
    Merged,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Pr {
    pub number: u32,
    pub title: String,
    pub by: String,
    pub state: PrState,
    pub age: String,
    pub added: u32,
    pub removed: u32,
    pub branch: String,
    pub summary: String,
    pub points: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ConnectedApp {
    pub slug: &'static str,
    pub name: String,
    pub note: String,
    pub agents: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AppAction {
    pub slug: &'static str,
    pub text: String,
    pub note: String,
    pub time: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Task {
    /// The approval this task waits on, from the engine: (chat title, request id). Its buttons
    /// answer it ("Allow once", "Don't allow").
    pub request: Option<(String, String)>,
    pub agent: String,
    pub title: String,
    pub sub: String,
    pub pill: Option<(String, Pill)>,
    pub body: TaskBody,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pill {
    Green,
    Warn,
    Blue,
    Gray,
    Purple,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TaskBody {
    Working { icon: &'static str, now: String, progress: f32, screen: bool },
    Ask { text: String, buttons: Vec<(String, ButtonKind)> },
    Done { proof: String, checked: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Column {
    Working,
    NeedsYou,
    Done,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    pub user: String,
    pub plan: String,
    pub project: String,
    pub team: Vec<Agent>,
    pub sessions: Vec<(String, Vec<Block>)>,
    pub chat_groups: Vec<ChatGroup>,
    pub recent: Vec<(String, String)>,
    pub threads: Vec<(String, Vec<ThreadItem>)>,
    pub prs: Vec<Pr>,
    pub connected: Vec<ConnectedApp>,
    pub popular: Vec<(&'static str, String, String)>,
    pub actions: Vec<AppAction>,
    pub tasks: Vec<(Column, Task)>,
    pub routines: Vec<(&'static str, String, String)>,
    /// 52 x 7 activity levels, 0 to 3, column-major by week.
    pub activity: Vec<u8>,
    /// Where the data comes from, for the status line ("Sample data", "codeply serve at ...").
    pub source: String,
    /// What the Codex-style views add (chats with their state, plugins, MCP, loops, ...).
    pub extra: Extra,
}

impl Snapshot {
    pub fn agent(&self, id: &str) -> Option<&Agent> {
        self.team.iter().find(|a| a.id == id)
    }
    pub fn session(&self, id: &str) -> &[Block] {
        self.sessions.iter().find(|(k, _)| k == id).map_or(&[], |(_, v)| v)
    }
    pub fn thread(&self, chat: &str) -> &[ThreadItem] {
        // "*" is the thread shown for a chat with none of its own (the sample data has one).
        let find = |key: &str| self.threads.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_slice());
        find(chat).or_else(|| find("*")).unwrap_or(&[])
    }
    pub fn count(&self, state: AgentState) -> usize {
        self.team.iter().filter(|a| a.state == state).count()
    }
}

// ---------- 4.0 beta: Codex-style views ----------

impl Shape {
    pub const ALL: [Shape; 7] = [Shape::Hex, Shape::Round, Shape::Square, Shape::Cloud, Shape::Triangle, Shape::Drop, Shape::Pebble];
    /// Its name in saved preferences.
    pub fn name(self) -> &'static str {
        match self {
            Shape::Hex => "hex",
            Shape::Round => "round",
            Shape::Square => "square",
            Shape::Cloud => "cloud",
            Shape::Triangle => "triangle",
            Shape::Drop => "drop",
            Shape::Pebble => "pebble",
        }
    }
    pub fn from_name(name: &str) -> Option<Shape> {
        Shape::ALL.into_iter().find(|s| s.name() == name)
    }
}

/// One chat as the Codex-style sidebar lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct ChatMeta {
    pub title: String,
    /// The project folder's name ("launch-site"), shown dim after the title.
    pub project: String,
    /// "4 min ago".
    pub ago: String,
    /// The last thing said, for the agent list's second line.
    pub preview: String,
    /// A reply is being written right now.
    pub running: bool,
    /// Unread: a reply finished since you last opened it (a blue dot).
    pub unread: bool,
}

/// A plugin: a bundle of skills, commands and connectors you can install.
#[derive(Clone, Debug, PartialEq)]
pub struct Plugin {
    pub id: String,
    pub name: String,
    pub note: String,
    pub by: String,
    /// An icon name (interface icons) or `app-<slug>` for an app's logo.
    pub icon: &'static str,
    pub installed: bool,
}

/// An MCP server the engine can talk to.
#[derive(Clone, Debug, PartialEq)]
pub struct McpServer {
    pub name: String,
    pub note: String,
    pub tools: u32,
    pub on: bool,
}

/// A loop: a task an agent runs on a schedule (the Agents view's right panel).
#[derive(Clone, Debug, PartialEq)]
pub struct Loop {
    pub agent: String,
    pub name: String,
    /// Recent runs, oldest first: true passed, false failed.
    pub runs: Vec<bool>,
    /// "Succeeded 50m ago", "Running now", "Failed 3d ago".
    pub last: String,
    pub on: bool,
}

/// An app in the Integrations catalogue.
#[derive(Clone, Debug, PartialEq)]
pub struct CatalogApp {
    pub slug: &'static str,
    pub name: String,
    pub note: String,
    pub category: &'static str,
    pub connected: bool,
    /// The app's site ("notion.so"), for its logo.
    pub domain: String,
    /// Its own logo's URL, when the catalogue has one (used before the domain's icon).
    pub icon: String,
}

/// The part of a Snapshot the Codex-style views add. Kept in its own struct so the original
/// fields (and the code that fills them) stay as they were.
/// Your token use, as the usage sheet shows it (the Electron app's Usage page).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Usage {
    /// Why there's nothing to show ("Sign in to see your usage."), or empty.
    pub error: String,
    pub tokens: u64,
    pub calls: u64,
    /// The model you've used most.
    pub favorite: String,
    /// Today, "YYYY-MM-DD" in your time zone.
    pub today: String,
    pub days: Vec<UsageDay>,
}

/// One day of use: its date ("YYYY-MM-DD"), tokens and calls, and both per model.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UsageDay {
    pub date: String,
    pub tokens: u64,
    pub calls: u64,
    pub models: Vec<(String, u64, u64)>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Extra {
    /// Every chat, newest first.
    pub chats: Vec<ChatMeta>,
    /// Project folders, for the sidebar's Projects section.
    pub projects: Vec<String>,
    /// Suggestions under "What should we build?": (icon or `app-<slug>`, text).
    pub suggestions: Vec<(&'static str, String)>,
    pub plugins: Vec<Plugin>,
    pub mcp: Vec<McpServer>,
    pub skills: Vec<(String, String)>,
    pub loops: Vec<Loop>,
    pub catalog: Vec<CatalogApp>,
    /// Which engine replies come from ("DSH", "Classic") and whether it is up.
    pub engine: String,
    pub engine_ok: bool,
    /// The engine's version, for Settings > General.
    pub version: String,
    /// The terminal beside a chat: what you or Wisp ran, and what it printed.
    pub terminal: Vec<TermLine>,
    /// Background tasks: agents working for Wisp, and commands still running.
    pub bg_tasks: Vec<BgTask>,
    /// The last Publish: where the project went live, or what went wrong.
    pub publish: Option<Publish>,
    /// Whether you're signed in to Codeply (the engine's account).
    pub signed_in: bool,
    /// Your token use, once asked for (the usage sheet); None while it loads.
    pub usage: Option<Usage>,
    /// The account's email, when signed in.
    pub email: String,
    /// Where an email sign-in is: None, "sent" (a code went to the email), "error: ...".
    pub sign_in: Option<String>,
    /// Memories Wisp keeps (the engine's brain): (id, kind, text, scope).
    pub memories: Vec<Memory>,
    /// The code editor: the project's files, the open one, and Wisp's help with it.
    pub code: Code,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Memory {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub scope: String,
}

/// The Code view's data: a real project folder on disk, through the engine.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Code {
    /// The project's files, relative paths with `/`, folders ending in `/`, sorted.
    pub files: Vec<String>,
    /// The open file's path, and its text as last loaded or saved.
    pub open: Option<String>,
    pub saved: String,
    /// The completion Wisp suggests at the caret: shown as ghost text, Tab takes it.
    /// (file, byte offset it applies at, text to insert)
    pub suggestion: Option<(String, usize, String)>,
    /// Wisp's review of the open file, as notes on lines.
    pub review: Vec<ReviewNote>,
    /// Wisp is reviewing right now.
    pub reviewing: bool,
    /// What Wisp is doing in the editor, for its morphing mascot: "idle", "writing",
    /// "reviewing", "fixing", "thinking".
    pub wisp: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReviewNote {
    /// 1-based line.
    pub line: u32,
    /// "error", "warning" or "info".
    pub severity: String,
    pub message: String,
    /// A replacement for the whole line, if Wisp has one.
    pub fix: Option<String>,
}

/// One line in the terminal pane.
#[derive(Clone, Debug, PartialEq)]
pub struct TermLine {
    pub kind: TermKind,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TermKind {
    /// A command you typed (shown after the prompt).
    Input,
    /// A command Wisp or an agent ran.
    Agent,
    Out,
    Err,
    /// "exited with 0".
    Exit,
}

/// Something running in the background.
#[derive(Clone, Debug, PartialEq)]
pub struct BgTask {
    pub id: String,
    /// "agent" (a helper Wisp handed work to) or "command".
    pub kind: &'static str,
    pub title: String,
    /// The agent's id, for its mascot (agents only).
    pub agent: Option<String>,
    pub detail: String,
    pub running: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Publish {
    pub running: bool,
    pub url: Option<String>,
    pub message: String,
}

impl Snapshot {
    pub fn chat(&self, title: &str) -> Option<&ChatMeta> {
        self.extra.chats.iter().find(|c| c.title == title)
    }
    pub fn is_running(&self, title: &str) -> bool {
        self.chat(title).is_some_and(|c| c.running)
    }
    /// Approvals still waiting for an answer, across every chat: (chat, request id, title).
    pub fn waiting(&self) -> Vec<(String, String, String)> {
        let mut out = Vec::new();
        for (chat, items) in &self.threads {
            for it in items {
                if let ThreadItem::Approval { id, title, answer: None, .. } = it {
                    out.push((chat.clone(), id.clone(), title.clone()));
                }
            }
        }
        out
    }
}
