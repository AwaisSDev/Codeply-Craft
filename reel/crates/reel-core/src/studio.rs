//! The Studio: one FilmCraft session (the edit: bins, sequences, timeline, export) and one
//! EffectCraft session (motion graphics: comps, layers, keyframes, effects) behind a single
//! command namespace.
//!
//! * `cut.<id>` runs a FilmCraft command, `fx.<id>` an EffectCraft command.
//! * A bare id (`timeline.razor`) goes to whichever engine has it; an id both have is an error
//!   that names both.
//! * `reel.<id>` are the cross-engine and agent-economy commands (see [`HELP`]).

use std::collections::{HashMap, VecDeque};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use serde_json::{Value, json};

use crate::compact::{self, prune, select};
use crate::dsl::{self, Step};
use crate::probe::{self, Rgba};

pub const HELP: &str = "\
reel: one command line per step. `cmd k=v k2=[a,b] k3.sub=1` or {\"cmd\":..,\"params\":{..}}; `;` chains.
namespaces: cut.* = FilmCraft (edit/timeline/export) | fx.* = EffectCraft (comps/layers/keys/effects) | reel.* = cross-engine. Bare ids auto-route.
refs: $1.layer = step 1's result .layer, $-1 = previous step. Meta params on any step: _select=a.b,c.*.id (keep fields) _budget=N (max reply tokens, 0=all) _raw=true (no pruning).
reel.find q=<words> [engine=cut|fx] [limit=20]       search both command catalogs (one line each)
reel.describe cmd=<id>                                 full params doc for one command
reel.state [_select=..]                                cut project+sequence and fx project, pruned
reel.diff                                              only what changed since last state/diff
reel.probe [engine=cut|fx] [t=sec] [comp=..] [ascii=48]  frame stats as text: luma, grid, palette, hash
reel.frame out=/path.png [engine] [t] [comp] [max=960] write a PNG to disk (path back, no pixels)
reel.compare a=<hash> b=<hash>                         picture distance of two probe hashes
reel.fx2cut comp=<name|id> [track=V2] [seconds=0]       render an fx comp (ProRes 4444 alpha) and place it in the cut
reel.save dir=<d> | reel.open dir=<d>                  both projects as <d>/cut.fcproj + <d>/fx.ecproj
reel.log [n=20] | reel.reset | reel.help";

/// One executed step, for the dashboard.
#[derive(Clone, Debug)]
pub struct LogEntry {
    pub at_ms: u128,
    pub cmd: String,
    pub ok: bool,
    pub ms: f64,
    pub tokens: usize,
    pub err: Option<String>,
}

#[derive(Default, Debug)]
pub struct Telemetry {
    pub log: VecDeque<LogEntry>,
    pub steps: u64,
    pub errors: u64,
    pub tokens_out: u64,
    pub busy_ms: f64,
    pub rev: u64,
    pub per_engine: HashMap<String, u64>,
    pub summary: Value,
}

const LOG_CAP: usize = 500;
const DEFAULT_BUDGET: usize = 1500;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Engine {
    Cut,
    Fx,
    Reel,
}

impl Engine {
    fn tag(self) -> &'static str {
        match self {
            Engine::Cut => "cut",
            Engine::Fx => "fx",
            Engine::Reel => "reel",
        }
    }
}

pub struct Studio {
    cut: filmcraft_engine::Session,
    fx: effectcraft_engine::Session,
    /// command id → engines that have it (filled on first bare-id route)
    ids: Option<HashMap<String, Vec<Engine>>>,
    snapshot: Option<Value>,
    work: PathBuf,
    started: Instant,
    pub tele: Arc<Mutex<Telemetry>>,
}

impl Studio {
    pub fn new(work: PathBuf) -> Self {
        Studio {
            cut: new_cut(),
            fx: effectcraft_host::session(),
            ids: None,
            snapshot: None,
            work,
            started: Instant::now(),
            tele: Arc::new(Mutex::new(Telemetry::default())),
        }
    }

    /// Run a script; one reply for the whole thing. A single step's reply is
    /// `{"ok":true,"r":<result>}`; several steps give `"r":[...]`. The first failing step stops
    /// the script: `{"ok":false,"at":<1-based step>,"err":..,"r":[results so far]}`.
    pub fn run(&mut self, src: &str) -> Value {
        let steps = match dsl::parse_script(src) {
            Ok(s) => s,
            Err(e) => return json!({"ok": false, "err": e}),
        };
        self.run_steps(&steps)
    }

    pub fn run_steps(&mut self, steps: &[Step]) -> Value {
        let rev0 = self.rev();
        let r = self.run_inner(steps);
        if self.rev() != rev0 {
            // keep the dashboard's document summary current: once per script, not per step
            self.doc();
        }
        r
    }

    fn rev(&self) -> u64 {
        self.tele.lock().unwrap_or_else(PoisonError::into_inner).rev
    }

    fn run_inner(&mut self, steps: &[Step]) -> Value {
        let t0 = Instant::now();
        let mut results: Vec<Value> = Vec::with_capacity(steps.len());
        let mut shown: Vec<Value> = Vec::with_capacity(steps.len());
        for (i, st) in steps.iter().enumerate() {
            let r = dsl::resolve_refs(&st.params, &results).and_then(|p| self.step(&st.cmd, p));
            match r {
                Ok((full, show)) => {
                    results.push(full);
                    shown.push(show);
                }
                Err(e) => {
                    let mut v = json!({"ok": false, "at": i + 1, "cmd": st.cmd, "err": e});
                    if !shown.is_empty() {
                        v["r"] = Value::Array(shown);
                    }
                    return v;
                }
            }
        }
        let ms = (t0.elapsed().as_secs_f64() * 10000.0).round() / 10.0;
        let r = if shown.len() == 1 { shown.pop().unwrap_or_default() } else { Value::Array(shown) };
        json!({"ok": true, "r": r, "ms": ms})
    }

    /// One step: returns the full result (for `$refs`) and the shaped reply (for the agent).
    fn step(&mut self, cmd: &str, mut params: Value) -> Result<(Value, Value), String> {
        let meta = take_meta(&mut params);
        let t0 = Instant::now();
        let routed = self.route(cmd);
        let res = routed.clone().and_then(|(eng, id)| {
            let p = params.clone();
            catch_unwind(AssertUnwindSafe(|| self.dispatch(eng, &id, p))).unwrap_or_else(|p| Err(format!("internal error: {}", panic_text(p))))
        });
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        let shaped = res.as_ref().ok().map(|v| shape(v, &meta));
        let tokens = shaped.as_ref().map_or(0, compact::tokens);
        if !meta.quiet {
            self.record(cmd, routed.as_ref().ok().map(|r| r.0), &res, ms, tokens);
        }
        let full = res?;
        Ok((full, shaped.unwrap_or_default()))
    }

    fn record(&mut self, cmd: &str, eng: Option<Engine>, res: &Result<Value, String>, ms: f64, tokens: usize) {
        let mut t = self.tele.lock().unwrap_or_else(PoisonError::into_inner);
        t.steps += 1;
        t.busy_ms += ms;
        t.tokens_out += tokens as u64;
        if let Some(e) = eng {
            *t.per_engine.entry(e.tag().into()).or_default() += 1;
            if e != Engine::Reel && res.is_ok() && !is_read_only(cmd) {
                t.rev += 1;
            }
        }
        if res.is_err() {
            t.errors += 1;
        }
        t.log.push_back(LogEntry {
            at_ms: self.started.elapsed().as_millis(),
            cmd: cmd.to_string(),
            ok: res.is_ok(),
            ms: (ms * 10.0).round() / 10.0,
            tokens,
            err: res.as_ref().err().cloned(),
        });
        while t.log.len() > LOG_CAP {
            t.log.pop_front();
        }
    }

    fn route(&mut self, cmd: &str) -> Result<(Engine, String), String> {
        if let Some((ns, id)) = cmd.split_once('.') {
            match ns {
                "cut" => return Ok((Engine::Cut, id.to_string())),
                "fx" => return Ok((Engine::Fx, id.to_string())),
                "reel" => return Ok((Engine::Reel, id.to_string())),
                _ => {}
            }
        }
        let ids = self.ids();
        match ids.get(cmd).map(Vec::as_slice) {
            Some([e]) => Ok((*e, cmd.to_string())),
            Some(_) => Err(format!("`{cmd}` exists in both engines: say cut.{cmd} (edit) or fx.{cmd} (motion)")),
            None => {
                let near = suggest(cmd, ids.keys());
                Err(format!("unknown command `{cmd}`{}", if near.is_empty() { String::new() } else { format!("; did you mean {}", near.join(", ")) }))
            }
        }
    }

    fn ids(&mut self) -> &HashMap<String, Vec<Engine>> {
        if self.ids.is_none() {
            let mut m: HashMap<String, Vec<Engine>> = HashMap::new();
            for (eng, list) in [(Engine::Cut, self.catalog(Engine::Cut)), (Engine::Fx, self.catalog(Engine::Fx))] {
                for c in list {
                    if let Some(id) = c.get("id").and_then(Value::as_str) {
                        m.entry(id.to_string()).or_default().push(eng);
                    }
                }
            }
            self.ids = Some(m);
        }
        self.ids.get_or_insert_with(HashMap::new)
    }

    fn catalog(&mut self, eng: Engine) -> Vec<Value> {
        let r = match eng {
            Engine::Cut => self.cut.execute("command.list", json!({})).ok(),
            Engine::Fx => self.fx_exec("command.list", json!({})).ok(),
            Engine::Reel => None,
        };
        r.and_then(|v| v.as_array().cloned()).unwrap_or_default()
    }

    fn fx_exec(&mut self, id: &str, params: Value) -> Result<Value, String> {
        let r = self.fx.execute_checked(id, params);
        self.fx.drain_events();
        r.map_err(|e| e.to_string())
    }

    fn cut_exec(&mut self, id: &str, params: Value) -> Result<Value, String> {
        self.cut.execute(id, params).map_err(|e| e.to_string())
    }

    fn dispatch(&mut self, eng: Engine, id: &str, p: Value) -> Result<Value, String> {
        match eng {
            Engine::Cut => self.cut_exec(id, p),
            Engine::Fx => self.fx_exec(id, p),
            Engine::Reel => self.builtin(id, p),
        }
    }

    fn builtin(&mut self, id: &str, p: Value) -> Result<Value, String> {
        match id {
            "help" => Ok(json!(HELP)),
            "find" => self.find(&p),
            "describe" => self.describe(&p),
            "state" => {
                let d = self.doc();
                self.snapshot = Some(d.clone());
                Ok(d)
            }
            "diff" => self.diff(),
            "probe" => {
                let (w, h, px, eng) = self.render(&p, 640)?;
                let mut v = probe::stats(&Rgba { w, h, px: &px }, p.get("ascii").and_then(Value::as_u64).unwrap_or(0) as u32);
                v["engine"] = json!(eng.tag());
                Ok(v)
            }
            "frame" => {
                let out = p.get("out").and_then(Value::as_str).ok_or("need out=/path.png")?.to_string();
                let max = p.get("max").and_then(Value::as_u64).unwrap_or(960) as u32;
                let (w, h, px, eng) = self.render(&p, max)?;
                image::RgbaImage::from_raw(w, h, px).ok_or("bad frame buffer")?.save(&out).map_err(|e| format!("write {out}: {e}"))?;
                Ok(json!({"out": out, "size": [w, h], "engine": eng.tag()}))
            }
            "compare" => {
                let g = |k: &str| p.get(k).and_then(Value::as_str).ok_or(format!("need {k}=<hash from reel.probe>"));
                let d = probe::hash_distance(g("a")?, g("b")?).ok_or("hashes are 16 hex digits")?;
                Ok(json!({"distance": d, "same": d <= 4, "verdict": match d { 0..=4 => "same picture", 5..=12 => "similar", _ => "different" }}))
            }
            "fx2cut" => self.fx2cut(&p),
            "save" => {
                let dir = PathBuf::from(p.get("dir").and_then(Value::as_str).ok_or("need dir=")?);
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let (c, f) = (dir.join("cut.fcproj"), dir.join("fx.ecproj"));
                self.cut_exec("file.saveAs", json!({"path": c}))?;
                self.fx_exec("file.saveAs", json!({"path": f}))?;
                Ok(json!({"cut": c, "fx": f}))
            }
            "open" => {
                let dir = PathBuf::from(p.get("dir").and_then(Value::as_str).ok_or("need dir=")?);
                let (c, f) = (dir.join("cut.fcproj"), dir.join("fx.ecproj"));
                let mut opened = vec![];
                if c.exists() {
                    self.cut_exec("file.open", json!({"path": c}))?;
                    opened.push("cut");
                }
                if f.exists() {
                    self.fx_exec("file.open", json!({"path": f}))?;
                    opened.push("fx");
                }
                self.snapshot = None;
                Ok(json!({"opened": opened}))
            }
            "log" => {
                let n = p.get("n").and_then(Value::as_u64).unwrap_or(20) as usize;
                let t = self.tele.lock().unwrap_or_else(PoisonError::into_inner);
                Ok(Value::Array(
                    t.log.iter().rev().take(n).map(|e| json!([e.cmd, e.ok, e.ms, e.tokens, e.err])).collect::<Vec<_>>().into_iter().rev().collect(),
                ))
            }
            "reset" => {
                self.cut = new_cut();
                self.fx = effectcraft_host::session();
                self.snapshot = None;
                Ok(json!("fresh sessions"))
            }
            _ => Err(format!("unknown reel command `reel.{id}` (reel.help lists them)")),
        }
    }

    fn find(&mut self, p: &Value) -> Result<Value, String> {
        let q = p.get("q").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
        let terms: Vec<&str> = q.split_whitespace().collect();
        let limit = p.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize;
        let only = p.get("engine").and_then(Value::as_str);
        let mut hits: Vec<(usize, String)> = Vec::new();
        let mut total = 0;
        for eng in [Engine::Cut, Engine::Fx] {
            if only.is_some_and(|o| o != eng.tag()) {
                continue;
            }
            for c in self.catalog(eng) {
                let id = c.get("id").and_then(Value::as_str).unwrap_or_default();
                let label = c.get("label").and_then(Value::as_str).unwrap_or_default();
                let hay = format!("{} {}", id.to_ascii_lowercase(), label.to_ascii_lowercase());
                if !terms.iter().all(|t| hay.contains(t)) {
                    continue;
                }
                total += 1;
                // id hits rank above label-only hits; shorter ids first
                let score = terms.iter().filter(|t| id.to_ascii_lowercase().contains(**t)).count() * 1000 + 999usize.saturating_sub(id.len());
                let mut line = format!("{}.{id}", eng.tag());
                if !label.is_empty() && !label.eq_ignore_ascii_case(id) {
                    line.push_str(" | ");
                    line.push_str(label);
                }
                if let Some(ps) = params_brief(&c) {
                    line.push_str(" | ");
                    line.push_str(&ps);
                }
                if c.get("enabled").and_then(Value::as_bool) == Some(false) {
                    line.push_str(" (disabled now)");
                }
                hits.push((score, line));
            }
        }
        hits.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        let lines: Vec<String> = hits.into_iter().take(limit).map(|h| h.1).collect();
        Ok(json!({"n": total, "hits": lines}))
    }

    fn describe(&mut self, p: &Value) -> Result<Value, String> {
        let cmd = p.get("cmd").and_then(Value::as_str).ok_or("need cmd=<id>")?;
        let (eng, id) = self.route(cmd)?;
        match eng {
            Engine::Fx => self.fx_exec("command.describe", json!({"command": id})),
            Engine::Cut => self
                .catalog(Engine::Cut)
                .into_iter()
                .find(|c| c.get("id").and_then(Value::as_str) == Some(id.as_str()))
                .ok_or_else(|| format!("no cut command `{id}`")),
            Engine::Reel => Ok(json!(HELP.lines().find(|l| l.contains(&format!("reel.{id}"))).unwrap_or(HELP))),
        }
    }

    /// The whole document as the agent sees it.
    fn doc(&mut self) -> Value {
        let project = self.cut_exec("project.inspect", json!({})).unwrap_or(Value::Null);
        let sequence = self.cut_exec("sequence.inspect", json!({})).unwrap_or(Value::Null);
        let fx = self.fx_exec("project.summary", json!({})).unwrap_or(Value::Null);
        let rev = self.tele.lock().unwrap_or_else(PoisonError::into_inner).rev;
        let d = prune(&json!({"rev": rev, "cut": {"project": project, "sequence": sequence}, "fx": fx}), 4);
        self.tele.lock().unwrap_or_else(PoisonError::into_inner).summary = summary(&d);
        d
    }

    fn diff(&mut self) -> Result<Value, String> {
        let now = self.doc();
        let Some(prev) = self.snapshot.replace(now.clone()) else {
            return Ok(json!({"baseline": true, "summary": summary(&now), "hint": "next reel.diff reports only changes"}));
        };
        let (changes, n) = compact::diff(&prev, &now, 60);
        let mut v = json!({"n": n, "changes": changes});
        if n > changes.len() {
            v["more"] = json!(n - changes.len());
        }
        Ok(v)
    }

    /// Render a frame from whichever engine the params name (`engine`, or `comp` ⇒ fx; else the
    /// cut when it has a sequence). Returns straight RGBA8.
    fn render(&mut self, p: &Value, max_side: u32) -> Result<(u32, u32, Vec<u8>, Engine), String> {
        let t = p.get("t").or_else(|| p.get("seconds")).and_then(Value::as_f64);
        let eng = match p.get("engine").and_then(Value::as_str) {
            Some("cut") => Engine::Cut,
            Some("fx") => Engine::Fx,
            Some(o) => return Err(format!("engine must be cut or fx, not `{o}`")),
            None if p.get("comp").is_some() => Engine::Fx,
            None if self.cut.active_sequence().is_some() => Engine::Cut,
            None => Engine::Fx,
        };
        match eng {
            Engine::Cut => {
                let (w, h) = self.cut.active_sequence().map(|q| (q.settings.width, q.settings.height)).ok_or("cut has no open sequence")?;
                let scale = (max_side as f32 / w.max(h).max(1) as f32).min(1.0);
                let at = t.map_or_else(|| self.cut.playhead(), filmcraft_time::Tick::from_seconds_f64);
                let img = self.cut.try_render_program_at(scale, at).map_err(|e| e.to_string())?;
                Ok((img.w as u32, img.h as u32, img.over_black_rgba8(), eng))
            }
            _ => {
                let cid = self.fx.resolve_comp(p.get("comp")).map_err(|_| "fx has no such / no active comp (fx.comp.new …)".to_string())?;
                let at = t.map_or_else(|| self.fx.time(), effectcraft_engine::time::Tick::from_seconds_f64);
                let (w, h, px) = self.fx.render_rgba8_alpha(cid, at, max_side, false).map_err(|e| e.to_string())?;
                Ok((w, h, px, Engine::Fx))
            }
        }
    }

    /// Render an fx comp to a ProRes 4444 movie (alpha kept) and lay it into the cut.
    fn fx2cut(&mut self, p: &Value) -> Result<Value, String> {
        let comp = p.get("comp").cloned().ok_or("need comp=<name|id>")?;
        let cid = self.fx.resolve_comp(Some(&comp)).map_err(|_| format!("no fx comp {comp}"))?;
        std::fs::create_dir_all(&self.work).map_err(|e| e.to_string())?;
        let out = match p.get("out").and_then(Value::as_str) {
            Some(o) => PathBuf::from(o),
            None => self.work.join(format!("fx_{}_{}.mov", cid.0, self.started.elapsed().as_millis())),
        };
        self.fx_exec("renderQueue.add", json!({"comp": cid.0, "format": "prores", "proresProfile": 4444, "channels": "rgba", "output": out}))?;
        let rendered = self.fx_exec("renderQueue.render", json!({"wait": true}))?;
        if !out.exists() {
            return Err(format!("fx render produced no file at {} ({rendered})", out.display()));
        }
        let imported = self.cut_exec("file.import", json!({"paths": [out]}))?;
        let item = first_id(&imported).ok_or_else(|| format!("import gave no item: {imported}"))?;
        let placed = if self.cut.active_sequence().is_none() {
            self.cut_exec("file.newSequenceFromClip", json!({"items": [item]}))?
        } else {
            let mut place = json!({"item": item, "seconds": p.get("seconds").and_then(Value::as_f64).unwrap_or(0.0)});
            if let Some(tr) = p.get("track") {
                place["track"] = tr.clone();
            }
            self.cut_exec("timeline.place", place)?
        };
        Ok(json!({"file": out, "item": item, "placed": prune(&placed, 3)}))
    }
}

fn new_cut() -> filmcraft_engine::Session {
    let mut s = filmcraft_engine::Session::default();
    if let Some(dir) = filmcraft_engine::autosave::default_data_dir() {
        s.export_presets.set_dir(&dir);
    }
    s
}

/// Pull `_select`, `_budget`, `_raw`, `_quiet` out of the params.
struct Meta {
    select: Vec<String>,
    budget: usize,
    raw: bool,
    /// not logged or counted (the dashboard's own preview renders)
    quiet: bool,
}

fn take_meta(p: &mut Value) -> Meta {
    let mut m = Meta { select: vec![], budget: DEFAULT_BUDGET, raw: false, quiet: false };
    if let Value::Object(o) = p {
        m.quiet = o.remove("_quiet").and_then(|q| q.as_bool()).unwrap_or(false);
        if let Some(s) = o.remove("_select") {
            m.select = match s {
                Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
                Value::String(s) => s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
                _ => vec![],
            };
        }
        if let Some(b) = o.remove("_budget").and_then(|b| b.as_u64()) {
            m.budget = if b == 0 { usize::MAX } else { b as usize };
        }
        if let Some(r) = o.remove("_raw") {
            m.raw = r.as_bool().unwrap_or(false);
        }
    }
    m
}

fn shape(v: &Value, m: &Meta) -> Value {
    let mut out = if m.raw { v.clone() } else { prune(v, 4) };
    if !m.select.is_empty() {
        let paths: Vec<&str> = m.select.iter().map(String::as_str).collect();
        out = select(&out, &paths);
    }
    let t = compact::tokens(&out);
    if t > m.budget {
        return json!({
            "truncated": true,
            "tokens": t,
            "outline": outline(&out, 2),
            "hint": "add _select=<paths> (e.g. tracks.*.clips.*.id) or _budget=0 for everything",
        });
    }
    out
}

/// Shape of a document without its bulk: keys, array lengths, scalar types.
fn outline(v: &Value, depth: usize) -> Value {
    match v {
        Value::Object(m) if depth > 0 => Value::Object(m.iter().map(|(k, x)| (k.clone(), outline(x, depth - 1))).collect()),
        Value::Object(m) => json!(format!("{{{} keys}}", m.len())),
        Value::Array(a) => json!(format!("[{}]", a.len())),
        Value::String(s) if s.len() > 40 => json!(format!("{}…", &s[..s.char_indices().nth(40).map_or(s.len(), |c| c.0)])),
        _ => v.clone(),
    }
}

/// A few numbers that say what the document holds (dashboard header, diff baseline).
fn summary(doc: &Value) -> Value {
    let count = |v: Option<&Value>| v.and_then(Value::as_array).map_or(0, Vec::len);
    let seq = doc.pointer("/cut/sequence");
    let tracks = |k: &str| seq.and_then(|s| s.get(k)).and_then(Value::as_array).cloned().unwrap_or_default();
    let clips = |k: &str| tracks(k).iter().map(|t| count(t.get("items"))).sum::<usize>();
    let items = doc.pointer("/fx/items").and_then(Value::as_array).cloned().unwrap_or_default();
    let comps: Vec<Value> = items
        .iter()
        .filter(|i| i.get("type").and_then(Value::as_str) == Some("Composition"))
        .map(|c| json!(format!("{}#{} {}L {}s", c["name"].as_str().unwrap_or("?"), c["id"], c["layers"], c["duration"])))
        .collect();
    json!({
        "rev": doc.get("rev"),
        "cut": {
            "sequence": seq.map(|s| format!("{}#{} {}x{} {}f", s["name"].as_str().unwrap_or("?"), s["id"], s["settings"]["width"], s["settings"]["height"], s["durationFrames"])),
            "tracks": format!("{}V {}A", tracks("video").len(), tracks("audio").len()),
            "clips": format!("{}V {}A", clips("video"), clips("audio")),
            "bins": count(doc.pointer("/cut/project/root/children")),
        },
        "fx": {
            "comps": comps,
            "items": items.len(),
            "active": doc.pointer("/fx/activeComp"),
        },
    })
}

fn params_brief(c: &Value) -> Option<String> {
    let p = c.get("params").or_else(|| c.get("paramDoc")).or_else(|| c.get("doc"))?;
    let s = match p {
        Value::String(s) => s.clone(),
        Value::Object(m) if !m.is_empty() => m.keys().cloned().collect::<Vec<_>>().join(","),
        _ => return None,
    };
    let s = s.trim();
    if s.is_empty() || s == "{}" {
        return None;
    }
    Some(if s.chars().count() > 90 { format!("{}…", s.chars().take(90).collect::<String>()) } else { s.to_string() })
}

fn is_read_only(cmd: &str) -> bool {
    let id = cmd.rsplit('.').next().unwrap_or(cmd).to_ascii_lowercase();
    ["inspect", "list", "describe", "summary", "info", "state", "status", "capabilities", "fonts", "get"].iter().any(|w| id.contains(w))
}

fn first_id(v: &Value) -> Option<Value> {
    for k in ["items", "item", "ids", "imported"] {
        match v.get(k) {
            Some(Value::Array(a)) if !a.is_empty() => return Some(a[0].get("id").cloned().unwrap_or_else(|| a[0].clone())),
            Some(x @ Value::Number(_)) => return Some(x.clone()),
            _ => {}
        }
    }
    match v {
        Value::Array(a) => a.first().map(|x| x.get("id").cloned().unwrap_or_else(|| x.clone())),
        Value::Number(_) => Some(v.clone()),
        _ => None,
    }
}

/// Closest ids by edit distance (typos), then ids containing the last segment.
fn suggest<'a>(cmd: &str, ids: impl Iterator<Item = &'a String>) -> Vec<String> {
    let want = cmd.to_ascii_lowercase();
    let last = want.rsplit('.').next().unwrap_or(&want).to_string();
    let mut scored: Vec<(usize, &String)> = ids
        .filter_map(|id| {
            let l = id.to_ascii_lowercase();
            let d = levenshtein(&want, &l);
            if d <= 2.max(want.len() / 6) {
                Some((d, id))
            } else if last.len() >= 3 && l.contains(&last) {
                Some((10 + l.len(), id))
            } else {
                None
            }
        })
        .collect();
    scored.sort();
    scored.into_iter().take(4).map(|(_, id)| id.clone()).collect()
}

fn levenshtein(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cur = row[j + 1];
            row[j + 1] = (prev + usize::from(ca != *cb)).min(row[j] + 1).min(cur + 1);
            prev = cur;
        }
    }
    row[b.len()]
}

fn panic_text(p: Box<dyn std::any::Any + Send>) -> String {
    p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_else(|| "panic".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_params_are_stripped_and_shape_applies() {
        let mut p = json!({"a":1,"_select":"x.y,z","_budget":0,"_raw":true});
        let m = take_meta(&mut p);
        assert_eq!(p, json!({"a":1}));
        assert_eq!(m.select, ["x.y", "z"]);
        assert!(m.raw && m.budget == usize::MAX);
        let v = shape(&json!({"x":{"y":1,"q":2},"z":null,"w":3}), &m);
        assert_eq!(v, json!({"x":{"y":1},"z":null}));
    }

    #[test]
    fn oversized_replies_become_an_outline() {
        let big = json!({"clips": (0..2000).map(|i| json!({"id": i})).collect::<Vec<_>>()});
        let v = shape(&big, &Meta { select: vec![], budget: 100, raw: false, quiet: false });
        assert_eq!(v["truncated"], true);
        assert_eq!(v["outline"]["clips"], "[2000]");
    }

    #[test]
    fn read_only_heuristic() {
        assert!(is_read_only("cut.sequence.inspect"));
        assert!(is_read_only("fx.project.summary"));
        assert!(!is_read_only("cut.timeline.razor"));
    }
}
