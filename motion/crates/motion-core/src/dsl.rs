//! The motion command language: one command per line (or `;`-separated), built for agents to write
//! with as few tokens as possible.
//!
//! ```text
//! fx.comp.new name=Title width=1920 height=1080 duration=4
//! fx.layer.newText text="Hello world" size=140 fill=#ffffff
//! motion.fx2cut comp=Title track=V2 seconds=2
//! cut.timeline.razor seconds=3.5 ; cut.sequence.inspect
//! {"cmd":"cut.file.import","params":{"paths":["/m/a.mp4"]}}
//! ```
//!
//! Values are JSON when they parse as JSON, else bare strings; `[a.mp4,b.mp4]` and `{k:v}` are
//! read leniently. `a.b=1` nests (`{"a":{"b":1}}`). `$1` / `$1.layer` / `$-1.items.0` refer to
//! earlier results in the same script, resolved when the step runs.

use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub cmd: String,
    pub params: Value,
}

/// Parse a script (any number of lines / `;`-separated commands). Blank lines and `#` comments
/// are skipped.
pub fn parse_script(src: &str) -> Result<Vec<Step>, String> {
    let mut out = Vec::new();
    for (n, line) in src.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('{') {
            out.push(parse_json_step(line).map_err(|e| format!("line {}: {e}", n + 1))?);
            continue;
        }
        for part in split_top(line, ';') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            out.push(parse_line(part).map_err(|e| format!("line {}: {e}", n + 1))?);
        }
    }
    Ok(out)
}

fn parse_json_step(line: &str) -> Result<Step, String> {
    let v: Value = serde_json::from_str(line).map_err(|e| format!("bad JSON: {e}"))?;
    let cmd = v.get("cmd").or_else(|| v.get("id")).or_else(|| v.get("command")).and_then(Value::as_str).ok_or("JSON step needs `cmd`")?;
    let params = v.get("params").or_else(|| v.get("p")).cloned().unwrap_or_else(|| Value::Object(Map::new()));
    Ok(Step { cmd: cmd.to_string(), params })
}

fn parse_line(line: &str) -> Result<Step, String> {
    let toks = split_ws(line)?;
    let mut it = toks.into_iter();
    let cmd = it.next().ok_or("empty command")?;
    let mut params = Map::new();
    let mut last_key: Option<String> = None;
    for t in it {
        let Some((k, v)) = split_kv(&t) else {
            // `q=sequence new`: a bare word after a bare-string value continues it
            if let Some(Value::String(prev)) = last_key.as_deref().and_then(|k| params.get_mut(k)).filter(|_| !t.starts_with('{')) {
                prev.push(' ');
                prev.push_str(&t);
                continue;
            }
            // A lone `{...}` after the command is the whole params object.
            if t.starts_with('{') && params.is_empty() {
                match lenient(&t) {
                    Value::Object(m) => {
                        params = m;
                        continue;
                    }
                    _ => return Err(format!("bad params object `{t}`")),
                }
            }
            return Err(format!("expected key=value, got `{t}`"));
        };
        let v = lenient(v);
        // only a top-level bare string may be continued; a quoted one is complete
        last_key = (!k.contains('.') && v.is_string() && !t[k.len() + 1..].starts_with('"')).then(|| k.to_string());
        insert_path(&mut params, k, v);
    }
    Ok(Step { cmd, params: Value::Object(params) })
}

/// `key=value` where key is `[A-Za-z0-9_.-]+` (so `#fff` or `a=b` inside a value never split it).
fn split_kv(t: &str) -> Option<(&str, &str)> {
    let i = t.find('=')?;
    let k = &t[..i];
    (!k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))).then(|| (k, &t[i + 1..]))
}

fn insert_path(m: &mut Map<String, Value>, key: &str, v: Value) {
    match key.split_once('.') {
        None => {
            m.insert(key.to_string(), v);
        }
        Some((head, rest)) => {
            let e = m.entry(head.to_string()).or_insert_with(|| Value::Object(Map::new()));
            if !e.is_object() {
                *e = Value::Object(Map::new());
            }
            if let Value::Object(inner) = e {
                insert_path(inner, rest, v);
            }
        }
    }
}

/// Split on whitespace, keeping quoted strings and bracketed groups whole. Quotes are kept so
/// the value parser can tell `"12"` (a string) from `12`.
fn split_ws(s: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let (mut depth, mut quote, mut esc) = (0i32, false, false);
    for c in s.chars() {
        if quote {
            cur.push(c);
            match (esc, c) {
                (true, _) => esc = false,
                (false, '\\') => esc = true,
                (false, '"') => quote = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => {
                quote = true;
                cur.push(c);
            }
            '[' | '{' => {
                depth += 1;
                cur.push(c);
            }
            ']' | '}' => {
                depth -= 1;
                cur.push(c);
            }
            c if c.is_whitespace() && depth == 0 => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if quote {
        return Err("unterminated string".into());
    }
    if depth != 0 {
        return Err("unbalanced brackets".into());
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    Ok(out)
}

/// Split on `sep` outside quotes and brackets.
fn split_top(s: &str, sep: char) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut depth, mut quote, mut esc, mut start) = (0i32, false, false, 0);
    for (i, c) in s.char_indices() {
        if quote {
            match (esc, c) {
                (true, _) => esc = false,
                (false, '\\') => esc = true,
                (false, '"') => quote = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => quote = true,
            '[' | '{' => depth += 1,
            ']' | '}' => depth -= 1,
            c if c == sep && depth == 0 => {
                out.push(&s[start..i]);
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    out.push(&s[start..]);
    out
}

/// JSON if it parses, else a lenient read: `[a,b]` → array of lenient items, `{k:v}` → object,
/// anything else → string.
pub fn lenient(s: &str) -> Value {
    let s = s.trim();
    if let Ok(v) = serde_json::from_str::<Value>(s) {
        return v;
    }
    if let Some(inner) = s.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
        if inner.trim().is_empty() {
            return Value::Array(vec![]);
        }
        return Value::Array(split_top(inner, ',').into_iter().map(lenient).collect());
    }
    if let Some(inner) = s.strip_prefix('{').and_then(|r| r.strip_suffix('}')) {
        let mut m = Map::new();
        for kv in split_top(inner, ',') {
            if let Some(i) = kv.find(':') {
                let k = kv[..i].trim().trim_matches('"');
                insert_path(&mut m, k, lenient(&kv[i + 1..]));
            }
        }
        return Value::Object(m);
    }
    Value::String(s.to_string())
}

/// Replace every string that is exactly `$N[.path]` (1-based step, or `$-N` counting back from
/// the current step) with the referenced value from `results`.
pub fn resolve_refs(v: &Value, results: &[Value]) -> Result<Value, String> {
    Ok(match v {
        Value::String(s) if s.starts_with('$') && s.len() > 1 => resolve_one(s, results)?,
        Value::Array(a) => Value::Array(a.iter().map(|x| resolve_refs(x, results)).collect::<Result<_, _>>()?),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| Ok((k.clone(), resolve_refs(x, results)?))).collect::<Result<_, String>>()?),
        _ => v.clone(),
    })
}

fn resolve_one(s: &str, results: &[Value]) -> Result<Value, String> {
    let body = &s[1..];
    let (idx, path) = match body.find('.') {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    let Ok(n) = idx.parse::<i64>() else {
        // not a reference (e.g. a literal "$5.99" price stays text only if it doesn't parse)
        return Ok(Value::String(s.to_string()));
    };
    let i = if n > 0 { n - 1 } else { results.len() as i64 + n };
    let base = usize::try_from(i).ok().and_then(|i| results.get(i)).ok_or_else(|| format!("`{s}`: no step {n} yet"))?;
    match path {
        None => Ok(base.clone()),
        Some(p) => get_path(base, p).cloned().ok_or_else(|| format!("`{s}`: no `{p}` in step {n}'s result")),
    }
}

/// Dotted path lookup; numeric segments index arrays.
pub fn get_path<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').filter(|s| !s.is_empty()).try_fold(v, |cur, seg| match cur {
        Value::Object(m) => m.get(seg),
        Value::Array(a) => seg.parse::<usize>().ok().and_then(|i| a.get(i)),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_kv_with_types() {
        let s = parse_script("fx.layer.newText text=\"Hello world\" size=140 fill=#ffffff on=true").unwrap();
        assert_eq!(s[0].cmd, "fx.layer.newText");
        assert_eq!(s[0].params, json!({"text":"Hello world","size":140,"fill":"#ffffff","on":true}));
    }

    #[test]
    fn lenient_arrays_and_nesting() {
        let s = parse_script("cut.file.import paths=[/m/a.mp4,/m/b c.mp4] a.b.c=1").unwrap();
        assert_eq!(s[0].params, json!({"paths":["/m/a.mp4","/m/b c.mp4"],"a":{"b":{"c":1}}}));
    }

    #[test]
    fn semicolons_comments_and_json_lines() {
        let src = "# setup\ncut.a x=1 ; cut.b\n{\"cmd\":\"fx.c\",\"params\":{\"y\":[1,2]}}\n\ncut.d {\"z\":true}";
        let s = parse_script(src).unwrap();
        assert_eq!(s.iter().map(|s| s.cmd.as_str()).collect::<Vec<_>>(), ["cut.a", "cut.b", "fx.c", "cut.d"]);
        assert_eq!(s[2].params, json!({"y":[1,2]}));
        assert_eq!(s[3].params, json!({"z":true}));
    }

    #[test]
    fn bare_words_continue_a_bare_string() {
        let s = parse_script("motion.find q=sequence new limit=3").unwrap();
        assert_eq!(s[0].params, json!({"q":"sequence new","limit":3}));
        assert!(parse_script("x.y q=\"done\" stray").is_err());
        assert!(parse_script("x.y n=3 stray").is_err());
    }

    #[test]
    fn semicolon_inside_quotes_is_text() {
        let s = parse_script("fx.t text=\"a;b\"").unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].params["text"], "a;b");
    }

    #[test]
    fn refs_resolve_forward_and_back() {
        let results = vec![json!({"layer": 7, "items": [3, 4]}), json!(9)];
        let p = json!({"a":"$1.layer","b":"$-1","c":["$1.items.1"],"d":"$price"});
        assert_eq!(resolve_refs(&p, &results).unwrap(), json!({"a":7,"b":9,"c":[4],"d":"$price"}));
        assert!(resolve_refs(&json!("$3"), &results).is_err());
        assert!(resolve_refs(&json!("$1.nope"), &results).is_err());
    }

    #[test]
    fn errors_are_reported() {
        assert!(parse_script("cut.a text=\"open").is_err());
        assert!(parse_script("cut.a x=[1,2").is_err());
        assert!(parse_script("cut.a loose").is_err());
    }
}
