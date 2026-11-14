//! The usage sheet, opened from the button beside you at the sidebar's foot: the Electron app's
//! Usage page (usage.js). You, five totals, and a year of token activity, weekly (stacks) or
//! daily (a grid), each square with its tokens on hover; click a week or a day for its tokens
//! per model.

use std::collections::HashMap;

use rune::{Color, El, ScrollSpec, col, el, row, text};

use crate::app::App;
use crate::model::{Usage, UsageDay};
use crate::theme::{self, Theme, ui};
use crate::ui::{ibtn, tabs};

const WEEKS: i64 = 52;
const CELL: f32 = 9.0;
const GAP: f32 = 3.0;
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
const LONG: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/// Days since 1970-01-01 for "YYYY-MM-DD" (proleptic Gregorian).
pub fn day_number(date: &str) -> Option<i64> {
    let mut it = date.splitn(3, '-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (it.next()??, it.next()??, it.next()??);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// (year, month 1..=12, day) for a day number.
fn civil(n: i64) -> (i64, i64, i64) {
    let z = n + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 }, m, d)
}

/// "YYYY-MM-DD" for a day number.
pub fn date_of(n: i64) -> String {
    let (y, m, d) = civil(n);
    format!("{y:04}-{m:02}-{d:02}")
}

/// 0 for Sunday.
fn weekday(n: i64) -> usize {
    (n + 4).rem_euclid(7) as usize
}

/// "14 November 2026".
fn nice(n: i64) -> String {
    let (y, m, d) = civil(n);
    format!("{d} {} {y}", LONG[(m - 1) as usize])
}

/// 4.3bn, 393m, 12.5k, 940 (usage.js `short`: one decimal under 100).
pub fn short(n: u64) -> String {
    let f = |x: f64| if x >= 100.0 { format!("{}", x.round()) } else { format!("{x:.1}").trim_end_matches(".0").to_owned() };
    let n = n as f64;
    if n >= 1e9 {
        format!("{}bn", f(n / 1e9))
    } else if n >= 1e6 {
        format!("{}m", f(n / 1e6))
    } else if n >= 1e3 {
        format!("{}k", f(n / 1e3))
    } else {
        format!("{}", n.round())
    }
}

fn plural(n: u64, w: &str) -> String {
    format!("{n} {w}{}", if n == 1 { "" } else { "s" })
}

/// (current, longest) runs of days with any use; the current one may end yesterday.
fn streaks(by_day: &HashMap<i64, &UsageDay>, today: i64) -> (u64, u64) {
    let mut days: Vec<i64> = by_day.iter().filter(|(_, d)| d.tokens > 0).map(|(n, _)| *n).collect();
    days.sort_unstable();
    let (mut longest, mut run, mut prev) = (0u64, 0u64, None);
    for n in days {
        run = if prev == Some(n - 1) { run + 1 } else { 1 };
        longest = longest.max(run);
        prev = Some(n);
    }
    let used = |n: i64| by_day.get(&n).is_some_and(|d| d.tokens > 0);
    let mut d = if used(today) { today } else { today - 1 };
    let mut cur = 0;
    while used(d) {
        cur += 1;
        d -= 1;
    }
    (cur, longest)
}

/// The sheet over the window, while it's open.
pub fn sheet(s: &App, t: &Theme) -> Option<El> {
    if !s.usage_open {
        return None;
    }
    let close = ibtn(t, "close", "Close").key("usage-close").on_press(|s: &mut App| s.usage_open = false);
    let who = if s.data.user.is_empty() { "You".to_owned() } else { s.data.user.clone() };
    let head = row().w_full().gap(12.0).center_y()
        .child(el().size(40.0, 40.0).radius(20.0).fill(theme::hex("#2f8f5b")).center()
            .child(text(who.chars().next().unwrap_or('Y').to_uppercase().to_string()).font(ui(15.0, 700.0)).color(Color::WHITE)))
        .child(col().grow(1.0).min_w(0.0)
            .child(text(who).font(ui(16.0, 600.0)).color(t.text).truncate())
            .child(text("Usage").font(ui(12.5, 400.0)).color(t.faint)))
        .child(close);
    let body = match s.data.extra.usage.as_ref() {
        None => note(t, "Loading your usage…"),
        Some(u) if !u.error.is_empty() => note(t, &u.error),
        Some(u) => content(s, t, u),
    };
    let card = col().key("usage-sheet").w(720.0).max_h(640.0).padding(24.0).gap(18.0).radius(16.0)
        .fill(t.card).border(1.0, t.card_border).shadow(16.0, 48.0, theme::rgba(0, 0, 0, 0.5))
        .transition(crate::ui::fade_in()).motion(crate::ui::ENTER)
        .role("dialog").label("Usage")
        .modal(true, |s: &mut App| s.usage_open = false)
        .child(head)
        .child(col().w_full().min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(body));
    Some(col().key("usage-scrim").pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).center()
        .fill(theme::rgba(0, 0, 0, 0.45))
        .child(card))
}

fn note(t: &Theme, msg: &str) -> El {
    row().w_full().py(40.0).center().child(text(msg.to_owned()).font(ui(13.5, 400.0)).color(t.faint))
}

fn content(s: &App, t: &Theme, u: &Usage) -> El {
    let today = day_number(&u.today).unwrap_or(0);
    let by_day: HashMap<i64, &UsageDay> = u.days.iter().filter_map(|d| Some((day_number(&d.date)?, d))).collect();
    let peak = u.days.iter().map(|d| d.tokens).max().unwrap_or(0);
    let (current, longest) = streaks(&by_day, today);
    let stats = [
        (short(u.tokens), "Lifetime tokens"),
        (short(peak), "Peak day"),
        (if u.favorite.is_empty() { "None yet".to_owned() } else { u.favorite.clone() }, "Favorite model"),
        (plural(current, "day"), "Current streak"),
        (plural(longest, "day"), "Longest streak"),
    ];
    let stats = row().w_full().gap(10.0).children(stats.into_iter().map(|(v, l)| {
        col().w(0.0).grow(1.0).min_w(0.0).gap(4.0).px(12.0).py(10.0).radius(10.0).fill(t.hover)
            .child(text(v).font(ui(17.0, 650.0)).color(t.text).truncate())
            .child(text(l).font(ui(11.5, 400.0)).color(t.faint).truncate())
    }));
    let mode = row().w_full().center_y()
        .child(text("Token activity").font(ui(14.0, 600.0)).color(t.text))
        .child(el().grow(1.0))
        .child(tabs(t, "usage-mode", &[(true, "Daily"), (false, "Weekly")], s.usage_daily, |s: &mut App, daily| {
            s.usage_daily = daily;
            s.usage_pick = None;
        }));
    // Weeks start on Sunday; the last column is this week.
    let this_week = today - weekday(today) as i64;
    let weeks: Vec<i64> = (0..WEEKS).rev().map(|w| this_week - 7 * w).collect();
    let tokens = |n: i64| by_day.get(&n).map_or(0, |d| d.tokens);
    let week_total = |start: i64| (0..7).map(|i| tokens(start + i)).sum::<u64>();
    let max_week = weeks.iter().map(|w| week_total(*w)).max().unwrap_or(0).max(1);
    let max_day = weeks.iter().flat_map(|w| (0..7).map(move |i| w + i)).filter(|n| *n <= today).map(tokens).max().unwrap_or(0).max(1);
    let pick = s.usage_pick.clone();
    let cols = weeks.iter().enumerate().map(|(i, &start)| {
        let mut column = col().gap(GAP);
        if s.usage_daily {
            for d in 0..7 {
                let n = start + d;
                let cell = el().size(CELL, CELL).radius(2.0);
                column = column.child(if n > today {
                    cell
                } else {
                    let v = tokens(n);
                    let level = if v == 0 { 0 } else { (1 + (v as f64 / max_day as f64 * 4.0) as u32).min(4) };
                    let key = format!("d{}", date_of(n));
                    let on = pick.as_deref() == Some(key.as_str());
                    cell.key(format!("usage-day/{key}"))
                        .fill(if level == 0 { t.hover } else { t.accent.alpha([0.0, 0.3, 0.5, 0.75, 1.0][level as usize]) })
                        .border(if on { 1.5 } else { 0.0 }, t.text)
                        .help(format!("{} tokens on {}", short(v), nice(n)))
                        .role("button").label(format!("{} tokens on {}", short(v), nice(n)))
                        .on_press(move |s: &mut App| s.usage_pick = if s.usage_pick.as_deref() == Some(key.as_str()) { None } else { Some(key.clone()) })
                });
            }
        } else {
            let total = week_total(start);
            let lit = if total == 0 { 0 } else { ((total as f64 / max_week as f64) * 7.0).round().max(1.0) as usize };
            let key = format!("w{i}");
            let on = pick.as_deref() == Some(key.as_str());
            for r in 0..7 {
                column = column.child(el().size(CELL, CELL).radius(2.0).fill(if 6 - r < lit { t.accent } else { t.hover }));
            }
            column = column.key(format!("usage-week/{i}")).radius(3.0)
                .border(if on { 1.5 } else { 0.0 }, t.text)
                .help(format!("{} tokens on week of {}", short(total), nice(start)))
                .role("button").label(format!("{} tokens on week of {}", short(total), nice(start)))
                .on_press(move |s: &mut App| s.usage_pick = if s.usage_pick.as_deref() == Some(key.as_str()) { None } else { Some(key.clone()) });
        }
        column
    });
    let grid = row().gap(GAP).children(cols);
    // A month's name under the first week that starts in it (a cut-off first month is left out).
    let mut last = -1;
    let mut labels: Vec<Option<&str>> = weeks.iter().map(|&w| {
        let m = civil(w).1;
        if m == last { None } else { last = m; Some(MONTHS[(m - 1) as usize]) }
    }).collect();
    if labels.iter().skip(1).position(Option::is_some).is_some_and(|p| p + 1 < 3) {
        labels[0] = None;
    }
    let months = row().gap(GAP).h(14.0).children(labels.into_iter().map(|l| {
        el().w(CELL).h(14.0).children(l.map(|m| text(m).font(ui(10.5, 400.0)).color(t.faint).absolute(0.0, 0.0)))
    }));
    let chart = col().w_full().gap(6.0).items_center().child(grid).child(months);
    col().w_full().gap(18.0)
        .child(stats)
        .child(mode)
        .child(chart)
        .children(breakdown(t, &weeks, &by_day, pick.as_deref()))
        .child(text(format!("{} model calls across the app, your agents, the CLI, cloud runs and your phone. Counts only, never what you wrote.", short(u.calls)))
            .font(ui(12.0, 400.0)).color(t.faint).wrap())
}

/// Tokens per model for the picked week or day.
fn breakdown(t: &Theme, weeks: &[i64], by_day: &HashMap<i64, &UsageDay>, pick: Option<&str>) -> Option<El> {
    let pick = pick?;
    let (title, days): (String, Vec<i64>) = if let Some(i) = pick.strip_prefix('w') {
        let start = *weeks.get(i.parse::<usize>().ok()?)?;
        (format!("Week of {}", nice(start)), (start..start + 7).collect())
    } else {
        let n = day_number(pick.strip_prefix('d')?)?;
        (format!("{}, {}", WEEKDAYS[weekday(n)], nice(n)), vec![n])
    };
    let mut per: HashMap<&str, (u64, u64)> = HashMap::new();
    let (mut total, mut calls) = (0u64, 0u64);
    for n in &days {
        let Some(d) = by_day.get(n) else { continue };
        total += d.tokens;
        calls += d.calls;
        for (m, mt, mn) in &d.models {
            let e = per.entry(m.as_str()).or_default();
            e.0 += mt;
            e.1 += mn;
        }
    }
    let mut list: Vec<(&str, (u64, u64))> = per.into_iter().collect();
    list.sort_by(|a, b| b.1.0.cmp(&a.1.0));
    let top = list.first().map_or(1, |(_, (v, _))| (*v).max(1));
    let rows: Vec<El> = if list.is_empty() {
        vec![text(format!("Nothing used on this {}.", if pick.starts_with('w') { "week" } else { "day" })).font(ui(12.5, 400.0)).color(t.faint)]
    } else {
        list.into_iter().map(|(m, (mt, mn))| {
            let name = m.rsplit('/').next().unwrap_or(m).to_owned();
            row().w_full().gap(10.0).center_y()
                .child(text(name).font(ui(12.5, 500.0)).color(t.text).truncate().w(170.0))
                .child(el().grow(1.0).h(6.0).radius(3.0).fill(t.hover)
                    .child(el().h_full().w_frac((mt as f32 / top as f32).max(0.02)).radius(3.0).fill(t.accent)))
                .child(text(short(mt)).font(ui(12.0, 500.0)).color(t.dim).w(52.0))
                .child(text(format!("{}%", if total > 0 { mt * 100 / total } else { 0 })).font(ui(12.0, 400.0)).color(t.faint).w(36.0))
                .child(text(plural(mn, "call")).font(ui(12.0, 400.0)).color(t.faint).w(70.0))
        }).collect()
    };
    Some(col().key("usage-breakdown").w_full().gap(10.0).padding(14.0).radius(12.0).border(1.0, t.card_border)
        .transition(crate::ui::fade_in()).motion(crate::ui::ENTER)
        .child(row().w_full().center_y().gap(8.0)
            .child(text(title).font(ui(13.5, 600.0)).color(t.text))
            .child(text(format!("{} tokens · {}", short(total), plural(calls, "call"))).font(ui(12.0, 400.0)).color(t.faint))
            .child(el().grow(1.0))
            .child(ibtn(t, "close", "Close").key("usage-breakdown-close").on_press(|s: &mut App| s.usage_pick = None)))
        .children(rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_round_trip_and_weekdays() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(date_of(day_number("2026-11-14").unwrap()), "2026-11-14");
        assert_eq!(date_of(day_number("2024-02-29").unwrap()), "2024-02-29");
        assert_eq!(weekday(day_number("2026-11-14").unwrap()), 6); // a Saturday
        assert_eq!(weekday(day_number("2026-11-15").unwrap()), 0); // a Sunday
        assert_eq!(day_number("2026-13-01"), None);
    }

    #[test]
    fn short_numbers() {
        assert_eq!(short(940), "940");
        assert_eq!(short(12_500), "12.5k");
        assert_eq!(short(392_800_000), "393m");
        assert_eq!(short(39_280_000), "39.3m");
        assert_eq!(short(4_300_000_000), "4.3bn");
        assert_eq!(short(150_000), "150k");
    }
}
