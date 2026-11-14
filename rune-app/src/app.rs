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
}

impl SettingsPage {
    pub const ALL: [SettingsPage; 17] = [
        SettingsPage::General, SettingsPage::Profile, SettingsPage::Appearance, SettingsPage::Configuration,
        SettingsPage::Models, SettingsPage::Personalization, SettingsPage::Shortcuts, SettingsPage::Mcp, SettingsPage::Hooks,
        SettingsPage::Connections, SettingsPage::Git, SettingsPage::Environments, SettingsPage::Worktrees,
        SettingsPage::Browser, SettingsPage::ComputerUse, SettingsPage::Archived, SettingsPage::Usage,
    ];
    pub fn label(self) -> &'static str {
        match self {
            SettingsPage::General => "General",
            SettingsPage::Profile => "Profile",
            SettingsPage::Appearance => "Appearance",
            SettingsPage::Configuration => "Configuration",
            SettingsPage::Models => "Models",
            SettingsPage::Personalization => "Personalization",
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
}

impl EditKey {
    pub const ALL: [EditKey; 15] = [
        EditKey::Search, EditKey::Mission, EditKey::AgentThread, EditKey::ChatHome, EditKey::ChatThread,
        EditKey::AppSearch, EditKey::Address, EditKey::SettingsSearch, EditKey::AboutMe, EditKey::Instructions,
        EditKey::Terminal, EditKey::Code, EditKey::SignInEmail, EditKey::SignInCode, EditKey::Memory,
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
    store: Box<dyn Store>,
    edits: HashMap<EditKey, TextEdit>,
    pub prefs: Prefs,
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
    pub app_category: Option<&'static str>,
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
    /// Whether the system asks for reduced motion, as the view last saw it.
    pub reduced: std::cell::Cell<bool>,
    /// Chats waiting for their reply's first words, and when each started waiting: the thinking
    /// line's word and seconds follow `think_now` (the last poll's clock).
    pub think_started: std::collections::HashMap<String, f64>,
    pub think_now: f64,
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
    code_loaded: Option<String>,
    code_asked: String,
    code_changed_at: f64,
    code_text_seen: String,
    /// The engine this app started, kept running while the app is.
    #[cfg(feature = "live")]
    pub sidecar: Option<crate::engine::Sidecar>,
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
        App {
            view: View::Chat,
            data,
            store,
            edits,
            prefs,
            agent: None,
            appearance: None,
            chat: None,
            pr: 44,
            pr_tab: PrTab::Summary,
            settings: SettingsPage::General,
            back: View::Chat,
            integrations: IntegrationsTab::Plugins,
            app_category: None,
            menu: None,
            expanded: HashSet::new(),
            notice: None,
            models_ui: Default::default(),
            browser,
            panes: Panes::default(),
            reduced: std::cell::Cell::new(false),
            think_started: std::collections::HashMap::new(),
            think_now: 0.0,
            usage_open: false,
            usage_daily: false,
            usage_pick: None,
            launched: false,
            code_loaded: None,
            code_asked: String::new(),
            code_changed_at: 0.0,
            code_text_seen: String::new(),
            #[cfg(feature = "live")]
            sidecar: None,
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
        self.view = view;
        self.appearance = None;
        self.menu = None;
    }

    /// Opens Settings on one page.
    pub fn open_settings(&mut self, page: SettingsPage) {
        self.go(View::Settings);
        self.settings = page;
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
        if let Some(name) = id.and_then(|i| self.data.agent(i)).map(|a| a.name.clone()) {
            self.store.open(&name);
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

    pub fn toggle_loop(&mut self, agent: &str, name: &str) {
        if let Some(l) = self.data.extra.loops.iter_mut().find(|l| l.agent == agent && l.name == name) {
            l.on = !l.on;
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
        }
    }

    /// Sends a composer's text to whoever it talks to, then clears it.
    pub fn submit(&mut self, key: EditKey, to: &Target) {
        let text = self.edit(key).text.trim().to_owned();
        if text.is_empty() {
            return;
        }
        let to = match to {
            Target::Chat(c) if c.is_empty() => Target::Chat(self.chat.clone().unwrap_or_default()),
            other => other.clone(),
        };
        match self.store.send(&to, &text, &mut self.data) {
            Ok(()) => {
                self.notice = None;
                self.edit_mut(key).clear();
            }
            Err(e) => self.notice = Some(e),
        }
    }

    /// Opens `url` in the browser pane beside the chat (from a link in a reply, a bookmark or
    /// the address bar).
    pub fn browse(&mut self, url: &str) {
        self.view = View::Chat;
        self.panes.browser = true;
        self.browser.navigate(url);
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
        self.store.open_file(path, &mut self.data);
    }

    /// Saves the editor's text to its file.
    pub fn save_file(&mut self) {
        if let Some(path) = self.data.extra.code.open.clone() {
            let text = self.edit(EditKey::Code).text.clone();
            self.store.save_file(&path, &text, &mut self.data);
            self.data.extra.code.saved = text;
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
    fn step_code(&mut self, now: f64, tx: &mut Tx) {
        if self.view != View::Code {
            return;
        }
        let Some(path) = self.data.extra.code.open.clone() else { return };
        // A file arrived (or changed on disk): put its text in the editor.
        if self.code_loaded.as_deref() != Some(path.as_str()) {
            self.code_loaded = Some(path.clone());
            let text = self.data.extra.code.saved.clone();
            self.edit_mut(EditKey::Code).replace_text(text.clone());
            self.code_text_seen = text.clone();
            self.code_asked = text;
            return;
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
        let q = self.edit(EditKey::AppSearch).text.trim().to_owned();
        self.store.search_apps(&q, &mut self.data);
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
        self.browser.set_waker(waker.clone());
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
        // An app's logo landed: its tile swaps its letter for the logo.
        changed |= crate::favicon::take_landed();
        // A chat the engine renamed (a new chat takes its first message as its title) stays open.
        for (old, new) in self.store.take_renames() {
            if self.chat.as_deref() == Some(old.as_str()) {
                self.chat = Some(new.clone());
            }
            if let Some(t0) = self.think_started.remove(&old) {
                self.think_started.insert(new, t0);
            }
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
        changed |= self.browser.poll(browser_up);
        if let Some(url) = self.store.take_open_url() {
            let _ = tx.open_url(&url);
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
        // Living eyes: glances and blinks move `Live` values, so they never rebuild the view.
        if let Some(wait) = crate::bot::animate(now, self.reduced.get()) {
            tx.wake_after(wait);
        }
        changed
    }

    pub fn key(&mut self, e: &KeyEvent, tx: &mut Tx) -> bool {
        if matches!(e.key, Key::Escape) {
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
        // The editor: Tab takes Wisp's suggestion, Ctrl S saves.
        if self.view == View::Code {
            if matches!(e.key, Key::Tab) && e.mods == rune::Mods::default() && self.accept_suggestion() {
                return true;
            }
            if Chord::parse("mod+s").is_ok_and(|c| c.matches_tx(e, tx)) {
                self.save_file();
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
