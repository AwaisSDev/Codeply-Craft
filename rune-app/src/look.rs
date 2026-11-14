//! How the app looks: light or dark (or the system's), custom colours, the UI font and its size
//! and weight, and a background (a picture, ASCII or dotted art), plus asking the engine's model
//! for a whole theme. The choices are `LookPrefs`, saved in the preferences; `Look` is what the
//! app keeps while it runs (searches, generated themes, decoded pictures). The sidecar routes
//! behind it are in `sidecar/ext-theme.mjs`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rune::{Pixels, TextEdit, Tx};
use serde_json::{Value, json};

use crate::app::App;
use crate::art::{self, Grid};
use crate::theme;

// ---------- the saved choices ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Mode {
    #[default]
    Dark,
    Light,
    System,
}

impl Mode {
    pub const ALL: [Mode; 3] = [Mode::Dark, Mode::Light, Mode::System];
    pub fn name(self) -> &'static str {
        match self {
            Mode::Dark => "dark",
            Mode::Light => "light",
            Mode::System => "system",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Mode::Dark => "Dark",
            Mode::Light => "Light",
            Mode::System => "Match system",
        }
    }
    pub fn from_name(s: &str) -> Option<Mode> {
        Mode::ALL.into_iter().find(|m| m.name() == s)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum BgKind {
    #[default]
    None,
    Picture,
    Ascii,
    Dots,
}

impl BgKind {
    pub const ALL: [BgKind; 4] = [BgKind::None, BgKind::Picture, BgKind::Ascii, BgKind::Dots];
    pub fn name(self) -> &'static str {
        match self {
            BgKind::None => "none",
            BgKind::Picture => "picture",
            BgKind::Ascii => "ascii",
            BgKind::Dots => "dots",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            BgKind::None => "None",
            BgKind::Picture => "Picture",
            BgKind::Ascii => "ASCII",
            BgKind::Dots => "Dots",
        }
    }
    pub fn from_name(s: &str) -> Option<BgKind> {
        BgKind::ALL.into_iter().find(|k| k.name() == s)
    }
}

/// UI text size steps: label and scale.
pub const SIZES: [(&str, f32); 5] = [("Small", 0.92), ("Default", 1.0), ("Large", 1.1), ("Larger", 1.2), ("Largest", 1.35)];
/// UI weight steps: label and the shift added to every weight.
pub const WEIGHTS: [(&str, i32); 4] = [("Light", -100), ("Regular", 0), ("Medium", 100), ("Bold", 200)];
/// How strongly the background is dimmed behind the app (opacity of the scrim).
pub const DIMS: [(&str, f32); 5] = [("Off", 0.0), ("Light", 0.4), ("Medium", 0.6), ("Strong", 0.78), ("Full", 0.92)];
/// Blur steps for a picture, as a Gaussian sigma on a 640 px copy.
pub const BLURS: [(&str, f32); 4] = [("Off", 0.0), ("Soft", 3.0), ("Medium", 7.0), ("Strong", 14.0)];

/// A colour the user can set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Slot {
    Accent,
    Bg,
    Side,
    Text,
}

impl Slot {
    pub const ALL: [Slot; 4] = [Slot::Accent, Slot::Bg, Slot::Side, Slot::Text];
    pub fn label(self) -> &'static str {
        match self {
            Slot::Accent => "Accent",
            Slot::Bg => "Background",
            Slot::Side => "Sidebar",
            Slot::Text => "Text",
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Slot::Accent => "accent",
            Slot::Bg => "bg",
            Slot::Side => "side",
            Slot::Text => "text",
        }
    }
    pub fn edit(self) -> LookEdit {
        match self {
            Slot::Accent => LookEdit::Accent,
            Slot::Bg => LookEdit::Bg,
            Slot::Side => LookEdit::Side,
            Slot::Text => LookEdit::Text,
        }
    }
    /// Ready-made choices.
    pub fn swatches(self) -> &'static [&'static str] {
        match self {
            Slot::Accent => &["#3d8bfd", "#2563eb", "#7c5cff", "#d946ef", "#f43f5e", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#06b6d4"],
            Slot::Bg => &["#0f0f0f", "#0b1220", "#17101f", "#101a15", "#1c1410", "#ffffff", "#f6f1e7", "#eef2f7", "#fbeff3", "#eef5ee"],
            Slot::Side => &["#171717", "#111a2e", "#201729", "#17251d", "#261c15", "#f7f7f7", "#efe8d8", "#e2e9f2", "#f6e0e8", "#e1ecdf"],
            Slot::Text => &["#ececec", "#ffffff", "#dbe6ff", "#f5e6d3", "#c8f5dc", "#1a1a1a", "#111827", "#2b2118", "#3b1f2b", "#14301f"],
        }
    }
}

/// Everything about the app's look that is saved between launches.
#[derive(Clone, Debug, PartialEq)]
pub struct LookPrefs {
    pub mode: Mode,
    /// Colours the user (or a generated theme) set; `None` keeps the mode's own.
    pub accent: Option<String>,
    pub bg: Option<String>,
    pub side: Option<String>,
    pub text: Option<String>,
    /// The name of the generated theme in use, if any.
    pub name: String,
    /// The UI font family ("" is the default stack) and the code font.
    pub font: String,
    pub mono: String,
    /// Indexes into `SIZES` and `WEIGHTS`.
    pub size: usize,
    pub weight: usize,
    pub bg_kind: BgKind,
    /// The picture's file, in the app's backgrounds folder.
    pub picture: String,
    /// ASCII and dotted art as ramp-character lines (see `art::Grid`).
    pub art: Vec<String>,
    /// Indexes into `DIMS` and `BLURS`.
    pub dim: usize,
    pub blur: usize,
}

impl Default for LookPrefs {
    fn default() -> LookPrefs {
        LookPrefs {
            mode: Mode::Dark,
            accent: None,
            bg: None,
            side: None,
            text: None,
            name: String::new(),
            font: String::new(),
            mono: String::new(),
            size: 1,
            weight: 1,
            bg_kind: BgKind::None,
            picture: String::new(),
            art: Vec::new(),
            dim: 2,
            blur: 0,
        }
    }
}

fn colour(v: &Value, k: &str) -> Option<String> {
    v[k].as_str().filter(|s| theme::is_hex(s)).map(str::to_owned)
}

impl LookPrefs {
    pub fn from_json(v: &Value) -> LookPrefs {
        let d = LookPrefs::default();
        let idx = |k: &str, or: usize, max: usize| v[k].as_u64().map_or(or, |n| (n as usize).min(max - 1));
        LookPrefs {
            mode: v["mode"].as_str().and_then(Mode::from_name).unwrap_or(d.mode),
            accent: colour(v, "accent"),
            bg: colour(v, "bg"),
            side: colour(v, "side"),
            text: colour(v, "text"),
            name: v["name"].as_str().unwrap_or("").chars().take(60).collect(),
            font: v["font"].as_str().unwrap_or("").chars().take(60).collect(),
            mono: v["mono"].as_str().unwrap_or("").chars().take(60).collect(),
            size: idx("size", d.size, SIZES.len()),
            weight: idx("weight", d.weight, WEIGHTS.len()),
            bg_kind: v["bg_kind"].as_str().and_then(BgKind::from_name).unwrap_or(d.bg_kind),
            picture: v["picture"].as_str().unwrap_or("").to_owned(),
            art: v["art"].as_array().map_or_else(Vec::new, |a| a.iter().filter_map(|l| l.as_str().map(str::to_owned)).take(200).collect()),
            dim: idx("dim", d.dim, DIMS.len()),
            blur: idx("blur", d.blur, BLURS.len()),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "mode": self.mode.name(), "accent": self.accent, "bg": self.bg, "side": self.side, "text": self.text,
            "name": self.name, "font": self.font, "mono": self.mono, "size": self.size, "weight": self.weight,
            "bg_kind": self.bg_kind.name(), "picture": self.picture, "art": self.art, "dim": self.dim, "blur": self.blur,
        })
    }

    pub fn colour(&self, slot: Slot) -> Option<&str> {
        match slot {
            Slot::Accent => self.accent.as_deref(),
            Slot::Bg => self.bg.as_deref(),
            Slot::Side => self.side.as_deref(),
            Slot::Text => self.text.as_deref(),
        }
    }

    pub fn set_colour(&mut self, slot: Slot, c: Option<String>) {
        match slot {
            Slot::Accent => self.accent = c,
            Slot::Bg => self.bg = c,
            Slot::Side => self.side = c,
            Slot::Text => self.text = c,
        }
        self.name.clear();
    }

    /// The font stacks for Rune's sans and mono slots.
    pub fn families(&self) -> (String, String) {
        let stack = |pick: &str, base: &str| if pick.is_empty() { base.to_owned() } else { format!("{pick}, {base}") };
        (stack(&self.font, theme::UI_FAMILIES), stack(&self.mono, theme::MONO_FAMILIES))
    }

    /// Whether a background is chosen and has something to draw.
    pub fn has_background(&self) -> bool {
        match self.bg_kind {
            BgKind::None => false,
            BgKind::Picture => !self.picture.is_empty(),
            BgKind::Ascii | BgKind::Dots => !self.art.is_empty(),
        }
    }

    pub fn scale(&self) -> f32 {
        SIZES[self.size.min(SIZES.len() - 1)].1
    }

    pub fn bold(&self) -> i32 {
        WEIGHTS[self.weight.min(WEIGHTS.len() - 1)].1
    }
}

// ---------- a theme the model made ----------

/// A theme proposed by the model, shown as a preview until the user applies it.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub name: String,
    /// Mode and colours (and the font and background below when the model chose them), laid over
    /// the current look for the preview.
    pub look: LookPrefs,
    /// Whether the model chose a font, with its size and weight.
    pub font: bool,
    /// Whether the model chose a background.
    pub background: bool,
    /// Words to search a picture for, when the background is a picture.
    pub query: Option<String>,
}

impl Candidate {
    /// Reads and checks the sidecar's answer (which has checked it already): anything that does
    /// not parse as a colour, a known mode or a sane art is left out rather than trusted.
    pub fn from_json(v: &Value, current: &LookPrefs) -> Result<Candidate, String> {
        let t = if v["theme"].is_object() { &v["theme"] } else { v };
        let mut look = current.clone();
        look.name = t["name"].as_str().unwrap_or("").trim().chars().take(40).collect();
        if look.name.is_empty() {
            look.name = "Custom theme".into();
        }
        look.mode = t["mode"].as_str().and_then(Mode::from_name).filter(|m| *m != Mode::System).unwrap_or(Mode::Dark);
        let c = &t["colors"];
        look.bg = colour(c, "bg");
        look.side = colour(c, "side");
        look.text = colour(c, "text");
        look.accent = colour(c, "accent");
        if look.bg.is_none() && look.accent.is_none() && look.text.is_none() {
            return Err("The model's theme had no usable colours.".into());
        }
        let f = &t["font"];
        let font = f.is_object();
        if font {
            look.font = f["family"].as_str().unwrap_or("").chars().filter(|c| c.is_alphanumeric() || " -_.".contains(*c)).take(40).collect();
            look.size = f["size"].as_u64().map_or(1, |n| (n as usize).min(SIZES.len() - 1)).min(3);
            look.weight = f["weight"].as_u64().map_or(1, |n| (n as usize).min(WEIGHTS.len() - 1));
        }
        let b = &t["background"];
        let mut background = false;
        let mut query = None;
        if let Some(kind) = b["kind"].as_str().and_then(BgKind::from_name) {
            match kind {
                BgKind::None => {
                    look.bg_kind = BgKind::None;
                    background = true;
                }
                BgKind::Ascii | BgKind::Dots => {
                    let lines: Vec<String> = b["art"].as_array().map_or_else(Vec::new, |a| {
                        a.iter().filter_map(|l| l.as_str()).take(60).map(|l| l.chars().take(120).collect()).collect()
                    });
                    if Grid::from_lines(&lines).is_some() {
                        look.bg_kind = kind;
                        look.art = lines;
                        background = true;
                    }
                }
                BgKind::Picture => {
                    if let Some(q) = b["query"].as_str().map(str::trim).filter(|q| !q.is_empty()) {
                        look.bg_kind = BgKind::Picture;
                        query = Some(q.chars().take(80).collect());
                        background = true;
                    }
                }
            }
        }
        Ok(Candidate { name: look.name.clone(), look, font, background, query })
    }
}

// ---------- what the app keeps while it runs ----------

/// An image search result: its thumbnail is already a file on this PC (the sidecar fetched it).
#[derive(Clone, Debug, PartialEq)]
pub struct Hit {
    pub title: String,
    pub thumb: String,
    pub url: String,
    pub credit: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LookEdit {
    Prompt,
    Search,
    Accent,
    Bg,
    Side,
    Text,
}

impl LookEdit {
    pub const ALL: [LookEdit; 6] = [LookEdit::Prompt, LookEdit::Search, LookEdit::Accent, LookEdit::Bg, LookEdit::Side, LookEdit::Text];
    pub fn name(self) -> &'static str {
        match self {
            LookEdit::Prompt => "theme-prompt",
            LookEdit::Search => "image-search",
            LookEdit::Accent => "hex-accent",
            LookEdit::Bg => "hex-bg",
            LookEdit::Side => "hex-side",
            LookEdit::Text => "hex-text",
        }
    }
}

enum Ev {
    Fonts(Vec<String>),
    Hits { hits: Vec<Hit>, pick: bool },
    SearchFailed(String),
    Generated(Result<Candidate, String>),
    Picture(Result<String, String>),
    Art(Result<Vec<String>, String>),
}

type Events = Arc<Mutex<Vec<Ev>>>;

pub struct Look {
    remote: Option<(String, String)>,
    events: Events,
    waker: Option<rune::Waker>,
    edits: HashMap<LookEdit, TextEdit>,
    /// Installed fonts, from the engine (asked once, when Appearance opens).
    pub fonts: Vec<String>,
    fonts_asked: bool,
    pub hits: Vec<Hit>,
    pub searching: bool,
    pub search_error: Option<String>,
    pub generating: bool,
    pub gen_error: Option<String>,
    pub candidate: Option<Candidate>,
    /// A picture is being fetched or converted.
    pub working: bool,
    /// Picking the first search result for a generated theme once the search lands.
    pending_pick: bool,
    pics: RefCell<HashMap<String, Pixels>>,
    art_px: RefCell<HashMap<u64, Pixels>>,
    families: (String, String),
}

impl Default for Look {
    fn default() -> Look {
        Look {
            remote: None,
            events: Arc::default(),
            waker: None,
            edits: LookEdit::ALL.iter().map(|&k| (k, TextEdit::new(""))).collect(),
            fonts: Vec::new(),
            fonts_asked: false,
            hits: Vec::new(),
            searching: false,
            search_error: None,
            generating: false,
            gen_error: None,
            candidate: None,
            working: false,
            pending_pick: false,
            pics: RefCell::default(),
            art_px: RefCell::default(),
            families: (theme::UI_FAMILIES.to_owned(), theme::MONO_FAMILIES.to_owned()),
        }
    }
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map_or_else(|| PathBuf::from("."), PathBuf::from)
}

/// Where pictures the user picked are kept.
fn backgrounds() -> PathBuf {
    home().join(".codeply").join("rune").join("backgrounds")
}

/// A stand-in for a picture in headless runs and tests.
pub const SAMPLE: &str = "sample:";

impl Look {
    pub fn edit(&self, k: LookEdit) -> &TextEdit {
        &self.edits[&k]
    }
    pub fn edit_mut(&mut self, k: LookEdit) -> &mut TextEdit {
        self.edits.entry(k).or_insert_with(|| TextEdit::new(""))
    }

    pub fn set_remote(&mut self, url: &str, token: &str) {
        self.remote = Some((url.trim_end_matches('/').to_owned(), token.to_owned()));
    }

    pub fn set_waker(&mut self, w: rune::Waker) {
        self.waker = Some(w);
    }

    /// Whether there is an engine to ask (searches and generated themes need one).
    pub fn online(&self) -> bool {
        self.remote.is_some()
    }

    /// The font choices: the app's own, then what is installed.
    pub fn font_choices(&self) -> Vec<String> {
        let mut all: Vec<String> = vec!["Geist".into(), "Inter".into()];
        for f in &self.fonts {
            if !all.iter().any(|a| a.eq_ignore_ascii_case(f)) {
                all.push(f.clone());
            }
        }
        all
    }

    /// Runs `work` against the engine on its own thread; `done` turns its answer into an event.
    #[cfg(feature = "live")]
    fn call(&self, method: &'static str, path: String, body: Option<Value>, secs: u64, done: impl FnOnce(Result<Value, String>) -> Ev + Send + 'static) {
        let Some((base, token)) = self.remote.clone() else {
            push(&self.events, &self.waker, done(Err("The engine isn't running, so this needs it.".into())));
            return;
        };
        let (events, waker) = (self.events.clone(), self.waker.clone());
        std::thread::spawn(move || {
            let agent = ureq::AgentBuilder::new().timeout_connect(std::time::Duration::from_secs(2)).timeout(std::time::Duration::from_secs(secs)).build();
            let req = agent.request(method, &format!("{base}{path}")).set("Authorization", &format!("Bearer {token}"));
            let resp = match body {
                Some(b) => req.send_json(b),
                None => req.call(),
            };
            let out = match resp {
                Ok(r) => r.into_json::<Value>().map_err(|e| e.to_string()),
                Err(ureq::Error::Status(code, r)) => Err(r.into_json::<Value>().ok().and_then(|v| v["error"].as_str().map(str::to_owned)).unwrap_or_else(|| format!("status {code}"))),
                Err(e) => Err(e.to_string()),
            };
            push(&events, &waker, done(out));
        });
    }

    #[cfg(not(feature = "live"))]
    fn call(&self, _: &'static str, _: String, _: Option<Value>, _: u64, done: impl FnOnce(Result<Value, String>) -> Ev + Send + 'static) {
        push(&self.events, &self.waker, done(Err("This build has no engine.".into())));
    }

    // ---------- pictures ----------

    /// The pixels of a picture file (blurred as asked, at most `max_w` wide), decoding it on a
    /// thread the first time. Empty until it lands.
    pub fn picture(&self, path: &str, blur: f32, max_w: u32) -> Pixels {
        let key = format!("{path}|{blur}|{max_w}");
        if let Some(p) = self.pics.borrow().get(&key) {
            return p.clone();
        }
        let px = Pixels::new();
        let mut pics = self.pics.borrow_mut();
        if pics.len() > 24 {
            pics.clear();
        }
        pics.insert(key, px.clone());
        let (out, path) = (px.clone(), path.to_owned());
        let load = move || {
            let decoded = if path == SAMPLE { Some(art::sample_picture()) } else { std::fs::read(&path).ok().and_then(|b| crate::favicon::decode_image(&b)) };
            if let Some((w, h, rgba)) = decoded {
                if let Some((w, h, rgba)) = art::prepare(rgba, w, h, blur, max_w) {
                    out.set(w, h, rgba);
                }
            }
        };
        if rune::is_headless() {
            load();
        } else {
            std::thread::spawn(load);
        }
        px
    }

    /// The pixels of ASCII or dotted art for `lines`, drawn in the theme's ink.
    pub fn art(&self, kind: BgKind, lines: &[String], t: &theme::Theme) -> Option<Pixels> {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        (kind.name(), lines, t.art, t.dark).hash(&mut h);
        let key = h.finish();
        if let Some(p) = self.art_px.borrow().get(&key) {
            return Some(p.clone());
        }
        let grid = Grid::from_saved(lines)?;
        let (w, hh, rgba) = match kind {
            BgKind::Ascii => art::ascii_image(&grid, t.art, 0.62, !t.dark),
            _ => art::dots_image(&grid, t.art, 0.6, !t.dark),
        };
        let px = Pixels::new();
        px.set(w, hh, rgba);
        let mut cache = self.art_px.borrow_mut();
        if cache.len() > 6 {
            cache.clear();
        }
        cache.insert(key, px.clone());
        Some(px)
    }
}

fn push(events: &Events, waker: &Option<rune::Waker>, ev: Ev) {
    events.lock().unwrap_or_else(|e| e.into_inner()).push(ev);
    if let Some(w) = waker {
        w();
    }
}

fn hits_from(v: &Value) -> Vec<Hit> {
    v["hits"].as_array().map_or_else(Vec::new, |a| {
        a.iter().filter_map(|h| {
            Some(Hit {
                title: h["title"].as_str().unwrap_or("Untitled").chars().take(80).collect(),
                thumb: h["thumb"].as_str()?.to_owned(),
                url: h["url"].as_str()?.to_owned(),
                credit: h["credit"].as_str().unwrap_or("").chars().take(120).collect(),
            })
        }).take(12).collect()
    })
}

// ---------- what the settings do ----------

impl App {
    fn save_look(&mut self) {
        self.prefs.save();
    }

    pub fn set_mode(&mut self, mode: Mode) {
        self.prefs.look.mode = mode;
        self.prefs.look.name.clear();
        self.save_look();
    }

    /// Sets (or, with None, clears) one colour.
    pub fn set_theme_colour(&mut self, slot: Slot, c: Option<&str>) {
        self.prefs.look.set_colour(slot, c.map(str::to_owned));
        self.look.edit_mut(slot.edit()).replace_text(c.unwrap_or("").to_owned());
        self.save_look();
    }

    /// Applies what was typed in a colour's hex field, if it is a colour.
    pub fn apply_hex(&mut self, slot: Slot) {
        let text = self.look.edit(slot.edit()).text.trim().to_owned();
        let text = if text.starts_with('#') || text.is_empty() { text } else { format!("#{text}") };
        if text.is_empty() {
            self.set_theme_colour(slot, None);
        } else if theme::is_hex(&text) {
            self.set_theme_colour(slot, Some(&text));
        }
    }

    pub fn set_font(&mut self, family: &str) {
        self.prefs.look.font = family.to_owned();
        self.prefs.look.name.clear();
        self.menu = None;
        self.save_look();
    }

    pub fn set_mono(&mut self, family: &str) {
        self.prefs.look.mono = family.to_owned();
        self.menu = None;
        self.save_look();
    }

    pub fn set_text_size(&mut self, i: usize) {
        self.prefs.look.size = i.min(SIZES.len() - 1);
        self.save_look();
    }

    pub fn set_text_weight(&mut self, i: usize) {
        self.prefs.look.weight = i.min(WEIGHTS.len() - 1);
        self.save_look();
    }

    pub fn set_bg_kind(&mut self, kind: BgKind) {
        self.prefs.look.bg_kind = kind;
        // ASCII and dots draw from the picture when there is no art yet.
        if matches!(kind, BgKind::Ascii | BgKind::Dots) && self.prefs.look.art.is_empty() && !self.prefs.look.picture.is_empty() {
            self.convert_picture();
        }
        self.save_look();
    }

    pub fn set_dim(&mut self, i: usize) {
        self.prefs.look.dim = i.min(DIMS.len() - 1);
        self.save_look();
    }

    pub fn set_blur(&mut self, i: usize) {
        self.prefs.look.blur = i.min(BLURS.len() - 1);
        self.save_look();
    }

    /// Uses the picture file at `path` as the background (copied into the app's folder so it
    /// stays after the original moves). In ASCII or dots it is converted.
    pub fn use_picture_file(&mut self, path: &std::path::Path) {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("img").to_ascii_lowercase();
        let dir = backgrounds();
        let _ = std::fs::create_dir_all(&dir);
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
        let dest = dir.join(format!("picked-{stamp}.{ext}"));
        let kept = if std::fs::copy(path, &dest).is_ok() { dest } else { path.to_path_buf() };
        self.use_picture(&kept.to_string_lossy());
    }

    fn use_picture(&mut self, path: &str) {
        let look = &mut self.prefs.look;
        look.picture = path.to_owned();
        look.name.clear();
        if look.bg_kind == BgKind::None {
            look.bg_kind = BgKind::Picture;
        }
        if matches!(look.bg_kind, BgKind::Ascii | BgKind::Dots) {
            look.art.clear();
            self.convert_picture();
        }
        self.look.pics.borrow_mut().clear();
        self.save_look();
    }

    /// Draws the picture into ASCII/dotted art lines (on a thread; they land through `poll`).
    pub fn convert_picture(&mut self) {
        let path = self.prefs.look.picture.clone();
        if path.is_empty() {
            return;
        }
        self.look.working = true;
        let (events, waker) = (self.look.events.clone(), self.look.waker.clone());
        let work = move || {
            let decoded = if path == SAMPLE { Some(art::sample_picture()) } else { std::fs::read(&path).ok().and_then(|b| crate::favicon::decode_image(&b)) };
            let out = decoded.and_then(|(w, h, rgba)| Grid::from_rgba(&rgba, w, h)).map(|g| g.to_lines()).ok_or_else(|| "That picture couldn't be read.".to_owned());
            push(&events, &waker, Ev::Art(out));
        };
        if rune::is_headless() {
            work();
        } else {
            std::thread::spawn(work);
        }
    }

    /// Searches for pictures (Openverse, then Wikimedia Commons, through the engine).
    pub fn search_images(&mut self) {
        let q = self.look.edit(LookEdit::Search).text.trim().to_owned();
        self.search_for(&q, false);
    }

    fn search_for(&mut self, q: &str, pick: bool) {
        if q.is_empty() {
            return;
        }
        self.look.searching = true;
        self.look.search_error = None;
        self.look.pending_pick = pick;
        let path = format!("/ext/theme/images?q={}", encode(q));
        self.look.call("GET", path, None, 40, move |r| match r {
            Ok(v) => Ev::Hits { hits: hits_from(&v), pick },
            Err(e) => Ev::SearchFailed(e),
        });
    }

    /// Takes a search result as the background: the engine downloads it, then it is used.
    pub fn use_hit(&mut self, i: usize) {
        let Some(hit) = self.look.hits.get(i).cloned() else { return };
        self.look.working = true;
        if hit.url == SAMPLE {
            self.look.working = false;
            self.use_picture(SAMPLE);
            return;
        }
        self.look.call("POST", "/ext/theme/fetch".into(), Some(json!({ "url": hit.url })), 60, |r| {
            Ev::Picture(r.and_then(|v| v["path"].as_str().map(str::to_owned).ok_or_else(|| "The picture didn't download.".to_owned())))
        });
    }

    /// Asks the model for a theme from the words in the box.
    pub fn generate_theme(&mut self) {
        let prompt = self.look.edit(LookEdit::Prompt).text.trim().to_owned();
        if prompt.is_empty() || self.look.generating {
            return;
        }
        self.look.generating = true;
        self.look.gen_error = None;
        let current = self.prefs.look.clone();
        let fonts: Vec<String> = self.look.font_choices().into_iter().take(60).collect();
        let body = json!({ "prompt": prompt, "mode": current.mode.name(), "fonts": fonts });
        self.look.call("POST", "/ext/theme/generate".into(), Some(body), 120, move |r| {
            Ev::Generated(r.and_then(|v| Candidate::from_json(&v, &current)))
        });
    }

    /// Makes the previewed theme the app's look.
    pub fn apply_candidate(&mut self) {
        let Some(c) = self.look.candidate.take() else { return };
        let look = &mut self.prefs.look;
        look.mode = c.look.mode;
        look.name = c.name.clone();
        look.bg = c.look.bg.clone();
        look.side = c.look.side.clone();
        look.text = c.look.text.clone();
        look.accent = c.look.accent.clone();
        if c.font {
            look.font = c.look.font.clone();
            look.size = c.look.size;
            look.weight = c.look.weight;
        }
        if c.background {
            look.bg_kind = c.look.bg_kind;
            if matches!(c.look.bg_kind, BgKind::Ascii | BgKind::Dots) {
                look.art = c.look.art.clone();
            }
        }
        for slot in Slot::ALL {
            let v = self.prefs.look.colour(slot).unwrap_or("").to_owned();
            self.look.edit_mut(slot.edit()).replace_text(v);
        }
        // A picture theme searches for its picture and takes the first one that comes back.
        if let Some(q) = c.query.filter(|_| c.background) {
            self.look.edit_mut(LookEdit::Search).replace_text(q.clone());
            self.search_for(&q, true);
        }
        self.save_look();
    }

    /// Sample state for headless renders and tests: a generated theme waiting to be applied, and
    /// pictures from a search. Nothing here touches the network.
    /// Uses the sample picture as the background (headless runs and tests have no files).
    pub fn use_picture_sample(&mut self) {
        self.use_picture(SAMPLE);
    }

    pub fn theme_demo(&mut self) {
        let tokyo = json!({ "theme": {
            "name": "Rainy Tokyo", "mode": "dark",
            "colors": { "bg": "#0b1220", "side": "#101a2e", "text": "#dbe6ff", "accent": "#7c5cff" },
            "font": { "family": "Geist", "size": 1, "weight": 1 },
            "background": { "kind": "dots", "art": [
                "                                        ",
                "                  @@@@                  ",
                "                @@@@@@@@                ",
                "                 @@@@@@                 ",
                "                                        ",
                "     ....::::::------=====++++++****    ",
                "  ..::--==++**##%%@@@@@@%%##**++==--::..",
            ] }
        } });
        self.look.candidate = Candidate::from_json(&tokyo, &self.prefs.look).ok();
        self.look.edit_mut(LookEdit::Prompt).replace_text("Make it feel like a rainy Tokyo night".to_owned());
        self.look.edit_mut(LookEdit::Search).replace_text("rainy tokyo".to_owned());
        self.look.hits = (1..=4).map(|i| Hit { title: format!("Sample {i}"), thumb: SAMPLE.into(), url: SAMPLE.into(), credit: String::new() }).collect();
    }

    /// `--look mode,size,bg` for headless renders, e.g. `light,3,dots`: mode (dark, light), size
    /// step 0 to 4, and a background (picture, ascii, dots) drawn from the sample picture.
    pub fn look_flags(&mut self, spec: &str) {
        for part in spec.split(',') {
            let look = &mut self.prefs.look;
            match part.trim() {
                "dark" => look.mode = Mode::Dark,
                "light" => look.mode = Mode::Light,
                "bold" => look.weight = 3,
                "geist" => look.font = "Geist".into(),
                "inter" => look.font = "Inter".into(),
                "picture" | "ascii" | "dots" => {
                    look.bg_kind = BgKind::from_name(part.trim()).unwrap_or_default();
                    look.picture = SAMPLE.into();
                    look.art = Grid::from_rgba(&art::sample_picture().2, 640, 360).map(|g| g.to_lines()).unwrap_or_default();
                }
                n => {
                    if let Ok(i) = n.parse::<usize>() {
                        look.size = i.min(SIZES.len() - 1);
                    } else if theme::is_hex(n) {
                        look.accent = Some(n.to_owned());
                    }
                }
            }
        }
    }

    pub fn discard_candidate(&mut self) {
        self.look.candidate = None;
    }

    /// Back to the stock dark look: colours, font and background (the picture file stays).
    pub fn reset_look(&mut self) {
        let keep = self.prefs.look.picture.clone();
        self.prefs.look = LookPrefs { picture: keep, ..LookPrefs::default() };
        for slot in Slot::ALL {
            self.look.edit_mut(slot.edit()).clear();
        }
        self.save_look();
    }

    /// Folds in what the background threads finished: searches, themes, pictures, fonts.
    fn fold_events(&mut self) -> bool {
        let mut changed = false;
        let events: Vec<Ev> = std::mem::take(&mut *self.look.events.lock().unwrap_or_else(|e| e.into_inner()));
        for ev in events {
            changed = true;
            match ev {
                Ev::Fonts(f) => self.look.fonts = f,
                Ev::Hits { hits, pick } => {
                    self.look.searching = false;
                    self.look.search_error = hits.is_empty().then(|| "No pictures found. Try other words.".to_owned());
                    self.look.hits = hits;
                    if pick && self.look.pending_pick {
                        self.look.pending_pick = false;
                        self.use_hit(0);
                    }
                }
                Ev::SearchFailed(e) => {
                    self.look.searching = false;
                    self.look.pending_pick = false;
                    self.look.search_error = Some(e);
                }
                Ev::Generated(r) => {
                    self.look.generating = false;
                    match r {
                        Ok(c) => self.look.candidate = Some(c),
                        Err(e) => self.look.gen_error = Some(e),
                    }
                }
                Ev::Picture(r) => {
                    self.look.working = false;
                    match r {
                        Ok(path) => self.use_picture(&path),
                        Err(e) => self.look.search_error = Some(e),
                    }
                }
                Ev::Art(r) => {
                    self.look.working = false;
                    match r {
                        Ok(lines) => {
                            self.prefs.look.art = lines;
                            self.save_look();
                        }
                        Err(e) => self.look.search_error = Some(e),
                    }
                }
            }
        }
        changed
    }

    /// Every frame: folds in finished searches, themes and pictures, asks for the installed
    /// fonts once Appearance is open, and moves Rune to the chosen font stacks. True when the
    /// view must be rebuilt.
    pub fn look_poll(&mut self, tx: &mut Tx) -> bool {
        let mut changed = false;
        if !self.look.fonts_asked && self.view == crate::app::View::Settings && self.settings == crate::app::SettingsPage::Appearance {
            self.look.fonts_asked = true;
            if self.look.online() {
                self.look.call("GET", "/ext/theme/fonts".into(), None, 20, |r| Ev::Fonts(r.map_or_else(|_| Vec::new(), |v| strings(&v["fonts"]))));
            }
        }
        changed |= self.fold_events();
        // A colour typed in a hex field applies as soon as it is whole.
        for slot in Slot::ALL {
            let typed = self.look.edit(slot.edit()).text.trim().to_owned();
            let typed = if typed.starts_with('#') || typed.is_empty() { typed } else { format!("#{typed}") };
            if typed.len() == 7 && theme::is_hex(&typed) && self.prefs.look.colour(slot) != Some(typed.as_str()) {
                self.prefs.look.set_colour(slot, Some(typed));
                self.save_look();
                changed = true;
            }
        }
        // Without an engine to list the installed fonts, offer the usual ones.
        if self.look.fonts.is_empty() && !self.look.online() {
            self.look.fonts = ["Segoe UI", "Calibri", "Arial", "Verdana", "Tahoma", "Trebuchet MS", "Georgia", "Cambria", "Candara"].map(str::to_owned).to_vec();
        }
        let want = self.prefs.look.families();
        if want != self.look.families {
            tx.set_font_families(want.0.clone(), want.1.clone());
            self.look.families = want;
            changed = true;
        }
        changed
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map_or_else(Vec::new, |a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
}

fn encode(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn look_prefs_round_trip_and_reject_bad_colours() {
        let mut l = LookPrefs { mode: Mode::Light, accent: Some("#ff8800".into()), font: "Geist".into(), size: 3, weight: 2, ..LookPrefs::default() };
        l.bg_kind = BgKind::Dots;
        l.art = vec!["@@  ..".into()];
        assert_eq!(LookPrefs::from_json(&l.to_json()), l);
        let bad = LookPrefs::from_json(&json!({ "accent": "javascript:alert(1)", "bg": "#12", "size": 99, "mode": "neon" }));
        assert_eq!((bad.accent, bad.bg, bad.size, bad.mode), (None, None, SIZES.len() - 1, Mode::Dark));
    }

    #[test]
    fn a_generated_theme_is_checked_before_it_is_used() {
        let cur = LookPrefs::default();
        let ok = Candidate::from_json(&json!({ "theme": {
            "name": "Rainy Tokyo", "mode": "dark",
            "colors": { "bg": "#0b1220", "side": "nope", "text": "#dbe6ff", "accent": "#7c5cff" },
            "font": { "family": "Geist<script>", "size": 2, "weight": 1 },
            "background": { "kind": "ascii", "art": ["  @@  ", " @@@@ ", "......"] }
        } }), &cur).expect("candidate");
        assert_eq!((ok.look.bg.as_deref(), ok.look.side.as_deref()), (Some("#0b1220"), None));
        assert_eq!(ok.look.font, "Geistscript");
        assert!(ok.font && ok.background && ok.look.bg_kind == BgKind::Ascii);
        assert!(Candidate::from_json(&json!({ "theme": { "name": "x", "colors": { "bg": "red" } } }), &cur).is_err());
        // Art that is empty is not a background.
        let none = Candidate::from_json(&json!({ "theme": { "colors": { "accent": "#fff" }, "background": { "kind": "dots", "art": [] } } }), &cur).expect("candidate");
        assert!(!none.background);
    }

    #[test]
    fn the_font_stack_leads_with_the_choice() {
        let l = LookPrefs { font: "Geist".into(), ..LookPrefs::default() };
        assert!(l.families().0.starts_with("Geist, Segoe UI Variable"));
        assert_eq!(LookPrefs::default().families().0, theme::UI_FAMILIES);
    }
}

#[cfg(all(test, feature = "live"))]
mod net_tests {
    use super::*;
    use std::io::{Read, Write};

    /// A tiny HTTP server that answers every request with `body`.
    fn serve(body: &'static str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!("http://{}", listener.local_addr().expect("addr"));
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        url
    }

    fn wait_for(app: &mut App, done: impl Fn(&App) -> bool) {
        for _ in 0..200 {
            app.fold_events();
            if done(app) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("the engine's answer never arrived");
    }

    #[test]
    fn a_picture_search_lands_as_results() {
        let mut app = App::with_mock();
        app.look.set_remote(&serve(r#"{"hits":[{"title":"Rain","thumb":"/tmp/t.jpg","url":"https://x/y.jpg","credit":"A"},{"title":"no url"}]}"#), "t");
        app.look.edit_mut(LookEdit::Search).replace_text("rain".to_owned());
        app.search_images();
        assert!(app.look.searching);
        wait_for(&mut app, |a| !a.look.searching);
        assert_eq!(app.look.hits.len(), 1, "a result without its URL is dropped");
        assert_eq!(app.look.hits[0].title, "Rain");
    }

    #[test]
    fn a_generated_theme_arrives_as_a_preview_then_applies() {
        let mut app = App::with_mock();
        app.look.set_remote(&serve(r##"{"theme":{"name":"Mist","mode":"light","colors":{"bg":"#f4f1ea","text":"#222222","accent":"#3b6ea5"},"font":{"family":"Geist","size":2,"weight":1}}}"##), "t");
        app.look.edit_mut(LookEdit::Prompt).replace_text("a quiet misty morning".to_owned());
        app.generate_theme();
        wait_for(&mut app, |a| a.look.candidate.is_some());
        assert_eq!(app.prefs.look.mode, Mode::Dark, "nothing changes before Apply");
        app.apply_candidate();
        let l = &app.prefs.look;
        assert_eq!((l.mode, l.name.as_str(), l.bg.as_deref(), l.font.as_str(), l.size), (Mode::Light, "Mist", Some("#f4f1ea"), "Geist", 2));
        assert!(app.look.candidate.is_none());
    }

    #[test]
    fn an_engine_error_is_shown_not_swallowed() {
        let mut app = App::with_mock();
        app.look.set_remote("http://127.0.0.1:9", "t");
        app.look.edit_mut(LookEdit::Prompt).replace_text("anything".to_owned());
        app.generate_theme();
        wait_for(&mut app, |a| !a.look.generating);
        assert!(app.look.gen_error.is_some());
    }
}
