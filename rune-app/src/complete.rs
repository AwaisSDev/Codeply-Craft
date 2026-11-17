//! The code editor's typing help, all local and instant (no model call per key): suggestions as
//! you type (words in the open file and the other open files, the language's keywords and
//! snippets), closing brackets and quotes, and keeping the indent on Enter. Pure functions over
//! the text and the caret; `editor.rs` applies what they return to the editor.

use std::collections::HashMap;

/// The languages the editor knows words for, by file extension.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Js,
    Ts,
    Rust,
    Python,
    Html,
    Css,
    Json,
    Other,
}

impl Lang {
    pub fn of(path: &str) -> Lang {
        let ext = path.rsplit_once('.').map_or("", |(_, e)| e).to_ascii_lowercase();
        match ext.as_str() {
            "js" | "jsx" | "mjs" | "cjs" | "vue" | "svelte" | "astro" => Lang::Js,
            "ts" | "tsx" | "mts" | "cts" => Lang::Ts,
            "rs" => Lang::Rust,
            "py" | "pyw" => Lang::Python,
            "html" | "htm" | "xhtml" => Lang::Html,
            "css" | "scss" | "less" => Lang::Css,
            "json" | "jsonc" => Lang::Json,
            _ => Lang::Other,
        }
    }

    /// Whether `c` can be part of a word to complete (CSS and HTML names take dashes, JS `$`).
    pub fn word_char(self, c: char) -> bool {
        c.is_alphanumeric() || c == '_' || (c == '$' && matches!(self, Lang::Js | Lang::Ts)) || (c == '-' && matches!(self, Lang::Css | Lang::Html))
    }
}

/// Where a suggestion comes from; the popup shows it as an icon and a note.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    /// A word in the open file.
    Word,
    Keyword,
    Snippet,
    /// A word in another open file.
    Other,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub label: String,
    pub kind: Kind,
    /// What goes in, when it isn't the label: `$0` marks where the caret lands, a tab is one
    /// indent, and each new line keeps the line's indent.
    pub body: Option<String>,
    /// The other file a word came from.
    pub from: String,
}

/// The suggestions open under the caret: they replace `start..caret` (the word typed so far).
#[derive(Clone, Debug, PartialEq)]
pub struct Popup {
    pub file: String,
    pub start: usize,
    pub caret: usize,
    pub items: Vec<Item>,
    pub pick: usize,
}

/// A change to the editor's text: `from..to` becomes `insert`, then the caret goes to `caret`.
#[derive(Clone, Debug, PartialEq)]
pub struct Change {
    pub from: usize,
    pub to: usize,
    pub insert: String,
    pub caret: usize,
}

/// The most suggestions to work out (the popup shows a window of them).
pub const MAX: usize = 40;

// ---------- words ----------

/// The word being typed before `caret`: where it starts, and its text.
pub fn word_before(lang: Lang, text: &str, caret: usize) -> (usize, &str) {
    let caret = caret.min(text.len());
    if !text.is_char_boundary(caret) {
        return (caret, "");
    }
    let start = text[..caret].char_indices().rev().take_while(|(_, c)| lang.word_char(*c)).last().map_or(caret, |(i, _)| i);
    (start, &text[start..caret])
}

/// The words in `text` (two characters or more, not starting with a digit), with how often each
/// appears, skipping the one that spans `skip`.
fn words(lang: Lang, text: &str, skip: Option<(usize, usize)>, out: &mut HashMap<String, u32>) {
    let mut start: Option<usize> = None;
    let push = |a: usize, b: usize, out: &mut HashMap<String, u32>| {
        if skip.is_some_and(|(s, e)| a <= e && b >= s) {
            return;
        }
        let w = &text[a..b];
        let w = w.trim_matches('-');
        if w.chars().count() >= 2 && !w.starts_with(|c: char| c.is_ascii_digit()) && w.chars().any(|c| c.is_alphabetic()) {
            *out.entry(w.to_owned()).or_default() += 1;
        }
    };
    for (i, c) in text.char_indices() {
        if lang.word_char(c) {
            start.get_or_insert(i);
        } else if let Some(s) = start.take() {
            push(s, i, out);
        }
    }
    if let Some(s) = start {
        push(s, text.len(), out);
    }
}

/// How well `label` matches what was typed: 0 starts with it exactly, 1 starts with it in
/// another case, 2 has its letters in order from the same first letter (`gEBI` finds
/// `getElementById`); None when it doesn't match.
pub fn rank(label: &str, typed: &str) -> Option<u8> {
    if typed.is_empty() {
        return None;
    }
    if label.starts_with(typed) {
        return Some(0);
    }
    let (l, t) = (label.to_lowercase(), typed.to_lowercase());
    if l.starts_with(&t) {
        return Some(1);
    }
    let mut lc = l.chars();
    if lc.next() != t.chars().next() {
        return None;
    }
    let mut rest = t.chars().skip(1).peekable();
    for c in lc {
        if rest.peek() == Some(&c) {
            rest.next();
        }
    }
    rest.peek().is_none().then_some(2)
}

/// What to suggest at `caret` in `text` (a `lang` file), with words from `others` (other open
/// files: name and text). Empty when no word is being typed.
pub fn suggest(lang: Lang, text: &str, caret: usize, others: &[(&str, &str)]) -> (usize, Vec<Item>) {
    let (start, typed) = word_before(lang, text, caret);
    if typed.is_empty() || typed.starts_with(|c: char| c.is_ascii_digit()) || typed.chars().all(|c| c == '-') {
        return (start, Vec::new());
    }
    // A very long file: the words around the caret are enough.
    let (lo, hi) = if text.len() > 2_000_000 { (floor(text, caret.saturating_sub(400_000)), ceil(text, caret + 400_000)) } else { (0, text.len()) };
    let mut here = HashMap::new();
    words(lang, &text[lo..hi], Some((start - lo, caret - lo)), &mut here);
    let mut there: HashMap<String, (u32, &str)> = HashMap::new();
    for (name, body) in others {
        let mut m = HashMap::new();
        words(lang, &body[..floor(body, 400_000)], None, &mut m);
        for (w, n) in m {
            there.entry(w).or_insert((n, name));
        }
    }

    // (rank, kind, -count, label length) orders them; ties go alphabetically.
    let mut found: Vec<((u8, Kind, i64, usize), Item)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (label, body) in snippets(lang) {
        if let Some(r) = rank(&label, typed) {
            found.push(((r, Kind::Snippet, 0, label.len()), Item { label, kind: Kind::Snippet, body: Some(body), from: String::new() }));
        }
    }
    for k in keywords(lang) {
        if k != typed && let Some(r) = rank(k, typed) && seen.insert(k.to_owned()) {
            found.push(((r, Kind::Keyword, 0, k.len()), Item { label: k.to_owned(), kind: Kind::Keyword, body: None, from: String::new() }));
        }
    }
    for (w, n) in &here {
        if w != typed && let Some(r) = rank(w, typed) && seen.insert(w.clone()) {
            found.push(((r, Kind::Word, -(*n as i64), w.len()), Item { label: w.clone(), kind: Kind::Word, body: None, from: String::new() }));
        }
    }
    for (w, (n, name)) in &there {
        if w != typed && let Some(r) = rank(w, typed) && seen.insert(w.clone()) {
            found.push(((r, Kind::Other, -(*n as i64), w.len()), Item { label: w.clone(), kind: Kind::Other, body: None, from: (*name).to_owned() }));
        }
    }
    // Snippets and keywords sit with the file's own words: what you named comes first among
    // equals, then the language's words, then other files'.
    found.sort_by(|(a, ia), (b, ib)| {
        let order = |k: Kind| match k {
            Kind::Word => 0,
            Kind::Keyword | Kind::Snippet => 1,
            Kind::Other => 2,
        };
        (a.0, order(a.1), a.2, a.3, &ia.label, a.1).cmp(&(b.0, order(b.1), b.2, b.3, &ib.label, b.1))
    });
    found.truncate(MAX);
    (start, found.into_iter().map(|(_, i)| i).collect())
}

fn floor(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Taking `item` in place of the word `start..caret` (`unit`: one indent).
pub fn accept(text: &str, start: usize, caret: usize, item: &Item, unit: &str) -> Change {
    let line_start = text[..start].rfind('\n').map_or(0, |i| i + 1);
    let indent: String = text[line_start..].chars().take_while(|c| *c == ' ' || *c == '\t').collect();
    let mut body = match &item.body {
        Some(b) => b.replace('\t', unit).replace('\n', &format!("\n{indent}")),
        None => item.label.clone(),
    };
    // A tag typed after its `<` doesn't get a second one.
    if start > 0 && text[..start].ends_with('<') && body.starts_with('<') {
        body.remove(0);
    }
    let at = body.find("$0").unwrap_or(body.len());
    let insert = body.replacen("$0", "", 1);
    Change { from: start, to: caret, caret: start + at, insert }
}

// ---------- brackets, quotes and indent ----------

/// One indent in this file: a tab when its lines start with tabs, else the spaces its lines use
/// (2 or 4), else the language's usual.
pub fn indent_unit(lang: Lang, text: &str) -> String {
    let (mut tabs, mut two, mut four) = (0, 0, 0);
    for line in text.lines().take(400) {
        if line.starts_with('\t') {
            tabs += 1;
        } else {
            let n = line.len() - line.trim_start_matches(' ').len();
            if n > 0 && line.trim().is_empty() {
                continue;
            }
            if n % 4 == 2 {
                two += 1;
            } else if n > 0 && n % 4 == 0 {
                four += 1;
            }
        }
    }
    if tabs > two + four {
        "\t".into()
    } else if two > 0 && two * 4 >= four {
        "  ".into()
    } else if four > 0 {
        "    ".into()
    } else if matches!(lang, Lang::Rust | Lang::Python | Lang::Other) {
        "    ".into()
    } else {
        "  ".into()
    }
}

fn closer(open: char) -> Option<char> {
    match open {
        '(' => Some(')'),
        '[' => Some(']'),
        '{' => Some('}'),
        '"' | '\'' | '`' => Some(open),
        _ => None,
    }
}

/// HTML elements with no closing tag.
const VOID: &[&str] = &["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"];

/// Typing `ch` over the selection `a..b`: a bracket or quote closes itself (or wraps the
/// selection), typing a closer that's already next steps over it, and `>` closes an HTML tag.
/// None when it types as usual.
pub fn typed(lang: Lang, text: &str, (a, b): (usize, usize), ch: char) -> Option<Change> {
    let (a, b) = (a.min(b), a.max(b).min(text.len()));
    if !text.is_char_boundary(a) || !text.is_char_boundary(b) {
        return None;
    }
    let next = text[b..].chars().next();
    let prev = text[..a].chars().next_back();
    let quote = matches!(ch, '"' | '\'' | '`');
    // Rust's `'` starts lifetimes and chars as often as strings, and `` ` `` pairs only in JS and TS.
    let pairs = closer(ch).is_some() && !(lang == Lang::Rust && ch == '\'') && !(ch == '`' && !matches!(lang, Lang::Js | Lang::Ts | Lang::Other));
    if a != b {
        let close = closer(ch).filter(|_| pairs)?;
        let inner = &text[a..b];
        return Some(Change { from: a, to: b, insert: format!("{ch}{inner}{close}"), caret: a + 1 + inner.len() });
    }
    // A closer that's already there: step over it.
    if (matches!(ch, ')' | ']' | '}') || (quote && pairs)) && next == Some(ch) {
        return Some(Change { from: a, to: a, insert: String::new(), caret: a + ch.len_utf8() });
    }
    if pairs && let Some(close) = closer(ch) {
        // A quote right after a word is an apostrophe (don't, it's), or closes a string.
        if quote && prev.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '\\') {
            return None;
        }
        // Text between HTML tags: quotes are just quotes.
        if lang == Lang::Html && quote && !text[..a].rsplit('>').next().unwrap_or("").contains('<') {
            return None;
        }
        let free = next.is_none_or(|c| c.is_whitespace() || matches!(c, ')' | ']' | '}' | ',' | ';' | ':' | '>'));
        return free.then(|| Change { from: a, to: a, insert: format!("{ch}{close}"), caret: a + 1 });
    }
    if ch == '>' && lang == Lang::Html {
        let open = text[..a].rfind('<')?;
        let tag = &text[open + 1..a];
        if tag.contains('>') || tag.ends_with('/') {
            return None;
        }
        let name: String = tag.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        if name.is_empty() || VOID.contains(&name.to_ascii_lowercase().as_str()) || text[b..].starts_with(&format!("</{name}")) {
            return None;
        }
        return Some(Change { from: a, to: a, insert: format!("></{name}>"), caret: a + 1 });
    }
    None
}

/// Backspace between a bracket or quote and its closer deletes both.
pub fn backspace(text: &str, (a, b): (usize, usize)) -> Option<Change> {
    if a != b || a == 0 || !text.is_char_boundary(a) {
        return None;
    }
    let prev = text[..a].chars().next_back()?;
    let next = text[a..].chars().next()?;
    (closer(prev) == Some(next)).then(|| Change { from: a - prev.len_utf8(), to: a + next.len_utf8(), insert: String::new(), caret: a - prev.len_utf8() })
}

/// Enter: a new line at the same indent, one deeper after an opening bracket (or Python's `:`),
/// and between a pair (`{|}`, `<p>|</p>`) the closer goes on a line of its own.
pub fn enter(lang: Lang, text: &str, (a, b): (usize, usize), unit: &str) -> Change {
    let (a, b) = (a.min(b), a.max(b).min(text.len()));
    let line_start = text[..a].rfind('\n').map_or(0, |i| i + 1);
    let indent: String = text[line_start..a].chars().take_while(|c| *c == ' ' || *c == '\t').collect();
    let before = text[line_start..a].trim_end();
    let after = &text[b..];
    let last = before.chars().next_back();
    // `<ul>|</ul>`, not `</li>|</ul>`.
    let tag_pair = lang == Lang::Html && before.ends_with('>') && !before.ends_with("/>") && after.starts_with("</")
        && !before.rfind('<').is_some_and(|i| before[i..].starts_with("</"));
    let pair = tag_pair || matches!((last, after.chars().next()), (Some('{'), Some('}')) | (Some('['), Some(']')) | (Some('('), Some(')')));
    let opens = pair || matches!(last, Some('{' | '[' | '(')) || (lang == Lang::Python && last == Some(':'));
    if pair {
        let first = format!("\n{indent}{unit}");
        return Change { from: a, to: b, caret: a + first.len(), insert: format!("{first}\n{indent}") };
    }
    let insert = if opens { format!("\n{indent}{unit}") } else { format!("\n{indent}") };
    Change { from: a, to: b, caret: a + insert.len(), insert }
}

/// Tab: one indent at the caret, or before each line of a selection that spans lines.
pub fn indent(text: &str, (a, b): (usize, usize), unit: &str) -> Change {
    let (a, b) = (a.min(b), a.max(b).min(text.len()));
    if !text[a..b].contains('\n') {
        return Change { from: a, to: b, caret: a + unit.len(), insert: unit.to_owned() };
    }
    let start = text[..a].rfind('\n').map_or(0, |i| i + 1);
    let insert: String = text[start..b].split('\n').map(|l| if l.is_empty() { String::new() } else { format!("{unit}{l}") }).collect::<Vec<_>>().join("\n");
    Change { from: start, to: b, caret: start + insert.len(), insert }
}

/// Shift+Tab: the caret's line one indent shallower.
pub fn outdent(text: &str, caret: usize, unit: &str) -> Option<Change> {
    let line_start = text[..caret.min(text.len())].rfind('\n').map_or(0, |i| i + 1);
    let rest = &text[line_start..];
    let n = if rest.starts_with('\t') {
        1
    } else {
        rest.chars().take(unit.len().max(1)).take_while(|c| *c == ' ').count()
    };
    (n > 0).then(|| Change { from: line_start, to: line_start + n, insert: String::new(), caret: caret.saturating_sub(n).max(line_start) })
}

// ---------- each language's words ----------

const JS: &[&str] = &[
    "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "export",
    "extends", "false", "finally", "for", "from", "function", "if", "import", "in", "instanceof", "let", "new", "null", "of", "return",
    "static", "super", "switch", "this", "throw", "true", "try", "typeof", "undefined", "var", "void", "while", "yield",
    "console", "document", "window", "JSON", "Math", "Promise", "Array", "Object", "String", "Number", "Boolean", "Date", "Error",
    "Map", "Set", "fetch", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "require", "module", "exports", "process",
    "localStorage", "addEventListener", "querySelector", "querySelectorAll", "getElementById", "innerHTML", "textContent",
    "length", "push", "map", "filter", "reduce", "forEach", "find", "includes", "slice", "splice", "join", "split", "replace",
    "toString", "parseInt", "parseFloat", "then", "constructor", "prototype",
];

const TS: &[&str] = &["interface", "type", "enum", "implements", "namespace", "declare", "readonly", "private", "protected", "public", "abstract", "keyof", "as", "any", "unknown", "never", "string", "number", "boolean", "Record", "Partial", "Promise"];

const RUST: &[&str] = &[
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false", "fn", "for", "if", "impl",
    "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait",
    "true", "type", "unsafe", "use", "where", "while", "Some", "None", "Ok", "Err", "Option", "Result", "String", "Vec", "Box", "HashMap",
    "HashSet", "println", "format", "vec", "assert", "assert_eq", "unwrap", "expect", "clone", "to_owned", "to_string", "iter", "collect",
    "into", "default", "Default", "Debug", "Clone", "derive",
];

const PYTHON: &[&str] = &[
    "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else",
    "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
    "return", "try", "while", "with", "yield", "self", "print", "len", "range", "enumerate", "zip", "open", "list", "dict", "set",
    "tuple", "str", "int", "float", "bool", "isinstance", "sorted", "super", "__init__", "__name__", "__main__",
];

const HTML: &[&str] = &[
    "class", "id", "href", "src", "alt", "style", "type", "name", "value", "title", "placeholder", "rel", "target", "width", "height",
    "onclick", "disabled", "checked", "required", "action", "method", "charset", "content", "lang", "for", "aria-label", "role",
];

/// Tags offered as snippets (`div` writes `<div></div>` with the caret inside).
const TAGS: &[&str] = &[
    "div", "span", "p", "a", "h1", "h2", "h3", "ul", "ol", "li", "button", "form", "label", "section", "header", "footer", "main",
    "nav", "article", "aside", "table", "tr", "td", "th", "strong", "em", "code", "pre", "textarea", "select", "option", "script", "style",
];

const CSS: &[&str] = &[
    "align-items", "animation", "background", "background-color", "border", "border-radius", "bottom", "box-shadow", "box-sizing",
    "color", "cursor", "display", "flex", "flex-direction", "flex-wrap", "font-family", "font-size", "font-weight", "gap", "grid",
    "grid-template-columns", "height", "justify-content", "left", "letter-spacing", "line-height", "margin", "margin-top",
    "margin-bottom", "max-width", "min-height", "opacity", "outline", "overflow", "padding", "position", "right", "text-align",
    "text-decoration", "top", "transform", "transition", "width", "z-index",
];

const CSS_VALUES: &[&str] = &["absolute", "auto", "block", "bold", "center", "column", "fixed", "flex", "grid", "hidden", "inherit", "inline-block", "none", "pointer", "relative", "row", "solid", "space-between", "sticky", "transparent", "wrap"];

pub fn keywords(lang: Lang) -> Vec<&'static str> {
    match lang {
        Lang::Js => JS.to_vec(),
        Lang::Ts => JS.iter().chain(TS).copied().collect(),
        Lang::Rust => RUST.to_vec(),
        Lang::Python => PYTHON.to_vec(),
        Lang::Html => HTML.to_vec(),
        Lang::Css => CSS_VALUES.to_vec(),
        Lang::Json => vec!["true", "false", "null"],
        Lang::Other => Vec::new(),
    }
}

const JS_SNIPPETS: &[(&str, &str)] = &[
    ("log", "console.log($0);"),
    ("for", "for (let i = 0; i < $0; i++) {\n\t\n}"),
    ("forof", "for (const item of $0) {\n\t\n}"),
    ("if", "if ($0) {\n\t\n}"),
    ("ifelse", "if ($0) {\n\t\n} else {\n\t\n}"),
    ("function", "function $0() {\n\t\n}"),
    ("arrow", "const $0 = () => {\n\t\n};"),
    ("try", "try {\n\t$0\n} catch (err) {\n\t\n}"),
    ("import", "import $0 from \"\";"),
    ("class", "class $0 {\n\tconstructor() {\n\t\t\n\t}\n}"),
    ("while", "while ($0) {\n\t\n}"),
    ("switch", "switch ($0) {\n\tcase :\n\t\tbreak;\n\tdefault:\n}"),
    ("timeout", "setTimeout(() => {\n\t$0\n}, 1000);"),
    ("fetch", "const res = await fetch($0);\nconst data = await res.json();"),
];

const TS_SNIPPETS: &[(&str, &str)] = &[("interface", "interface $0 {\n\t\n}"), ("type", "type $0 = ;")];

const RUST_SNIPPETS: &[(&str, &str)] = &[
    ("fn", "fn $0() {\n\t\n}"),
    ("pfn", "pub fn $0() {\n\t\n}"),
    ("main", "fn main() {\n\t$0\n}"),
    ("struct", "struct $0 {\n\t\n}"),
    ("enum", "enum $0 {\n\t\n}"),
    ("impl", "impl $0 {\n\t\n}"),
    ("match", "match $0 {\n\t_ => {}\n}"),
    ("iflet", "if let Some($0) =  {\n\t\n}"),
    ("for", "for $0 in  {\n\t\n}"),
    ("println", "println!(\"{}\", $0);"),
    ("test", "#[test]\nfn $0() {\n\t\n}"),
    ("derive", "#[derive(Debug, Clone$0)]"),
];

const PYTHON_SNIPPETS: &[(&str, &str)] = &[
    ("def", "def $0():\n\t"),
    ("class", "class $0:\n\tdef __init__(self):\n\t\t"),
    ("if", "if $0:\n\t"),
    ("ifmain", "if __name__ == \"__main__\":\n\t$0"),
    ("for", "for $0 in :\n\t"),
    ("while", "while $0:\n\t"),
    ("try", "try:\n\t$0\nexcept Exception as e:\n\t"),
    ("with", "with open($0) as f:\n\t"),
    ("print", "print($0)"),
];

const HTML_SNIPPETS: &[(&str, &str)] = &[
    ("html5", "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n\t<meta charset=\"UTF-8\">\n\t<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n\t<title>$0</title>\n</head>\n<body>\n\t\n</body>\n</html>"),
    ("img", "<img src=\"$0\" alt=\"\">"),
    ("input", "<input type=\"$0\">"),
    ("link", "<link rel=\"stylesheet\" href=\"$0\">"),
    ("meta", "<meta name=\"$0\" content=\"\">"),
    ("br", "<br>"),
    ("scriptsrc", "<script src=\"$0\"></script>"),
];

/// The language's snippets: (label, body).
pub fn snippets(lang: Lang) -> Vec<(String, String)> {
    let own = |list: &[(&str, &str)]| list.iter().map(|(l, b)| ((*l).to_owned(), (*b).to_owned())).collect::<Vec<_>>();
    match lang {
        Lang::Js => own(JS_SNIPPETS),
        Lang::Ts => own(JS_SNIPPETS).into_iter().chain(own(TS_SNIPPETS)).collect(),
        Lang::Rust => own(RUST_SNIPPETS),
        Lang::Python => own(PYTHON_SNIPPETS),
        Lang::Html => own(HTML_SNIPPETS).into_iter().chain(TAGS.iter().map(|t| ((*t).to_owned(), format!("<{t}>$0</{t}>")))).collect(),
        // A property writes `name: ;` with the caret before the `;`.
        Lang::Css => CSS.iter().map(|p| ((*p).to_owned(), format!("{p}: $0;"))).collect(),
        Lang::Json | Lang::Other => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(items: &[Item]) -> Vec<&str> {
        items.iter().map(|i| i.label.as_str()).collect()
    }

    #[test]
    fn the_word_before_the_caret() {
        assert_eq!(word_before(Lang::Js, "let total = sub", 15), (12, "sub"));
        assert_eq!(word_before(Lang::Js, "a.$el", 5), (2, "$el"));
        assert_eq!(word_before(Lang::Css, "  background-co", 15), (2, "background-co"));
        assert_eq!(word_before(Lang::Rust, "x + ", 4), (4, ""));
    }

    #[test]
    fn ranks_prefix_then_case_then_letters_in_order() {
        assert_eq!(rank("getElementById", "get"), Some(0));
        assert_eq!(rank("getElementById", "GET"), Some(1));
        assert_eq!(rank("getElementById", "gEBI"), Some(2));
        assert_eq!(rank("getElementById", "eid"), None, "the first letter must match");
        assert_eq!(rank("map", ""), None);
    }

    #[test]
    fn suggests_the_files_words_keywords_and_snippets() {
        let text = "const totalPrice = 1;\nfunction renderTotal() {}\nto";
        let (start, items) = suggest(Lang::Js, text, text.len(), &[]);
        assert_eq!(start, text.len() - 2);
        let l = labels(&items);
        assert!(l.contains(&"totalPrice") && l.contains(&"toString"), "{l:?}");
        assert!(!l.contains(&"to"), "not the word being typed");
        // The file's own words first among exact prefixes.
        assert_eq!(l[0], "totalPrice");

        let (_, items) = suggest(Lang::Js, "ret", 3, &[]);
        assert_eq!(labels(&items)[0], "return");
        let (_, items) = suggest(Lang::Js, "lo", 2, &[]);
        assert!(items.iter().any(|i| i.label == "log" && i.kind == Kind::Snippet));
        let (_, items) = suggest(Lang::Rust, "pri", 3, &[]);
        assert!(labels(&items).contains(&"println"));
        let (_, items) = suggest(Lang::Python, "de", 2, &[]);
        assert!(items.iter().any(|i| i.label == "def" && i.kind == Kind::Snippet));
        let (_, items) = suggest(Lang::Css, "  backg", 7, &[]);
        assert_eq!(labels(&items)[..2], ["background", "background-color"]);
        let (_, items) = suggest(Lang::Html, "<se", 3, &[]);
        assert!(labels(&items).contains(&"section"));
    }

    #[test]
    fn words_from_other_open_files_come_after_this_ones() {
        let (_, items) = suggest(Lang::Ts, "const plan = 1;\npl", 18, &[("plans.ts", "export const planPrices = {}")]);
        let l = labels(&items);
        assert_eq!(l[0], "plan");
        let other = items.iter().find(|i| i.label == "planPrices").expect("from the other file");
        assert_eq!((other.kind, other.from.as_str()), (Kind::Other, "plans.ts"));
    }

    #[test]
    fn nothing_while_typing_numbers_or_after_a_space() {
        assert!(suggest(Lang::Js, "x = 12", 6, &[]).1.is_empty());
        assert!(suggest(Lang::Js, "return ", 7, &[]).1.is_empty());
    }

    #[test]
    fn accepting_replaces_the_word_and_places_the_caret() {
        let text = "  co";
        let item = Item { label: "console".into(), kind: Kind::Keyword, body: None, from: String::new() };
        assert_eq!(accept(text, 2, 4, &item, "  "), Change { from: 2, to: 4, insert: "console".into(), caret: 9 });
        // A snippet keeps the line's indent on each new line, with the caret at $0.
        let snip = Item { label: "if".into(), kind: Kind::Snippet, body: Some("if ($0) {\n\t\n}".into()), from: String::new() };
        let c = accept("    if", 4, 6, &snip, "  ");
        assert_eq!(c.insert, "if () {\n      \n    }");
        assert_eq!(c.caret, 8);
        // After a `<`, a tag snippet doesn't add another.
        let tag = Item { label: "div".into(), kind: Kind::Snippet, body: Some("<div>$0</div>".into()), from: String::new() };
        assert_eq!(accept("<di", 1, 3, &tag, "  ").insert, "div></div>");
    }

    #[test]
    fn brackets_and_quotes_close_themselves() {
        let c = typed(Lang::Js, "f", (1, 1), '(').unwrap();
        assert_eq!((c.insert.as_str(), c.caret), ("()", 2));
        // Typing the closer that's next steps over it.
        assert_eq!(typed(Lang::Js, "f()", (2, 2), ')').unwrap(), Change { from: 2, to: 2, insert: String::new(), caret: 3 });
        // Not before a word, and no apostrophes turned into pairs.
        assert!(typed(Lang::Js, "fx", (1, 1), '(').is_none());
        assert!(typed(Lang::Js, "don", (3, 3), '\'').is_none());
        // A selection is wrapped.
        assert_eq!(typed(Lang::Js, "a b", (2, 3), '"').unwrap().insert, "\"b\"");
        // Rust's lifetimes stay single.
        assert!(typed(Lang::Rust, "&", (1, 1), '\'').is_none());
        // HTML closes the tag on `>`, not void ones.
        assert_eq!(typed(Lang::Html, "<div class=\"a\"", (14, 14), '>').unwrap().insert, "></div>");
        assert!(typed(Lang::Html, "<br", (3, 3), '>').is_none());
        assert_eq!(backspace("f()", (2, 2)).unwrap(), Change { from: 1, to: 3, insert: String::new(), caret: 1 });
        assert!(backspace("f(x)", (3, 3)).is_none());
    }

    #[test]
    fn enter_keeps_the_indent() {
        let t = "  let a = 1;";
        assert_eq!(enter(Lang::Js, t, (12, 12), "  ").insert, "\n  ");
        let t = "  if (x) {}";
        let c = enter(Lang::Js, t, (10, 10), "  ");
        assert_eq!((c.insert.as_str(), c.caret), ("\n    \n  ", 15));
        assert_eq!(enter(Lang::Python, "def f():", (8, 8), "    ").insert, "\n    ");
        assert_eq!(enter(Lang::Html, "<ul></ul>", (4, 4), "  ").insert, "\n  \n");
        assert_eq!(outdent("    x", 5, "  "), Some(Change { from: 0, to: 2, insert: String::new(), caret: 3 }));
        assert_eq!(indent("a\nb", (0, 3), "  ").insert, "  a\n  b");
        assert_eq!(indent("ab", (1, 1), "\t"), Change { from: 1, to: 1, insert: "\t".into(), caret: 2 });
    }

    #[test]
    fn the_indent_follows_the_file() {
        assert_eq!(indent_unit(Lang::Js, "a {\n\tb\n}"), "\t");
        assert_eq!(indent_unit(Lang::Js, "a {\n    b\n        c\n}"), "    ");
        assert_eq!(indent_unit(Lang::Rust, "a {\n  b\n    c\n}"), "  ");
        assert_eq!(indent_unit(Lang::Python, ""), "    ");
        assert_eq!(indent_unit(Lang::Css, ""), "  ");
    }

    #[test]
    fn languages_by_extension() {
        assert_eq!(Lang::of("src/App.tsx"), Lang::Ts);
        assert_eq!(Lang::of("main.RS"), Lang::Rust);
        assert_eq!(Lang::of("index.htm"), Lang::Html);
        assert_eq!(Lang::of("Makefile"), Lang::Other);
    }
}
