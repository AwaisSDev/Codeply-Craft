//! Pull requests: the list, the agent's summary of what changed, the diff, checks, reviewers
//! and Merge.

use rune::{Color, El, ScrollSpec, Span, col, el, rich, row, text};

use crate::app::App;
use crate::bot;
use crate::icons::ico_s;
use crate::model::{ButtonKind, Pill, PrState};
use crate::theme::{self, Theme, mono, tabular, ui};
use crate::ui::{btn, card, enter, fade_in, me, pill, rich_text, side_head, side_row, ENTER};

pub fn side(s: &App, t: &Theme) -> El {
    let rows = s.data.prs.iter().enumerate().map(|(i, p)| {
        let n = p.number;
        let who = s.data.agent(&p.by).map_or(String::new(), |a| a.name.clone());
        enter(
            side_row(t, p.number == s.pr).key(format!("pr/{n}")).role("button").label(p.title.clone())
                .children(s.data.agent(&p.by).map(|a| bot::agent(a, 26.0)))
                .child(col().grow(1.0).min_w(0.0)
                    .child(text(p.title.clone()).font(ui(14.0, 500.0)).color(t.text).truncate())
                    .child(text(format!("#{n} · {who} · {}", p.age)).font(ui(12.0, 400.0)).color(t.faint).truncate()))
                .on_press(move |s: &mut App| s.pr = n),
            i,
        )
    });
    col().h_full().min_h(0.0)
        .child(side_head(t, "Pull requests", Some(("menu", "Filter"))))
        .child(col().grow(1.0).min_h(0.0).px(8.0).pb(10.0)
            .child(row().px(8.0).pt(14.0).pb(6.0).child(text(s.data.project.clone()).font(ui(12.5, 600.0)).color(t.faint)))
            .children(rows))
        .child(me(s, t))
}

pub fn main(s: &App, t: &Theme) -> El {
    let Some(p) = s.data.prs.iter().find(|p| p.number == s.pr).or(s.data.prs.first()) else { return el() };
    let author = s.data.agent(&p.by);
    let state = match p.state {
        PrState::Open => pill(t, "Open", Pill::Green),
        PrState::Draft => pill(t, "Draft", Pill::Gray),
        PrState::Merged => pill(t, "Merged", Pill::Purple),
    };
    let title = row().gap(12.0).center_y().grow(1.0).min_w(0.0)
        .child(state)
        .child(rich(format!("{} #{}", p.title, p.number), vec![{
            let mut sp = Span::new(p.title.len() + 1, p.title.len() + 2 + p.number.to_string().len()).weight(400.0);
            sp.color = Some(t.faint);
            sp
        }]).font(ui(22.0, 650.0)).color(t.text).truncate());
    let head = row().gap(12.0).pt(16.0).pb(4.0).center_y()
        .child(title)
        .child(btn(t, "Open on GitHub", Some("external"), ButtonKind::Plain))
        .child(btn(t, "Merge", None, ButtonKind::Green));
    let strong = |x: &str| text(x.to_owned()).font(ui(13.0, 600.0)).color(t.text);
    let quiet = |x: String| text(x).font(ui(13.0, 400.0)).color(t.faint);
    let meta = row().gap(8.0).pb(18.0).center_y()
        .children(author.map(|a| bot::agent(a, 18.0)))
        .child(quiet(format!("{} wants to merge", author.map_or("", |a| a.name.as_str()))))
        .child(strong(&p.branch)).child(quiet("into".into())).child(strong("main")).child(quiet(format!("· {} ago", p.age)));

    let h4 = |icon: &str, label: &str| row().gap(8.0).pb(10.0).center_y().child(ico_s(icon, 16.0, t.dim)).child(text(label.to_owned()).font(ui(13.0, 600.0)).color(t.dim));
    let summary = card(t).px(16.0).py(14.0)
        .child(h4("sparkle", "What changed, from the agent"))
        .child(text(p.summary.clone()).font(ui(14.0, 400.0).lh(22.4)).color(t.text).wrap())
        .child(col().pt(8.0).gap(2.0).children(p.points.iter().map(|x| {
            row().gap(10.0).pl(4.0).items_start()
                .child(text("•").font(ui(14.0, 400.0).lh(22.0)).color(t.dim))
                .child(rich_text(x, 14.0, t.dim, t.text).wrap().grow(1.0).min_w(0.0))
        })));
    let files = (p.added + p.removed).div_ceil(60).max(1);
    let fh = |label: String| row().gap(10.0).px(14.0).py(10.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.card_border)
        .child(ico_s("file-text", 16.0, t.text)).child(text(label).font(ui(13.0, 400.0)).color(t.text).grow(1.0))
        .child(text(format!("+{}", p.added)).font(tabular(13.0, 400.0)).color(t.green))
        .child(text(format!("-{}", p.removed)).font(tabular(13.0, 400.0)).color(t.red));
    let diff = if p.number == 44 {
        let line = |no: &str, sign: &str, code: &str, bg: Color| {
            row().h(20.0).center_y().fill(bg)
                .child(text(no.to_owned()).font(mono(12.5, 20.0)).color(theme::hex("#5a5a5a")).w(44.0).pr(12.0).align(rune::Align::End))
                .child(text(format!("{sign} {code}")).font(mono(12.5, 20.0)).color(t.text).single_line())
        };
        let (add, del, none) = (t.green.alpha(0.1), t.red.alpha(0.1), Color::TRANSPARENT);
        card(t).mt(16.0).clip_rounded(theme::R_MD).child(fh("src/pricing/pricing.js".into())).child(col().py(6.0)
            .child(line("18", " ", " const cards = plans.map((p) => {", none))
            .child(line("19", " ", "   const price = yearly ? p.yearly : p.monthly;", none))
            .child(line("20", "+", "   const save = yearly ? Math.round((1 - p.yearly / (p.monthly * 12)) * 100) : 0;", add))
            .child(line("21", "-", "   return `<div class=\"plan\">", del))
            .child(line("21", "+", "   return `<article class=\"plan${p.featured ? \" featured\" : \"\"}\">", add))
            .child(line("22", "+", "     ${save ? `<span class=\"save\">Save ${save}%</span>` : \"\"}", add))
            .child(line("23", " ", "   </article>`;", none)))
    } else {
        card(t).mt(16.0).child(fh(format!("{} lines in {files} files", p.added + p.removed)))
    };
    let chk = |i: usize, done: bool, label: &str, time: &str| {
        row().gap(10.0).py(7.0).center_y().border_sides([if i == 0 { 0.0 } else { 1.0 }, 0.0, 0.0, 0.0], t.card_border)
            .child(ico_s(if done { "check" } else { "refresh" }, 16.0, if done { t.green } else { t.warn }))
            .child(text(label.to_owned()).font(ui(13.5, 400.0)).color(t.text).grow(1.0))
            .child(text(time.to_owned()).font(tabular(12.0, 400.0)).color(t.faint))
    };
    let checks = card(t).px(16.0).py(14.0).child(h4("shield-check", "Checks"))
        .child(chk(0, true, "Tests · 212 passed", "48s")).child(chk(1, true, "Type check", "12s"))
        .child(chk(2, true, "Browser check · 3 sizes", "31s")).child(chk(3, false, "Preview deploy", "running"));
    let you = el().size(20.0, 20.0).radius(10.0).fill(theme::hex("#2f8f5b")).center().child(text("S").font(ui(10.0, 700.0)).color(Color::WHITE));
    let reviewers = card(t).mt(12.0).px(16.0).py(14.0).child(h4("users", "Reviewers"))
        .child(col().gap(6.0)
            .child(row().gap(8.0).center_y().children(s.data.agent("wisp").map(|a| bot::agent(a, 20.0)))
                .child(text("Wisp reviewed it").font(ui(13.5, 400.0)).color(t.text).grow(1.0)).child(pill(t, "OK", Pill::Green)))
            .child(row().gap(8.0).center_y().child(you)
                .child(text("You").font(ui(13.5, 400.0)).color(t.text).grow(1.0)).child(pill(t, "Pending", Pill::Gray))));
    let page = col().key(format!("pr-page-{}", p.number)).w_full().max_w(1040.0).px(24.0).pb(40.0).transition(fade_in()).motion(ENTER)
        .child(head).child(meta)
        .child(row().gap(16.0).items_start()
            .child(col().grow(1.0).min_w(0.0).child(summary).child(diff))
            .child(col().w(300.0).child(checks).child(reviewers)));
    col().w_full().h_full().items_center().scroll(ScrollSpec { stick_bottom: false }).child(page)
}
