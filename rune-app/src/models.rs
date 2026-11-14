//! Models: what the composer picks from. Haze 2 (Codeply's own router, the default), plus the
//! models you add: any OpenAI-compatible endpoint (a base URL, a model id and usually an API key)
//! and Ollama, online or on this computer. The list lives in the engine's `~/.codeply/config.json`,
//! the Electron app's file, so both apps see the same models; the engine runs each chat on the
//! picked one (`routeFor` in `sidecar/engine.mjs`). The app never holds a saved key: it gets
//! `has_key` and a short preview, and a key typed into the form goes to the engine once.

use rune::TextEdit;
use serde_json::Value;

/// The id of Haze 2 in the engine's list.
pub const AUTO: &str = "auto";

/// "Use on my phone": whether a model can sync to the account, and where it stands.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Phone {
    pub eligible: bool,
    pub on: bool,
    pub synced: bool,
    /// Why it can't sync, or why a sync failed.
    pub reason: String,
}

/// One model you added.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    /// "openai" (any OpenAI-compatible endpoint) or "ollama".
    pub kind: String,
    pub base_url: String,
    /// The provider's own model id ("gpt-4o-mini").
    pub model: String,
    /// The chosen effort ("" is the provider's default).
    pub effort: String,
    /// The effort levels the provider answered with: None before it was asked, empty for none.
    pub effort_levels: Option<Vec<String>>,
    pub has_key: bool,
    pub key_preview: String,
    pub phone: Phone,
}

/// Effort words as people read them.
pub fn effort_label(id: &str) -> String {
    match id {
        "none" => "None".into(),
        "minimal" => "Minimal".into(),
        "low" | "Low" => "Low".into(),
        "medium" | "Medium" => "Medium".into(),
        "high" | "High" => "High".into(),
        "xhigh" => "Extra high".into(),
        "max" => "Max".into(),
        "" => "Default".into(),
        other => other.to_owned(),
    }
}

impl ModelInfo {
    pub fn from_json(v: &Value) -> Option<ModelInfo> {
        let text = |k: &str| v[k].as_str().unwrap_or_default().to_owned();
        let phone = &v["phone"];
        Some(ModelInfo {
            id: v["id"].as_str()?.to_owned(),
            name: v["name"].as_str().filter(|n| !n.is_empty()).or(v["model"].as_str())?.to_owned(),
            kind: text("kind"),
            base_url: text("baseUrl"),
            model: text("model"),
            effort: text("effort"),
            effort_levels: v["effortLevels"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()),
            has_key: v["hasKey"].as_bool().unwrap_or(false),
            key_preview: text("keyPreview"),
            phone: Phone {
                eligible: phone["eligible"].as_bool().unwrap_or(false),
                on: phone["on"].as_bool().unwrap_or(false),
                synced: phone["synced"].as_bool().unwrap_or(false),
                reason: phone["reason"].as_str().unwrap_or_default().to_owned(),
            },
        })
    }

    /// Runs on this computer (an Ollama host).
    pub fn is_local(&self) -> bool {
        self.kind == "ollama" && is_local_url(&self.base_url)
    }

    /// Where it runs, for the second line: "On this computer", or the host of its base URL.
    pub fn place(&self) -> String {
        if self.is_local() {
            "On this computer".into()
        } else {
            host_of(&self.base_url)
        }
    }

    /// Whether the model has an effort setting: not Ollama's, and not a provider that said it ignores effort.
    pub fn has_effort(&self) -> bool {
        self.kind != "ollama" && self.kind != "chatgpt" && !self.effort_levels.as_ref().is_some_and(Vec::is_empty)
    }

    /// The levels to pick from: the provider's default first, then what it answered with (or the
    /// usual three until it has been asked). Empty when the model has no effort setting.
    pub fn efforts(&self) -> Vec<(String, String)> {
        if !self.has_effort() {
            return Vec::new();
        }
        let levels: Vec<String> = self.effort_levels.clone().unwrap_or_else(|| vec!["low".into(), "medium".into(), "high".into()]);
        std::iter::once(String::new()).chain(levels).map(|id| { let l = effort_label(&id); (id, l) }).collect()
    }
}

fn is_local_url(url: &str) -> bool {
    let host = host_of(url);
    let host = host.split(':').next().unwrap_or_default();
    matches!(host, "localhost" | "127.0.0.1" | "0.0.0.0" | "::1" | "[::1]")
}

/// "api.openai.com" from "https://api.openai.com/v1".
pub fn host_of(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    rest.split(['/', '?', '#']).next().unwrap_or_default().rsplit('@').next().unwrap_or_default().to_owned()
}

/// What `GET /ext/models/ollama` found.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Scan {
    /// The scan is waiting for Ollama to answer.
    pub busy: bool,
    pub error: Option<String>,
    /// (name, detail "7B · qwen2 · 4.4 GB").
    pub found: Vec<(String, String)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Models {
    /// "auto" (Haze 2) or a model's id.
    pub selected: String,
    pub list: Vec<ModelInfo>,
    /// The engine answered at least once (so the sample list isn't shown as yours).
    pub loaded: bool,
    /// A save, delete or sync is in flight.
    pub busy: bool,
    /// What went wrong with the last add or change, shown in the form.
    pub error: Option<String>,
    /// The test request failed, so "Save without testing" is offered.
    pub test_failed: bool,
    /// Counts saves that went through; the form closes when it moves.
    pub saved: u32,
    /// What the Ollama scan found.
    pub scan: Scan,
}

impl Default for Models {
    fn default() -> Models {
        Models { selected: AUTO.into(), list: Vec::new(), loaded: false, busy: false, error: None, test_failed: false, saved: 0, scan: Scan::default() }
    }
}

impl Models {
    /// The picked model, or None for Haze 2.
    pub fn current(&self) -> Option<&ModelInfo> {
        if self.selected == AUTO { None } else { self.list.iter().find(|m| m.id == self.selected) }
    }

    /// The composer chip: the model's name, and its effort in grey when it has one.
    pub fn chip(&self, haze_effort: &str) -> (String, Option<String>) {
        match self.current() {
            None => ("Haze 2".into(), Some(haze_effort.to_owned())),
            Some(m) => (m.name.clone(), (m.has_effort() && !m.effort.is_empty()).then(|| effort_label(&m.effort))),
        }
    }

    /// Takes in what the engine sent: the list (`{selected, models}`), or an answer to a change
    /// (`{ok, state}` or `{ok: false, error}`).
    pub fn apply(&mut self, v: &Value) {
        self.busy = false;
        if v["models"].is_array() {
            self.fold(v);
            return;
        }
        if v["ok"].as_bool() == Some(false) {
            self.error = Some(v["error"].as_str().unwrap_or("That didn't work.").to_owned());
            self.test_failed = v["testFailed"].as_bool().unwrap_or(false);
            if v["state"]["models"].is_array() {
                self.fold(&v["state"]);
            }
            return;
        }
        self.error = None;
        self.test_failed = false;
        if v["state"]["models"].is_array() {
            self.fold(&v["state"]);
        }
        if v["model"]["id"].is_string() {
            self.saved += 1;
        }
    }

    fn fold(&mut self, v: &Value) {
        self.loaded = true;
        self.selected = v["selected"].as_str().unwrap_or(AUTO).to_owned();
        self.list = v["models"].as_array().map_or_else(Vec::new, |a| a.iter().filter_map(ModelInfo::from_json).collect());
        if self.selected != AUTO && !self.list.iter().any(|m| m.id == self.selected) {
            self.selected = AUTO.into();
        }
    }

    pub fn apply_scan(&mut self, v: &Value) {
        let found = v["models"].as_array().map_or_else(Vec::new, |a| {
            a.iter().filter_map(|m| {
                let name = m["name"].as_str()?.to_owned();
                let size = m["size"].as_f64().unwrap_or(0.0);
                let gb = size / 1e9;
                let size = if size <= 0.0 { String::new() } else if gb >= 1.0 { format!("{gb:.1} GB") } else { format!("{:.0} MB", size / 1e6) };
                let detail = [m["params"].as_str().unwrap_or_default(), m["family"].as_str().unwrap_or_default(), size.as_str()]
                    .iter().filter(|p| !p.is_empty()).copied().collect::<Vec<_>>().join(" · ");
                Some((name, detail))
            }).collect()
        });
        self.scan = Scan { busy: false, error: (v["ok"].as_bool() == Some(false)).then(|| v["error"].as_str().unwrap_or("Couldn't find Ollama.").to_owned()), found };
    }
}

/// What the form sends: the fields of the Electron app's "Add a model".
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelDraft {
    /// Set when editing a saved model.
    pub id: Option<String>,
    pub kind: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    /// None while editing with the key box left empty: the engine keeps the saved key.
    pub api_key: Option<String>,
    pub phone: bool,
    /// Save without the test request (after it failed, or Ollama isn't running right now).
    pub skip_test: bool,
}

impl ModelDraft {
    pub fn to_json(&self) -> Value {
        let mut v = serde_json::json!({
            "kind": self.kind, "name": self.name, "baseUrl": self.base_url, "model": self.model,
            "phone": self.phone, "skipTest": self.skip_test,
        });
        if let Some(id) = &self.id {
            v["id"] = id.clone().into();
        }
        if let Some(k) = &self.api_key {
            v["apiKey"] = k.clone().into();
        }
        v
    }

    /// The checks the engine makes first, so the form can say so without a round trip.
    pub fn problem(&self) -> Option<&'static str> {
        if self.model.trim().is_empty() {
            return Some("Enter the model id (for example gpt-4o-mini or llama3.1).");
        }
        let url = self.base_url.trim();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Some("The base URL must start with http:// or https://.");
        }
        None
    }
}

/// What a store is asked to do with the models.
#[derive(Clone, Debug, PartialEq)]
pub enum ModelOp {
    Select(String),
    Save(ModelDraft),
    Delete(String),
    /// A model's effort ("" is the default).
    Effort(String, String),
    /// Asks the provider which effort levels a model takes.
    Levels(String),
    Phone(String, bool),
    /// Looks for Ollama on this computer and lists the models it has pulled.
    ScanOllama,
}

/// One-click fills for the form, like the Electron app's "Quick fill".
pub const PRESETS: &[(&str, &str, &str, &str)] = &[
    ("OpenAI", "GPT-4o mini", "https://api.openai.com/v1", "gpt-4o-mini"),
    ("Claude", "Claude Sonnet", "https://api.anthropic.com/v1", "claude-sonnet-5"),
    ("Gemini", "Gemini Flash", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-3.7-flash"),
    ("OpenRouter", "OpenRouter", "https://openrouter.ai/api/v1", "openrouter/auto"),
    ("Groq", "Groq", "https://api.groq.com/openai/v1", "openai/gpt-oss-120b"),
    ("DeepSeek", "DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat"),
    ("Ollama online", "gpt-oss (Ollama)", "https://ollama.com/v1", "gpt-oss:20b"),
];

/// The form's four fields, by index.
pub const NAME: usize = 0;
pub const URL: usize = 1;
pub const MODEL: usize = 2;
pub const KEY: usize = 3;

/// The add/edit form's state. It lives on the app, not in the snapshot: text fields hold their own
/// edit state.
pub struct ModelsUi {
    /// The form is open: None for a new model, Some(id) when editing one.
    pub form: Option<Option<String>>,
    /// `Models::saved` when the form opened; the form shows only while it still matches.
    opened_at: u32,
    pub edits: [TextEdit; 4],
    pub phone: bool,
    /// The kind a new model is saved as ("openai", or "ollama" for a pulled model).
    pub kind: String,
    /// The row whose "Remove" is armed.
    pub confirm: Option<String>,
    /// Models whose effort levels were already asked for this launch.
    pub asked: Vec<String>,
}

impl Default for ModelsUi {
    fn default() -> ModelsUi {
        ModelsUi { form: None, opened_at: 0, edits: [TextEdit::new(""), TextEdit::new(""), TextEdit::new(""), TextEdit::new("")], phone: true, kind: "openai".into(), confirm: None, asked: Vec::new() }
    }
}

impl ModelsUi {
    /// Whether the form is on screen: opened, and not yet closed by a save that went through.
    pub fn open(&self, models: &Models) -> bool {
        self.form.is_some() && self.opened_at == models.saved
    }

    /// Opens the form empty (new) or filled from a saved model (edit; the key box starts empty).
    pub fn open_form(&mut self, models: &Models, edit: Option<&str>) {
        self.opened_at = models.saved;
        for e in &mut self.edits {
            e.clear();
        }
        self.phone = true;
        self.kind = "openai".into();
        if let Some(m) = edit.and_then(|id| models.list.iter().find(|m| m.id == id)) {
            self.edits[NAME].replace_text(m.name.clone());
            self.edits[URL].replace_text(m.base_url.clone());
            self.edits[MODEL].replace_text(m.model.clone());
            self.phone = m.phone.on;
            self.kind = m.kind.clone();
        }
        self.form = Some(edit.map(str::to_owned));
    }

    pub fn close_form(&mut self) {
        self.form = None;
        self.edits[KEY].clear();
    }

    pub fn preset(&mut self, i: usize) {
        if let Some(&(_, name, url, model)) = PRESETS.get(i) {
            self.edits[NAME].replace_text(name);
            self.edits[URL].replace_text(url);
            self.edits[MODEL].replace_text(model);
            self.kind = "openai".into();
        }
    }

    /// What the form holds, ready to send.
    pub fn draft(&self, skip_test: bool) -> ModelDraft {
        let editing = self.form.clone().flatten();
        let key = self.edits[KEY].text.trim().to_owned();
        ModelDraft {
            api_key: if editing.is_some() && key.is_empty() { None } else { Some(key) },
            id: editing,
            kind: self.kind.clone(),
            name: self.edits[NAME].text.trim().to_owned(),
            base_url: self.edits[URL].text.trim().to_owned(),
            model: self.edits[MODEL].text.trim().to_owned(),
            phone: self.phone,
            skip_test,
        }
    }

    /// A save went through: forget the key the form held, and close it.
    pub fn tick(&mut self, models: &Models) {
        if self.form.is_some() && self.opened_at != models.saved {
            self.close_form();
        }
    }

    /// Why "Use on my phone" can't be on for what's typed (the Electron form's hint), or None.
    pub fn phone_blocker(&self, models: &Models) -> Option<&'static str> {
        let editing = self.form.clone().flatten().and_then(|id| models.list.iter().find(|m| m.id == id));
        let has_key = !self.edits[KEY].text.trim().is_empty() || editing.is_some_and(|m| m.has_key);
        let url = self.edits[URL].text.trim().to_owned();
        if self.kind == "ollama" {
            return Some("Ollama runs on this PC, so your phone uses it through this PC while it is on.");
        }
        if !has_key {
            return Some("Needs an API key. Without one the model only works through this PC.");
        }
        if !url.is_empty() && !url.starts_with("https://") {
            return Some("Needs an https address. This one only works through this PC.");
        }
        if is_private_host(&host_of(&url)) {
            return Some("This address is on your own network, so it only works through this PC.");
        }
        None
    }
}

/// Addresses the account's servers can't reach (the engine checks the same, in model-sync.js).
fn is_private_host(host: &str) -> bool {
    let h = host.split(':').next().unwrap_or_default().to_ascii_lowercase();
    if h.is_empty() {
        return false;
    }
    let octets: Vec<u8> = h.split('.').filter_map(|p| p.parse().ok()).collect();
    let private_v4 = octets.len() == 4 && matches!(octets[..], [10, ..] | [127, ..] | [0, ..] | [192, 168, ..] | [169, 254, ..] | [172, 16..=31, ..] | [100, 64..=127, ..]);
    private_v4 || h == "localhost" || h.starts_with('[') || h.ends_with(".local") || h.ends_with(".internal") || h.ends_with(".lan") || h.ends_with(".localhost")
}

/// Sample data for the mock store, headless renders and tests: Haze 2 and four models you added.
pub fn sample() -> Models {
    let model = |id: &str, name: &str, kind: &str, url: &str, model: &str, key: bool, levels: Option<&[&str]>, effort: &str, phone: Phone| ModelInfo {
        id: id.into(), name: name.into(), kind: kind.into(), base_url: url.into(), model: model.into(), effort: effort.into(),
        effort_levels: levels.map(|l| l.iter().map(|s| (*s).to_owned()).collect()), has_key: key,
        key_preview: if key { "sk-p…9f3a".into() } else { String::new() }, phone,
    };
    let synced = Phone { eligible: true, on: true, synced: true, reason: String::new() };
    let no = |why: &str| Phone { eligible: false, on: false, synced: false, reason: why.into() };
    Models {
        selected: AUTO.into(),
        list: vec![
            model("m1", "GPT-4o mini", "openai", "https://api.openai.com/v1", "gpt-4o-mini", true, Some(&["low", "medium", "high"]), "medium", synced.clone()),
            model("m2", "Claude Sonnet", "openai", "https://api.anthropic.com/v1", "claude-sonnet-5", true, Some(&["low", "medium", "high", "max"]), "", synced),
            model("m3", "qwen2.5-coder (local)", "ollama", "http://localhost:11434", "qwen2.5-coder:7b", false, None, "", no("Ollama runs on this PC, so the phone uses it through this PC while it is on.")),
            model("m4", "Company gateway", "openai", "https://llm.corp.example.com/v1", "corp-chat", true, Some(&[]), "", Phone { eligible: true, on: false, synced: false, reason: String::new() }),
        ],
        loaded: true,
        ..Models::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_list_and_answers_fold_in() {
        let mut m = Models::default();
        m.apply(&json!({ "selected": "m1", "models": [{ "id": "m1", "name": "GPT", "kind": "openai", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini", "effort": "high", "effortLevels": ["low", "high"], "hasKey": true, "keyPreview": "sk-p…9f3a", "phone": { "eligible": true, "on": true, "synced": true } }] }));
        assert_eq!(m.selected, "m1");
        assert_eq!(m.chip("High"), ("GPT".into(), Some("High".into())));
        assert_eq!(m.current().map(ModelInfo::place).as_deref(), Some("api.openai.com"));
        // A failed test says why, and offers to save anyway.
        m.apply(&json!({ "ok": false, "testFailed": true, "error": "HTTP 401" }));
        assert_eq!((m.error.as_deref(), m.test_failed), (Some("HTTP 401"), true));
        // A save that went through clears it and counts.
        m.apply(&json!({ "ok": true, "model": { "id": "m1" }, "state": { "selected": "auto", "models": [] } }));
        assert_eq!((m.error.is_none(), m.saved, m.selected.as_str(), m.list.len()), (true, 1, "auto", 0));
    }

    #[test]
    fn a_selection_that_is_gone_falls_back_to_haze() {
        let mut m = Models::default();
        m.apply(&json!({ "selected": "gone", "models": [] }));
        assert_eq!(m.chip("Low"), ("Haze 2".into(), Some("Low".into())));
    }

    #[test]
    fn effort_follows_the_provider() {
        let s = sample();
        let by = |id: &str| s.list.iter().find(|m| m.id == id).unwrap().clone();
        assert_eq!(by("m1").efforts().len(), 4); // Default, low, medium, high
        assert!(by("m3").efforts().is_empty(), "Ollama has no effort");
        assert!(by("m4").efforts().is_empty(), "a provider that ignores effort has none");
        let unprobed = ModelInfo { kind: "openai".into(), ..ModelInfo::default() };
        assert_eq!(unprobed.efforts().len(), 4, "until the provider is asked, the usual three");
    }

    #[test]
    fn the_form_checks_what_the_engine_checks() {
        let d = ModelDraft { model: "".into(), base_url: "https://x".into(), ..ModelDraft::default() };
        assert!(d.problem().is_some());
        let d = ModelDraft { model: "m".into(), base_url: "ftp://x".into(), ..ModelDraft::default() };
        assert!(d.problem().is_some());
        let d = ModelDraft { model: "m".into(), base_url: "http://localhost:1234/v1".into(), ..ModelDraft::default() };
        assert!(d.problem().is_none());
    }

    #[test]
    fn phone_sync_explains_itself() {
        let models = sample();
        let mut ui = ModelsUi::default();
        ui.open_form(&models, None);
        assert!(ui.phone_blocker(&models).unwrap().contains("API key"));
        ui.edits[KEY].replace_text("sk-abc");
        ui.edits[URL].replace_text("http://example.com/v1");
        assert!(ui.phone_blocker(&models).unwrap().contains("https"));
        ui.edits[URL].replace_text("https://192.168.1.5/v1");
        assert!(ui.phone_blocker(&models).unwrap().contains("own network"));
        ui.edits[URL].replace_text("https://api.openai.com/v1");
        assert!(ui.phone_blocker(&models).is_none());
    }

    #[test]
    fn editing_keeps_the_saved_key_unless_you_type_one() {
        let models = sample();
        let mut ui = ModelsUi::default();
        ui.open_form(&models, Some("m1"));
        assert_eq!(ui.draft(false).api_key, None);
        ui.edits[KEY].replace_text("sk-new");
        assert_eq!(ui.draft(false).api_key.as_deref(), Some("sk-new"));
        assert_eq!(ui.draft(false).id.as_deref(), Some("m1"));
    }
}
