//! MCP over stdio (newline-delimited JSON-RPC 2.0). Two tools instead of dozens: every tool's
//! schema sits in the agent's context on every turn, so the catalogue lives behind `motion.find`.

use std::io::{BufRead, Write};
use std::path::PathBuf;

use motion_core::{HELP, Handle};
use serde_json::{Value, json};

const RUN_DESC: &str = "Run Codeply Motion commands (video editing + motion graphics, headless). One command per line or `;`-chained: `cmd key=value ...`. \
cut.* = FilmCraft editor (import, sequences, timeline, effects, export), fx.* = EffectCraft (comps, layers, keyframes, 300+ effects, render queue), motion.* = cross-engine. \
Discover with `motion.find q=<words>` and `motion.describe cmd=<id>`. Verify with `motion.probe` (text frame stats) or `motion.diff` (what changed) instead of screenshots. \
Refs: `$1.layer` = step 1's result field. Meta: `_select=a.b,c.*.id` trims replies, `_budget=N` caps reply tokens.";

pub fn serve(h: Handle, ws: Option<PathBuf>) {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(req) => handle(&h, &ws, &req),
            Err(e) => Some(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": format!("parse error: {e}")}})),
        };
        if let Some(r) = reply {
            let _ = writeln!(out, "{r}");
            let _ = out.flush();
        }
    }
    crate::save(&h, &ws);
}

fn handle(h: &Handle, ws: &Option<PathBuf>, req: &Value) -> Option<Value> {
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let p = req.get("params").cloned().unwrap_or(json!({}));
    let result: Result<Value, (i64, String)> = match method {
        "initialize" => Ok(json!({
            "protocolVersion": p.get("protocolVersion").cloned().unwrap_or(json!("2025-06-18")),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "codeply-motion", "version": env!("CARGO_PKG_VERSION")},
            "instructions": HELP,
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tools()})),
        "tools/call" => Ok(call(h, ws, &p)),
        m if m.starts_with("notifications/") => return None,
        m => Err((-32601, format!("method not found: {m}"))),
    };
    id.as_ref()?;
    Some(match result {
        Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
        Err((code, msg)) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": msg}}),
    })
}

fn tools() -> Value {
    json!([
        {
            "name": "run",
            "title": "Run Motion commands",
            "description": RUN_DESC,
            "inputSchema": {"type": "object", "properties": {
                "script": {"type": "string", "description": "Commands, one per line or `;`-separated."},
                "save": {"type": "boolean", "description": "Save the workspace afterwards (when started with --ws)."}
            }, "required": ["script"], "additionalProperties": false},
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false}
        },
        {
            "name": "look",
            "title": "Look at a frame",
            "description": "PNG of a frame, for when text stats (motion.probe) are not enough. Costs ~1-2k tokens; prefer motion.probe.",
            "inputSchema": {"type": "object", "properties": {
                "engine": {"type": "string", "enum": ["cut", "fx"]},
                "t": {"type": "number", "description": "seconds"},
                "comp": {"description": "fx comp name or id"},
                "max": {"type": "integer", "description": "longest side, default 512"}
            }, "additionalProperties": false},
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
        }
    ])
}

fn call(h: &Handle, ws: &Option<PathBuf>, p: &Value) -> Value {
    let args = p.get("arguments").cloned().unwrap_or(json!({}));
    match p.get("name").and_then(Value::as_str) {
        Some("run") => {
            let Some(script) = args.get("script").and_then(Value::as_str) else { return err("need `script`") };
            let r = h.run(script);
            if args.get("save").and_then(Value::as_bool) == Some(true) {
                crate::save(h, ws);
            }
            let is_err = r["ok"] != true;
            json!({"content": [{"type": "text", "text": r.to_string()}], "isError": is_err})
        }
        Some("look") => {
            let path = std::env::temp_dir().join(format!("motion-look-{}.png", std::process::id()));
            let mut cmd = format!("motion.frame out={} max={}", crate::quote(&path), args.get("max").and_then(Value::as_u64).unwrap_or(512));
            for k in ["engine", "t", "comp"] {
                if let Some(v) = args.get(k) {
                    cmd.push_str(&format!(" {k}={v}"));
                }
            }
            let r = h.run(&cmd);
            if r["ok"] != true {
                return err(&r["err"].to_string());
            }
            let png = std::fs::read(&path).unwrap_or_default();
            let _ = std::fs::remove_file(&path);
            json!({"content": [
                {"type": "image", "data": b64(&png), "mimeType": "image/png"},
                {"type": "text", "text": r["r"].to_string()}
            ]})
        }
        other => err(&format!("unknown tool {other:?}")),
    }
}

fn err(m: &str) -> Value {
    json!({"content": [{"type": "text", "text": m}], "isError": true})
}

pub fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648() {
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foobar"), "Zm9vYmFy");
    }
}
