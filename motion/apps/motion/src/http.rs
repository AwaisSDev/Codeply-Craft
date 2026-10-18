//! A small HTTP/1.1 server on 127.0.0.1: the agent API and the dashboard that watches it.
//!
//! * `POST /api/run`   body = script → reply JSON (needs header `X-Motion: 1`, which a cross-site
//!   form cannot send, so a web page can't drive the studio)
//! * `GET  /api/tele`  counters, document summary and the recent command log (never waits on a
//!   running script)
//! * `GET  /api/frame?engine=cut&t=1.5&max=640` PNG of a frame
//! * `GET  /`          the dashboard

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::PoisonError;
use std::sync::atomic::{AtomicU64, Ordering};

use motion_core::{HELP, Handle};
use serde_json::{Value, json};

const DASH: &str = include_str!("dash.html");
const MAX_BODY: usize = 4 << 20;

pub fn serve(h: Handle, port: u16, ws: Option<PathBuf>) {
    let addr = format!("127.0.0.1:{port}");
    let l = TcpListener::bind(&addr).unwrap_or_else(|e| crate::die(&format!("cannot listen on {addr}: {e}")));
    eprintln!("motion: dashboard http://{addr}/  api POST http://{addr}/api/run (header X-Motion: 1)");
    for s in l.incoming().flatten() {
        let (h, ws) = (h.clone(), ws.clone());
        std::thread::spawn(move || {
            let _ = conn(s, &h, &ws, port);
        });
    }
}

struct Req {
    method: String,
    path: String,
    query: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Req {
    fn header(&self, k: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str())
    }
    fn q(&self, k: &str) -> Option<String> {
        self.query.split('&').filter_map(|kv| kv.split_once('=')).find(|(n, _)| *n == k).map(|(_, v)| v.replace("%20", " "))
    }
}

fn read_req(r: &mut BufReader<&TcpStream>) -> Option<Req> {
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let (path, query) = target.split_once('?').map_or((target.clone(), String::new()), |(p, q)| (p.to_string(), q.to_string()));
    let mut headers = vec![];
    loop {
        let mut l = String::new();
        if r.read_line(&mut l).ok()? == 0 {
            break;
        }
        let l = l.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let len = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse::<usize>().ok()).unwrap_or(0);
    if len > MAX_BODY {
        return None;
    }
    let mut body = vec![0; len];
    r.read_exact(&mut body).ok()?;
    Some(Req { method, path, query, headers, body })
}

fn conn(s: TcpStream, h: &Handle, ws: &Option<PathBuf>, port: u16) -> std::io::Result<()> {
    let mut r = BufReader::new(&s);
    loop {
        let Some(req) = read_req(&mut r) else { return Ok(()) };
        // DNS-rebinding guard: only answer requests addressed to the loopback name we serve on
        let host_ok = req.header("host").is_some_and(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"));
        let (status, ctype, body) = if !host_ok {
            (403, "text/plain", b"bad host".to_vec())
        } else {
            route(&req, h, ws)
        };
        let mut w = &s;
        write!(w, "HTTP/1.1 {status} {}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n\r\n", reason(status), body.len())?;
        w.write_all(&body)?;
        w.flush()?;
        if req.header("connection").is_some_and(|c| c.eq_ignore_ascii_case("close")) {
            return Ok(());
        }
    }
}

fn reason(s: u16) -> &'static str {
    match s {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    }
}

fn route(req: &Req, h: &Handle, ws: &Option<PathBuf>) -> (u16, &'static str, Vec<u8>) {
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/") => (200, "text/html; charset=utf-8", DASH.as_bytes().to_vec()),
        ("GET", "/api/help") => (200, "text/plain; charset=utf-8", HELP.as_bytes().to_vec()),
        ("GET", "/api/tele") => (200, "application/json", tele(h).to_string().into_bytes()),
        ("POST", "/api/run") => {
            if req.header("x-motion") != Some("1") {
                return (403, "text/plain", b"send header X-Motion: 1".to_vec());
            }
            let src = String::from_utf8_lossy(&req.body);
            let mut r = h.run(&src);
            if req.q("save").as_deref() == Some("1") {
                r["saved"] = crate::save(h, ws);
            }
            (200, "application/json", r.to_string().into_bytes())
        }
        ("GET", "/api/frame") => {
            static N: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!("motion-dash-{}-{}.png", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
            let mut cmd = format!("motion.frame _quiet=true out={} max={}", crate::quote(&path), req.q("max").and_then(|m| m.parse::<u32>().ok()).unwrap_or(640));
            if let Some(e) = req.q("engine").filter(|e| e == "cut" || e == "fx") {
                cmd.push_str(&format!(" engine={e}"));
            }
            if let Some(t) = req.q("t").and_then(|t| t.parse::<f64>().ok()) {
                cmd.push_str(&format!(" t={t}"));
            }
            let r = h.run(&cmd);
            match (r["ok"] == true).then(|| std::fs::read(&path).ok()).flatten() {
                Some(png) => {
                    let _ = std::fs::remove_file(&path);
                    (200, "image/png", png)
                }
                None => (404, "application/json", r.to_string().into_bytes()),
            }
        }
        _ => (404, "text/plain", b"not found".to_vec()),
    }
}

fn tele(h: &Handle) -> Value {
    let t = h.tele.lock().unwrap_or_else(PoisonError::into_inner);
    let log: Vec<Value> = t.log.iter().rev().take(150).map(|e| json!({"at": e.at_ms as u64, "cmd": e.cmd, "ok": e.ok, "ms": e.ms, "tok": e.tokens, "err": e.err})).collect();
    json!({
        "steps": t.steps,
        "errors": t.errors,
        "tokens": t.tokens_out,
        "busyMs": (t.busy_ms * 10.0).round() / 10.0,
        "rev": t.rev,
        "engines": t.per_engine,
        "summary": t.summary,
        "log": log,
    })
}
