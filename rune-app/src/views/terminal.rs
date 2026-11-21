//! The terminal pane: what Wisp and the agents ran, what you typed, and a command line; beside
//! it the Ports tab (views/ports.rs).

use rune::{Color, El, ScrollSpec, col, el, row, text, text_input};

use crate::app::{App, EditKey, Pane};
use crate::bot;
use crate::icons::ico_s;
use crate::model::TermKind;
use crate::theme::{Theme, mono, ui};
use crate::ui::ibtn;

pub fn pane(s: &App, t: &Theme) -> El {
    let prompt = format!("PS {}>", s.data.project);
    // Terminal and Ports, as tabs (VS Code's panel).
    let ports = s.ports_tab;
    let count = if ports { 0 } else { s.port_rows().len() };
    let tab = |key: &str, label: &str, on: bool| {
        row().key(key.to_owned()).h(26.0).px(10.0).gap(6.0).radius(7.0).center_y().hover(t.hover)
            .fill(if on { t.active } else { Color::TRANSPARENT })
            .role("tab").checked(on).label(label.to_owned())
            .child(text(label.to_owned()).font(ui(13.0, if on { 600.0 } else { 500.0 })).color(if on { t.text } else { t.dim }))
    };
    let header = row().w_full().h(38.0).px(12.0).gap(4.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.border)
        .child(ico_s(if ports { "link" } else { "terminal" }, 15.0, t.dim))
        .child(tab("terminal-tab", "Terminal", !ports).on_press(|s: &mut App| s.ports_tab = false))
        .child(tab("ports-tab", "Ports", ports)
            .children((count > 0).then(|| el().min_w(16.0).h(16.0).px(4.0).radius(8.0).center().fill(t.accent)
                .child(text(count.to_string()).font(crate::theme::tabular(10.5, 700.0)).color(t.on_accent))))
            .on_press(|s: &mut App| s.show_ports(true)))
        .child(el().grow(1.0).min_w(0.0))
        .children((!ports).then(|| ibtn(t, "trash", "Clear").key("terminal-clear").on_press(|s: &mut App| s.clear_terminal())))
        .child(ibtn(t, "close", "Close terminal").key("terminal-close").on_press(|s: &mut App| s.toggle_pane(Pane::Terminal)));
    if ports {
        return col().key("terminal-pane").w_full().h_full().min_h(0.0).min_w(0.0).fill(t.pane)
            .child(header)
            .child(crate::views::ports::panel(s, t));
    }

    let lines = s.data.extra.terminal.iter().enumerate().map(|(i, l)| {
        let body = |color| text(l.text.clone()).font(mono(12.5, 19.0)).color(color).wrap().selectable(true).grow(1.0).min_w(0.0);
        let line = row().key(format!("term-line/{i}")).w_full().gap(8.0);
        match l.kind {
            TermKind::Input => line
                .child(text(prompt.clone()).font(mono(12.5, 19.0)).color(t.faint))
                .child(body(t.text)),
            TermKind::Agent => line
                .child(el().h(19.0).center_y().child(bot::wisp(14.0)))
                .child(text("$").font(mono(12.5, 19.0)).color(t.faint))
                .child(body(t.text)),
            TermKind::Out => line.child(body(t.dim)),
            TermKind::Err => line.child(body(t.red)),
            TermKind::Exit => line.child(body(t.faint)),
        }
    });
    let output = col().grow(1.0).min_h(0.0).w_full().scroll(ScrollSpec { stick_bottom: true })
        .child(col().w_full().px(12.0).py(10.0).children(lines));

    let input = text_input(s.edit(EditKey::Terminal), mono(12.5, 19.0)).key("terminal-input").single_line().grow(1.0).min_w(0.0)
        .color(t.text).caret(t.accent, t.accent.alpha(0.3)).label("Terminal command")
        .on_edit(|s: &mut App| s.edit_mut(EditKey::Terminal))
        .on_submit(|s: &mut App, _| s.run_command());
    let prompt_row = row().w_full().px(12.0).py(8.0).gap(8.0).center_y().border_sides([1.0, 0.0, 0.0, 0.0], t.border)
        .child(text(prompt).font(mono(12.5, 19.0)).color(t.faint))
        .child(input);

    col().key("terminal-pane").w_full().h_full().min_h(0.0).min_w(0.0).fill(t.pane)
        .child(header)
        .child(output)
        .child(prompt_row)
}
