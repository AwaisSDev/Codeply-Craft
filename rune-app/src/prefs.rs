//! What the app remembers between launches: Settings choices, each helper's look, pinned chats
//! and browser bookmarks. One JSON file, `~/.codeply/rune/prefs.json`, written whenever something
//! changes. Headless runs and tests never read or write it.

use std::path::PathBuf;

use serde_json::{Value, json};

/// When the engine asks before it acts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Approval {
    /// Ask before every write, edit or command ("Approve manually").
    Ask,
    /// Run without asking ("Full access").
    Auto,
}

impl Approval {
    pub fn name(self) -> &'static str {
        match self {
            Approval::Ask => "ask",
            Approval::Auto => "auto",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Approval::Ask => "Approve manually",
            Approval::Auto => "Full access",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Prefs {
    pub approval: Approval,
    /// The model's reasoning effort chip: "Low", "Medium", "High".
    pub effort: String,
    /// Each helper's colour and shape, by agent id: (id, `#rrggbb`, shape name).
    pub looks: Vec<(String, String, String)>,
    /// Pinned chats, by title.
    pub pinned: Vec<String>,
    /// Archived chats, by title (hidden from the sidebar, listed in Settings).
    pub archived: Vec<String>,
    /// The browser's home page.
    pub home: String,
    /// Browser bookmarks: (title, url).
    pub bookmarks: Vec<(String, String)>,
    pub notifications: bool,
    /// Enter sends; Shift+Enter makes a new line. Off: Ctrl+Enter sends.
    pub enter_sends: bool,
    /// Show each tool call in a chat, or fold them into "Worked for ...".
    pub show_tools: bool,
    /// Fade replies in word by word as they stream (grey to white).
    pub reveal: bool,
    /// Personalization: what Wisp should know about you, and how it should answer.
    pub about_me: String,
    pub instructions: String,
}

impl Default for Prefs {
    fn default() -> Prefs {
        Prefs {
            approval: Approval::Ask,
            effort: "High".into(),
            looks: Vec::new(),
            pinned: Vec::new(),
            archived: Vec::new(),
            home: "https://www.codeply.app".into(),
            bookmarks: vec![
                ("Codeply".into(), "https://www.codeply.app".into()),
                ("GitHub".into(), "https://github.com".into()),
                ("Vercel".into(), "https://vercel.com/dashboard".into()),
            ],
            notifications: true,
            enter_sends: true,
            show_tools: false,
            reveal: true,
            about_me: String::new(),
            instructions: String::new(),
        }
    }
}

fn file() -> PathBuf {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map_or_else(|| PathBuf::from("."), PathBuf::from);
    home.join(".codeply").join("rune").join("prefs.json")
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map_or_else(Vec::new, |a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
}

impl Prefs {
    /// Reads the saved preferences, or the defaults (always the defaults when headless).
    pub fn load() -> Prefs {
        if rune::is_headless() || cfg!(test) {
            return Prefs::default();
        }
        std::fs::read_to_string(file()).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).map_or_else(Prefs::default, |v| Prefs::from_json(&v))
    }

    pub fn from_json(v: &Value) -> Prefs {
        let d = Prefs::default();
        let text = |k: &str, or: &str| v[k].as_str().unwrap_or(or).to_owned();
        let flag = |k: &str, or: bool| v[k].as_bool().unwrap_or(or);
        Prefs {
            approval: if v["approval"] == "auto" { Approval::Auto } else { Approval::Ask },
            effort: text("effort", &d.effort),
            looks: v["looks"].as_array().map_or_else(Vec::new, |a| {
                a.iter().filter_map(|l| Some((l["id"].as_str()?.to_owned(), l["color"].as_str()?.to_owned(), l["shape"].as_str()?.to_owned()))).collect()
            }),
            pinned: strings(&v["pinned"]),
            archived: strings(&v["archived"]),
            home: text("home", &d.home),
            bookmarks: v["bookmarks"].as_array().map_or(d.bookmarks, |a| {
                a.iter().filter_map(|b| Some((b["title"].as_str()?.to_owned(), b["url"].as_str()?.to_owned()))).collect()
            }),
            notifications: flag("notifications", d.notifications),
            enter_sends: flag("enter_sends", d.enter_sends),
            show_tools: flag("show_tools", d.show_tools),
            reveal: flag("reveal", d.reveal),
            about_me: text("about_me", ""),
            instructions: text("instructions", ""),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "approval": self.approval.name(),
            "effort": self.effort,
            "looks": self.looks.iter().map(|(id, color, shape)| json!({ "id": id, "color": color, "shape": shape })).collect::<Vec<_>>(),
            "pinned": self.pinned,
            "archived": self.archived,
            "home": self.home,
            "bookmarks": self.bookmarks.iter().map(|(t, u)| json!({ "title": t, "url": u })).collect::<Vec<_>>(),
            "notifications": self.notifications,
            "enter_sends": self.enter_sends,
            "show_tools": self.show_tools,
            "reveal": self.reveal,
            "about_me": self.about_me,
            "instructions": self.instructions,
        })
    }

    /// Writes the preferences (never when headless or under test).
    pub fn save(&self) {
        if rune::is_headless() || cfg!(test) {
            return;
        }
        let path = file();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, self.to_json().to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }

    /// Remembers a helper's look.
    pub fn set_look(&mut self, id: &str, color: &str, shape: &str) {
        self.looks.retain(|(k, _, _)| k != id);
        self.looks.push((id.to_owned(), color.to_owned(), shape.to_owned()));
    }

    pub fn toggle_pin(&mut self, chat: &str) {
        if let Some(i) = self.pinned.iter().position(|c| c == chat) {
            self.pinned.remove(i);
        } else {
            self.pinned.push(chat.to_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_round_trip() {
        let mut p = Prefs { approval: Approval::Auto, effort: "Medium".into(), ..Prefs::default() };
        p.set_look("backend", "#ff8a1a", "cloud");
        p.toggle_pin("Pricing page");
        assert_eq!(Prefs::from_json(&p.to_json()), p);
    }

    #[test]
    fn a_missing_file_gives_the_defaults() {
        assert_eq!(Prefs::from_json(&json!({})), Prefs::default());
    }
}
