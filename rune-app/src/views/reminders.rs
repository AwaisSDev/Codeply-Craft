//! Reminders: the same ones the phone shows (the account's reminders, `sidecar/ext-reminders.mjs`).
//! Opened from the Agents sidebar. Add one in plain words, snooze or delete it; one set from any
//! chat ("remind me at 5: call mom") or on the phone shows up here, and back.

use rune::{Color, El, ScrollSpec, col, el, row, text, text_input};

use crate::agentsync::{self, Reminder, SyncOp};
use crate::app::{App, EditKey};
use crate::bot;
use crate::icons::ico_s;
use crate::model::ButtonKind;
use crate::theme::{Theme, ui};
use crate::ui::{btn, enter, ibtn};

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl App {
    /// Opens Reminders in Agents, and reads them again.
    pub fn open_reminders(&mut self) {
        self.view = crate::app::View::Agents;
        self.agent = None;
        self.reminders_open = true;
        self.with_store(|st, d| st.sync_op(SyncOp::Refresh, d));
    }

    /// Adds what the form holds.
    pub fn add_reminder(&mut self) {
        let text = self.edit(EditKey::ReminderText).text.trim().to_owned();
        let when = self.edit(EditKey::ReminderWhen).text.trim().to_owned();
        if text.is_empty() || when.is_empty() {
            self.notice = Some("Write what to remember and when.".into());
            return;
        }
        self.notice = None;
        self.edit_mut(EditKey::ReminderText).clear();
        self.edit_mut(EditKey::ReminderWhen).clear();
        self.with_store(|st, d| st.sync_op(SyncOp::AddReminder { text, when }, d));
    }

    pub fn reminder_op(&mut self, op: SyncOp) {
        self.with_store(|st, d| st.sync_op(op, d));
    }
}

fn field(s: &App, t: &Theme, key: EditKey, label: &str, placeholder: &str, grow: f32) -> El {
    let input = text_input(s.edit(key), ui(13.5, 400.0)).key(format!("reminder-field/{}", key.name())).single_line().grow(1.0).color(t.text)
        .placeholder(placeholder.to_owned(), t.faint).caret(t.accent, t.accent.alpha(0.3)).label(label.to_owned())
        .on_edit(move |s: &mut App| s.edit_mut(key))
        .on_submit(|s: &mut App, _| s.add_reminder());
    row().grow(grow).min_w(0.0).h(38.0).px(12.0).radius(10.0).clip_rounded(10.0).center_y().fill(t.field).border(1.0, t.field_border).child(input)
}

/// Who set it: that agent's face when it's on the team, else its first letter.
fn face(s: &App, t: &Theme, who: &str, size: f32) -> El {
    match s.data.team.iter().find(|a| a.name.eq_ignore_ascii_case(who) || a.id.eq_ignore_ascii_case(who)) {
        Some(a) => bot::agent(&crate::views::agents::awake(a), size),
        None => el().size(size, size).radius(size / 2.0).fill(t.hover).center()
            .child(text(who.chars().next().unwrap_or('C').to_uppercase().to_string()).font(ui(size * 0.42, 650.0)).color(t.dim)),
    }
}

/// The notice the phone shows when notifications are off, for the PC: they're the app's own switch.
pub fn notifications_off(s: &App, t: &Theme, what: &str) -> Option<El> {
    (!s.prefs.notifications).then(|| {
        row().key("notifications-off").w_full().px(14.0).py(10.0).gap(10.0).radius(10.0).center_y().fill(t.warn.alpha(0.10)).border(1.0, t.warn.alpha(0.25))
            .child(ico_s("bell", 16.0, t.warn))
            .child(text(format!("Notifications are off for Codeply, so {what} only show here while the app is open.")).font(ui(12.5, 400.0)).color(t.text).wrap().grow(1.0).min_w(0.0))
            .child(btn(t, "Turn on", None, ButtonKind::Plain).key("notifications-on").on_press(|s: &mut App| s.update_prefs(|p| p.notifications = true)))
    })
}

fn upcoming_row(s: &App, t: &Theme, i: usize, r: &Reminder, now: u64) -> El {
    let (snooze, gone) = (r.id.clone(), r.id.clone());
    let row_ = row().key(format!("reminder/{}", r.id)).hover_group().w_full().min_h(52.0).px(10.0).py(8.0).gap(12.0).radius(10.0).center_y().hover(t.hover)
        .child(face(s, t, &r.bot, 30.0))
        .child(col().grow(1.0).min_w(0.0).gap(2.0)
            .child(text(r.text.clone()).font(ui(14.0, 500.0)).color(t.text).truncate())
            .child(text(agentsync::reminder_line(r, now)).font(ui(12.5, 400.0)).color(t.dim).truncate()))
        .child(ibtn(t, "clock", "Snooze 10 min").key(format!("reminder-snooze/{}", r.id)).group_opacity(0.0, 1.0)
            .on_press(move |s: &mut App| s.reminder_op(SyncOp::Snooze(snooze.clone(), 10))))
        .child(ibtn(t, "close", "Delete reminder").key(format!("reminder-delete/{}", r.id))
            .on_press(move |s: &mut App| s.reminder_op(SyncOp::CancelReminder(gone.clone()))));
    enter(row_, i)
}

fn earlier_row(s: &App, t: &Theme, r: &Reminder) -> El {
    let gone = r.id.clone();
    let at = agentsync::parse_iso(if r.sent_at.is_empty() { &r.due_at } else { &r.sent_at }).map(|ms| agentsync::when_label(ms, now_ms())).unwrap_or_default();
    let who = if r.bot.is_empty() { "Codeply" } else { r.bot.as_str() };
    row().key(format!("reminder-earlier/{}", r.id)).w_full().min_h(44.0).px(10.0).py(6.0).gap(12.0).radius(10.0).center_y().hover(t.hover)
        .child(face(s, t, who, 24.0))
        .child(col().grow(1.0).min_w(0.0).gap(1.0)
            .child(text(r.text.clone()).font(ui(13.5, 400.0)).color(t.dim).truncate())
            .child(text(format!("{who} · {} · {at}", agentsync::done_word(r))).font(ui(12.0, 400.0)).color(t.faint).truncate()))
        .child(ibtn(t, "close", "Remove").key(format!("reminder-remove/{}", r.id))
            .on_press(move |s: &mut App| s.reminder_op(SyncOp::CancelReminder(gone.clone()))))
}

fn label(t: &Theme, title: &str) -> El {
    row().px(10.0).pt(26.0).pb(6.0).child(text(title.to_owned()).font(ui(12.5, 600.0)).color(t.faint))
}

pub fn page(s: &App, t: &Theme) -> El {
    let x = &s.data.extra.agents;
    let now = now_ms();
    let form = row().w_full().gap(8.0).center_y()
        .child(field(s, t, EditKey::ReminderText, "What to remember", "What to remember, like call mom", 2.0))
        .child(field(s, t, EditKey::ReminderWhen, "When", "When: in 10 min, at 5pm, tomorrow", 1.3))
        .child(btn(t, "Add", None, ButtonKind::Blue).key("reminder-add").on_press(|s: &mut App| s.add_reminder()));

    let mut body = col().w_full().max_w(720.0).px(24.0).gap(0.0)
        .child(col().w_full().gap(4.0).pb(20.0)
            .child(text("Reminders").font(ui(24.0, 650.0).tracking(-0.3)).color(t.text))
            .child(text("Your bots remind you, text you or call you at the time you ask for. They are the same on your phone.").font(ui(13.0, 400.0)).color(t.faint).wrap()))
        .child(form);
    if let Some(n) = s.notice.clone().filter(|_| s.reminders_open) {
        body = body.child(text(n).font(ui(12.5, 400.0)).color(t.red).wrap().pt(8.0).px(2.0));
    }
    if !x.reminders_note.is_empty() {
        body = body.child(row().w_full().mt(10.0).px(12.0).py(9.0).radius(10.0).gap(8.0).center_y().fill(t.hover)
            .child(ico_s("alert", 15.0, t.dim))
            .child(text(x.reminders_note.clone()).font(ui(12.5, 400.0)).color(t.dim).wrap().grow(1.0).min_w(0.0)));
    }
    if let Some(n) = notifications_off(s, t, "reminders") {
        body = body.child(el().w_full().mt(12.0).child(n));
    }

    let upcoming: Vec<&Reminder> = x.upcoming().collect();
    body = body.child(label(t, "Coming up"));
    if !x.reminders_loaded {
        body = body.child(text("Getting your reminders...").font(ui(13.0, 400.0)).color(t.faint).px(10.0).py(6.0));
    } else if upcoming.is_empty() {
        body = body.child(text("Nothing coming up. Add one above, or say \"remind me at 5: call mom\" in any chat.").font(ui(13.0, 400.0)).color(t.faint).wrap().px(10.0).py(6.0));
    }
    for (i, r) in upcoming.into_iter().enumerate() {
        body = body.child(upcoming_row(s, t, i, r, now));
    }

    // The last day's sent ones, like the phone's "Earlier".
    let earlier: Vec<&Reminder> = x.reminders.iter()
        .filter(|r| !r.upcoming && matches!(r.status.as_str(), "sent" | "done"))
        .filter(|r| agentsync::parse_iso(if r.sent_at.is_empty() { &r.due_at } else { &r.sent_at }).is_some_and(|ms| now.saturating_sub(ms) < 86_400_000))
        .take(10).collect();
    if !earlier.is_empty() {
        body = body.child(label(t, "Earlier"));
        for r in earlier {
            body = body.child(earlier_row(s, t, r));
        }
    }
    col().key("reminders").w_full().h_full().items_center().scroll(ScrollSpec { stick_bottom: false }).child(body.py(48.0))
        .fill(Color::TRANSPARENT)
}
