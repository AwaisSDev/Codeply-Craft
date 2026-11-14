//! Your real team and its standing jobs (loops): the engine's specialists and schedules
//! (`sidecar/ext-team.mjs`, `codeply-cli/lib/wisp.js`), shown on the Agents page, plus the two
//! small dialogs that add to them: a new agent (the sidebar's "+") and a new loop ("Create a loop"
//! on an agent's page).

use rune::{El, col, row, text, text_input};
use serde_json::Value;

use crate::app::{App, EditKey};
use crate::model::{Agent, AgentState, ButtonKind, Face, Look, Loop, Shape, Snapshot};
use crate::theme::{self, Theme, ui};
use crate::ui::{btn, ibtn};

/// A change to the team, as the store sends it to the engine.
#[derive(Clone, Debug, PartialEq)]
pub enum TeamOp {
    Create { name: String, focus: String },
    Remove(String),
    AddJob { agent: String, task: String, when: String },
    ToggleJob(String, bool),
    CancelJob(String),
}

/// Which dialog is open: a new agent, or a new loop for an agent (by id).
#[derive(Clone, Debug, PartialEq)]
pub enum TeamDialog {
    NewAgent,
    NewLoop(String),
}

/// The engine's shape names (wisp.js SHAPES) as the mascots this app draws.
fn shape_of(name: &str) -> Shape {
    match name {
        "circle" => Shape::Round,
        "square" => Shape::Square,
        "hexagon" => Shape::Hex,
        "triangle" | "spiky" => Shape::Triangle,
        "cloud" => Shape::Cloud,
        "star" => Shape::Drop,
        _ => Shape::Pebble,
    }
}

/// The team and loops from the engine's `{ team, jobs }`. Wisp stays first; an agent already on
/// screen keeps its look (and what you picked for it in Appearance applies on top, in App::poll).
/// Returns the team as the engine's /config wants it: (id, name, focus).
pub fn apply(snap: &mut Snapshot, v: &Value) -> Vec<(String, String, String)> {
    let str_of = |x: &Value, k: &str| x[k].as_str().unwrap_or_default().to_owned();
    let mut agents: Vec<Agent> = snap.team.iter().filter(|a| a.id == "wisp").cloned().collect();
    let faces = [Face::Glossy, Face::Content, Face::Capsule, Face::Googly];
    for (i, m) in v["team"].as_array().map(Vec::as_slice).unwrap_or_default().iter().enumerate() {
        let id = str_of(m, "id");
        if id.is_empty() || id == "wisp" {
            continue;
        }
        let old = snap.team.iter().find(|a| a.id == id);
        let focus = str_of(m, "focus");
        agents.push(Agent {
            name: str_of(m, "name"),
            color: Some(str_of(m, "color")).filter(|c| c.starts_with('#') && c.len() == 7).unwrap_or_else(|| "#4a78e0".into()),
            look: old.map_or_else(|| Look::new(shape_of(m["shape"].as_str().unwrap_or("blob")), faces[i % faces.len()], &[]), |a| a.look.clone()),
            role: focus.clone(),
            state: old.map_or(AgentState::Idle, |a| a.state),
            place: old.map_or_else(|| "Studio".into(), |a| a.place.clone()),
            action: old.map_or_else(String::new, |a| a.action.clone()),
            status: old.map(|a| a.status.clone()).filter(|s| !s.is_empty()).unwrap_or(focus),
            pos: old.map_or((160.0 + 130.0 * (i % 7) as f32, 260.0 + 160.0 * (i / 7) as f32), |a| a.pos),
            id,
        });
    }
    snap.team = agents;
    snap.extra.loops = v["jobs"].as_array().map(Vec::as_slice).unwrap_or_default().iter().map(|j| {
        let failed = !str_of(j, "lastError").is_empty();
        let ran = j["lastAt"].as_u64().unwrap_or(0) > 0;
        Loop {
            id: str_of(j, "id"),
            agent: str_of(j, "specialist"),
            name: str_of(j, "task").lines().next().unwrap_or_default().chars().take(80).collect(),
            runs: if failed { vec![false] } else if ran { vec![true] } else { Vec::new() },
            last: str_of(j, "status"),
            on: j["enabled"].as_bool().unwrap_or(true),
        }
    }).collect();
    if let Some(e) = v["error"].as_str().filter(|e| !e.is_empty()) {
        snap.extra.team_note = Some(e.to_owned());
    }
    snap.team.iter().filter(|a| a.id != "wisp").map(|a| (a.id.clone(), a.name.clone(), a.role.clone())).collect()
}

/// The mock store's version: the same changes on the sample team.
pub fn apply_sample(op: &TeamOp, snap: &mut Snapshot) {
    match op {
        TeamOp::Create { name, focus } => {
            let id = name.to_lowercase().replace(' ', "-");
            if !snap.team.iter().any(|a| a.id == id) {
                snap.team.push(Agent {
                    id, name: name.clone(), color: "#4a78e0".into(), look: Look::new(Shape::Pebble, Face::Content, &[]),
                    role: focus.clone(), state: AgentState::Idle, place: "Studio".into(), action: String::new(), status: focus.clone(), pos: (600.0, 300.0),
                });
            }
        }
        TeamOp::Remove(id) => snap.team.retain(|a| a.id != *id || a.id == "wisp"),
        TeamOp::AddJob { agent, task, when } => snap.extra.loops.push(Loop {
            id: format!("job-{}", snap.extra.loops.len() + 1), agent: agent.clone(), name: task.clone(), runs: Vec::new(), last: format!("{when} · first run soon"), on: true,
        }),
        TeamOp::ToggleJob(id, on) => {
            if let Some(l) = snap.extra.loops.iter_mut().find(|l| l.id == *id) {
                l.on = *on;
            }
        }
        TeamOp::CancelJob(id) => snap.extra.loops.retain(|l| l.id != *id),
    }
}

impl App {
    pub fn open_team_dialog(&mut self, d: TeamDialog) {
        for k in [EditKey::AgentName, EditKey::AgentFocus, EditKey::LoopTask, EditKey::LoopWhen] {
            self.edit_mut(k).clear();
        }
        self.team_dialog = Some(d);
    }

    /// Sends what the dialog holds to the engine, and closes it (an error comes back as a notice).
    pub fn submit_team_dialog(&mut self) {
        let get = |s: &App, k: EditKey| s.edit(k).text.trim().to_owned();
        let op = match self.team_dialog.clone() {
            Some(TeamDialog::NewAgent) => {
                let (name, focus) = (get(self, EditKey::AgentName), get(self, EditKey::AgentFocus));
                if focus.is_empty() && name.is_empty() {
                    self.notice = Some("Say what your agent should do.".into());
                    return;
                }
                TeamOp::Create { name, focus }
            }
            Some(TeamDialog::NewLoop(agent)) => {
                let (task, when) = (get(self, EditKey::LoopTask), get(self, EditKey::LoopWhen));
                if task.is_empty() || when.is_empty() {
                    self.notice = Some("Say what the loop does and when.".into());
                    return;
                }
                TeamOp::AddJob { agent, task, when }
            }
            None => return,
        };
        self.notice = None;
        self.team_dialog = None;
        self.with_store(|st, d| st.team_op(op, d));
    }

    /// Turns a loop on or off, here and in the engine.
    pub fn toggle_loop(&mut self, agent: &str, name: &str) {
        let Some(l) = self.data.extra.loops.iter_mut().find(|l| l.agent == agent && l.name == name) else { return };
        l.on = !l.on;
        let op = TeamOp::ToggleJob(l.id.clone(), l.on);
        self.with_store(|st, d| st.team_op(op, d));
    }

    /// Removes a loop for good.
    pub fn cancel_loop(&mut self, id: &str) {
        self.with_store(|st, d| st.team_op(TeamOp::CancelJob(id.to_owned()), d));
    }

    /// Takes an agent you made off the team (built-in ones stay).
    #[allow(dead_code)]
    pub fn remove_agent(&mut self, id: &str) {
        if self.agent.as_deref() == Some(id) {
            self.agent = None;
        }
        self.with_store(|st, d| st.team_op(TeamOp::Remove(id.to_owned()), d));
    }
}

fn field(s: &App, t: &Theme, key: EditKey, label: &str, placeholder: &str) -> El {
    let input = text_input(s.edit(key), ui(13.5, 400.0)).key(format!("team-field/{}", key.name())).single_line().grow(1.0).color(t.text)
        .placeholder(placeholder.to_owned(), t.faint).caret(t.accent, t.accent.alpha(0.3)).label(label.to_owned())
        .on_edit(move |s: &mut App| s.edit_mut(key))
        .on_submit(|s: &mut App, _| s.submit_team_dialog());
    col().w_full().gap(5.0)
        .child(text(label.to_owned()).font(ui(12.0, 600.0)).color(t.faint))
        .child(row().w_full().h(38.0).px(12.0).radius(10.0).clip_rounded(10.0).center_y().fill(t.field).border(1.0, t.field_border).child(input))
}

/// The open dialog, over the window.
pub fn dialog(s: &App, t: &Theme) -> Option<El> {
    let d = s.team_dialog.as_ref()?;
    let (title, sub, fields): (String, String, Vec<El>) = match d {
        TeamDialog::NewAgent => (
            "New agent".into(),
            "Describe it in plain words: Codeply writes its full instructions, and Wisp hands it the work that fits. You can also just ask Wisp to make one.".into(),
            vec![
                field(s, t, EditKey::AgentFocus, "Describe it", "Writes our landing pages and launch emails"),
                field(s, t, EditKey::AgentName, "Name (optional)", "Copywriter"),
            ],
        ),
        TeamDialog::NewLoop(agent) => {
            let name = s.data.agent(agent).map_or_else(|| agent.clone(), |a| a.name.clone());
            (
                format!("New loop for {name}"),
                "A job it does on a schedule, in its own chat, while Codeply is open.".into(),
                vec![
                    field(s, t, EditKey::LoopTask, "What to do", "Check the open pull requests and summarise them"),
                    field(s, t, EditKey::LoopWhen, "When", "every weekday at 9"),
                ],
            )
        }
    };
    let notice = s.notice.clone().map(|n| text(n).font(ui(12.5, 400.0)).color(t.red).wrap());
    let card = col().key("team-dialog").w(460.0).padding(22.0).gap(14.0).radius(16.0)
        .fill(t.card).border(1.0, t.card_border).shadow(16.0, 48.0, theme::rgba(0, 0, 0, 0.45))
        .transition(crate::ui::fade_in()).motion(crate::ui::ENTER)
        .role("dialog").label(title.clone())
        .modal(true, |s: &mut App| s.team_dialog = None)
        .child(row().w_full().center_y()
            .child(col().grow(1.0).min_w(0.0).gap(3.0)
                .child(text(title).font(ui(16.0, 600.0)).color(t.text))
                .child(text(sub).font(ui(12.5, 400.0)).color(t.faint).wrap()))
            .child(ibtn(t, "close", "Close").key("team-dialog-close").on_press(|s: &mut App| s.team_dialog = None)))
        .children(fields)
        .children(notice)
        .child(row().w_full().gap(8.0).justify_end()
            .child(btn(t, "Cancel", None, ButtonKind::Plain).key("team-dialog-cancel").on_press(|s: &mut App| s.team_dialog = None))
            .child(btn(t, if matches!(d, TeamDialog::NewAgent) { "Add to team" } else { "Create loop" }, None, ButtonKind::Blue)
                .key("team-dialog-ok").on_press(|s: &mut App| s.submit_team_dialog())));
    Some(col().key("team-scrim").pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).center()
        .fill(theme::rgba(0, 0, 0, 0.4))
        .child(card))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_engines_team_and_jobs_replace_the_sample() {
        let mut snap = crate::store::mock::sample();
        let v = json!({
            "team": [
                { "id": "frontend", "name": "Frontend", "focus": "Frontend", "shape": "circle", "color": "#e85d9a", "builtin": true },
                { "id": "copywriter", "name": "Copywriter", "focus": "Landing pages", "shape": "blob", "color": "#58b9e6" }
            ],
            "jobs": [
                { "id": "s1", "specialist": "copywriter", "task": "Draft the weekly update\nwith links", "enabled": true, "lastAt": 0, "status": "every Monday at 9 · first run Mon 17 Nov 09:00" },
                { "id": "s2", "specialist": "frontend", "task": "Check the pricing page", "enabled": false, "lastAt": 5, "lastError": "", "status": "Off · every day at 18:00" }
            ]
        });
        let team = apply(&mut snap, &v);
        assert_eq!(snap.team.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["wisp", "frontend", "copywriter"]);
        assert_eq!(team, [("frontend".to_owned(), "Frontend".to_owned(), "Frontend".to_owned()), ("copywriter".to_owned(), "Copywriter".to_owned(), "Landing pages".to_owned())]);
        assert_eq!(snap.extra.loops.len(), 2);
        assert_eq!(snap.extra.loops[0].name, "Draft the weekly update");
        assert!(snap.extra.loops[0].runs.is_empty());
        assert!(!snap.extra.loops[1].on);
        assert_eq!(snap.extra.loops[1].runs, [true]);
    }
}
