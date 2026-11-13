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

/// The one small accessory each helper wears, so it reads at sidebar size.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Gear {
    None,
    Beret,
    Headphones,
    Glasses,
    Sprout,
    Antennae,
    /// Drawn like the others; no sample agent wears it yet.
    #[allow(dead_code)]
    Cap,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Agent {
    pub id: String,
    pub name: String,
    /// `#rrggbb`. Colour belongs to agents only; interface icons stay monochrome.
    pub color: String,
    pub gear: Gear,
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
