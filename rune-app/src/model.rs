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
