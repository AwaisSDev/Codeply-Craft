//! Pull requests, Codex-style: a sidebar of open and merged PRs, and a page with Summary and
//! Changes tabs.

use rune::{Color, El, ScrollSpec, col, el, row, text};

use crate::app::{App, PrTab};
use crate::bot;
use crate::icons::ico_s;
use crate::markdown;
use crate::model::{ButtonKind, Pr, PrState};
use crate::theme::{self, Theme, mono, tabular, ui};
use crate::ui::{btn, card, enter, fade_in, me, side_head, side_row, ENTER};

fn pr_row(s: &App, t: &Theme, p: &Pr) -> El {
    let n = p.number;
    let ink = match p.state {
        PrState::Open => t.green,
        PrState::Draft => t.dim,
        PrState::Merged => t.purple,
    };
    side_row(t, n == s.pr).key(format!("pr/{n}")).role("button").label(p.title.clone())
        .child(ico_s("branch", 16.0, ink))
        .child(col().grow(1.0).min_w(0.0)
            .child(text(p.title.clone()).font(ui(14.0, 400.0)).color(t.text).truncate())
            .child(text(if p.local { format!("{} · {}", p.branch, p.age) } else { format!("#{n} · {}", p.age) }).font(ui(12.0, 400.0)).color(t.faint).truncate()))
        .on_press(move |s: &mut App| s.open_pr(n, PrTab::Summary))
}

fn section(t: &Theme, title: &str) -> El {
    row().px(8.0).pt(14.0).pb(6.0).child(text(title.to_owned()).font(ui(12.5, 600.0)).color(t.faint))
}

pub fn side(s: &App, t: &Theme) -> El {
    let mine: Vec<&Pr> = s.data.prs.iter().filter(|p| p.local).collect();
    let open: Vec<&Pr> = s.data.prs.iter().filter(|p| !p.local && p.state != PrState::Merged).collect();
    let merged: Vec<&Pr> = s.data.prs.iter().filter(|p| p.state == PrState::Merged).collect();
    let mut list = col().px(8.0).pb(10.0);
    let mut i = 0;
    if !s.data.extra.prs_note.is_empty() {
        list = list.child(row().px(8.0).pt(10.0).gap(8.0).items_start()
            .child(ico_s("help", 15.0, t.faint))
            .child(text(s.data.extra.prs_note.clone()).font(ui(12.5, 400.0)).color(t.faint).wrap().grow(1.0).min_w(0.0)));
    }
    if !mine.is_empty() {
        list = list.child(section(t, "This branch"));
        for p in &mine {
            list = list.child(enter(pr_row(s, t, p), i));
            i += 1;
        }
    }
    if !open.is_empty() {
        list = list.child(section(t, "Open"));
        for p in &open {
            list = list.child(enter(pr_row(s, t, p), i));
            i += 1;
        }
    }
    if !merged.is_empty() {
        list = list.child(section(t, "Merged"));
        for p in &merged {
            list = list.child(enter(pr_row(s, t, p), i));
            i += 1;
        }
    }
    col().h_full().min_h(0.0)
        .child(side_head(t, "Pull requests", None))
        .child(col().grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(list))
        .child(me(s, t))
}

/// A small state chip: a branch icon and the state's name.
fn state_chip(t: &Theme, state: PrState) -> El {
    let (label, ink) = match state {
        PrState::Open => ("Open", t.green),
        PrState::Draft => ("Draft", t.dim),
        PrState::Merged => ("Merged", t.purple),
    };
    let bg = if state == PrState::Draft { t.hover } else { ink.alpha(0.14) };
    row().key("pr-state").h(24.0).px(9.0).gap(5.0).radius(12.0).center_y().fill(bg)
        .child(ico_s("branch", 14.0, ink))
        .child(text(label).font(ui(12.5, 600.0)).color(ink))
}

/// Made-up but plausible hunks, keyed off the PR number: (path, lines), each line a marker
/// (`+`, `-` or a space) and its code.
pub fn sample_diff(pr: &Pr) -> Vec<(String, Vec<(char, String)>)> {
    let conv = |lines: &[(char, &str)]| -> Vec<(char, String)> { lines.iter().map(|&(c, l)| (c, l.to_owned())).collect() };
    match pr.number % 3 {
        0 => vec![
            ("src/auth/session.rs".to_owned(), conv(&[
                (' ', "pub fn refresh(&mut self, now: u64) -> bool {"),
                ('-', "    if self.expires_at > now {"),
                ('+', "    // Refresh a minute early so a request never races the expiry."),
                ('+', "    if self.expires_at > now + 60 {"),
                (' ', "        return false;"),
                (' ', "    }"),
                ('+', "    self.token = self.client.renew(&self.token);"),
            ])),
            ("src/auth/tests.rs".to_owned(), conv(&[
                (' ', "#[test]"),
                ('+', "fn refreshes_a_minute_early() {"),
                ('+', "    let mut s = Session::new(1_000);"),
                ('+', "    assert!(s.refresh(940));"),
                ('+', "}"),
            ])),
        ],
        1 => vec![
            ("src/pricing/pricing.js".to_owned(), conv(&[
                (' ', "const cards = plans.map((p) => {"),
                (' ', "  const price = yearly ? p.yearly : p.monthly;"),
                ('+', "  const save = yearly ? Math.round((1 - p.yearly / (p.monthly * 12)) * 100) : 0;"),
                ('-', "  return `<div class=\"plan\">"),
                ('+', "  return `<article class=\"plan${p.featured ? \" featured\" : \"\"}\">"),
                ('+', "    ${save ? `<span class=\"save\">Save ${save}%</span>` : \"\"}"),
                (' ', "  </article>`;"),
            ])),
            ("src/pricing/pricing.css".to_owned(), conv(&[
                (' ', ".plan {"),
                ('-', "  padding: 16px;"),
                ('+', "  padding: 20px;"),
                ('+', "  border: 1px solid var(--border);"),
                (' ', "}"),
                ('+', ".plan.featured { border-color: var(--accent); }"),
            ])),
            ("index.html".to_owned(), conv(&[
                (' ', "<section id=\"pricing\">"),
                ('-', "  <h2>Plans</h2>"),
                ('+', "  <h2>Simple pricing</h2>"),
                (' ', "  <div id=\"plans\"></div>"),
            ])),
        ],
        _ => vec![
            ("src/components/Header.tsx".to_owned(), conv(&[
                (' ', "export function Header({ user }: Props) {"),
                ('-', "  return <header>{user.name}</header>;"),
                ('+', "  return ("),
                ('+', "    <header className=\"header\">"),
                ('+', "      <Logo />"),
                ('+', "      <span>{user.name}</span>"),
                ('+', "    </header>"),
                ('+', "  );"),
                (' ', "}"),
            ])),
            ("README.md".to_owned(), conv(&[
                (' ', "## Development"),
                ('+', ""),
                ('+', "Run `npm run dev` and open http://localhost:3000."),
            ])),
        ],
    }
}

fn diff_card(t: &Theme, i: usize, path: &str, lines: &[(char, String)]) -> El {
    let added = lines.iter().filter(|(c, _)| *c == '+').count();
    let removed = lines.iter().filter(|(c, _)| *c == '-').count();
    let head = row().gap(10.0).px(14.0).py(10.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.card_border)
        .child(ico_s("file-text", 16.0, t.dim))
        .child(text(path.to_owned()).font(ui(13.0, 500.0)).color(t.text).truncate().grow(1.0).min_w(0.0))
        .child(text(format!("+{added}")).font(tabular(13.0, 400.0)).color(t.green))
        .child(text(format!("\u{2212}{removed}")).font(tabular(13.0, 400.0)).color(t.red));
    let body = col().w_full().py(6.0).children(lines.iter().map(|(c, code)| {
        let (bg, ink) = match *c {
            '+' => (t.green.alpha(0.12), t.green),
            '-' => (t.red.alpha(0.12), t.red),
            '@' => (t.accent.alpha(0.07), t.faint),
            _ => (Color::TRANSPARENT, t.faint),
        };
        // A hunk's head ('@') reads as a quiet separator with the function it's in.
        let (mark, code_ink) = if *c == '@' { (String::new(), t.faint) } else { (c.to_string(), t.text) };
        row().w_full().min_h(20.0).px(14.0).gap(10.0).center_y().fill(bg)
            .child(text(mark).font(mono(12.5, 20.0)).color(ink).w(10.0))
            .child(text(code.clone()).font(mono(12.5, 20.0)).color(code_ink).single_line().selectable(true))
    }));
    card(t).key(format!("pr-file/{i}")).w_full().clip_rounded(theme::R_MD).child(head).child(body)
}

fn heading(t: &Theme, label: &str) -> El {
    text(label.to_owned()).font(ui(15.0, 650.0)).color(t.text)
}

fn event(t: &Theme, icon: &str, ink: Color, label: String) -> El {
    row().gap(10.0).center_y().child(ico_s(icon, 16.0, ink)).child(text(label).font(ui(13.5, 400.0)).color(t.dim).wrap().grow(1.0).min_w(0.0))
}

fn meta_block(t: &Theme, title: &str, body: El) -> El {
    col().gap(8.0).pb(18.0)
        .child(text(title.to_owned()).font(ui(12.5, 600.0)).color(t.faint))
        .child(body)
}

pub fn main(s: &App, t: &Theme) -> El {
    let Some(p) = s.data.prs.iter().find(|p| p.number == s.pr).or(s.data.prs.first()) else {
        let why = if s.data.extra.prs_note.is_empty() { "No pull requests or changes in this project yet.".to_owned() } else { s.data.extra.prs_note.clone() };
        return col().w_full().h_full().center().gap(8.0)
            .child(ico_s("branch", 22.0, t.faint))
            .child(text(why).font(ui(14.0, 400.0)).color(t.faint).wrap());
    };
    // The sample data's PRs show their sample summary; real ones show what GitHub or git says.
    let sample = p.url.is_empty() && !p.local;
    let author = s.data.agent(&p.by);
    let author_name = author.map_or_else(|| p.by.clone(), |a| a.name.clone());

    let mut top = row().w_full().gap(12.0).center_y()
        .child(crate::ui::tabs(t, "pr-tabs", &[(PrTab::Summary, "Summary"), (PrTab::Changes, "Changes")], s.pr_tab,
            |s: &mut App, v: PrTab| {
                let n = s.data.prs.iter().find(|p| p.number == s.pr).or(s.data.prs.first()).map_or(0, |p| p.number);
                s.open_pr(n, v);
            }))
        .child(text(format!("+{}", p.added)).font(tabular(13.0, 500.0)).color(t.green))
        .child(text(format!("\u{2212}{}", p.removed)).font(tabular(13.0, 500.0)).color(t.red))
        .child(el().grow(1.0));
    if !p.url.is_empty() {
        let url = p.url.clone();
        top = top.child(btn(t, "View on GitHub", Some("external"), ButtonKind::Plain).key("pr-github")
            .on_press_tx(move |_: &mut App, tx| { let _ = tx.open_url(&url); }));
    }
    if p.local {
        top = top.child(btn(t, "Create pull request", Some("branch"), ButtonKind::Blue).key("pr-create")
            .on_press(|s: &mut App| s.prs_op(crate::model::PrOp::Create)));
    } else if p.state == PrState::Open {
        let n = p.number;
        top = top.child(btn(t, "Merge", None, ButtonKind::Green).key("pr-merge")
            .on_press(move |s: &mut App| if !sample { s.prs_op(crate::model::PrOp::Merge(n)) }));
    }

    let who = row().gap(8.0).center_y().pt(10.0).pb(20.0)
        .children(author.map(|a| bot::agent(a, 20.0)))
        .child(text(author_name.clone()).font(ui(13.5, 500.0)).color(t.text))
        .child(text(p.age.clone()).font(ui(13.0, 400.0)).color(t.faint))
        .child(row().key("pr-branch").h(24.0).px(9.0).radius(7.0).center_y().fill(t.hover)
            .child(text(p.branch.clone()).font(mono(12.0, 16.0)).color(t.dim).single_line()));

    let head = col().w_full().pt(20.0)
        .children((!p.local).then(|| row().pb(14.0).child(state_chip(t, p.state))))
        .child(text(p.title.clone()).font(ui(26.0, 650.0)).color(t.text).wrap())
        .child(who);

    let content = match s.pr_tab {
        PrTab::Summary if !sample => {
            let checks = p.checks.map_or_else(
                || text("None").font(ui(13.5, 400.0)).color(t.faint),
                |(ok, bad, wait)| {
                    let (icon, ink, words) = if bad > 0 {
                        ("close", t.red, format!("{bad} failed, {ok} passed"))
                    } else if wait > 0 {
                        ("history", t.warn, format!("{wait} running, {ok} passed"))
                    } else {
                        ("check", t.green, format!("{ok} passed"))
                    };
                    row().gap(8.0).center_y().child(ico_s(icon, 16.0, ink)).child(text(words).font(ui(13.5, 400.0)).color(t.text))
                },
            );
            let reviewers = if p.reviewers.is_empty() { "None yet".to_owned() } else { p.reviewers.join(", ") };
            let body = if p.summary.trim().is_empty() { "No description.".to_owned() } else { p.summary.clone() };
            let left = col().grow(1.0).min_w(0.0).gap(14.0)
                .child(heading(t, if p.local { "Commits" } else { "Summary" }))
                .child(markdown::render(&body, t, false));
            let side_meta = col().key("pr-meta").w(220.0)
                .children((!p.local).then(|| meta_block(t, "Reviewers", text(reviewers).font(ui(13.5, 400.0)).color(t.text).wrap())))
                .children((!p.local).then(|| meta_block(t, "Checks", checks)))
                .child(meta_block(t, "Branch", text(p.branch.clone()).font(mono(12.0, 16.0)).color(t.dim).wrap().selectable(true)));
            row().w_full().gap(32.0).items_start().child(left).child(side_meta)
        }
        PrTab::Summary => {
            let points = p.points.iter().map(|x| format!("- {x}")).collect::<Vec<_>>().join("\n");
            let plan = format!(
                "- Check out {} and run the test suite\n- Open the preview and try the change by hand\n- Read through the {} changed lines",
                p.branch,
                p.added + p.removed
            );
            let mut activity = col().gap(10.0).pt(10.0)
                .child(event(t, "branch", t.dim, format!("{author_name} opened this pull request \u{b7} {} ago", p.age)))
                .child(event(t, "check", t.green, "All 3 checks passed".to_owned()));
            if p.state == PrState::Merged {
                activity = activity.child(event(t, "branch", t.purple, "Merged into main".to_owned()));
            }
            let left = col().grow(1.0).min_w(0.0).gap(14.0)
                .child(heading(t, "Summary"))
                .child(markdown::paragraph(&p.summary, t, 14.5, 400.0, t.text, false))
                .child(markdown::render(&points, t, false))
                .child(el().h(6.0))
                .child(heading(t, "Test plan"))
                .child(markdown::render(&plan, t, false))
                .child(el().h(6.0))
                .child(heading(t, "Activity"))
                .child(activity);
            let you = row().gap(8.0).center_y()
                .child(el().size(20.0, 20.0).radius(10.0).fill(theme::hex("#2f8f5b")).center()
                    .child(text(s.data.user.chars().next().unwrap_or('S').to_string()).font(ui(10.0, 700.0)).color(Color::WHITE)))
                .child(text(s.data.user.clone()).font(ui(13.5, 400.0)).color(t.text));
            let checks = row().gap(8.0).center_y()
                .child(ico_s("check", 16.0, t.green))
                .child(text("3 passed").font(ui(13.5, 400.0)).color(t.text));
            let side_meta = col().key("pr-meta").w(220.0)
                .child(meta_block(t, "Reviewers", you))
                .child(meta_block(t, "Checks", checks))
                .child(meta_block(t, "Branch", text(p.branch.clone()).font(mono(12.0, 16.0)).color(t.dim).wrap().selectable(true)));
            row().w_full().gap(32.0).items_start().child(left).child(side_meta)
        }
        PrTab::Changes => match s.data.extra.pr_files.as_ref().filter(|(n, _)| *n == p.number) {
            None => row().w_full().py(30.0).center().child(crate::ui::wave("Loading the changes", ui(13.5, 400.0), t.dim)),
            Some((_, files)) if files.is_empty() => row().w_full().py(30.0).center().child(text("No changes.").font(ui(13.5, 400.0)).color(t.faint)),
            Some((_, files)) => col().w_full().gap(14.0).children(files.iter().enumerate().map(|(i, (path, lines))| diff_card(t, i, path, lines))),
        },
    };

    let page = col().key(format!("pr-page-{}", p.number)).w_full().max_w(860.0).padding(32.0).transition(fade_in()).motion(ENTER)
        .child(top)
        .child(head)
        .child(content);
    col().w_full().h_full().items_center().scroll(ScrollSpec { stick_bottom: false }).child(page)
}
