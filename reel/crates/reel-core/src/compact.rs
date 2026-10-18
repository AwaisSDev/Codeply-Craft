//! Shrinking engine replies before they reach an agent's context: drop empty values, round
//! floats, keep only requested fields, and report state as diffs instead of full dumps.

use serde_json::{Map, Number, Value};

/// Drop nulls, empty strings/arrays/objects; round floats to `digits` decimals.
pub fn prune(v: &Value, digits: u32) -> Value {
    match v {
        Value::Object(m) => {
            let mut out = Map::new();
            for (k, x) in m {
                let x = prune(x, digits);
                if !is_empty(&x) {
                    out.insert(k.clone(), x);
                }
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(|x| prune(x, digits)).collect()),
        Value::Number(n) if n.is_f64() => round(n.as_f64().unwrap_or_default(), digits),
        _ => v.clone(),
    }
}

fn is_empty(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(m) => m.is_empty(),
        _ => false,
    }
}

fn round(f: f64, digits: u32) -> Value {
    let p = 10f64.powi(digits as i32);
    let r = (f * p).round() / p;
    if r.fract() == 0.0 && r.abs() < 9e15 {
        Value::Number(Number::from(r as i64))
    } else {
        Number::from_f64(r).map_or(Value::Null, Value::Number)
    }
}

/// Keep only the listed dotted paths. `*` fans out over array elements or object values:
/// `tracks.*.clips.*.id`. The result keeps the original nesting.
pub fn select(v: &Value, paths: &[&str]) -> Value {
    let mut out = Value::Null;
    for p in paths {
        let segs: Vec<&str> = p.split('.').filter(|s| !s.is_empty()).collect();
        merge(&mut out, pick(v, &segs));
    }
    out
}

fn pick(v: &Value, segs: &[&str]) -> Value {
    let Some((head, rest)) = segs.split_first() else { return v.clone() };
    match (v, *head) {
        (Value::Array(a), "*") => Value::Array(a.iter().map(|x| pick(x, rest)).collect()),
        (Value::Object(m), "*") => Value::Object(m.iter().map(|(k, x)| (k.clone(), pick(x, rest))).collect()),
        (Value::Array(a), i) => match i.parse::<usize>().ok().and_then(|i| a.get(i)) {
            Some(x) => pick(x, rest),
            None => Value::Null,
        },
        (Value::Object(m), k) => match m.get(k) {
            Some(x) => {
                let mut o = Map::new();
                o.insert(k.to_string(), pick(x, rest));
                Value::Object(o)
            }
            None => Value::Null,
        },
        _ => Value::Null,
    }
}

fn merge(into: &mut Value, from: Value) {
    match (into, from) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                merge(a.entry(k).or_insert(Value::Null), v);
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            for (i, v) in b.into_iter().enumerate() {
                if i < a.len() {
                    merge(&mut a[i], v);
                } else {
                    a.push(v);
                }
            }
        }
        (slot @ Value::Null, from) => *slot = from,
        (_, Value::Null) => {}
        (slot, from) => *slot = from,
    }
}

/// Paths that changed between two documents: `[path, old, new]` triples (`null` for added /
/// removed), at most `cap` of them. Arrays of objects with an `id` are matched by id, so
/// inserting one clip reports one addition rather than every later clip shifting.
pub fn diff(old: &Value, new: &Value, cap: usize) -> (Vec<Value>, usize) {
    let mut out = Vec::new();
    let mut total = 0;
    walk("", old, new, &mut out, &mut total, cap);
    (out, total)
}

fn walk(path: &str, a: &Value, b: &Value, out: &mut Vec<Value>, total: &mut usize, cap: usize) {
    if a == b {
        return;
    }
    let join = |k: &str| if path.is_empty() { k.to_string() } else { format!("{path}.{k}") };
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for (k, va) in x {
                walk(&join(k), va, y.get(k).unwrap_or(&Value::Null), out, total, cap);
            }
            for (k, vb) in y {
                if !x.contains_key(k) {
                    walk(&join(k), &Value::Null, vb, out, total, cap);
                }
            }
        }
        (Value::Array(x), Value::Array(y)) if id_key(x, y).is_some() => {
            let f = id_key(x, y).unwrap_or("id");
            let key = |v: &Value| v.get(f).map(|i| i.to_string()).unwrap_or_default();
            for va in x {
                let k = key(va);
                let vb = y.iter().find(|v| key(v) == k).unwrap_or(&Value::Null);
                walk(&join(&format!("[{f}={k}]")), va, vb, out, total, cap);
            }
            for vb in y {
                let k = key(vb);
                if !x.iter().any(|v| key(v) == k) {
                    walk(&join(&format!("[{f}={k}]")), &Value::Null, vb, out, total, cap);
                }
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (i, (va, vb)) in x.iter().zip(y).enumerate() {
                walk(&join(&i.to_string()), va, vb, out, total, cap);
            }
        }
        // pruning drops empty lists, so a list's first element shows up as null → [..]
        (Value::Null, Value::Array(y)) if id_key(&[], y).is_some() => walk(path, &Value::Array(vec![]), b, out, total, cap),
        (Value::Array(x), Value::Null) if id_key(x, &[]).is_some() => walk(path, a, &Value::Array(vec![]), out, total, cap),
        // a list that only grew (an undo stack, a log): report what was appended
        (Value::Array(x), Value::Array(y)) if y.len() > x.len() && y.starts_with(x) => {
            push(out, total, cap, join("+"), Value::Null, Value::Array(y[x.len()..].iter().map(brief).collect()));
        }
        (Value::Array(x), Value::Array(y)) if x.len() > y.len() && x.starts_with(y) => {
            push(out, total, cap, join("-"), Value::Array(x[y.len()..].iter().map(brief).collect()), Value::Null);
        }
        _ => push(out, total, cap, path.to_string(), brief(a), brief(b)),
    }
}

fn push(out: &mut Vec<Value>, total: &mut usize, cap: usize, path: String, a: Value, b: Value) {
    *total += 1;
    if out.len() < cap {
        out.push(Value::Array(vec![Value::String(path), a, b]));
    }
}

/// An added or removed object as its scalar fields only; nested parts become `[n]` / `{n}`.
/// Ask `reel.state _select=...` for the detail.
fn brief(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, x)| {
                    let x = match x {
                        Value::Array(a) if a.iter().all(|e| !e.is_object() && !e.is_array()) && a.len() <= 8 => x.clone(),
                        Value::Array(a) => Value::String(format!("[{}]", a.len())),
                        Value::Object(o) => Value::String(format!("{{{}}}", o.len())),
                        _ => x.clone(),
                    };
                    (k.clone(), x)
                })
                .collect(),
        ),
        Value::Array(a) if a.len() > 8 || a.iter().any(|e| e.is_object()) => Value::Array(a.iter().map(brief).collect()),
        _ => v.clone(),
    }
}

/// The identity field shared by every element of both lists (`id`, or FilmCraft's
/// `clip` / `item`, EffectCraft's `layer` / `uid`).
fn id_key(a: &[Value], b: &[Value]) -> Option<&'static str> {
    if a.is_empty() && b.is_empty() {
        return None;
    }
    ["id", "clip", "item", "layer", "uid"].into_iter().find(|k| a.iter().chain(b).all(|v| v.get(*k).is_some_and(|x| !x.is_object() && !x.is_array())))
}

/// Rough token estimate (≈4 bytes per token) for the reply budget shown on the dashboard.
pub fn tokens(v: &Value) -> usize {
    serde_json::to_string(v).map_or(0, |s| s.len().div_ceil(4))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prune_drops_empties_and_rounds() {
        let v = json!({"a":null,"b":[],"c":{},"d":"","e":1.234567,"f":false,"g":[{"h":null}],"i":2.0});
        assert_eq!(prune(&v, 3), json!({"e":1.235,"f":false,"g":[{}],"i":2}));
    }

    #[test]
    fn select_keeps_shape() {
        let v = json!({"name":"S","tracks":[{"id":1,"clips":[{"id":5,"x":1},{"id":6,"x":2}]},{"id":2,"clips":[]}]});
        assert_eq!(select(&v, &["name", "tracks.*.clips.*.id"]), json!({"name":"S","tracks":[{"clips":[{"id":5},{"id":6}]},{"clips":[]}]}));
    }

    #[test]
    fn diff_matches_by_id() {
        let a = json!({"clips":[{"id":1,"start":0},{"id":2,"start":10}],"playhead":0});
        let b = json!({"clips":[{"id":3,"start":0},{"id":1,"start":5},{"id":2,"start":10}],"playhead":0});
        let (d, n) = diff(&a, &b, 10);
        assert_eq!(n, 2);
        assert!(d.contains(&json!(["clips.[id=1].start", 0, 5])));
        assert!(d.contains(&json!(["clips.[id=3]", null, {"id":3,"start":0}])));
    }

    #[test]
    fn diff_briefs_added_objects_and_appends() {
        let a = json!({"undo":["a","b"],"clips":[{"id":1}]});
        let b = json!({"undo":["a","b","c"],"clips":[{"id":1},{"id":2,"fx":[{"p":{"x":1}}],"m":{"k":1},"t":[1,2]}]});
        let (d, _) = diff(&a, &b, 10);
        assert!(d.contains(&json!(["undo.+", null, ["c"]])), "{d:?}");
        assert!(d.contains(&json!(["clips.[id=2]", null, {"id":2,"fx":"[1]","m":"{1}","t":[1,2]}])), "{d:?}");
    }

    #[test]
    fn diff_caps_output_but_counts_all() {
        let a = json!({"a":1,"b":2,"c":3});
        let b = json!({"a":2,"b":3,"c":4});
        let (d, n) = diff(&a, &b, 1);
        assert_eq!((d.len(), n), (1, 3));
    }
}
