//! Replies as the Electron app draws them (rich-ui.js): the agent's Markdown as real, readable
//! UI, natively in Rune.
//!
//!  - Headings in six sizes, **bold**, *italic*, ~~strike~~, ==highlight==, `code`, and links
//!    as the site's icon and name ("Codeply" with its favicon, not the raw URL). Clicking a link
//!    opens it in the built-in browser.
//!  - Colour and pills: `:green[text]`, `:pill-amber[Pending]`, `:badge[New]`, `:kbd[Ctrl+K]`.
//!  - Quotes, callouts (a quote that opens with `[!NOTE]`, `[!TIP]`, `[!WARNING]` ...), dividers.
//!  - Numbered, bulleted, nested and task lists; tables with aligned columns.
//!  - ```` ```doc Title ```` a document card with Copy and Expand; a link to a file on its own
//!    line as a file card; code blocks with Copy.
//!  - ```` ```widget Title ```` in Electron runs sandboxed HTML. Here nothing ever runs: the card
//!    shows the title and, behind "Show code", the source as text. Model text can only display.
//!
//! While a reply streams in, its words fade in from grey to white as they arrive (Rune's
//! streaming reveal), the Electron app's text animation. Half-written blocks (a fence not yet
//! closed, a table without rows) draw as what has arrived so far.

use std::cell::Cell;
use std::collections::HashSet;
use std::ops::Range;

use rune::{Align, Color, El, Icon, InlineIcon, Link, LinkPaint, PillStyle, Span, TextCase, col, el, icon, rich, row, text};

use crate::app::App;
use crate::favicon;
use crate::icons::ico_s;
use crate::theme::{READ_LH, Theme, hex, mono, rgba, text_scale, ui};

/// How long each arriving word takes to fade in, in seconds.
pub const WORD_FADE: f32 = 0.6;

/// A reply's body text size.
const SIZE: f32 = 15.0;

// ─── Inline ─────────────────────────────────────────────────────────────────

/// One line of inline Markdown, flattened: the text, its styled runs, its links (byte range,
/// URL), and the ranges drawn as struck, as capsule pills and as key caps.
#[derive(Debug, Default, PartialEq)]
pub struct Inline {
    pub text: String,
    pub spans: Vec<Span>,
    pub links: Vec<(Range<usize>, String)>,
    /// `~~struck~~` byte ranges.
    pub strikes: Vec<Range<usize>>,
    /// Capsule pills: range, chip fill, label ink.
    pub pills: Vec<(Range<usize>, Color, Color)>,
    /// Key caps (`:kbd[..]`): range and the cap's outline.
    pub rings: Vec<(Range<usize>, Color)>,
}

/// rich-ui.js's COLORS: each name a colour directive accepts, to the colour it means.
pub fn color_name(name: &str) -> Option<&'static str> {
    Some(match name {
        "green" | "success" => "green",
        "red" | "danger" | "error" => "red",
        "blue" | "info" => "blue",
        "amber" | "orange" | "yellow" | "warning" | "warn" => "amber",
        "purple" | "violet" => "purple",
        "gray" | "grey" | "muted" => "gray",
        _ => return None,
    })
}

/// What `:name[text]` draws.
#[derive(Debug, PartialEq)]
pub enum Directive {
    /// `:kbd[Ctrl+K]`: a key cap.
    Kbd,
    /// `:pill[..]`, `:badge[..]`, `:pill-green[..]`: a capsule, plain or in a colour.
    Pill(Option<&'static str>),
    /// `:green[..]`: coloured text.
    Ink(&'static str),
}

/// rich-ui.js's `directive()`: None for a name it doesn't know (the text stays as written).
pub fn directive(name: &str) -> Option<Directive> {
    match name {
        "kbd" => return Some(Directive::Kbd),
        "pill" | "badge" => return Some(Directive::Pill(None)),
        _ => {}
    }
    if let Some(c) = name.strip_prefix("pill-").or_else(|| name.strip_prefix("badge-")) {
        return color_name(c).map(|c| Directive::Pill(Some(c)));
    }
    color_name(name).map(Directive::Ink)
}

/// The Electron app's `--blue`.
fn blue(t: &Theme) -> Color {
    if t.dark { hex("#3d8bfd") } else { hex("#1a73e8") }
}

/// A colour name from [`color_name`] in this theme.
fn tone(t: &Theme, c: &str) -> Color {
    match c {
        "green" => t.green,
        "red" => t.red,
        "blue" => blue(t),
        "amber" => t.warn,
        "purple" => t.purple,
        _ => t.dim,
    }
}

/// `==highlight==`: a marker-pen yellow (`--rx-mark`).
fn mark_fill(t: &Theme) -> Color {
    if t.dark { rgba(240, 196, 64, 0.28) } else { rgba(255, 213, 79, 0.55) }
}

/// LaTeX arrows models slip into prose ("A $\rightarrow$ B"): rich-ui.js's LATEX_MAP.
const LATEX: &[(&str, &str)] = &[
    ("rightarrow", "→"), ("to", "→"), ("Rightarrow", "⇒"), ("leftarrow", "←"), ("Leftarrow", "⇐"),
    ("leftrightarrow", "↔"), ("Leftrightarrow", "⇔"), ("times", "×"), ("cdot", "·"), ("approx", "≈"),
    ("neq", "≠"), ("leq", "≤"), ("geq", "≥"), ("pm", "±"), ("infty", "∞"),
];

/// Parses one line of inline Markdown: `**bold**` / `__bold__`, `*italic*` / `_italic_`,
/// `~~strike~~`, `==highlight==`, `` `code` ``, `[label](url)`, bare URLs, `:name[text]`
/// directives and LaTeX arrows.
pub fn inline(src: &str, t: &Theme) -> Inline {
    let mut out = Inline::default();
    let chars: Vec<char> = src.chars().collect();
    let n = chars.len();
    let at = |i: usize, s: &str| -> bool {
        let mut k = i;
        for c in s.chars() {
            if k >= n || chars[k] != c {
                return false;
            }
            k += 1;
        }
        true
    };
    let find = |from: usize, s: &str| -> Option<usize> { (from..n).find(|&k| at(k, s)) };
    let collect = |a: usize, b: usize| chars[a..b].iter().collect::<String>();
    let space = |k: usize| chars.get(k).is_none_or(|c| c.is_whitespace());
    let word = |k: Option<usize>| k.and_then(|k| chars.get(k)).is_some_and(|c| c.is_alphanumeric());
    // A `mark`ed run (`**`, `~~`, `==`): it opens and closes against a non-space.
    let pair = |i: usize, mark: &str| -> Option<usize> {
        let m = mark.chars().count();
        if !at(i, mark) || space(i + m) {
            return None;
        }
        (i + m + 1..n).find(|&k| at(k, mark) && !space(k - 1) && !chars[k..].iter().take(m).any(|&c| c == '\n'))
            .filter(|&k| !chars[i + m..k].contains(&'\n'))
    };
    let mut i = 0;
    while i < n {
        let c = chars[i];
        // `code`: nothing inside it is Markdown.
        if c == '`' {
            if let Some(end) = find(i + 1, "`").filter(|&e| e > i + 1 && !chars[i + 1..e].contains(&'\n')) {
                let start = out.text.len();
                out.text.push_str(&collect(i + 1, end));
                out.spans.push(Span::new(start, out.text.len()).mono().bg(t.code_bg, 3.0).color(t.code_ink));
                i = end + 1;
                continue;
            }
        }
        // $\rightarrow$ and friends.
        if c == '\\' || (c == '$' && chars.get(i + 1) == Some(&'\\')) {
            let slash = if c == '$' { i + 1 } else { i };
            let name_end = (slash + 1..n).find(|&k| !chars[k].is_ascii_alphabetic()).unwrap_or(n);
            let name = collect(slash + 1, name_end);
            if let Some((_, sym)) = LATEX.iter().find(|(k, _)| *k == name) {
                out.text.push_str(sym);
                i = if chars.get(name_end) == Some(&'$') { name_end + 1 } else { name_end };
                continue;
            }
        }
        // [label](url)
        if c == '[' {
            if let Some(close) = find(i + 1, "](").filter(|&k| !chars[i + 1..k].contains(&'\n')) {
                if let Some(end) = find(close + 2, ")") {
                    let label = collect(i + 1, close);
                    let url = collect(close + 2, end);
                    if !label.is_empty() && (favicon::host(&url).is_some() || url.starts_with("file:")) {
                        let base = out.text.len();
                        let inner = inline(&label, t);
                        append(&mut out, inner);
                        let end_b = out.text.len();
                        link_chip(&mut out, base..end_b, &url, t);
                        i = end + 1;
                        continue;
                    }
                }
            }
        }
        // A bare URL: shown as the site's name.
        if (at(i, "https://") || at(i, "http://")) && (i == 0 || chars[i - 1].is_whitespace() || chars[i - 1] == '(') {
            let mut end = i;
            while end < n && !chars[end].is_whitespace() && !matches!(chars[end], ')' | '>' | '"' | '\'' | '<') {
                end += 1;
            }
            // Sentence punctuation after a URL isn't part of it.
            while end > i && matches!(chars[end - 1], '.' | ',' | ';' | ':' | '!' | '?') {
                end -= 1;
            }
            let url = collect(i, end);
            if favicon::host(&url).is_some() {
                let start = out.text.len();
                out.text.push_str(&favicon::site_name(&url));
                let end_b = out.text.len();
                link_chip(&mut out, start..end_b, &url, t);
                i = end;
                continue;
            }
        }
        // :name[text]
        if c == ':' && chars.get(i + 1).is_some_and(|c| c.is_ascii_lowercase()) {
            let name_end = (i + 1..n).find(|&k| !(chars[k].is_ascii_lowercase() || chars[k] == '-')).unwrap_or(n);
            let name = collect(i + 1, name_end);
            let shaped = !name.ends_with('-') && name.matches('-').count() <= 1;
            if shaped && chars.get(name_end) == Some(&'[') {
                if let (Some(d), Some(close)) = (directive(&name), find(name_end + 1, "]")) {
                    if close > name_end + 1 && !chars[name_end + 1..close].contains(&'\n') {
                        let start = out.text.len();
                        let inner = inline(&collect(name_end + 1, close), t);
                        append(&mut out, inner);
                        let r = start..out.text.len();
                        match d {
                            Directive::Kbd => {
                                out.spans.push(Span::new(r.start, r.end).mono().bg(t.control, 3.0).color(t.text));
                                out.rings.push((r, t.control_border));
                            }
                            Directive::Pill(None) => out.pills.push((r, t.bubble, t.text)),
                            Directive::Pill(Some(c)) => {
                                let ink = tone(t, c);
                                out.pills.push((r, ink.alpha(if t.dark { 0.17 } else { 0.13 }), ink));
                            }
                            Directive::Ink(c) => out.spans.push(Span::new(r.start, r.end).color(tone(t, c))),
                        }
                        i = close + 1;
                        continue;
                    }
                }
            }
        }
        // **bold** and __bold__ (the underscores not inside a word).
        let bold = if c == '_' && word(i.checked_sub(1)) { None } else { pair(i, "**").or_else(|| pair(i, "__")) };
        if let Some(end) = bold {
            let start = out.text.len();
            let inner = inline(&collect(i + 2, end), t);
            append(&mut out, inner);
            out.spans.push(Span::new(start, out.text.len()).weight(600.0).color(t.text));
            i = end + 2;
            continue;
        }
        // ~~strike~~
        if let Some(end) = pair(i, "~~") {
            let start = out.text.len();
            let inner = inline(&collect(i + 2, end), t);
            append(&mut out, inner);
            out.strikes.push(start..out.text.len());
            out.spans.push(Span::new(start, out.text.len()).color(t.dim));
            i = end + 2;
            continue;
        }
        // ==highlight==
        if let Some(end) = pair(i, "==") {
            let start = out.text.len();
            let inner = inline(&collect(i + 2, end), t);
            append(&mut out, inner);
            out.spans.push(Span::new(start, out.text.len()).bg(mark_fill(t), 2.0));
            i = end + 2;
            continue;
        }
        // *italic* or _italic_ (not inside a word, so snake_case stays as it is)
        if (c == '*' || c == '_') && !word(i.checked_sub(1)) && (i == 0 || chars[i - 1] != c) && chars.get(i + 1).is_some_and(|x| !x.is_whitespace() && *x != c) {
            let close = (i + 2..n).find(|&k| chars[k] == c && !chars[k - 1].is_whitespace() && chars[k - 1] != c && chars.get(k + 1) != Some(&c) && !word(Some(k + 1)));
            if let Some(end) = close.filter(|&e| !chars[i + 1..e].contains(&'\n')) {
                let start = out.text.len();
                let inner = inline(&collect(i + 1, end), t);
                append(&mut out, inner);
                out.spans.push(Span::new(start, out.text.len()).italic());
                i = end + 1;
                continue;
            }
        }
        out.text.push(c);
        i += 1;
    }
    out
}

/// Adds `inner` (parsed on its own) to the end of `out`.
fn append(out: &mut Inline, inner: Inline) {
    let base = out.text.len();
    let shift = |r: Range<usize>| r.start + base..r.end + base;
    out.text.push_str(&inner.text);
    out.spans.extend(inner.spans.into_iter().map(|mut s| {
        s.start += base as u32;
        s.end += base as u32;
        s
    }));
    out.links.extend(inner.links.into_iter().map(|(r, u)| (shift(r), u)));
    out.strikes.extend(inner.strikes.into_iter().map(shift));
    out.pills.extend(inner.pills.into_iter().map(|(r, a, b)| (shift(r), a, b)));
    out.rings.extend(inner.rings.into_iter().map(|(r, c)| (shift(r), c)));
}

/// A soft chip around a link's name, as the Electron app draws a link.
fn link_chip(out: &mut Inline, r: Range<usize>, url: &str, t: &Theme) {
    out.spans.push(Span::new(r.start, r.end).weight(500.0).color(t.text).bg(t.code_bg, 4.0));
    out.links.push((r, url.to_owned()));
}

/// One paragraph (or list item, heading, quote line) as a text element: styled runs, links
/// that open in the browser, each link's site icon before it, and the streaming fade.
pub fn paragraph(src: &str, t: &Theme, size: f32, weight: f32, color: Color, streaming: bool) -> El {
    styled(src, t, size, ui(size, weight).lh(read_lh(size)), color, streaming, false)
}

/// Reading line height for text of `size` points.
fn read_lh(size: f32) -> f32 {
    (size * text_scale() * READ_LH).round()
}

/// [`paragraph`] in any text style; `struck`: the whole line is crossed out (a done task).
fn styled(src: &str, t: &Theme, size: f32, font: rune::TextStyle, color: Color, streaming: bool, struck: bool) -> El {
    let mut p = inline(src, t);
    // Bold inside a heading keeps the heading's weight.
    if font.weight > 600.0 {
        for s in &mut p.spans {
            if s.weight == Some(600.0) {
                s.weight = Some(font.weight);
            }
        }
    }
    // Pills and key caps in smaller type, as rich-ui.css sets them (0.82em).
    let small = (size * 0.86 * 2.0).round() / 2.0;
    for (r, ..) in &p.pills {
        p.spans.push(Span::new(r.start, r.end).size(small).weight(600.0));
    }
    for (r, _) in &p.rings {
        p.spans.push(Span::new(r.start, r.end).size(small));
    }
    if streaming {
        let tail = tail_spans(&p.text, t);
        p.spans.extend(tail);
    }
    let len = p.text.len();
    let mut e = rich(p.text.clone(), p.spans).font(font).color(color).wrap().selectable(true);
    if !p.strikes.is_empty() {
        e = e.strikes(p.strikes.iter().map(|r| (r.start, r.end, None)));
    }
    if struck && len > 0 {
        e = e.strike(0, len, Some(t.faint));
    }
    if !p.pills.is_empty() {
        e = e.pills(p.pills.iter().map(|(r, bg, fg)| (r.clone(), PillStyle::new().bg(*bg).fg(*fg))));
    }
    if !p.rings.is_empty() {
        e = e.span_rings(p.rings.iter().map(|(r, c)| (r.start, r.end, *c, 1.0)));
    }
    for (range, url) in &p.links {
        if let Some(icon) = favicon::get(url) {
            e = e.inline_icon(range.start, InlineIcon::image(icon).size(size).gap(5.0).radius(3.0));
        }
        e = e.link(Link::new(range.clone(), url.clone()).help(url.clone()).hover(LinkPaint::new().underline(t.text)));
    }
    if !p.links.is_empty() {
        e = e.on_link(|s: &mut App, url: &str, _tx| s.browse(url));
    }
    if streaming {
        e = e.reveal(WORD_FADE);
    }
    e
}

/// The streaming wave: the newest words of a reply that is still arriving are grey and
/// brighten to white over the last `TAIL` words, so the colour flows along as text comes in.
const TAIL: usize = 14;

fn tail_spans(text: &str, t: &Theme) -> Vec<Span> {
    let mut words: Vec<(usize, usize)> = Vec::new();
    let mut start = None;
    for (i, c) in text.char_indices() {
        match (c.is_whitespace(), start) {
            (false, None) => start = Some(i),
            (true, Some(b)) => {
                words.push((b, i));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(b) = start {
        words.push((b, text.len()));
    }
    words.iter().rev().take(TAIL).enumerate().map(|(k, &(a, b))| {
        let lit = (k as f32 + 1.0) / (TAIL as f32 + 1.0);
        Span::new(a, b).color(t.faint.mix(t.text, lit))
    }).collect()
}

// ─── Blocks ─────────────────────────────────────────────────────────────────

/// One block of a reply, as rich-ui.js's `blocks()` splits it.
#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    /// Lines of one paragraph, joined with `\n` (each its own line, as `<br>`).
    Para(String),
    Heading(u8, String),
    Rule,
    Quote(Vec<Block>),
    /// `> [!WARNING] Title`: a kind from [`callout_kind`], its title, its body.
    Callout { kind: &'static str, title: String, body: Vec<Block> },
    List { ordered: bool, start: u64, items: Vec<Item> },
    Table(Table),
    /// A fenced block: its language (lower case), the rest of the opening line, its text, and
    /// whether its closing fence has arrived.
    Fence { lang: String, info: String, body: String, closed: bool },
    /// Links to files, each on its own line.
    Files(Vec<FileLink>),
}

/// A list item: a task's tick (`None`: not a task), its text, and what's nested under it.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub task: Option<bool>,
    pub text: String,
    pub sub: Vec<Block>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Table {
    pub head: Vec<String>,
    /// Per column: what the separator row says (`:---` start, `:---:` centre, `---:` end),
    /// `None` when it says nothing.
    pub align: Vec<Option<Align>>,
    pub rows: Vec<Vec<String>>,
}

/// A link to a file: where it opens (an http(s) or `file:` URL), the file's name, its
/// extension (lower case), and the link's own words when they say more than the name.
#[derive(Clone, Debug, PartialEq)]
pub struct FileLink {
    pub url: String,
    pub name: String,
    pub ext: String,
    pub label: Option<String>,
}

/// rich-ui.js's CALLOUTS: kind, title, colour.
const CALLOUTS: &[(&str, &str, &str)] = &[
    ("note", "Note", "blue"),
    ("info", "Info", "blue"),
    ("tip", "Tip", "green"),
    ("success", "Done", "green"),
    ("important", "Important", "purple"),
    ("warning", "Warning", "amber"),
    ("caution", "Caution", "red"),
    ("danger", "Danger", "red"),
];

/// A callout kind by any case (`NOTE`, `Tip`), as its CALLOUTS key.
pub fn callout_kind(word: &str) -> Option<&'static str> {
    let w = word.to_ascii_lowercase();
    CALLOUTS.iter().find(|(k, ..)| *k == w).map(|(k, ..)| *k)
}

/// Columns indented with tabs count four each.
fn indent_of(l: &str) -> usize {
    l.chars().take_while(|c| c.is_whitespace()).map(|c| if c == '\t' { 4 } else { 1 }).sum()
}

/// The line after up to three leading spaces (None when it's indented further).
fn lead3(l: &str) -> Option<&str> {
    let rest = l.trim_start_matches(' ');
    (l.len() - rest.len() <= 3).then_some(rest)
}

/// An opening fence: its character and length, language, and the rest of the line.
fn fence_open(l: &str) -> Option<(char, usize, String, String)> {
    let s = lead3(l)?;
    let c = s.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let len = s.chars().take_while(|&x| x == c).count();
    if len < 3 {
        return None;
    }
    let rest = s[len..].trim_start();
    let lang_len = rest.find(|ch: char| !(ch.is_ascii_alphanumeric() || "_+#.-".contains(ch))).unwrap_or(rest.len());
    Some((c, len, rest[..lang_len].to_ascii_lowercase(), unquote(rest[lang_len..].trim()).to_owned()))
}

fn fence_close(l: &str, c: char, len: usize) -> bool {
    let s = l.trim();
    s.chars().count() >= len.max(3) && s.chars().all(|x| x == c)
}

fn unquote(s: &str) -> &str {
    for q in ['"', '\''] {
        if s.len() >= 2 && s.starts_with(q) && s.ends_with(q) {
            return &s[1..s.len() - 1];
        }
    }
    s
}

fn heading(l: &str) -> Option<(u8, String)> {
    let s = lead3(l)?;
    let n = s.chars().take_while(|&c| c == '#').count();
    if n == 0 || n > 6 {
        return None;
    }
    let rest = &s[n..];
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let mut body = rest.trim();
    // Closing hashes ("## Title ##"), not a word's own ("C#").
    let bare = body.trim_end_matches('#');
    if bare.len() != body.len() && (bare.is_empty() || bare.ends_with(char::is_whitespace)) {
        body = bare.trim_end();
    }
    Some((n as u8, body.to_owned()))
}

fn is_rule(l: &str) -> bool {
    let Some(s) = lead3(l) else { return false };
    let Some(c) = s.chars().next().filter(|c| matches!(c, '-' | '*' | '_')) else { return false };
    let marks = s.chars().filter(|x| !x.is_whitespace());
    s.chars().filter(|&x| x == c).count() >= 3 && marks.clone().all(|x| x == c)
}

fn quote_line(l: &str) -> Option<&str> {
    let s = lead3(l)?.strip_prefix('>')?;
    Some(s.strip_prefix([' ', '\t']).unwrap_or(s))
}

/// A list item: its indent, its marker, and its text.
fn list_item(l: &str) -> Option<(usize, &str, &str)> {
    let ind = indent_of(l);
    let s = l.trim_start();
    let first = s.chars().next()?;
    let mlen = if matches!(first, '-' | '*' | '+' | '•') {
        first.len_utf8()
    } else {
        let digits = s.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 || digits > 9 || !matches!(s[digits..].chars().next(), Some('.' | ')')) {
            return None;
        }
        digits + 1
    };
    let rest = &s[mlen..];
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some((ind, &s[..mlen], rest.trim_start()))
}

/// A table's separator row (`| :--- | ---: |`).
fn table_sep(l: &str) -> bool {
    if !l.contains('-') {
        return false;
    }
    let s = l.trim();
    let s = s.strip_prefix('|').unwrap_or(s);
    let s = s.strip_suffix('|').unwrap_or(s);
    s.split('|').all(|c| {
        let c = c.trim();
        let c = c.strip_prefix(':').unwrap_or(c);
        let c = c.strip_suffix(':').unwrap_or(c);
        !c.is_empty() && c.chars().all(|x| x == '-')
    })
}

/// A table row's cells (`\|` is a pipe inside a cell).
fn cells(l: &str) -> Vec<String> {
    let mut s = l.trim();
    s = s.strip_prefix('|').unwrap_or(s);
    if s.ends_with('|') && !s.ends_with("\\|") {
        s = &s[..s.len() - 1];
    }
    let mut out = vec![String::new()];
    let mut prev = '\0';
    for c in s.chars() {
        if c == '|' && prev != '\\' {
            out.push(String::new());
        } else if let Some(last) = out.last_mut() {
            if c == '|' {
                last.pop();
            }
            last.push(c);
        }
        prev = c;
    }
    out.into_iter().map(|c| c.trim().to_owned()).collect()
}

/// A separator cell's alignment.
pub fn cell_align(c: &str) -> Option<Align> {
    let c = c.trim();
    match (c.starts_with(':'), c.ends_with(':')) {
        (true, true) => Some(Align::Center),
        (false, true) => Some(Align::End),
        (true, false) => Some(Align::Start),
        _ => None,
    }
}

/// A cell that is a number (rich-ui.js: a column of them lines up on the right).
fn is_numeric(c: &str) -> bool {
    let mut s = c.trim();
    s = s.strip_prefix(['-', '+']).unwrap_or(s);
    s = s.strip_prefix(['$', '€', '£']).unwrap_or(s);
    if !s.starts_with(|c: char| c.is_ascii_digit()) {
        return false;
    }
    let num = s.find(|c: char| !(c.is_ascii_digit() || c == ',' || c == '.')).unwrap_or(s.len());
    let unit = s[num..].trim().to_ascii_lowercase();
    ["", "%", "x", "ms", "s", "k", "m", "gb", "mb"].contains(&unit.as_str())
}

fn starts_block(line: &str, next: Option<&str>) -> bool {
    fence_open(line).is_some() || heading(line).is_some() || is_rule(line) || list_item(line).is_some() || quote_line(line).is_some()
        || (line.contains('|') && next.is_some_and(table_sep))
}

/// Splits a reply into blocks.
pub fn parse(src: &str) -> Vec<Block> {
    let src = src.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<String> = src.split('\n').map(str::to_owned).collect();
    blocks(&lines)
}

fn blocks(lines: &[String]) -> Vec<Block> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].as_str();
        if line.trim().is_empty() {
            i += 1;
            continue;
        }
        if let Some((c, len, lang, info)) = fence_open(line) {
            let mut body = Vec::new();
            let mut closed = false;
            i += 1;
            while i < lines.len() {
                if fence_close(&lines[i], c, len) {
                    closed = true;
                    i += 1;
                    break;
                }
                body.push(lines[i].as_str());
                i += 1;
            }
            out.push(Block::Fence { lang, info, body: body.join("\n"), closed });
            continue;
        }
        if let Some((n, h)) = heading(line) {
            out.push(Block::Heading(n, h));
            i += 1;
            continue;
        }
        if is_rule(line) {
            out.push(Block::Rule);
            i += 1;
            continue;
        }
        if quote_line(line).is_some() {
            let mut body = Vec::new();
            while i < lines.len() && !lines[i].trim().is_empty() {
                let Some(q) = quote_line(&lines[i]) else { break };
                body.push(q.to_owned());
                i += 1;
            }
            out.push(quote(&body));
            continue;
        }
        if line.contains('|') && lines.get(i + 1).is_some_and(|l| table_sep(l)) {
            let head = cells(line);
            let align = cells(&lines[i + 1]).iter().map(|c| cell_align(c)).collect();
            i += 2;
            let mut rows = Vec::new();
            while i < lines.len() && !lines[i].trim().is_empty() && lines[i].contains('|') {
                rows.push(cells(&lines[i]));
                i += 1;
            }
            out.push(Block::Table(Table { head, align, rows }));
            continue;
        }
        if let Some((base, ..)) = list_item(line) {
            let start = i;
            i += 1;
            while i < lines.len() {
                let l = lines[i].as_str();
                if l.trim().is_empty() {
                    // A blank line continues the list only if more of it follows.
                    let more = lines.get(i + 1).is_some_and(|nx| {
                        !nx.trim().is_empty() && (indent_of(nx) > base || list_item(nx).is_some_and(|(ind, ..)| ind >= base))
                    });
                    if more {
                        i += 1;
                        continue;
                    }
                    break;
                }
                if indent_of(l) > base || list_item(l).is_some_and(|(ind, ..)| ind >= base) {
                    i += 1;
                    continue;
                }
                break;
            }
            if let Some(b) = list(&lines[start..i], base) {
                out.push(b);
            }
            continue;
        }
        // A paragraph: runs until a blank line or the start of another block.
        let mut para: Vec<&str> = Vec::new();
        while i < lines.len() && !lines[i].trim().is_empty() && (para.is_empty() || !starts_block(&lines[i], lines.get(i + 1).map(String::as_str))) {
            para.push(lines[i].trim());
            i += 1;
        }
        let files: Vec<FileLink> = para.iter().filter_map(|l| file_link(l)).collect();
        if files.len() == para.len() {
            out.push(Block::Files(files));
        } else {
            out.push(Block::Para(para.join("\n")));
        }
    }
    out
}

fn quote(body: &[String]) -> Block {
    let first = body.first().map(|l| l.trim_start()).unwrap_or("");
    if let Some(rest) = first.strip_prefix("[!") {
        if let Some((word, title)) = rest.split_once(']') {
            if let Some(kind) = callout_kind(word).filter(|_| word.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')) {
                return Block::Callout { kind, title: title.trim().to_owned(), body: blocks(&body[1..]) };
            }
        }
    }
    Block::Quote(blocks(body))
}

fn task(text: &str) -> Option<(bool, &str)> {
    let done = match text.get(..3)? {
        "[ ]" => false,
        "[x]" | "[X]" => true,
        _ => return None,
    };
    let rest = &text[3..];
    rest.starts_with(char::is_whitespace).then(|| (done, rest.trim_start()))
}

fn list(lines: &[String], base: usize) -> Option<Block> {
    // Split into items at the base indent; deeper lines belong to the item above.
    let mut items: Vec<(String, String, Vec<String>)> = Vec::new();
    for l in lines {
        match list_item(l) {
            Some((ind, marker, first)) if ind == base => items.push((marker.to_owned(), first.to_owned(), Vec::new())),
            _ => {
                if let Some(last) = items.last_mut() {
                    last.2.push(l.clone());
                }
            }
        }
    }
    let (first_marker, ..) = items.first()?;
    let ordered = first_marker.starts_with(|c: char| c.is_ascii_digit());
    let start = if ordered { first_marker.trim_end_matches(['.', ')']).parse().unwrap_or(1) } else { 1 };
    let mut out = Vec::new();
    for (_, first, mut rest) in items {
        let (tick, mut text) = match task(&first) {
            Some((done, t)) => (Some(done), t.to_owned()),
            None => (None, first),
        };
        if rest.last().is_some_and(|l| l.trim().is_empty()) {
            rest.pop();
        }
        let mut sub = Vec::new();
        if !rest.is_empty() {
            let cut = rest.iter().filter(|l| !l.trim().is_empty()).map(|l| indent_of(l)).min().unwrap_or(usize::MAX);
            let deeper: Vec<String> = rest.iter().map(|l| {
                let l = l.replace('\t', "    ");
                let k = cut.min(indent_of(&l));
                l.chars().skip(k).collect()
            }).collect();
            let mut k = 0;
            if list_item(&deeper[0]).is_none() && fence_open(&deeper[0]).is_none() && !deeper[0].trim().is_empty() {
                // Lines that are only a deeper continuation of the text join it.
                while k < deeper.len() && !deeper[k].trim().is_empty() && !starts_block(&deeper[k], deeper.get(k + 1).map(String::as_str)) {
                    text.push('\n');
                    text.push_str(deeper[k].trim());
                    k += 1;
                }
            }
            sub = blocks(&deeper[k..]);
        }
        out.push(Item { task: tick, text, sub });
    }
    Some(Block::List { ordered, start, items: out })
}

// ─── Files ──────────────────────────────────────────────────────────────────

/// Extensions a link opens as a file card, with its kind's name and badge colour.
const FILE_KINDS: &[(&[&str], &str, &str)] = &[
    (&["pdf"], "PDF", "#e5484d"),
    (&["doc", "docx", "odt", "rtf", "pages"], "Word document", "#2f6fe4"),
    (&["xls", "xlsx", "ods", "numbers"], "Spreadsheet", "#1e8e4f"),
    (&["csv", "tsv"], "CSV", "#1e8e4f"),
    (&["ppt", "pptx", "odp", "key"], "Presentation", "#e0651b"),
    (&["zip", "gz", "tgz", "tar", "7z", "rar"], "Archive", "#b7791f"),
    (&["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "bmp"], "Image", "#8b5cf6"),
    (&["mp3", "wav", "m4a", "mp4", "mov", "webm"], "Media", "#d6409f"),
    (&["md"], "Markdown", "#6b7280"),
    (&["txt", "json", "epub"], "Text", "#6b7280"),
];

fn file_kind(ext: &str) -> Option<(&'static str, &'static str)> {
    FILE_KINDS.iter().find(|(exts, ..)| exts.contains(&ext)).map(|(_, name, color)| (*name, *color))
}

/// A path on this computer as a `file:` URL (None for anything that isn't an absolute path).
fn file_url(path: &str) -> Option<String> {
    if path.starts_with("file:") {
        return Some(path.to_owned());
    }
    let abs = if let Some(rest) = path.strip_prefix("~/") {
        let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok()?;
        format!("{}/{rest}", home.trim_end_matches(['/', '\\']))
    } else {
        path.to_owned()
    };
    let b = abs.as_bytes();
    let windows = b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
    if !abs.starts_with('/') && !windows {
        return None;
    }
    let slashed = abs.replace('\\', "/");
    let enc: String = slashed.chars().map(|c| if c == ' ' { "%20".to_owned() } else { c.to_string() }).collect();
    Some(if windows { format!("file:///{enc}") } else { format!("file://{enc}") })
}

/// A whole line that is only a link to a file: `[label](url)`, a bare URL or an absolute path
/// (also in backticks or angle brackets).
pub fn file_link(line: &str) -> Option<FileLink> {
    let line = line.trim();
    let (label, target) = if let Some(rest) = line.strip_prefix('[') {
        let (label, rest) = rest.split_once("](")?;
        let target = rest.strip_suffix(')')?;
        (Some(label.trim().to_owned()).filter(|l| !l.is_empty()), target.trim())
    } else {
        let bare = line.strip_prefix('`').and_then(|l| l.strip_suffix('`'))
            .or_else(|| line.strip_prefix('<').and_then(|l| l.strip_suffix('>')))
            .unwrap_or(line);
        (None, bare)
    };
    if target.is_empty() || target.contains(['\n', '"', '<', '>']) || (label.is_none() && target.contains(' ') && !target.contains(['/', '\\'])) {
        return None;
    }
    let web = favicon::host(target).is_some();
    let url = if web { target.to_owned() } else { file_url(target)? };
    // The name: the path's last part, without any query or fragment.
    let path = target.split(['?', '#']).next().unwrap_or(target);
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path).replace("%20", " ");
    let (stem, ext) = name.rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    if stem.is_empty() || file_kind(&ext).is_none() {
        return None;
    }
    let label = label.filter(|l| !l.eq_ignore_ascii_case(&name) && !l.eq_ignore_ascii_case(target));
    Some(FileLink { url, name, ext, label })
}

// ─── Drawing ────────────────────────────────────────────────────────────────

/// What a reply is drawn with: the theme, the cards that are open (None: no App to keep them,
/// so cards show everything), the reply's id for their keys, and a count of its cards.
struct Ctx<'a> {
    t: &'a Theme,
    open: Option<&'a HashSet<String>>,
    id: &'a str,
    cards: Cell<usize>,
}

impl Ctx<'_> {
    /// The next card's key in `s.expanded`.
    fn key(&self, kind: &str) -> String {
        let n = self.cards.get();
        self.cards.set(n + 1);
        format!("md/{}/{kind}/{n}", self.id)
    }

    fn is_open(&self, key: &str) -> bool {
        self.open.is_some_and(|o| o.contains(key))
    }
}

fn gap() -> f32 {
    (12.0 * text_scale()).round()
}

/// A whole reply. `streaming`: it is still arriving, so new words fade in. With no App to
/// keep cards open or closed, documents show in full and widgets show only Copy; see [`reply`].
pub fn render(src: &str, t: &Theme, streaming: bool) -> El {
    let cx = Ctx { t, open: None, id: "", cards: Cell::new(0) };
    stack(&cx, &parse(src), t.text, 0, streaming)
}

/// [`render`] for a reply in a chat: document cards open and close, and widgets show their
/// code, kept in `s.expanded` under `md/{id}/...`. `id` names the reply ("chat title/index").
#[allow(dead_code)] // until thread.rs draws replies with it
pub fn reply(s: &App, id: &str, src: &str, t: &Theme, streaming: bool) -> El {
    let cx = Ctx { t, open: Some(&s.expanded), id, cards: Cell::new(0) };
    stack(&cx, &parse(src), t.text, 0, streaming)
}

/// Blocks one under another, in `ink`; only the last one is still arriving.
fn stack(cx: &Ctx, blocks: &[Block], ink: Color, depth: usize, live: bool) -> El {
    let mut out = col().w_full().min_w(0.0).gap(gap());
    let last = blocks.len().saturating_sub(1);
    for (k, b) in blocks.iter().enumerate() {
        out = out.child(block(cx, b, ink, depth, live && k == last, k == 0));
    }
    out
}

fn block(cx: &Ctx, b: &Block, ink: Color, depth: usize, live: bool, first: bool) -> El {
    let t = cx.t;
    match b {
        Block::Para(p) => paragraph(p, t, SIZE, 400.0, ink, live),
        Block::Heading(n, h) => {
            let k = (*n as usize).clamp(1, 6) - 1;
            let size = [26.0, 21.5, 18.5, 16.0, 15.0, 13.0][k];
            let weight = [700.0, 700.0, 650.0, 650.0, 650.0, 650.0][k];
            let tracking = [-0.45, -0.25, -0.15, 0.0, 0.0, 0.5][k];
            let font = ui(size, weight).lh((size * text_scale() * 1.3).round()).tracking(tracking);
            let color = if k == 5 { t.dim } else { t.text };
            let mut e = styled(h, t, size, font, color, live, false);
            if k == 5 {
                e = e.text_case(TextCase::Uppercase);
            }
            // More room above a heading than below it.
            let above = if first { 0.0 } else { [14.0, 12.0, 8.0, 4.0, 2.0, 2.0][k] };
            e.mt(above).mb(-3.0)
        }
        Block::Rule => el().w_full().h(1.0).my(6.0).fill(t.border),
        Block::Quote(body) => row().w_full().min_w(0.0).pl(14.0).border_sides([0.0, 0.0, 0.0, 3.0], t.control_border)
            .child(stack(cx, body, t.dim, depth, live).grow(1.0).min_w(0.0)),
        Block::Callout { kind, title, body } => callout(cx, kind, title, body, live),
        Block::List { ordered, start, items } => list_el(cx, *ordered, *start, items, ink, depth, live),
        Block::Table(tb) => table(t, tb, ink),
        Block::Fence { lang, info, body, closed } => fence(cx, lang, info, body, *closed, live),
        Block::Files(files) => files_el(t, files),
    }
}

// Callout icons, from rich-ui.js's CALLOUTS (24 grid, 2 point strokes).
static I_NOTE: Icon = Icon { name: "rx-note", view: 24.0, body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></g>"# };
static I_TIP: Icon = Icon { name: "rx-tip", view: 24.0, body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z"/></g>"# };
static I_DONE: Icon = Icon { name: "rx-done", view: 24.0, body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></g>"# };
static I_IMPORTANT: Icon = Icon { name: "rx-important", view: 24.0, body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4Z"/><path d="M12 8v3"/><path d="M12 13.5h.01"/></g>"# };
static I_WARNING: Icon = Icon { name: "rx-warning", view: 24.0, body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20Z"/><path d="M12 10v4"/><path d="M12 17h.01"/></g>"# };
static I_CAUTION: Icon = Icon { name: "rx-caution", view: 24.0, body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3h8l5 5v8l-5 5H8l-5-5V8Z"/><path d="M12 8v5"/><path d="M12 16h.01"/></g>"# };

fn callout(cx: &Ctx, kind: &str, title: &str, body: &[Block], live: bool) -> El {
    let t = cx.t;
    let (_, label, color) = CALLOUTS.iter().find(|(k, ..)| *k == kind).copied().unwrap_or(CALLOUTS[0]);
    let glyph = match kind {
        "tip" => &I_TIP,
        "success" => &I_DONE,
        "important" => &I_IMPORTANT,
        "warning" => &I_WARNING,
        "caution" | "danger" => &I_CAUTION,
        _ => &I_NOTE,
    };
    let c = tone(t, color);
    let line = read_lh(SIZE);
    let head_text = if title.is_empty() { label.to_owned() } else { title.to_owned() };
    let head = row().w_full().gap(8.0).items_start()
        .child(icon(glyph, 17.0).color(c).mt(((line - 17.0) / 2.0).max(0.0)))
        .child(styled(&head_text, t, SIZE, ui(SIZE, 650.0).lh(line), c, live && body.is_empty(), false).grow(1.0).min_w(0.0));
    let mut card = col().w_full().min_w(0.0).gap(4.0).px(16.0).pt(11.0).pb(12.0)
        .radius(12.0).continuous_corners().fill(c.alpha(if t.dark { 0.08 } else { 0.06 })).border(1.0, c.alpha(0.24))
        .child(head);
    if !body.is_empty() {
        card = card.child(stack(cx, body, t.text, 0, live));
    }
    card
}

fn list_el(cx: &Ctx, ordered: bool, start: u64, items: &[Item], ink: Color, depth: usize, live: bool) -> El {
    let t = cx.t;
    let line = read_lh(SIZE);
    let k = text_scale();
    let last_n = start + items.len().saturating_sub(1) as u64;
    let mark_w = if ordered { ((6.0 + 8.6 * last_n.to_string().len() as f32) * k).round() } else { (14.0 * k).round() };
    let mut out = col().w_full().min_w(0.0).gap((6.0 * k).round());
    let last = items.len().saturating_sub(1);
    for (n, it) in items.iter().enumerate() {
        let live_it = live && n == last;
        let marker = match it.task {
            Some(done) => {
                let b = (16.0 * k).round();
                let mut boxed = el().size(b, b).mt(((line - b) / 2.0).max(0.0)).mr(2.0).radius(4.5).continuous_corners().center();
                boxed = if done {
                    boxed.fill(t.accent).child(ico_s("check", (12.0 * k).round(), t.on_accent))
                } else {
                    boxed.border(1.5, t.faint.alpha(0.7))
                };
                boxed
            }
            None if ordered => text(format!("{}.", start + n as u64)).font(ui(SIZE, 400.0).lh(line).features("'tnum' 1")).color(t.faint).w(mark_w).align(Align::End),
            None => text(["•", "◦", "▪"][depth % 3]).font(ui(SIZE, 400.0).lh(line)).color(t.faint).w(mark_w).align(Align::Center),
        };
        let done = it.task == Some(true);
        let mut body = col().grow(1.0).min_w(0.0).gap((6.0 * k).round())
            .child(styled(&it.text, t, SIZE, ui(SIZE, 400.0).lh(line), if done { t.dim } else { ink }, live_it && it.sub.is_empty(), done));
        if !it.sub.is_empty() {
            body = body.child(stack(cx, &it.sub, ink, depth + 1, live_it));
        }
        out = out.child(row().w_full().min_w(0.0).gap(8.0).items_start().child(marker).child(body));
    }
    out
}

/// A table as ChatGPT draws one: no box, a bold header, thin lines between rows, numbers on
/// the right. Up to five columns share the width by how much they hold and wrap; a wider
/// table scrolls sideways inside itself.
fn table(t: &Theme, tb: &Table, ink: Color) -> El {
    let n = tb.head.len().max(tb.rows.iter().map(Vec::len).max().unwrap_or(0)).max(1);
    let size = 14.0;
    let k = text_scale();
    let numeric: Vec<bool> = (0..n).map(|c| !tb.rows.is_empty() && tb.rows.iter().all(|r| r.get(c).is_some_and(|x| is_numeric(x)))).collect();
    let align: Vec<Align> = (0..n).map(|c| match tb.align.get(c).copied().flatten() {
        Some(a) => a,
        None if numeric[c] && c > 0 => Align::End,
        None => Align::Start,
    }).collect();
    // What each column holds, as shown (without its Markdown): its longest cell and word.
    let shown: Vec<Vec<String>> = std::iter::once(&tb.head).chain(tb.rows.iter())
        .map(|r| (0..n).map(|c| r.get(c).map(|x| inline(x, t).text).unwrap_or_default()).collect()).collect();
    let longest: Vec<usize> = (0..n).map(|c| shown.iter().map(|r| r[c].chars().count()).max().unwrap_or(1)).collect();
    let word: Vec<usize> = (0..n).map(|c| {
        shown.iter().flat_map(|r| r[c].split_whitespace().map(|w| w.chars().count())).max().unwrap_or(1)
    }).collect();
    // Up to five columns always fit: they share the width by what they hold (a long word
    // counts double, so a short column keeps its word whole) and wrap. More columns than that
    // scroll sideways inside the table, each as wide as it needs up to about 36 letters.
    let wide = n > 5;
    let pad = (16.0 * k).round();
    let line = (size * k * 1.5).round();
    let cell = |src: &str, c: usize, head: bool| -> El {
        let mut font = ui(size, if head { 600.0 } else { 400.0 }).lh(line);
        if numeric[c] {
            font = font.features("'tnum' 1");
        }
        let pr = if c + 1 < n { pad } else { 0.0 };
        let words = styled(src, t, size, font, if head { t.text } else { ink }, false, false).w_full().align(align[c]);
        if wide {
            el().w(((longest[c].clamp(4, 36) as f32) * 8.4 * k + 8.0 + pr).round()).pr(pr).child(words)
        } else {
            let share = (longest[c].min(60).max(word[c] * 2)).max(4) as f32;
            el().grow(share).min_w(((word[c].min(6) as f32) * 9.0 * k + 4.0 + pr).round()).pr(pr).child(words.wrap_anywhere())
        }
    };
    let row_of = |r: &[String], head: bool| -> El {
        (0..n).fold(row().w_full().items_start(), |acc, c| acc.child(cell(r.get(c).map(String::as_str).unwrap_or(""), c, head)))
    };
    let mut body = col().w_full().min_w(0.0)
        .child(row_of(&tb.head, true).pb((8.0 * k).round()).border_sides([0.0, 0.0, 1.0, 0.0], t.control_border));
    let last = tb.rows.len().saturating_sub(1);
    for (i, r) in tb.rows.iter().enumerate() {
        let mut e = row_of(r, false).py((9.0 * k).round());
        if i < last {
            e = e.border_sides([0.0, 0.0, 1.0, 0.0], t.border);
        }
        body = body.child(e);
    }
    if wide {
        // It scrolls sideways inside itself, never the page.
        el().w_full().min_w(0.0).my(4.0).scroll_x().scroll_edge_fade(24.0).child(body)
    } else {
        body.my(4.0)
    }
}

fn fence(cx: &Ctx, lang: &str, info: &str, body: &str, closed: bool, live: bool) -> El {
    let t = cx.t;
    match lang {
        "doc" | "document" | "writing" => doc_card(cx, lang, info, body, live),
        "callout" | "note" | "tip" | "warning" | "important" | "caution" => {
            let mut words = info.split_whitespace();
            let (kind, title) = if lang == "callout" {
                let first = words.next().unwrap_or("note");
                match callout_kind(first) {
                    Some(k) => (k, words.collect::<Vec<_>>().join(" ")),
                    None => ("note", info.to_owned()),
                }
            } else {
                (callout_kind(lang).unwrap_or("note"), info.to_owned())
            };
            callout(cx, kind, unquote(&title), &parse(body), live)
        }
        // A finished reply whose widget never closed is shown as its code.
        "widget" | "ui" | "interactive" if closed || live => widget(cx, info, body, closed),
        _ => code_block(t, lang, body),
    }
}

/// A small icon button in a card's top bar.
fn icon_btn(t: &Theme, name: &str, label: &str) -> El {
    el().size(28.0, 28.0).radius(8.0).continuous_corners().center().hover(t.hover).role("button").label(label.to_owned()).help(label.to_owned())
        .child(ico_s(name, 15.0, t.dim))
}

static I_DOC: Icon = Icon { name: "rx-doc", view: 24.0, body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></g>"# };
static I_COLLAPSE: Icon = Icon { name: "rx-collapse", view: 24.0, body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></g>"# };

/// A ```` ```doc Title ```` block: a card with the writing in it as full Markdown, Copy and
/// Expand. Closed, a long one shows its first dozen lines fading out.
fn doc_card(cx: &Ctx, lang: &str, title: &str, body: &str, live: bool) -> El {
    let t = cx.t;
    let key = cx.key("doc");
    let long = body.lines().count() > 14 || body.chars().count() > 1100;
    let can_fold = cx.open.is_some() && long;
    let open = !can_fold || cx.is_open(&key);
    // Its title (or what it is) in small type at the top, as ChatGPT labels a piece of writing.
    let label = match title.trim() {
        "" if lang == "writing" => "Writing".to_owned(),
        "" => "Document".to_owned(),
        x => x.to_owned(),
    };
    let copy = body.to_owned();
    let mut buttons = row().gap(2.0).child(icon_btn(t, "copy", "Copy").on_press_tx(move |_: &mut App, tx| tx.copy(copy.clone())));
    if can_fold {
        let k = key.clone();
        let (label, glyph) = if open { ("Collapse", &I_COLLAPSE) } else { ("Expand", &I_DOC) };
        let b = el().size(28.0, 28.0).radius(8.0).continuous_corners().center().hover(t.hover).role("button").label(label).help(label)
            .child(if open { icon(glyph, 15.0).color(t.dim) } else { ico_s("expand", 15.0, t.dim) })
            .on_press(move |s: &mut App| s.toggle_expanded(&k));
        buttons = buttons.child(b);
    }
    let head = row().w_full().h(40.0).pl(18.0).pr(8.0).center_y().justify_between()
        .child(row().grow(1.0).min_w(0.0).gap(7.0).center_y().child(icon(&I_DOC, 15.0).color(t.faint)).child(text(label).font(ui(12.5, 550.0)).color(t.faint).truncate()))
        .child(buttons);
    let content = col().w_full().min_w(0.0).px(22.0).pt(2.0).pb(22.0).child(stack(cx, &parse(body), t.text, 0, live));
    let shown = if open {
        content
    } else {
        // About twelve lines of reading text, fading out at the bottom.
        el().w_full().min_w(0.0).max_h((read_lh(SIZE) * 12.0).round()).clip_fade(0.0, 0.0, 0.0, 72.0).child(content)
    };
    let mut card = col().w_full().min_w(0.0).radius(16.0).continuous_corners().fill(t.card).border(1.0, t.border).child(head).child(shown);
    if !open {
        let k = key.clone();
        card = card.child(row().w_full().h(36.0).center().gap(6.0).hover(t.hover).role("button").label("Show all")
            .child(text("Show all").font(ui(12.5, 500.0)).color(t.dim)).child(ico_s("chevron-down", 14.0, t.dim))
            .on_press(move |s: &mut App| s.toggle_expanded(&k)));
    }
    card
}

/// A ```` ```widget Title ```` block. In the Electron app it runs in a sandboxed frame; here it
/// never runs: a card with its title and, behind "Show code", its source as plain text.
fn widget(cx: &Ctx, title: &str, body: &str, closed: bool) -> El {
    let t = cx.t;
    let key = cx.key("widget");
    let open = cx.is_open(&key);
    let title = if title.trim().is_empty() { "Interactive" } else { title };
    let mut head = row().w_full().min_w(0.0).gap(11.0).pl(12.0).pr(8.0).py(10.0).center_y()
        .child(el().size(32.0, 32.0).radius(9.0).continuous_corners().fill(t.accent.alpha(0.14)).center().child(ico_s("sparkle", 17.0, t.accent)))
        .child(col().grow(1.0).min_w(0.0).gap(1.0)
            .child(text(title.to_owned()).font(ui(14.0, 600.0)).color(t.text).truncate())
            .child(text(if closed { "Interactive widget" } else { "Building the widget…" }).font(ui(12.0, 400.0)).color(t.faint)));
    if closed {
        let mut buttons = row().gap(2.0).center_y();
        if cx.open.is_some() {
            let k = key.clone();
            buttons = buttons.child(row().h(28.0).px(9.0).gap(6.0).radius(8.0).continuous_corners().center_y().hover(t.hover)
                .fill(if open { t.active } else { Color::TRANSPARENT }).role("button").label(if open { "Hide code" } else { "Show code" })
                .child(ico_s("code", 15.0, t.dim))
                .child(text(if open { "Hide code" } else { "Show code" }).font(ui(12.5, 500.0)).color(t.dim))
                .on_press(move |s: &mut App| s.toggle_expanded(&k)));
        }
        let copy = body.to_owned();
        buttons = buttons.child(icon_btn(t, "copy", "Copy code").on_press_tx(move |_: &mut App, tx| tx.copy(copy.clone())));
        head = head.child(buttons);
    }
    let mut card = col().w_full().min_w(0.0).radius(16.0).continuous_corners().fill(t.card).border(1.0, t.border).clip_rounded(16.0).child(head);
    if open && closed {
        let spans = rune_kit::syntax::SyntaxTheme::neutral(t.dark).spans(&rune_kit::syntax::highlight(Some("html"), body), 0);
        card = card.child(el().w_full().max_h(320.0).border_sides([1.0, 0.0, 0.0, 0.0], t.border).fill(t.well).scroll_xy()
            .child(el().padding(14.0).child(text(body.to_owned()).font(mono(12.0, 19.0)).color(t.code_ink).spans(spans).selectable(true))));
    }
    card
}

/// A file type's badge: its extension on the kind's colour.
fn badge(ext: &str, w: f32, h: f32) -> El {
    let color = file_kind(ext).map_or("#6b7280", |(_, c)| c);
    let label: String = ext.to_ascii_uppercase().chars().take(4).collect();
    let size = if w < 36.0 { 9.5 } else { 10.5 };
    el().size(w, h).radius(8.0).continuous_corners().fill(hex(color)).center()
        .child(text(label).font(ui(size, 700.0).tracking(0.3)).color(Color::WHITE))
}

/// Links to files on lines of their own: one with words of its own as a big card (badge, name,
/// what it is, Open), others as compact attachment cards side by side. Both open the file in
/// the browser pane.
fn files_el(t: &Theme, files: &[FileLink]) -> El {
    let kind = |f: &FileLink| file_kind(&f.ext).map_or("File", |(n, _)| n);
    let short = |f: &FileLink| if kind(f) == "PDF" { "PDF".to_owned() } else { f.ext.to_ascii_uppercase() };
    if let [f] = files {
        if let Some(label) = &f.label {
            let url = f.url.clone();
            let web = f.url.starts_with("http");
            return row().w_full().max_w(560.0).min_w(0.0).gap(14.0).pl(12.0).pr(16.0).py(12.0).center_y()
                .radius(14.0).continuous_corners().fill(t.card).border(1.0, t.border).hover(t.hover)
                .role("link").label(format!("{} {}", f.name, label)).help(f.url.clone())
                .child(badge(&f.ext, 40.0, 46.0))
                .child(col().grow(1.0).min_w(0.0).gap(2.0)
                    .child(text(f.name.clone()).font(ui(14.5, 600.0)).color(t.text).truncate())
                    .child(text(format!("{} · {label}", short(f))).font(ui(12.5, 400.0)).color(t.faint).truncate()))
                .child(row().gap(4.0).center_y()
                    .child(text(if web { "Download" } else { "Open" }).font(ui(13.0, 550.0)).color(t.accent))
                    .child(ico_s("arrow-up-right", 14.0, t.accent)))
                .on_press(move |s: &mut App| s.browse(&url));
        }
    }
    row().w_full().min_w(0.0).flex_wrap().gap(8.0).children(files.iter().map(|f| {
        let url = f.url.clone();
        row().max_w(300.0).min_w(0.0).shrink().gap(10.0).pl(8.0).pr(14.0).py(8.0).center_y()
            .radius(14.0).continuous_corners().fill(t.card).border(1.0, t.border).hover(t.hover)
            .role("link").label(f.name.clone()).help(f.url.clone())
            .child(badge(&f.ext, 34.0, 34.0))
            .child(col().shrink().min_w(0.0).gap(1.0)
                .child(text(f.name.clone()).font(ui(13.5, 600.0)).color(t.text).truncate())
                .child(text(kind(f)).font(ui(12.0, 400.0)).color(t.faint)))
            .on_press(move |s: &mut App| s.browse(&url))
    }))
}

/// A fenced code block: the language, a copy button, and the code in monospace.
pub fn code_block(t: &Theme, lang: &str, code: &str) -> El {
    let copy = code.to_owned();
    let apply = code.to_owned();
    let spans = {
        let known = (!lang.is_empty()).then_some(lang);
        let found = rune_kit::syntax::highlight(known, code);
        rune_kit::syntax::SyntaxTheme::neutral(t.dark).spans(&found, 0)
    };
    col().w_full().radius(10.0).continuous_corners().fill(t.well).border(1.0, t.card_border).clip_rounded(10.0)
        .child(row().h(32.0).px(12.0).center_y().justify_between().border_sides([0.0, 0.0, 1.0, 0.0], t.card_border)
            .child(text(if lang.is_empty() { "code".to_owned() } else { lang.to_owned() }).font(ui(12.0, 500.0)).color(t.faint))
            .child(row().gap(2.0)
                .child(row().gap(5.0).px(6.0).h(24.0).radius(6.0).continuous_corners().center_y().hover(t.hover).role("button").label("Copy code")
                    .child(crate::icons::ico_s("copy", 14.0, t.faint))
                    .child(text("Copy").font(ui(12.0, 500.0)).color(t.faint))
                    .on_press_tx(move |_: &mut App, tx| tx.copy(copy.clone())))
                // Wisp works it into the file open in Code, as a diff to accept or reject.
                .child(row().gap(5.0).px(6.0).h(24.0).radius(6.0).continuous_corners().center_y().hover(t.hover).role("button").label("Apply to the open file")
                    .child(crate::icons::ico_s("arrow-right", 14.0, t.faint))
                    .child(text("Apply").font(ui(12.0, 500.0)).color(t.faint))
                    .on_press(move |s: &mut App| s.apply_snippet(&apply)))))
        .child(el().w_full().padding(12.0).scroll_x().child(text(code.to_owned()).font(mono(12.5, 19.0)).color(t.code_ink).spans(spans).selectable(true)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_servers_read_as_their_address() {
        use crate::favicon::{get, site_name};
        assert_eq!(site_name("http://127.0.0.1:8080/"), "127.0.0.1:8080");
        assert_eq!(site_name("http://localhost:3000/app"), "localhost:3000");
        assert_eq!(site_name("http://192.168.1.20"), "192.168.1.20");
        assert!(get("http://127.0.0.1:8080/").is_none(), "no favicon lookup for a local server");
    }

    #[test]
    fn links_show_the_site_name() {
        let t = crate::theme::dark();
        let p = inline("open https://www.codeply.app on your phone", &t);
        assert_eq!(p.text, "open Codeply on your phone");
        assert_eq!(p.links, vec![(5..12, "https://www.codeply.app".to_owned())]);
        let p = inline("see [the docs](https://docs.rs/rune) and **this**", &t);
        assert_eq!(p.text, "see the docs and this");
        assert_eq!(p.links[0].0, 4..12);
    }

    #[test]
    fn code_and_snake_case() {
        let t = crate::theme::dark();
        assert_eq!(inline("run `npm test` in my_project_dir", &t).text, "run npm test in my_project_dir");
        assert_eq!(inline("a * b * c and x_y_z", &t).text, "a * b * c and x_y_z");
        assert_eq!(inline("`**not bold**`", &t).text, "**not bold**");
    }

    #[test]
    fn emphasis_strike_and_highlight() {
        let t = crate::theme::dark();
        let p = inline("**bold**, *it*, _it_, ~~gone~~ and ==see==", &t);
        assert_eq!(p.text, "bold, it, it, gone and see");
        assert_eq!(p.strikes, vec![14..18]);
        assert!(p.spans.iter().any(|s| s.start == 0 && s.end == 4 && s.weight == Some(600.0)));
        assert!(p.spans.iter().any(|s| s.start == 23 && s.end == 26 && s.bg.is_some()));
        assert!(p.spans.iter().filter(|s| s.italic).count() == 2);
        // Not closed, or against a space: left as written.
        assert_eq!(inline("a ~~ b ~~ and == c", &t).text, "a ~~ b ~~ and == c");
        assert_eq!(inline("x == y and ~~half", &t).text, "x == y and ~~half");
        // Nesting.
        let p = inline("**bold ~~and struck~~**", &t);
        assert_eq!(p.text, "bold and struck");
        assert_eq!(p.strikes, vec![5..15]);
    }

    #[test]
    fn directives() {
        assert_eq!(directive("kbd"), Some(Directive::Kbd));
        assert_eq!(directive("badge"), Some(Directive::Pill(None)));
        assert_eq!(directive("pill-amber"), Some(Directive::Pill(Some("amber"))));
        assert_eq!(directive("badge-success"), Some(Directive::Pill(Some("green"))));
        assert_eq!(directive("warning"), Some(Directive::Ink("amber")));
        assert_eq!(directive("grey"), Some(Directive::Ink("gray")));
        assert_eq!(directive("violet"), Some(Directive::Ink("purple")));
        assert_eq!(directive("pill-teal"), None);
        assert_eq!(directive("note"), None);
        let t = crate::theme::dark();
        let p = inline("Status :pill-amber[Pending], press :kbd[Ctrl+K], :green[ok] :nope[x]", &t);
        assert_eq!(p.text, "Status Pending, press Ctrl+K, ok :nope[x]");
        assert_eq!(p.pills.len(), 1);
        assert_eq!(p.pills[0].0, 7..14);
        assert_eq!(p.pills[0].2, t.warn);
        assert_eq!(p.rings.len(), 1);
        assert_eq!(p.rings[0].0, 22..28);
        assert!(p.spans.iter().any(|s| s.start == 30 && s.end == 32 && s.color == Some(t.green)));
        // A URL's colon is not a directive.
        assert_eq!(inline("at http://localhost:3000/x", &t).text, "at localhost:3000");
    }

    #[test]
    fn latex_arrows() {
        let t = crate::theme::dark();
        assert_eq!(inline(r"A $\rightarrow$ B \to C, 3 \times 4 \leq 12 \pm 1", &t).text, "A → B → C, 3 × 4 ≤ 12 ± 1");
        assert_eq!(inline(r"\Leftrightarrow \infty", &t).text, "⇔ ∞");
        assert_eq!(inline(r"keep \today and `\to`", &t).text, r"keep \today and \to");
    }

    #[test]
    fn headings_rules_and_quotes() {
        let b = parse("# One\n###### Six ##\n####### seven\n#nope\n\n---\n* * *\n> quoted\n> more");
        assert_eq!(b[0], Block::Heading(1, "One".into()));
        assert_eq!(b[1], Block::Heading(6, "Six".into()));
        assert_eq!(b[2], Block::Para("####### seven\n#nope".into()));
        assert_eq!(b[3], Block::Rule);
        assert_eq!(b[4], Block::Rule);
        assert_eq!(b[5], Block::Quote(vec![Block::Para("quoted\nmore".into())]));
        assert_eq!(parse("## C#")[0], Block::Heading(2, "C#".into()));
    }

    #[test]
    fn callouts() {
        let b = parse("> [!WARNING] Back up first\n> This deletes the table.");
        assert_eq!(b[0], Block::Callout { kind: "warning", title: "Back up first".into(), body: vec![Block::Para("This deletes the table.".into())] });
        let b = parse("> [!tip]\n> Short.");
        assert!(matches!(&b[0], Block::Callout { kind: "tip", title, .. } if title.is_empty()));
        // An unknown kind is a plain quote.
        assert!(matches!(&parse("> [!SHRUG] hm")[0], Block::Quote(_)));
        assert_eq!(callout_kind("CAUTION"), Some("caution"));
        assert_eq!(callout_kind("Success"), Some("success"));
        assert_eq!(callout_kind("hint"), None);
    }

    #[test]
    fn table_alignment() {
        assert_eq!(cell_align(":---"), Some(Align::Start));
        assert_eq!(cell_align(" :---: "), Some(Align::Center));
        assert_eq!(cell_align("---:"), Some(Align::End));
        assert_eq!(cell_align("---"), None);
        assert!(table_sep("| :--- | :---: | ---: |"));
        assert!(table_sep("---|---"));
        assert!(!table_sep("| a | b |"));
        assert!(!table_sep("| --- | b |"));
        let b = parse("| Plan | Seats | Price |\n|:--|:-:|---|\n| Pro | 5 | $20 |\n| Team \\| Max | 50 | $1,200 |");
        let Block::Table(tb) = &b[0] else { panic!("not a table: {b:?}") };
        assert_eq!(tb.head, vec!["Plan", "Seats", "Price"]);
        assert_eq!(tb.align, vec![Some(Align::Start), Some(Align::Center), None]);
        assert_eq!(tb.rows[1], vec!["Team | Max", "50", "$1,200"]);
        assert!(is_numeric("$1,200") && is_numeric("-3.5%") && is_numeric("120 ms") && is_numeric("4x"));
        assert!(!is_numeric("about 5") && !is_numeric("") && !is_numeric("v2"));
        // A header whose separator hasn't arrived is still a paragraph.
        assert!(matches!(&parse("| a | b |\n|")[0], Block::Para(_)));
    }

    #[test]
    fn lists_and_tasks() {
        let b = parse("3. three\n4. four\n   more of four\n   - nested\n     - deeper\n5. five");
        let Block::List { ordered, start, items } = &b[0] else { panic!("{b:?}") };
        assert!(*ordered);
        assert_eq!(*start, 3);
        assert_eq!(items.len(), 3);
        assert_eq!(items[1].text, "four\nmore of four");
        let Block::List { ordered: false, items: sub, .. } = &items[1].sub[0] else { panic!("{:?}", items[1].sub) };
        assert_eq!(sub[0].text, "nested");
        assert!(matches!(&sub[0].sub[0], Block::List { .. }));
        let b = parse("- [ ] todo\n- [x] done\n- [X] also\n- [y] not a task\n- [ ]");
        let Block::List { items, .. } = &b[0] else { panic!() };
        assert_eq!(items.iter().map(|i| i.task).collect::<Vec<_>>(), vec![Some(false), Some(true), Some(true), None, None]);
        assert_eq!(items[1].text, "done");
        // A blank line between items keeps one list.
        assert_eq!(parse("- a\n\n- b").len(), 1);
        // Bold at the start of a line is not a bullet.
        assert!(matches!(&parse("**Note** this")[0], Block::Para(_)));
    }

    #[test]
    fn fences_and_streaming() {
        let b = parse("```doc \"My title\"\n# Hi\n```\n```widget Mixer\n<b>x</b>");
        assert_eq!(b[0], Block::Fence { lang: "doc".into(), info: "My title".into(), body: "# Hi".into(), closed: true });
        assert_eq!(b[1], Block::Fence { lang: "widget".into(), info: "Mixer".into(), body: "<b>x</b>".into(), closed: false });
        // A longer fence holds a shorter one.
        let b = parse("````md\n```js\nx\n```\n````");
        assert!(matches!(&b[0], Block::Fence { body, closed: true, .. } if body == "```js\nx\n```"));
        // Half-written replies never panic.
        let t = crate::theme::dark();
        for src in ["```", "```rust\nfn", "| a |\n|--", "- [", "> [!", ":pill-[", "**", "~~x", "1.", "#", "\\", "$\\", "[a](", "*a", "````\n```"] {
            let _ = render(src, &t, true);
            let _ = parse(src);
        }
    }

    #[test]
    fn file_cards() {
        let f = file_link("[Q3 report, 12 pages](https://example.com/files/q3-report.pdf)").unwrap();
        assert_eq!((f.name.as_str(), f.ext.as_str(), f.label.as_deref()), ("q3-report.pdf", "pdf", Some("Q3 report, 12 pages")));
        let f = file_link("/home/sam/Desktop/budget plan.xlsx").unwrap();
        assert_eq!(f.url, "file:///home/sam/Desktop/budget%20plan.xlsx");
        assert_eq!(f.label, None);
        let f = file_link(r"`C:\Users\sam\notes.docx`").unwrap();
        assert_eq!(f.url, "file:///C:/Users/sam/notes.docx");
        assert_eq!(file_link("[notes.md](file:///tmp/notes.md)").unwrap().label, None);
        assert!(file_link("https://example.com/page.html").is_none());
        assert!(file_link("see /home/sam/a.pdf").is_none());
        assert!(file_link("relative/a.pdf").is_none());
        assert!(matches!(&parse("Here it is:\n\n[Report](https://x.io/r.pdf)\n/tmp/a.png\n/tmp/b.csv")[1], Block::Files(f) if f.len() == 3));
    }
}
