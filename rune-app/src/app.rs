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
    /// Mission control and each agent's conversation. The default view.
    Agents,
    /// Codex-style chats: "What should we build?", recents, projects, transcripts.
    Chat,
    Code,
    Prs,
    /// The built-in web browser.
    Browser,
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
    pub const ALL: [SettingsPage; 16] = [
        SettingsPage::General, SettingsPage::Profile, SettingsPage::Appearance, SettingsPage::Configuration,
        SettingsPage::Personalization, SettingsPage::Shortcuts, SettingsPage::Mcp, SettingsPage::Hooks,
        SettingsPage::Connections, SettingsPage::Git, SettingsPage::Environments, SettingsPage::Worktrees,
        SettingsPage::Browser, SettingsPage::ComputerUse, SettingsPage::Archived, SettingsPage::Usage,
    ];
    pub fn label(self) -> &'static str {
        match self {
            SettingsPage::General => "General",
            SettingsPage::Profile => "Profile",
            SettingsPage::Appearance => "Appearance",
            SettingsPage::Configuration => "Configuration",
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
}

impl EditKey {
    pub const ALL: [EditKey; 10] = [
        EditKey::Search, EditKey::Mission, EditKey::AgentThread, EditKey::ChatHome, EditKey::ChatThread,
        EditKey::AppSearch, EditKey::Address, EditKey::SettingsSearch, EditKey::AboutMe, EditKey::Instructions,
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
        }
    }
}

/// A small menu open over the composer or a row ("model", "approval", "chat/<title>", ...).
pub type MenuId = String;

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
    /// The built-in browser: its tabs, and the native web view on Windows.
    pub browser: Browser,
    /// Whether the system asks for reduced motion, as the view last saw it.
    pub reduced: std::cell::Cell<bool>,
    /// Whether the first poll has run (the window's launch-time setup).
    launched: bool,
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
            view: View::Agents,
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
            back: View::Agents,
            integrations: IntegrationsTab::Plugins,
            app_category: None,
            menu: None,
            expanded: HashSet::new(),
            notice: None,
            browser,
            reduced: std::cell::Cell::new(false),
            launched: false,
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
        let back = if self.back == View::Settings { View::Agents } else { self.back };
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

    pub fn toggle_app(&mut self, slug: &str) {
        if let Some(a) = self.data.extra.catalog.iter_mut().find(|a| a.slug == slug) {
            a.connected = !a.connected;
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

    /// Opens the browser on `url` (from a link in a chat, a bookmark or the address bar).
    pub fn browse(&mut self, url: &str) {
        self.go(View::Browser);
        self.browser.navigate(url);
    }

    pub fn set_waker(&mut self, waker: rune::Waker) {
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
        // A chat the store made for you (a new chat from "What should we build?") opens itself.
        if let Some(title) = self.store.take_focus() {
            if self.view == View::Chat && self.chat.is_none() {
                self.chat = Some(title.clone());
                self.store.open(&title);
            }
            changed = true;
        }
        changed |= self.browser.poll(self.view == View::Browser && self.menu.is_none() && self.appearance.is_none());
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
        if Chord::parse("mod+k").is_ok_and(|c| c.matches_tx(e, tx)) {
            tx.focus("cmdk", true);
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
        if self.view == View::Browser && Chord::parse("mod+l").is_ok_and(|c| c.matches_tx(e, tx)) {
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
