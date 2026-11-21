//! Run, Live Server and Ports in the code view: what Run does for the open file (`plans`), the
//! ports dev servers print (`detect_ports`), and the handlers behind the Run button, Ctrl F5,
//! "Open with Live Server" and the Ports panel. Live Server and port sharing run in the engine
//! (`sidecar/ext-live.mjs`).

use serde_json::Value;

use crate::app::{App, EditKey};
use crate::model::{BgTask, Forward, LiveOp, Ports, TermKind, TermLine};

/// What a Run choice does.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Action {
    /// A command in the project folder, in the terminal.
    Cmd(String),
    /// Serve the project with Live Server and open this page in the browser.
    Live(String),
}

/// One way to run what's open: Run takes the first, its menu lists them all.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub title: String,
    pub action: Action,
}

impl Plan {
    /// The command, or what Live Server does, for the menu's second line.
    pub fn note(&self) -> String {
        match &self.action {
            Action::Cmd(c) => c.clone(),
            Action::Live(f) => format!("Serves the project, opens {f}, reloads on save"),
        }
    }
}

/// A path as a shell argument: quoted when it has spaces or other odd characters.
fn arg(p: &str) -> String {
    if p.chars().all(|c| c.is_ascii_alphanumeric() || "_./-@+".contains(c)) { p.to_owned() } else { format!("\"{p}\"") }
}

fn dir_of(p: &str) -> &str {
    p.rsplit_once('/').map_or("", |(d, _)| d)
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() { name.to_owned() } else { format!("{dir}/{name}") }
}

/// The ways to run `file` (a project path with `/`), or the project when it isn't runnable on
/// its own; best first. `files` is the project's file list and `read` a project file's text
/// (package.json for its scripts). `windows`: the commands run in PowerShell there.
pub fn plans(file: Option<&str>, files: &[String], read: &dyn Fn(&str) -> Option<String>, windows: bool) -> Vec<Plan> {
    let has = |p: &str| files.iter().any(|f| f == p);
    // The nearest folder at or above `dir` holding `name`.
    let nearest = |dir: &str, name: &str| -> Option<String> {
        let mut d = dir.to_owned();
        loop {
            if has(&join(&d, name)) {
                return Some(d);
            }
            if d.is_empty() {
                return None;
            }
            d = dir_of(&d).to_owned();
        }
    };
    let py = if windows { "python" } else { "python3" };
    let cmd = |title: String, c: String| Plan { title, action: Action::Cmd(c) };
    // A package's dev and start scripts, in its package manager's words.
    let scripts = |dir: &str| -> Vec<Plan> {
        let Some(json) = read(&join(dir, "package.json")).and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return Vec::new() };
        let lock = |n: &str| has(&join(dir, n));
        let pm = if lock("pnpm-lock.yaml") { "pnpm" } else if lock("yarn.lock") { "yarn" } else if lock("bun.lockb") || lock("bun.lock") { "bun" } else { "npm" };
        ["dev", "start"].iter().filter(|s| json["scripts"][**s].is_string()).map(|s| {
            let c = match (pm, dir.is_empty()) {
                ("npm", true) if *s == "start" => "npm start".to_owned(),
                ("npm", true) => format!("npm run {s}"),
                ("npm", false) if *s == "start" => format!("npm --prefix {} start", arg(dir)),
                ("npm", false) => format!("npm --prefix {} run {s}", arg(dir)),
                ("pnpm", true) | ("yarn", true) => format!("{pm} {s}"),
                ("pnpm", false) => format!("pnpm -C {} {s}", arg(dir)),
                ("yarn", false) => format!("yarn --cwd {} {s}", arg(dir)),
                (_, true) => format!("bun run {s}"),
                (_, false) => format!("bun --cwd {} run {s}", arg(dir)),
            };
            let at = if dir.is_empty() { String::new() } else { format!(" in {dir}") };
            cmd(format!("Run the {s} script{at}"), c)
        }).collect()
    };
    // A compiled language's one file: build it, then run what it made.
    let build_run = |compiler: &str, f: &str| {
        let name = f.rsplit('/').next().unwrap_or(f).rsplit_once('.').map_or(f, |(n, _)| n);
        let out = join(dir_of(f), name);
        if windows {
            format!("{compiler} {} -o {}; if ($?) {{ ./{} }}", arg(f), arg(&format!("{out}.exe")), arg(&format!("{out}.exe")))
        } else {
            format!("{compiler} {} -o {} && ./{}", arg(f), arg(&out), arg(&out))
        }
    };

    let mut out: Vec<Plan> = Vec::new();
    if let Some(f) = file {
        let name = f.rsplit('/').next().unwrap_or(f);
        let ext = name.rsplit_once('.').map_or(String::new(), |(_, e)| e.to_ascii_lowercase());
        let dir = dir_of(f);
        let pkg = nearest(dir, "package.json").map(|d| scripts(&d)).unwrap_or_default();
        // Files a dev server serves: under src/, app/, pages/ and the like, or a web file.
        let web_dir = f.split('/').any(|p| matches!(p, "src" | "app" | "pages" | "components" | "public" | "routes" | "views"));
        let run_file = format!("Run {name}");
        match ext.as_str() {
            "html" | "htm" => {
                let live = Plan { title: "Open with Live Server".into(), action: Action::Live(f.to_owned()) };
                // A Vite-style project serves its own index.html.
                if pkg.iter().any(|p| p.title.starts_with("Run the dev script")) {
                    out.extend(pkg);
                    out.push(live);
                } else {
                    out.push(live);
                    out.extend(pkg);
                }
            }
            "js" | "mjs" | "cjs" | "ts" | "mts" | "cts" => {
                let own = cmd(run_file, if matches!(ext.as_str(), "ts" | "mts" | "cts") { format!("npx tsx {}", arg(f)) } else { format!("node {}", arg(f)) });
                if web_dir && !pkg.is_empty() {
                    out.extend(pkg);
                    out.push(own);
                } else {
                    out.push(own);
                    out.extend(pkg);
                }
            }
            "jsx" | "tsx" | "vue" | "svelte" | "astro" | "css" | "scss" | "less" | "json" => out.extend(pkg),
            "py" | "pyw" => out.push(cmd(run_file, format!("{py} {}", arg(f)))),
            "rs" => match nearest(dir, "Cargo.toml") {
                Some(krate) => {
                    let inner = if krate.is_empty() { f.to_owned() } else { f[krate.len() + 1..].to_owned() };
                    let mut c = String::from("cargo run");
                    if !krate.is_empty() {
                        c.push_str(&format!(" --manifest-path {}", arg(&join(&krate, "Cargo.toml"))));
                    }
                    let parts: Vec<&str> = inner.split('/').collect();
                    match parts.as_slice() {
                        ["src", "bin", bin] => c.push_str(&format!(" --bin {}", bin.trim_end_matches(".rs"))),
                        ["src", "bin", bin, "main.rs"] => c.push_str(&format!(" --bin {bin}")),
                        ["examples", ex] => c.push_str(&format!(" --example {}", ex.trim_end_matches(".rs"))),
                        _ => {}
                    }
                    out.push(cmd("Run with Cargo".into(), c));
                }
                None => out.push(cmd(run_file, build_run("rustc", f))),
            },
            "go" => out.push(cmd(run_file, format!("go run {}", arg(f)))),
            "sh" | "bash" => out.push(cmd(run_file, format!("bash {}", arg(f)))),
            "ps1" => out.push(cmd(run_file, format!("{} -ExecutionPolicy Bypass -File {}", if windows { "powershell" } else { "pwsh" }, arg(f)))),
            "rb" => out.push(cmd(run_file, format!("ruby {}", arg(f)))),
            "php" => out.push(cmd(run_file, format!("php {}", arg(f)))),
            "pl" => out.push(cmd(run_file, format!("perl {}", arg(f)))),
            "lua" => out.push(cmd(run_file, format!("lua {}", arg(f)))),
            "java" => out.push(cmd(run_file, format!("java {}", arg(f)))),
            "dart" => out.push(cmd(run_file, format!("dart run {}", arg(f)))),
            "swift" => out.push(cmd(run_file, format!("swift {}", arg(f)))),
            "r" => out.push(cmd(run_file, format!("Rscript {}", arg(f)))),
            "c" => out.push(cmd(run_file, build_run("gcc", f))),
            "cpp" | "cc" | "cxx" => out.push(cmd(run_file, build_run("g++", f))),
            _ => {}
        }
    }
    // The project as a whole, after what's specific to the file.
    out.extend(scripts(""));
    if has("Cargo.toml") {
        out.push(cmd("Run with Cargo".into(), "cargo run".into()));
    }
    if has("manage.py") {
        out.push(cmd("Start the Django server".into(), format!("{py} manage.py runserver")));
    }
    for main in ["main.py", "app.py"] {
        if has(main) {
            out.push(cmd(format!("Run {main}"), format!("{py} {main}")));
        }
    }
    if has("go.mod") {
        out.push(cmd("Run the Go module".into(), "go run .".into()));
    }
    if has("index.html") {
        out.push(Plan { title: "Open with Live Server".into(), action: Action::Live("index.html".into()) });
    }
    if has("Makefile") {
        out.push(cmd("Run make".into(), "make".into()));
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(p.action.clone()));
    out
}

// ---------- ports ----------

/// A port worth listing: one dev servers use, not HTTPS's or the low system ones.
fn plausible(n: u32) -> Option<u16> {
    ((80..=65535).contains(&n) && n != 443).then_some(n as u16)
}

fn digits(s: &str) -> Option<u16> {
    let d: String = s.chars().take_while(char::is_ascii_digit).collect();
    if d.is_empty() || d.len() > 5 { None } else { plausible(d.parse().ok()?) }
}

/// The ports a line of output says something listens on: `localhost:5173`, `0.0.0.0:8000`,
/// `http://192.168.1.4:3000`, "listening on port 3000". Not "port 3000 is in use".
pub fn ports_in(line: &str) -> Vec<u16> {
    let l = line.to_ascii_lowercase();
    if l.contains("in use") || l.contains("eaddrinuse") || l.contains("refused") {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut add = |p: Option<u16>| {
        if let Some(p) = p && !out.contains(&p) {
            out.push(p);
        }
    };
    for host in ["localhost:", "127.0.0.1:", "0.0.0.0:", "[::]:", "[::1]:"] {
        for (i, _) in l.match_indices(host) {
            add(digits(&l[i + host.len()..]));
        }
    }
    // Addresses on the local network, as Vite's "Network:" line prints them.
    for (i, _) in l.match_indices("://") {
        let rest = &l[i + 3..];
        let host: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        let private = host.starts_with("192.168.") || host.starts_with("10.") || host.starts_with("172.");
        if private && rest[host.len()..].starts_with(':') {
            add(digits(&rest[host.len() + 1..]));
        }
    }
    if ["listen", "running", "serving", "started", "ready", "available"].iter().any(|w| l.contains(w)) {
        for (i, _) in l.match_indices("port") {
            add(digits(l[i + 4..].trim_start_matches([' ', ':', '='])));
        }
    }
    out
}

/// The ports dev servers said they listen on, in the terminal's output and running commands'
/// latest lines, each with the command that printed it.
pub fn detect_ports(lines: &[TermLine], tasks: &[BgTask]) -> Vec<(u16, String)> {
    let mut out: Vec<(u16, String)> = Vec::new();
    let mut by = String::new();
    for l in lines {
        match l.kind {
            TermKind::Input | TermKind::Agent => by = l.text.clone(),
            TermKind::Out | TermKind::Err => {
                for p in ports_in(&l.text) {
                    if !out.iter().any(|(q, _)| *q == p) {
                        out.push((p, by.clone()));
                    }
                }
            }
            TermKind::Exit => {}
        }
    }
    for t in tasks.iter().filter(|t| t.running) {
        for p in ports_in(&t.detail) {
            if !out.iter().any(|(q, _)| *q == p) {
                out.push((p, t.title.clone()));
            }
        }
    }
    out
}

fn forward_from(v: &Value) -> Option<Forward> {
    Some(Forward {
        port: u16::try_from(v["port"].as_u64()?).ok()?,
        state: v["state"].as_str().unwrap_or("starting").to_owned(),
        url: v["url"].as_str().unwrap_or_default().to_owned(),
        message: v["message"].as_str().unwrap_or_default().to_owned(),
    })
}

/// Folds what the engine says about Live Server and shared ports (an answer or an event):
/// `live` (its port or null), `forwards` (all of them), `forward` (one changed), `tools`, `error`.
pub fn fold_live(p: &mut Ports, v: &Value) {
    if let Some(l) = v.get("live") {
        p.live = l["port"].as_u64().and_then(|n| u16::try_from(n).ok());
    }
    if let Some(all) = v["forwards"].as_array() {
        p.forwards = all.iter().filter_map(forward_from).collect();
    }
    if let Some(f) = v.get("forward").and_then(forward_from) {
        p.forwards.retain(|x| x.port != f.port);
        if f.state != "closed" {
            p.forwards.push(f);
            p.forwards.sort_by_key(|x| x.port);
        }
    }
    if v["tools"].is_object() {
        p.tools = Some((v["tools"]["cloudflared"].as_bool().unwrap_or(false), v["tools"]["ssh"].as_bool().unwrap_or(false)));
    }
    if let Some(e) = v["error"].as_str() {
        p.error = e.to_owned();
    }
}

/// A Live Server page's address.
pub fn live_url(port: u16, file: &str) -> String {
    let path: String = file.split('/').map(|seg| {
        seg.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>()
    }).collect::<Vec<_>>().join("/");
    format!("http://127.0.0.1:{port}/{path}")
}

/// A port as typed: `3000`, `:3000`, `localhost:3000`, `http://localhost:3000/`.
pub fn parse_port(s: &str) -> Option<u16> {
    let s = s.trim().trim_end_matches('/');
    let tail = s.rsplit(':').next().unwrap_or(s);
    let n: u32 = tail.parse().ok()?;
    (1..=65535).contains(&n).then_some(n as u16)
}

/// A row of the Ports panel.
#[derive(Clone, Debug, PartialEq)]
pub struct PortRow {
    pub port: u16,
    /// What's on it: the command that printed it, "Live Server", or "Added by you".
    pub what: String,
    pub manual: bool,
}

impl App {
    /// The ways to run what's open in the code view, best first.
    pub fn run_plans(&self) -> Vec<Plan> {
        let code = &self.data.extra.code;
        let open = code.open.as_deref();
        let editor = &self.edit(EditKey::Code).text;
        // The open package.json as you've typed it, the others as last read.
        let read = |p: &str| if open == Some(p) { Some(editor.clone()) } else { code.manifests.iter().find(|(k, _)| k == p).map(|(_, t)| t.clone()) };
        plans(open, &code.files, &read, cfg!(windows))
    }

    /// Run (Ctrl F5): the first plan, or the one picked in Run's menu. The file is saved first.
    pub fn run_plan(&mut self, i: usize) {
        self.menu = None;
        let Some(plan) = self.run_plans().into_iter().nth(i) else {
            self.notice = Some("Nothing to run here. Open a script, or add a dev or start script to package.json.".into());
            return;
        };
        if self.code_dirty() {
            self.save_file();
        }
        match plan.action {
            Action::Live(file) => self.open_live(&file),
            Action::Cmd(cmd) => {
                self.ports_tab = false;
                self.run_cmd = Some(cmd.clone());
                self.run_in_terminal(&cmd);
            }
        }
    }

    /// The task of the last Run, while it's still running.
    pub fn running_run(&self) -> Option<String> {
        let cmd: String = self.run_cmd.as_ref()?.chars().take(80).collect();
        self.data.extra.bg_tasks.iter().find(|t| t.running && t.kind == "command" && t.title == cmd).map(|t| t.id.clone())
    }

    /// Stops what Run started.
    pub fn stop_run(&mut self) {
        if let Some(id) = self.running_run() {
            self.kill_task(&id);
        }
    }

    /// Serves the project with Live Server and opens `file` in the browser once it's up.
    pub fn open_live(&mut self, file: &str) {
        self.menu = None;
        self.live_open = Some(file.to_owned());
        self.data.extra.ports.error.clear();
        self.with_store(|st, d| st.live_op(LiveOp::Start(file.to_owned()), d));
    }

    pub fn stop_live(&mut self) {
        self.live_open = None;
        self.with_store(|st, d| st.live_op(LiveOp::Stop, d));
    }

    /// Opens or closes the Ports tab of the terminal pane (asking which tunnel tools there are).
    pub fn show_ports(&mut self, on: bool) {
        self.ports_tab = on;
        if on {
            self.panes.terminal = true;
            self.with_store(|st, d| st.live_op(LiveOp::Status, d));
        }
    }

    /// The Ports panel's rows: Live Server, what dev servers printed, and the ports you added.
    pub fn port_rows(&self) -> Vec<PortRow> {
        let mut rows: Vec<PortRow> = Vec::new();
        let mut add = |port: u16, what: String, manual: bool| {
            if !rows.iter().any(|r| r.port == port) && (manual || !self.ports_hidden.contains(&port)) {
                rows.push(PortRow { port, what, manual });
            }
        };
        if let Some(p) = self.data.extra.ports.live {
            add(p, "Live Server".into(), false);
        }
        for (p, by) in detect_ports(&self.data.extra.terminal, &self.data.extra.bg_tasks) {
            add(p, by, false);
        }
        for p in &self.ports_added {
            add(*p, "Added by you".into(), true);
        }
        for f in &self.data.extra.ports.forwards {
            add(f.port, "Added by you".into(), true);
        }
        rows
    }

    /// Adds the port typed in the Ports panel.
    pub fn add_port(&mut self) {
        let typed = self.edit(EditKey::PortAdd).text.clone();
        match parse_port(&typed) {
            Some(p) => {
                self.ports_hidden.retain(|q| *q != p);
                if !self.ports_added.contains(&p) {
                    self.ports_added.push(p);
                }
                self.edit_mut(EditKey::PortAdd).clear();
                self.data.extra.ports.error.clear();
            }
            None => self.data.extra.ports.error = format!("\"{}\" isn't a port. Type a number like 3000.", typed.trim()),
        }
    }

    /// Takes a port off the list (and stops sharing it).
    pub fn remove_port(&mut self, port: u16) {
        self.ports_added.retain(|p| *p != port);
        if !self.ports_hidden.contains(&port) {
            self.ports_hidden.push(port);
        }
        if self.data.extra.ports.forwards.iter().any(|f| f.port == port) {
            self.unshare_port(port);
        }
    }

    /// Shares a port outside this computer through a tunnel (cloudflared, else localhost.run).
    pub fn share_port(&mut self, port: u16) {
        self.data.extra.ports.error.clear();
        self.with_store(|st, d| st.live_op(LiveOp::Forward(port), d));
    }

    pub fn unshare_port(&mut self, port: u16) {
        self.with_store(|st, d| st.live_op(LiveOp::Unforward(port), d));
    }

    /// On each poll: opens the Live Server page once it's up, and reads the project's
    /// package.json files for Run when the file list changes. True when the view must rebuild.
    pub(crate) fn step_dev(&mut self) -> bool {
        let mut changed = false;
        if let Some(file) = self.live_open.clone() {
            if let Some(port) = self.data.extra.ports.live {
                self.live_open = None;
                self.browse(&live_url(port, &file));
                changed = true;
            } else if !self.data.extra.ports.error.is_empty() {
                self.live_open = None;
                self.notice = Some(self.data.extra.ports.error.clone());
                changed = true;
            }
        }
        if self.view == crate::app::View::Code {
            let wanted: Vec<String> = self.data.extra.code.files.iter()
                .filter(|f| (*f == "package.json" || f.ends_with("/package.json")) && f.matches('/').count() <= 2 && !f.contains("node_modules"))
                .take(12).cloned().collect();
            let key = wanted.join("\n");
            if key != self.manifests_key {
                self.manifests_key = key;
                if !wanted.is_empty() {
                    self.with_store(|st, d| st.read_manifests(wanted, d));
                }
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn files(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    fn cmds(file: Option<&str>, list: &[&str], pkgs: &[(&str, &str)], windows: bool) -> Vec<String> {
        let read = |p: &str| pkgs.iter().find(|(k, _)| *k == p).map(|(_, v)| (*v).to_owned());
        plans(file, &files(list), &read, windows).into_iter().map(|p| match p.action {
            Action::Cmd(c) => c,
            Action::Live(f) => format!("live:{f}"),
        }).collect()
    }

    const VITE: &str = r#"{ "scripts": { "dev": "vite", "build": "vite build" } }"#;

    #[test]
    fn a_web_project_runs_its_dev_script_first() {
        let list = ["package.json", "index.html", "src/main.js", "src/pricing/pricing.js"];
        let c = cmds(Some("src/pricing/pricing.js"), &list, &[("package.json", VITE)], false);
        assert_eq!(c, ["npm run dev", "node src/pricing/pricing.js", "live:index.html"]);
        // Vite serves its own index.html, so the dev script comes before Live Server.
        assert_eq!(cmds(Some("index.html"), &list, &[("package.json", VITE)], false)[..2], ["npm run dev", "live:index.html"]);
        // A component has nothing to run on its own.
        assert_eq!(cmds(Some("src/App.tsx"), &list, &[("package.json", VITE)], false), ["npm run dev", "live:index.html"]);
    }

    #[test]
    fn a_node_script_runs_with_node_first() {
        let pkg = r#"{ "scripts": { "start": "node server.js" } }"#;
        assert_eq!(cmds(Some("server.js"), &["package.json", "server.js"], &[("package.json", pkg)], false), ["node server.js", "npm start"]);
        assert_eq!(cmds(Some("tools/seed.ts"), &["tools/seed.ts"], &[], false), ["npx tsx tools/seed.ts"]);
    }

    #[test]
    fn the_lockfile_picks_the_package_manager() {
        assert_eq!(cmds(Some("src/a.js"), &["package.json", "pnpm-lock.yaml", "src/a.js"], &[("package.json", VITE)], false)[0], "pnpm dev");
        let list = ["web/package.json", "web/yarn.lock", "web/src/a.jsx"];
        assert_eq!(cmds(Some("web/src/a.jsx"), &list, &[("web/package.json", VITE)], false), ["yarn --cwd web dev"]);
        let list = ["site/package.json", "site/src/a.css"];
        assert_eq!(cmds(Some("site/src/a.css"), &list, &[("site/package.json", VITE)], false), ["npm --prefix site run dev"]);
    }

    #[test]
    fn python_rust_and_others() {
        assert_eq!(cmds(Some("scripts/hello world.py"), &[], &[], false), ["python3 \"scripts/hello world.py\""]);
        assert_eq!(cmds(Some("app.py"), &["app.py"], &[], true), ["python app.py"]);
        assert_eq!(cmds(Some("src/main.rs"), &["Cargo.toml", "src/main.rs"], &[], false), ["cargo run"]);
        assert_eq!(cmds(Some("src/bin/tool.rs"), &["Cargo.toml"], &[], false), ["cargo run --bin tool", "cargo run"]);
        assert_eq!(cmds(Some("rune-app/src/views/code.rs"), &["rune-app/Cargo.toml"], &[], false), ["cargo run --manifest-path rune-app/Cargo.toml"]);
        assert_eq!(cmds(Some("examples/demo.rs"), &["Cargo.toml"], &[], false)[0], "cargo run --example demo");
        assert_eq!(cmds(Some("hello.rs"), &[], &[], false), ["rustc hello.rs -o hello && ./hello"]);
        assert_eq!(cmds(Some("hello.c"), &[], &[], true), ["gcc hello.c -o hello.exe; if ($?) { ./hello.exe }"]);
        assert_eq!(cmds(Some("main.go"), &["go.mod"], &[], false), ["go run main.go", "go run ."]);
    }

    #[test]
    fn a_page_opens_with_live_server_and_other_files_run_the_project() {
        assert_eq!(cmds(Some("about/index.html"), &["about/index.html"], &[], false), ["live:about/index.html"]);
        assert_eq!(cmds(Some("README.md"), &["README.md", "Cargo.toml"], &[], false), ["cargo run"]);
        assert_eq!(cmds(Some("README.md"), &["README.md", "manage.py"], &[], false), ["python3 manage.py runserver"]);
        assert!(cmds(Some("notes.txt"), &["notes.txt"], &[], false).is_empty());
        assert!(cmds(None, &[], &[], false).is_empty());
    }

    #[test]
    fn ports_from_dev_server_output() {
        assert_eq!(ports_in("  ➜  Local:   http://localhost:5173/"), [5173]);
        assert_eq!(ports_in("  ➜  Network: http://192.168.1.20:5173/"), [5173]);
        assert_eq!(ports_in("Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ..."), [8000]);
        assert_eq!(ports_in("Server listening on port 3000"), [3000]);
        assert_eq!(ports_in("   Finished `dev` profile; Listening on http://[::1]:8080"), [8080]);
        assert!(ports_in("Port 3000 is in use, trying another one...").is_empty());
        assert!(ports_in("GET https://registry.npmjs.org/vite 200").is_empty());
        assert!(ports_in("Exported port 3000 in the docs").is_empty());

        let lines = vec![
            TermLine { kind: TermKind::Input, text: "npm run dev".into() },
            TermLine { kind: TermKind::Out, text: "  Local:   http://localhost:5173/".into() },
            TermLine { kind: TermKind::Out, text: "  Network: http://192.168.1.20:5173/".into() },
            TermLine { kind: TermKind::Agent, text: "python -m http.server 8000".into() },
            TermLine { kind: TermKind::Err, text: "Serving HTTP on :: port 8000 (http://[::]:8000/) ...".into() },
        ];
        let tasks = [BgTask { id: "t".into(), kind: "command", title: "node api.js".into(), agent: None, detail: "listening on localhost:4000".into(), running: true }];
        assert_eq!(detect_ports(&lines, &tasks), [(5173, "npm run dev".into()), (8000, "python -m http.server 8000".into()), (4000, "node api.js".into())]);
    }

    #[test]
    fn live_server_and_tunnels_fold_in() {
        let mut p = Ports::default();
        fold_live(&mut p, &json!({ "live": { "port": 5500 }, "forwards": [], "tools": { "cloudflared": false, "ssh": true } }));
        assert_eq!((p.live, p.tools), (Some(5500), Some((false, true))));
        fold_live(&mut p, &json!({ "forward": { "port": 5173, "state": "open", "url": "https://a-b.lhr.life" } }));
        assert_eq!(p.forwards[0].url, "https://a-b.lhr.life");
        fold_live(&mut p, &json!({ "forward": { "port": 5173, "state": "closed" } }));
        assert!(p.forwards.is_empty());
        fold_live(&mut p, &json!({ "live": null }));
        assert_eq!(p.live, None);
        assert_eq!(live_url(5500, "my site/index.html"), "http://127.0.0.1:5500/my%20site/index.html");
        assert_eq!((parse_port("http://localhost:3000/"), parse_port(":8080"), parse_port("abc")), (Some(3000), Some(8080), None));
    }
}
