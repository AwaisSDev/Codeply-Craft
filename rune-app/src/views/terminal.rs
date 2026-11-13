//! The terminal pane: what Wisp and the agents ran, what you typed, and a command line.

use rune::{El, ScrollSpec, col, el, row, text, text_input};

use crate::app::{App, EditKey, Pane};
use crate::bot;
use crate::icons::ico_s;
use crate::model::TermKind;
use crate::theme::{self, Theme, mono, ui};
use crate::ui::ibtn;

pub fn pane(s: &App, t: &Theme) -> El {
    let prompt = format!("PS {}>", s.data.project);
    let header = row().w_full().h(38.0).px(12.0).gap(6.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.border)
        .child(ico_s("terminal", 15.0, t.dim))
        .child(text("Terminal").font(ui(13.0, 600.0)).color(t.text))
        .child(el().grow(1.0).min_w(0.0))
        .child(ibtn(t, "trash", "Clear").key("terminal-clear").on_press(|s: &mut App| s.clear_terminal()))
        .child(ibtn(t, "close", "Close terminal").key("terminal-close").on_press(|s: &mut App| s.toggle_pane(Pane::Terminal)));

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

    col().key("terminal-pane").w_full().h_full().min_h(0.0).min_w(0.0).fill(theme::hex("#0c0c0c"))
        .child(header)
        .child(output)
        .child(prompt_row)
}
