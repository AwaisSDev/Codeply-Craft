//! Code: the project's file tree, the open file in an editable editor with Wisp's ghost
//! suggestion, the terminal pane, and "Wisp in the editor" (its morphing mascot, its review).

use rune::{Align, Color, El, ScrollSpec, col, el, row, text, text_input};

use crate::app::{App, EditKey};
use crate::bot;
use crate::icons::ico_s;
use crate::model::{ButtonKind, Shape};
use crate::store::Target;
use crate::theme::{Theme, mono, ui};
use crate::ui::{btn, card, composer, enter, fade_in, ibtn, me, wave, ENTER};
use crate::views::agents::awake;

const LINE: f32 = 19.0;

// ---------- sidebar ----------

pub fn side(s: &App, t: &Theme) -> El {
    let code = &s.data.extra.code;
    let mut rows: Vec<El> = Vec::new();
    for path in &code.files {
        let is_dir = path.ends_with('/');
        let parts: Vec<&str> = path.trim_end_matches('/').split('/').collect();
        let depth = parts.len().saturating_sub(1);
        // Hidden when any ancestor folder is collapsed (`s.expanded` holds the collapsed ones).
        let hidden = (1..=depth).any(|i| s.expanded.contains(&format!("dir/{}/", parts[..i].join("/"))));
        if hidden {
            continue;
        }
        let name = parts.last().copied().unwrap_or("").to_owned();
        let indent = 8.0 + depth as f32 * 16.0;
        if is_dir {
            let collapsed = s.expanded.contains(&format!("dir/{path}"));
            let key = format!("dir/{path}");
            let k = key.clone();
            rows.push(
                row().key(key).min_h(28.0).py(3.0).pr(8.0).pl(indent).gap(6.0).radius(10.0).center_y().hover(t.hover)
                    .role("button").label(name.clone())
                    .child(ico_s(if collapsed { "chevron-right" } else { "chevron-down" }, 16.0, t.faint))
                    .child(ico_s(if collapsed { "folder" } else { "folder-open" }, 16.0, t.faint))
                    .child(text(name).font(ui(13.5, 400.0)).color(t.text).grow(1.0).truncate())
                    .on_press(move |s: &mut App| s.toggle_expanded(&k)),
            );
        } else {
            let on = code.open.as_deref() == Some(path.as_str());
            let p = path.clone();
            rows.push(
                row().key(format!("file/{path}")).min_h(28.0).py(3.0).pr(8.0).pl(indent + 22.0).gap(6.0).radius(10.0).center_y().hover(t.hover)
                    .fill(if on { t.active } else { Color::TRANSPARENT })
                    .role("button").label(name.clone())
                    .child(ico_s("file", 16.0, if on { t.text } else { t.faint }))
                    .child(text(name).font(ui(13.5, if on { 500.0 } else { 400.0 })).color(t.text).grow(1.0).truncate())
                    .on_press(move |s: &mut App| s.open_file(&p)),
            );
        }
    }
    let reload = code.open.clone();
    col().h_full().min_h(0.0)
        .child(row().pt(14.0).pr(12.0).pb(8.0).pl(16.0).center_y().justify_between()
            .child(text(s.data.project.clone()).font(ui(15.0, 650.0)).color(t.text).truncate().grow(1.0))
            .child(ibtn(t, "refresh", "Refresh").key("code-refresh").on_press(move |s: &mut App| {
                if let Some(p) = &reload {
                    s.open_file(p);
                }
            })))
        .child(col().grow(1.0).min_h(0.0).px(8.0).scroll(ScrollSpec { stick_bottom: false })
            .children(rows.into_iter().enumerate().map(|(i, e)| enter(e, i.min(12)))))
        .child(me(s, t))
}

// ---------- main ----------

pub fn main(s: &App, t: &Theme) -> El {
    let mut left = col().grow(1.0).min_w(0.0).h_full().border_sides([0.0, 1.0, 0.0, 0.0], t.border)
        .child(tab_bar(s, t))
        .child(breadcrumb(s, t))
        .child(editor(s, t));
    if s.panes.terminal {
        left = left.child(col().h(240.0).min_h(0.0).child(crate::views::terminal::pane(s, t)));
    }
    row().key("ide").w_full().h_full().transition(fade_in()).motion(ENTER)
        .child(left)
        .child(wisp_panel(s, t))
}

fn tab_bar(s: &App, t: &Theme) -> El {
    let code = &s.data.extra.code;
    let name = code.open.as_deref().map(|p| p.rsplit('/').next().unwrap_or(p).to_owned());
    let mut bar = row().h(38.0).px(14.0).gap(8.0).center_y().fill(t.rail).border_sides([0.0, 0.0, 1.0, 0.0], t.border);
    if let Some(name) = name {
        bar = bar
            .child(ico_s("file", 16.0, t.text))
            .child(text(name).font(ui(13.0, 500.0)).color(t.text))
            .children(s.code_dirty().then(|| el().size(8.0, 8.0).radius(4.0).fill(t.warn)));
    }
    bar = bar.child(el().grow(1.0));
    if code.open.is_some() {
        bar = bar
            .child(btn(t, "Edit with Wisp", Some("sparkle"), ButtonKind::Plain).key("code-edit-with-wisp").help("Ctrl K")
                .on_press_tx(|s: &mut App, tx| s.toggle_code_ask(tx)))
            .child(btn(t, "Save", None, ButtonKind::Plain).key("code-save").on_press(|s: &mut App| s.save_file()))
            .child(if code.reviewing {
                row().key("code-review").h(32.0).px(12.0).center_y().child(wave("Reviewing", ui(13.0, 500.0), t.dim))
            } else {
                btn(t, "Review", Some("check"), ButtonKind::Plain).key("code-review").on_press(|s: &mut App| s.review_file())
            });
    }
    bar
}

fn breadcrumb(s: &App, t: &Theme) -> El {
    let mut r = row().h(30.0).px(16.0).gap(6.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.border);
    if let Some(path) = &s.data.extra.code.open {
        let parts: Vec<&str> = path.split('/').collect();
        let last = parts.len().saturating_sub(1);
        for (i, part) in parts.iter().enumerate() {
            if i > 0 {
                r = r.child(ico_s("chevron-right", 12.0, t.faint));
            }
            r = r.child(text((*part).to_owned()).font(ui(12.5, if i == last { 500.0 } else { 400.0 })).color(if i == last { t.text } else { t.faint }));
        }
    }
    r
}

fn sev_color(t: &Theme, severity: &str) -> Color {
    match severity {
        "error" => t.red,
        "warning" => t.warn,
        _ => t.accent,
    }
}

/// The open file's syntax colours, as spans over `code` starting at `offset`.
fn syntax(t: &Theme, path: &str, code: &str, offset: usize) -> Vec<rune::Span> {
    let lang = rune_kit::syntax::lang_for_path(path);
    let found = rune_kit::syntax::highlight(lang, code);
    rune_kit::syntax::SyntaxTheme::neutral(t.dark).spans(&found, offset)
}

/// Lines of `before` and `after` as a diff: ('-' removed, '+' added, ' ' kept), each with its
/// text and its line number in the file it belongs to. Common lines at both ends are matched
/// directly; the middle by longest common subsequence (or all removed then added, when big).
pub fn line_diff<'a>(before: &'a str, after: &'a str) -> Vec<(char, &'a str, usize)> {
    let a: Vec<&str> = before.split('\n').collect();
    let b: Vec<&str> = after.split('\n').collect();
    let mut head = 0;
    while head < a.len() && head < b.len() && a[head] == b[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < a.len() - head && tail < b.len() - head && a[a.len() - 1 - tail] == b[b.len() - 1 - tail] {
        tail += 1;
    }
    let (am, bm) = (&a[head..a.len() - tail], &b[head..b.len() - tail]);
    let mut out: Vec<(char, &str, usize)> = a[..head].iter().enumerate().map(|(i, l)| (' ', *l, i + 1)).collect();
    if am.len() * bm.len() <= 4_000_000 {
        let (n, m) = (am.len(), bm.len());
        let mut lcs = vec![0u32; (n + 1) * (m + 1)];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                lcs[i * (m + 1) + j] = if am[i] == bm[j] { lcs[(i + 1) * (m + 1) + j + 1] + 1 } else { lcs[(i + 1) * (m + 1) + j].max(lcs[i * (m + 1) + j + 1]) };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n || j < m {
            if i < n && j < m && am[i] == bm[j] {
                out.push((' ', bm[j], head + j + 1));
                i += 1;
                j += 1;
            } else if i < n && (j == m || lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) {
                // Removed before added, as a diff reads.
                out.push(('-', am[i], head + i + 1));
                i += 1;
            } else {
                out.push(('+', bm[j], head + j + 1));
                j += 1;
            }
        }
    } else {
        out.extend(am.iter().enumerate().map(|(i, l)| ('-', *l, head + i + 1)));
        out.extend(bm.iter().enumerate().map(|(j, l)| ('+', *l, head + j + 1)));
    }
    out.extend(b[b.len() - tail..].iter().enumerate().map(|(k, l)| (' ', *l, b.len() - tail + k + 1)));
    out
}

/// "Edit with Wisp" (Ctrl K) over the editor: what to change, Enter sends it.
fn ask_bar(s: &App, t: &Theme) -> El {
    let field = text_input(s.edit(EditKey::CodeAsk), ui(13.5, 400.0)).key("code-ask").single_line().grow(1.0).min_w(0.0).color(t.text)
        .placeholder("Edit with Wisp: what should change? Enter to send, Esc to close", t.faint).caret(t.accent, t.accent.alpha(0.3)).label("Edit with Wisp")
        .on_edit(|s: &mut App| s.edit_mut(EditKey::CodeAsk))
        .on_submit(|s: &mut App, _| s.submit_code_ask());
    row().key("code-ask-bar").mx(16.0).mt(10.0).px(12.0).h(40.0).gap(10.0).radius(10.0).center_y().clip_rounded(10.0)
        .fill(t.composer).border(1.0, t.accent.alpha(0.5)).shadow(6.0, 18.0, crate::theme::rgba(0, 0, 0, 0.3))
        .transition(fade_in()).motion(ENTER)
        .child(ico_s("sparkle", 15.0, t.accent))
        .child(field)
        .child(row().h(20.0).px(6.0).radius(5.0).center_y().fill(t.active).child(text("Ctrl K").font(ui(11.0, 600.0)).color(t.dim)))
}

/// The pending edit's card: what you asked, and Accept or Reject once Wisp's change is in.
fn proposal_bar(t: &Theme, p: &crate::model::Proposal) -> El {
    let keycap = |k: &str| row().h(18.0).px(5.0).radius(4.0).center_y().fill(crate::theme::rgba(255, 255, 255, 0.16)).child(text(k.to_owned()).font(ui(10.5, 600.0)).color(Color::WHITE));
    let mut bar = row().key("code-proposal").mx(16.0).mt(10.0).px(14.0).py(10.0).gap(10.0).radius(10.0).center_y()
        .fill(t.composer).border(1.0, t.composer_border).transition(fade_in()).motion(ENTER)
        .child(col().grow(1.0).min_w(0.0).gap(3.0)
            .child(text(p.instruction.clone()).font(ui(13.5, 500.0)).color(t.text).wrap())
            .children((!p.error.is_empty()).then(|| text(p.error.clone()).font(ui(12.5, 400.0)).color(t.red).wrap())));
    if p.after.is_none() && p.error.is_empty() {
        bar = bar.child(wave("Wisp is editing", ui(13.0, 400.0), t.dim))
            .child(btn(t, "Stop", None, ButtonKind::Plain).key("code-proposal-stop").on_press(|s: &mut App| { s.reject_proposal(); }));
    } else if p.after.is_some() {
        bar = bar
            .child(row().key("code-accept").h(28.0).px(10.0).gap(6.0).radius(7.0).center_y().fill(t.accent).role("button").label("Accept")
                .child(keycap("Ctrl \u{21b5}")).child(text("Accept").font(ui(12.5, 600.0)).color(Color::WHITE))
                .on_press(|s: &mut App| { s.accept_proposal(); }))
            .child(row().key("code-reject").h(28.0).px(10.0).gap(6.0).radius(7.0).center_y().fill(t.control).border(1.0, t.control_border).role("button").label("Reject")
                .child(text("Esc").font(ui(10.5, 600.0)).color(t.faint)).child(text("Reject").font(ui(12.5, 500.0)).color(t.text))
                .on_press(|s: &mut App| { s.reject_proposal(); }));
    } else {
        bar = bar.child(btn(t, "Close", None, ButtonKind::Plain).key("code-proposal-close").on_press(|s: &mut App| { s.reject_proposal(); }));
    }
    bar
}

/// Wisp's change as the editor shows it before you take it: removed lines red, added green,
/// both in the file's syntax colours.
fn diff_view(t: &Theme, path: &str, before: &str, after: &str) -> El {
    let rows = line_diff(before, after).into_iter().map(|(kind, line, n)| {
        let (bg, mark, ink) = match kind {
            '+' => (t.green.alpha(0.16), "+", t.green),
            '-' => (t.red.alpha(0.16), "\u{2212}", t.red),
            _ => (Color::TRANSPARENT, "", t.faint),
        };
        row().w_full().h(LINE).center_y().fill(bg)
            .child(text(if kind == '-' { String::new() } else { n.to_string() }).font(mono(12.5, LINE)).color(t.faint).w(34.0).align(Align::End).pr(6.0))
            .child(text(mark).font(mono(12.5, LINE)).color(ink).w(14.0))
            .child(text(line.to_owned()).font(mono(13.0, LINE)).color(t.text).spans(syntax(t, path, line, 0)).single_line().selectable(true))
    });
    col().key("code-diff").grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false })
        .child(col().w_full().py(10.0).pr(16.0).children(rows))
}

fn editor(s: &App, t: &Theme) -> El {
    let code = &s.data.extra.code;
    let Some(open) = code.open.clone() else {
        return col().grow(1.0).min_h(0.0).center().gap(8.0)
            .child(ico_s("file", 24.0, t.faint))
            .child(text("Open a file from the left").font(ui(14.0, 400.0)).color(t.faint));
    };
    let proposal = code.proposal.as_ref().filter(|p| p.file == open);
    let bars = col().w_full()
        .children(s.code_ask.then(|| ask_bar(s, t)))
        .children(proposal.map(|p| proposal_bar(t, p)));
    // Wisp's change, before you take it: the diff in place of the editor.
    if let Some((p, after)) = proposal.and_then(|p| p.after.as_ref().map(|a| (p, a))) {
        return col().grow(1.0).min_h(0.0).child(bars).child(diff_view(t, &open, &p.before, after));
    }

    let edit = s.edit(EditKey::Code);
    let lines = edit.text.split('\n').count().max(1);
    let gutter = col().w(44.0).children((1..=lines).map(|n| {
        let dot = code.review.iter().find(|r| r.line as usize == n).map(|r| sev_color(t, &r.severity));
        row().h(LINE).center_y()
            .child(el().w(14.0).h(LINE).center().children(dot.map(|c| el().size(6.0, 6.0).radius(3.0).fill(c))))
            .child(text(n.to_string()).font(mono(12.5, LINE)).color(t.faint).grow(1.0).pr(10.0).align(Align::End))
    }));
    let style = mono(13.0, LINE);
    let field = text_input(edit, style).key("code-editor").grow(1.0).min_w(0.0).color(t.text)
        .spans(syntax(t, &open, &edit.text, 0))
        .caret(t.accent, t.accent.alpha(0.3)).label("Code editor")
        .on_edit(|s: &mut App| s.edit_mut(EditKey::Code));

    // Wisp's suggestion, in grey right after the caret when the caret ends its line (Tab takes it).
    let (_, caret) = edit.range();
    let ghost = code.suggestion.as_ref().filter(|(f, at, _)| *f == open && *at == caret && edit.text.is_char_boundary(caret)).and_then(|(_, _, sug)| {
        let line_start = edit.text[..caret].rfind('\n').map_or(0, |i| i + 1);
        let rest = edit.text[caret..].split('\n').next().unwrap_or("");
        if !rest.trim().is_empty() {
            return None;
        }
        let row_i = edit.text[..line_start].matches('\n').count();
        let x = rune::text::advance(&edit.text[line_start..caret], style);
        let first = sug.split('\n').next().unwrap_or("").to_owned();
        let more = sug.matches('\n').count();
        Some(row().key("code-ghost").gap(8.0).center_y().absolute(x, row_i as f32 * LINE).h(LINE).inert()
            .child(text(first).font(style).color(t.faint.alpha(0.75)).single_line())
            .children((more > 0).then(|| text(format!("+{more} lines")).font(ui(11.0, 500.0)).color(t.faint)))
            .child(row().h(16.0).px(5.0).radius(4.0).center_y().fill(t.active).border(1.0, t.control_border)
                .child(text("Tab").font(ui(10.5, 600.0)).color(t.dim))))
    });
    let body = col().grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false })
        .child(row().py(10.0).items_start().child(gutter)
            .child(el().grow(1.0).min_w(0.0).pr(16.0).child(field.w_full()).children(ghost)));
    col().grow(1.0).min_h(0.0).child(bars).child(body)
}

#[cfg(test)]
mod diff_tests {
    use super::line_diff;

    #[test]
    fn a_changed_line_reads_removed_then_added() {
        let d = line_diff("a\nb\nc", "a\nB\nc\nd");
        assert_eq!(d, [(' ', "a", 1), ('-', "b", 2), ('+', "B", 2), (' ', "c", 3), ('+', "d", 4)]);
        assert!(line_diff("same\n", "same\n").iter().all(|(k, _, _)| *k == ' '));
    }
}

// ---------- Wisp panel ----------

fn wisp_panel(s: &App, t: &Theme) -> El {
    let code = &s.data.extra.code;
    let mut panel = col().w(320.0).h_full().fill(t.side).border_sides([0.0, 1.0, 0.0, 0.0], t.border);

    let (shape, status, active) = match code.wisp.as_str() {
        "writing" => (Shape::Round, "Writing with you".to_owned(), true),
        "thinking" => (Shape::Cloud, "Thinking of a completion".to_owned(), true),
        "reviewing" => {
            let name = code.open.as_deref().map(|p| p.rsplit('/').next().unwrap_or(p)).unwrap_or("this file");
            (Shape::Square, format!("Reviewing {name}"), true)
        }
        "fixing" => (Shape::Triangle, "Fixing that line".to_owned(), true),
        _ => (Shape::Hex, "Watching your code".to_owned(), false),
    };
    let mascot = s.data.agent("wisp").map(|a| {
        let mut a = awake(a);
        a.look.shape = shape;
        // One key per shape, so a change of shape mounts a new mascot that fades in.
        el().key(format!("wisp-mascot/{shape:?}")).transition(fade_in()).motion(ENTER).child(bot::agent(&a, 64.0))
    });
    let status_line = if active {
        wave(&status, ui(13.5, 500.0), t.text)
    } else {
        row().child(text(status).font(ui(13.5, 500.0)).color(t.dim))
    };
    panel = panel.child(
        col().items_center().gap(10.0).pt(22.0).pb(16.0).border_sides([0.0, 0.0, 1.0, 0.0], t.border)
            .children(mascot)
            .child(status_line)
            .child(text("Wisp in the editor").font(ui(12.0, 400.0)).color(t.faint)),
    );

    let mut list = col().grow(1.0).min_h(0.0).px(14.0).py(12.0).gap(10.0).scroll(ScrollSpec { stick_bottom: false })
        .child(text("Review").font(ui(12.5, 600.0)).color(t.faint));
    if code.review.is_empty() {
        list = list.child(text("No issues. Press Review to have Wisp check this file.").font(ui(13.0, 400.0)).color(t.faint).wrap());
    }
    for (i, n) in code.review.iter().enumerate() {
        let c = sev_color(t, &n.severity);
        let line = n.line;
        let mut c_card = card(t).gap(8.0).padding(12.0)
            .child(row().gap(8.0).center_y()
                .child(row().h(22.0).px(8.0).radius(11.0).center_y().fill(c.alpha(0.14))
                    .child(text(n.severity.clone()).font(ui(12.0, 600.0)).color(c)))
                .child(text(format!("Line {line}")).font(ui(12.5, 500.0)).color(t.dim)))
            .child(text(n.message.clone()).font(ui(13.0, 400.0)).color(t.text).wrap());
        if let Some(fix) = &n.fix {
            c_card = c_card
                .child(el().px(8.0).py(6.0).radius(8.0).fill(t.solid)
                    .child(text(fix.clone()).font(mono(12.0, 18.0)).color(t.text).wrap()))
                .child(row().child(btn(t, "Apply", Some("check"), ButtonKind::Green).key(format!("fix/{line}"))
                    .on_press(move |s: &mut App| s.apply_fix(line))));
        }
        list = list.child(enter(c_card.key(format!("note/{line}")), i.min(8)));
    }
    panel = panel.child(list);

    panel.child(col().px(12.0).pt(10.0).pb(12.0).border_sides([1.0, 0.0, 0.0, 0.0], t.border)
        .child(composer(s, t, EditKey::AgentThread, Target::Wisp, "Ask Wisp about this file", false, true)))
}
