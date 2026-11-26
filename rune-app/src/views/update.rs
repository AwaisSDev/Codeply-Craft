//! The update screen (a bigger update: its version, its notes and "Update now"), the titlebar's
//! "Restart to update", and Settings' version and update rows. See update.rs.

use rune::{El, ScrollSpec, col, el, row, text};

use crate::app::App;
use crate::model::ButtonKind;
use crate::theme::{self, Theme, ui};
use crate::ui::btn;
use crate::update::{Phase, VERSION};

/// Megabytes, for download progress.
fn mb(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1_048_576.0)
}

/// The update screen, over the window, while a bigger update waits or downloads.
pub fn sheet(s: &App, t: &Theme) -> Option<El> {
    if !s.updater.screen() {
        return None;
    }
    let (version, notes) = match &s.updater.phase {
        Phase::Offer(r) => (r.version.clone(), r.notes.clone()),
        Phase::Fetching { version, .. } => (version.clone(), String::new()),
        _ => (String::new(), String::new()),
    };
    let head = row().w_full().gap(12.0).center_y()
        .child(crate::logo::mark(40.0))
        .child(col().grow(1.0).min_w(0.0)
            .child(text(format!("Yune {version}")).font(ui(17.0, 650.0)).color(t.text))
            .child(text(format!("You have {VERSION}. This update brings a new engine, so it installs in a minute and Yune opens again.")).font(ui(13.0, 400.0)).color(t.dim).wrap()));
    let notes = (!notes.trim().is_empty()).then(|| {
        col().w_full().gap(8.0)
            .child(text("What's new").font(ui(12.5, 600.0)).color(t.faint))
            .child(col().w_full().max_h(220.0).scroll(ScrollSpec { stick_bottom: false })
                .child(text(notes.trim().to_owned()).font(ui(13.5, 400.0)).color(t.text).wrap().selectable(true)))
    });
    let foot = match &s.updater.phase {
        Phase::Fetching { done, total, .. } => {
            let frac = if *total > 0 { (*done as f32 / *total as f32).clamp(0.0, 1.0) } else { 0.0 };
            let label = if *total > 0 { format!("Downloading {} of {}", mb(*done), mb(*total)) } else { format!("Downloading {}", mb(*done)) };
            col().w_full().gap(8.0)
                .child(el().w_full().h(6.0).radius(3.0).fill(t.hover).clip_rounded(3.0)
                    .child(el().h_full().w_frac(frac).radius(3.0).continuous_corners().fill(t.accent)))
                .child(text(label).font(ui(12.5, 400.0)).color(t.faint))
        }
        Phase::Installing => col().child(text("Installing. Yune will open again when it's done.").font(ui(13.0, 400.0)).color(t.dim)),
        _ => row().w_full().gap(8.0).justify_end()
            .child(btn(t, "Later", None, ButtonKind::Plain).key("update-later").on_press(|s: &mut App| s.later_update()))
            .child(btn(t, "Update now", Some("download"), ButtonKind::Blue).key("update-now").on_press(|s: &mut App| s.install_update())),
    };
    let card = col().key("update-sheet").w(480.0).padding(24.0).gap(18.0).radius(16.0).continuous_corners()
        .fill(t.card).border(1.0, t.card_border).shadow(16.0, 48.0, theme::rgba(0, 0, 0, 0.5))
        .role("dialog").label("Update")
        .child(head)
        .children(notes)
        .child(foot);
    Some(col().key("update-scrim").pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).center()
        .fill(theme::rgba(0, 0, 0, 0.45))
        .child(card))
}

/// The titlebar's note: "Restart to update" once a small update is in place, or "Update
/// available" for a bigger one you put off.
pub fn pill(s: &App, t: &Theme) -> Option<El> {
    let (label, ready) = match &s.updater.phase {
        Phase::Ready(_) => ("Restart to update", true),
        Phase::Offer(_) if !s.updater.screen() => ("Update available", false),
        _ => return None,
    };
    Some(row().key("update-pill").h(26.0).px(10.0).gap(6.0).radius(13.0).center_y().fill(t.accent.alpha(0.14)).hover(t.accent.alpha(0.22))
        .role("button").label(label).no_window_drag()
        .child(crate::icons::ico_s("download", 13.0, t.accent))
        .child(text(label).font(ui(12.0, 600.0)).color(t.accent))
        .on_press_tx(move |s: &mut App, tx| if ready { s.restart_to_update(tx) } else { s.updater.dismissed = None }))
}

/// Settings > General: what the updater says, and the one button that moves it on.
pub fn status(s: &App, t: &Theme) -> El {
    let (line, action): (String, Option<El>) = match &s.updater.phase {
        Phase::Idle => ("Yune looks for updates when it opens.".into(), Some(check(t))),
        Phase::Checking => ("Checking…".into(), None),
        Phase::Current => (format!("{VERSION} is the newest."), Some(check(t))),
        Phase::Fetching { version, done, total, .. } => (
            if *total > 0 { format!("Downloading {version}: {} of {}", mb(*done), mb(*total)) } else { format!("Downloading {version}") },
            None,
        ),
        Phase::Ready(r) => (
            format!("{} is ready.", r.version),
            Some(btn(t, "Restart to update", None, ButtonKind::Blue).key("set-update-restart").on_press_tx(|s: &mut App, tx| s.restart_to_update(tx))),
        ),
        Phase::Offer(r) => (
            format!("{} is available (with a new engine).", r.version),
            Some(btn(t, "Update now", None, ButtonKind::Blue).key("set-update-now").on_press(|s: &mut App| s.install_update())),
        ),
        Phase::Installing => ("Installing…".into(), None),
        Phase::Failed(e) => (e.clone(), Some(check(t))),
    };
    crate::views::settings::item(t, "Updates", Some(&line), action.unwrap_or_else(|| row()))
}

fn check(t: &Theme) -> El {
    btn(t, "Check for updates", None, ButtonKind::Plain).key("set-update-check").on_press(|s: &mut App| s.check_updates())
}
