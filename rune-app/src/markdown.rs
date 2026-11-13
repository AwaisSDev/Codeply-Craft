//! Replies as the Electron app draws them: Markdown (headings, lists, quotes, code blocks,
//! **bold**, *italic*, `code`), and links as the site's icon and name ("Codeply" with its
//! favicon, not the raw URL). Clicking a link opens it in the built-in browser.
//!
//! While a reply streams in, its words fade in from grey to white as they arrive (Rune's
//! streaming reveal), the Electron app's text animation.

use rune::{Color, El, InlineIcon, Link, LinkPaint, Span, col, el, rich, row, text};

use crate::app::App;
use crate::favicon;
use crate::theme::{self, Theme, mono, ui};

/// How long each arriving word takes to fade in, in seconds.
pub const WORD_FADE: f32 = 0.45;

/// One line of inline Markdown, flattened: the text, its styled runs, and its links
/// (byte range, URL).
#[derive(Debug, Default, PartialEq)]
pub struct Inline {
    pub text: String,
    pub spans: Vec<Span>,
    pub links: Vec<(std::ops::Range<usize>, String)>,
}

/// Parses `**bold**`, `*italic*` / `_italic_`, `` `code` ``, `[label](url)` and bare URLs.
pub fn inline(src: &str, t: &Theme) -> Inline {
    let mut out = Inline::default();
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0;
    let at = |i: usize, s: &str| -> bool {
        let pat: Vec<char> = s.chars().collect();
        chars.len() >= i + pat.len() && chars[i..i + pat.len()] == pat[..]
    };
    let find = |from: usize, s: &str| -> Option<usize> {
        let pat: Vec<char> = s.chars().collect();
        (from..chars.len()).find(|&k| chars.len() >= k + pat.len() && chars[k..k + pat.len()] == pat[..])
    };
    let collect = |a: usize, b: usize| chars[a..b].iter().collect::<String>();
    while i < chars.len() {
        // **bold**
        if at(i, "**") {
            if let Some(end) = find(i + 2, "**").filter(|&e| e > i + 2) {
                let start = out.text.len();
                let inner = inline(&collect(i + 2, end), t);
                append(&mut out, inner);
                out.spans.push(Span::new(start, out.text.len()).weight(600.0).color(t.text));
                i = end + 2;
                continue;
            }
        }
        // `code`
        if chars[i] == '`' {
            if let Some(end) = find(i + 1, "`").filter(|&e| e > i + 1) {
                let start = out.text.len();
                out.text.push_str(&collect(i + 1, end));
                out.spans.push(Span::new(start, out.text.len()).mono().bg(theme::hex("#2a2a2a"), 3.0).color(theme::hex("#e6e6e6")));
                i = end + 1;
                continue;
            }
        }
        // *italic* or _italic_ (not inside a word, so snake_case stays as it is)
        if (chars[i] == '*' || chars[i] == '_') && (i == 0 || !chars[i - 1].is_alphanumeric()) && chars.get(i + 1).is_some_and(|c| !c.is_whitespace()) {
            let mark = chars[i].to_string();
            if let Some(end) = find(i + 1, &mark).filter(|&e| e > i + 1 && !chars.get(e + 1).is_some_and(|c| c.is_alphanumeric())) {
                let start = out.text.len();
                out.text.push_str(&collect(i + 1, end));
                out.spans.push(Span::new(start, out.text.len()).italic());
                i = end + 1;
                continue;
            }
        }
        // [label](url)
        if chars[i] == '[' {
            if let Some(close) = find(i + 1, "](") {
                if let Some(end) = find(close + 2, ")") {
                    let label = collect(i + 1, close);
                    let url = collect(close + 2, end);
                    if favicon::host(&url).is_some() || url.starts_with("file:") {
                        push_link(&mut out, &label, &url, t);
                        i = end + 1;
                        continue;
                    }
                }
            }
        }
        // A bare URL: shown as the site's name.
        if at(i, "https://") || at(i, "http://") {
            let mut end = i;
            while end < chars.len() && !chars[end].is_whitespace() && !matches!(chars[end], ')' | '>' | '"' | '\'') {
                end += 1;
            }
            // Sentence punctuation after a URL isn't part of it.
            while end > i && matches!(chars[end - 1], '.' | ',' | ';' | ':' | '!' | '?') {
                end -= 1;
            }
            let url = collect(i, end);
            if favicon::host(&url).is_some() {
                push_link(&mut out, &favicon::site_name(&url), &url, t);
                i = end;
                continue;
            }
        }
        out.text.push(chars[i]);
        i += 1;
    }
    out
}

fn append(out: &mut Inline, inner: Inline) {
    let base = out.text.len();
    out.text.push_str(&inner.text);
    out.spans.extend(inner.spans.into_iter().map(|mut s| {
        s.start += base as u32;
        s.end += base as u32;
        s
    }));
    out.links.extend(inner.links.into_iter().map(|(r, u)| (r.start + base..r.end + base, u)));
}

fn push_link(out: &mut Inline, label: &str, url: &str, t: &Theme) {
    let start = out.text.len();
    out.text.push_str(label);
    let end = out.text.len();
    // A soft chip around the name, as the Electron app draws a link.
    out.spans.push(Span::new(start, end).weight(500.0).color(t.text).bg(theme::hex("#2a2a2a"), 4.0));
    out.links.push((start..end, url.to_owned()));
}

/// One paragraph (or list item, heading, quote line) as a text element: styled runs, links
/// that open in the browser, each link's site icon before it, and the streaming fade.
pub fn paragraph(src: &str, t: &Theme, size: f32, weight: f32, color: Color, streaming: bool) -> El {
    let p = inline(src, t);
    let mut e = rich(p.text.clone(), p.spans).font(ui(size, weight).lh((size * 1.55).round())).color(color).wrap().selectable(true);
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

/// A whole reply. `streaming`: it is still arriving, so new words fade in.
pub fn render(src: &str, t: &Theme, streaming: bool) -> El {
    let size = 14.5;
    let mut out = col().w_full().min_w(0.0).gap(10.0);
    let mut para: Vec<&str> = Vec::new();
    let mut lines = src.lines().peekable();
    let flush = |out: El, para: &mut Vec<&str>| -> El {
        if para.is_empty() {
            return out;
        }
        let joined = para.join("\n");
        para.clear();
        out.child(paragraph(&joined, t, size, 400.0, t.text, streaming))
    };
    while let Some(line) = lines.next() {
        let trimmed = line.trim_start();
        // ``` code blocks
        if let Some(lang) = trimmed.strip_prefix("```") {
            out = flush(out, &mut para);
            let mut code = Vec::new();
            for l in lines.by_ref() {
                if l.trim_start().starts_with("```") {
                    break;
                }
                code.push(l);
            }
            out = out.child(code_block(t, lang.trim(), &code.join("\n")));
            continue;
        }
        if trimmed.is_empty() {
            out = flush(out, &mut para);
            continue;
        }
        if trimmed == "---" || trimmed == "***" {
            out = flush(out, &mut para);
            out = out.child(el().w_full().h(1.0).my(4.0).fill(t.border));
            continue;
        }
        let heading = [("### ", 15.0, 600.0), ("## ", 17.0, 650.0), ("# ", 20.0, 650.0)].into_iter().find(|(m, _, _)| trimmed.starts_with(m));
        if let Some((mark, sz, w)) = heading {
            out = flush(out, &mut para);
            out = out.child(paragraph(&trimmed[mark.len()..], t, sz, w, t.text, streaming).mt(4.0));
            continue;
        }
        if let Some(q) = trimmed.strip_prefix("> ") {
            out = flush(out, &mut para);
            out = out.child(row().w_full().pl(12.0).border_sides([0.0, 0.0, 0.0, 3.0], t.control_border).child(paragraph(q, t, size, 400.0, t.dim, streaming).grow(1.0).min_w(0.0)));
            continue;
        }
        let bullet = ["- ", "* ", "• "].into_iter().find(|m| trimmed.starts_with(m)).map(|m| ("•".to_owned(), &trimmed[m.len()..]));
        let number = trimmed.split_once(". ").filter(|(n, _)| !n.is_empty() && n.len() <= 3 && n.chars().all(|c| c.is_ascii_digit())).map(|(n, rest)| (format!("{n}."), rest));
        if let Some((mark, rest)) = bullet.or(number) {
            out = flush(out, &mut para);
            let indent = (line.len() - trimmed.len()).min(8) as f32 * 6.0;
            out = out.child(row().w_full().gap(8.0).pl(4.0 + indent).items_start()
                .child(text(mark).font(ui(size, 400.0).lh((size * 1.55).round())).color(t.faint).min_w(14.0))
                .child(paragraph(rest, t, size, 400.0, t.text, streaming).grow(1.0).min_w(0.0)));
            continue;
        }
        para.push(line);
    }
    flush(out, &mut para)
}

/// A fenced code block: the language, a copy button, and the code in monospace.
pub fn code_block(t: &Theme, lang: &str, code: &str) -> El {
    let copy = code.to_owned();
    col().w_full().radius(10.0).fill(theme::hex("#161616")).border(1.0, t.card_border).clip_rounded(10.0)
        .child(row().h(32.0).px(12.0).center_y().justify_between().border_sides([0.0, 0.0, 1.0, 0.0], t.card_border)
            .child(text(if lang.is_empty() { "code".to_owned() } else { lang.to_owned() }).font(ui(12.0, 500.0)).color(t.faint))
            .child(row().gap(5.0).px(6.0).h(24.0).radius(6.0).center_y().hover(t.hover).role("button").label("Copy code")
                .child(crate::icons::ico_s("file", 14.0, t.faint))
                .child(text("Copy").font(ui(12.0, 500.0)).color(t.faint))
                .on_press_tx(move |_: &mut App, tx| tx.copy(copy.clone()))))
        .child(el().w_full().padding(12.0).scroll_x().child(text(code.to_owned()).font(mono(12.5, 19.0)).color(theme::hex("#d4d4d4")).selectable(true)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_show_the_site_name() {
        let t = theme::dark();
        let p = inline("open https://www.codeply.app on your phone", &t);
        assert_eq!(p.text, "open Codeply on your phone");
        assert_eq!(p.links, vec![(5..12, "https://www.codeply.app".to_owned())]);
        let p = inline("see [the docs](https://docs.rs/rune) and **this**", &t);
        assert_eq!(p.text, "see the docs and this");
        assert_eq!(p.links[0].0, 4..12);
    }

    #[test]
    fn code_and_snake_case() {
        let t = theme::dark();
        assert_eq!(inline("run `npm test` in my_project_dir", &t).text, "run npm test in my_project_dir");
    }
}
