//! Code: the project's file tree, editor tabs, the editor with Frontend's live caret, the
//! terminal and the agent pane. Monospace only in the editor, terminal and the diff hunk.

use rune::{Color, El, LoopSpec, Span, col, el, rich, row, text};

use crate::app::{App, EditKey};
use crate::bot;
use crate::icons::ico_s;
use crate::model::{ButtonKind, Pill};
use crate::store::Target;
use crate::theme::{self, Theme, mono, tabular, ui};
use crate::ui::{btn, composer, enter, fade_in, me, pill, rich_text, side_head, ENTER};

/// The sample file, `«class|text»` marking highlighted runs (k keyword, s string, t function,
/// c comment, a argument, p number).
const SRC: &[(&str, &str)] = &[
    ("c", "«c|// Pricing: three plans, monthly or yearly, matching the homepage.»"),
    ("", "«k|import» { plans } «k|from» «s|\"./plans.json\"»;"),
    ("", ""),
    ("", "«k|export function» «t|renderPricing»(«a|root», { «a|yearly» = «k|false» } = {}) {"),
    ("", "  «k|const» cards = plans.«t|map»((«a|p») => {"),
    ("", "    «k|const» price = yearly ? p.yearly : p.monthly;"),
    ("add", "    «k|const» save = yearly ? «t|Math».«t|round»((«p|1» - p.yearly / (p.monthly * «p|12»)) * «p|100») : «p|0»;"),
    ("add", "    «k|return» «s|`<article class=\"plan${p.featured ? \" featured\" : \"\"}\">»"),
    ("add", "«s|      <h3>${p.name}</h3>»"),
    ("add", "«s|      <p class=\"price\">$${price}<small>/${yearly ? \"yr\" : \"mo\"}</small></p>»"),
    ("cur", "«s|      ${save ? `<span class=\"save\">Save ${save}%</span>` : \"\"}»"),
    ("", "«s|    </article>`»;"),
    ("", "  });"),
    ("", "  root.innerHTML = cards.«t|join»(«s|\"\"»);"),
    ("", "}"),
    ("", ""),
    ("c", "«c|// The switch: one click flips every card, no reload.»"),
    ("", "«k|export function» «t|bindToggle»(«a|root», «a|toggle») {"),
    ("", "  toggle.«t|addEventListener»(«s|\"change\"», () => «t|renderPricing»(root, { yearly: toggle.checked }));"),
    ("", "}"),
];

fn syntax(class: char) -> Color {
    theme::hex(match class {
        'k' => "#c792ea",
        's' => "#a5d6a7",
        't' => "#82aaff",
        'c' => "#6a737d",
        'a' => "#ffcb6b",
        'p' => "#89ddff",
        _ => "#ececec",
    })
}

/// One highlighted line: the plain text and its coloured spans.
pub fn highlight(src: &str) -> (String, Vec<Span>) {
    let mut plain = String::new();
    let mut spans = Vec::new();
    let mut rest = src;
    while let Some(open) = rest.find('«') {
        plain.push_str(&rest[..open]);
        let after = &rest[open + '«'.len_utf8()..];
        let close = after.find('»').unwrap_or(after.len());
        let (class, body) = after[..close].split_once('|').unwrap_or(("", &after[..close]));
        let start = plain.len();
        plain.push_str(body);
        let mut s = Span::new(start, plain.len());
        s.color = Some(syntax(class.chars().next().unwrap_or(' ')));
        spans.push(s);
        rest = after.get(close + '»'.len_utf8()..).unwrap_or("");
    }
    plain.push_str(rest);
    (plain, spans)
}

pub fn side(s: &App, t: &Theme) -> El {
    let r = |depth: f32, chev: Option<&str>, icon: &str, name: &str, mark: Option<(&str, Color)>, on: bool| {
        row().min_h(28.0).py(3.0).pr(8.0).pl(8.0 + depth).gap(6.0).radius(10.0).center_y().hover(t.hover)
            .fill(if on { t.active } else { Color::TRANSPARENT })
            .children(chev.map(|c| ico_s(c, 16.0, t.faint)))
            .child(ico_s(icon, 16.0, t.faint))
            .child(text(name.to_owned()).font(ui(13.5, 400.0)).color(t.text).grow(1.0).truncate())
            .children(mark.map(|(m, c)| text(m.to_owned()).font(ui(11.0, 700.0)).color(c)))
    };
    let rows = [
        r(0.0, Some("chevron-down"), "folder-open", "src", None, false),
        r(18.0, Some("chevron-down"), "folder-open", "pricing", None, false),
        r(36.0, None, "file-text", "pricing.js", Some(("M", t.warn)), true),
        r(36.0, None, "file-text", "pricing.css", Some(("M", t.warn)), false),
        r(36.0, None, "file", "plans.json", Some(("A", t.green)), false),
        r(18.0, Some("chevron-right"), "folder", "components", None, false),
        r(18.0, None, "file-text", "main.js", None, false),
        r(0.0, Some("chevron-right"), "folder", "public", None, false),
        r(0.0, None, "file", "package.json", None, false),
        r(0.0, None, "file", "README.md", None, false),
    ];
    col().h_full().min_h(0.0)
        .child(side_head(t, &s.data.project, Some(("oai-folder", "Open folder"))))
        .child(col().grow(1.0).min_h(0.0).px(8.0)
            .child(row().gap(8.0).px(8.0).pt(14.0).pb(6.0).center_y().child(ico_s("branch", 16.0, t.faint))
                .child(text("claude/pricing-page").font(ui(12.5, 600.0)).color(t.faint)))
            .children(rows.into_iter().enumerate().map(|(i, e)| enter(e, i))))
        .child(me(s, t))
}

pub fn main(s: &App, t: &Theme) -> El {
    row().key("ide").w_full().h_full().transition(fade_in()).motion(ENTER)
        .child(col().grow(1.0).min_w(0.0).h_full().border_sides([0.0, 1.0, 0.0, 0.0], t.border)
            .child(editor(t))
            .child(terminal(t)))
        .child(agent_pane(s, t))
}

fn editor(t: &Theme) -> El {
    // The prototype marks a modified tab with a dot; Codeply has no status dots in labels, and the
    // file tree's "M" already says it.
    let tab = |icon: &str, name: &str, on: bool| {
        row().h(36.0).px(14.0).gap(8.0).center_y().border_sides([0.0, 1.0, 0.0, 0.0], t.border)
            .fill(if on { t.bg } else { Color::TRANSPARENT })
            .children(on.then(|| el().pin(Some(0.0), Some(0.0), Some(0.0), None).h(2.0).fill(t.accent)))
            .child(ico_s(icon, 16.0, if on { t.text } else { t.faint }))
            .child(text(name.to_owned()).font(ui(13.0, 400.0)).color(if on { t.text } else { t.faint }))
    };
    let tabs = row().fill(t.rail).border_sides([0.0, 0.0, 1.0, 0.0], t.border)
        .child(tab("file-text", "pricing.js", true))
        .child(tab("file-text", "pricing.css", false))
        .child(tab("file", "plans.json", false));
    let crumbs = row().h(30.0).px(16.0).gap(6.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.border)
        .child(text("src").font(ui(12.5, 400.0)).color(t.faint)).child(ico_s("chevron-right", 12.0, t.faint))
        .child(text("pricing").font(ui(12.5, 400.0)).color(t.faint)).child(ico_s("chevron-right", 12.0, t.faint))
        .child(text("pricing.js").font(ui(12.5, 400.0)).color(t.faint));
    let pink = theme::hex("#ff5c9d");
    let lines = SRC.iter().enumerate().map(|(i, (kind, src))| {
        let (plain, spans) = highlight(src);
        let added = *kind == "add" || *kind == "cur";
        // `.ln.add` and `.ln.cur` both tint; the current line is a touch lighter.
        let fill = match *kind { "cur" => t.green.alpha(0.12), "add" => t.green.alpha(0.09), _ => Color::TRANSPARENT };
        row().h(20.0).center_y().fill(fill)
            .child(text((i + 1).to_string()).font(mono(13.0, 20.0)).color(if added { t.green } else { theme::hex("#5a5a5a") }).w(52.0).pr(16.0).align(rune::Align::End))
            .child(rich(plain, spans).font(mono(13.0, 20.0)).color(t.text).single_line())
            .children((*kind == "cur").then(|| {
                row().gap(6.0).center_y()
                    .child(el().size(2.0, 16.0).fill(pink).looping(LoopSpec::opacity(1.0, 0.0, 0.0, 1.0)))
                    .child(el().px(6.0).radius(4.0).fill(pink).child(text("Frontend").font(ui(11.0, 600.0).lh(16.0)).color(Color::WHITE)))
            }))
    });
    col().grow(1.0).min_h(0.0).child(tabs).child(crumbs).child(col().grow(1.0).min_h(0.0).py(8.0).clip_rounded(0.0).children(lines))
}

fn terminal(t: &Theme) -> El {
    let tab = |name: &str, on: bool| {
        col().h(34.0).justify_center()
            .child(text(name.to_owned()).font(ui(12.5, 400.0)).color(if on { t.text } else { t.faint }))
            .children(on.then(|| el().pin(Some(0.0), None, Some(0.0), Some(0.0)).h(2.0).fill(t.text)))
    };
    let (ok, dim, ink) = (t.green, theme::hex("#6f6f6f"), theme::hex("#cfcfcf"));
    let line = |parts: &[(&str, Color)]| {
        let mut plain = String::new();
        let mut spans = Vec::new();
        for (p, c) in parts {
            let start = plain.len();
            plain.push_str(p);
            let mut s = Span::new(start, plain.len());
            s.color = Some(*c);
            spans.push(s);
        }
        rich(plain, spans).font(mono(12.5, 19.0)).single_line()
    };
    col().h(200.0).fill(theme::hex("#0b0b0b")).border_sides([1.0, 0.0, 0.0, 0.0], t.border)
        .child(row().h(34.0).px(14.0).gap(16.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.border)
            .child(tab("Terminal", true)).child(tab("Problems", false)).child(tab("Output", false)))
        .child(col().px(14.0).py(8.0).clip_rounded(0.0).grow(1.0)
            .child(line(&[("~/launch-site", dim), (" npm test", ink)]))
            .child(line(&[("PASS", ok), (" src/pricing/pricing.test.js", ink)]))
            .child(line(&[("  pricing", ink)]))
            .child(line(&[("    ", ink), ("✓", ok), (" renders three plans (4 ms)", ink)]))
            .child(line(&[("    ", ink), ("✓", ok), (" yearly shows the saving (2 ms)", ink)]))
            .child(line(&[("    ", ink), ("✓", ok), (" toggle re-renders without reload (3 ms)", ink)]))
            .child(line(&[(" ", ink)]))
            .child(line(&[("Tests: ", ink), ("212 passed", ok), (", 212 total", ink)]))
            .child(line(&[("~/launch-site", dim), (" ", ink)])))
}

fn agent_pane(s: &App, t: &Theme) -> El {
    let Some(frontend) = s.data.agent("frontend") else { return el() };
    let step = |i: usize, done: bool, txt: &str, d: &str| {
        enter(row().gap(8.0).items_start()
            .child(ico_s(if done { "check" } else { "refresh" }, 16.0, if done { t.green } else { t.dim }).mt(1.0))
            .child(rich_text(txt, 13.0, t.dim, t.text).wrap().grow(1.0).min_w(0.0))
            .child(text(d.to_owned()).font(tabular(12.0, 400.0)).color(t.faint)), i)
    };
    let (plus, minus) = (theme::hex("#b9f0cf"), theme::hex("#ffc2b8"));
    let hunk_line = |s: &str, ink: Color, bg: Color| row().px(10.0).h(18.0).center_y().fill(bg).child(text(s.to_owned()).font(mono(12.0, 18.0)).color(ink).single_line());
    let hunk = col().border(1.0, t.card_border).radius(10.0).clip_rounded(10.0)
        .child(row().gap(8.0).px(10.0).py(8.0).center_y().fill(t.card)
            .child(ico_s("file-text", 16.0, t.text)).child(text("pricing.js").font(ui(12.5, 400.0)).color(t.text).grow(1.0))
            .child(pill(t, "+5", Pill::Green)))
        .child(col().py(6.0)
            .child(hunk_line("+ const save = yearly ? Math.round(...) : 0;", plus, t.green.alpha(0.1)))
            .child(hunk_line("+ return `<article class=\"plan...\">", plus, t.green.alpha(0.1)))
            .child(hunk_line("- return `<div class=\"plan\">", minus, t.red.alpha(0.1))));
    col().w(320.0).h_full().fill(t.side)
        .child(row().gap(10.0).padding(14.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.border)
            .child(bot::agent(frontend, 32.0))
            .child(col().child(text("Frontend is editing").font(ui(14.0, 600.0)).color(t.text))
                .child(text("Claude Code on your plan").font(ui(12.0, 400.0)).color(t.faint))))
        .child(col().grow(1.0).min_h(0.0).px(14.0).py(12.0).gap(10.0)
            .child(step(0, true, "Read **index.html** and the homepage styles", "0:12"))
            .child(step(1, true, "Asked Backend for the plan data", "1:40"))
            .child(step(2, true, "Created **plans.json**", "2:05"))
            .child(step(3, false, "Editing **pricing.js**", "now"))
            .child(enter(hunk, 4))
            .child(enter(row().gap(8.0).child(btn(t, "Keep", None, ButtonKind::Green)).child(btn(t, "Undo", None, ButtonKind::Plain))
                .child(btn(t, "Preview", Some("external"), ButtonKind::Plain)), 5)))
        .child(col().px(12.0).pt(10.0).pb(12.0).border_sides([1.0, 0.0, 0.0, 0.0], t.border)
            .child(composer(s, t, EditKey::AgentThread, Target::Agent("frontend".into()), "Tell Frontend what to change", false, true)))
}
