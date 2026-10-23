//! `motion`: Codeply Motion's single binary.
//!
//! ```text
//! motion run [--ws DIR] SCRIPT|@file|-     one shot; --ws loads/saves DIR/cut.fcproj + DIR/fx.ecproj
//! motion sh  [--ws DIR]                    persistent session: a script per stdin line, a JSON reply per line
//! motion mcp [--ws DIR]                    MCP server on stdio (two tools: run, look)
//! motion serve [--port 7070] [--ws DIR]    HTTP API + live agent dashboard on 127.0.0.1
//! motion help                              the command language
//! ```

mod http;
mod mcp;

use std::io::{BufRead, Read, Write};
use std::path::PathBuf;

use motion_core::{HELP, Handle, default_work_dir};
use serde_json::{Value, json};

const USAGE: &str = "usage: motion run [--ws DIR] SCRIPT|@file|- | motion sh [--ws DIR] | motion mcp [--ws DIR] | motion serve [--port N] [--ws DIR] | motion help";

struct Args {
    cmd: String,
    ws: Option<PathBuf>,
    port: u16,
    rest: Vec<String>,
}

fn args() -> Args {
    let mut a = Args { cmd: String::new(), ws: None, port: 7070, rest: vec![] };
    let mut it = std::env::args().skip(1);
    while let Some(x) = it.next() {
        match x.as_str() {
            "--ws" => a.ws = it.next().map(PathBuf::from),
            "--port" => a.port = it.next().and_then(|p| p.parse().ok()).unwrap_or_else(|| die("--port needs a number")),
            "-h" | "--help" => a.cmd = "help".into(),
            _ if a.cmd.is_empty() => a.cmd = x,
            _ => a.rest.push(x),
        }
    }
    a
}

fn die(msg: &str) -> ! {
    eprintln!("motion: {msg}\n{USAGE}");
    std::process::exit(2)
}

fn main() {
    let a = args();
    match a.cmd.as_str() {
        "help" | "" => println!("{USAGE}\n\n{HELP}"),
        "run" => run_once(&a),
        "sh" => shell(&a),
        "mcp" => mcp::serve(open(&a), a.ws.clone()),
        "serve" => http::serve(open(&a), a.port, a.ws.clone()),
        other => die(&format!("unknown subcommand `{other}`")),
    }
}

fn open(a: &Args) -> Handle {
    let h = Handle::spawn(default_work_dir());
    if let Some(ws) = a.ws.as_ref().filter(|d| d.exists()) {
        let r = h.run(&format!("motion.open dir={}", quote(ws)));
        if r["ok"] != true {
            eprintln!("motion: could not open workspace {}: {}", ws.display(), r["err"]);
        }
    }
    h
}

/// Save the workspace back after work that changed it.
pub fn save(h: &Handle, ws: &Option<PathBuf>) -> Value {
    match ws {
        Some(d) => h.run(&format!("motion.save dir={}", quote(d))),
        None => Value::Null,
    }
}

pub fn quote(p: &std::path::Path) -> String {
    serde_json::to_string(&p.to_string_lossy()).unwrap_or_default()
}

fn run_once(a: &Args) {
    let src = match a.rest.first().map(String::as_str) {
        None => die("run needs a script"),
        Some("-") => {
            let mut s = String::new();
            let _ = std::io::stdin().read_to_string(&mut s);
            s
        }
        Some(f) if f.starts_with('@') => std::fs::read_to_string(&f[1..]).unwrap_or_else(|e| die(&format!("{f}: {e}"))),
        Some(_) => a.rest.join(" "),
    };
    let h = open(a);
    let r = h.run(&src);
    let ok = r["ok"] == true;
    if ok && a.ws.is_some() {
        let s = save(&h, &a.ws);
        if s["ok"] != true {
            eprintln!("motion: save failed: {}", s["err"]);
        }
    }
    println!("{}", r);
    std::process::exit(if ok { 0 } else { 1 });
}

fn shell(a: &Args) {
    let h = open(a);
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // `{"script": "..."}` carries a multi-line script on one line
        let src = serde_json::from_str::<Value>(line).ok().and_then(|v| v.get("script").and_then(Value::as_str).map(String::from)).unwrap_or_else(|| line.to_string());
        let r = if src == "motion.quit" || src == "quit" {
            let s = save(&h, &a.ws);
            let _ = writeln!(out, "{}", json!({"ok": true, "r": "bye", "saved": s.get("r")}));
            break;
        } else {
            h.run(&src)
        };
        let _ = writeln!(out, "{r}");
        let _ = out.flush();
    }
    save(&h, &a.ws);
}
