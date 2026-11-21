//! The app's state, and the handlers that change it.

use std::collections::{HashMap, HashSet};

use rune::{Chord, Key, KeyEvent, TextEdit, Tx};

use crate::browser::Browser;
use crate::model::{Shape, Snapshot};
use crate::prefs::{Approval, Prefs};
use crate::store::{Store, Target, mock::MockStore};

/// The views, one per icon in the left rail. Settings takes the whole window (Codex-style), with
/// "Back to app" returning to the view it was opened from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    /// Mission control and each agent's conversation.
    Agents,
    /// Codex-style chats led by Wisp: "What should we build?", recents, projects, transcripts.
    /// The first rail icon and the view the app opens on.
    Chat,
    Code,
    Prs,
    /// Plugins, apps, MCP servers and skills.
    Integrations,
    Settings,
}

/// Settings' pages, in the order its left list shows them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SettingsPage {
    General,
    Profile,
    Appearance,
    Configuration,
    Models,
    Personalization,
    Skills,
    Shortcuts,
    Mcp,
    Hooks,
    Connections,
    Git,
    Environments,
    Worktrees,
    Browser,
    ComputerUse,
    Archived,
    Usage,
    Cloud,
}

impl SettingsPage {
    pub const ALL: [SettingsPage; 19] = [
        SettingsPage::General, SettingsPage::Profile, SettingsPage::Appearance, SettingsPage::Configuration,
        SettingsPage::Models, SettingsPage::Personalization, SettingsPage::Skills, SettingsPage::Shortcuts, SettingsPage::Mcp, SettingsPage::Hooks,
        SettingsPage::Connections, SettingsPage::Git, SettingsPage::Environments, SettingsPage::Worktrees,
        SettingsPage::Browser, SettingsPage::ComputerUse, SettingsPage::Archived, SettingsPage::Usage, SettingsPage::Cloud,
    ];
    pub fn label(self) -> &'static str {
        match self {
            SettingsPage::General => "General",
            SettingsPage::Profile => "Profile",
            SettingsPage::Appearance => "Appearance",
            SettingsPage::Configuration => "Configuration",
            SettingsPage::Models => "Models",
            SettingsPage::Personalization => "Personalization",
            SettingsPage::Skills => "Skills",
            SettingsPage::Shortcuts => "Keyboard shortcuts",
            SettingsPage::Mcp => "MCP servers",
            SettingsPage::Hooks => "Hooks",
            SettingsPage::Connections => "Connections",
            SettingsPage::Git => "Git",
            SettingsPage::Environments => "Environments",
            SettingsPage::Worktrees => "Worktrees",
            SettingsPage::Browser => "Browser",
            SettingsPage::ComputerUse => "Computer use",
            SettingsPage::Archived => "Archived chats",
            SettingsPage::Usage => "Usage & billing",
            SettingsPage::Cloud => "Cloud & devices",
        }
    }
    /// The icon beside it in Settings' list (names from `icons::pack`).
    pub fn icon(self) -> &'static str {
        match self {
            SettingsPage::General => "oai-settings",
            SettingsPage::Profile => "users",
            SettingsPage::Appearance => "sun",
            SettingsPage::Configuration => "shield-check",
            SettingsPage::Models => "chip",
            SettingsPage::Personalization => "sparkle",
            SettingsPage::Skills => "book",
            SettingsPage::Shortcuts => "terminal",
            SettingsPage::Mcp => "link",
            SettingsPage::Hooks => "refresh",
            SettingsPage::Connections => "external",
            SettingsPage::Git => "branch",
            SettingsPage::Environments => "oai-cloud",
            SettingsPage::Worktrees => "folder",
            SettingsPage::Browser => "search",
            SettingsPage::ComputerUse => "oai-desktop",
            SettingsPage::Archived => "history",
            SettingsPage::Usage => "gauge",
            SettingsPage::Cloud => "oai-cloud",
        }
    }
    /// Its name for `--scene settings-<name>`.
    pub fn slug(self) -> &'static str {
        match self {
            SettingsPage::General => "general",
            SettingsPage::Profile => "profile",
            SettingsPage::Appearance => "appearance",
            SettingsPage::Configuration => "configuration",
            SettingsPage::Models => "models",
            SettingsPage::Personalization => "personalization",
            SettingsPage::Skills => "skills",
            SettingsPage::Shortcuts => "shortcuts",
            SettingsPage::Mcp => "mcp",
            SettingsPage::Hooks => "hooks",
            SettingsPage::Connections => "connections",
            SettingsPage::Git => "git",
            SettingsPage::Environments => "environments",
            SettingsPage::Worktrees => "worktrees",
            SettingsPage::Browser => "browser",
            SettingsPage::ComputerUse => "computer-use",
            SettingsPage::Archived => "archived",
            SettingsPage::Usage => "usage",
            SettingsPage::Cloud => "cloud",
        }
    }
}

/// Integrations' tabs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntegrationsTab {
    Plugins,
    Apps,
    Mcp,
    Skills,
}

impl IntegrationsTab {
    pub const ALL: [IntegrationsTab; 4] = [IntegrationsTab::Plugins, IntegrationsTab::Apps, IntegrationsTab::Mcp, IntegrationsTab::Skills];
    pub fn label(self) -> &'static str {
        match self {
            IntegrationsTab::Plugins => "Plugins",
            IntegrationsTab::Apps => "Apps",
            IntegrationsTab::Mcp => "MCP servers",
            IntegrationsTab::Skills => "Skills",
        }
    }
}

/// A pull request's tabs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrTab {
    Summary,
    Changes,
}

/// Each text field keeps its own draft.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EditKey {
    /// The titlebar's Ctrl K search.
    Search,
    /// Mission control's composer (talks to Wisp).
    Mission,
    /// An agent's conversation composer.
    AgentThread,
    /// "What should we build?" (starts a new chat).
    ChatHome,
    /// An open chat's composer.
    ChatThread,
    /// Integrations' search.
    AppSearch,
    /// The browser's address bar.
    Address,
    /// Settings' search.
    SettingsSearch,
    /// Settings > Personalization.
    AboutMe,
    Instructions,
    /// The terminal pane's command line.
    Terminal,
    /// The code editor (the open file).
    Code,
    /// Sign-in: the email, then the code that was emailed.
    SignInEmail,
    SignInCode,
    /// Settings > Personalization's "add a memory".
    Memory,
    /// The New agent dialog: its name and what it's good at.
    AgentName,
    AgentFocus,
    /// The New loop dialog: what it does, and when.
    LoopTask,
    LoopWhen,
    /// The code view's inline edit: what to change (Ctrl K).
    CodeAsk,
    /// New file / Rename: the path.
    FilePath,
    /// A chat's new name (its menu's Rename).
    ChatTitle,
    /// The Pull requests page's "Clone a repository" field.
    CloneUrl,
    /// The code view's agent panel.
    CodeAgent,
    /// Background tasks: a message to the open subagent, or to its team.
    Subagent,
    TeamPost,
    /// The Ports panel's "Add a port".
    PortAdd,
    /// Settings > Skills' search.
    SkillSearch,
    /// Settings > General > Voice: the Groq API key.
    GroqKey,
}

/// The code view's file dialogs.
#[derive(Clone, Debug, PartialEq)]
pub enum CodeDialog {
    New,
    Rename(String),
    Delete(String),
}

impl EditKey {
    pub const ALL: [EditKey; 29] = [
        EditKey::Search, EditKey::Mission, EditKey::AgentThread, EditKey::ChatHome, EditKey::ChatThread,
        EditKey::AppSearch, EditKey::Address, EditKey::SettingsSearch, EditKey::AboutMe, EditKey::Instructions,
        EditKey::Terminal, EditKey::Code, EditKey::SignInEmail, EditKey::SignInCode, EditKey::Memory,
        EditKey::AgentName, EditKey::AgentFocus, EditKey::LoopTask, EditKey::LoopWhen, EditKey::CodeAsk, EditKey::FilePath, EditKey::ChatTitle,
        EditKey::CloneUrl, EditKey::CodeAgent, EditKey::Subagent, EditKey::TeamPost, EditKey::PortAdd, EditKey::SkillSearch, EditKey::GroqKey,
    ];
    pub fn name(self) -> &'static str {
        match self {
            EditKey::Search => "search",
            EditKey::Mission => "mission",
            EditKey::AgentThread => "agent-thread",
            EditKey::ChatHome => "chat-home",
            EditKey::ChatThread => "chat-thread",
            EditKey::AppSearch => "app-search",
            EditKey::Address => "address",
            EditKey::SettingsSearch => "settings-search",
            EditKey::AboutMe => "about-me",
            EditKey::Instructions => "instructions",
            EditKey::Terminal => "terminal",
            EditKey::Code => "code",
            EditKey::SignInEmail => "sign-in-email",
            EditKey::SignInCode => "sign-in-code",
            EditKey::Memory => "memory",
            EditKey::AgentName => "agent-name",
            EditKey::AgentFocus => "agent-focus",
            EditKey::LoopTask => "loop-task",
            EditKey::LoopWhen => "loop-when",
            EditKey::CodeAsk => "code-ask",
            EditKey::FilePath => "file-path",
            EditKey::ChatTitle => "chat-title",
            EditKey::CloneUrl => "clone-url",
            EditKey::CodeAgent => "code-agent",
            EditKey::Subagent => "subagent",
            EditKey::TeamPost => "team-post",
            EditKey::PortAdd => "port-add",
            EditKey::SkillSearch => "skill-search",
            EditKey::GroqKey => "groq-key",
        }
    }
}

/// A small menu open over the composer or a row ("model", "approval", "chat/<title>", ...).
pub type MenuId = String;

/// The panes a chat can open beside it (Codeply's workspace): the browser, the terminal and
/// background tasks. The chat keeps at least half the width; open panes share the rest.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Panes {
    pub browser: bool,
    pub terminal: bool,
    pub tasks: bool,
    /// The browser shows the page at phone width (390 pt), centred.
    pub mobile: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pane {
    Browser,
    Terminal,
    Tasks,
}

pub struct App {
    pub view: View,
    pub data: Snapshot,
    pub(crate) store: Box<dyn Store>,
    edits: HashMap<EditKey, TextEdit>,
    pub prefs: Prefs,
    /// Themes, fonts and backgrounds at work (see `look.rs`).
    pub look: crate::look::Look,
    /// The agent whose conversation is open in Agents, or None for Mission control.
    pub agent: Option<String>,
    /// The agent whose Appearance popover is open (from its "more" button in the Agents list).
    pub appearance: Option<String>,
    /// The open chat, or the Chat home ("What should we build?").
    pub chat: Option<String>,
    pub pr: u32,
    pub pr_tab: PrTab,
    pub settings: SettingsPage,
    /// Where Settings' "Back to app" goes.
    pub back: View,
    pub integrations: IntegrationsTab,
    /// Integrations > Apps' category filter (None: all).
    pub app_category: Option<String>,
    /// Integrations > Apps: the open dialog and its fields, and the search last sent to the catalogue.
    pub apps_ui: crate::views::apps::AppsUi,
    apps_sent: String,
    apps_seen: String,
    apps_seen_at: f64,
    /// The open menu, if any. Escape or a click outside closes it.
    pub menu: Option<MenuId>,
    /// Folded groups the user opened ("Worked for 2m 30s", tool calls), by key.
    pub expanded: HashSet<String>,
    /// The last thing that failed, shown under the composer until the next send.
    pub notice: Option<String>,
    /// Settings > Models: the add/edit form.
    pub models_ui: crate::models::ModelsUi,
    /// The built-in browser: its tabs, and the native web view on Windows.
    pub browser: Browser,
    /// Which panes are open beside the chat.
    pub panes: Panes,
    /// Background tasks: the subagent whose log is open, whether the Subagents list is folded,
    /// and the team whose channel is open.
    pub sub_open: Option<String>,
    pub sub_folded: bool,
    pub team_open: Option<String>,
    /// Whether the system asks for reduced motion, as the view last saw it.
    pub reduced: std::cell::Cell<bool>,
    /// Chats waiting for their reply's first words, and when each started waiting: the thinking
    /// line's word and seconds follow `think_now` (the last poll's clock).
    pub think_started: std::collections::HashMap<String, f64>,
    pub think_now: f64,
    /// The code view's "Edit with Wisp" bar (Ctrl K), while it's open.
    pub code_ask: bool,
    /// The session open on each agent's page, by agent id (empty: a new one, made by the next
    /// message). None: the agent's latest.
    pub agent_session: std::collections::HashMap<String, String>,
    /// Chat's search: the field shows and filters the sidebar.
    pub chat_search: bool,
    /// Files attached to each composer's next message (the "+" picks them).
    pub attachments: std::collections::HashMap<EditKey, Vec<String>>,
    /// The files open as tabs in the code view, and each one's unsaved text when it isn't showing.
    pub code_tabs: Vec<String>,
    pub code_drafts: std::collections::HashMap<String, String>,
    /// New file, Rename or Delete, while its dialog is open.
    pub code_dialog: Option<CodeDialog>,
    /// The chat being renamed, while its dialog is open.
    pub chat_rename: Option<String>,
    /// The New agent / New loop dialog, while it's open (team.rs).
    pub team_dialog: Option<crate::team::TeamDialog>,
    /// Whether the usage sheet is open (the button beside you at the sidebar's foot).
    pub usage_open: bool,
    /// The usage sheet's grouping (weekly or daily) and the week ("w12") or day ("d2026-10-11")
    /// picked for its tokens per model.
    pub usage_daily: bool,
    pub usage_pick: Option<String>,
    /// Whether the first poll has run (the window's launch-time setup).
    launched: bool,
    /// The code editor: which file its text was loaded from, the text the last completion was
    /// asked for, and when the text last changed (completions wait for a pause in typing).
    pub(crate) code_loaded: Option<String>,
    /// The open file's text on disk as the editor last took it: when it changes (the agent
    /// edited the file) and you haven't typed since, the editor follows.
    code_saved_seen: String,
    /// The code view's agent was working at the last poll.
    code_agent_busy: bool,
    code_asked: String,
    code_changed_at: f64,
    pub(crate) code_text_seen: String,
    /// The suggestions popup under the editor's caret (editor.rs), and the other open tabs'
    /// text as they were loaded, for their words.
    pub completion: Option<crate::complete::Popup>,
    /// A composer's "/" or "@" menu, while it's open (mentions.rs).
    pub mention: Option<crate::mentions::Popup>,
    /// What the last message sent gave the engine: its text, files and refs (mentions::body).
    pub last_sent: Option<serde_json::Value>,
    /// Settings > Skills: where they came from ("" all, "built-in", "plugin", "user"), and how
    /// many show before "Show more".
    pub skills_from: &'static str,
    pub skills_limit: usize,
    pub code_others: std::collections::HashMap<String, String>,
    /// The command the code view's Run last started (Stop ends it while it runs).
    pub run_cmd: Option<String>,
    /// The page to open once Live Server is up.
    pub live_open: Option<String>,
    /// The terminal pane shows Ports instead of the terminal; the ports you added, and the
    /// ones you took off the list.
    pub ports_tab: bool,
    pub ports_added: Vec<u16>,
    pub ports_hidden: Vec<u16>,
    /// The package.json files last asked for (run.rs), so they're read once per change.
    pub(crate) manifests_key: String,
    /// The engine this app started, kept running while the app is.
    #[cfg(feature = "live")]
    pub sidecar: Option<crate::engine::Sidecar>,
    /// Updates: checking, downloading, waiting for a restart or for "Update now" (update.rs).
    pub updater: crate::update::Updater,
    /// The upgrade sheet: open, and the plan picked (views/upgrade.rs).
    pub upgrade: crate::views::upgrade::Upgrade,
    /// The composer's mic: recording, or waiting on Whisper (voice.rs).
    pub voice: crate::voice::Voice,
}

impl App {
    pub fn new(mut store: Box<dyn Store>) -> App {
        let mut data = store.load();
        let prefs = Prefs::load();
        apply_looks(&mut data, &prefs);
        store.configure(&prefs);
        let browser = Browser::new(&prefs.home);
        let mut edits: HashMap<EditKey, TextEdit> = EditKey::ALL.iter().map(|&k| (k, TextEdit::new(""))).collect();
        edits.insert(EditKey::AboutMe, TextEdit::new(prefs.about_me.clone()));
        edits.insert(EditKey::Instructions, TextEdit::new(prefs.instructions.clone()));
        edits.insert(EditKey::GroqKey, TextEdit::new(prefs.groq_key.clone()));
        App {
            view: View::Chat,
            data,
            store,
            edits,
            prefs,
            look: Default::default(),
            agent: None,
            appearance: None,
            chat: None,
            pr: 44,
            pr_tab: PrTab::Summary,
            settings: SettingsPage::General,
            back: View::Chat,
            integrations: IntegrationsTab::Plugins,
            app_category: None,
            apps_ui: Default::default(),
            apps_sent: String::new(),
            apps_seen: String::new(),
            apps_seen_at: 0.0,
            menu: None,
            expanded: HashSet::new(),
            notice: None,
            models_ui: Default::default(),
            browser,
            panes: Panes::default(),
            sub_open: None,
            sub_folded: false,
            team_open: None,
            reduced: std::cell::Cell::new(false),
            think_started: std::collections::HashMap::new(),
            think_now: 0.0,
            usage_open: false,
            team_dialog: None,
            code_ask: false,
            attachments: std::collections::HashMap::new(),
            agent_session: std::collections::HashMap::new(),
            chat_search: false,
            code_tabs: Vec::new(),
            code_drafts: std::collections::HashMap::new(),
            code_dialog: None,
            chat_rename: None,
            usage_daily: false,
            usage_pick: None,
            launched: false,
            code_loaded: None,
            code_saved_seen: String::new(),
            code_agent_busy: false,
            code_asked: String::new(),
            code_changed_at: 0.0,
            code_text_seen: String::new(),
            completion: None,
            mention: None,
            last_sent: None,
            skills_from: "",
            skills_limit: crate::views::skills::PAGE,
            code_others: std::collections::HashMap::new(),
            run_cmd: None,
            live_open: None,
            ports_tab: false,
            ports_added: Vec::new(),
            ports_hidden: Vec::new(),
            manifests_key: String::new(),
            #[cfg(feature = "live")]
            sidecar: None,
            updater: Default::default(),
            upgrade: Default::default(),
            voice: Default::default(),
        }
    }

    pub fn with_mock() -> App {
        App::new(Box::new(MockStore::default()))
    }

    /// Whether replies come from a real engine.
    pub fn is_live(&self) -> bool {
        self.store.is_live()
    }

    pub fn go(&mut self, view: View) {
        if view == View::Settings && self.view != View::Settings {
            self.back = self.view;
        }
        if view == View::Prs && self.view != View::Prs {
            self.prs_op(crate::model::PrOp::Refresh);
        }
        // The code view's agent conversation, from the engine.
        if view == View::Code && self.view != View::Code {
            let chat = crate::views::code::agent_chat(self);
            self.store.open(&chat);
        }
        self.view = view;
        self.appearance = None;
        self.menu = None;
        self.completion = None;
        self.mention = None;
    }

    /// Opens Settings on one page.
    pub fn open_settings(&mut self, page: SettingsPage) {
        self.go(View::Settings);
        self.settings = page;
        match page {
            SettingsPage::Cloud => self.cloud_op(crate::model::CloudOp::Load),
            SettingsPage::Usage => self.store.load_usage(&mut self.data),
            SettingsPage::Models => self.store.billing(crate::model::BillingOp::LoadLinked, &mut self.data),
            _ => {}
        }
    }

    /// Settings > Models > Your plans: sign in to your Claude or ChatGPT plan ("claude", "chatgpt").
    pub fn linked_sign_in(&mut self, which: &str) {
        self.store.billing(crate::model::BillingOp::Link(which.to_owned()), &mut self.data);
    }

    pub fn linked_sign_out(&mut self, which: &str) {
        self.store.billing(crate::model::BillingOp::Unlink(which.to_owned()), &mut self.data);
    }

    /// A Cloud & devices operation through the store.
    pub fn cloud_op(&mut self, op: crate::model::CloudOp) {
        self.store.cloud_op(op, &mut self.data);
    }

    /// Settings' "Back to app".
    pub fn leave_settings(&mut self) {
        let back = if self.back == View::Settings { View::Chat } else { self.back };
        self.go(back);
    }

    /// Opens an agent's conversation in Agents (None: Mission control).
    pub fn open_agent(&mut self, id: Option<&str>) {
        self.view = View::Agents;
        self.agent = id.map(str::to_owned);
        self.menu = None;
        if let Some(a) = id.and_then(|i| self.data.agent(i)).cloned() {
            let title = crate::views::agents::open_session(self, &a);
            if !title.is_empty() {
                self.store.open(&title);
            }
        }
    }

    /// Shows one of an agent's sessions on its page ("" starts a new one with the next message).
    pub fn open_agent_session(&mut self, agent: &str, title: &str) {
        self.agent_session.insert(agent.to_owned(), title.to_owned());
        if !title.is_empty() {
            self.store.open(title);
            if let Some(c) = self.data.extra.chats.iter_mut().find(|c| c.title == title) {
                c.unread = false;
            }
        }
    }

    pub fn open_chat(&mut self, chat: &str) {
        self.view = View::Chat;
        self.chat = Some(chat.to_owned());
        self.menu = None;
        if let Some(c) = self.data.extra.chats.iter_mut().find(|c| c.title == chat) {
            c.unread = false;
        }
        self.store.open(chat);
    }

    /// "New chat": back to "What should we build?".
    pub fn new_chat(&mut self) {
        self.view = View::Chat;
        self.chat = None;
        self.menu = None;
    }

    /// Answers an approval: "once", "always" or "reject".
    pub fn answer(&mut self, request: &str, verdict: &str) {
        self.store.answer(request, verdict, &mut self.data);
    }

    /// Stops the reply being written in a chat.
    pub fn stop(&mut self, chat: &str) {
        self.store.abort(chat);
    }

    /// Repaints a helper (the Appearance colour picker), and remembers it.
    pub fn set_color(&mut self, id: &str, color: &str) {
        if let Some(a) = self.data.team.iter_mut().find(|a| a.id == id) {
            a.color = color.to_owned();
            let shape = a.look.shape.name();
            self.prefs.set_look(id, color, shape);
            self.prefs.save();
        }
    }

    /// Reshapes a helper (the Appearance shape picker), and remembers it.
    pub fn set_shape(&mut self, id: &str, shape: Shape) {
        if let Some(a) = self.data.team.iter_mut().find(|a| a.id == id) {
            a.look.shape = shape;
            let color = a.color.clone();
            self.prefs.set_look(id, &color, shape.name());
            self.prefs.save();
        }
    }

    pub fn toggle_appearance(&mut self, id: &str) {
        self.appearance = if self.appearance.as_deref() == Some(id) { None } else { Some(id.to_owned()) };
    }

    /// Opens a menu, or closes it when it's the one open.
    pub fn toggle_menu(&mut self, id: &str) {
        self.menu = if self.menu.as_deref() == Some(id) { None } else { Some(id.to_owned()) };
        if id.starts_with("model:") && self.menu.is_some() {
            self.model_menu_opened();
        }
    }

    /// Opens or folds a group ("Worked for ...", a tool call's detail).
    pub fn toggle_expanded(&mut self, key: &str) {
        if !self.expanded.remove(key) {
            self.expanded.insert(key.to_owned());
        }
    }

    /// When the engine asks before it acts, and tells the engine.
    /// Tells the engine the settings it follows (approval, effort, the team, co-author).
    pub fn configure_engine(&mut self) {
        self.store.configure(&self.prefs);
    }

    pub fn set_approval(&mut self, a: Approval) {
        self.prefs.approval = a;
        self.menu = None;
        self.prefs.save();
        self.store.configure(&self.prefs);
    }

    pub fn set_effort(&mut self, effort: &str) {
        self.prefs.effort = effort.to_owned();
        self.menu = None;
        self.prefs.save();
        self.store.configure(&self.prefs);
    }

    /// Changes preferences with `f`, then saves them and tells the engine.
    pub fn update_prefs(&mut self, f: impl FnOnce(&mut Prefs)) {
        f(&mut self.prefs);
        self.prefs.save();
        self.store.configure(&self.prefs);
    }

    /// A chat's menu > Rename: the dialog, with its name ready to change.
    pub fn open_chat_rename(&mut self, chat: &str) {
        self.edit_mut(EditKey::ChatTitle).replace_text(chat.to_owned());
        self.menu = None;
        self.chat_rename = Some(chat.to_owned());
    }

    pub fn submit_chat_rename(&mut self) {
        let Some(old) = self.chat_rename.take() else { return };
        let new = self.edit(EditKey::ChatTitle).text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !new.is_empty() && new != old {
            self.store.rename_chat(&old, &new, &mut self.data);
        }
    }

    pub fn toggle_pin(&mut self, chat: &str) {
        self.prefs.toggle_pin(chat);
        self.menu = None;
        self.prefs.save();
    }

    /// Hides a chat from the sidebar (Settings > Archived chats brings it back).
    pub fn archive(&mut self, chat: &str) {
        if !self.prefs.archived.iter().any(|c| c == chat) {
            self.prefs.archived.push(chat.to_owned());
        }
        self.prefs.pinned.retain(|c| c != chat);
        if self.chat.as_deref() == Some(chat) {
            self.chat = None;
        }
        self.menu = None;
        self.prefs.save();
    }

    /// Deletes a chat (or an agent's session) for good.
    pub fn delete_chat(&mut self, chat: &str) {
        self.store.delete_chat(chat, &mut self.data);
        self.prefs.pinned.retain(|c| c != chat);
        self.prefs.archived.retain(|c| c != chat);
        if self.chat.as_deref() == Some(chat) {
            self.chat = None;
        }
        self.agent_session.retain(|_, t| t != chat);
        self.menu = None;
        self.prefs.save();
    }

    pub fn unarchive(&mut self, chat: &str) {
        self.prefs.archived.retain(|c| c != chat);
        self.prefs.save();
    }

    /// Whether a plugin, an app or an MCP server is on; flips it (sample data until the engine
    /// has an API for them).
    pub fn toggle_plugin(&mut self, id: &str) {
        if let Some(p) = self.data.extra.plugins.iter_mut().find(|p| p.id == id) {
            p.installed = !p.installed;
        }
    }

    /// Connects an app (its sign-in opens in your browser), or disconnects it.
    #[allow(dead_code)]
    pub fn toggle_app(&mut self, slug: &str) {
        let connected = self.data.extra.catalog.iter().any(|a| a.slug == slug && a.connected);
        if connected {
            self.store.disconnect_app(slug, &mut self.data);
        } else {
            self.store.connect_app(slug, &mut self.data);
        }
    }

    pub fn toggle_mcp(&mut self, name: &str) {
        if let Some(m) = self.data.extra.mcp.iter_mut().find(|m| m.name == name) {
            m.on = !m.on;
        }
    }


    /// Runs `f` with the store and the data it fills (for modules that add their own handlers).
    pub fn with_store<R>(&mut self, f: impl FnOnce(&mut dyn Store, &mut Snapshot) -> R) -> R {
        f(self.store.as_mut(), &mut self.data)
    }

    pub fn edit(&self, key: EditKey) -> &TextEdit {
        // Every key gets its edit in `new`, so this always finds one.
        &self.edits[&key]
    }

    pub fn edit_mut(&mut self, key: EditKey) -> &mut TextEdit {
        self.edits.entry(key).or_insert_with(|| TextEdit::new(""))
    }

    /// The chat a composer talks in, by title, if it has one yet.
    pub fn chat_of(&self, to: &Target) -> Option<String> {
        match to {
            Target::Chat(c) if !c.is_empty() => Some(c.clone()),
            Target::Chat(_) => self.chat.clone(),
            Target::Wisp => Some("Wisp".to_owned()),
            Target::Agent(id) => self.data.agent(id).map(|a| a.name.clone()),
            Target::New => None,
            Target::Project(title) => Some(title.clone()),
            Target::AgentSession { title, .. } => (!title.is_empty()).then(|| title.clone()),
        }
    }

    /// Sends a composer's text to whoever it talks to, then clears it.
    pub fn submit(&mut self, key: EditKey, to: &Target) {
        // `/review` becomes its prompt; `/skill` and `@mention` tokens go to the engine as refs.
        let (mut text, refs) = self.outgoing(self.edit(key).text.trim());
        let files = self.attachments.get(&key).cloned().unwrap_or_default();
        if text.is_empty() && files.is_empty() {
            return;
        }
        // The code view's agent knows which file you're looking at.
        if key == EditKey::CodeAgent
            && let Some(open) = &self.data.extra.code.open
        {
            text.push_str(&format!("\n\n(Open in the editor: {open})"));
        }
        // Attached and pasted files go beside the message: the engine hands the model the
        // pictures themselves and the other files' paths, and the chat shows them above it.
        if !files.is_empty() && text.is_empty() {
            text = "Have a look at the attached files.".into();
        }
        let to = match to {
            Target::Chat(c) if c.is_empty() => Target::Chat(self.chat.clone().unwrap_or_default()),
            // A new session with an agent: named after the agent and what you asked, and it
            // shows on the agent's page from now on.
            Target::AgentSession { agent, title } if title.is_empty() => {
                let name = self.data.agent(agent).map_or_else(|| agent.clone(), |a| a.name.clone());
                let first = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("New chat");
                let short: String = if first.chars().count() > 50 { format!("{}...", first.chars().take(47).collect::<String>().trim_end()) } else { first.to_owned() };
                let mut title = format!("{name}: {short}");
                let mut n = 2;
                while self.data.extra.chats.iter().any(|c| c.title == title) {
                    title = format!("{name}: {short} ({n})");
                    n += 1;
                }
                self.agent_session.insert(agent.clone(), title.clone());
                Target::AgentSession { agent: agent.clone(), title }
            }
            other => other.clone(),
        };
        match self.store.send_refs(&to, &text, &files, &refs, &mut self.data) {
            Ok(()) => {
                self.last_sent = Some(crate::mentions::body(&text, &files, &refs));
                if self.mention.as_ref().is_some_and(|p| p.key == key) {
                    self.mention = None;
                }
                self.notice = None;
                self.edit_mut(key).clear();
                self.attachments.remove(&key);
            }
            Err(e) => self.notice = Some(e),
        }
    }

    /// A paste into a composer: a picture (copied from a web page, a screenshot) is saved and
    /// attached, copied files are attached; plain text pastes as usual (false).
    pub fn paste_into(&mut self, key: EditKey, content: &rune::ClipboardContent) -> bool {
        let mut took = false;
        if let Some(img) = content.image() {
            let dir = crate::prefs::data_dir().join("pasted");
            let _ = std::fs::create_dir_all(&dir);
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
            let file = dir.join(format!("pasted-{stamp}.png"));
            match std::fs::write(&file, img.png()) {
                Ok(()) => {
                    self.attachments.entry(key).or_default().push(file.to_string_lossy().into_owned());
                    took = true;
                }
                Err(e) => self.notice = Some(format!("Couldn't keep the pasted picture: {e}")),
            }
        }
        for f in content.files() {
            let p = f.to_string_lossy().into_owned();
            let list = self.attachments.entry(key).or_default();
            if !list.contains(&p) {
                list.push(p);
            }
            took = true;
        }
        // A picture with a caption (a browser copies both): the picture is attached, the text
        // pastes too.
        took && content.text().trim().is_empty()
    }

    /// The composer's "+": pick files to attach to the next message.
    pub fn pick_attachments(&mut self, key: EditKey, tx: &mut Tx) {
        let options = rune::FileDialogOptions { title: "Attach files".into(), ..Default::default() };
        tx.open_file(options, move |s: &mut App, result, _| match result {
            Ok(Some(path)) => {
                let p = path.to_string_lossy().into_owned();
                let list = s.attachments.entry(key).or_default();
                if !list.contains(&p) {
                    list.push(p);
                }
            }
            Ok(None) => {}
            Err(e) => s.notice = Some(format!("Couldn't open the file picker: {e}")),
        });
    }

    /// Opens `url` in the browser pane beside the chat (from a link in a reply, a bookmark or
    /// the address bar).
    pub fn browse(&mut self, url: &str) {
        self.view = View::Chat;
        self.panes.browser = true;
        self.browser.navigate(url);
    }

    /// Opens or closes a subagent's log in Background tasks (one at a time).
    pub fn toggle_subagent(&mut self, id: &str) {
        self.sub_open = if self.sub_open.as_deref() == Some(id) { None } else { Some(id.to_owned()) };
        self.team_open = None;
        self.edit_mut(EditKey::Subagent).clear();
    }

    /// Opens or closes a team's channel in Background tasks.
    pub fn toggle_team(&mut self, id: &str) {
        self.team_open = if self.team_open.as_deref() == Some(id) { None } else { Some(id.to_owned()) };
        self.sub_open = None;
    }

    /// Sends what's in the open subagent's typing bar: into its run while it works, else its next round.
    pub fn send_subagent(&mut self) {
        let Some(id) = self.sub_open.clone() else { return };
        let text = self.edit(EditKey::Subagent).text.trim().to_owned();
        if text.is_empty() {
            return;
        }
        self.edit_mut(EditKey::Subagent).clear();
        self.agents_op(crate::subagents::Op::Send(id, text));
    }

    /// Posts what's in the team bar on the open team's channel.
    pub fn post_team(&mut self) {
        let Some(id) = self.team_open.clone() else { return };
        let text = self.edit(EditKey::TeamPost).text.trim().to_owned();
        if text.is_empty() {
            return;
        }
        self.edit_mut(EditKey::TeamPost).clear();
        self.agents_op(crate::subagents::Op::Team(id, text));
    }

    pub fn agents_op(&mut self, op: crate::subagents::Op) {
        if let crate::subagents::Op::Remove(id) = &op && self.sub_open.as_deref() == Some(id.as_str()) {
            self.sub_open = None;
        }
        self.store.agents_op(op, &mut self.data);
    }

    pub fn toggle_pane(&mut self, pane: Pane) {
        match pane {
            Pane::Browser => self.panes.browser = !self.panes.browser,
            Pane::Terminal => self.panes.terminal = !self.panes.terminal,
            Pane::Tasks => self.panes.tasks = !self.panes.tasks,
        }
    }

    /// Runs what's in the terminal pane's command line ("clear" clears it).
    pub fn run_command(&mut self) {
        let cmd = self.edit(EditKey::Terminal).text.trim().to_owned();
        if cmd.is_empty() {
            return;
        }
        self.edit_mut(EditKey::Terminal).clear();
        if cmd == "clear" || cmd == "cls" {
            self.data.extra.terminal.clear();
            return;
        }
        self.store.run_command(&cmd, &mut self.data);
    }

    pub fn clear_terminal(&mut self) {
        self.data.extra.terminal.clear();
    }

    pub fn kill_task(&mut self, id: &str) {
        self.store.kill(id, &mut self.data);
    }

    // ---------- code ----------

    /// Opens a project file in the editor.
    pub fn open_file(&mut self, path: &str) {
        self.view = View::Code;
        // The file you leave stays a tab (the one open at launch too).
        if let Some(cur) = self.data.extra.code.open.clone() {
            self.add_tab(&cur);
        }
        // The tab you leave keeps its unsaved text, so coming back finds it.
        if let Some(cur) = self.data.extra.code.open.clone()
            && cur != path
            && self.code_dirty()
        {
            let text = self.edit(EditKey::Code).text.clone();
            self.code_drafts.insert(cur, text);
        }
        self.completion = None;
        self.add_tab(path);
        self.store.open_file(path, &mut self.data);
    }

    fn add_tab(&mut self, path: &str) {
        if !self.code_tabs.iter().any(|p| p == path) {
            self.code_tabs.push(path.to_owned());
        }
    }

    /// The tabs to show: the open files, the one showing among them.
    pub fn tabs(&self) -> Vec<String> {
        let mut tabs = self.code_tabs.clone();
        if let Some(open) = &self.data.extra.code.open
            && !tabs.contains(open)
        {
            tabs.push(open.clone());
        }
        tabs
    }

    /// Closes a tab (its unsaved text goes with it); the next one shows.
    pub fn close_tab(&mut self, path: &str) {
        let tabs = self.tabs();
        let at = tabs.iter().position(|p| p == path).unwrap_or(0);
        self.code_tabs.retain(|p| p != path);
        self.code_drafts.remove(path);
        self.code_others.remove(path);
        if self.data.extra.code.open.as_deref() == Some(path) {
            let rest: Vec<String> = tabs.into_iter().filter(|p| p != path).collect();
            match rest.get(at.min(rest.len().saturating_sub(1))).cloned() {
                Some(next) => {
                    // Leaving a closed tab: nothing of it to keep.
                    self.data.extra.code.saved = self.edit(EditKey::Code).text.clone();
                    self.open_file(&next);
                }
                None => {
                    self.data.extra.code.open = None;
                    self.code_loaded = None;
                    self.data.extra.code.proposal = None;
                    self.edit_mut(EditKey::Code).clear();
                }
            }
        }
    }

    /// Opens the New file, Rename or Delete dialog.
    pub fn open_code_dialog(&mut self, d: CodeDialog) {
        let start = match &d {
            CodeDialog::Rename(p) => p.clone(),
            CodeDialog::New => self.data.extra.code.open.as_deref().and_then(|p| p.rsplit_once('/')).map_or_else(String::new, |(dir, _)| format!("{dir}/")),
            CodeDialog::Delete(_) => String::new(),
        };
        self.edit_mut(EditKey::FilePath).replace_text(start);
        self.menu = None;
        self.code_dialog = Some(d);
    }

    /// Does what the file dialog says.
    pub fn submit_code_dialog(&mut self) {
        let path = self.edit(EditKey::FilePath).text.trim().trim_start_matches('/').replace('\\', "/");
        let op = match self.code_dialog.clone() {
            Some(CodeDialog::New) if !path.is_empty() && !path.ends_with('/') => {
                self.add_tab(&path);
                crate::model::FileOp::New(path)
            }
            Some(CodeDialog::Rename(from)) if !path.is_empty() && path != from => {
                for p in self.code_tabs.iter_mut().filter(|p| **p == from) {
                    *p = path.clone();
                }
                if let Some(d) = self.code_drafts.remove(&from) {
                    self.code_drafts.insert(path.clone(), d);
                }
                if self.data.extra.code.open.as_deref() == Some(from.as_str()) {
                    // The file reopens under its new name; keep what's in the editor.
                    let text = self.edit(EditKey::Code).text.clone();
                    if self.code_dirty() {
                        self.code_drafts.insert(path.clone(), text);
                    }
                }
                crate::model::FileOp::Rename(from, path)
            }
            Some(CodeDialog::Delete(p)) => {
                self.close_tab(&p);
                crate::model::FileOp::Delete(p)
            }
            _ => return,
        };
        self.code_dialog = None;
        self.store.file_op(op, &mut self.data);
    }

    /// "Apply" on code in a reply: Wisp works it into the open file, and the change shows as a
    /// diff in the editor to accept or reject.
    pub fn apply_snippet(&mut self, code: &str) {
        let Some(file) = self.data.extra.code.open.clone() else {
            self.notice = Some("Open the file to apply it to in Code first.".into());
            self.view = View::Code;
            return;
        };
        let instruction = format!("Apply this change from the chat to the file:\n```\n{}\n```", code.trim_end());
        let before = self.edit(EditKey::Code).text.clone();
        self.view = View::Code;
        self.data.extra.code.suggestion = None;
        self.data.extra.code.wisp = "thinking".into();
        self.data.extra.code.proposal = Some(crate::model::Proposal { file: file.clone(), instruction: instruction.clone(), before: before.clone(), after: None, error: String::new() });
        self.store.edit_code(&file, &before, &instruction, &mut self.data);
    }

    /// Saves the editor's text to its file.
    pub fn save_file(&mut self) {
        if let Some(path) = self.data.extra.code.open.clone() {
            let text = self.edit(EditKey::Code).text.clone();
            self.store.save_file(&path, &text, &mut self.data);
            self.data.extra.code.saved = text;
            // Run reads the scripts again.
            if path.ends_with("package.json") {
                self.manifests_key.clear();
            }
        }
    }

    /// Whether the editor has changes not yet saved.
    pub fn code_dirty(&self) -> bool {
        self.data.extra.code.open.is_some() && self.edit(EditKey::Code).text != self.data.extra.code.saved
    }

    /// Tab: takes Wisp's suggestion at the caret. False when there's none to take.
    pub fn accept_suggestion(&mut self) -> bool {
        let Some((file, at, text)) = self.data.extra.code.suggestion.take() else { return false };
        if self.data.extra.code.open.as_deref() != Some(file.as_str()) {
            return false;
        }
        let edit = self.edit_mut(EditKey::Code);
        let (_, caret) = edit.range();
        if caret != at || !edit.text.is_char_boundary(at) {
            return false;
        }
        edit.insert(&text);
        true
    }

    /// Opens (or closes) the "Edit with Wisp" bar over the editor.
    pub fn toggle_code_ask(&mut self, tx: &mut Tx) {
        self.code_ask = !self.code_ask;
        if self.code_ask {
            self.edit_mut(EditKey::CodeAsk).clear();
            tx.focus("code-ask", true);
        }
    }

    /// Sends the bar's instruction: Wisp rewrites the open file, and the change shows as a diff.
    pub fn submit_code_ask(&mut self) {
        let instruction = self.edit(EditKey::CodeAsk).text.trim().to_owned();
        let Some(file) = self.data.extra.code.open.clone() else { return };
        if instruction.is_empty() {
            return;
        }
        let before = self.edit(EditKey::Code).text.clone();
        self.code_ask = false;
        self.data.extra.code.suggestion = None;
        self.data.extra.code.wisp = "thinking".into();
        self.data.extra.code.proposal = Some(crate::model::Proposal { file: file.clone(), instruction: instruction.clone(), before: before.clone(), after: None, error: String::new() });
        self.store.edit_code(&file, &before, &instruction, &mut self.data);
    }

    /// Takes Wisp's change into the editor (not saved until Ctrl S).
    pub fn accept_proposal(&mut self) -> bool {
        let Some(p) = self.data.extra.code.proposal.take() else { return false };
        match p.after {
            Some(after) if self.data.extra.code.open.as_deref() == Some(p.file.as_str()) => {
                self.edit_mut(EditKey::Code).replace_text(after);
                true
            }
            _ => {
                self.data.extra.code.proposal = Some(p);
                false
            }
        }
    }

    /// Drops Wisp's change (or stops waiting for it).
    pub fn reject_proposal(&mut self) -> bool {
        self.data.extra.code.wisp = "idle".into();
        self.data.extra.code.proposal.take().is_some()
    }

    /// Asks Wisp to review the open file.
    pub fn review_file(&mut self) {
        if let Some(path) = self.data.extra.code.open.clone() {
            let text = self.edit(EditKey::Code).text.clone();
            self.data.extra.code.reviewing = true;
            self.data.extra.code.wisp = "reviewing".into();
            self.store.review(&path, &text, &mut self.data);
        }
    }

    /// Applies a review note's fix to its line.
    pub fn apply_fix(&mut self, line: u32) {
        let Some(fix) = self.data.extra.code.review.iter().find(|n| n.line == line).and_then(|n| n.fix.clone()) else { return };
        let text = self.edit(EditKey::Code).text.clone();
        let mut lines: Vec<&str> = text.split('\n').collect();
        let i = line.saturating_sub(1) as usize;
        if i < lines.len() {
            lines[i] = &fix;
            let joined = lines.join("\n");
            self.edit_mut(EditKey::Code).replace_text(joined);
            self.data.extra.code.review.retain(|n| n.line != line);
            self.data.extra.code.wisp = "fixing".into();
        }
    }

    /// While typing in the editor: after a short pause, ask for a completion at the caret.
    /// Puts the open file's text in the editor now (scenes; `step_code` does it on a poll).
    pub fn poll_code(&mut self) {
        if let Some(path) = self.data.extra.code.open.clone() {
            let text = self.code_drafts.remove(&path).unwrap_or_else(|| self.data.extra.code.saved.clone());
            self.code_loaded = Some(path);
            self.edit_mut(EditKey::Code).replace_text(text.clone());
            self.code_text_seen = text.clone();
            self.code_asked = text;
        }
    }

    fn step_code(&mut self, now: f64, tx: &mut Tx) {
        if self.view != View::Code {
            return;
        }
        let Some(path) = self.data.extra.code.open.clone() else { return };
        // A file arrived (or changed on disk): put its text in the editor.
        if self.code_loaded.as_deref() != Some(path.as_str()) {
            self.code_loaded = Some(path.clone());
            // A tab you come back to shows what you'd typed in it.
            let text = self.code_drafts.remove(&path).unwrap_or_else(|| self.data.extra.code.saved.clone());
            self.code_saved_seen = self.data.extra.code.saved.clone();
            // Its words, for suggestions in the other tabs.
            self.code_others.insert(path.clone(), self.data.extra.code.saved.clone());
            self.edit_mut(EditKey::Code).replace_text(text.clone());
            self.code_text_seen = text.clone();
            self.code_asked = text;
            return;
        }
        // The file changed on disk (the agent edited it): show the new text, unless you've typed.
        if self.data.extra.code.saved != self.code_saved_seen {
            let before = std::mem::replace(&mut self.code_saved_seen, self.data.extra.code.saved.clone());
            if self.edit(EditKey::Code).text == before {
                let text = self.data.extra.code.saved.clone();
                self.edit_mut(EditKey::Code).replace_text(text.clone());
                self.code_text_seen = text.clone();
                self.code_asked = text;
                return;
            }
        }
        let text = self.edit(EditKey::Code).text.clone();
        if text != self.code_text_seen {
            self.code_text_seen = text.clone();
            self.code_changed_at = now;
            self.data.extra.code.suggestion = None;
            self.data.extra.code.wisp = "writing".into();
        }
        const PAUSE: f64 = 0.45;
        if text != self.code_asked {
            if now - self.code_changed_at >= PAUSE {
                self.code_asked = text.clone();
                let (_, caret) = self.edit(EditKey::Code).range();
                let caret = caret.min(text.len());
                if text.is_char_boundary(caret) {
                    let (prefix, suffix) = text.split_at(caret);
                    self.data.extra.code.wisp = "thinking".into();
                    self.store.complete(&path, prefix, suffix, &mut self.data);
                }
            } else {
                tx.wake_after(std::time::Duration::from_secs_f64(PAUSE));
            }
        }
    }

    /// A pull request operation through the store.
    pub fn prs_op(&mut self, op: crate::model::PrOp) {
        self.store.prs_op(op, &mut self.data);
    }

    /// Opens a PR (or this branch's changes) on a tab; Changes loads its diff.
    pub fn open_pr(&mut self, n: u32, tab: PrTab) {
        self.pr = n;
        self.pr_tab = tab;
        if tab == PrTab::Changes && self.data.extra.pr_files.as_ref().is_none_or(|(m, _)| *m != n) {
            self.data.extra.pr_files = None;
            self.prs_op(crate::model::PrOp::Diff(n));
        }
    }

    /// Opens the usage sheet (fetching your use afresh), or closes it.
    pub fn toggle_usage(&mut self) {
        self.usage_open = !self.usage_open;
        self.usage_pick = None;
        if self.usage_open {
            self.store.load_usage(&mut self.data);
        }
    }

    // ---------- account, apps, memory ----------

    pub fn send_code(&mut self) {
        let email = self.edit(EditKey::SignInEmail).text.trim().to_owned();
        if !email.is_empty() {
            self.store.send_code(&email, &mut self.data);
        }
    }

    pub fn verify_code(&mut self) {
        let email = self.edit(EditKey::SignInEmail).text.trim().to_owned();
        let code = self.edit(EditKey::SignInCode).text.trim().to_owned();
        if !email.is_empty() && !code.is_empty() {
            self.store.verify_code(&email, &code, &mut self.data);
            self.edit_mut(EditKey::SignInCode).clear();
        }
    }

    pub fn sign_out(&mut self) {
        self.store.sign_out(&mut self.data);
    }

    pub fn search_apps(&mut self) {
        self.browse_apps(false);
    }

    /// Asks the catalogue for the apps matching the search and category: the first page, or (`more`)
    /// the page after the ones shown.
    pub fn browse_apps(&mut self, more: bool) {
        let text = self.edit(EditKey::AppSearch).text.trim().to_owned();
        let offset = if more { self.data.extra.catalog.len() } else { 0 };
        self.apps_sent = text.clone();
        let q = crate::store::AppsQuery { text, category: self.app_category.clone(), offset };
        self.store.browse_apps(&q, &mut self.data);
    }

    /// Search as you type: once the box has rested for 200 ms, the catalogue is asked.
    fn step_apps_search(&mut self, now: f64, tx: &mut Tx) {
        let text = self.edit(EditKey::AppSearch).text.trim().to_owned();
        if text == self.apps_sent {
            return;
        }
        if text != self.apps_seen {
            self.apps_seen = text;
            self.apps_seen_at = now;
        }
        let wait = 0.2 - (now - self.apps_seen_at);
        if wait <= 0.0 {
            self.browse_apps(false);
        } else {
            tx.wake_after(std::time::Duration::from_secs_f64(wait));
        }
    }

    pub fn connect_app_key(&mut self, slug: &str, key: &str) {
        self.store.connect_app_key(slug, key, &mut self.data);
    }

    pub fn add_app(&mut self, url: &str, title: &str, header: &str, key: &str) {
        self.store.add_app(url, title, header, key, &mut self.data);
    }

    pub fn cancel_app(&mut self) {
        self.store.cancel_app(&mut self.data);
    }

    pub fn app_tools(&mut self, slug: &str) {
        self.store.app_tools(slug, &mut self.data);
    }

    pub fn connect_app(&mut self, slug: &str) {
        self.store.connect_app(slug, &mut self.data);
    }

    pub fn disconnect_app(&mut self, slug: &str) {
        self.store.disconnect_app(slug, &mut self.data);
    }

    pub fn remember(&mut self) {
        let text = self.edit(EditKey::Memory).text.trim().to_owned();
        if !text.is_empty() {
            self.store.remember(&text, &mut self.data);
            self.edit_mut(EditKey::Memory).clear();
        }
    }

    pub fn forget(&mut self, id: &str) {
        self.store.forget(id, &mut self.data);
    }

    /// The Publish button: puts the project live.
    pub fn publish(&mut self) {
        let chat = self.chat.clone();
        self.store.publish(chat.as_deref(), &mut self.data);
    }

    pub fn set_waker(&mut self, waker: rune::Waker) {
        crate::favicon::set_waker(waker.clone());
        self.updater.set_waker(waker.clone());
        self.browser.set_waker(waker.clone());
        self.look.set_waker(waker.clone());
        self.voice.set_waker(waker.clone());
        self.store.set_waker(waker);
    }

    /// Before every frame: fold in the store's and the browser's news. True when the view must
    /// be rebuilt.
    pub fn poll(&mut self, now: f64, tx: &mut Tx) -> bool {
        // Windows opens maximized, so the window fits any screen (Rune has no display-size API).
        if !self.launched {
            self.launched = true;
            if cfg!(windows) && !rune::is_headless() {
                tx.toggle_maximized();
            }
        }
        let mut changed = self.store.poll(&mut self.data);
        if changed {
            apply_looks(&mut self.data, &self.prefs);
        }
        self.models_ui.tick(&self.data.extra.models);
        changed |= self.look_poll(tx);
        changed |= self.mention_focus(tx.focused());
        // A change to the team the engine turned down.
        if let Some(note) = self.data.extra.team_note.take() {
            self.notice = Some(note);
            changed = true;
        }
        // Agents that just started in the open chat: Background tasks opens on them.
        let started = std::mem::take(&mut self.data.extra.subagents.started);
        if self.chat.as_ref().is_some_and(|c| started.contains(c)) && !self.panes.tasks {
            self.panes.tasks = true;
            changed = true;
        }
        // An app's logo landed: its tile swaps its letter for the logo.
        changed |= crate::favicon::take_landed();
        // A chat the engine renamed (a new chat takes its first message as its title) stays open.
        for (old, new) in self.store.take_renames() {
            if self.chat.as_deref() == Some(old.as_str()) {
                self.chat = Some(new.clone());
            }
            for a in self.data.extra.subagents.agents.iter_mut().filter(|a| a.chat == old) {
                a.chat = new.clone();
            }
            // Pins, archive and the open thread are kept by title: they follow it.
            for c in self.prefs.pinned.iter_mut().chain(self.prefs.archived.iter_mut()).filter(|c| **c == old) {
                *c = new.clone();
            }
            if !self.data.threads.iter().any(|(k, _)| *k == new) {
                for (k, _) in self.data.threads.iter_mut().filter(|(k, _)| *k == old) {
                    *k = new.clone();
                }
            }
            if let Some(t0) = self.think_started.remove(&old) {
                self.think_started.insert(new, t0);
            }
            self.prefs.save();
            changed = true;
        }
        // Thinking lines: each chat waiting on its reply keeps the time it started; while any
        // waits, the view rebuilds each second (its counter) and so picks up each new word.
        let waiting: Vec<String> = self.data.threads.iter()
            .filter(|(c, items)| self.data.is_running(c) && !matches!(items.last(), Some(crate::model::ThreadItem::Them(_))))
            .map(|(c, _)| c.clone())
            .collect();
        let before = self.think_started.len();
        self.think_started.retain(|c, _| waiting.contains(c));
        for c in waiting {
            self.think_started.entry(c).or_insert(now);
        }
        changed |= before != self.think_started.len();
        if !self.think_started.is_empty() {
            if now.floor() != self.think_now.floor() {
                changed = true;
            }
            tx.wake_after(std::time::Duration::from_secs_f64(1.0 - now.fract().min(0.99)));
        }
        self.think_now = now;
        // A chat the store made for you (a new chat from "What should we build?") opens itself.
        if let Some(title) = self.store.take_focus() {
            if self.view == View::Chat && self.chat.is_none() {
                self.chat = Some(title.clone());
                self.store.open(&title);
            }
            changed = true;
        }
        // The web view shows only while its pane is up and nothing covers it.
        let browser_up = self.view == View::Chat && self.panes.browser && self.menu.is_none() && self.appearance.is_none();
        // Background agents' actions in their own tabs, and what came of them.
        for ask in std::mem::take(&mut self.data.extra.subagents.asks) {
            self.browser.agent_ask(&ask);
            changed = true;
        }
        changed |= self.browser.poll(browser_up);
        for (req, ok, text) in std::mem::take(&mut self.browser.answers) {
            self.store.agents_op(crate::subagents::Op::Browser(req, ok, text), &mut self.data);
        }
        if let Some(url) = self.store.take_open_url() {
            let _ = tx.open_url(&url);
        }
        changed |= self.step_project();
        changed |= self.step_voice();
        changed |= self.step_dev();
        // When the code view's agent finishes, the file tree and the open file catch up with what
        // it changed.
        let agent_busy = self.data.is_running(&crate::views::code::agent_chat(self));
        if self.code_agent_busy && !agent_busy {
            self.refresh_code();
            changed = true;
        }
        self.code_agent_busy = agent_busy;
        changed |= self.step_updates(now, tx);
        changed |= self.step_billing();
        if self.view == View::Integrations && self.integrations == IntegrationsTab::Apps {
            let before = self.data.extra.apps.loading;
            self.step_apps_search(now, tx);
            changed |= before != self.data.extra.apps.loading;
        }
        let had = self.data.extra.code.suggestion.is_some();
        self.step_code(now, tx);
        changed |= had != self.data.extra.code.suggestion.is_some();
        if let Some(what) = self.browser.picked.take() {
            let key = if self.chat.is_some() { EditKey::ChatThread } else { EditKey::ChatHome };
            let before = self.edit(key).text.trim_end().to_owned();
            let joined = if before.is_empty() { format!("{what} ") } else { format!("{before}\n{what} ") };
            self.edit_mut(key).replace_text(joined);
            changed = true;
        }
        changed
    }

    pub fn key(&mut self, e: &KeyEvent, tx: &mut Tx) -> bool {
        if matches!(e.key, Key::Escape) {
            if self.mention.take().is_some() {
                return true;
            }
            if self.menu.is_some() || self.appearance.is_some() {
                self.menu = None;
                self.appearance = None;
                return true;
            }
            if self.view == View::Settings {
                self.leave_settings();
                return true;
            }
        }
        // The editor: Tab takes Wisp's suggestion, Ctrl S saves, Ctrl K asks Wisp for a change,
        // Ctrl Enter accepts it and Escape rejects it.
        if self.view == View::Code {
            if Chord::parse("mod+k").is_ok_and(|c| c.matches_tx(e, tx)) {
                self.toggle_code_ask(tx);
                return true;
            }
            if Chord::parse("mod+enter").is_ok_and(|c| c.matches_tx(e, tx)) && self.accept_proposal() {
                return true;
            }
            if matches!(e.key, Key::Escape) && (std::mem::take(&mut self.code_ask) || self.reject_proposal()) {
                return true;
            }
            if matches!(e.key, Key::Tab) && e.mods == rune::Mods::default() && self.accept_suggestion() {
                return true;
            }
            if Chord::parse("mod+s").is_ok_and(|c| c.matches_tx(e, tx)) {
                self.save_file();
                return true;
            }
            // Ctrl F5, as in VS Code: run the open file or the project.
            if matches!(e.key, Key::Function(5)) && e.mods.ctrl && !e.mods.alt && !e.mods.shift {
                self.run_plan(0);
                return true;
            }
        }
        if Chord::parse("mod+j").is_ok_and(|c| c.matches_tx(e, tx)) {
            self.view = View::Chat;
            self.panes.terminal = !self.panes.terminal;
            return true;
        }
        if Chord::parse("mod+n").is_ok_and(|c| c.matches_tx(e, tx)) {
            self.new_chat();
            return true;
        }
        if Chord::parse("mod+,").is_ok_and(|c| c.matches_tx(e, tx)) {
            self.open_settings(SettingsPage::General);
            return true;
        }
        if self.panes.browser && Chord::parse("mod+l").is_ok_and(|c| c.matches_tx(e, tx)) {
            tx.focus("address", true);
            return true;
        }
        false
    }
}

/// Puts each helper's saved look on the team.
fn apply_looks(data: &mut Snapshot, prefs: &Prefs) {
    for (id, color, shape) in &prefs.looks {
        if let Some(a) = data.team.iter_mut().find(|a| &a.id == id) {
            a.color = color.clone();
            if let Some(s) = Shape::from_name(shape) {
                a.look.shape = s;
            }
        }
    }
}
