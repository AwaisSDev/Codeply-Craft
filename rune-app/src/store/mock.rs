//! The 4.0 prototype's sample data (design/workspace/index.html and views.js), so every view can
//! be built, tested and screenshotted without the engine running.

use super::{Store, Target};
use crate::model::*;

#[derive(Default)]
pub struct MockStore;

fn s(v: &str) -> String {
    v.to_owned()
}

#[allow(clippy::too_many_arguments)]
fn agent(id: &str, name: &str, color: &str, look: Look, role: &str, state: AgentState, place: &str, action: &str, status: &str, pos: (f32, f32)) -> Agent {
    Agent { id: s(id), name: s(name), color: s(color), look, role: s(role), state, place: s(place), action: s(action), status: s(status), pos }
}

fn step(t: &str) -> Block {
    Block::Step { text: s(t), now: false }
}
fn now(t: &str) -> Block {
    Block::Step { text: s(t), now: true }
}
fn btn(t: &str, k: ButtonKind) -> (String, ButtonKind, Option<&'static str>) {
    (s(t), k, None)
}

/// A year of activity that is quiet early on and busy over the last three months, the shape the
/// prototype's random fill has, from a fixed seed so screenshots are stable.
pub fn activity() -> Vec<u8> {
    let mut seed: u64 = 11;
    let mut rnd = || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((seed >> 33) as f64) / f64::from(1u32 << 31)
    };
    (0..52 * 7)
        .map(|i| {
            let r = rnd();
            let late = i % 52 > 40;
            if late && r > 0.45 { if r > 0.8 { 3 } else if r > 0.62 { 2 } else { 1 } } else if r > 0.97 { 1 } else { 0 }
        })
        .collect()
}

pub fn sample() -> Snapshot {
    use AgentState::*;
    let team = vec![
        agent("wisp", "Wisp", "#2f6bff", Look::new(Shape::Hex, Face::Pill, &[]), "Your agent", Idle, "At the lead desk", "Watching your day. Brief at 6:00", "Watching your day. Brief at 6:00", (760.0, 214.0)),
        agent("frontend", "Frontend", "#ff5c9d", Look::new(Shape::Triangle, Face::Capsule, &[]).looking(0, -1), "Claude Code", Working, "Studio", "Editing pricing.html, +42 lines", "Building the pricing page", (170.0, 214.0)),
        agent("backend", "Backend", "#ff8a1a", Look::new(Shape::Cloud, Face::Capsule, &[]).looking(-1, 0), "Claude Code", Thinking, "Kitchen", "Thinking about plan limits over coffee", "Thinking about plan limits", (1050.0, 124.0)),
        agent("inbox", "Inbox", "#1fc75f", Look::new(Shape::Round, Face::Capsule, &[]).looking(1, -1), "Mail", Waiting, "Needs you", "Waiting for your OK on 1 reply", "Needs your OK on 1 reply", (300.0, 588.0)),
        agent("research", "Research", "#7b5cff", Look::new(Shape::Square, Face::Capsule, &[]).looking(1, 0), "Web", Sleeping, "Lounge", "Asleep. Finished the venue search 1h ago", "4 venues for Friday", (780.0, 600.0)),
        agent("docs", "Docs", "#4fb3ff", Look::new(Shape::Drop, Face::Capsule, &[]).looking(-1, 1), "Claude Code", Walking, "Hallway", "Walking to the kitchen. Next: README after PR #44", "README after PR #44", (430.0, 340.0)),
    ];

    let sessions = vec![
        (s("frontend"), vec![
            Block::Label(s("Live session · 14 min")),
            Block::LiveScreen,
            step("Read **index.html** and the homepage styles"),
            step("Asked Backend for the plan data"),
            step("Created **plans.json**"),
            now("Editing **pricing.html**, +42 lines"),
            Block::Buttons(vec![(s("Open in Code"), ButtonKind::Plain, Some("code")), (s("PR #44"), ButtonKind::Plain, Some("branch"))]),
        ]),
        (s("backend"), vec![
            Block::Label(s("Live session · thinking")),
            step("Read the pricing brief from Frontend"),
            step("Wrote **plans.json** with Free, Plus and Team"),
            now("Deciding how strict the Team limits should be"),
            Block::Quote(s("\"Free: 3 projects. Plus: 20. Team: unlimited, with per-seat billing. Checking the API enforces it, not just the page.\"")),
        ]),
        (s("inbox"), vec![
            Block::Label(s("Needs your OK")),
            Block::Draft { title: s("Re: lease renewal"), to: s("to landlord@example.com"), via: Some(s("gmail")), body: s("Hi Ana, thanks for the renewal. The 1st works for me, and I'll send the deposit by Friday.\n\nBest,\nSam") },
            Block::Buttons(vec![(s("Send"), ButtonKind::Blue, Some("arrow-up")), btn("Edit", ButtonKind::Plain), btn("Discard", ButtonKind::Plain)]),
        ]),
        (s("research"), vec![
            Block::Label(s("Latest chat · 1h ago")),
            Block::Bubble(s("Find a place for Friday drinks, 20 people, near the office.")),
            Block::Reply(s("Found 4. The top pick holds 20, is 10 minutes away and costs $240 for the evening. Want me to book it?")),
            Block::Buttons(vec![btn("Book it", ButtonKind::Blue), btn("See all 4", ButtonKind::Plain)]),
        ]),
        (s("wisp"), vec![
            Block::Label(s("Latest chat · 9:41")),
            Block::Bubble(s("Morning! Can you check in with the team for me?")),
            Block::Reply(s("All on track. Frontend is checking the pricing page, Backend is on the plan limits, and Inbox has a reply for you to approve.")),
            Block::Via { icon: "history", text: s("Created routine: Morning check-in, every day at 9:00") },
        ]),
        (s("docs"), vec![Block::Label(s("On a short break")), step("Updated the changelog for 4.0"), now("Next: the README, once PR #44 merges")]),
    ];

    let chat_groups = vec![
        ChatGroup { icon: "oai-desktop", title: s("This Computer"), chats: vec![s("Casual chat"), s("Parallel greeting agents test"), s("Getting acquainted with Codeply")] },
        ChatGroup { icon: "oai-cloud", title: s("Cloud"), chats: vec![s("Nightly test run"), s("Docs refresh")] },
        ChatGroup { icon: "oai-folder", title: s("launch-site"), chats: vec![s("Pricing page"), s("Local site mockup fixes"), s("Git push command explanation")] },
    ];

    let thread = vec![
        ThreadItem::Stamp(s("9:41 AM")),
        ThreadItem::You(s("Morning! Can you check in with the team for me?")),
        ThreadItem::Them(s("On it. Pinging everyone for status now.")),
        ThreadItem::Team { text: s("6 messages with"), agents: vec![s("frontend"), s("backend"), s("inbox")] },
        ThreadItem::Them(s("All on track. Frontend is checking the pricing page at three sizes, Backend is running the tests, and Inbox drafted a reply to your landlord that needs your OK.")),
        ThreadItem::You(s("Love it, do this every morning.")),
        ThreadItem::Event { icon: "history", text: s("Created routine: Morning check-in, every day at 9:00") },
        ThreadItem::Them(s("Done. It'll be here at 9:00 every day.")),
    ];

    let pr = |number, title: &str, by: &str, state, age: &str, added, removed, branch: &str, summary: &str, points: [&str; 3]| Pr {
        number, title: s(title), by: s(by), state, age: s(age), added, removed, branch: s(branch), summary: s(summary), points: points.map(s).to_vec(),
    };
    let prs = vec![
        pr(44, "Pricing page for launch-site", "frontend", PrState::Open, "2h", 186, 12, "claude/pricing-page", "A pricing page with three plans and a monthly or yearly switch, styled like the homepage.", ["New **plans.json** from Backend, one source for names and prices", "Yearly shows the saving per plan", "Checked at 375, 768 and 1440 px; no layout shift"]),
        pr(43, "Plan data and limits", "backend", PrState::Draft, "6m", 48, 3, "claude/plan-data", "Plan names, prices and usage limits in one file the page and the API both read.", ["**plans.json** with Free, Plus and Team", "Limits enforced in the API, not just shown", "Still running the test suite"]),
        pr(42, "Fix the checkout crash", "backend", PrState::Open, "1d", 9, 4, "claude/checkout-nan", "Checkout crashed when a coupon made the total NaN. Totals are now clamped and the coupon is checked first.", ["Reproduced the crash with an empty coupon", "Clamp NaN to 0 in **math.ts**", "New test covers the empty coupon case"]),
        pr(41, "Admin dashboard: progress", "frontend", PrState::Merged, "7d", 402, 120, "claude/admin-progress", "A progress section on the admin dashboard with weekly charts.", ["Charts render from the existing stats API", "Empty state for new accounts", "Merged by you"]),
    ];

    let conn = |slug, name: &str, note: &str, who: &[&str]| ConnectedApp { slug, name: s(name), note: s(note), agents: who.iter().map(|w| s(w)).collect() };
    let connected = vec![
        conn("gmail", "Gmail", "Read, draft and send. Sends only after you OK it.", &["inbox", "wisp"]),
        conn("googlecalendar", "Google Calendar", "Read and change events. Every change is read back.", &["wisp"]),
        conn("github", "GitHub", "Branches, pull requests and checks.", &["frontend", "backend"]),
        conn("slack", "Slack", "Read channels, post updates you approve.", &["wisp"]),
        conn("notion", "Notion", "Read and write pages.", &["docs"]),
        conn("vercel", "Vercel", "Preview and production deploys.", &["frontend"]),
    ];
    let popular = [("linear", "Linear", "Issues"), ("stripe", "Stripe", "Payments"), ("figma", "Figma", "Design"), ("googledrive", "Google Drive", "Files"), ("discord", "Discord", "Chat"), ("whatsapp", "WhatsApp", "Messages"), ("hubspot", "HubSpot", "CRM"), ("zoom", "Zoom", "Meetings")]
        .into_iter().map(|(a, b, c)| (a, s(b), s(c))).collect();
    let act = |slug, text: &str, note: &str, time: &str| AppAction { slug, text: s(text), note: s(note), time: s(time) };
    let actions = vec![
        act("gmail", "Inbox drafted **Re: lease renewal**", "waiting for your OK", "8:14"),
        act("googlecalendar", "Wisp moved **Standup** to 9:30", "read back, matches", "7:52"),
        act("github", "Frontend opened **PR #44**", "3 checks passed", "7:12"),
        act("slack", "Wisp posted the standup change in **#team**", "you approved", "7:53"),
    ];

    let task = |agent: &str, title: &str, sub: &str, pill: Option<(&str, Pill)>, body| Task { agent: s(agent), title: s(title), sub: s(sub), pill: pill.map(|(t, p)| (s(t), p)), body };
    let done = |agent, title, proof: &str, checked| (Column::Done, task(agent, title, "", None, TaskBody::Done { proof: s(proof), checked }));
    let tasks = vec![
        (Column::Working, task("frontend", "Pricing page for launch-site", "Frontend · Claude Code · 14 min", Some(("Code", Pill::Blue)), TaskBody::Working { icon: "edit", now: s("Editing pricing.html, +42 lines"), progress: 0.64, screen: true })),
        (Column::Working, task("backend", "Plan data and limits", "Backend · Claude Code · 6 min", Some(("Code", Pill::Blue)), TaskBody::Working { icon: "terminal", now: s("Running npm test"), progress: 0.30, screen: false })),
        (Column::NeedsYou, task("inbox", "Reply to the landlord", "Inbox · drafted 18 min ago", Some(("Approve", Pill::Warn)), TaskBody::Ask { text: s("\"Thanks for the renewal. The 1st works, and I'll send the deposit by Friday.\""), buttons: vec![(s("Send"), ButtonKind::Blue), (s("Edit"), ButtonKind::Plain), (s("Discard"), ButtonKind::Plain)] })),
        (Column::NeedsYou, task("research", "Book the Friday venue?", "Research · 4 options", Some(("Decide", Pill::Warn)), TaskBody::Ask { text: s("Top pick holds 20 people, 10 minutes from the office, $240 for the evening."), buttons: vec![(s("Book it"), ButtonKind::Blue), (s("See all 4"), ButtonKind::Plain)] })),
        done("wisp", "Moved standup to 9:30", "Checked on Google Calendar", true),
        done("frontend", "Hero section shipped to preview", "Tests passed, 212 of 212", true),
        done("inbox", "Archived 41 newsletters", "Kept everyone you know", true),
        done("backend", "Fixed the checkout crash", "PR #42 opened", true),
        done("wisp", "Internet bill reminder", "Not checked: no bill found", false),
    ];

    Snapshot {
        user: s("Sam"),
        plan: s("Free plan"),
        project: s("launch-site"),
        team,
        sessions,
        chat_groups,
        recent: vec![(s("Casual chat"), s("24 h ago")), (s("Local site mockup fixes"), s("2 days ago")), (s("iMessage clone build"), s("3 days ago"))],
        threads: vec![(s("*"), thread)],
        prs,
        connected,
        popular,
        actions,
        tasks,
        routines: vec![("sun", s("Morning brief"), s("Every day at 6:00")), ("mail", s("Inbox cleanup"), s("Weekdays at 8:00")), ("history", s("Weekly review"), s("Fridays at 17:00"))],
        activity: activity(),
        source: s("Sample data"),
    }
}

/// Appends what you sent, and the agent's acknowledgement, where you'll see it.
pub fn echo(snap: &mut Snapshot, to: &Target, text: &str, reply: &str) {
    match to {
        Target::Agent(id) => {
            if let Some((_, blocks)) = snap.sessions.iter_mut().find(|(k, _)| k == id) {
                blocks.push(Block::Bubble(text.to_owned()));
                blocks.push(Block::Reply(reply.to_owned()));
            }
        }
        Target::Chat(chat) => {
            let key = if snap.threads.iter().any(|(k, _)| k == chat) { chat.clone() } else { "*".to_owned() };
            if let Some((_, items)) = snap.threads.iter_mut().find(|(k, _)| *k == key) {
                items.push(ThreadItem::You(text.to_owned()));
                items.push(ThreadItem::Them(reply.to_owned()));
            }
        }
        Target::Wisp => {
            if let Some((_, blocks)) = snap.sessions.iter_mut().find(|(k, _)| k == "wisp") {
                blocks.push(Block::Bubble(text.to_owned()));
                blocks.push(Block::Reply(reply.to_owned()));
            }
        }
    }
}

impl Store for MockStore {
    fn load(&mut self) -> Snapshot {
        sample()
    }
    fn poll(&mut self, _: &mut Snapshot) -> bool {
        false
    }
    fn send(&mut self, to: &Target, text: &str, snap: &mut Snapshot) -> Result<(), String> {
        echo(snap, to, text, "On it. I'll post here when it's done.");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sample_matches_the_prototype() {
        let snap = sample();
        assert_eq!(snap.team.len(), 6);
        assert_eq!(snap.count(AgentState::Working), 1);
        assert_eq!(snap.count(AgentState::Waiting), 1);
        assert_eq!(snap.prs.iter().map(|p| p.number).collect::<Vec<_>>(), [44, 43, 42, 41]);
        assert_eq!(snap.activity.len(), 52 * 7);
        for (id, _) in &snap.sessions {
            assert!(snap.agent(id).is_some(), "session for unknown agent {id}");
        }
        assert!(!snap.thread("Docs refresh").is_empty(), "every chat falls back to the sample thread");
    }

    #[test]
    fn sending_to_an_agent_lands_in_its_drawer() {
        let mut snap = sample();
        MockStore.send(&Target::Agent("research".into()), "Book it for 7pm", &mut snap).ok();
        assert!(matches!(snap.session("research").iter().rev().nth(1), Some(Block::Bubble(t)) if t == "Book it for 7pm"));
    }
}
