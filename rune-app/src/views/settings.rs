//! Settings, Codex-style: a page over the whole window with a list of sections on the left and
//! the chosen section's groups on the right. Each group is a rounded card of rows, a label and
//! a description on the left and a control on the right.

use rune::{Cx, El, ScrollSpec, col, el, row, text, text_input};

use crate::app::{App, EditKey, SettingsPage};
use crate::bot;
use crate::icons::{ico, ico_s};
use crate::model::{ButtonKind, Pill};
use crate::prefs::Approval;
use crate::theme::{self, Theme, mono, ui};
use crate::ui::{btn, btn_primary, ibtn, pill, sec, side_row, tabs, toggle};

pub fn page(s: &App, t: &Theme, _cx: &mut Cx<App>) -> El {
    let q = s.edit(EditKey::SettingsSearch).text.trim().to_lowercase();
    let pages = SettingsPage::ALL.iter().copied().filter(|p| q.is_empty() || p.label().to_lowercase().contains(&q)).map(|p| {
        side_row(t, s.settings == p).key(format!("settings/{}", p.slug())).role("button").label(p.label())
            .child(ico(p.icon(), t.dim))
            .child(text(p.label()).font(ui(14.0, 400.0)).color(t.text).grow(1.0))
            .on_press(move |s: &mut App| s.settings = p)
    });
    let back = side_row(t, false).key("settings-back").role("button").label("Back to app")
        .child(ico("arrow-left", t.dim))
        .child(text("Back to app").font(ui(14.0, 400.0)).color(t.text))
        .on_press(|s: &mut App| s.leave_settings());
    let search = row().h(34.0).gap(8.0).px(10.0).radius(9.0).center_y().fill(t.field).border(1.0, t.field_border)
        .child(ico_s("search", 16.0, t.faint))
        .child(text_input(s.edit(EditKey::SettingsSearch), ui(13.5, 400.0)).key("settings-search").single_line().grow(1.0).color(t.text)
            .placeholder("Search settings", t.faint).caret(t.accent, t.accent.alpha(0.3)).label("Search settings")
            .on_edit(|s: &mut App| s.edit_mut(EditKey::SettingsSearch)));
    let nav = col().key("settings-nav").w(260.0).h_full().min_h(0.0).fill(t.side).border_sides([0.0, 1.0, 0.0, 0.0], t.border)
        .child(col().px(12.0).pt(14.0).gap(10.0).child(back).child(search))
        .child(col().grow(1.0).min_h(0.0).px(12.0).scroll(ScrollSpec { stick_bottom: false })
            .child(sec(t, None, "Personal", false))
            .children(pages));
    let title = s.settings.label();
    let content = col().key("settings-page").w_full().max_w(720.0).pt(40.0).pb(64.0).gap(24.0)
        .child(col().gap(4.0)
            .child(text(title).font(ui(24.0, 650.0)).color(t.text))
            .child(text(subtitle(s.settings)).font(ui(13.5, 400.0)).color(t.dim).wrap()))
        .children(groups(s, t, s.settings));
    let right = col().grow(1.0).min_w(0.0).h_full().px(32.0).items_center().scroll(ScrollSpec { stick_bottom: false }).child(content);
    row().key("settings-root").w_full().h_full().fill(t.bg).child(nav).child(right)
}

fn subtitle(page: SettingsPage) -> &'static str {
    match page {
        SettingsPage::General => "Permissions, notifications, chat behaviour and the workspace.",
        SettingsPage::Profile => "Who you are in Codeply.",
        SettingsPage::Appearance => "How Codeply and your team look.",
        SettingsPage::Configuration => "How much the engine asks, how hard it thinks, and what it runs on.",
        SettingsPage::Personalization => "Tell Wisp about yourself and how you like answers.",
        SettingsPage::Shortcuts => "Keys that work anywhere in the app.",
        SettingsPage::Mcp => "Servers that give the engine extra tools.",
        SettingsPage::Hooks => "Commands that run at set moments in a task.",
        SettingsPage::Connections => "Accounts your agents can reach.",
        SettingsPage::Git => "How commits and branches are made.",
        SettingsPage::Environments => "Where tasks run.",
        SettingsPage::Worktrees => "Keep each task's changes in a folder of its own.",
        SettingsPage::Browser => "The built-in browser's home page, bookmarks and data.",
        SettingsPage::ComputerUse => "Let an agent look at and control your screen.",
        SettingsPage::Archived => "Chats you hid from the sidebar.",
        SettingsPage::Usage => "Your plan and what you have used.",
    }
}

// ---------- building blocks ----------

/// A titled card; its rows are separated by 1 px lines.
pub fn group(t: &Theme, title: &str, rows: Vec<El>) -> El {
    col().gap(8.0)
        .child(text(title.to_owned()).font(ui(13.0, 600.0)).color(t.dim).pl(4.0))
        .child(col().w_full().fill(t.card).border(1.0, t.card_border).radius(12.0)
            .children(rows.into_iter().enumerate().map(|(i, r)| r.border_sides([if i == 0 { 0.0 } else { 1.0 }, 0.0, 0.0, 0.0], t.card_border))))
}

/// A row: label and description on the left, `control` on the right.
pub fn item(t: &Theme, label: &str, desc: Option<&str>, control: El) -> El {
    row().w_full().min_h(56.0).px(16.0).py(12.0).gap(16.0).center_y()
        .child(col().grow(1.0).min_w(0.0).gap(2.0)
            .child(text(label.to_owned()).font(ui(14.0, 500.0)).color(t.text))
            .children(desc.map(|d| text(d.to_owned()).font(ui(12.5, 400.0)).color(t.dim).wrap())))
        .child(control)
}

/// A plain note under a group.
pub fn note(t: &Theme, msg: &str) -> El {
    text(msg.to_owned()).font(ui(12.5, 400.0)).color(t.faint).wrap().px(4.0)
}

/// A value shown as text on the right of a row.
fn value(t: &Theme, v: &str) -> El {
    text(v.to_owned()).font(ui(13.5, 400.0)).color(t.dim)
}

/// A toggle that does something.
fn sw(t: &Theme, key: &str, on: bool, label: &str, f: impl Fn(&mut App) + 'static) -> El {
    toggle(t, key.to_owned(), on, label).on_press(f)
}

/// A toggle in a sample page (it shows the control; nothing listens yet).
fn sample(t: &Theme, key: &str, on: bool, label: &str) -> El {
    toggle(t, key.to_owned(), on, label)
}

/// A key on the keyboard.
fn keys(t: &Theme, combo: &str) -> El {
    row().gap(4.0).children(combo.split(' ').map(|k| {
        row().h(24.0).min_w(24.0).px(7.0).radius(6.0).center().fill(t.control).border(1.0, t.control_border)
            .child(text(k.to_owned()).font(mono(12.0, 16.0)).color(t.dim))
    }))
}

/// A text box for Personalization: the group's card is the box.
fn editor(s: &App, t: &Theme, key: EditKey, placeholder: &str) -> El {
    col().w_full().min_h(110.0).px(16.0).py(14.0)
        .child(text_input(s.edit(key), ui(14.0, 400.0)).key(format!("{}-field", key.name())).w_full().min_h(82.0).color(t.text)
            .placeholder(placeholder.to_owned(), t.faint).caret(t.accent, t.accent.alpha(0.3)).label(placeholder.to_owned())
            .on_edit(move |s: &mut App| s.edit_mut(key)))
}

/// A usage meter: a thin bar, `frac` of it filled.
fn meter(t: &Theme, frac: f32) -> El {
    let w = 140.0;
    el().w(w).h(4.0).radius(2.0).fill(t.border).child(el().w(w * frac.clamp(0.0, 1.0)).h(4.0).radius(2.0).fill(t.accent))
}

// ---------- pages ----------

fn groups(s: &App, t: &Theme, page: SettingsPage) -> Vec<El> {
    match page {
        SettingsPage::General => general(s, t),
        SettingsPage::Profile => profile(s, t),
        SettingsPage::Appearance => appearance(s, t),
        SettingsPage::Configuration => configuration(s, t),
        SettingsPage::Personalization => personalization(s, t),
        SettingsPage::Shortcuts => shortcuts(t),
        SettingsPage::Mcp => mcp(s, t),
        SettingsPage::Hooks => hooks(t),
        SettingsPage::Connections => connections(t),
        SettingsPage::Git => git(t),
        SettingsPage::Environments => environments(t),
        SettingsPage::Worktrees => worktrees(t),
        SettingsPage::Browser => browser(s, t),
        SettingsPage::ComputerUse => computer_use(t),
        SettingsPage::Archived => archived(s, t),
        SettingsPage::Usage => usage(s, t),
    }
}

fn general(s: &App, t: &Theme) -> Vec<El> {
    let p = &s.prefs;
    vec![
        group(t, "Permissions", vec![
            item(t, "Full access", Some("Run commands and edit files without asking each time."),
                sw(t, "set-full-access", p.approval == Approval::Auto, "Full access", |s: &mut App| {
                    let next = if s.prefs.approval == Approval::Auto { Approval::Ask } else { Approval::Auto };
                    s.set_approval(next);
                })),
        ]),
        group(t, "Notifications", vec![
            item(t, "Notifications", Some("Tell me when a task finishes or needs me."),
                sw(t, "set-notifications", p.notifications, "Notifications", |s: &mut App| s.update_prefs(|p| p.notifications = !p.notifications))),
        ]),
        group(t, "Chat", vec![
            item(t, "Enter sends", Some("Shift+Enter makes a new line. Off: Ctrl+Enter sends."),
                sw(t, "set-enter-sends", p.enter_sends, "Enter sends", |s: &mut App| s.update_prefs(|p| p.enter_sends = !p.enter_sends))),
            item(t, "Show each tool call", Some("Off folds them into \"Worked for ...\"."),
                sw(t, "set-show-tools", p.show_tools, "Show each tool call", |s: &mut App| s.update_prefs(|p| p.show_tools = !p.show_tools))),
            item(t, "Fade replies in as they stream", Some("Words arrive from grey to white."),
                sw(t, "set-reveal", p.reveal, "Fade replies in as they stream", |s: &mut App| s.update_prefs(|p| p.reveal = !p.reveal))),
        ]),
        group(t, "Workspace", vec![
            item(t, "Project folder", Some(&s.data.project),
                btn(t, "Change", None, ButtonKind::Plain).key("set-change-project")),
            item(t, "Engine", None, value(t, &s.data.source)),
            item(t, "Version", None, value(t, &s.data.extra.version)),
        ]),
    ]
}

fn profile(s: &App, t: &Theme) -> Vec<El> {
    let initial = s.data.user.chars().next().unwrap_or('S').to_string();
    vec![group(t, "Account", vec![
        row().w_full().px(16.0).py(20.0).gap(16.0).center_y()
            .child(el().key("profile-avatar").size(64.0, 64.0).radius(32.0).fill(theme::hex("#2f8f5b")).center()
                .child(text(initial).font(ui(26.0, 650.0)).color(rune::Color::WHITE)))
            .child(col().grow(1.0).min_w(0.0).gap(2.0)
                .child(text(s.data.user.clone()).font(ui(18.0, 650.0)).color(t.text))
                .child(text(s.data.plan.clone()).font(ui(13.0, 400.0)).color(t.dim)))
            .children(s.data.extra.signed_in.then(|| btn(t, "Sign out", None, ButtonKind::Plain).key("set-sign-out").on_press(|s: &mut App| s.sign_out()))),
    ]), sign_in(s, t)]
}

/// One line field for the sign-in card.
fn line_field(s: &App, t: &Theme, key: EditKey, placeholder: &str, submit: fn(&mut App)) -> El {
    row().grow(1.0).min_w(0.0).h(36.0).px(12.0).radius(9.0).center_y().fill(t.hover).border(1.0, t.border)
        .child(text_input(s.edit(key), ui(14.0, 400.0)).key(format!("{}-field", key.name())).single_line().grow(1.0).color(t.text)
            .placeholder(placeholder.to_owned(), t.faint).caret(t.accent, t.accent.alpha(0.3)).label(placeholder.to_owned())
            .on_edit(move |s: &mut App| s.edit_mut(key))
            .on_submit(move |s: &mut App, _| submit(s)))
}

/// Sign in with a code sent to your email (the Codeply account the engine uses).
fn sign_in(s: &App, t: &Theme) -> El {
    if s.data.extra.signed_in {
        return group(t, "Codeply account", vec![item(t, "Signed in", Some(&s.data.extra.email), ico_s("check", 16.0, t.green))]);
    }
    let state = s.data.extra.sign_in.clone().unwrap_or_default();
    let sent = state == "sent" || state == "verifying";
    let mut rows = vec![
        col().w_full().px(16.0).py(14.0).gap(10.0)
            .child(text("Sign in with your email. Codeply sends you a code.").font(ui(13.5, 400.0)).color(t.dim))
            .child(row().w_full().gap(8.0).center_y()
                .child(line_field(s, t, EditKey::SignInEmail, "you@example.com", App::send_code))
                .child(btn(t, if sent { "Resend" } else { "Send code" }, None, if sent { ButtonKind::Plain } else { ButtonKind::Blue }).key("sign-in-send").on_press(|s: &mut App| s.send_code())))
    ];
    if sent {
        rows.push(col().w_full().px(16.0).py(14.0).gap(10.0)
            .child(text("Enter the code from the email.").font(ui(13.5, 400.0)).color(t.dim))
            .child(row().w_full().gap(8.0).center_y()
                .child(line_field(s, t, EditKey::SignInCode, "123456", App::verify_code))
                .child(btn(t, "Sign in", None, ButtonKind::Blue).key("sign-in-verify").on_press(|s: &mut App| s.verify_code()))));
    }
    if let Some(err) = state.strip_prefix("error: ") {
        rows.push(row().w_full().px(16.0).py(10.0).child(text(err.to_owned()).font(ui(13.0, 400.0)).color(t.red).wrap()));
    }
    group(t, "Codeply account", rows)
}

fn appearance(s: &App, t: &Theme) -> Vec<El> {
    let team = s.data.team.iter().map(|a| {
        let right = if a.id == "wisp" {
            text("Keeps its hexagon and Codeply blue").font(ui(12.5, 400.0)).color(t.faint)
        } else {
            crate::views::appearance::pickers(t, a)
        };
        row().key(format!("team/{}", a.id)).w_full().px(16.0).py(14.0).gap(14.0).center_y()
            .child(bot::agent(a, 48.0))
            .child(col().grow(1.0).min_w(0.0).gap(2.0)
                .child(text(a.name.clone()).font(ui(14.0, 600.0)).color(t.text))
                .child(text(a.role.clone()).font(ui(12.5, 400.0)).color(t.dim).wrap()))
            .child(right)
    }).collect::<Vec<_>>();
    let mut page = crate::views::themes::groups(s, t);
    page.extend(vec![
        group(t, "Your team", team),
        note(t, "Colour and shape picks are saved, and show wherever the helper appears."),
    ]);
    page
}

fn configuration(s: &App, t: &Theme) -> Vec<El> {
    let effort = match s.prefs.effort.as_str() {
        "Low" => "Low",
        "Medium" => "Medium",
        _ => "High",
    };
    vec![
        group(t, "Approval and effort", vec![
            item(t, "Approval policy", Some("When the engine asks before it acts."),
                tabs(t, "cfg-approval", &[(Approval::Ask, "On request"), (Approval::Auto, "Never ask")], s.prefs.approval,
                    |s: &mut App, v: Approval| s.set_approval(v))),
            item(t, "Model effort", Some("How hard the model thinks before it answers."),
                tabs(t, "cfg-effort", &[("Low", "Low"), ("Medium", "Medium"), ("High", "High")], effort,
                    |s: &mut App, v: &'static str| s.set_effort(v))),
        ]),
        group(t, "Workspace dependencies", vec![
            item(t, "Current version", None, value(t, &s.data.extra.version)),
            item(t, "Codeply dependencies", Some("Node and the DSH runtime, from the installed app."), value(t, &s.data.extra.engine)),
            item(t, "Maintenance", Some("Check the install, or put it back as it shipped."),
                row().gap(8.0)
                    .child(btn(t, "Diagnose", None, ButtonKind::Plain).key("cfg-diagnose"))
                    .child(btn(t, "Reinstall", None, ButtonKind::Plain).key("cfg-reinstall"))),
        ]),
    ]
}

fn personalization(s: &App, t: &Theme) -> Vec<El> {
    vec![
        group(t, "About you", vec![editor(s, t, EditKey::AboutMe, "What should Wisp know about you?")]),
        group(t, "Custom instructions", vec![editor(s, t, EditKey::Instructions, "How should Wisp answer?")]),
        row().justify_end().child(btn_primary(t, "Save", "check").key("set-save").on_press(|s: &mut App| {
            let a = s.edit(EditKey::AboutMe).text.clone();
            let b = s.edit(EditKey::Instructions).text.clone();
            s.update_prefs(move |p| {
                p.about_me = a;
                p.instructions = b;
            });
        })),
        memories(s, t),
    ]
}

/// What Wisp remembers (the engine's memory): add one, or forget one.
fn memories(s: &App, t: &Theme) -> El {
    let mut rows = vec![row().w_full().px(16.0).py(12.0).gap(8.0).center_y()
        .child(line_field(s, t, EditKey::Memory, "Tell Wisp something to remember", App::remember))
        .child(btn(t, "Remember", None, ButtonKind::Plain).key("memory-add").on_press(|s: &mut App| s.remember()))];
    if s.data.extra.memories.is_empty() {
        rows.push(item(t, "Nothing yet", Some("Wisp remembers what you tell it, and what it learns while working."), el()));
    }
    for m in &s.data.extra.memories {
        let id = m.id.clone();
        rows.push(item(t, &m.text, Some(&format!("{} · {}", m.kind, m.scope)),
            ibtn(t, "close", "Forget").key(format!("memory-forget/{}", m.id)).on_press(move |s: &mut App| s.forget(&id))));
    }
    group(t, "Memories", rows)
}

fn shortcuts(t: &Theme) -> Vec<El> {
    let list = [
        ("Ctrl K", "Search"),
        ("Ctrl N", "New chat"),
        ("Ctrl ,", "Open settings"),
        ("Ctrl L", "Focus the address bar (browser)"),
        ("Enter", "Send"),
        ("Shift Enter", "New line"),
        ("Esc", "Close the menu or settings"),
    ];
    vec![group(t, "Shortcuts", list.iter().map(|&(k, what)| {
        item(t, what, None, keys(t, k)).key(format!("shortcut/{k}"))
    }).collect())]
}

fn mcp(s: &App, t: &Theme) -> Vec<El> {
    let servers: Vec<El> = if s.data.extra.mcp.is_empty() {
        vec![item(t, "No servers yet", Some("Add one to give the engine more tools."), el())]
    } else {
        s.data.extra.mcp.iter().map(|m| {
            let name = m.name.clone();
            item(t, &m.name, Some(&m.note),
                row().gap(12.0).center_y()
                    .child(value(t, &format!("{} tools", m.tools)))
                    .child(toggle(t, format!("set-mcp/{}", m.name), m.on, &m.name).on_press(move |s: &mut App| s.toggle_mcp(&name))))
        }).collect()
    };
    vec![
        group(t, "Servers", servers),
        row().justify_end().child(btn_primary(t, "Add server", "plus").key("set-mcp-add")),
    ]
}

fn hooks(t: &Theme) -> Vec<El> {
    vec![
        group(t, "Hooks", vec![
            item(t, "Run tests before a commit", Some("Stops the commit if a test fails."), sample(t, "set-hook/tests", true, "Run tests before a commit")),
            item(t, "Format files after an edit", Some("Runs your formatter on each file the engine writes."), sample(t, "set-hook/format", true, "Format files after an edit")),
            item(t, "Tell me when a task ends", Some("Runs a command when an agent finishes."), sample(t, "set-hook/notify", false, "Tell me when a task ends")),
        ]),
        row().justify_end().child(btn(t, "Add hook", Some("plus"), ButtonKind::Plain).key("set-hook-add")),
    ]
}

fn connections(t: &Theme) -> Vec<El> {
    vec![group(t, "Accounts", vec![
        item(t, "GitHub", Some("Pull requests and issues."), btn(t, "Manage", None, ButtonKind::Plain).key("set-conn/github")),
        item(t, "Slack", Some("Post updates to a channel."), btn(t, "Connect", None, ButtonKind::Blue).key("set-conn/slack")),
        item(t, "Google Drive", Some("Open files from your Drive."), btn(t, "Connect", None, ButtonKind::Blue).key("set-conn/drive")),
    ])]
}

fn git(t: &Theme) -> Vec<El> {
    vec![group(t, "Commits and branches", vec![
        item(t, "Commit with co-author", Some("Adds Codeply to the commit message."), sample(t, "set-git/coauthor", true, "Commit with co-author")),
        item(t, "Default branch prefix", Some("New task branches start with this."), value(t, "codeply/")),
        item(t, "Open pull requests as drafts", None, sample(t, "set-git/drafts", false, "Open pull requests as drafts")),
    ])]
}

fn environments(t: &Theme) -> Vec<El> {
    vec![group(t, "Where tasks run", vec![
        item(t, "This computer", Some("Tasks run in your project folder."), pill(t, "Active", Pill::Green)),
        item(t, "Codeply Cloud", Some("Tasks keep running when your computer is off."), btn(t, "Set up", None, ButtonKind::Plain).key("set-env/cloud")),
    ])]
}

fn worktrees(t: &Theme) -> Vec<El> {
    vec![group(t, "Worktrees", vec![
        item(t, "Use a worktree for each task", Some("Changes stay apart until you merge them."), sample(t, "set-wt/each", true, "Use a worktree for each task")),
        item(t, "Worktree folder", None, value(t, "~/.codeply/worktrees")),
        item(t, "Clean up after a merge", Some("Delete the worktree once its branch is merged."), sample(t, "set-wt/clean", false, "Clean up after a merge")),
    ])]
}

fn computer_use(t: &Theme) -> Vec<El> {
    vec![group(t, "Computer use", vec![
        item(t, "Allow Wisp to use your screen", Some("Wisp can see the screen, click and type."), sample(t, "set-cu/allow", false, "Allow Wisp to use your screen")),
        item(t, "Ask before each action", None, sample(t, "set-cu/ask", true, "Ask before each action")),
        item(t, "Show an outline while Wisp works", None, sample(t, "set-cu/outline", true, "Show an outline while Wisp works")),
    ])]
}

fn browser(s: &App, t: &Theme) -> Vec<El> {
    let marks: Vec<El> = if s.prefs.bookmarks.is_empty() {
        vec![item(t, "No bookmarks", Some("Bookmarks you add in the browser show here."), el())]
    } else {
        s.prefs.bookmarks.iter().map(|(title, url)| {
            let u = url.clone();
            item(t, title, Some(url),
                ibtn(t, "close", "Remove bookmark").key(format!("bookmark-remove/{url}")).on_press(move |s: &mut App| {
                    let u = u.clone();
                    s.update_prefs(move |p| p.bookmarks.retain(|(_, x)| *x != u));
                }))
        }).collect()
    };
    vec![
        group(t, "Home", vec![item(t, "Home page", None, value(t, &s.prefs.home))]),
        group(t, "Bookmarks", marks),
        group(t, "Privacy", vec![
            item(t, "Browsing data", Some("History, cookies and cached files."), btn(t, "Clear browsing data", None, ButtonKind::Plain).key("set-clear-browsing")),
        ]),
    ]
}

fn archived(s: &App, t: &Theme) -> Vec<El> {
    let rows: Vec<El> = if s.prefs.archived.is_empty() {
        vec![item(t, "Nothing archived", Some("Chats you archive from the sidebar will show up here."), el())]
    } else {
        s.prefs.archived.iter().map(|title| {
            let name = title.clone();
            item(t, title, None, btn(t, "Unarchive", None, ButtonKind::Plain).key(format!("unarchive/{title}")).on_press(move |s: &mut App| s.unarchive(&name)))
        }).collect()
    };
    vec![group(t, "Archived chats", rows)]
}

fn usage(s: &App, t: &Theme) -> Vec<El> {
    let bar = |label: &str, shown: &str, frac: f32| {
        item(t, label, None, row().gap(12.0).center_y().child(value(t, shown)).child(meter(t, frac)))
    };
    vec![
        group(t, "Plan", vec![
            item(t, &s.data.plan, Some("Your current plan."), btn_primary(t, "Upgrade", "sparkle").key("set-upgrade")),
        ]),
        group(t, "Usage", vec![
            bar("Chats this month", "23 / 50", 23.0 / 50.0),
            bar("Tokens", "77.8m", 0.78),
        ]),
    ]
}
